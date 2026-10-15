import { Activity } from "../../shared/contracts/operations";
import type { ApiRequest, ApiResponse } from "../../shared/contracts/registry";
import { parseRequest } from "../../shared/contracts/registry";
import { resolvePrincipal } from "../auth/principal";
import { HttpError, type ApiContext } from "../http";
import { sha256Hex } from "../mutations/hash";
import { requirePermission } from "../routes/invitations";

/**
 * 活動履歴の検索（T038、docs/05 API-05、docs/04 §3.2/§4:174、docs/10 PER-01、docs/11 開催・実参加）。
 * 認可前置（PER-01＝自unitのみ。unit外は絶対に返さない）のうえ、検索条件ごとに分離したWHEREを組み立てる。
 * - 期間は半開区間。fromは包含、toは排他（planned_starts_atで判定。AT-ACT-04）
 * - actual=trueは「現有効実績」検索。operations.countable=1の活動に紐づく現行revision
 *   （activity_results.current_revision_id → activity_result_revisions → activity_actual_participants）の
 *   participated行を見る。取消(countable=0)の実績は出さず、旧revisionも見ない（docs/11 §3、T035/T037）。
 *   memberIdとの組合せで「その団員が実参加した活動」に絞る。
 * - actual無しのmemberIdは予定（対象snapshot＝activity_audience）基準。出欠の回答は検索に出さない
 *   （回答を実参加へコピーしないのと同じく、実参加を予定出欠から求めない。docs/11 実参加行）
 * - kind/status（activityStates列挙。cancelledも検索可能）はactivitiesの列をそのまま絞る
 * - keysetは安定順（planned_starts_at, id）。cursorはfilterHashごと署名付きのopaque値で
 *   （gis/cursor.tsと同じ流儀）、条件を変えた続き取得・改変cursorは409 SNAPSHOT_CHANGED。
 *   metaのnextCursorが「続きがあるか」の件数根拠（limit+1で取得し、切り捨てない）になる
 */

/** API-05の1ページ。itemsは応答data（ApiResponse<"API-05">）、nextCursorはmetaに載せる続き取得キー */
export interface ActivityListPage {
  items: ApiResponse<"API-05">;
  nextCursor?: string;
}

/** cursorの素。filterHash（検索条件の指紋）とソートキー（planned_starts_at,id）をサーバー署名付きで持つ */
interface ActivityCursor {
  filterHash: string;
  startsAt: string;
  id: string;
}

const signingKey = (secret: string): Promise<CryptoKey> =>
  crypto.subtle.importKey("raw", new TextEncoder().encode(`activity-cursor:${secret}`), { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);

const b64url = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes)).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
const unb64url = (s: string) => Uint8Array.from(atob(s.replaceAll("-", "+").replaceAll("_", "/")), (c) => c.charCodeAt(0));

async function encodeCursor(key: CryptoKey, cursor: ActivityCursor): Promise<string> {
  const payload = b64url(new TextEncoder().encode(JSON.stringify(cursor)));
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(payload));
  return `${payload}.${b64url(new Uint8Array(sig))}`;
}

/** 改変・署名不一致・型の不整合は全てnull（呼び出し側は条件変更と同じ409にする。gis/cursor.tsと同じ扱い） */
async function decodeCursor(key: CryptoKey, value: string): Promise<ActivityCursor | null> {
  const [payload, sig] = value.split(".");
  if (!payload || !sig) return null;
  try {
    const valid = await crypto.subtle.verify("HMAC", key, unb64url(sig) as BufferSource, new TextEncoder().encode(payload));
    if (!valid) return null;
    const parsed = JSON.parse(new TextDecoder().decode(unb64url(payload))) as ActivityCursor;
    if (typeof parsed.filterHash !== "string" || typeof parsed.startsAt !== "string" || typeof parsed.id !== "string") return null;
    return parsed;
  } catch {
    return null;
  }
}

interface ActivityRow {
  id: string; version: number; operation_id: string; title: string; kind: string;
  planned_starts_at: string; planned_ends_at: string | null;
  location_text: string; owner_member_id: string; status: string; response_due_at: string | null;
  created_at: string; updated_at: string;
}

/**
 * 活動履歴の1ページ（docs/05 API-05）。入力は検証前の契約形（ApiRequest）で受け、
 * ここで契約検証（未知のquery・範囲外limitは400）と認可前置（PER-01）を行う。
 * 画面（T039）やホームのドリルダウン（T047）からも同じ関数で検索できるよう、route非依存の単位に分離している。
 */
