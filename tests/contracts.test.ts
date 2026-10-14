import { describe, expect, it } from "vitest";
import { ErrorEnvelope, LIMITS, errorCodes, errorStatus } from "../src/shared/contracts/common";
import { apiDef, apiIds, parseRequest, registry, safeParseRequest } from "../src/shared/contracts/registry";
import { buildOpenApi } from "../src/shared/contracts/openapi";
import { successStatusProblems } from "../src/shared/contracts/doc-check";
import * as states from "../src/shared/states";
import { Hono } from "hono";
import type { AppBindings } from "../src/server/env";
import { HttpError, onError, parseApiRequest, readJsonBody } from "../src/server/http";

const ID = "11111111-1111-4111-8111-111111111111";
const ID2 = "22222222-2222-4222-8222-222222222222";
const KEY = { "idempotency-key": "key-1" };

// docs/05 §4 の101行を独立に数え上げた期待値（API-01〜API-101）
const expected101Ids = Array.from({ length: 101 }, (_, i) => `API-${String(i + 1).padStart(2, "0")}`);

const validFacility = {
  type: "hydrant", latitude: 35.0, longitude: 139.0, locationSource: "現地確認", locationNote: "交差点北側", managementNumber: "H-001",
};

describe("contracts (T002)", () => {
  it("contract_registry_is_complete_and_strict", () => {
    const registryIds = [...apiIds];
    expect(registryIds).toEqual(expected101Ids);

    // 未知列
    const unknownField = safeParseRequest("API-11", { body: { ...validFacility, role: "admin" }, headers: KEY });
    // NaN / 範囲外の緯度
    const invalidLatitude = safeParseRequest("API-11", { body: { ...validFacility, latitude: Number.NaN }, headers: KEY });
    const outOfRange = safeParseRequest("API-11", { body: { ...validFacility, latitude: 91 }, headers: KEY });
    // 既存rowの更新で version 欠落
    const missingVersion = safeParseRequest("API-13", { params: { id: ID }, body: { locationNote: "x" }, headers: KEY });
    // limit=201
    const limit201 = safeParseRequest("API-05", { query: { limit: "201" } });
    // 空配列の必須項目
    const emptyAudience = safeParseRequest("API-25", {
      body: { title: "t", body: "b", audienceMemberIds: [] }, headers: KEY,
    });

    expect(unknownField.success).toBe(false);
    expect(invalidLatitude.success).toBe(false);
    expect(outOfRange.success).toBe(false);
    expect(missingVersion.success).toBe(false);
    expect(limit201.success).toBe(false);
    expect(emptyAudience.success).toBe(false);

    // 正常系は通る（厳しすぎて全拒否になっていないこと）
    expect(safeParseRequest("API-11", { body: validFacility, headers: KEY }).success).toBe(true);
    expect(safeParseRequest("API-13", { params: { id: ID }, body: { version: 2, locationNote: "x" }, headers: KEY }).success).toBe(true);
  });

  it("limit_defaults_to_50_and_max_is_200", () => {
    expect(parseRequest("API-05", { query: {} }).query.limit).toBe(50);
    expect(parseRequest("API-05", { query: { limit: "200" } }).query.limit).toBe(200);
    expect(safeParseRequest("API-05", { query: { limit: "0" } }).success).toBe(false);
    expect(safeParseRequest("API-05", { query: { limit: "abc" } }).success).toBe(false);
  });

  it("every_mutation_requires_idempotency_key_except_api36_and_api83", () => {
    const exempt = new Set(["API-36", "API-83", "API-76"]);
    for (const id of apiIds) {
      const def = apiDef(id);
      const writes = ["POST", "PUT", "PATCH", "DELETE"].includes(def.method);
      const shape = (def.request as unknown as { shape?: Record<string, unknown> }).shape ?? {};
      if (writes && !exempt.has(id)) expect(shape.headers, `${id} に Idempotency-Key が必要`).toBeDefined();
      if (!writes) expect(shape.headers, `${id}(GET)にIdempotency-Keyは不要`).toBeUndefined();
    }
    // 実際にキーが無いと拒否される
    expect(safeParseRequest("API-06", { body: {} }).success).toBe(false);
  });

  it("existing_row_updates_require_version_and_upserts_accept_zero", () => {
    const attendance = { params: { id: ID }, headers: KEY };
    expect(safeParseRequest("API-08", { ...attendance, body: { version: 0, response: "attending" } }).success).toBe(true);
    expect(safeParseRequest("API-08", { ...attendance, body: { response: "attending" } }).success).toBe(false);
    // 通常の更新は version>=1。0は不可
    expect(safeParseRequest("API-04", { params: { id: ID }, body: { version: 0 }, headers: KEY }).success).toBe(false);
  });

  it("limits_and_formats_follow_docs_05", () => {
    const base = { params: { id: ID }, headers: KEY };
    expect(safeParseRequest("API-40", { ...base, body: { version: 1, reason: "x".repeat(LIMITS.bodyMax + 1) } }).success).toBe(false);
    expect(safeParseRequest("API-77", { body: { query: "q".repeat(LIMITS.queryMax + 1), contextRefs: [] }, headers: KEY }).success).toBe(false);
    const ids = Array.from({ length: 101 }, (_, i) => `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`);
    expect(safeParseRequest("API-25", { body: { title: "t", body: "b", audienceMemberIds: ids }, headers: KEY }).success).toBe(false);
    // UTC瞬間と業務日は別型
    expect(safeParseRequest("API-68", { body: { title: "t", dueDate: "2026-10-13T00:00:00Z" }, headers: KEY }).success).toBe(false);
    expect(safeParseRequest("API-68", { body: { title: "t", dueDate: "2026-10-13" }, headers: KEY }).success).toBe(true);
    expect(safeParseRequest("API-05", { query: { from: "2026-10-13" } }).success).toBe(false);
  });

  it("business_rules_in_input_are_validated", () => {
    // 終了が開始より前
    const activity = {
      title: "訓練", kind: "training", plannedStartsAt: "2026-10-13T10:00:00Z", plannedEndsAt: "2026-10-13T09:00:00Z",
      locationText: "詰所", ownerMemberId: ID, audienceMemberIds: [ID2],
    };
    expect(safeParseRequest("API-06", { body: activity, headers: KEY }).success).toBe(false);
    // 施設: 番号も識別名もない
    const { managementNumber: _m, ...noName } = validFacility;
    expect(safeParseRequest("API-11", { body: noName, headers: KEY }).success).toBe(false);
    // 保管先: facility と vehicle の同時指定
    const equipment = { assetCode: "E1", name: "ホース", quantity: 1, quantityUnit: "本" };
    // 保管先の排他（両方指定は不可）はサーバーが422で返す業務規則（docs/16 T025）。契約は形だけ検査する
    expect(safeParseRequest("API-49", { body: { ...equipment, storage: { facilityId: ID, vehicleId: ID2 } }, headers: KEY }).success).toBe(true);
    // 点検様式: code重複
    const dup = [
      { code: "a", label: "A", valueType: "boolean", required: true },
      { code: "a", label: "B", valueType: "boolean", required: true },
    ];
    expect(safeParseRequest("API-95", { body: { name: "n", targetType: "facility", itemSchema: dup }, headers: KEY }).success).toBe(false);
    // bbox: 南>北は不可、経度跨ぎは可
    expect(safeParseRequest("API-10", { query: { bbox: "139,36,140,35" } }).success).toBe(false);
    expect(safeParseRequest("API-10", { query: { bbox: "179,35,-179,36" } }).success).toBe(true);
    // 状態の列挙外
    expect(safeParseRequest("API-15", { query: { status: "deleted" } }).success).toBe(false);
  });

  it("doc_check_detects_success_status_drift_between_docs_and_registry", () => {
    expect(successStatusProblems("API-84", "Attachment＋Job(202)", [202])).toEqual([]);
    expect(successStatusProblems("API-84", "Attachment＋Job(202)", [200])).toHaveLength(1);
    expect(successStatusProblems("API-85", "204（D1 tombstone後R2削除job）", [204])).toEqual([]);
    expect(successStatusProblems("API-85", "204（D1 tombstone後R2削除job）", [200])).toHaveLength(1);
    expect(successStatusProblems("API-54", "ImportResult(202可)", [200, 202])).toEqual([]);
    expect(successStatusProblems("API-54", "ImportResult(202可)", [202])).toHaveLength(1);
    expect(successStatusProblems("API-12", "FacilityDetail", [202])).toHaveLength(1);
  });

  it("instants_are_normalized_before_comparison_and_ids_must_be_lowercase", () => {
    const activity = {
      title: "訓練", kind: "training", locationText: "詰所", ownerMemberId: ID, audienceMemberIds: [ID2],
      plannedStartsAt: "2026-10-13T10:00:00.500Z", plannedEndsAt: "2026-10-13T10:00:00Z",
    };
    // 文字列比較だと end>=start に見えるが、実際は終了が0.5秒前
    expect(safeParseRequest("API-06", { body: activity, headers: KEY }).success).toBe(false);
    const ok = parseRequest("API-06", { body: { ...activity, plannedEndsAt: "2026-10-13T11:00:00Z" }, headers: KEY });
    expect(ok.body.plannedEndsAt).toBe("2026-10-13T11:00:00.000Z"); // DBと同じミリ秒3桁へ正規化
    const lettered = "abcdef12-3456-4789-8abc-def012345678";
    expect(safeParseRequest("API-86", { params: { id: lettered } }).success).toBe(true);
    expect(safeParseRequest("API-86", { params: { id: lettered.toUpperCase() } }).success).toBe(false);
  });

  it("api36_and_binary_apis_have_their_own_contract", () => {
    expect(registry["API-36"].kind).toBe("external");
    expect(registry["API-27"].kind).toBe("binary");
    expect(registry["API-85"].success).toEqual([204]);
    expect(registry["API-101"].success).toEqual([204]);
    // API-83 は uploadToken をヘッダーで受け、Idempotency-Key は要求しない
    expect(safeParseRequest("API-83", { params: { id: ID }, headers: { "x-upload-token": "t" } }).success).toBe(true);
    // 202は永続job
    for (const id of ["API-29", "API-32", "API-53", "API-64", "API-84", "API-89"] as const) {
      expect(registry[id].success).toEqual([202]);
    }
  });

  it("state_dictionary_matches_docs_11", () => {
    expect(states.issueStates).toEqual(["reported", "under_review", "in_progress", "resolved", "closed"]);
    expect(states.activityStates).toEqual(["draft", "scheduled", "in_progress", "completed", "cancelled"]);
    expect(states.mobilizationStates).toEqual(["unconfirmed", "unavailable", "mobilizing", "arrived", "returned"]);
    expect(states.deliveryStates).toHaveLength(6);
    expect(states.canTransition(states.issueTransitions, "reported", "under_review")).toBe(true);
    expect(states.canTransition(states.issueTransitions, "reported", "closed")).toBe(false);
    expect(states.canTransition(states.activityTransitions, "completed", "in_progress")).toBe(true);
    expect(states.canTransition(states.incidentTransitions, "voided", "recording")).toBe(false);
    expect(states.canTransition(states.jobTransitions, "running", "retry_wait")).toBe(true);
    expect(states.canTransition(states.jobTransitions, "succeeded", "running")).toBe(false);
    // 遷移表の行き先は全て定義済みの状態
    for (const table of [states.issueTransitions, states.activityTransitions, states.jobTransitions, states.attachmentTransitions]) {
      for (const [from, tos] of Object.entries(table)) for (const to of tos) expect(Object.keys(table)).toContain(to);
    }
  });

  it("error_codes_map_to_documented_http_statuses", () => {
    expect(errorStatus.VALIDATION_ERROR).toBe(400);
    expect(errorStatus.VERSION_CONFLICT).toBe(409);
    expect(errorStatus.IDEMPOTENCY_MISMATCH).toBe(409);
    expect(errorStatus.SNAPSHOT_CHANGED).toBe(409);
    expect(errorStatus.INVALID_TRANSITION).toBe(422);
    expect(errorStatus.RATE_LIMITED).toBe(429);
    expect(errorStatus.DEPENDENCY_UNAVAILABLE).toBe(503);
    expect(Object.keys(errorStatus).sort()).toEqual([...errorCodes].sort());
  });

  it("openapi_is_3_1_and_describes_all_non_external_apis", () => {
    const doc = buildOpenApi() as { openapi: string; paths: Record<string, Record<string, { operationId: string; parameters: { name: string; in: string }[] }>> };
    expect(doc.openapi).toBe("3.1.0");
    const ops = Object.values(doc.paths).flatMap((p) => Object.values(p));
    expect(ops).toHaveLength(100); // API-36は x-external-apis
    const put = doc.paths["/api/v1/activities/{id}/attendance/me"]?.put;
    expect(put?.operationId).toBe("API-08");
    expect(put?.parameters.some((p) => p.name === "idempotency-key" && p.in === "header")).toBe(true);
  });
});

