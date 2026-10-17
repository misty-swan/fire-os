import { env } from "cloudflare:workers";
import { applyD1Migrations } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import {
  LOAD_ADMIN, LOAD_MEMBER, LOAD_OFFICER, REPRESENTATIVE_PROFILE,
  seedLoad, summarizeLoad, type RequestSample,
} from "../../scripts/seed-load";
import { LoadClient, LoadSampler, idem, makeLoadApp, toJson } from "./helpers";

/**
 * 代表件数下の通常API性能と30端末pollの負荷（T082、docs/14 D18・docs/08 CT-14/AT-NFR-03・docs/13 RG-02）。
 *
 * 測定条件（docs/evidence/V07-performance.mdに正式記録）: ローカルworkerd＋ローカルD1、D18代表件数そのもの
 * （縮小なし）、緩和SecurityPolicy（tests/load/helpers.ts。実環境ではWAF/RL層＋policyの値が効く）、
 * 実回線RTT・実端末は含まない。承認済み合格値は存在しないため、D18の「原目標」（通常API p95 2秒）を
 * **開発目標**として使い、これを実環境の合格と扱わない（実環境測定はV07の残手順）。
 *
 * 確かめること:
 *  - 通常API（閲覧/保存/集計/添付）のp95が開発目標内で、地図（API-10）とAI（API-76）は **別bucket** で測る
 *  - 失敗要求を集計から外さない（omittedFailedRequests=0。平均だけでなくp50/p95/maxで判定する）
 *  - 測定対象の主要クエリに「境界外走査」（絞りに索引を使えない全表走査）が無い（unboundedQueryCount=0）。
 *    計画監査はEXPLAIN QUERY PLAN（ローカルD1＝SQLite）で行う。実D1のrows_read実測はV07残手順
 *  - 出欠イベント（activity_attendance）大量のunitで30端末がpollしたときの、1行ずつACL判定の
 *    読み取り増を実測する（PH6レビュー#6・docs/14 D16＝outbox非正規化の判断材料。V07に記録）
 */

let admin: LoadClient;
let officer: LoadClient;
let member: LoadClient;

beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
  await seedLoad(env, REPRESENTATIVE_PROFILE);
  const app = makeLoadApp();
  admin = new LoadClient(app, env, LOAD_ADMIN);
  officer = new LoadClient(app, env, LOAD_OFFICER);
  member = new LoadClient(app, env, LOAD_MEMBER);
});

const json = async (r: Response) =>
  (await r.json()) as { data?: Record<string, unknown>; error?: { code: string; details?: { field: string; reason: string }[] } };

interface EventPageResponse {
  events: { id: string; entityType: string; entityId: string; entityVersion: number; eventType: string; sequence: number }[];
  resumeCursor: string;
  resyncRequired: boolean;
}

const sleepJittered = (ms: number) => new Promise<void>((r) => setTimeout(r, ms * (0.8 + Math.random() * 0.4)));

// --- クエリ計画監査（unboundedQueryCountの根拠。ローカルD1＝SQLiteのEXPLAIN QUERY PLAN） ---
// 測定対象のAPIが主に使う読み取りを、server実装と同じ形のSQLで再現して監査する（server内部の
// 文を直接差せないための複製。対応する実装をコメントで添える。複製が実装と食い違った場合は
// この監査とV07の概算を直す）。
// 判定: 「SCAN <主表>」で索引（USING INDEX）もFTSのMATCH制約も無い計画を境界外と数える。
// PK/一意索引の点ルックアップ（SEARCH ... USING INDEX）は常に境界内なので監査しない。
interface PlanAudit {
  api: string;
  /** 監査対象の主表（detailのSCAN判定に使う） */
  table: string;
  sql: string;
  binds: unknown[];
}

