import { Announcement, ReadReceipt, type AnnouncementDto } from "../../shared/contracts/content";
import { announcementTransitions, canTransition } from "../../shared/states";
import { authorize } from "../auth/authorize";
import { resolvePrincipal, type AuthzPrincipal } from "../auth/principal";
import { HttpError, defineRoute, ok, parseApiRequest, type ApiApp, type ApiContext } from "../http";
import type { AppEnv } from "../env";
import { canonicalRequestHash, sha256Hex } from "../mutations/hash";
import { executeMutation } from "../mutations/execute";
import { requirePermission } from "./invitations";

/**
 * お知らせの作成・公開/改版/対象変更・本人既読（T045、docs/05 API-24/25/66/72、docs/04 §3.4 132-135行、
 * docs/11 お知らせ行、docs/10 PER-03）。
 * - 対象は明示snapshot（announcement_audience。docs/04:134）。名簿変更で対象を変えない
 * - title/body/対象の変更は新revision（announcement_revisions。親/版UNIQUE。変更原本＝追記のみで不変。docs/04:133）。
 *   公開/アーカイブの状態遷移だけでは版を上げない（内容が変わらないため）
 * - 既読は版に束縛（announcement_reads。docs/04:135「三つ組UNIQUE、本人のみ」）。改版後は別の既読として
 *   取り直し、旧版の既読は新版の未読として扱う（docs/11「既読は版に束縛」）。対象変更でも既読は消さない
 * - 通知（API-63〜65/100）はPH4のため、作成/公開/改版/対象変更で通知ジョブを自動起動しない
 *   （docs/11「対象変更は新通知承認」は承認フローごとPH4。docs/16 T045「編集/対象変更で通知を自動承認/再送しない」）
 */

/** 応答の組立（対象snapshotをそのまま応答へ写す。json()でテキストをJSON配列として埋め込む）。
 *  createdByMemberId（作成者。users→members）、readAt（この要求の本人の現行版既読。未読はNULL）、
 *  attachments（リンク中の添付。API-101のunlinkにlinkId/linkVersionを渡す）も同じ形で返す（T046） */
const ANNOUNCEMENT_JSON =
  "SELECT json_object('id', id, 'version', version, 'title', title, 'body', body, 'revisionNo', revision_no, " +
    "'status', status, 'publishedAt', published_at, 'audienceMemberIds', " +
    "json((SELECT v.audience_snapshot FROM announcement_revisions v WHERE v.unit_id = announcements.unit_id " +
      "AND v.announcement_id = announcements.id AND v.revision_no = announcements.revision_no)), " +
    "'createdByMemberId', (SELECT m.id FROM members m WHERE m.user_id = announcements.created_by), " +
    "'readAt', (SELECT r.read_at FROM announcement_reads r WHERE r.announcement_id = announcements.id " +
      "AND r.revision_no = announcements.revision_no AND r.member_id = ?), " +
    "'attachments', json((SELECT json_group_array(json_object('id', t.id, 'linkId', l.id, 'linkVersion', l.version, " +
        "'status', t.status, 'contentType', t.content_type)) FROM attachment_links l " +
      "JOIN attachments t ON t.id = l.attachment_id AND t.unit_id = l.unit_id " +
      "WHERE l.entity_type = 'announcement' AND l.entity_id = announcements.id " +
      "AND l.unit_id = announcements.unit_id AND l.unlinked_at IS NULL)), " +
    "'createdAt', created_at, 'updatedAt', updated_at) " +
  "FROM announcements WHERE id = ?";

const READ_JSON =
  "SELECT json_object('readAt', read_at, 'revisionNo', revision_no) FROM announcement_reads WHERE id = ?";

interface AnnouncementRow {
  id: string; unit_id: string; version: number; title: string; body: string;
  revision_no: number; status: string; published_at: string | null;
  created_at: string; updated_at: string;
  /** 一覧のSELECTで足す派生列（単一行の応答はANNOUNCEMENT_JSONが直接json_objectを組む） */
  audience_json: string; created_by_member_id?: string | null; my_read_at?: string | null; attachments_json?: string;
}

