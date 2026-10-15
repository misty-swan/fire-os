import { env } from "cloudflare:workers";
import { FICTIONAL, FIXTURE_START, ROLE_IDS } from "../fixtures/core";
import { createRuntime } from "./runtime";

export type RoleCode = keyof typeof ROLE_IDS;
export type PersonKey = keyof typeof FICTIONAL.people;

export interface Identity {
  userId: string;
  memberId: string | null;
  unitId: string;
  person: PersonKey;
  roleCode: RoleCode | null;
}

export interface UnitFixture {
  id: string;
  people: Record<PersonKey, Identity>;
  /** operator が担当(scope)を持つ対象と、持たない対象 */
  scopeIn: { entityType: "facility"; entityId: string };
  scopeOut: { entityType: "facility"; entityId: string };
}

export interface FixedClock {
  now(): Date;
  set(iso: string): void;
  advance(ms: number): void;
}

export interface TestClient {
  request(method: string, path: string, body?: unknown, headers?: Record<string, string>): Promise<Response>;
}

export interface TestFixture {
  units: { a: UnitFixture; b: UnitFixture };
  client(identity: Identity): TestClient;
  /** 生のRequestをWorkerへ渡す（バイナリアップロードなど専用ヘッダー/本文の試験用） */
  raw(identity: Identity): (request: Request) => Promise<Response>;
  rows(table: string, where?: Record<string, string | number | null>): Promise<Record<string, unknown>[]>;
  clock: FixedClock;
  dispose(): Promise<void>;
}

const TABLES = new Set([
  "units", "users", "roles", "members", "member_roles", "scope_assignments",
  "idempotency_records", "mutation_assertions", "audit_logs", "domain_events",
  // PH2: 添付・GIS・資産・点検・異常
  "attachment_drafts", "upload_attempts", "attachments", "attachment_links", "attachment_events",
  "facilities", "facility_location_revisions",
  "vehicles", "equipment",
  "import_batches", "import_rows",
  "inspection_templates", "inspection_template_versions",
  "inspection_series", "facility_inspections", "asset_inspections", "inspection_items",
  "issues", "issue_events",
  // PH3: 活動（予定）
  "operations", "activities", "activity_audience", "activity_events",
  "activity_attendance", "attendance_events", "activity_results", "activity_result_revisions",
  "activity_actual_participants",
  // PH3: 出動（模擬・訓練・実出動記録）
  "incidents", "incident_events", "incident_participants", "incident_participant_events",
  // PH3: 車両/機材の使用履歴（T042）
  "resource_usages", "resource_usage_events",
  // PH3: お知らせ（T045）
  "announcements", "announcement_revisions", "announcement_audience", "announcement_reads",
  // PH4: 点検期限と超過検出のログ（T048）
  "inspection_schedules", "inspection_due_detections",
  // PH4: 業務タスク（T049）
  "tasks", "task_events",
]);
const IDENT = /^[a-z_][a-z0-9_]*$/;

function fixedClock(startIso: string): FixedClock {
  let t = new Date(startIso).getTime();
  return { now: () => new Date(t), set: (iso) => { t = new Date(iso).getTime(); }, advance: (ms) => { t += ms; } };
}

