import { Equipment, Vehicle, type AssetDetailDto } from "../../shared/contracts/assets";
import { resolvePrincipal } from "../auth/principal";
import { HttpError, defineRoute, ok, parseApiRequest, type ApiApp, type ApiContext } from "../http";
import { canonicalRequestHash } from "../mutations/hash";
import { executeMutation } from "../mutations/execute";
import { bumpDatasetRevision } from "./facility-writes";
import { requirePermission } from "./invitations";
import { toResourceUsageDto } from "./resource-usages";

/**
 * 車両・資機材の台帳（T025、docs/04 §3.2、docs/05 API-18/19/47〜51、D15）。
 * 保管先は施設/車両のどちらか一方、外部保管は備考。使用による在庫の自動減算はしない。
 * 物理削除はしない（参照履歴を守る。廃止はarchived_at）。
 */

const VEHICLE_JSON =
  "SELECT json_object('id', id, 'version', version, 'assetCode', asset_code, 'name', name, 'status', status, " +
  "'storageFacilityId', storage_facility_id, 'archivedAt', archived_at) FROM vehicles WHERE id = ?";
const EQUIPMENT_JSON =
  "SELECT json_object('id', id, 'version', version, 'assetCode', asset_code, 'name', name, 'quantity', quantity, 'quantityUnit', quantity_unit, 'status', status, " +
  "'storage', json_object('facilityId', storage_facility_id, 'vehicleId', storage_vehicle_id, 'note', storage_note), 'archivedAt', archived_at) FROM equipment WHERE id = ?";

interface VehicleRow {
  id: string; unit_id: string; version: number; asset_code: string; name: string; status: string;
  storage_facility_id: string | null; archived_at: string | null;
}
interface EquipmentRow {
  id: string; unit_id: string; version: number; asset_code: string; name: string; quantity: number;
  quantity_unit: string; status: string; storage_facility_id: string | null; storage_vehicle_id: string | null;
  storage_note: string | null; archived_at: string | null;
}

const likeEscape = (s: string) => s.replace(/[\\%_]/g, (c) => `\\${c}`);
const encodeCursor = (code: string, id: string) =>
  btoa(unescape(encodeURIComponent(JSON.stringify([code, id])))).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
function decodeCursor(cursor: string): [string, string] {
  try {
    const v = JSON.parse(decodeURIComponent(escape(atob(cursor.replaceAll("-", "+").replaceAll("_", "/"))))) as unknown;
    if (Array.isArray(v) && v.length === 2 && typeof v[0] === "string" && typeof v[1] === "string") return [v[0], v[1]];
  } catch {
    /* 下で400 */
  }
  throw new HttpError("VALIDATION_ERROR", undefined, [{ field: "cursor", reason: "invalid_cursor" }]);
}

