import type { AppEnv } from "../src/server/env";

/**
 * 代表件数のseedと負荷測定の集計（T082、docs/14 D18の代表負荷・docs/08 CT-14・AT-NFR-03）。
 *
 * - `seedLoad(env, profile)`: D18の代表件数（施設1,000/点検年10,000/文書100×20頁/30同時端末）を
 *   1つの負荷試験用unitへ直接INSERTで作る（fixtures作法と同じ直接INSERT＝mutation経路を使わない）。
 *   mutation経路を通らないため、**1年分のoutbox（domain_events）はseed自身が作る**（点検10,000件＝
 *   記録1万mutation分、出欠回答約2,300件など。units.event_sequenceも最後まで進める）。これで
 *   API-80の走査と1行ずつACL判定を代表件数下で測れる。
 * - `summarizeLoad(samples)`: 測定sample（RequestSample）から **平均だけでなくp50/p95/maxと失敗数** を
 *   bucket（ordinary/map/ai/poll）ごとに集計する（docs/08 CT-14「平均値だけで判定しない」）。
 *   地図（API-10の一覧＝地図データ源）とAI（API-76検索/RAG）は **別bucket** で測り、通常APIのp95に
 *   混ぜない（docs/08 AT-NFR-03「通常API p95<=2秒の条件を明記、地図/AIを別測定」）。
 *   失敗sampleは外さず数える（成功要求だけの性能判定を禁止＝docs/08 CT-14）。
 *
 * CLI: `npx tsx scripts/seed-load.ts --out /tmp/seed-load.sql` で同じseedのSQLを生成する。
 * 適用は `wrangler d1 execute DB --local --file /tmp/seed-load.sql`（ローカルのworkerd外にはenvが無い
 * ため、試験基盤の外で代表件数を再現するときはwrangler経由で流す）。
 */

/** D18の代表負荷（docs/14 D18「施設1,000/点検年10,000/30同時端末等」＋docs/08 AT-NFR-03） */
export interface LoadProfile {
  /** 施設の件数（D18: 1,000） */
  facilities: number;
  /** 施設点検の年間件数（D18: 10,000） */
  inspectionsPerYear: number;
  /** 許諾文書の件数（D18: 100） */
  documents: number;
  /** 文書1件の頁数（＝chunk数。D18: 20頁） */
  documentPages: number;
  /** 同時端末数（D18: 30。接続数であって利用者数ではない） */
  terminals: number;
  /**
   * 名簿の一般団員数（出欠の対象母数。分団規模の目安として30。D18は「端末30」であって「名簿30」ではないため
   * 別の値として明示する。役割3名〔管理者/幹部/団員〕と合わせてunitの名簿は33名になる）
   */
  members: number;
  /** 年間の活動件数（出欠イベントの源。週2回ペースの目安として100） */
  activitiesPerYear: number;
  /** 対象者のうち回答した割合（出欠行＝活動×対象×この割合。0.7） */
  responseRate: number;
}

/** D18の代表件数そのもの（縮小なし。docs/evidence/V07-performance.mdの測定条件に記録） */
export const REPRESENTATIVE_PROFILE: LoadProfile = {
  facilities: 1_000,
  inspectionsPerYear: 10_000,
  documents: 100,
  documentPages: 20,
  terminals: 30,
  members: 30,
  activitiesPerYear: 100,
  responseRate: 0.7,
};

/** 負荷試験用unit（固定ID。試験ファイルごとに隔離storageなので衝突しない。二重seedはseedLoad内で防ぐ） */
export const LOAD_UNIT_ID = "00000000-0000-4000-8000-00000000f001";
/** 負荷試験の利用者（x-test-identity注入用。管理者/幹部/一般団員。状態は毎要求DBから引かれる） */
export const LOAD_ADMIN = { userId: "00000000-0000-4000-8000-00000000f0a1", memberId: "00000000-0000-4000-8000-00000000f0b1", unitId: LOAD_UNIT_ID };
export const LOAD_OFFICER = { userId: "00000000-0000-4000-8000-00000000f0a2", memberId: "00000000-0000-4000-8000-00000000f0b2", unitId: LOAD_UNIT_ID };
export const LOAD_MEMBER = { userId: "00000000-0000-4000-8000-00000000f0a3", memberId: "00000000-0000-4000-8000-00000000f0b3", unitId: LOAD_UNIT_ID };

