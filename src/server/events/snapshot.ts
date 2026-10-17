import { LIMITS } from "../../shared/contracts/common";
import type { EventPageDto, SyncEventDto } from "../../shared/contracts/sync";
import { authorize } from "../auth/authorize";
import type { AuthzPrincipal } from "../auth/principal";
import { resolvePrincipal } from "../auth/principal";
import { documentVisibilitySql } from "../documents/authorized";
import { systemClock } from "../clock";
import { HttpError, type ApiContext } from "../http";
import { requirePermission } from "../routes/invitations";
import { manageVisibility } from "../routes/announcements";
import { cursorKey, decodeSyncCursor, encodeSyncCursor, newSyncCursor } from "./cursor";

/**
 * 認可済snapshotと差分取得（T072、docs/05 §8）。
 *
 * - readSnapshot: 同期対象のsnapshot（親/子データ）とunits.event_sequenceを**同一のD1 read batch**で読み、
 *   その瞬間の位置を表すsnapshotCursorを返す。snapshotの親子と連番が食い違う瞬間を作らない。
 * - readEvents: cursorの位置以後のoutbox（domain_events）を走査し、**現在のACL**でfilterして返す。
 *   snapshotと接続の間にcommitされた変更もこの走査で回収する（outboxの再読が正本。docs/05 §8
 *   「更新後はdomain_eventを失ってもD1 outbox再読で回収できる」）。
 *   不可視イベント（他unit・権限が無い対象）は応答に現さず、走査位置だけを進める。番号が飛んでも
 *   resumeCursorが読み位置を伝えるため、クライアントは飛びを通信欠落と誤認しない。
 *
 * カーソルはdocs/05 §8どおりunit/認可版/対象filter/走査済sequence/期限を暗号化・認証したopaque値
 * （src/server/events/cursor.ts）。認可版不一致・期限切れ・改変・別unitは409 RESYNC_REQUIRED。
 */

/** 1応答に載せるイベント数（一般一覧と同じ既定。docs/05 §1） */
const PAGE_LIMIT = LIMITS.listLimitDefault;
/** 1リクエストで走査するoutbox行の上限。不可視行が集中しても応答を有限にする（続きはresumeCursorから） */
const SCAN_MAX_ROWS = 1000;
/** 走査1回の読み取り行数 */
const SCAN_BATCH = 200;

/**
 * snapshot読み取りの指定。statementsのSQLはunit条件を必ず含めること（他unitの行を親子に混ぜない）。
 * assembleはbatchの全結果（unit連番の読み取りを除く）と、その瞬間の連番・発行済cursorを受け取りDTOを組み立てる。
 */
export interface SnapshotQueries<T> {
  /** 呼び出し主体（routeがresolvePrincipalで引いた最新の状態） */
  principal: AuthzPrincipal;
  /** cursorに結合する対象filter。省略はfilter無し（unit全体のstream。docs/05 §8どおりACLだけがfilter） */
  filter?: { entityType: string; entityId: string | null };
  /** 親子の読み取り。units.event_sequenceの読み取りはreadSnapshotが同じbatchに追加する */
  statements: (db: D1Database) => D1PreparedStatement[];
  assemble: (rows: D1Result[], eventSequence: number, snapshotCursor: string) => T;
}

/**
 * snapshot＋unit連番の同一batch読み取りとsnapshotCursorの発行。
 * 失敗するとbatch全体が取り消されるため、戻ったdataとcursorは必ず同じ瞬間の状態を指す。
 */