async function planAudits(unitId: string): Promise<PlanAudit[]> {
  const facility = await env.DB.prepare("SELECT id FROM facilities WHERE unit_id = ? LIMIT 1").bind(unitId).first<{ id: string }>();
  const seq = ((await env.DB.prepare("SELECT event_sequence FROM units WHERE id = ?").bind(unitId).first<{ event_sequence: number }>())!).event_sequence;
  return [
    {
      // API-80（src/server/events/snapshot.ts readEventsの走査。絞り無し）
      api: "API-80", table: "domain_events",
      sql: "SELECT id, unit_id, entity_type, entity_id, entity_version, event_type, payload_minimal, sequence, created_at FROM domain_events WHERE unit_id = ? AND sequence > ? ORDER BY sequence LIMIT 200",
      binds: [unitId, seq],
    },
    {
      // API-80（絞り付き。SCR-12の詳細同期）
      api: "API-80-filtered", table: "domain_events",
      sql: "SELECT id, unit_id, entity_type, entity_id, entity_version, event_type, payload_minimal, sequence, created_at FROM domain_events WHERE unit_id = ? AND sequence > ? AND entity_type = ? AND entity_id = ? ORDER BY sequence LIMIT 200",
      binds: [unitId, seq, "incident", crypto.randomUUID()],
    },
    {
      // 全APIのprincipal解決（src/server/auth/principal.ts BASE_SQL）
      api: "principal", table: "users",
      sql: "SELECT u.id AS user_id, u.authz_version, u.status AS user_status, u.session_revoked_before, m.id AS member_id, m.status AS member_status, m.unit_id, n.status AS unit_status, m.display_name, m.rank, n.name AS unit_name FROM users u JOIN members m ON m.user_id = u.id JOIN units n ON n.id = m.unit_id WHERE u.id = ?",
      binds: [LOAD_MEMBER.userId],
    },
    {
      // API-02（src/server/routes/members.ts。絞り無しの先頭ページ）
      api: "API-02", table: "members",
      sql: "SELECT m.id, m.version, m.display_name, m.rank, m.squad, m.qualifications, m.joined_at, m.status, m.user_id FROM members m WHERE m.unit_id = ? ORDER BY m.display_name, m.id LIMIT ?",
      binds: [unitId, 51],
    },
    {
      // API-10（src/server/gis/query.ts。地図データ源。map bucket）
      api: "API-10", table: "facilities",
      sql: "SELECT id, version, type, management_number, identifying_name, latitude, longitude, location_source, location_note, location_version, verification_status, last_verified_at, metadata FROM facilities WHERE unit_id = ? AND archived_at IS NULL ORDER BY id LIMIT ?",
      binds: [unitId, 101],
    },
    {
      // API-44（src/server/routes/facility-inspections.ts。施設の点検履歴）
      api: "API-44", table: "facility_inspections",
      sql: "SELECT * FROM facility_inspections WHERE unit_id = ? AND facility_id = ? ORDER BY inspected_at DESC, id DESC LIMIT ?",
      binds: [unitId, facility!.id, 51],
    },
    {
      // API-28（src/server/routes/dashboard.tsの件数。活動/異常/通知/タスク）
      api: "API-28-activities", table: "activities",
      sql: "SELECT COUNT(*) AS n FROM activities a WHERE a.unit_id = ? AND a.planned_starts_at >= ? AND a.status = ?",
      binds: [unitId, new Date().toISOString(), "scheduled"],
    },
    {
      api: "API-28-issues", table: "issues",
      sql: "SELECT COUNT(*) AS n FROM issues WHERE unit_id = ? AND status = ?",
      binds: [unitId, "reported"],
    },
    {
      api: "API-28-notifications", table: "notification_recipients",
      sql: "SELECT COUNT(*) AS n FROM notifications n JOIN notification_recipients r ON r.notification_id = n.id AND r.unit_id = n.unit_id WHERE n.unit_id = ? AND r.member_id = ? AND n.status IN ('approved', 'dispatching', 'finished', 'failed') AND r.read_at IS NULL",
      binds: [unitId, LOAD_MEMBER.memberId],
    },
    {
      api: "API-28-tasks", table: "tasks",
      sql: "SELECT COUNT(*) AS n FROM tasks WHERE unit_id = ? AND assignee_member_id = ? AND status IN ('open', 'assigned', 'in_progress')",
      binds: [unitId, LOAD_MEMBER.memberId],
    },
    {
      // API-52（src/server/analytics/query.ts。年度集計の活動側）
      api: "API-52", table: "activities",
      sql: "SELECT a.id, a.operation_id, a.title, a.kind, a.planned_starts_at, v.actual_starts_at, v.actual_ends_at FROM activities a JOIN activity_results r ON r.unit_id = a.unit_id AND r.activity_id = a.id JOIN activity_result_revisions v ON v.unit_id = r.unit_id AND v.result_id = r.id AND v.id = r.current_revision_id WHERE a.unit_id = ? AND a.planned_starts_at >= ? AND a.planned_starts_at < ?",
      binds: [unitId, "2026-03-31T15:00:00.000Z", "2027-03-31T15:00:00.000Z"],
    },
    {
      // API-80の1バッチACL判定（src/server/events/snapshot.ts visibleFlagsOfBatchの出欠branch。
      // T082で1行ずつの点ルックアップからIN一括へ変えた。PH6レビュー#6）
      api: "eventVisible-attendance", table: "activity_attendance",
      sql: "SELECT a.id, a.member_id, a.activity_id, act.owner_member_id FROM activity_attendance a JOIN activities act ON act.id = a.activity_id AND act.unit_id = a.unit_id WHERE a.unit_id = ? AND a.id IN (?, ?, ?)",
      binds: [unitId, crypto.randomUUID(), crypto.randomUUID(), crypto.randomUUID()],
    },
    {
      // API-76（src/server/search/adapter.ts。FTS検索。ai bucket）
      api: "API-76", table: "document_chunks_fts",
      sql: "SELECT document_chunks_fts.chunk_id, document_chunks_fts.version_id, v.document_id, c.chunk_no, c.page_no, c.section, c.text, document_chunks_fts.rank FROM document_chunks_fts JOIN document_chunks c ON c.unit_id = document_chunks_fts.unit_id AND c.id = document_chunks_fts.chunk_id AND c.version_id = document_chunks_fts.version_id AND c.index_status = 'indexed' JOIN document_versions v ON v.unit_id = document_chunks_fts.unit_id AND v.id = document_chunks_fts.version_id AND v.status = 'approved' JOIN documents d ON d.unit_id = v.unit_id AND d.id = v.document_id AND d.status <> 'withdrawn' WHERE document_chunks_fts MATCH ? AND document_chunks_fts.unit_id = ? ORDER BY document_chunks_fts.rank LIMIT ?",
      binds: ['"巡視要領"', unitId, 5],
    },
  ];
}

