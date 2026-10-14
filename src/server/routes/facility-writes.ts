import { Facility, LocationRevision } from "../../shared/contracts/gis";
import { resolvePrincipal } from "../auth/principal";
import { HttpError, defineRoute, ok, parseApiRequest, type ApiApp } from "../http";
import { canonicalRequestHash } from "../mutations/hash";
import { executeMutation } from "../mutations/execute";
import { planAttachmentLinks } from "../attachments/link";
import { requirePermission } from "./invitations";

/**
 * 施設の作成・変更・位置確認（T019、docs/04 facilities、docs/11 位置確認、D09/D19）。
 * 台帳の変更はunits.dataset_revisionを同じbatchで増分する（全件取得のsnapshot検知はT020）。
 */

export const FACILITY_JSON =
  "SELECT json_object('id', id, 'version', version, 'type', type, 'managementNumber', management_number, 'identifyingName', identifying_name, " +
  "'latitude', latitude, 'longitude', longitude, 'locationSource', location_source, 'locationNote', location_note, " +
  "'locationVersion', location_version, 'verificationStatus', verification_status, 'lastVerifiedAt', last_verified_at, 'metadata', json(metadata)) " +
  "FROM facilities WHERE id = ?";

export interface FacilityRow {
  id: string; unit_id: string; version: number; type: string; management_number: string | null; identifying_name: string | null;
  latitude: number; longitude: number; location_note: string; location_source: string; location_version: number;
  verification_status: string; last_verified_at: string | null; verified_by_member_id: string | null; metadata: string; archived_at: string | null;
}

export async function loadFacility(env: { DB: D1Database }, id: string, unitId: string): Promise<FacilityRow | null> {
  const row = await env.DB.prepare("SELECT * FROM facilities WHERE id = ?").bind(id).first<FacilityRow>();
  return row && row.unit_id === unitId ? row : null;
}

/** 台帳変更と同じbatchで実行するdataset_revisionの増分（docs/05 §5。これで続き取得が409 SNAPSHOT_CHANGEDになる） */
export const bumpDatasetRevision = (env: { DB: D1Database }, unitId: string) =>
  env.DB.prepare("UPDATE units SET dataset_revision = dataset_revision + 1 WHERE id = ?").bind(unitId);

/** 位置履歴に1行追記する。同版内の確認はevent_noを増分して残す（docs/04 facility_location_revisions） */
export function insertLocationRevision(env: { DB: D1Database }, params: {
  id: string; unitId: string; facilityId: string; locationVersion: number; latitude: number; longitude: number;
  locationSource: string; verificationStatus: string; verifiedByMemberId: string | null; verifiedAt: string | null;
  reason: string; actorUserId: string | null; now: string;
}): D1PreparedStatement {
  return env.DB.prepare(
    "INSERT INTO facility_location_revisions (id, unit_id, facility_id, location_version, event_no, latitude, longitude, location_source, verification_status, verified_by_member_id, verified_at, reason, actor_user_id, actor_kind, created_at) " +
      "VALUES (?, ?, ?, ?, (SELECT COALESCE(MAX(event_no), 0) + 1 FROM facility_location_revisions WHERE facility_id = ? AND location_version = ?), ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
  ).bind(
    params.id, params.unitId, params.facilityId, params.locationVersion, params.facilityId, params.locationVersion,
    params.latitude, params.longitude, params.locationSource, params.verificationStatus,
    params.verifiedByMemberId, params.verifiedAt, params.reason, params.actorUserId,
    params.actorUserId ? "human" : "system", params.now,
  );
}

const REVISION_JSON =
  "SELECT json_object('id', id, 'locationVersion', location_version, 'eventNo', event_no, 'latitude', latitude, 'longitude', longitude, " +
  "'locationSource', location_source, 'verificationStatus', verification_status, 'verifiedByMemberId', verified_by_member_id, " +
  "'verifiedAt', verified_at, 'reason', reason, 'createdAt', created_at) FROM facility_location_revisions WHERE facility_id = ? AND location_version = ? ORDER BY event_no DESC LIMIT 1";