export async function readSnapshot<T>(ctx: ApiContext, queries: SnapshotQueries<T>): Promise<{ data: T; snapshotCursor: string }> {
  const p = queries.principal;
  const filter = queries.filter ?? { entityType: null, entityId: null };
  const stmts = queries.statements(ctx.env.DB);
  const results = await ctx.env.DB.batch([
    ...stmts,
    // 連番は親子と同じbatchで読む（docs/05 §8「親/子データとunits.event_sequenceを同一D1 read batch」）
    ctx.env.DB.prepare("SELECT event_sequence FROM units WHERE id = ?").bind(p.unitId),
  ]);
  const seqRow = results[results.length - 1]?.results[0] as { event_sequence: number } | undefined;
  if (!seqRow) throw new HttpError("INTERNAL_ERROR");
  const nowIso = systemClock.now().toISOString();
  const snapshotCursor = await encodeSyncCursor(
    await cursorKey(ctx.env.BETTER_AUTH_SECRET),
    newSyncCursor(p, { ...filter, lastSequence: seqRow.event_sequence }, nowIso),
  );
  return { data: queries.assemble(results.slice(0, -1), seqRow.event_sequence, snapshotCursor), snapshotCursor };
}

interface EventRow {
  id: string; unit_id: string; entity_type: string; entity_id: string; entity_version: number;
  event_type: string; payload_minimal: string; sequence: number; created_at: string;
}

/**
 * 同期で常に見える対象種別。読み取りAPIがPER-01（unit内の全役割）で開いている種別だけを収録する
 * （docs/05: 出動API-70・活動API-17・施設API-11/12・資産API-51・異常API-15・タスクAPI-87・
 * 点検/使用履歴/参集/結果など対象の見える子。団員の基本項目は全役割が読める。docs/10 §1。
 * イベントのpayloadは最小値で本文を持たないため、これらの変更通知は種別の読み取り可視と同じ範囲）。
 * ここに無い種別は**非可視（既定拒否）**。新種別を配信するときは読み取りAPIの権限を確認してから収録する。
 * 出欠（activity_attendance）は読み取りAPI-07/08が「PER-03の管理権なら全行、なければ自分の行だけ」を
 * 開けるため収録しない（全役割に開くと読み取りAPIより広く他人の回答が配信される。行判定は下のeventVisible）。
 */
const UNIT_WIDE_VISIBLE = new Set([
  "incident", "activity", "operation", "facility", "vehicle", "equipment", "issue", "task",
  "facility_inspection", "asset_inspection", "inspection_schedule", "activity_result",
  "incident_participant", "member",
]);

/**
 * 走査1バッチ（≤SCAN_BATCH行）の可視性をまとめて判定する（T082。旧eventVisible〔1行ずつのSQL〕の
 * バッチ化。判定の語彙と結果は同一＝fail-closed・非可視は走査位置だけ進める）。
 * 根拠: 代表件数（出欠イベント約2,300件のunitを30端末がpoll）の実測で、1行ずつの点ルックアップは
 * 1要求あたり最大SCAN_MAX_ROWS回のSQLになりp95≈8.9秒だった（docs/evidence/V07-performance.md）。
 * バッチ化で1走査バッチにつき種別ごと最大1回のSQL（IN句はD1のbind上限内に分割＝出欠・通知・
 * お知らせは90件ずつ、visibility SQLのbindを伴う文書は80件ずつ。analytics/query.tsと同じ注意）。
 * 判定規則は旧1行版と同じ（docs/05 §8・各読み取りAPIの可視規則）:
 *  - 他unit → 非可視。UNIT_WIDE_VISIBLE → 可視。未収録種別 → 非可視（既定拒否）
 *  - 通知（API-65「PER-12/対象者」）: 宛先本人、または管理権限（幹部・管理者）/明示scopeの保持者
 *  - お知らせ（API-24「可視公開対象のみ」）: 対象者、または管理権限（manageVisibilityと同じ判定）
 *  - 文書（API-90/91）: deny優先の文書ACLと撤回（authorized.tsと同じWHERE片）
 *  - 出欠（API-07と同じ読み取り規則）: 行の本人、または親活動の管理権（PER-03）
 */