/** 測定の区分。通常API（ordinary）のp95にはmap/ai/pollを **含めない**（docs/08 CT-14・AT-NFR-03） */
export type LoadBucket = "ordinary" | "map" | "ai" | "poll";

/** AI系列として通常APIに混ぜないAPI（src/server/security/limits.tsのAI区分と同じ。負荷試験で実際に叩くのはAPI-76） */
const AI_LABELS = new Set(["API-29", "API-32", "API-76", "API-77", "API-89"]);

/** 1要求の測定sample。失敗も必ず記録する（成功だけの性能判定を禁止＝docs/08 CT-14） */
export interface RequestSample {
  /** 計測した要求（API番号。遅延は要求単位で、ページ数など応答内容は含めない） */
  api: string;
  bucket: LoadBucket;
  ok: boolean;
  status: number;
  durationMs: number;
  /**
   * この要求のapiについてクエリ計画監査（EXPLAIN QUERY PLAN）で「境界外走査」（絞りに索引を使えない
   * 全表走査）と判定された計画の数。監査は試験側で実施し、結果をここへ記録する（省略は0＝境界内）。
   * summarizeLoadは合計してunboundedQueryCountにする。
   */
  unboundedQueries?: number;
}

export interface BucketMetrics {
  count: number;
  failedCount: number;
  p50Ms: number;
  p95Ms: number;
  maxMs: number;
}

export interface LoadMetrics {
  total: number;
  failedCount: number;
  /** 失敗を集計から外した数。このrunnerは外さないので常に0（summarizeが保証する。0以外はrunnerの欠陥） */
  omittedFailedRequests: number;
  /** 通常API（ordinary bucket）のp95。開発目標は2,000ms（docs/14 D18の「原目標」。承認済み合格値ではない） */
  ordinaryApiP95Ms: number;
  buckets: Record<LoadBucket, BucketMetrics>;
  /** AI（検索/RAG）を通常APIと別のbucketで測定したか（ordinaryにAI系列が1件も混ざっていないことを含む） */
  aiMeasuredSeparately: boolean;
  /** 記録された境界外走査の合計（0が合格。クエリ計画監査の結果） */
  unboundedQueryCount: number;
}

// ============================================================================
// seed本体（fixtures作法と同じ直接INSERT。CHECK制約の正本はdrizzle/*.sql）
// ============================================================================

const NOW = "2026-10-13T00:00:00.000Z";
const ROLE_IDS = {
  member: "00000000-0000-4000-8000-000000000101",
  officer: "00000000-0000-4000-8000-000000000103",
  admin: "00000000-0000-4000-8000-000000000104",
} as const;
/** 架空の文書の語（実在の団体・地名は使わない＝AGENTS.md。API-76の検索語にも使う語を含む） */
const FICTIONAL_TEXT = "堤防の巡視要領（架空）。豪雨時は請負業者と連絡を取り、水位を確認して本部へ報告する。";

/** 1つのINSERT文（db.batchへ渡す形。CLIはこれをSQLへ直列化する） */
export interface SeedStatement {
  sql: string;
  binds: unknown[];
}

export interface SeedPlan {
  /** 1つのbatchに入れる必要のある文のグループ（点検のseries↔原本・文書のroot↔版の循環参照。境界で分割しない） */
  groups: SeedStatement[][];
  /** seed後のunit連番（outboxの総行数。units.event_sequenceはここまで進む） */
  eventSequence: number;
  /** outboxに作った出欠イベントのsequence範囲（非正規化の判断材料の測定点） */
  attendanceRange: { min: number; max: number };
  stats: Record<string, number>;
}

const insert = (table: string, cols: string[], binds: unknown[]): SeedStatement => ({
  sql: `INSERT INTO ${table} (${cols.join(", ")}) VALUES (${cols.map(() => "?").join(", ")})`,
  binds,
});

/**
 * 連番の固定UUID（小文字UUID＝契約のId形。「00000000-0000-4000-8000-」＋block（1〜4桁hex）＋
 * 残りを0埋めした連番。粒度は16^(12-桁数)まで＝各件数の上限。超えるprofileは拒否する）。
 */