export function registerFacilityWriteRoutes(app: ApiApp): void {
  // --- API-11 作成（PER-03。確認状態はunverifiedで開始し、位置履歴にも最初の1行を残す） ---
  defineRoute(app, "API-11", async (c) => {
    const p = await resolvePrincipal(c);
    const { body, headers } = await parseApiRequest(c, "API-11");
    requirePermission(p, "PER-03", { unitId: p.unitId, type: "facility" });
    const id = crypto.randomUUID();
    // 添付の予約（draftId）とready添付の個別指定（attachmentIds。docs/05 API-11。draftIdと併用可）を、
    // 施設の作成と同じbatchで消費/リンクする（T017）
    const link = body.attachmentDraftId || (body.attachmentIds?.length ?? 0) > 0
      ? await planAttachmentLinks(c.env, p.unitId, p.userId, {
          target: { type: "facility", id },
          draftId: body.attachmentDraftId,
          attachmentIds: body.attachmentIds,
          targetCreatedInBatch: true,
        })
      : null;
    const result = await executeMutation(c.env, p, {
      operationCode: "facility.create",
      key: headers["idempotency-key"],
      requestHash: await canonicalRequestHash({ method: "POST", path: "/facilities", body }),
      expectedAuthzVersion: p.authzVersion,
      roots: link?.root ? [link.root] : [],
      created: [{ table: "facilities", id }],
      conditions: link?.conditions ?? [],
      duplicateOn: ["facilities.unit_id", "facilities.type", "facilities.management_number", ...(link?.duplicateOn ?? [])],
      statements: (ctx) => [
        c.env.DB.prepare(
          "INSERT INTO facilities (id, unit_id, type, management_number, identifying_name, latitude, longitude, location_note, location_source, location_version, verification_status, metadata, last_mutation_token, created_at, updated_at, created_by, actor_kind) " +
            "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 'unverified', ?, ?, ?, ?, ?, 'human')",
        ).bind(
          id, p.unitId, body.type, body.managementNumber ?? null, body.identifyingName ?? null,
          body.latitude, body.longitude, body.locationNote, body.locationSource,
          JSON.stringify(body.metadata ?? {}), ctx.attempt, ctx.now, ctx.now, p.userId,
        ),
        insertLocationRevision(c.env, {
          id: crypto.randomUUID(), unitId: p.unitId, facilityId: id, locationVersion: 1,
          latitude: body.latitude, longitude: body.longitude, locationSource: body.locationSource,
          verificationStatus: "unverified", verifiedByMemberId: null, verifiedAt: null,
          reason: "登録", actorUserId: p.userId, now: ctx.now,
        }),
        bumpDatasetRevision(c.env, p.unitId),
        ...(link ? link.statements(ctx) : []),
      ],
      audit: { action: "facility.create", entityType: "facility", entityId: id, metadata: { type: body.type } },
      event: { entityType: "facility", entityId: id, entityVersion: 1, eventType: "facility.created", payload: { type: body.type } },
      response: { status: 201, sql: FACILITY_JSON, binds: [id], decode: (j) => Facility.parse(j) },
    });
    return ok(c, result.data, {}, 201);
  });

  // --- API-13 変更（座標・出典を変えると位置確認だけが失効する。docs/11 位置確認） ---
  defineRoute(app, "API-13", async (c) => {
    const p = await resolvePrincipal(c);
    const { params, body, headers } = await parseApiRequest(c, "API-13");
    requirePermission(p, "PER-03", { unitId: p.unitId, type: "facility", id: params.id });
    const current = await loadFacility(c.env, params.id, p.unitId);
    if (!current) throw new HttpError("NOT_FOUND"); // 別unitも同じ応答

    const sets: string[] = [];
    const setBinds: unknown[] = [];
    const col = (name: string, value: unknown) => { sets.push(`${name} = ?`); setBinds.push(value); };
    let locationChanged = false;
    if (body.type !== undefined) col("type", body.type);
    if (body.managementNumber !== undefined) col("management_number", body.managementNumber);
    if (body.identifyingName !== undefined) col("identifying_name", body.identifyingName);
    if (body.locationNote !== undefined) col("location_note", body.locationNote);
    if (body.metadata !== undefined) col("metadata", JSON.stringify(body.metadata));
    if (body.latitude !== undefined) { col("latitude", body.latitude); locationChanged = true; }
    if (body.longitude !== undefined) { col("longitude", body.longitude); locationChanged = true; }
    if (body.locationSource !== undefined) { col("location_source", body.locationSource); locationChanged = true; }
    if (sets.length === 0) throw new HttpError("VALIDATION_ERROR", undefined, [{ field: "(body)", reason: "no_changes" }]);
    if (locationChanged) {
      // 位置の変更は必ず新しいlocationVersion。旧確認は失効する（履歴の行には残る）
      sets.push("location_version = location_version + 1", "verification_status = 'unverified'", "last_verified_at = NULL", "verified_by_member_id = NULL");
    }
    const newLocationVersion = current.location_version + (locationChanged ? 1 : 0);
    const result = await executeMutation(c.env, p, {
      operationCode: "facility.update",
      key: headers["idempotency-key"],
      requestHash: await canonicalRequestHash({ method: "PATCH", path: `/facilities/${params.id}`, baseVersion: body.version, body }),
      expectedAuthzVersion: p.authzVersion,
      roots: [{ table: "facilities", id: params.id, expectedVersion: body.version }],
      // 番号の変更が既存の施設と重複したら409（D19案: 分団×種別×番号の一意。API-11と同じ宣言）
      duplicateOn: ["facilities.unit_id", "facilities.type", "facilities.management_number"],
      statements: (ctx) => [
        c.env.DB.prepare(
          `UPDATE facilities SET ${[...sets, "version = version + 1", "last_mutation_token = ?", "updated_at = ?"].join(", ")} WHERE id = ? AND unit_id = ? AND version = ?`,
        ).bind(...setBinds, ctx.attempt, ctx.now, params.id, p.unitId, body.version),
        ...(locationChanged
          ? [insertLocationRevision(c.env, {
              id: crypto.randomUUID(), unitId: p.unitId, facilityId: params.id, locationVersion: newLocationVersion,
              latitude: body.latitude ?? current.latitude, longitude: body.longitude ?? current.longitude,
              locationSource: body.locationSource ?? current.location_source,
              verificationStatus: "unverified", verifiedByMemberId: null, verifiedAt: null,
              reason: "位置情報を変更しました", actorUserId: p.userId, now: ctx.now,
            })]
          : []),
        bumpDatasetRevision(c.env, p.unitId),
      ],
      audit: { action: "facility.update", entityType: "facility", entityId: params.id, metadata: locationChanged ? { location: "changed" } : {} },
      event: { entityType: "facility", entityId: params.id, entityVersion: body.version + 1, eventType: "facility.updated", payload: locationChanged ? { location: "changed" } : {} },
      response: { status: 200, sql: FACILITY_JSON, binds: [params.id], decode: (j) => Facility.parse(j) },
    });
    return ok(c, result.data);
  });

  // --- API-45 位置確認（request/verify/reject。座標版の一致が前提。docs/11の許可辺） ---
  defineRoute(app, "API-45", async (c) => {
    const p = await resolvePrincipal(c);
    const { params, body, headers } = await parseApiRequest(c, "API-45");
    requirePermission(p, "PER-03", { unitId: p.unitId, type: "facility", id: params.id });
    const current = await loadFacility(c.env, params.id, p.unitId);
    if (!current) throw new HttpError("NOT_FOUND");
    const allowedStates = { request: ["unverified", "pending"], verify: ["pending"], reject: ["pending"] } as const;
    const nextStatus = { request: "pending", verify: "verified", reject: "rejected" } as const;
    if (current.location_version !== body.locationVersion) {
      throw new HttpError("VERSION_CONFLICT", undefined, [{ field: "locationVersion", reason: "location_version_mismatch" }]);
    }
    const result = await executeMutation(c.env, p, {
      operationCode: "facility.location.review",
      key: headers["idempotency-key"],
      requestHash: await canonicalRequestHash({ method: "POST", path: `/facilities/${params.id}/location-reviews`, baseVersion: body.version, body }),
      expectedAuthzVersion: p.authzVersion,
      roots: [{
        table: "facilities", id: params.id, expectedVersion: body.version,
        allowedStates: { column: "verification_status", values: allowedStates[body.decision] },
      }],
      statements: (ctx) => [
        c.env.DB.prepare(
          "UPDATE facilities SET " +
            "verification_status = CASE WHEN ? IN ('request','verify','reject') THEN ? ELSE verification_status END, " +
            "last_verified_at = CASE WHEN ? = 'verify' THEN ? ELSE last_verified_at END, " +
            "verified_by_member_id = CASE WHEN ? = 'verify' THEN ? ELSE verified_by_member_id END, " +
            "version = version + 1, last_mutation_token = ?, updated_at = ? " +
            "WHERE id = ? AND unit_id = ? AND version = ?",
        ).bind(body.decision, nextStatus[body.decision], body.decision, ctx.now, body.decision, p.memberId, ctx.attempt, ctx.now, params.id, p.unitId, body.version),
        insertLocationRevision(c.env, {
          id: crypto.randomUUID(), unitId: p.unitId, facilityId: params.id, locationVersion: body.locationVersion,
          latitude: current.latitude, longitude: current.longitude, locationSource: current.location_source,
          verificationStatus: nextStatus[body.decision],
          verifiedByMemberId: body.decision === "verify" ? p.memberId : null,
          verifiedAt: body.decision === "verify" ? ctx.now : null,
          reason: body.reason, actorUserId: p.userId, now: ctx.now,
        }),
        bumpDatasetRevision(c.env, p.unitId),
      ],
      audit: { action: `facility.location.${body.decision}`, entityType: "facility", entityId: params.id, metadata: { locationVersion: body.locationVersion } },
      event: { entityType: "facility", entityId: params.id, entityVersion: body.version + 1, eventType: `facility.location_${body.decision}`, payload: { locationVersion: body.locationVersion } },
      response: {
        status: 200,
        sql: "SELECT json_object('facility', (" + FACILITY_JSON + "), 'revision', (" + REVISION_JSON + "))",
        binds: [params.id, params.id, body.locationVersion],
        decode: (j) => {
          const v = j as { facility: unknown; revision: unknown };
          return { facility: Facility.parse(v.facility), revision: LocationRevision.parse(v.revision) };
        },
      },
    });
    return ok(c, result.data);
  });
}