describe("http layer (T002)", () => {
  const app = new Hono<AppBindings>();
  app.use("*", async (c, next) => { c.set("requestId", "req-1"); await next(); });
  app.get("/boom", () => { throw new Error("SQLITE_ERROR: secret table name"); });
  app.get("/conflict", () => { throw new HttpError("VERSION_CONFLICT"); });
  app.post("/echo", async (c) => c.json(await readJsonBody(c)));
  app.put("/attendance/:id", async (c) => c.json(await parseApiRequest(c, "API-08")));
  app.onError(onError);

  it("errors_use_the_documented_envelope_and_hide_internals", async () => {
    const boom = await app.request("/boom");
    const text = await boom.text();
    expect(boom.status).toBe(500);
    expect(text).not.toContain("SQLITE");
    expect(ErrorEnvelope.safeParse(JSON.parse(text)).success).toBe(true);

    const conflict = await app.request("/conflict");
    expect(conflict.status).toBe(409);
    expect((await conflict.json() as { error: { code: string } }).error.code).toBe("VERSION_CONFLICT");
  });

  it("json_body_over_256kib_or_invalid_json_is_400", async () => {
    const big = await app.request("/echo", { method: "POST", body: JSON.stringify({ a: "x".repeat(LIMITS.jsonBytesMax) }) });
    expect(big.status).toBe(400);
    const bad = await app.request("/echo", { method: "POST", body: "{not json" });
    expect(bad.status).toBe(400);
    const good = await app.request("/echo", { method: "POST", body: JSON.stringify({ a: 1 }) });
    expect(good.status).toBe(200);
  });

  it("parseApiRequest_validates_params_body_and_headers", async () => {
    const json = { "content-type": "application/json" };
    const body = JSON.stringify({ version: 0, response: "attending" });
    const okRes = await app.request(`/attendance/${ID}`, { method: "PUT", headers: { ...json, "idempotency-key": "k1" }, body });
    expect(okRes.status).toBe(200);
    const noKey = await app.request(`/attendance/${ID}`, { method: "PUT", headers: json, body });
    expect(noKey.status).toBe(400);
    const badId = await app.request(`/attendance/not-a-uuid`, { method: "PUT", headers: { ...json, "idempotency-key": "k1" }, body });
    expect(badId.status).toBe(400);
    // 本文があるのにJSONでない（text/plain等のCSRF的な送信）
    const noType = await app.request(`/attendance/${ID}`, { method: "PUT", headers: { "idempotency-key": "k1" }, body });
    expect(noType.status).toBe(400);
    // 契約に無いqueryは無視せず拒否
    const extraQuery = await app.request(`/attendance/${ID}?admin=1`, { method: "PUT", headers: { ...json, "idempotency-key": "k1" }, body });
    expect(extraQuery.status).toBe(400);
  });

  it("content_type_must_be_exactly_json_and_binary_bodies_are_left_to_the_handler", async () => {
    const body = JSON.stringify({ version: 0, response: "attending" });
    const put = (type: string) =>
      app.request(`/attendance/${ID}`, { method: "PUT", headers: { "content-type": type, "idempotency-key": "k" }, body });
    expect((await put("application/json; charset=utf-8")).status).toBe(200);
    expect((await put("APPLICATION/JSON")).status).toBe(200);
    expect((await put("application/jsonx")).status).toBe(400);
    expect((await put("text/plain")).status).toBe(400);
    // バイナリ(API-83)は本文を契約で読まず、ハンドラが読めるように残す
    const bin = new Hono<AppBindings>();
    bin.use("*", async (c, next) => { c.set("requestId", "r"); await next(); });
    bin.put("/attachments/:id/upload", async (c) => {
      await parseApiRequest(c, "API-83");
      return c.json({ size: (await c.req.arrayBuffer()).byteLength });
    });
    bin.onError(onError);
    const upload = await bin.request(`/attachments/${ID}/upload`, {
      method: "PUT", headers: { "x-upload-token": "t", "content-type": "image/jpeg" }, body: new Uint8Array(1000),
    });
    expect(upload.status).toBe(200);
    expect(((await upload.json()) as { size: number }).size).toBe(1000);
  });

  it("requests_without_query_contract_reject_unknown_query", async () => {
    // 本文の契約が無いAPIはGETだけ(fetchの仕様でGETは本文を持てない)なので、ここではqueryの拒否を確かめる
    const getApp = new Hono<AppBindings>();
    getApp.use("*", async (c, next) => { c.set("requestId", "r"); await next(); });
    getApp.get("/jobs/:id", async (c) => c.json(await parseApiRequest(c, "API-86")));
    getApp.onError(onError);
    expect((await getApp.request(`/jobs/${ID}`)).status).toBe(200);
    expect((await getApp.request(`/jobs/${ID}?foo=1`)).status).toBe(400);
  });

  it("chunked_body_without_content_length_is_cut_at_the_limit", async () => {
    let sent = 0;
    const chunk = new TextEncoder().encode("x".repeat(64 * 1024));
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        // 上限(256KiB)を大きく超える量を流す。途中で打ち切られれば全部は読まれない
        if (sent >= 64) return controller.close();
        sent++;
        controller.enqueue(chunk);
      },
    });
    const res = await app.request("/echo", { method: "POST", body: stream, duplex: "half" } as RequestInit);
    expect(res.status).toBe(400);
    expect(sent).toBeLessThan(64);
  });
});