async function visibleFlagsOfBatch(env: Pick<ApiContext["env"], "DB">, p: AuthzPrincipal, rows: EventRow[]): Promise<boolean[]> {
  const flags = new Array<boolean>(rows.length).fill(false);
  const pending: Record<"notification" | "announcement" | "document" | "activity_attendance", number[]> = {
    notification: [], announcement: [], document: [], activity_attendance: [],
  };
  rows.forEach((row, i) => {
    if (row.unit_id !== p.unitId) return; // 他unitは非可視
    if (UNIT_WIDE_VISIBLE.has(row.entity_type)) { flags[i] = true; return; }
    if (row.entity_type === "notification") {
      const managed = p.roles.includes("officer") || p.roles.includes("admin") ||
        p.scopes.some((s) => s.entityType === "notification" && s.permissions.includes("PER-12") && s.entityId === row.entity_id);
      if (managed) flags[i] = true;
      else pending.notification.push(i);
      return;
    }
    if (row.entity_type === "announcement") {
      const manage = manageVisibility(p);
      if (manage.all || manage.scopedIds.includes(row.entity_id)) flags[i] = true;
      else pending.announcement.push(i);
      return;
    }
    if (row.entity_type === "document") { pending.document.push(i); return; }
    if (row.entity_type === "activity_attendance") { pending.activity_attendance.push(i); return; }
    // 未収録の種別（報告書・招待・添付・AI等）は非可視。配信する場合は収録と権限確認をセットで
  });

  // IN句はD1のbind上限（100）を超えないよう分割する（src/server/analytics/query.tsと同じ注意）。
  // 文書branchはvisibility SQLのbind（本人+役割の2組=最大10）を伴うため80件にする
  const chunksOf = <T>(values: T[], size = 90): T[][] => {
    const chunks: T[][] = [];
    for (let i = 0; i < values.length; i += size) chunks.push(values.slice(i, i + size));
    return chunks;
  };

  // 通知: 宛先本人の行だけ見える（API-65。旧1行版と同じ条件のIN版）
  for (const chunk of chunksOf(pending.notification)) {
    const ids = chunk.map((i) => rows[i]!.entity_id);
    const found = new Set(
      (await env.DB.prepare(
        `SELECT notification_id FROM notification_recipients WHERE unit_id = ? AND member_id = ? AND notification_id IN (${ids.map(() => "?").join(",")})`,
      ).bind(p.unitId, p.memberId, ...ids).all<{ notification_id: string }>()).results.map((r) => r.notification_id),
    );
    for (const i of chunk) if (found.has(rows[i]!.entity_id)) flags[i] = true;
  }

  // お知らせ: 対象者の行だけ見える（API-24。旧1行版と同じ条件のIN版）
  for (const chunk of chunksOf(pending.announcement)) {
    const ids = chunk.map((i) => rows[i]!.entity_id);
    const found = new Set(
      (await env.DB.prepare(
        `SELECT announcement_id FROM announcement_audience WHERE unit_id = ? AND member_id = ? AND announcement_id IN (${ids.map(() => "?").join(",")})`,
      ).bind(p.unitId, p.memberId, ...ids).all<{ announcement_id: string }>()).results.map((r) => r.announcement_id),
    );
    for (const i of chunk) if (found.has(rows[i]!.entity_id)) flags[i] = true;
  }

  // 文書: deny優先ACL＋撤回除外の可視集合（authorized.tsの単一の正本と同じWHERE片。1行版と同じ行集合）
  const visibility = documentVisibilitySql(p);
  for (const chunk of chunksOf(pending.document, 80)) {
    const ids = chunk.map((i) => rows[i]!.entity_id);
    const found = new Set(
      (await env.DB.prepare(
        `SELECT d.id FROM documents d WHERE d.unit_id = ? AND d.id IN (${ids.map(() => "?").join(",")}) AND d.status <> 'withdrawn' AND ${visibility.sql}`,
      ).bind(p.unitId, ...ids, ...visibility.binds).all<{ id: string }>()).results.map((r) => r.id),
    );
    for (const i of chunk) if (found.has(rows[i]!.entity_id)) flags[i] = true;
  }

  // 出欠: 行の本人、または親活動の管理権（PER-03。API-07と同じ読み取り規則。行が無い/別unitは非可視）
  for (const chunk of chunksOf(pending.activity_attendance)) {
    const ids = chunk.map((i) => rows[i]!.entity_id);
    const attendanceRows = (await env.DB.prepare(
      "SELECT a.id, a.member_id, a.activity_id, act.owner_member_id FROM activity_attendance a " +
        "JOIN activities act ON act.id = a.activity_id AND act.unit_id = a.unit_id " +
        `WHERE a.unit_id = ? AND a.id IN (${ids.map(() => "?").join(",")})`,
    ).bind(p.unitId, ...ids).all<{ id: string; member_id: string; activity_id: string; owner_member_id: string }>()).results;
    const byId = new Map(attendanceRows.map((r) => [r.id, r]));
    for (const i of chunk) {
      const attendance = byId.get(rows[i]!.entity_id);
      if (!attendance) continue; // 行が無い/別unitなら非可視（走査位置だけ進める）
      if (attendance.member_id === p.memberId) { flags[i] = true; continue; }
      if (authorize(p, "PER-03", { unitId: p.unitId, type: "activity", id: attendance.activity_id, ownerMemberId: attendance.owner_member_id }).allowed) {
        flags[i] = true;
      }
    }
  }
  return flags;
}