const toAnnouncementDto = (r: AnnouncementRow, audience: string[] | null) =>
  Announcement.parse({
    id: r.id, version: r.version, title: r.title, body: r.body, revisionNo: r.revision_no, status: r.status,
    publishedAt: r.published_at,
    // 対象者ID一覧（他対象者のIDを含む）は管理権限（PER-03）の応答だけに載せる（docs/05 §1。nullは省略）
    ...(audience === null ? {} : { audienceMemberIds: audience }),
    createdByMemberId: r.created_by_member_id ?? null,
    readAt: r.my_read_at ?? null, attachments: r.attachments_json ? (JSON.parse(r.attachments_json) as unknown) : [],
    createdAt: r.created_at, updatedAt: r.updated_at,
  });

/** 存在しない/別unitのお知らせは同じ404（存在を明かさない。activities.tsと同じ流儀） */
async function loadAnnouncement(c: ApiContext, id: string, unitId: string): Promise<AnnouncementRow> {
  const row = await c.env.DB.prepare(
    "SELECT id, unit_id, version, title, body, revision_no, status, published_at, created_at, updated_at FROM announcements WHERE id = ?",
  ).bind(id).first<AnnouncementRow>();
  if (!row || row.unit_id !== unitId) throw new HttpError("NOT_FOUND");
  return row;
}

/** 現行版の対象snapshot（announcement_revisions.audience_snapshot。版と対象は同時に置き換わるため一致が保たれる） */
async function loadAudienceSnapshot(c: ApiContext, id: string, revisionNo: number): Promise<string> {
  const row = await c.env.DB.prepare(
    "SELECT audience_snapshot FROM announcement_revisions WHERE announcement_id = ? AND revision_no = ?",
  ).bind(id, revisionNo).first<{ audience_snapshot: string }>();
  if (!row) throw new HttpError("NOT_FOUND");
  return row.audience_snapshot;
}

/** 対象者は同unitの団員だけ（存在しない/別unitは同じ404。重複は集合として畳む。activities.tsと同じ流儀） */
async function requireAudienceMembers(c: ApiContext, unitId: string, memberIds: readonly string[]): Promise<void> {
  if (memberIds.length === 0) return;
  const rows = (
    await c.env.DB.prepare(
      `SELECT id, unit_id FROM members WHERE id IN (${memberIds.map(() => "?").join(",")})`,
    ).bind(...memberIds).all<{ id: string; unit_id: string }>()
  ).results;
  if (rows.length !== new Set(memberIds).size || rows.some((r) => r.unit_id !== unitId)) {
    throw new HttpError("NOT_FOUND");
  }
}

const audienceInsert = (unitId: string, announcementId: string, memberId: string, userId: string, now: string) =>
  ({
    sql: "INSERT INTO announcement_audience (id, unit_id, announcement_id, member_id, actor_user_id, actor_kind, created_at) VALUES (?, ?, ?, ?, ?, 'human', ?)",
    binds: [crypto.randomUUID(), unitId, announcementId, memberId, userId, now],
  });

/**
 * PER-03（お知らせの管理）をこの主体が持つかの材料。管理者/幹部は所属内、担当は
 * entity_type='announcement'の明示scopeだけ（docs/10 PER-03「明示担当範囲、公開先を編集する権限も必要」）。
 * 一覧で authorize を行ごとに呼ばないため、同じ規則をSQLの可視条件へ写すのに使う。
 * イベント配信（src/server/events/snapshot.ts）の管理可視判定もこれを使う（T072）
 */
export function manageVisibility(p: AuthzPrincipal): { all: boolean; scopedIds: string[] } {
  return {
    all: p.roles.includes("officer") || p.roles.includes("admin"),
    scopedIds: p.scopes
      .filter((s) => s.entityType === "announcement" && s.permissions.includes("PER-03"))
      .map((s) => s.entityId),
  };
}

/**
 * お知らせの可視条件（docs/11 お知らせ行・T045完了条件。API-24と添付配信API-27の共通の正本。T091-S7）:
 * - published は対象者だけ（対象外の一覧・件数に現れない）
 * - draft は PER-03 保持者（作成者/管理権限）だけ
 * - archived は対象者と PER-03 保持者（公開済の記録。終端のため既読は取れない）
 * unit_id の絞り込みは含まない（呼び出し側で付ける）。binds は sql の ? の並び順
 */