const blockId = (block: string, n: number): string => {
  if (!/^[0-9a-f]{1,4}$/.test(block)) throw new Error(`seed-load: blockIdのblockは1〜4桁hex（${block}）`);
  const width = 12 - block.length;
  const limit = 16 ** width;
  if (n < 1 || n >= limit) throw new Error(`seed-load: blockId(${block}, ${n}) は${limit - 1}まで（profileが大きすぎる）`);
  return `00000000-0000-4000-8000-${block}${n.toString(16).padStart(width, "0")}`;
};

/**
 * 代表件数のseed計画を作る（純関数。seedLoadとCLIで共有する）。
 * 行の内容はすべて架空データ（AGENTS.md。実名簿・実地名は載せない）。
 */
export function buildSeedPlan(profile: LoadProfile): SeedPlan {
  const groups: SeedStatement[][] = [];
  const group = (stmts: SeedStatement[]) => groups.push(stmts);
  const stats: Record<string, number> = {};

  // --- unitと利用者（fixtures/core.tsと同じ形。x-test-identityはuserIdを注入し、状態はDBから引く）。
  //     順序はFKの親→子（users→units→members→member_roles。D1のbatchはFKを即時検査する） ---
  const head: SeedStatement[] = [];
  for (const who of [LOAD_ADMIN, LOAD_OFFICER, LOAD_MEMBER]) {
    head.push(insert("users", ["id", "auth_id", "status", "created_at", "updated_at"],
      [who.userId, `auth-load-${who.userId}`, "active", NOW, NOW]));
  }
  head.push(insert("units", ["id", "name", "status", "created_at", "updated_at", "created_by", "actor_kind"],
    [LOAD_UNIT_ID, "架空市 負荷試験分団", "active", NOW, NOW, LOAD_ADMIN.userId, "human"]));
  const people: { identity: typeof LOAD_ADMIN; displayName: string; rank: string; role: keyof typeof ROLE_IDS }[] = [
    { identity: LOAD_ADMIN, displayName: "架空 負荷管理者", rank: "分団長", role: "admin" },
    { identity: LOAD_OFFICER, displayName: "架空 負荷幹部", rank: "副分団長", role: "officer" },
    { identity: LOAD_MEMBER, displayName: "架空 負荷団員", rank: "団員", role: "member" },
  ];
  for (const p of people) {
    head.push(insert("members", ["id", "unit_id", "user_id", "display_name", "rank", "status", "created_at", "updated_at", "created_by", "actor_kind"],
      [p.identity.memberId, LOAD_UNIT_ID, p.identity.userId, p.displayName, p.rank, "active", NOW, NOW, LOAD_ADMIN.userId, "human"]));
    head.push(insert("member_roles", ["id", "unit_id", "member_id", "role_id", "granted_by", "created_at", "updated_at", "created_by", "actor_kind"],
      [crypto.randomUUID(), LOAD_UNIT_ID, p.identity.memberId, ROLE_IDS[p.role], LOAD_ADMIN.userId, NOW, NOW, LOAD_ADMIN.userId, "human"]));
  }
  // 一般団員（user無し。出欠の対象母数＝名簿は33名になる）
  const rosterIds: string[] = people.map((p) => p.identity.memberId);
  for (let i = 1; i <= profile.members; i++) {
    const memberId = blockId("ff", i);
    rosterIds.push(memberId);
    head.push(insert("members", ["id", "unit_id", "user_id", "display_name", "rank", "status", "created_at", "updated_at", "created_by", "actor_kind"],
      [memberId, LOAD_UNIT_ID, null, `架空 団員${String(i).padStart(2, "0")}`, "団員", "active", NOW, NOW, LOAD_ADMIN.userId, "human"]));
  }
  group(head);
  stats.members = rosterIds.length;

  // --- 施設1,000（D18。種別×管理番号は一意。座標は架空の領域に均す） ---
  const facilityIds: string[] = [];
  const facilityTypes = ["hydrant", "cistern", "box"] as const;
  const facilityGroup: SeedStatement[] = [];
  for (let i = 1; i <= profile.facilities; i++) {
    const id = blockId("a", i);
    facilityIds.push(id);
    facilityGroup.push(insert("facilities", ["id", "unit_id", "type", "management_number", "identifying_name", "latitude", "longitude",
      "location_note", "location_source", "location_version", "verification_status", "last_verified_at", "metadata",
      "created_at", "updated_at", "created_by", "actor_kind"],
    [id, LOAD_UNIT_ID, facilityTypes[i % 3]!, `LF-${String(i).padStart(5, "0")}`, `架空の施設${i}`,
      35.6 + (i % 200) / 1000, 139.7 + (i % 200) / 1000,
      `架空市${i % 40}丁目（負荷試験の架空施設）`, "架空の台帳（seed）", 1, "verified", NOW, "{}",
      NOW, NOW, LOAD_ADMIN.userId, "human"]));
  }
  group(facilityGroup);
  stats.facilities = facilityIds.length;

  // --- 点検のseries・原本（D18: 年10,000。1施設あたり10本/年＝月次点検の目安。series↔原本の
  //     循環参照は本番の保存経路（src/server/inspections/build.ts）と同じく「ポインタ付きseriesを
  //     先にINSERTしてから原本」を1つのbatchで行う。D1はbatch内でFK遅延評価） ---
  const templateId = blockId("c", 1);
  const templateVersionId = blockId("c", 2);
  group([
    insert("inspection_templates", ["id", "unit_id", "name", "target_type", "status", "created_at", "updated_at", "created_by", "actor_kind"],
      [templateId, LOAD_UNIT_ID, "架空の施設点検台帳（seed）", "facility", "active", NOW, NOW, LOAD_ADMIN.userId, "human"]),
    insert("inspection_template_versions", ["id", "unit_id", "template_id", "revision_no", "item_schema", "status",
      "approved_by_member_id", "approved_at", "created_at", "updated_at", "created_by", "actor_kind"],
    [templateVersionId, LOAD_UNIT_ID, templateId, 1, "[]", "approved", LOAD_ADMIN.memberId, NOW, NOW, NOW, LOAD_ADMIN.userId, "human"]),
  ]);
  const inspectionsPerFacility = Math.max(1, Math.round(profile.inspectionsPerYear / profile.facilities));
  let inspectionNo = 0;
  for (let f = 0; f < facilityIds.length; f++) {
    const facilityId = facilityIds[f]!;
    const seriesId = blockId("b", f + 1);
    const stmts: SeedStatement[] = [];
    for (let k = 0; k < inspectionsPerFacility; k++) {
      inspectionNo++;
      const inspectionId = blockId("d", inspectionNo);
      const inspectedAt = `2026-${String((k % 12) + 1).padStart(2, "0")}-05T02:00:00.000Z`;
      if (k === 0) {
        stmts.push(insert("inspection_series",
          ["id", "unit_id", "facility_id", "current_facility_inspection_id", "created_at", "updated_at", "created_by", "actor_kind"],
          [seriesId, LOAD_UNIT_ID, facilityId, inspectionId, NOW, NOW, LOAD_ADMIN.userId, "human"]));
      }
      stmts.push(insert("facility_inspections",
        ["id", "unit_id", "series_id", "facility_id", "template_version_id", "inspector_member_id", "inspected_at",
          "result", "note", "location_version", "created_at", "updated_at", "created_by", "actor_kind"],
      [inspectionId, LOAD_UNIT_ID, seriesId, facilityId, templateVersionId, rosterIds[(f + k) % rosterIds.length]!,
        inspectedAt, inspectionNo % 9 === 0 ? "needs_review" : "ok",
        `点検を実施した（架空・${k + 1}回目）。問題${inspectionNo % 9 === 0 ? "があり要確認" : "はなかった"}。`,
        1, NOW, NOW, LOAD_ADMIN.userId, "human"]));
    }
    group(stmts);
  }
  stats.facility_inspections = inspectionNo;
  stats.inspection_series = facilityIds.length;

  // --- 活動100（出欠イベントの源。対象snapshot＝名簿33名、回答率70%。完了活動には実績と実参加も作る。
  //     これは集計API-52が「現有効実績のある活動」を数えるため＝0件の集計を実測と偽らないため） ---
  const attendanceIds: string[] = [];
  let resultNo = 0;
  for (let a = 1; a <= profile.activitiesPerYear; a++) {
    const operationId = blockId("e", a);
    const activityId = blockId("f0", a);
    const scheduled = a % 5 === 0; // 2割は今後の予定（dashboardの指標が0件でない状態を作る）
    const plannedStartsAt = scheduled
      ? `2026-12-${String((a % 28) + 1).padStart(2, "0")}T01:00:00.000Z`
      : `2026-${String((a % 9) + 1).padStart(2, "0")}-10T01:00:00.000Z`;
    const respondents: { memberId: string; response: "attending" | "absent" | "undecided" }[] = [];
    rosterIds.forEach((memberId, mi) => {
      if ((mi * 7 + a) % 10 >= profile.responseRate * 10) return; // 70%が回答
      respondents.push({ memberId, response: (["attending", "absent", "undecided"] as const)[(mi + a) % 3]! });
    });
    const stmts: SeedStatement[] = [
      insert("operations", ["id", "unit_id", "kind", "status", "countable", "created_at", "updated_at", "created_by", "actor_kind"],
        [operationId, LOAD_UNIT_ID, "activity", scheduled ? "scheduled" : "completed", 1, NOW, NOW, LOAD_ADMIN.userId, "human"]),
      insert("activities", ["id", "unit_id", "operation_id", "title", "kind", "planned_starts_at", "location_text",
        "owner_member_id", "status", "created_at", "updated_at", "created_by", "actor_kind"],
      [activityId, LOAD_UNIT_ID, operationId, `架空の${a % 2 === 0 ? "訓練" : "配備"}活動${a}`, "training",
        plannedStartsAt, "架空市庁舎駐車場", LOAD_OFFICER.memberId, scheduled ? "scheduled" : "completed",
        NOW, NOW, LOAD_ADMIN.userId, "human"]),
    ];
    for (const memberId of rosterIds) {
      stmts.push(insert("activity_audience", ["id", "unit_id", "activity_id", "member_id", "actor_user_id", "actor_kind", "created_at"],
        [crypto.randomUUID(), LOAD_UNIT_ID, activityId, memberId, LOAD_ADMIN.userId, "human", NOW]));
    }
    for (const r of respondents) {
      const attendanceId = crypto.randomUUID();
      attendanceIds.push(attendanceId);
      stmts.push(insert("activity_attendance",
        ["id", "unit_id", "activity_id", "member_id", "response", "responded_at", "created_at", "updated_at", "created_by", "actor_kind"],
        [attendanceId, LOAD_UNIT_ID, activityId, r.memberId, r.response, NOW, NOW, NOW, LOAD_ADMIN.userId, "human"]));
    }
    if (!scheduled) {
      // 実績（集計API-52の対象。活動の現行revision＋実参加＝回答「参加」の行）
      resultNo++;
      const resultId = blockId("f1", resultNo);
      const revisionId = blockId("f2", resultNo);
      const actualStartsAt = plannedStartsAt;
      const actualEndsAt = plannedStartsAt.replace("T01:00:00.000Z", "T03:00:00.000Z");
      stmts.push(insert("activity_results", ["id", "unit_id", "activity_id", "current_revision_id", "created_at", "updated_at", "created_by", "actor_kind"],
        [resultId, LOAD_UNIT_ID, activityId, revisionId, NOW, NOW, LOAD_ADMIN.userId, "human"]));
      stmts.push(insert("activity_result_revisions", ["id", "unit_id", "result_id", "revision_no", "actual_starts_at", "actual_ends_at",
        "content", "actor_user_id", "actor_kind", "created_at"],
      [revisionId, LOAD_UNIT_ID, resultId, 1, actualStartsAt, actualEndsAt,
        `架空の活動実績${a}。配備と点検を実施した。`, LOAD_ADMIN.userId, "human", NOW]));
      for (const r of respondents.filter((x) => x.response === "attending")) {
        stmts.push(insert("activity_actual_participants", ["id", "unit_id", "result_revision_id", "member_id", "actual_status", "created_at", "created_by", "actor_kind"],
          [crypto.randomUUID(), LOAD_UNIT_ID, revisionId, r.memberId, "participated", NOW, LOAD_ADMIN.userId, "human"]));
      }
    }
    group(stmts);
  }
  stats.activities = profile.activitiesPerYear;
  stats.activity_attendance = attendanceIds.length;
  stats.activity_results = resultNo;

  // --- 文書100×20頁（D18。承認済み版＋索引済みchunk＋FTS行。原本添付はreadyのattachment行） ---
  for (let d = 1; d <= profile.documents; d++) {
    const documentId = blockId("f3", d);
    const versionId = blockId("f4", d);
    const attachmentId = blockId("f5", d);
    const stmts: SeedStatement[] = [
      insert("attachments", ["id", "unit_id", "owner_user_id", "owner_member_id", "intent_target_type", "intent_target_id",
        "ready_key", "content_type", "byte_size", "sha256", "status", "expires_at", "classification",
        "upload_token_hash", "created_at", "updated_at", "created_by", "actor_kind"],
      [attachmentId, LOAD_UNIT_ID, LOAD_ADMIN.userId, LOAD_ADMIN.memberId, "document", documentId,
        `seed/document-${d}/original.pdf`, "application/pdf", 20 * 1024, "1".repeat(64), "ready",
        "2099-01-01T00:00:00.000Z", "basic", "0".repeat(64), NOW, NOW, LOAD_ADMIN.userId, "human"]),
      insert("documents", ["id", "unit_id", "title", "classification", "status", "created_at", "updated_at", "created_by", "actor_kind"],
        [documentId, LOAD_UNIT_ID, `架空の資機材取扱説明書${d}（負荷試験seed）`, "資機材", "approved", NOW, NOW, LOAD_ADMIN.userId, "human"]),
      insert("document_versions", ["id", "unit_id", "document_id", "revision_no", "attachment_id", "status",
        "approved_by", "approved_at", "license_ref", "content_hash", "created_at", "updated_at", "created_by", "actor_kind"],
      [versionId, LOAD_UNIT_ID, documentId, 1, attachmentId, "approved", LOAD_ADMIN.userId, NOW,
        "架空の許諾（seed）", "1".repeat(64), NOW, NOW, LOAD_ADMIN.userId, "human"]),
      // root→版の循環参照の解消（本番の作成経路と同じく同一batch。rootはNULLでINSERT→版→UPDATE）
      { sql: "UPDATE documents SET current_version_id = ?, current_draft_version_id = ? WHERE id = ? AND unit_id = ?",
        binds: [versionId, versionId, documentId, LOAD_UNIT_ID] },
    ];
    for (let page = 1; page <= profile.documentPages; page++) {
      const chunkNo = (d - 1) * profile.documentPages + page;
      const chunkId = blockId("f6", chunkNo);
      const text = `${FICTIONAL_TEXT}\n第${page}頁: 架空の点検手順と連絡先（文書${d}）。巡視の記録はこの業務で付け、異常は確認待ちへ回す。`;
      stmts.push(insert("document_chunks", ["id", "unit_id", "version_id", "chunk_no", "page_no", "text",
        "source_offsets", "index_status", "index_key", "created_at", "updated_at", "created_by", "actor_kind"],
      [chunkId, LOAD_UNIT_ID, versionId, page, page, text,
        JSON.stringify({ contentHash: "1".repeat(64), extractorVersion: "seed", pageNo: page, start: 0, end: text.length }),
        "indexed", `d1_fts:v1/${chunkId}`, NOW, NOW, LOAD_ADMIN.userId, "human"]));
      stmts.push({ sql: "INSERT INTO document_chunks_fts (chunk_id, unit_id, version_id, document_id, page_no, chunk_no, text) VALUES (?,?,?,?,?,?,?)",
        binds: [chunkId, LOAD_UNIT_ID, versionId, documentId, page, page, text] });
    }
    group(stmts);
  }
  stats.documents = profile.documents;
  stats.document_chunks = profile.documents * profile.documentPages;

  // --- 1年分のoutbox（domain_events。seedはmutation経路を通さないためここで作る。
  //     1 mutation 1 event・unit内で単調採番（drizzle/0001）。payloadは最小値で本文を持たない） ---
  let seq = 0;
  const event = (entityType: string, entityId: string, eventType: string, payload: Record<string, unknown>): SeedStatement =>
    insert("domain_events", ["id", "unit_id", "mutation_id", "entity_type", "entity_id", "entity_version", "event_type", "payload_minimal", "sequence", "created_at"],
      [crypto.randomUUID(), LOAD_UNIT_ID, crypto.randomUUID(), entityType, entityId, 1, eventType, JSON.stringify(payload), ++seq, NOW]);
  const eventGroup: SeedStatement[] = [];
  for (const facilityId of facilityIds) eventGroup.push(event("facility", facilityId, "facility.created", { type: "facility" }));
  for (let n = 1; n <= inspectionNo; n++) {
    eventGroup.push(event("facility_inspection", blockId("d", n), "facility_inspection.created",
      { result: n % 9 === 0 ? "needs_review" : "ok" }));
  }
  for (let a = 1; a <= profile.activitiesPerYear; a++) {
    eventGroup.push(event("activity", blockId("f0", a), "activity.created", {}));
  }
  const attendanceMin = seq + 1;
  for (const attendanceId of attendanceIds) {
    eventGroup.push(event("activity_attendance", attendanceId, "activity_attendance.answered", { response: "answered" }));
  }
  const attendanceMax = seq;
  group(eventGroup);
  stats.outbox_events = seq;
  group([{ sql: "UPDATE units SET event_sequence = ? WHERE id = ?", binds: [seq, LOAD_UNIT_ID] }]);

  return {
    groups,
    eventSequence: seq,
    attendanceRange: { min: attendanceMin, max: attendanceMax },
    stats,
  };
}