async function seedUnit(label: string, unitName: string, now: string): Promise<UnitFixture> {
  const db = env.DB;
  const unitId = crypto.randomUUID();
  const stmts: D1PreparedStatement[] = [];
  const insert = (sql: string, ...binds: unknown[]) => stmts.push(db.prepare(sql).bind(...binds));

  // 先にuser(unitに属さない)を作る。停止ユーザーは disabled＋authz_version増分済み
  const people = {} as Record<PersonKey, Identity>;
  const roleOf: Record<PersonKey, RoleCode | null> = {
    admin: "admin", officer: "officer", operator: "operator", member: "member", suspended: "member", unlinked: null,
  };
  const keys = Object.keys(FICTIONAL.people) as PersonKey[];
  for (const key of keys) {
    const userId = key === "unlinked" ? null : crypto.randomUUID();
    const memberId = crypto.randomUUID();
    people[key] = { userId: userId as string, memberId, unitId, person: key, roleCode: roleOf[key] };
    if (userId) {
      const suspended = key === "suspended";
      insert(
        "INSERT INTO users (id, auth_id, status, authz_version, disabled_at, created_at, updated_at) VALUES (?,?,?,?,?,?,?)",
        userId, `auth-${label}-${key}-${crypto.randomUUID()}`, suspended ? "disabled" : "active",
        suspended ? 2 : 1, suspended ? now : null, now, now,
      );
    }
  }
  const adminUser = people.admin.userId;
  insert(
    "INSERT INTO units (id, name, status, created_at, updated_at, created_by, actor_kind) VALUES (?,?,?,?,?,?,?)",
    unitId, unitName, "active", now, now, adminUser, "human",
  );
  for (const key of keys) {
    const p = people[key];
    insert(
      "INSERT INTO members (id, unit_id, user_id, display_name, rank, status, created_at, updated_at, created_by, actor_kind) VALUES (?,?,?,?,?,?,?,?,?,?)",
      p.memberId, unitId, p.userId ?? null, FICTIONAL.people[key].displayName, FICTIONAL.people[key].rank,
      "active", now, now, adminUser, "human",
    );
    if (p.roleCode) {
      insert(
        "INSERT INTO member_roles (id, unit_id, member_id, role_id, granted_by, created_at, updated_at, created_by, actor_kind) VALUES (?,?,?,?,?,?,?,?,?)",
        crypto.randomUUID(), unitId, p.memberId, ROLE_IDS[p.roleCode], adminUser, now, now, adminUser, "human",
      );
    }
  }
  const scopeIn = { entityType: "facility" as const, entityId: crypto.randomUUID() };
  const scopeOut = { entityType: "facility" as const, entityId: crypto.randomUUID() };
  insert(
    "INSERT INTO scope_assignments (id, unit_id, member_id, entity_type, entity_id, permissions, created_at, updated_at, created_by, actor_kind) VALUES (?,?,?,?,?,?,?,?,?,?)",
    crypto.randomUUID(), unitId, people.operator.memberId, scopeIn.entityType, scopeIn.entityId,
    JSON.stringify(["PER-03", "PER-04"]), now, now, adminUser, "human",
  );
  await db.batch(stmts);
  return { id: unitId, people, scopeIn, scopeOut };
}

/**
 * 架空の「2分団×4役割＋停止ユーザー＋未登録団員＋担当内外」を作る。
 * 呼び出しごとに新しいIDを採番するので、同じDBで複数回呼んでも衝突しない。
 * client(identity) は x-test-identity ヘッダー({userId})を付ける。受け側は src/server/auth/principal.ts の
 * 試験専用注入（APP_ENV=local かつ TEST_AUTH=1 のときだけ有効）。本物のセッション認証はT007/T008で実装する。
 */
export async function createFixture(name: "two-units"): Promise<TestFixture> {
  if (name !== "two-units") throw new Error(`unknown fixture: ${name}`);
  const clock = fixedClock(FIXTURE_START);
  const now = FIXTURE_START;
  const a = await seedUnit("a", FICTIONAL.unitA.name, now);
  const b = await seedUnit("b", FICTIONAL.unitB.name, now);
  const runtime = await createRuntime();

  return {
    units: { a, b },
    clock,
    client: (identity) => ({
      request: (method, path, body, headers = {}) =>
        runtime.fetch(
          new Request(`http://example.com${path}`, {
            method,
            headers: { "content-type": "application/json", "x-test-identity": JSON.stringify(identity), ...headers },
            body: body === undefined ? undefined : JSON.stringify(body),
          }),
        ),
    }),
    raw: (identity) => (request) => {
      const headers = new Headers(request.headers);
      headers.set("x-test-identity", JSON.stringify(identity));
      return runtime.fetch(new Request(request.url, { method: request.method, headers, body: request.body, duplex: "half" } as RequestInit));
    },
    async rows(table, where = {}) {
      if (!TABLES.has(table)) throw new Error(`rows(): 未知の表 ${table}`);
      const cols = Object.keys(where);
      for (const c of cols) if (!IDENT.test(c)) throw new Error(`rows(): 不正な列名 ${c}`);
      const sql = `SELECT * FROM ${table}${cols.length ? " WHERE " + cols.map((c) => (where[c] === null ? `${c} IS NULL` : `${c} = ?`)).join(" AND ") : ""}`;
      const binds = cols.map((c) => where[c]).filter((v) => v !== null);
      const res = await env.DB.prepare(sql).bind(...binds).all();
      return res.results as Record<string, unknown>[];
    },
    dispose: async () => runtime.dispose(),
  };
}