/** API-47/49: 車両・資機材の登録。API-48/50: 変更（版管理）。API-18/19: 一覧。API-51: 詳細 */
export function registerAssetRoutes(app: ApiApp): void {
  // --- API-47 車両の登録 ---
  defineRoute(app, "API-47", async (c) => {
    const p = await resolvePrincipal(c);
    const { body, headers } = await parseApiRequest(c, "API-47");
    requirePermission(p, "PER-03", { unitId: p.unitId, type: "vehicle" });
    if (body.storageFacilityId) {
      const f = await c.env.DB.prepare("SELECT 1 FROM facilities WHERE id = ? AND unit_id = ?").bind(body.storageFacilityId, p.unitId).first();
      if (!f) throw new HttpError("NOT_FOUND");
    }
    const id = crypto.randomUUID();
    const result = await executeMutation(c.env, p, {
      operationCode: "vehicle.create",
      key: headers["idempotency-key"],
      requestHash: await canonicalRequestHash({ method: "POST", path: "/vehicles", body }),
      expectedAuthzVersion: p.authzVersion,
      roots: [],
      created: [{ table: "vehicles", id }],
      duplicateOn: ["vehicles.unit_id", "vehicles.asset_code"],
      statements: (ctx) => [
        c.env.DB.prepare(
          "INSERT INTO vehicles (id, unit_id, asset_code, name, status, storage_facility_id, last_mutation_token, created_at, updated_at, created_by, actor_kind) " +
            "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'human')",
        ).bind(id, p.unitId, body.assetCode, body.name, body.status, body.storageFacilityId ?? null, ctx.attempt, ctx.now, ctx.now, p.userId),
        bumpDatasetRevision(c.env, p.unitId),
      ],
      audit: { action: "vehicle.create", entityType: "vehicle", entityId: id },
      event: { entityType: "vehicle", entityId: id, entityVersion: 1, eventType: "vehicle.created" },
      response: { status: 201, sql: VEHICLE_JSON, binds: [id], decode: (j) => Vehicle.parse(j) },
    });
    return ok(c, result.data, {}, 201);
  });

  // --- API-48 車両の変更 ---
  defineRoute(app, "API-48", async (c) => {
    const p = await resolvePrincipal(c);
    const { params, body, headers } = await parseApiRequest(c, "API-48");
    requirePermission(p, "PER-03", { unitId: p.unitId, type: "vehicle", id: params.id });
    const current = await c.env.DB.prepare("SELECT * FROM vehicles WHERE id = ?").bind(params.id)
      .first<VehicleRow>().then((r) => (r && r.unit_id === p.unitId ? r : null));
    if (!current) throw new HttpError("NOT_FOUND");
    const sets: string[] = [];
    const binds: unknown[] = [];
    const col = (n: string, v: unknown) => { sets.push(`${n} = ?`); binds.push(v); };
    if (body.assetCode !== undefined) col("asset_code", body.assetCode);
    if (body.name !== undefined) col("name", body.name);
    if (body.status !== undefined) col("status", body.status);
    if (body.storageFacilityId !== undefined) {
      if (body.storageFacilityId) {
        const f = await c.env.DB.prepare("SELECT 1 FROM facilities WHERE id = ? AND unit_id = ?").bind(body.storageFacilityId, p.unitId).first();
        if (!f) throw new HttpError("NOT_FOUND");
      }
      col("storage_facility_id", body.storageFacilityId);
    }
    if (sets.length === 0) throw new HttpError("VALIDATION_ERROR", undefined, [{ field: "(body)", reason: "no_changes" }]);
    const result = await executeMutation(c.env, p, {
      operationCode: "vehicle.update",
      key: headers["idempotency-key"],
      requestHash: await canonicalRequestHash({ method: "PATCH", path: `/vehicles/${params.id}`, baseVersion: body.version, body }),
      expectedAuthzVersion: p.authzVersion,
      roots: [{ table: "vehicles", id: params.id, expectedVersion: body.version }],
      conditions: body.storageFacilityId
        ? [{ existsSql: "SELECT 1 FROM facilities WHERE id = ? AND unit_id = ?", binds: [body.storageFacilityId, p.unitId], failCode: "NOT_FOUND" }]
        : [],
      duplicateOn: ["vehicles.unit_id", "vehicles.asset_code"],
      statements: (ctx) => [
        c.env.DB.prepare(
          `UPDATE vehicles SET ${[...sets, "version = version + 1", "last_mutation_token = ?", "updated_at = ?"].join(", ")} WHERE id = ? AND unit_id = ? AND version = ?`,
        ).bind(...binds, ctx.attempt, ctx.now, params.id, p.unitId, body.version),
        bumpDatasetRevision(c.env, p.unitId),
      ],
      audit: { action: "vehicle.update", entityType: "vehicle", entityId: params.id },
      event: { entityType: "vehicle", entityId: params.id, entityVersion: body.version + 1, eventType: "vehicle.updated" },
      response: { status: 200, sql: VEHICLE_JSON, binds: [params.id], decode: (j) => Vehicle.parse(j) },
    });
    return ok(c, result.data);
  });

  // --- API-49 資機材の登録（保管先の排他はDBのCHECKと入力の両方で守る） ---
  defineRoute(app, "API-49", async (c) => {
    const p = await resolvePrincipal(c);
    const { body, headers } = await parseApiRequest(c, "API-49");
    requirePermission(p, "PER-03", { unitId: p.unitId, type: "equipment" });
    if (body.storage.facilityId && body.storage.vehicleId) {
      throw new HttpError("INVALID_TRANSITION", undefined, [{ field: "storage", reason: "two_storage_targets" }]);
    }
    if (!body.storage.facilityId && !body.storage.vehicleId && !body.storage.note) {
      throw new HttpError("VALIDATION_ERROR", undefined, [{ field: "storage", reason: "storage_required" }]);
    }
    const id = crypto.randomUUID();
    const result = await executeMutation(c.env, p, {
      operationCode: "equipment.create",
      key: headers["idempotency-key"],
      requestHash: await canonicalRequestHash({ method: "POST", path: "/equipment", body }),
      expectedAuthzVersion: p.authzVersion,
      roots: [],
      created: [{ table: "equipment", id }],
      conditions: [
        ...(body.storage.facilityId ? [{ existsSql: "SELECT 1 FROM facilities WHERE id = ? AND unit_id = ?", binds: [body.storage.facilityId, p.unitId], failCode: "NOT_FOUND" as const }] : []),
        ...(body.storage.vehicleId ? [{ existsSql: "SELECT 1 FROM vehicles WHERE id = ? AND unit_id = ?", binds: [body.storage.vehicleId, p.unitId], failCode: "NOT_FOUND" as const }] : []),
      ],
      duplicateOn: ["equipment.unit_id", "equipment.asset_code"],
      statements: (ctx) => [
        c.env.DB.prepare(
          "INSERT INTO equipment (id, unit_id, asset_code, name, quantity, quantity_unit, status, storage_facility_id, storage_vehicle_id, storage_note, last_mutation_token, created_at, updated_at, created_by, actor_kind) " +
            "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'human')",
        ).bind(
          id, p.unitId, body.assetCode, body.name, body.quantity, body.quantityUnit, "在庫",
          body.storage.facilityId ?? null, body.storage.vehicleId ?? null, body.storage.note ?? null,
          ctx.attempt, ctx.now, ctx.now, p.userId,
        ),
        bumpDatasetRevision(c.env, p.unitId),
      ],
      audit: { action: "equipment.create", entityType: "equipment", entityId: id },
      event: { entityType: "equipment", entityId: id, entityVersion: 1, eventType: "equipment.created" },
      response: { status: 201, sql: EQUIPMENT_JSON, binds: [id], decode: (j) => Equipment.parse(j) },
    });
    return ok(c, result.data, {}, 201);
  });

  // --- API-50 資機材の変更 ---
  defineRoute(app, "API-50", async (c) => {
    const p = await resolvePrincipal(c);
    const { params, body, headers } = await parseApiRequest(c, "API-50");
    requirePermission(p, "PER-03", { unitId: p.unitId, type: "equipment", id: params.id });
    const current = await c.env.DB.prepare("SELECT * FROM equipment WHERE id = ?").bind(params.id)
      .first<EquipmentRow>().then((r) => (r && r.unit_id === p.unitId ? r : null));
    if (!current) throw new HttpError("NOT_FOUND");
    const sets: string[] = [];
    const binds: unknown[] = [];
    const col = (n: string, v: unknown) => { sets.push(`${n} = ?`); binds.push(v); };
    if (body.assetCode !== undefined) col("asset_code", body.assetCode);
    if (body.name !== undefined) col("name", body.name);
    if (body.quantity !== undefined) col("quantity", body.quantity);
    if (body.quantityUnit !== undefined) col("quantity_unit", body.quantityUnit);
    if (body.status !== undefined) col("status", body.status);
    const conditions: { existsSql: string; binds: unknown[]; failCode: "NOT_FOUND" }[] = [];
    if (body.storage !== undefined) {
      const facilityId = body.storage.facilityId ?? null;
      const vehicleId = body.storage.vehicleId ?? null;
      const note = body.storage.note ?? null;
      if (facilityId && vehicleId) throw new HttpError("INVALID_TRANSITION", undefined, [{ field: "storage", reason: "two_storage_targets" }]);
      if (!facilityId && !vehicleId && !note) throw new HttpError("VALIDATION_ERROR", undefined, [{ field: "storage", reason: "storage_required" }]);
      if (facilityId) {
        conditions.push({ existsSql: "SELECT 1 FROM facilities WHERE id = ? AND unit_id = ?", binds: [facilityId, p.unitId], failCode: "NOT_FOUND" });
      }
      if (vehicleId) {
        conditions.push({ existsSql: "SELECT 1 FROM vehicles WHERE id = ? AND unit_id = ?", binds: [vehicleId, p.unitId], failCode: "NOT_FOUND" });
      }
      col("storage_facility_id", facilityId);
      col("storage_vehicle_id", vehicleId);
      col("storage_note", note);
    }
    if (sets.length === 0) throw new HttpError("VALIDATION_ERROR", undefined, [{ field: "(body)", reason: "no_changes" }]);
    const result = await executeMutation(c.env, p, {
      operationCode: "equipment.update",
      key: headers["idempotency-key"],
      requestHash: await canonicalRequestHash({ method: "PATCH", path: `/equipment/${params.id}`, baseVersion: body.version, body }),
      expectedAuthzVersion: p.authzVersion,
      roots: [{ table: "equipment", id: params.id, expectedVersion: body.version }],
      conditions,
      duplicateOn: ["equipment.unit_id", "equipment.asset_code"],
      statements: (ctx) => [
        c.env.DB.prepare(
          `UPDATE equipment SET ${[...sets, "version = version + 1", "last_mutation_token = ?", "updated_at = ?"].join(", ")} WHERE id = ? AND unit_id = ? AND version = ?`,
        ).bind(...binds, ctx.attempt, ctx.now, params.id, p.unitId, body.version),
        bumpDatasetRevision(c.env, p.unitId),
      ],
      audit: { action: "equipment.update", entityType: "equipment", entityId: params.id },
      event: { entityType: "equipment", entityId: params.id, entityVersion: body.version + 1, eventType: "equipment.updated" },
      response: { status: 200, sql: EQUIPMENT_JSON, binds: [params.id], decode: (j) => Equipment.parse(j) },
    });
    return ok(c, result.data);
  });

  // --- API-18/19: 一覧（車両・資機材）。名簿と同じcode順のkeyset ---
  const listRoute = (apiId: "API-18" | "API-19", table: "vehicles" | "equipment", type: "vehicle" | "equipment") =>
    defineRoute(app, apiId, async (c) => {
      const p = await resolvePrincipal(c);
      const { query } = await parseApiRequest(c, apiId);
      const storageFilter = (query as { storage?: string }).storage;
      requirePermission(p, "PER-01", { unitId: p.unitId, type });
      const where = ["unit_id = ?"];
      const binds: unknown[] = [p.unitId];
      if (query.q) {
        where.push("(asset_code LIKE ? ESCAPE '\\' OR name LIKE ? ESCAPE '\\')");
        binds.push(`%${likeEscape(query.q)}%`, `%${likeEscape(query.q)}%`);
      }
      if (query.status) { where.push("status = ?"); binds.push(query.status); }
      if (storageFilter) { where.push("storage_note LIKE ? ESCAPE '\\'"); binds.push(`%${likeEscape(storageFilter)}%`); }
      if (query.cursor) {
        const [code, id] = decodeCursor(query.cursor);
        where.push("(asset_code > ? OR (asset_code = ? AND id > ?))");
        binds.push(code, code, id);
      }
      const rows = (
        await c.env.DB.prepare(
          `SELECT * FROM ${table} WHERE ${where.join(" AND ")} ORDER BY asset_code, id LIMIT ?`,
        ).bind(...binds, query.limit + 1).all<Record<string, unknown>>()
      ).results;
      const page = rows.slice(0, query.limit);
      const nextCursor = rows.length > query.limit
        ? encodeCursor(page[page.length - 1]!.asset_code as string, page[page.length - 1]!.id as string)
        : undefined;
      const data = page.map((r) =>
        table === "vehicles"
          ? Vehicle.parse({
              id: r.id, version: r.version, assetCode: r.asset_code, name: r.name, status: r.status,
              storageFacilityId: r.storage_facility_id, archivedAt: r.archived_at,
            })
          : Equipment.parse({
              id: r.id, version: r.version, assetCode: r.asset_code, name: r.name, quantity: r.quantity,
              quantityUnit: r.quantity_unit, status: r.status,
              storage: { facilityId: r.storage_facility_id, vehicleId: r.storage_vehicle_id, note: r.storage_note },
              archivedAt: r.archived_at,
            }),
      );
      return ok(c, data, { nextCursor });
    });
  listRoute("API-18", "vehicles", "vehicle");
  listRoute("API-19", "equipment", "equipment");

  // --- API-51: 詳細（docs/05 API-51行どおりAssetDetail。使用履歴のcursor子PageはT042で接続。
  // 点検/異常/点検期限の子Pageは未接続＝残作業（T030/T032/T048）。続きはmeta.nextCursor） ---
  defineRoute(app, "API-51", async (c) => {
    const p = await resolvePrincipal(c);
    const { params, query } = await parseApiRequest(c, "API-51");
    requirePermission(p, "PER-01", { unitId: p.unitId, type: params.type, id: params.id });
    if (params.type === "vehicle") {
      const row = await c.env.DB.prepare("SELECT * FROM vehicles WHERE id = ?").bind(params.id)
        .first<VehicleRow>().then((r) => (r && r.unit_id === p.unitId ? r : null));
      if (!row) throw new HttpError("NOT_FOUND");
      const asset = Vehicle.parse({
        id: row.id, version: row.version, assetCode: row.asset_code, name: row.name, status: row.status,
        storageFacilityId: row.storage_facility_id, archivedAt: row.archived_at,
      });
      const usages = await usageChildPage(c, p.unitId, params.type, params.id, query.cursor, query.limit);
      return ok(c, { asset, usages: usages.page }, { nextCursor: usages.nextCursor });
    }
    const row = await c.env.DB.prepare("SELECT * FROM equipment WHERE id = ?").bind(params.id)
      .first<EquipmentRow>().then((r) => (r && r.unit_id === p.unitId ? r : null));
    if (!row) throw new HttpError("NOT_FOUND");
    const asset = Equipment.parse({
      id: row.id, version: row.version, assetCode: row.asset_code, name: row.name, quantity: row.quantity,
      quantityUnit: row.quantity_unit, status: row.status,
      storage: { facilityId: row.storage_facility_id, vehicleId: row.storage_vehicle_id, note: row.storage_note },
      archivedAt: row.archived_at,
    });
    const usages = await usageChildPage(c, p.unitId, params.type, params.id, query.cursor, query.limit);
    return ok(c, { asset, usages: usages.page }, { nextCursor: usages.nextCursor });
  });
}