/**
 * 代表件数のseed（ブリーフのInterface）。既に同じunitが在るときは何もしない（冪等。
 * 試験ファイルごとに隔離storageなので通常は空DBから1回）。
 * 試験はこの後 x-test-identity で LOAD_ADMIN/LOAD_OFFICER/LOAD_MEMBER として要求する。
 */
export async function seedLoad(env: AppEnv, profile: LoadProfile): Promise<void> {
  const existing = await env.DB.prepare("SELECT id FROM units WHERE id = ?").bind(LOAD_UNIT_ID).first();
  if (existing) return;
  const plan = buildSeedPlan(profile);
  // groups（循環参照のある親子）は1つのbatchにまとめる。groupを跨いでbatchを作る
  const BATCH_STATEMENTS = 400;
  let batch: D1PreparedStatement[] = [];
  let batchIndex = 0;
  let batchStatements = 0;
  const flush = async () => {
    if (batch.length > 0) {
      try {
        await env.DB.batch(batch);
      } catch (err) {
        // どのグループで失敗したかを特定できるようにする（seedの保守用。通常の失敗でも出る）
        console.error(`[seed-load] batch #${batchIndex}（statements=${batch.length}）で失敗: ${String(err)}`);
        throw err;
      }
    }
    batch = [];
    batchStatements = 0;
    batchIndex++;
  };
  for (const g of plan.groups) {
    if (batchStatements > 0 && batchStatements + g.length > BATCH_STATEMENTS) await flush();
    for (const s of g) batch.push(env.DB.prepare(s.sql).bind(...s.binds));
    batchStatements += g.length;
  }
  await flush();
}