export function announcementVisibilitySql(p: AuthzPrincipal, alias: string): { sql: string; binds: unknown[] } {
  const manage = manageVisibility(p);
  const scopedIds = manage.scopedIds;
  const manageVisible = manage.all ? "1 = 1" : scopedIds.length > 0 ? `${alias}.id IN (${scopedIds.map(() => "?").join(",")})` : "0 = 1";
  const audienceVisible =
    `EXISTS (SELECT 1 FROM announcement_audience au WHERE au.announcement_id = ${alias}.id AND au.member_id = ?)`;
  const scopeBinds = manage.all ? [] : scopedIds;
  return {
    sql:
      `((${alias}.status = 'published' AND ${audienceVisible})` +
      ` OR (${alias}.status = 'draft' AND ${manageVisible})` +
      ` OR (${alias}.status = 'archived' AND (${audienceVisible} OR ${manageVisible})))`,
    binds: [p.memberId, ...scopeBinds, p.memberId, ...scopeBinds],
  };
}

/** 単一のお知らせをこの主体が閲覧できるか（API-27の添付配信用。API-24の一覧と同じ条件） */
export async function isAnnouncementVisible(env: Pick<AppEnv, "DB">, p: AuthzPrincipal, announcementId: string): Promise<boolean> {
  const vis = announcementVisibilitySql(p, "a");
  const row = await env.DB.prepare(`SELECT 1 AS ok FROM announcements a WHERE a.id = ? AND a.unit_id = ? AND ${vis.sql}`)
    .bind(announcementId, p.unitId, ...vis.binds).first();
  return row !== null;
}

// --- 署名付きcursor（activities/query.tsと同じ流儀。条件を変えた続き取得・改変cursorは409 SNAPSHOT_CHANGED） ---

interface AnnouncementCursor {
  filterHash: string;
  createdAt: string;
  id: string;
}

const signingKey = (secret: string): Promise<CryptoKey> =>
  crypto.subtle.importKey("raw", new TextEncoder().encode(`announcement-cursor:${secret}`), { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);

const b64url = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes)).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
const unb64url = (s: string) => Uint8Array.from(atob(s.replaceAll("-", "+").replaceAll("_", "/")), (c) => c.charCodeAt(0));

async function encodeCursor(key: CryptoKey, cursor: AnnouncementCursor): Promise<string> {
  const payload = b64url(new TextEncoder().encode(JSON.stringify(cursor)));
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(payload));
  return `${payload}.${b64url(new Uint8Array(sig))}`;
}

/** 改変・署名不一致・型の不整合は全てnull（呼び出し側は条件変更と同じ409にする。activities/query.tsと同じ扱い） */
async function decodeCursor(key: CryptoKey, value: string): Promise<AnnouncementCursor | null> {
  const [payload, sig] = value.split(".");
  if (!payload || !sig) return null;
  try {
    const valid = await crypto.subtle.verify("HMAC", key, unb64url(sig) as BufferSource, new TextEncoder().encode(payload));
    if (!valid) return null;
    const parsed = JSON.parse(new TextDecoder().decode(unb64url(payload))) as AnnouncementCursor;
    if (typeof parsed.filterHash !== "string" || typeof parsed.createdAt !== "string" || typeof parsed.id !== "string") return null;
    return parsed;
  } catch {
    return null;
  }
}