export async function queryActivities(ctx: ApiContext, input: ApiRequest<"API-05">): Promise<ActivityListPage> {
  // 認可前置（docs/10 PER-01「業務閲覧/検索/集計」＝所属内）。listはunit全体の検索なので対象は自unitのみ
  const p = await resolvePrincipal(ctx);
  requirePermission(p, "PER-01", { unitId: p.unitId, type: "activity" });
  const { query } = parseRequest("API-05", input);

  const key = await signingKey(ctx.env.BETTER_AUTH_SECRET);
  // 条件の指紋はcursor自体を除いて計算する（cursorが変わっても検索条件は変わっていない。gis/query.tsと同じ）
  const { cursor: cursorValue, ...filterOnly } = query;
  const filterHash = await sha256Hex(JSON.stringify(filterOnly));

  if (cursorValue) {
    const cursor = await decodeCursor(key, cursorValue);
    // 署名が一致しないcursor・条件が変わったcursorは、続きとして成立しない（409 SNAPSHOT_CHANGED）
    if (!cursor || cursor.filterHash !== filterHash) {
      throw new HttpError("SNAPSHOT_CHANGED");
    }
  }

  const where = ["a.unit_id = ?"];
  const binds: unknown[] = [p.unitId];
  // from包含／to排他（半開区間）。時刻はInstantで正規化済みのため文字列比較でよい（docs/05 §1）
  if (query.from) { where.push("a.planned_starts_at >= ?"); binds.push(query.from); }
  if (query.to) { where.push("a.planned_starts_at < ?"); binds.push(query.to); }
  if (query.kind) { where.push("a.kind = ?"); binds.push(query.kind); }
  if (query.status) { where.push("a.status = ?"); binds.push(query.status); }
  if (query.memberId && !query.actual) {
    // 予定基準の参加者検索は対象snapshot（activity_audience）で判定する（未回答母数と同じ単位。docs/04）
    where.push("EXISTS (SELECT 1 FROM activity_audience au WHERE au.activity_id = a.id AND au.member_id = ?)");
    binds.push(query.memberId);
  }
  if (query.actual) {
    // 現有効実績（docs/16 T035状態欄）: 取消でcountable=0のoperationは除外し、
    // 現行revision（current_revision_id）のparticipated行だけを見る。旧revision・出欠の回答は見ない
    where.push("EXISTS (SELECT 1 FROM operations o WHERE o.unit_id = a.unit_id AND o.id = a.operation_id AND o.countable = 1)");
    where.push(
      "EXISTS (SELECT 1 FROM activity_results r " +
        "JOIN activity_result_revisions v ON v.unit_id = r.unit_id AND v.result_id = r.id AND v.id = r.current_revision_id " +
        "JOIN activity_actual_participants ap ON ap.result_revision_id = v.id AND ap.actual_status = 'participated'" +
        `${query.memberId ? " AND ap.member_id = ?" : ""} ` +
        "WHERE r.unit_id = a.unit_id AND r.activity_id = a.id)",
    );
    if (query.memberId) binds.push(query.memberId);
  }
  if (cursorValue) {
    // 安定ソート（planned_starts_at, id）の続き。同時刻の活動はid順で並べ、取りこぼしも重複も作らない
    const cursor = (await decodeCursor(key, cursorValue))!;
    where.push("(a.planned_starts_at > ? OR (a.planned_starts_at = ? AND a.id > ?))");
    binds.push(cursor.startsAt, cursor.startsAt, cursor.id);
  }

  // limit+1件だけ読み、続きの有無をnextCursorの有無で返す（件数を黙って切り捨てない。docs/05 §1）
  const rows = (
    await ctx.env.DB.prepare(
      "SELECT a.id, a.version, a.operation_id, a.title, a.kind, a.planned_starts_at, a.planned_ends_at, " +
        "a.location_text, a.owner_member_id, a.status, a.response_due_at, a.created_at, a.updated_at " +
        `FROM activities a WHERE ${where.join(" AND ")} ORDER BY a.planned_starts_at, a.id LIMIT ?`,
    ).bind(...binds, query.limit + 1).all<ActivityRow>()
  ).results;

  const page = rows.slice(0, query.limit);
  const items = page.map((r) =>
    Activity.parse({
      id: r.id, version: r.version, operationId: r.operation_id, title: r.title, kind: r.kind,
      plannedStartsAt: r.planned_starts_at, plannedEndsAt: r.planned_ends_at, locationText: r.location_text,
      ownerMemberId: r.owner_member_id, status: r.status, responseDueAt: r.response_due_at,
      createdAt: r.created_at, updatedAt: r.updated_at,
    }),
  );
  const nextCursor = rows.length > query.limit
    ? await encodeCursor(key, {
        filterHash,
        startsAt: page[page.length - 1]!.planned_starts_at,
        id: page[page.length - 1]!.id,
      })
    : undefined;
  return { items, nextCursor };
}