/** 最近点順位法の百分位（V06と同じ。平均だけでなく分布で判定する＝docs/08 CT-14） */
const percentileNearestRank = (values: number[], p: number): number => {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.ceil(p * sorted.length) - 1]!;
};

/** 測定sampleの集計（ブリーフのInterface）。失敗を外さず、平均でなくp50/p95/maxで返す */
export function summarizeLoad(samples: RequestSample[]): LoadMetrics {
  const empty = (): BucketMetrics => ({ count: 0, failedCount: 0, p50Ms: 0, p95Ms: 0, maxMs: 0 });
  const buckets: Record<LoadBucket, BucketMetrics> = { ordinary: empty(), map: empty(), ai: empty(), poll: empty() };
  const durations: Record<LoadBucket, number[]> = { ordinary: [], map: [], ai: [], poll: [] };
  for (const s of samples) {
    const b = buckets[s.bucket];
    if (!b) continue; // 未知のbucketは集計しない（omittedFailedRequestsが0にならず検出される）
    b.count++;
    if (!s.ok) b.failedCount++;
    durations[s.bucket]!.push(s.durationMs);
  }
  for (const key of Object.keys(buckets) as LoadBucket[]) {
    const ds = durations[key]!;
    buckets[key] = {
      count: buckets[key]!.count,
      failedCount: buckets[key]!.failedCount,
      p50Ms: percentileNearestRank(ds, 0.5),
      p95Ms: percentileNearestRank(ds, 0.95),
      maxMs: ds.length > 0 ? Math.max(...ds) : 0,
    };
  }
  const failedCount = samples.filter((s) => !s.ok).length;
  const counted = (Object.values(buckets) as BucketMetrics[]).reduce((sum, b) => sum + b.count, 0);
  // 全sampleがちょうど1つのbucketに数えられていること（=失敗も含めて1つも外していない）の検査点
  const omittedFailedRequests = samples.length - counted;
  const ordinarySamples = samples.filter((s) => s.bucket === "ordinary");
  return {
    total: samples.length,
    failedCount,
    omittedFailedRequests,
    ordinaryApiP95Ms: percentileNearestRank(ordinarySamples.map((s) => s.durationMs), 0.95),
    buckets,
    // AI系列が別bucketで測られ、ordinaryにAI系列が1件も混ざっていないことの両方を見る
    aiMeasuredSeparately: buckets.ai.count > 0 && !ordinarySamples.some((s) => AI_LABELS.has(s.api)),
    unboundedQueryCount: samples.reduce((sum, s) => sum + (s.unboundedQueries ?? 0), 0),
  };
}