/** お知らせの一覧検索（API-24）。route非依存の単位に分離し、画面（T046）からも同じ条件を使えるようにする */
async function queryAnnouncements(c: ApiContext): Promise<{ items: AnnouncementDto[]; nextCursor?: string }> {
  const p = await resolvePrincipal(c);
  const { query } = await parseApiRequest(c, "API-24");
  requirePermission(p, "PER-01", { unitId: p.unitId, type: "announcement" });

  const manage = manageVisibility(p);
  const vis = announcementVisibilitySql(p, "a");
  const where = ["a.unit_id = ?", vis.sql];
  const binds: unknown[] = [p.unitId, ...vis.binds];
  const scopedIds = manage.scopedIds;
  if (query.status) {
    where.push("a.status = ?");
    binds.push(query.status);
  }

  // 条件の指紋はcursor自体を除いて計算する（activities/query.tsと同じ）
  const key = await signingKey(c.env.BETTER_AUTH_SECRET);
  const { cursor: cursorValue, ...filterOnly } = query;
  const filterHash = await sha256Hex(JSON.stringify(filterOnly));
  if (cursorValue) {
    const cursor = await decodeCursor(key, cursorValue);
    if (!cursor || cursor.filterHash !== filterHash) throw new HttpError("SNAPSHOT_CHANGED");
    // 新しい順（作成降順）の続き。同時刻はid降順で並べ、取りこぼしも重複も作らない
    where.push("(a.created_at < ? OR (a.created_at = ? AND a.id < ?))");
    binds.push(cursor.createdAt, cursor.createdAt, cursor.id);
  }

  // limit+1件だけ読み、続きの有無をnextCursorの有無で返す（件数を黙って切り捨てない。docs/05 §1）。
  // SELECT派生列の本人既読（readAt）のbindが最も先（SQLの並び順）。WHERE句のbindはそのあと
  const rows = (
    await c.env.DB.prepare(
      "SELECT a.id, a.version, a.title, a.body, a.revision_no, a.status, a.published_at, a.created_at, a.updated_at, " +
        "json((SELECT v.audience_snapshot FROM announcement_revisions v WHERE v.unit_id = a.unit_id " +
          "AND v.announcement_id = a.id AND v.revision_no = a.revision_no)) AS audience_json, " +
        "(SELECT m.id FROM members m WHERE m.user_id = a.created_by) AS created_by_member_id, " +
        "(SELECT r.read_at FROM announcement_reads r WHERE r.announcement_id = a.id " +
          "AND r.revision_no = a.revision_no AND r.member_id = ?) AS my_read_at, " +
        "json((SELECT json_group_array(json_object('id', t.id, 'linkId', l.id, 'linkVersion', l.version, " +
            "'status', t.status, 'contentType', t.content_type)) FROM attachment_links l " +
          "JOIN attachments t ON t.id = l.attachment_id AND t.unit_id = l.unit_id " +
          "WHERE l.entity_type = 'announcement' AND l.entity_id = a.id " +
          "AND l.unit_id = a.unit_id AND l.unlinked_at IS NULL)) AS attachments_json " +
        `FROM announcements a WHERE ${where.join(" AND ")} ORDER BY a.created_at DESC, a.id DESC LIMIT ?`,
    ).bind(p.memberId, ...binds, query.limit + 1).all<AnnouncementRow>()
  ).results;

  const page = rows.slice(0, query.limit);
  // 対象者ID一覧は管理権限（PER-03）の応答だけに載せる（docs/05 §1。全件管理権 or その行がscope対象）。
  // 対象者には省略する（他対象者のID一覧を配信しない。API-25/72は管理権限専用なので必ず載る）
  const items = page.map((r) =>
    toAnnouncementDto(r, manage.all || scopedIds.includes(r.id) ? (JSON.parse(r.audience_json) as string[]) : null),
  );
  if (rows.length > query.limit) {
    const last = page[page.length - 1]!;
    return { items, nextCursor: await encodeCursor(key, { filterHash, createdAt: last.created_at, id: last.id }) };
  }
  return { items };
}