/**
 * 資産の使用履歴の子Page（docs/05 API-51「使用履歴のcursor子Page」。docs/04:100。
 * cancelledも行として残る。作成順＝(created_at, id)の安定keyset。facility-detailの位置履歴と同じ流儀）。
 * limit+1件だけ読み、続きの有無をnextCursorの有無で返す（件数を黙って切り捨てない。docs/05 §1）
 */
interface UsageQueryRow {
  id: string; unit_id: string; operation_id: string; vehicle_id: string | null; equipment_id: string | null;
  quantity: number; used_from: string | null; used_to: string | null;
  recorded_by_member_id: string; status: string; version: number; created_at: string;
}

async function usageChildPage(
  c: ApiContext, unitId: string, type: "vehicle" | "equipment", id: string, cursor: string | undefined, limit: number,
): Promise<{ page: AssetDetailDto["usages"]; nextCursor: string | undefined }> {
  const where = ["unit_id = ?", `${type}_id = ?`];
  const binds: unknown[] = [id];
  if (cursor) {
    const [at, lastId] = decodeCursor(cursor);
    where.push("(created_at > ? OR (created_at = ? AND id > ?))");
    binds.push(at, at, lastId);
  }
  const rows = (
    await c.env.DB.prepare(
      `SELECT id, unit_id, operation_id, vehicle_id, equipment_id, quantity, used_from, used_to, recorded_by_member_id, status, version, created_at ` +
        `FROM resource_usages WHERE ${where.join(" AND ")} ORDER BY created_at, id LIMIT ?`,
    ).bind(unitId, ...binds, limit + 1).all<UsageQueryRow>()
  ).results;
  const page = rows.slice(0, limit);
  const nextCursor = rows.length > limit
    ? encodeCursor(page[page.length - 1]!.created_at, page[page.length - 1]!.id)
    : undefined;
  return { page: page.map(toResourceUsageDto), nextCursor };
}