// ============================================================================
// CLI（`npx tsx scripts/seed-load.ts --out /tmp/seed-load.sql`）。workerd外ではenvが無いため
// SQLの生成までを行い、適用は wrangler d1 execute DB --local --file で行う。
// ============================================================================

const sqlLiteral = (v: unknown): string => {
  if (v === null || v === undefined) return "NULL";
  if (typeof v === "number") return String(v);
  return `'${String(v).replaceAll("'", "''")}'`;
};

const inlineBinds = (sql: string, binds: unknown[]): string => {
  let out = "";
  let rest = sql;
  let i = 0;
  for (; i < binds.length; i++) {
    const marker = rest.indexOf("?");
    if (marker < 0) throw new Error("seed-load: placeholderの数とbindsの数が一致しません");
    out += rest.slice(0, marker) + sqlLiteral(binds[i]);
    rest = rest.slice(marker + 1);
  }
  if (rest.includes("?")) throw new Error("seed-load: placeholderの数とbindsの数が一致しません");
  return out + rest;
};

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const outIndex = argv.indexOf("--out");
  const out = outIndex >= 0 ? argv[outIndex + 1] : undefined;
  if (!out) {
    console.error("使い方: npx tsx scripts/seed-load.ts --out /tmp/seed-load.sql");
    console.error("生成したSQLは wrangler d1 execute DB --local --file <ファイル> で適用する（架空データのみ）");
    process.exitCode = 2;
    return;
  }
  const { writeFileSync } = await import("node:fs");
  const plan = buildSeedPlan(REPRESENTATIVE_PROFILE);
  const lines: string[] = [
    "-- T082 代表件数seed（D18。架空データのみ。scripts/seed-load.ts が生成した）",
    `-- 適用: wrangler d1 execute DB --local --file ${out}`,
    "BEGIN TRANSACTION;",
  ];
  for (const s of plan.groups.flat()) {
    lines.push(inlineBinds(s.sql, s.binds) + ";");
  }
  lines.push("COMMIT;");
  writeFileSync(out, lines.join("\n") + "\n");
  console.log(`seed SQLを ${out} へ生成しました（statements=${plan.groups.flat().length} event_sequence=${plan.eventSequence}）`);
  console.log(JSON.stringify(plan.stats, null, 2));
}

// CLIとして直接実行されたときだけ動く（試験はこのモジュールをimportするため走らない）
if (typeof process !== "undefined" && Array.isArray(process.argv) && process.argv[1]?.includes("seed-load")) {
  await main();
}