const toSyncEvent = (row: EventRow): SyncEventDto => ({
  id: row.id,
  entityType: row.entity_type,
  entityId: row.entity_id,
  entityVersion: row.entity_version,
  eventType: row.event_type,
  payload: JSON.parse(row.payload_minimal) as Record<string, unknown>,
  sequence: row.sequence,
  createdAt: row.created_at,
});

const resync = (reason: string) => new HttpError("RESYNC_REQUIRED", undefined, [{ field: "cursor", reason }]);

interface StreamFilter { entityType: string | null; entityId: string | null }

/** queryのentityType/entityIdを検査してfilterへ（契約検証を通らない直接呼出し（T073のtransport）の防御） */
function filterOf(q: Record<string, string>): StreamFilter | null {
  const entityType = q.entityType;
  const entityId = q.entityId;
  if (entityType === undefined && entityId === undefined) return null;
  if (entityType !== undefined && (entityType.length < 1 || entityType.length > 100)) throw tooLargeField("entityType");
  if (entityId !== undefined && (entityId.length < 1 || entityId.length > 64)) throw tooLargeField("entityId");
  if (entityType === undefined || entityId === undefined) return { entityType: entityType ?? null, entityId: entityId ?? null };
  return { entityType, entityId };
}
const tooLargeField = (field: string) => new HttpError("VALIDATION_ERROR", undefined, [{ field, reason: "invalid_value" }]);

/**
 * 差分取得（API-80）。cursorは空文字で初回（queryのafterSequence/filterで開く）。
 * cursorがあるときは位置もfilterもcursorが正（queryのafterSequenceは無視。filterはcursorに矛盾しないときだけ採用）。
 * explicitを渡すとqueryの絞りの代わりにそれを使う（T073のtransport。{null,null}は絞り無しの指定に正規化する。
 * 挙動と検査順はqueryの絞りと同じ）。応答のevents/resumeCursor/resyncRequiredの意味はdocs/05 §8と
 * src/shared/contracts/sync.tsの注記。
 */