/** 計画監査の実行。「SCAN <主表>」で索引もFTS MATCH制約も無い計画を境界外として数える */
async function auditQueryPlans(unitId: string): Promise<Map<string, number>> {
  const result = new Map<string, number>();
  for (const audit of await planAudits(unitId)) {
    const rows = (await env.DB.prepare(`EXPLAIN QUERY PLAN ${audit.sql}`).bind(...audit.binds).all<{ detail: string }>()).results;
    const unbounded = rows.filter(
      (r) =>
        r.detail.startsWith(`SCAN ${audit.table}`) &&
        !r.detail.includes("USING INDEX") &&
        !/VIRTUAL TABLE INDEX \d+:M/.test(r.detail),
    );
    if (unbounded.length > 0) {
      console.error(`[plan-audit] ${audit.api}: 境界外走査 ${JSON.stringify(rows.map((r) => r.detail))}`);
    }
    result.set(audit.api, unbounded.length);
  }
  return result;
}

/** metricsを1行ずつ出す（実測値の証跡。実行ログをdocs/evidence/V07-performance.mdへ転記する） */
function printMetrics(title: string, m: ReturnType<typeof summarizeLoad>, samples: RequestSample[]): void {
  console.log(`[metrics] ${title}: total=${m.total} failed=${m.failedCount} ordinaryP95=${m.ordinaryApiP95Ms}ms unbounded=${m.unboundedQueryCount}`);
  for (const [bucket, s] of Object.entries(m.buckets)) {
    console.log(`[metrics]   ${bucket}: n=${s.count} failed=${s.failedCount} p50=${s.p50Ms}ms p95=${s.p95Ms}ms max=${s.maxMs}ms`);
  }
  // apiごとの内訳（CT-14「平均値だけで判定しない」の証跡。遅いapiをoperation単位で見る）
  const byApi = new Map<string, number[]>();
  for (const s of samples) {
    if (s.bucket !== "ordinary" && s.bucket !== "map" && s.bucket !== "ai") continue;
    const list = byApi.get(`${s.bucket}/${s.api}`) ?? [];
    list.push(s.durationMs);
    byApi.set(`${s.bucket}/${s.api}`, list);
  }
  for (const [key, ds] of [...byApi.entries()].sort((a, b) => Math.max(...b[1]) - Math.max(...a[1]))) {
    const sorted = [...ds].sort((x, y) => x - y);
    console.log(`[metrics-api] ${key}: n=${ds.length} p50=${sorted[Math.floor(sorted.length / 2)]}ms p95=${sorted[Math.ceil(sorted.length * 0.95) - 1]}ms max=${sorted.at(-1)}ms`);
  }
}

