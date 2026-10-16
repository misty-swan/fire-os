import { LIMITS } from "../../shared/contracts/common";
import type { EventPageDto, SyncEventDto } from "../../shared/contracts/sync";
import type { AuthzPrincipal } from "../auth/principal";
import { resolvePrincipal } from "../auth/principal";
import { isDocumentVisible } from "../documents/authorized";
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
 */
const UNIT_WIDE_VISIBLE = new Set([
  "incident", "activity", "operation", "facility", "vehicle", "equipment", "issue", "task",
  "facility_inspection", "asset_inspection", "inspection_schedule", "activity_result",
  "activity_attendance", "incident_participant", "member",
]);

/** 1行のイベントが今のACLで見えるか。管理系・宛先付きの種別は行ごとに判定する（docs/05 §8「現在のACLでfilter」） */
async function eventVisible(env: Pick<ApiContext["env"], "DB">, p: AuthzPrincipal, row: EventRow): Promise<boolean> {
  if (row.unit_id !== p.unitId) return false;
  if (UNIT_WIDE_VISIBLE.has(row.entity_type)) return true;
  // 通知（API-65「PER-12/対象者」）: 宛先本人、または管理権限（幹部・管理者）/明示scopeの保持者
  if (row.entity_type === "notification") {
    const managed = p.roles.includes("officer") || p.roles.includes("admin") ||
      p.scopes.some((s) => s.entityType === "notification" && s.permissions.includes("PER-12") && s.entityId === row.entity_id);
    if (managed) return true;
    return await env.DB.prepare(
      "SELECT 1 FROM notification_recipients WHERE notification_id = ? AND unit_id = ? AND member_id = ?",
    ).bind(row.entity_id, p.unitId, p.memberId).first() !== null;
  }
  // お知らせ（API-24「可視公開対象のみ」）: 対象者、または管理権限（announcements.tsのmanageVisibilityと同じ判定）
  if (row.entity_type === "announcement") {
    const manage = manageVisibility(p);
    const managed = manage.all || manage.scopedIds.includes(row.entity_id);
    if (managed) return true;
    return await env.DB.prepare(
      "SELECT 1 FROM announcement_audience WHERE announcement_id = ? AND unit_id = ? AND member_id = ?",
    ).bind(row.entity_id, p.unitId, p.memberId).first() !== null;
  }
  // 文書（API-90/91）: deny優先の文書ACLと撤回（authorized.tsの単一の正本）
  if (row.entity_type === "document") return isDocumentVisible(env, p, row.entity_id);
  return false; // 未収録の種別（報告書・招待・添付・AI等）は非可視。配信する場合は収録と権限確認をセットで
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
    for (const row of rows) {
      last = row.sequence;
      scanned++;
      // 不可視イベントも走査位置は進める（docs/05 §8「非可視イベントは走査位置だけ進め」）
      if (await eventVisible(ctx.env, p, row)) events.push(toSyncEvent(row));
      if (events.length >= PAGE_LIMIT) break;
    }
    // ページが満ちるか、走査上限・末尾に達したら返す（未走査の残りはresumeCursorの位置から再開）
    if (events.length >= PAGE_LIMIT || rows.length < SCAN_BATCH || scanned >= SCAN_MAX_ROWS) break;
    rows = ((await scan(last).all()).results ?? []) as unknown as EventRow[];
  }

  const resumeCursor = await encodeSyncCursor(
    await cursorKey(ctx.env.BETTER_AUTH_SECRET),
    newSyncCursor(p, { ...filter, lastSequence: last }, nowIso),
  );
  return { events, resumeCursor, resyncRequired: false };
}