export async function readEvents(ctx: ApiContext, cursor: string, explicit?: StreamFilter): Promise<EventPageDto> {
  const p = await resolvePrincipal(ctx);
  requirePermission(p, "PER-13", { unitId: p.unitId, type: "sync" });
  const q = ctx.req.query();
  const queryFilter =
    explicit === undefined ? filterOf(q)
      : explicit.entityType === null && explicit.entityId === null ? null : explicit;
  const nowIso = systemClock.now().toISOString();

  let position: number;
  let filter: StreamFilter;
  if (cursor !== "") {
    const cur = await decodeSyncCursor(await cursorKey(ctx.env.BETTER_AUTH_SECRET), cursor);
    // 改変・鍵違い・別unitのcursorは全て同じ409（存在や中身を明かさない。docs/05 §8）
    if (!cur || cur.unitId !== p.unitId) throw resync("cursor_invalid");
    if (cur.expiresAt <= nowIso) throw resync("cursor_expired");
    if (cur.authzVersion !== p.authzVersion) throw resync("authz_changed");
    // 位置は常にcursorが正。filterは未結合（null）のcursorにqueryで付けられる絞りを採用して結合し、
    // 結合済みのcursorと矛盾する絞りは409（別のstream。snapshotから取り直す。docs/05 API-80行）
    if (queryFilter !== null && cur.entityType !== null &&
        (queryFilter.entityType !== cur.entityType || queryFilter.entityId !== cur.entityId)) {
      throw resync("filter_changed");
    }
    position = cur.lastSequence;
    filter = queryFilter ?? { entityType: cur.entityType, entityId: cur.entityId };
  } else {
    const raw = q.afterSequence;
    position = raw === undefined ? 0 : Number(raw);
    if (!Number.isInteger(position) || position < 0) throw tooLargeField("afterSequence");
    filter = queryFilter ?? { entityType: null, entityId: null };
  }

  const scan = (after: number) => {
    const where = ["unit_id = ?", "sequence > ?"];
    const binds: unknown[] = [p.unitId, after];
    if (filter.entityType !== null) { where.push("entity_type = ?"); binds.push(filter.entityType); }
    if (filter.entityId !== null) { where.push("entity_id = ?"); binds.push(filter.entityId); }
    return ctx.env.DB.prepare(
      `SELECT id, unit_id, entity_type, entity_id, entity_version, event_type, payload_minimal, sequence, created_at ` +
        `FROM domain_events WHERE ${where.join(" AND ")} ORDER BY sequence LIMIT ${SCAN_BATCH}`,
    ).bind(...binds);
  };

  // 最初の走査とunit連番の読み取りを同じbatchに（位置が連番より先の判定を同時点で行う）
  const [firstScan, unitRow] = await ctx.env.DB.batch([
    scan(position),
    ctx.env.DB.prepare("SELECT event_sequence FROM units WHERE id = ?").bind(p.unitId),
  ]);
  const currentSeq = (unitRow!.results[0] as { event_sequence: number }).event_sequence;
  if (position > currentSeq) {
    // 位置が先すぎる（DB復元・連番の巻き戻し）。このままでは取りこぼしを検知できないため再取得へ
    const resume = await encodeSyncCursor(await cursorKey(ctx.env.BETTER_AUTH_SECRET), newSyncCursor(p, { ...filter, lastSequence: position }, nowIso));
    return { events: [], resumeCursor: resume, resyncRequired: true };
  }

  const events: SyncEventDto[] = [];
  let last = position;
  let scanned = 0;
  let rows = (firstScan!.results as unknown as EventRow[]).slice();
  for (;;) {
    // 1走査バッチ（≤SCAN_BATCH行）の可視性をまとめて判定する（T082。1行ずつのSQL→バッチ1SQL。
    // 判定結果は旧1行版eventVisibleと同一。不可視イベントも走査位置は進める＝docs/05 §8）
    const flags = await visibleFlagsOfBatch(ctx.env, p, rows);
    for (let i = 0; i < rows.length; i++) {
      last = rows[i]!.sequence;
      scanned++;
      if (flags[i]) events.push(toSyncEvent(rows[i]!));
      if (events.length >= PAGE_LIMIT) break; // ページ満杯。未走査の残りはresumeCursorの位置から再開
    }
    // ページが満ちるか、走査上限・末尾に達したら返す
    if (events.length >= PAGE_LIMIT || rows.length < SCAN_BATCH || scanned >= SCAN_MAX_ROWS) break;
    rows = ((await scan(last).all()).results ?? []) as unknown as EventRow[];
  }

  const resumeCursor = await encodeSyncCursor(
    await cursorKey(ctx.env.BETTER_AUTH_SECRET),
    newSyncCursor(p, { ...filter, lastSequence: last }, nowIso),
  );
  return { events, resumeCursor, resyncRequired: false };
}