describe("代表件数・30端末の性能 (T082)", () => {
  it(
    "ordinary_api_p95_is_measured_separately_from_map_and_ai",
    async () => {
      // --- 0) クエリ計画監査（要求の前に。結果はsampleへ記録してsummarizeLoadが合計する） ---
      const unboundedByApi = await auditQueryPlans(LOAD_MEMBER.unitId);
      const sampler = new LoadSampler(env, unboundedByApi);

      // --- 1) 負荷の下地: 30端末のpoll接続（0.5req/s±20%。V06の実測条件と同じ） ---
      // cursorは現在のunit連番の位置（空ページ）から始める＝定常状態のpoll。履歴のdrainは
      // reconnect-load.test.ts（切断後の再接続）と下のattendanceケースで測る
      const seq = ((await env.DB.prepare("SELECT event_sequence FROM units WHERE id = ?").bind(LOAD_MEMBER.unitId)
        .first<{ event_sequence: number }>())!).event_sequence;
      const first = await member.request("GET", `/api/v1/events?afterSequence=${seq}`);
      expect(first.status).toBe(200);
      const firstPage = (await toJson<{ data: { resumeCursor: string } }>(first)).data;

      interface PollTerminal { cursor: string; stop: boolean; loop: Promise<void> }
      const POLL_MS = 2_000;
      const terminals: PollTerminal[] = Array.from({ length: REPRESENTATIVE_PROFILE.terminals }, () => ({
        cursor: firstPage.resumeCursor,
        stop: false,
        loop: Promise.resolve(),
      }));
      for (const t of terminals) {
        t.loop = (async () => {
          while (!t.stop) {
            await sleepJittered(POLL_MS);
            if (t.stop) break;
            const r = await sampler.run("API-80", "poll", () => member.request("GET", `/api/v1/events?cursor=${encodeURIComponent(t.cursor)}`));
            if (r.status === 200) {
              t.cursor = (await toJson<{ data: EventPageResponse }>(r)).data.resumeCursor;
            }
          }
        })();
      }

      // --- 2) 通常APIの要求mix（閲覧/保存/集計/添付。地図とAIは別bucket）。30端末が並列に回す ---
      // 地図データ源（API-10）のidを1回だけ非計測で取り（詳細のidに使う）。地図の一覧そのものは
      // 各端末の初回ラウンドでmap bucketとして30本計測する（1本だけの分布を実測と偽らない）
      const facilityPage0 = await member.request("GET", "/api/v1/facilities?limit=100");
      expect(facilityPage0.status).toBe(200);
      const facilityIds = (await toJson<{ data: { id: string }[] }>(facilityPage0)).data.map((f) => f.id);

      const ROUNDS = 4;
      const deviceLoops = Array.from({ length: REPRESENTATIVE_PROFILE.terminals }, (_, d) =>
        (async () => {
          for (let round = 0; round < ROUNDS; round++) {
            // 地図（map bucket。API-10の一覧＝地図データ源。通常APIのp95に含めない）
            if (round === 0) {
              expect((await sampler.run("API-10", "map", () => member.request("GET", "/api/v1/facilities?limit=100"))).status).toBe(200);
            }
            // 閲覧: 名簿・施設詳細・点検履歴・文書一覧（一般団員の画面が開く要求）
            expect((await sampler.run("API-01", "ordinary", () => member.request("GET", "/api/v1/me"))).status).toBe(200);
            expect((await sampler.run("API-02", "ordinary", () => member.request("GET", "/api/v1/members?limit=50"))).status).toBe(200);
            const fid = facilityIds[(d + round) % facilityIds.length]!;
            expect((await sampler.run("API-12", "ordinary", () => member.request("GET", `/api/v1/facilities/${fid}`))).status).toBe(200);
            expect((await sampler.run("API-44", "ordinary", () => member.request("GET", `/api/v1/facilities/${fid}/inspections?limit=50`))).status).toBe(200);
            expect((await sampler.run("API-90", "ordinary", () => member.request("GET", "/api/v1/documents?limit=50"))).status).toBe(200);
            // 集計: ホームの指標（団員）と年度集計（幹部）
            expect((await sampler.run("API-28", "ordinary", () => member.request("GET", "/api/v1/dashboard"))).status).toBe(200);
            expect((await sampler.run("API-52", "ordinary", () => officer.request("GET", "/api/v1/analytics"))).status).toBe(200);
            // 保存: 出動の記録（幹部。create＋訂正の1組。このcommitはpoll配信にも流れる）
            const created = await sampler.run("API-22", "ordinary", () =>
              officer.request("POST", "/api/v1/incidents", { kind: "training", occurredAt: "2026-10-17T02:00:00.000Z", summary: `負荷試験の架空出動 d${d} r${round}` }, idem()));
            expect(created.status).toBe(201);
            const incident = (await json(created)).data! as { id: string; version: number };
            const patched = await sampler.run("API-69", "ordinary", () =>
              officer.request("PATCH", `/api/v1/incidents/${incident.id}`, { version: incident.version, status: "active", reason: "訓練を開始（架空）" }, idem()));
            expect(patched.status).toBe(200);
            // 検索（AI）: RAGは幹部（PER-09）。通常APIのp95に含めない（ai bucket。ローカルはfake AIで決定的応答。
            // trigramは3字以上の語が一致する（T065実測の限界）ため検索語は4字にする）
            expect((await sampler.run("API-76", "ai", () => officer.request("POST", "/api/v1/search/rag", { query: "巡視要領" }))).status).toBe(200);
          }
          // 添付: draft→intent→upload（1端末1本。小さなPNG。対象語彙はattachmentTargetTypesから
          // 「点検」（実在の対象）。実環境ではAPI-83はupload bucketの上限が効く）
          const draft = await sampler.run("API-98", "ordinary", () =>
            officer.request("POST", "/api/v1/attachment-drafts", { intendedEntityType: "inspection" }, idem()));
          expect(draft.status).toBe(201);
          const draftBody = (await json(draft)).data! as { id: string };
          const bytes = new Uint8Array(100).fill(d);
          const intent = await sampler.run("API-26", "ordinary", () =>
            officer.request("POST", "/api/v1/attachments/upload-intents", {
              target: { type: "attachment_draft", id: draftBody.id }, contentType: "image/png", byteSize: bytes.byteLength,
            }, idem()));
          expect(intent.status).toBe(201);
          const intentBody = (await json(intent)).data! as { id: string; uploadToken: string };
          const uploaded = await sampler.run("API-83", "ordinary", () =>
            officer.raw(new Request(`http://example.com/api/v1/attachments/${intentBody.id}/upload`, {
              method: "PUT", headers: { "content-type": "application/octet-stream", "x-upload-token": intentBody.uploadToken }, body: bytes as BufferSource,
            })));
          expect(uploaded.status).toBe(200);
        })(),
      );
      await Promise.all(deviceLoops);

      // --- 3) pollをもう少し回して定常のpoll分布を確保してから止める ---
      await sleepJittered(10_000);
      for (const t of terminals) t.stop = true;
      await Promise.all(terminals.map((t) => t.loop));

      // --- 4) 集計と断言（ブリーフの4断言） ---
      const metrics = summarizeLoad(sampler.samples);
      printMetrics("通常API負荷（代表件数＋30端末poll併走）", metrics, sampler.samples);

      const ordinaryApiP95Ms = metrics.ordinaryApiP95Ms;
      const omittedFailedRequests = metrics.omittedFailedRequests;
      const aiMeasuredSeparately = metrics.aiMeasuredSeparately;
      const unboundedQueryCount = metrics.unboundedQueryCount;

      // 失敗が1件でもあれば中身を出す（どのapiがどう失敗したか。成功だけの性能判定をしない）
      if (metrics.failedCount > 0) {
        const failed = sampler.samples.filter((s) => !s.ok);
        console.error("失敗sample:", JSON.stringify(failed.slice(0, 20), null, 2));
      }
      expect(omittedFailedRequests).toBe(0); // 失敗は記録され、集計から外されない
      expect(metrics.failedCount).toBe(0); // 代表件数下で全要求が成功する
      expect(aiMeasuredSeparately).toBe(true); // AIは別bucketで測った（ordinaryに混ざらない）
      expect(unboundedQueryCount).toBe(0); // 主要クエリに境界外走査が無い（EXPLAIN QUERY PLAN）
      // D18の開発目標（原目標2秒。承認済み合格値ではない＝docs/14 D18）
      expect(ordinaryApiP95Ms).toBeLessThanOrEqual(2000);
    },
    600_000,
  );

  it(
    "attendance_event_acl_scan_is_bounded_and_measured_for_denormalization_decision",
    async () => {
      // --- 出欠イベント大量のunitで30端末がpollしたときの1行ずつACL判定（PH6レビュー#6・docs/14 D16） ---
      // member（一般団員。PER-03無し）にとって出欠イベントは **非可視** なので、走査は1行ごとに
      // activity_attendanceの点ルックアップを行って進む（scan位置だけが進む。docs/05 §8）。
      // これが「outboxへのmember_id/activity_id非正規化が要るか」の判断材料になる（V07に記録）。
      const range = (await env.DB.prepare(
        "SELECT MIN(sequence) AS min, MAX(sequence) AS max, COUNT(*) AS n FROM domain_events WHERE unit_id = ? AND entity_type = 'activity_attendance'",
      ).bind(LOAD_MEMBER.unitId).first<{ min: number; max: number; n: number }>())!;
      expect(range.n).toBeGreaterThan(1_000); // seedが「大量」を作れていることの確認
      // 本人の出欠行は本人に見える（API-07と同じ読み取り規則＝行の本人またはPER-03）。だから
      // 「漏えい」の判定は、**本人以外の行**が1行も見えないことである（自分の行の配信は正しい挙動）
      const ownAttendance = new Set(
        ((await env.DB.prepare("SELECT id FROM activity_attendance WHERE unit_id = ? AND member_id = ?")
          .bind(LOAD_MEMBER.unitId, LOAD_MEMBER.memberId).all<{ id: string }>()).results).map((r) => r.id),
      );

      // 30端末が出欠イベントの直前から接続（=窓が全て出欠イベントの最悪ケース）
      const cursors: string[] = [];
      for (let i = 0; i < REPRESENTATIVE_PROFILE.terminals; i++) {
        const r = await member.request("GET", `/api/v1/events?afterSequence=${range.min - 1}`);
        expect(r.status).toBe(200);
        cursors.push((await toJson<{ data: { resumeCursor: string } }>(r)).data.resumeCursor);
      }
      const drainSamples: RequestSample[] = [];
      let leaked = 0;
      let ownDelivered = 0;
      await Promise.all(cursors.map((cursor0) =>
        (async () => {
          let cursor = cursor0;
          for (;;) {
            const t0 = Date.now();
            const r = await member.request("GET", `/api/v1/events?cursor=${encodeURIComponent(cursor)}`);
            const durationMs = Date.now() - t0;
            expect(r.status).toBe(200);
            const page = (await toJson<{ data: EventPageResponse }>(r)).data;
            leaked += page.events.filter((e) => e.entityType === "activity_attendance" && !ownAttendance.has(e.entityId)).length; // 他人の行は1行も見えてはいけない
            ownDelivered += page.events.filter((e) => e.entityType === "activity_attendance" && ownAttendance.has(e.entityId)).length;
            drainSamples.push({ api: "API-80-attendance-drain", bucket: "poll", ok: true, status: 200, durationMs });
            cursor = page.resumeCursor;
            if (page.events.length === 0) break; // 窓の末尾まで走査した
          }
        })(),
      ));
      expect(leaked).toBe(0); // 非可視の出欠行（他人の行）が1行も露出しない（fail-closedの確認）
      expect(ownDelivered).toBeGreaterThan(0); // 本人の行は本人へ配信される（API-07と同じ規則の確認）

      // 比較基準: 同じ一般団員が窓0（空ページ）でpollしたときの遅延（30要求）
      const baseline: number[] = [];
      for (let i = 0; i < REPRESENTATIVE_PROFILE.terminals; i++) {
        const t0 = Date.now();
        const r = await member.request("GET", `/api/v1/events?afterSequence=${range.max}`);
        expect(r.status).toBe(200);
        baseline.push(Date.now() - t0);
      }

      const sorted = [...drainSamples.map((s) => s.durationMs)].sort((a, b) => a - b);
      const drainP50 = sorted[Math.floor(sorted.length / 2)]!;
      const drainP95 = sorted[Math.ceil(sorted.length * 0.95) - 1]!;
      const baselineP50 = [...baseline].sort((a, b) => a - b)[Math.floor(baseline.length / 2)]!;
      console.log(`[attendance-drain] 出欠イベント窓の30端末drain: n=${drainSamples.length} p50=${drainP50}ms p95=${drainP95}ms max=${sorted.at(-1)}ms / 空ページ基線 p50=${baselineP50}ms / 1要求の走査上限=1000行（SCAN_MAX_ROWS）`);
      // 境界の確認: 1要求の走査はSCAN_MAX_ROWS=1000で有界（docs/14 D16）。遅延もD18開発目標内。
      // ここが超えたら実測値とともに「非正規化の再評価」をdocs/14 D16へ提案する（V07の判断材料）
      expect(drainP95).toBeLessThanOrEqual(2000);
    },
    600_000,
  );
});
