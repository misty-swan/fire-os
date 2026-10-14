import { Facility } from "../../shared/contracts/gis";
import type { ParsedRequest } from "../../shared/contracts/registry";
import type { AppEnv } from "../env";
import { HttpError } from "../http";
import { decodeGisCursor, encodeGisCursor, filterHashOf, signingKey } from "./cursor";

/**
 * 施設のGIS検索（T020、docs/05 §5、docs/04 §5）。
 * bboxは境界を含み、日付変更線を跨ぐ（west>east）場合は経度の条件を二分する。
 * 順序はid（GIS）。cursorにfilterHashとsnapshotRevisionを持つので、条件変更や台帳更新の後の続き取得は409になる。
 */

export type FacilityQueryInput = ParsedRequest<"API-10">["query"];

export interface FacilityListResult {
  items: unknown[];
  nextCursor?: string;
  snapshotRevision: number;
}

const likeEscape = (s: string) => s.replace(/[\\%_]/g, (c) => `\\${c}`);

export async function queryFacilities(env: Pick<AppEnv, "DB">, unitId: string, secret: string, query: FacilityQueryInput): Promise<FacilityListResult> {
  const key = await signingKey(secret);
  // 条件の指紋はcursor自体を除いて計算する（cursorが変わっても検索条件は変わっていない）
  const { cursor: cursorValue, ...filterOnly } = query;
  const filterHash = await filterHashOf(filterOnly);

  // snapshotRevision（units.dataset_revision）を先に読む。続き取得はこの値がcursorと一致することを要求する
  const unit = await env.DB.prepare("SELECT dataset_revision FROM units WHERE id = ?").bind(unitId).first<{ dataset_revision: number }>();
  if (!unit) throw new HttpError("NOT_FOUND");
  const snapshotRevision = unit.dataset_revision;

  if (cursorValue) {
    const cursor = await decodeGisCursor(key, cursorValue);
    // 条件が変わったcursor・署名が一致しないcursor・台帳が変わった後のcursorは、続きとして成立しない
    if (!cursor || cursor.filterHash !== filterHash) {
      throw new HttpError("SNAPSHOT_CHANGED");
    }
    if (cursor.snapshotRevision !== snapshotRevision) {
      throw new HttpError("SNAPSHOT_CHANGED");
    }
  }

  const where = ["unit_id = ?", "archived_at IS NULL"];
  const binds: unknown[] = [unitId];
  if (query.bbox) {
    const [west, south, east, north] = query.bbox.split(",").map(Number) as [number, number, number, number];
    where.push("latitude >= ?", "latitude <= ?");
    binds.push(south, north);
    if (west <= east) {
      where.push("longitude >= ?", "longitude <= ?");
      binds.push(west, east);
    } else {
      // 日付変更線を跨ぐ: west..180 か -180..east のどちらか
      where.push("(longitude >= ? OR longitude <= ?)");
      binds.push(west, east);
    }
  }
  if (query.type) { where.push("type = ?"); binds.push(query.type); }
  if (query.verificationStatus) { where.push("verification_status = ?"); binds.push(query.verificationStatus); }
  if (query.q) {
    where.push("(management_number LIKE ? ESCAPE '\\' OR identifying_name LIKE ? ESCAPE '\\')");
    binds.push(`%${likeEscape(query.q)}%`, `%${likeEscape(query.q)}%`);
  }
  // 点検結果・開いている異常のフィルタは、その表ができるT029/T032でJOINとして接続する。
  // この時点で点検・異常は存在しないため、条件が指定されたら0件が正しい答えになる
  if (query.inspectionResult) where.push("0 = 1");
  if (query.hasOpenIssue) where.push("0 = 1");

  if (cursorValue) {
    const cursor = (await decodeGisCursor(key, cursorValue))!;
    where.push("id > ?");
    binds.push(cursor.sortKey);
  }

  const rows = (
    await env.DB.prepare(
      `SELECT id, version, type, management_number, identifying_name, latitude, longitude, location_source, location_note, ` +
        `location_version, verification_status, last_verified_at, metadata FROM facilities WHERE ${where.join(" AND ")} ORDER BY id LIMIT ?`,
    ).bind(...binds, query.limit + 1).all<Record<string, unknown>>()
  ).results;

  const page = rows.slice(0, query.limit);
  const items = page.map((r) => Facility.parse({
    id: r.id, version: r.version, type: r.type, managementNumber: r.management_number, identifyingName: r.identifying_name,
    latitude: r.latitude, longitude: r.longitude, locationSource: r.location_source, locationNote: r.location_note,
    locationVersion: r.location_version, verificationStatus: r.verification_status, lastVerifiedAt: r.last_verified_at,
    metadata: JSON.parse(r.metadata as string) as Record<string, unknown>,
  }));
  const nextCursor = rows.length > query.limit
    ? await encodeGisCursor(key, { filterHash, sortKey: page[page.length - 1]!.id as string, snapshotRevision })
    : undefined;
  return { items, nextCursor, snapshotRevision };
}