export function registerAnnouncementRoutes(app: ApiApp): void {
  // --- API-24: 一覧（可視公開対象のみ。docs/05 API-24「status/limit/cursor;可視公開対象のみ」） ---
  defineRoute(app, "API-24", async (c) => {
    const result = await queryAnnouncements(c);
    return ok(c, result.items, { nextCursor: result.nextCursor });
  });

  // --- API-25: 作成（draft。root/初版/対象snapshotを同一batchで生成。docs/05 API-25「最初draft」） ---
  defineRoute(app, "API-25", async (c) => {
    const p = await resolvePrincipal(c);
    const { body, headers } = await parseApiRequest(c, "API-25");
    requirePermission(p, "PER-03", { unitId: p.unitId, type: "announcement" });
    const audience = [...new Set(body.audienceMemberIds)].sort();
    await requireAudienceMembers(c, p.unitId, audience);

    const id = crypto.randomUUID();
    const revisionId = crypto.randomUUID();
    const result = await executeMutation(c.env, p, {
      operationCode: "announcement.create",
      key: headers["idempotency-key"],
      requestHash: await canonicalRequestHash({ method: "POST", path: "/announcements", body }),
      expectedAuthzVersion: p.authzVersion,
      roots: [],
      created: [{ table: "announcements", id }],
      statements: (ctx) => [
        // 公開予定時刻(publishAt)はpublished_atへ保持する（公開状態への遷移はAPI-72の明示操作。
        // 自動公開jobは作らない。docs/16 T045）
        c.env.DB.prepare(
          "INSERT INTO announcements (id, unit_id, title, body, revision_no, status, published_at, last_mutation_token, created_at, updated_at, created_by, actor_kind) " +
            "VALUES (?, ?, ?, ?, 1, 'draft', ?, ?, ?, ?, ?, 'human')",
        ).bind(id, p.unitId, body.title, body.body, body.publishAt ?? null, ctx.attempt, ctx.now, ctx.now, p.userId),
        // 初版（docs/04:133「変更原本保持」。対象snapshotを同梱する）
        c.env.DB.prepare(
          "INSERT INTO announcement_revisions (id, unit_id, announcement_id, revision_no, title, body, audience_snapshot, actor_user_id, actor_kind, created_at) " +
            "VALUES (?, ?, ?, 1, ?, ?, ?, ?, 'human', ?)",
        ).bind(revisionId, p.unitId, id, body.title, body.body, JSON.stringify(audience), p.userId, ctx.now),
        // 対象はsnapshotで固定（docs/04:134「対象を明示snapshot」）
        ...audience.map((memberId) => {
          const ins = audienceInsert(p.unitId, id, memberId, p.userId, ctx.now);
          return c.env.DB.prepare(ins.sql).bind(...ins.binds);
        }),
      ],
      audit: { action: "announcement.create", entityType: "announcement", entityId: id, metadata: { audienceCount: audience.length, revisionNo: 1 } },
      event: { entityType: "announcement", entityId: id, entityVersion: 1, eventType: "announcement.created" },
      response: { status: 201, sql: ANNOUNCEMENT_JSON, binds: [p.memberId, id], decode: (j) => Announcement.parse(j) },
    });
    return ok(c, result.data, {}, 201);
  });

  // --- API-72: 公開・アーカイブ・改版・対象変更（docs/11の許可辺。内容/対象の変更は新revision。旧版は409） ---
  defineRoute(app, "API-72", async (c) => {
    const p = await resolvePrincipal(c);
    const { params, body, headers } = await parseApiRequest(c, "API-72");
    const current = await loadAnnouncement(c, params.id, p.unitId);
    requirePermission(p, "PER-03", { unitId: p.unitId, type: "announcement", id: params.id });
    // docs/05 §2「同じキー/本文の再送は元HTTP status/dataを返し」: 鍵が既にある（=再送の）ときは
    // 現在の状態では不可になる変更（archived終端・遷移・変更点なし）でも保存済み応答を返す必要があるため、
    // 新しい操作のときだけ状態前提を検査してからbatchに入る（T041/T042と同じ流儀）
    const knownKey = await c.env.DB.prepare(
      "SELECT 1 FROM idempotency_records WHERE actor_user_id = ? AND operation_code = ? AND idempotency_key = ?",
    ).bind(p.userId, "announcement.update", headers["idempotency-key"]).first();

    const statusChange = body.status !== undefined && body.status !== current.status;
    const audienceChange = body.audienceMemberIds !== undefined;
    const audience = audienceChange ? [...new Set(body.audienceMemberIds!)].sort() : [];
    if (audienceChange) await requireAudienceMembers(c, p.unitId, audience);
    const contentChange = body.title !== undefined || body.body !== undefined || audienceChange;

    if (!knownKey) {
      if (statusChange && !canTransition(announcementTransitions, current.status as keyof typeof announcementTransitions, body.status!)) {
        throw new HttpError("INVALID_TRANSITION", undefined, [{ field: "status", reason: "transition_not_allowed" }]);
      }
      // archivedは終端（docs/11 お知らせ）。状態遷移だけでなく内容/対象の変更も受け付けない
      if (!statusChange && current.status === "archived") {
        throw new HttpError("INVALID_TRANSITION", undefined, [{ field: "status", reason: "archived_is_terminal" }]);
      }
      if (!statusChange && !contentChange) {
        throw new HttpError("VALIDATION_ERROR", undefined, [{ field: "(body)", reason: "no_changes" }]);
      }
    }

    // title/body/対象の変更は新revision（docs/11「編集で新revision」。revision_no増分。旧revisionは不変）。
    // 対象だけの変更でも新revisionにする（版の時点の対象を原本に残す。docs/04:133「audience_snapshot」）
    const nextRevisionNo = contentChange ? current.revision_no + 1 : current.revision_no;
    // 新revisionの対象snapshot。対象変更が無い場合は現行版のsnapshotをそのまま引き継ぐ
    const snapshot = audienceChange ? JSON.stringify(audience) : await loadAudienceSnapshot(c, params.id, current.revision_no);
    const nextTitle = body.title ?? current.title;
    const nextBody = body.body ?? current.body;

    const changed =
      [
        ...(statusChange ? ["status"] : []),
        ...(body.title !== undefined || body.body !== undefined ? ["content"] : []),
        ...(audienceChange ? ["audience"] : []),
      ].join(".") || "none";
    const result = await executeMutation(c.env, p, {
      operationCode: "announcement.update",
      key: headers["idempotency-key"],
      requestHash: await canonicalRequestHash({ method: "PATCH", path: `/announcements/${params.id}`, baseVersion: body.version, body }),
      expectedAuthzVersion: p.authzVersion,
      roots: [
        { table: "announcements", id: params.id, expectedVersion: body.version, allowedStates: { column: "status", values: [current.status] } },
      ],
      statements: (ctx) => [
        c.env.DB.prepare(
          `UPDATE announcements SET ` +
            [
              ...(body.title !== undefined ? ["title = ?"] : []),
              ...(body.body !== undefined ? ["body = ?"] : []),
              ...(contentChange ? ["revision_no = ?"] : []),
              ...(statusChange ? ["status = ?"] : []),
              // 公開日時は公開操作時に確定する（作成時に指定したpublishAtを尊重し、無ければ操作時刻。
              // 一度決まったら改版で変えない。docs/16 T045）
              ...(statusChange && body.status === "published" ? ["published_at = COALESCE(published_at, ?)"] : []),
              "version = version + 1", "last_mutation_token = ?", "updated_at = ?",
            ].join(", ") +
            " WHERE id = ? AND unit_id = ? AND version = ?",
        ).bind(
          ...(body.title !== undefined ? [body.title] : []),
          ...(body.body !== undefined ? [body.body] : []),
          ...(contentChange ? [nextRevisionNo] : []),
          ...(statusChange ? [body.status!] : []),
          ...(statusChange && body.status === "published" ? [ctx.now] : []),
          ctx.attempt, ctx.now, params.id, p.unitId, body.version,
        ),
        // 新revision（追記のみ。旧版は変更しない。docs/04:133「変更原本保持」）
        ...(contentChange
          ? [c.env.DB.prepare(
              "INSERT INTO announcement_revisions (id, unit_id, announcement_id, revision_no, title, body, audience_snapshot, actor_user_id, actor_kind, created_at) " +
                "VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'human', ?)",
            ).bind(crypto.randomUUID(), p.unitId, params.id, nextRevisionNo, nextTitle, nextBody, snapshot, p.userId, ctx.now)]
          : []),
        // 対象snapshotの張替え（既読は版に束縛するので消さない。docs/11 お知らせ行）
        ...(audienceChange
          ? [
              c.env.DB.prepare("DELETE FROM announcement_audience WHERE unit_id = ? AND announcement_id = ?").bind(p.unitId, params.id),
              ...audience.map((memberId) => {
                const ins = audienceInsert(p.unitId, params.id, memberId, p.userId, ctx.now);
                return c.env.DB.prepare(ins.sql).bind(...ins.binds);
              }),
            ]
          : []),
      ],
      audit: {
        action: "announcement.update", entityType: "announcement", entityId: params.id,
        metadata: { changed, to: statusChange ? body.status! : current.status, revisionNo: nextRevisionNo },
      },
      event: {
        entityType: "announcement", entityId: params.id, entityVersion: body.version + 1,
        eventType: "announcement.updated", payload: { changed },
      },
      response: { status: 200, sql: ANNOUNCEMENT_JSON, binds: [p.memberId, params.id], decode: (j) => Announcement.parse(j) },
    });
    return ok(c, result.data);
  });

  // --- API-66: 本人既読（版付き。対象者だけ。docs/05 API-66「revisionNo;対象・公開版」） ---
  defineRoute(app, "API-66", async (c) => {
    const p = await resolvePrincipal(c);
    const { params, body, headers } = await parseApiRequest(c, "API-66");
    const current = await loadAnnouncement(c, params.id, p.unitId);
    // docs/05 §2「同じキー/本文の再送は元HTTP status/dataを返し」: 鍵が既にある（=再送の）ときは
    // 現在の状態では不可になる変更（アーカイブ後・旧版指定・対象外）でも保存済み領収を返す必要があるため、
    // 状態前提（公開・対象・現行版）を検査せずexecuteMutationへ渡す（T041と同じ流儀。
    // 認可の再検査と本文の一致検査はexecuteMutationが行う。同キー別本文は409 IDEMPOTENCY_MISMATCH）
    const knownKey = await c.env.DB.prepare(
      "SELECT 1 FROM idempotency_records WHERE actor_user_id = ? AND operation_code = ? AND idempotency_key = ?",
    ).bind(p.userId, "announcement.read", headers["idempotency-key"]).first();

    if (!knownKey) {
      // 公開前draft・archivedへの既読は拒否する（docs/16 T045。存在も明かさない404）。
      // 公開済でなければ、対象者・管理権保持者のどちらにも存在を見せない
      if (current.status !== "published") throw new HttpError("NOT_FOUND");
      // 対象者だけが自分の既読を作れる（docs/04:135「本人のみ」）。対象外は404（存在を明かさない）だが、
      // 管理権（PER-03）保持者による対象者分の既読操作（代理read＝本人以外の操作）は403で拒否する
      // （docs/11「既読は版に束縛」＝既読は本人の操作。docs/16 T045）
      const inAudience = await c.env.DB.prepare(
        "SELECT 1 FROM announcement_audience WHERE announcement_id = ? AND member_id = ?",
      ).bind(params.id, p.memberId).first();
      if (!inAudience) {
        const manage = authorize(p, "PER-03", { unitId: p.unitId, type: "announcement", id: params.id });
        if (manage.allowed) throw new HttpError("FORBIDDEN", undefined, [{ field: "permission", reason: "read_is_self_only" }]);
        throw new HttpError("NOT_FOUND");
      }
      // 既読は版に束縛（docs/11 お知らせ行）。現行版以外のrevisionNoは受け付けない（旧版は既に読めない）
      if (body.revisionNo !== current.revision_no) {
        throw new HttpError("NOT_FOUND", undefined, [{ field: "revisionNo", reason: "revision_not_current" }]);
      }

      // 既読済みなら同じ領収書を返す（行を増やさず初回readAtを保持）
      const existing = await c.env.DB.prepare(
        "SELECT read_at, revision_no FROM announcement_reads WHERE announcement_id = ? AND revision_no = ? AND member_id = ?",
      ).bind(params.id, body.revisionNo, p.memberId).first<{ read_at: string; revision_no: number }>();
      if (existing) {
        return ok(c, ReadReceipt.parse({ readAt: existing.read_at, revisionNo: existing.revision_no }));
      }
    }

    const id = crypto.randomUUID();
    const result = await executeMutation(c.env, p, {
      operationCode: "announcement.read",
      key: headers["idempotency-key"],
      requestHash: await canonicalRequestHash({ method: "PUT", path: `/announcements/${params.id}/read`, body }),
      expectedAuthzVersion: p.authzVersion,
      roots: [],
      created: [{ table: "announcement_reads", id }],
      // batch内でも公開・現行版・対象を再検査する（読んでからの競合で既読を作らない。attendance.tsと同じ流儀）
      conditions: [
        {
          existsSql: "SELECT 1 FROM announcements WHERE id = ? AND unit_id = ? AND status = 'published' AND revision_no = ?",
          binds: [params.id, p.unitId, body.revisionNo],
          failCode: "NOT_FOUND",
        },
        {
          existsSql: "SELECT 1 FROM announcement_audience WHERE announcement_id = ? AND member_id = ?",
          binds: [params.id, p.memberId],
          failCode: "NOT_FOUND",
        },
      ],
      statements: (ctx) => [
        c.env.DB.prepare(
          "INSERT INTO announcement_reads (id, unit_id, announcement_id, revision_no, member_id, read_at, last_mutation_token, created_at, updated_at, created_by, actor_kind) " +
            "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'human')",
        ).bind(id, p.unitId, params.id, body.revisionNo, p.memberId, ctx.now, ctx.attempt, ctx.now, ctx.now, p.userId),
      ],
      duplicateOn: ["announcement_reads.announcement_id", "announcement_reads.revision_no", "announcement_reads.member_id"],
      audit: { action: "announcement.read", entityType: "announcement", entityId: params.id, metadata: { revisionNo: body.revisionNo } },
      event: {
        entityType: "announcement", entityId: params.id, entityVersion: current.version,
        eventType: "announcement.read", payload: { revisionNo: body.revisionNo },
      },
      response: { status: 200, sql: READ_JSON, binds: [id], decode: (j) => ReadReceipt.parse(j) },
    });
    return ok(c, result.data);
  });
}
