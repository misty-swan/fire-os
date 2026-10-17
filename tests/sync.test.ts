import { env } from "cloudflare:workers";
import { applyD1Migrations } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import { createFixture, type Identity, type TestFixture } from "./helpers/fixture";
import { canonicalJson, sha256Hex } from "../src/server/mutations/hash";

/**
 * 保留操作の同期（T076、docs/05 §2・API-81/82、docs/07 端末保持、docs/10 PER-13「オフライン操作も再認可」）。
 * 同期は元APIの認可・版・冪等・状態を省略せず、応答消失後の同キー再送は一回だけ成立して同じ結果を返す。
 */
let fx: TestFixture;
beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
  fx = await createFixture("two-units");
});

const idem = () => ({ "idempotency-key": crypto.randomUUID() });
const json = async (r: Response) =>
  (await r.json()) as {
    data?: Record<string, unknown>;
    error?: { code: string; details?: { field: string; reason: string }[] };
  };

interface SyncCommandBody {
  clientOperationId: string;
  deviceId: string;
  operationCode: string;
  targetId: string;
  baseVersion: number;
  payload: Record<string, unknown>;
  payloadHash: string;
}

/** 端末が下書きから組み立てて送るSyncCommand（docs/07: clientOperationId/baseVersion/payloadHash）。 */
const syncCmd = async (
  cmd: { operationCode: string; targetId: string; baseVersion: number; payload: Record<string, unknown> },
  ids: { clientOperationId?: string; deviceId?: string } = {},
): Promise<SyncCommandBody> => ({
  clientOperationId: ids.clientOperationId ?? crypto.randomUUID(),
  deviceId: ids.deviceId ?? crypto.randomUUID(),
  operationCode: cmd.operationCode,
  targetId: cmd.targetId,
  baseVersion: cmd.baseVersion,
  payload: cmd.payload,
  payloadHash: await sha256Hex(canonicalJson(cmd.payload)),
});

/** API-81の送信。Idempotency-KeyはclientOperationIdと同値（1操作1鍵。docs/05 §2）。 */
const postSync = (who: Identity, cmd: SyncCommandBody) =>
  fx.client(who).request("POST", "/api/v1/sync/commands", cmd, { "idempotency-key": cmd.clientOperationId });

/** 業務効果の証跡: 出欠の履歴行数（再送で増えないことの数え上げ。CT-04「重複効果0」） */
const effectsOf = async (activityId: string) =>
  (
    await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM attendance_events e JOIN activity_attendance a ON a.id = e.attendance_id WHERE a.activity_id = ?",
    ).bind(activityId).first<{ n: number }>()
  )!.n;

/** 対象者付きの予定を作成して公開（docs/11 出欠は「受付中のみ」。T036の経路） */
async function seedPublishedActivity(admin: Identity, audienceIds: string[]): Promise<string> {
  const res = await fx.client(admin).request("POST", "/api/v1/activities", {
    title: "秋季の水防訓練",
    kind: "訓練",
    plannedStartsAt: "2099-10-20T01:00:00.000Z",
    locationText: "架空市堤防",
    ownerMemberId: admin.memberId!,
    audienceMemberIds: audienceIds,
    responseDueAt: "2098-01-01T00:00:00.000Z",
  }, idem());
  expect(res.status).toBe(201);
  const id = ((await json(res)).data! as { id: string }).id;
  expect((await fx.client(admin).request("PATCH", `/api/v1/activities/${id}`, {
    version: 1, status: "scheduled", reason: "対象を確定して公開",
  }, idem())).status).toBe(200);
  return id;
}

/** 承認済みの施設点検様式（T027の経路。点検同期の前提） */
async function seedFacilityTemplate(admin: Identity): Promise<string> {
  const schema = [
    { code: "exterior", label: "本体の外観", valueType: "select", required: true, allowedResults: ["ok", "needs_review"] },
  ];
  const res = await fx.client(admin).request("POST", "/api/v1/inspection-templates", {
    name: `施設様式${crypto.randomUUID().slice(0, 6)}`, targetType: "facility", itemSchema: schema,
  }, idem());
  const data = ((await res.json()) as { data?: { id: string; versions: { id: string }[] } }).data;
  if (!data) throw new Error(`template create failed: ${res.status}`);
  const versionId = data.versions[0]!.id;
  await fx.client(admin).request("POST", `/api/v1/inspection-templates/${data.id}/decision`, { version: 1, templateVersionId: versionId, decision: "request_review", reason: "確認" }, idem());
  const done = await json(await fx.client(admin).request("POST", `/api/v1/inspection-templates/${data.id}/decision`, { version: 2, templateVersionId: versionId, decision: "approve", reason: "確認した" }, idem()));
  if (!done.data) throw new Error("approve failed");
  return versionId;
}

async function seedFacility(unitId: string, by: string, explicitId?: string): Promise<string> {
  const id = explicitId ?? crypto.randomUUID();
  const now = new Date().toISOString();
  await env.DB.prepare(
    "INSERT INTO facilities (id, unit_id, type, management_number, latitude, longitude, location_note, location_source, created_at, updated_at, created_by, actor_kind) VALUES (?, ?, 'hydrant', ?, 35, 139, 'x', '架空台帳', ?, ?, ?, 'human')",
  ).bind(id, unitId, `F-${id.slice(0, 6)}`, now, now, by).run();
  return id;
}

const inspectionPayload = (versionId: string, inspector: string, over: Record<string, unknown> = {}) => ({
  templateVersionId: versionId,
  inspectedAt: "2026-10-14T02:00:00.000Z",
  inspectorMemberId: inspector,
  result: "ok",
  checkItems: [{ code: "exterior", result: "ok" }],
  note: "同期試験の点検記録",
  createIssue: false,
  attachmentIds: [],
  ...over,
});

/** 検査jobをまだ走らせていない（=ready前）の添付を作る（T029の経路。転送と完了のみ） */
async function makeUnreadyAttachment(who: Identity): Promise<string> {
  const dRes = await fx.client(who).request("POST", "/api/v1/attachment-drafts", { intendedEntityType: "inspection" }, idem());
  const draft = (await json(dRes)).data! as { id: string };
  const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]); // 中身の検査はT016。ここでは未検査であることだけが必要
  const iRes = await fx.client(who).request(
    "POST", "/api/v1/attachments/upload-intents",
    { target: { type: "attachment_draft", id: draft.id }, contentType: "image/png", byteSize: bytes.byteLength }, idem(),
  );
  const intent = (await json(iRes)).data! as { id: string; uploadToken: string };
  const up = await fx.raw(who)(new Request(`http://example.com/api/v1/attachments/${intent.id}/upload`, {
    method: "PUT", headers: { "content-type": "application/octet-stream", "x-upload-token": intent.uploadToken }, body: bytes as BufferSource,
  }));
  const attempt = (await json(up)).data! as { id: string; sha256: string };
  await fx.client(who).request("POST", `/api/v1/attachments/${intent.id}/completion`, { version: 1, uploadAttemptId: attempt.id, sha256: attempt.sha256 }, idem());
  return intent.id;
}

describe("保留操作の同期 (T076)", () => {
  it("sync_replay_after_lost_response_has_one_effect_and_same_result", async () => {
    const a = fx.units.a;
    const admin = a.people.admin; // 管理者（点検の保存 PER-04、同期の接続 PER-13）
    const member = a.people.member; // 一般団員（本人出欠の同期。PER-02は本人）
    const officer = a.people.officer; // 他user照会に使う（PER-13は全役割だが本人以外は404）
    const operator = a.people.operator; // 停止後再接続に使う

    const activityId = await seedPublishedActivity(admin, [member.memberId!, operator.memberId!]);
    const templateVersionId = await seedFacilityTemplate(admin);
    const facilityId = await seedFacility(a.id, admin.userId);

    // --- 本人出欠の同期操作（初回。docs/05 API-81） ---
    const cmd = await syncCmd({ operationCode: "attendance.respond", targetId: activityId, baseVersion: 0, payload: { response: "attending" } });
    const first = await postSync(member, cmd);
    expect(first.status).toBe(200);
    const applied = (await json(first)).data! as { id: string; status: string };
    expect(applied.status).toBe("applied");
    const appliedEffects = await effectsOf(activityId);
    expect(appliedEffects).toBe(1);

    // --- 応答消失後の同キー同本文再送: 元の結果を返し、業務効果は増えない（docs/07「適用済operationの再送は同結果」） ---
    const replay = await postSync(member, cmd);
    expect(replay.status).toBe(200);
    expect((await json(replay)).data).toEqual(applied as unknown as Record<string, unknown>);
    expect(await effectsOf(activityId)).toBe(1);
    // 台帳は1行。結果照会（API-82）は本人だけに見える
    expect(await fx.rows("sync_operations", { id: applied.id })).toHaveLength(1);
    const own = await fx.client(member).request("GET", `/api/v1/sync/operations/${applied.id}`);
    expect(own.status).toBe(200);
    expect((await json(own)).data).toEqual(applied as unknown as Record<string, unknown>);
    const others = await fx.client(officer).request("GET", `/api/v1/sync/operations/${applied.id}`);
    expect(others.status).toBe(404); // 他人の操作は存在も明かさない（docs/05 API-82「本人」）

    // --- 同キー別本文（payloadだけ変えた再送）は409 IDEMPOTENCY_MISMATCH。効果は増えない（docs/05 §1） ---
    const changedPayloadCmd = { ...cmd, payload: { response: "absent" }, payloadHash: await sha256Hex(canonicalJson({ response: "absent" })) };
    const changedPayload = await postSync(member, changedPayloadCmd);
    expect(changedPayload.status).toBe(409);
    expect((await json(changedPayload)).error?.code).toBe("IDEMPOTENCY_MISMATCH");
    expect(await effectsOf(activityId)).toBe(1);

    // --- 旧baseVersionの新しい操作は409 VERSION_CONFLICT。失敗した操作は台帳に残らない ---
    const staleCmd = await syncCmd({ operationCode: "attendance.respond", targetId: activityId, baseVersion: 0, payload: { response: "undecided" } });
    const staleBase = await postSync(member, staleCmd);
    expect(staleBase.status).toBe(409);
    expect((await json(staleBase)).error?.code).toBe("VERSION_CONFLICT");
    expect(await effectsOf(activityId)).toBe(1);
    expect(await fx.rows("sync_operations", { client_operation_id: staleCmd.clientOperationId })).toHaveLength(0);

    // --- ready前の写真: 点検保存の同期は元APIと同じ422で、点検も台帳も増えない（T029の検査を同期が引き継ぐ） ---
    const unreadyId = await makeUnreadyAttachment(admin);
    const inspectionsBefore = (await env.DB.prepare("SELECT COUNT(*) AS n FROM facility_inspections").first<{ n: number }>())!.n;
    const photoCmd = await syncCmd({
      operationCode: "facility_inspection.create", targetId: facilityId, baseVersion: 0,
      payload: inspectionPayload(templateVersionId, admin.memberId!, { attachmentIds: [unreadyId] }),
    });
    const unready = await postSync(admin, photoCmd);
    expect(unready.status).toBe(422);
    expect((await json(unready)).error?.code).toBe("ATTACHMENT_NOT_READY");
    expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM facility_inspections").first<{ n: number }>())!.n).toBe(inspectionsBefore);
    expect(await fx.rows("sync_operations", { client_operation_id: photoCmd.clientOperationId })).toHaveLength(0);

    // --- 停止後再接続: 停止した利用者の保留操作は再認証・再認可で拒否され、適用されない（docs/10 PER-13） ---
    const pendingCmd = await syncCmd({ operationCode: "attendance.respond", targetId: activityId, baseVersion: 0, payload: { response: "attending" } });
    await env.DB.prepare("UPDATE users SET status = 'disabled', disabled_at = ?, updated_at = ? WHERE id = ?")
      .bind(new Date().toISOString(), new Date().toISOString(), operator.userId).run();
    const afterDisableRes = await postSync(operator, pendingCmd);
    expect(afterDisableRes.status).toBe(401);
    const operatorRows = await fx.rows("activity_attendance", { activity_id: activityId, member_id: operator.memberId! });
    const afterDisableApplied = operatorRows.some((r) => r.response === "attending");
    expect(afterDisableApplied).toBe(false);
    expect(await fx.rows("sync_operations", { client_operation_id: pendingCmd.clientOperationId })).toHaveLength(0);

    // --- allowlist外のoperationCodeは400（同期経路で任意の操作を呼べない。Object.prototypeの鍵も外側） ---
    const unknownCmd = await syncCmd({ operationCode: "activity.create", targetId: activityId, baseVersion: 0, payload: { title: "x" } });
    const unknownOperationCode = await postSync(member, unknownCmd);
    expect(unknownOperationCode.status).toBe(400);
    const protoKey = await postSync(member, await syncCmd({ operationCode: "toString", targetId: activityId, baseVersion: 0, payload: {} }));
    expect(protoKey.status).toBe(400);

    // --- briefの結果（名称どおりに断言） ---
    expect(appliedEffects).toBe(1);
    expect(changedPayload.status).toBe(409);
    expect(staleBase.status).toBe(409);
    expect(afterDisableApplied).toBe(false);
    expect(unknownOperationCode.status).toBe(400);
  });

  it("sync_reuses_original_handler_authorization_for_inspection_correction_and_mobilization", async () => {
    const a = fx.units.a;
    const admin = a.people.admin;
    const member = a.people.member; // 参集の本人記録（PER-04の本人分）
    const operator = a.people.operator; // scopeInの施設にPER-04の担当を持つ（docs/10 PER-04「担当者は担当対象」）

    const templateVersionId = await seedFacilityTemplate(admin);
    // 担当scopeの対象（scopeIn）を実施設計として作る（fixtureのscopeはIDだけなので、点検の対象行が要る）
    await seedFacility(a.id, admin.userId, a.scopeIn.entityId);
    // 1件目の試験で停止したoperatorを戻す（fixtureは同じファイル内で共有。docs/04「退団時…」ではなく試験の前提回復）
    await env.DB.prepare("UPDATE users SET status = 'active', disabled_at = NULL, updated_at = ? WHERE id = ?")
      .bind(new Date().toISOString(), operator.userId).run();

    // --- 担当scope内の点検保存は元APIと同じPER-04判定で通る ---
    const saveCmd = await syncCmd({
      operationCode: "facility_inspection.create", targetId: a.scopeIn.entityId, baseVersion: 0,
      payload: inspectionPayload(templateVersionId, operator.memberId!, { note: "通信断中の点検記録" }),
    });
    const saved = await postSync(operator, saveCmd);
    expect(saved.status).toBe(200);
    const savedData = (await json(saved)).data! as { id: string; status: string };
    expect(savedData.status).toBe("applied");
    const savedRow = (await fx.rows("facility_inspections", { facility_id: a.scopeIn.entityId }))[0]!;
    expect(savedRow.note).toBe("通信断中の点検記録");
    // 同キー再送は同じ結果で、点検は増えない
    const savedReplay = await postSync(operator, saveCmd);
    expect((await json(savedReplay)).data).toEqual(savedData as unknown as Record<string, unknown>);
    expect(await fx.rows("facility_inspections", { facility_id: a.scopeIn.entityId })).toHaveLength(1);

    // --- 点検の訂正の同期（docs/05 API-46と同じ契約検査・series版ガード。payloadのseriesVersionで競合を検出） ---
    const correctionCmd = await syncCmd({
      operationCode: "inspection.correction", targetId: savedRow.id as string, baseVersion: 0,
      payload: { type: "facility", seriesVersion: 2, reason: "数値の誤り訂正", ...inspectionPayload(templateVersionId, operator.memberId!, { note: "訂正後の記録" }) },
    });
    const corrected = await postSync(operator, correctionCmd);
    expect(corrected.status).toBe(200);
    const series = (await fx.rows("inspection_series", { facility_id: a.scopeIn.entityId }))[0]!;
    expect(series.version).toBe(3); // 保存(2)→訂正(3)
    expect(series.current_facility_inspection_id).not.toBe(savedRow.id);
    expect(await fx.rows("facility_inspections", { series_id: series.id as string })).toHaveLength(2); // 原本+訂正（一本の履歴）

    // --- 参集の同期（出動への本人記録。docs/05 API-23と同じ状態前提を同期時に検査） ---
    const incRes = await fx.client(admin).request("POST", "/api/v1/incidents", {
      kind: "training", occurredAt: "2026-10-14T02:00:00.000Z", summary: "墜落警報訓練（架空）",
    }, idem());
    expect(incRes.status).toBe(201);
    const incidentId = ((await json(incRes)).data! as { id: string }).id;
    const mobCmd = await syncCmd({
      operationCode: "incident.participant.record", targetId: incidentId, baseVersion: 0,
      payload: { attendanceStatus: "mobilizing", times: { mobilizedAt: "2026-10-14T02:05:00.000Z" } },
    });
    const mobilized = await postSync(member, mobCmd);
    expect(mobilized.status).toBe(200);
    const participantRow = (await fx.rows("incident_participants", { incident_id: incidentId }))[0]!;
    expect(participantRow.attendance_status).toBe("mobilizing");
    expect(await fx.rows("incident_participant_events", { participant_id: participantRow.id as string })).toHaveLength(1);
    const mobReplay = await postSync(member, mobCmd);
    expect((await json(mobReplay)).data).toEqual((await json(mobilized)).data as unknown as Record<string, unknown>);
    expect(await fx.rows("incident_participant_events", { participant_id: participantRow.id as string })).toHaveLength(1); // 効果は1件

    // --- 担当scopeの取消後の同期は再認可で403。点検は増えない（失権した同期の拒否。AT-DSP-05） ---
    await env.DB.prepare("DELETE FROM scope_assignments WHERE member_id = ?").bind(operator.memberId).run();
    const inspectionsBefore = (await env.DB.prepare("SELECT COUNT(*) AS n FROM facility_inspections").first<{ n: number }>())!.n;
    const revokedCmd = await syncCmd({
      operationCode: "facility_inspection.create", targetId: a.scopeIn.entityId, baseVersion: 0,
      payload: inspectionPayload(templateVersionId, operator.memberId!, { note: "失権後の点検" }),
    });
    const revoked = await postSync(operator, revokedCmd);
    expect(revoked.status).toBe(403);
    expect((await json(revoked)).error?.code).toBe("FORBIDDEN");
    expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM facility_inspections").first<{ n: number }>())!.n).toBe(inspectionsBefore);
    expect(await fx.rows("sync_operations", { client_operation_id: revokedCmd.clientOperationId })).toHaveLength(0);
  });

  it("sync_command_shares_the_original_api_idempotency_key_without_double_effect", async () => {
    const admin = fx.units.a.people.admin;
    const member = fx.units.a.people.member;

    const activityId = await seedPublishedActivity(admin, [member.memberId!]);

    // 直接APIで先に実行（Idempotency-Key=K。docs/05 §2の元APIの鍵）
    const key = crypto.randomUUID();
    const direct = await fx.client(member).request("PUT", `/api/v1/activities/${activityId}/attendance/me`, { version: 0, response: "attending" }, { "idempotency-key": key });
    expect(direct.status).toBe(201);

    // 同じ鍵をclientOperationIdとして同期に載せる → 再実行せず台帳だけが埋まる（元API/同requestHash。docs/05 API-81行）
    const cmd = await syncCmd(
      { operationCode: "attendance.respond", targetId: activityId, baseVersion: 0, payload: { response: "attending" } },
      { clientOperationId: key },
    );
    const viaSync = await postSync(member, cmd);
    expect(viaSync.status).toBe(200);
    const viaSyncData = (await json(viaSync)).data! as { id: string; status: string };
    expect(viaSyncData.status).toBe("applied");
    expect(await fx.rows("sync_operations", { client_operation_id: key })).toHaveLength(1);
    expect(await effectsOf(activityId)).toBe(1); // 二重効果なし

    // 以降の再送は台帳の結果を返す
    const again = await postSync(member, cmd);
    expect((await json(again)).data).toEqual(viaSyncData as unknown as Record<string, unknown>);
    expect(await effectsOf(activityId)).toBe(1);
  });

  it("sync_routes_require_per13_at_entry_so_role_stripped_caller_is_403", async () => {
    const a = fx.units.a;
    const admin = a.people.admin;
    const member = a.people.member; // 役割を外す主体（PER-13は全役割。役割が無ければ拒否になる）

    const activityId = await seedPublishedActivity(admin, [member.memberId!]);

    // 役割を外す前に適用済みの操作を作る（照会・再送の対象。docs/05 API-81/82）
    const cmd = await syncCmd({ operationCode: "attendance.respond", targetId: activityId, baseVersion: 0, payload: { response: "attending" } });
    const first = await postSync(member, cmd);
    expect(first.status).toBe(200);
    const applied = (await json(first)).data! as { id: string; status: string };
    expect(await effectsOf(activityId)).toBe(1);

    // 役割を全て失効させる（resolvePrincipalは毎要求D1から有効な役割だけ引く。tests/revocation.test.tsと同じ直接更新）
    await env.DB.prepare("UPDATE member_roles SET revoked_at = ? WHERE member_id = ? AND revoked_at IS NULL")
      .bind("2026-10-13T01:00:00.000Z", member.memberId).run();

    // --- API-82: 本人のoperation照会でもPER-13が無ければ403（経路入口で拒否。docs/05 API-82「PER-13本人」） ---
    const query = await fx.client(member).request("GET", `/api/v1/sync/operations/${applied.id}`);
    expect(query.status).toBe(403);

    // --- API-81: 適用済みの同キー再送（台帳で解決される経路。元操作の再検査を通らない）も入口のPER-13で403
    // （docs/05 API-81「PER-13＋元操作」。再送でも「現在の認可は再検査」。docs/05 §2） ---
    const replay = await postSync(member, cmd);
    expect(replay.status).toBe(403);
    expect((await json(replay)).error?.code).toBe("FORBIDDEN");
    expect(await effectsOf(activityId)).toBe(1);

    // --- 新規の操作も拒否され、業務効果も台帳も増えない（docs/10 PER-13「オフライン操作も再認可」） ---
    const freshCmd = await syncCmd({ operationCode: "attendance.respond", targetId: activityId, baseVersion: 0, payload: { response: "undecided" } });
    const fresh = await postSync(member, freshCmd);
    expect(fresh.status).toBe(403);
    expect(await effectsOf(activityId)).toBe(1);
    expect(await fx.rows("sync_operations", { client_operation_id: freshCmd.clientOperationId })).toHaveLength(0);

    // 後片付け（fixtureは同じファイルの試験で共有。役割を戻すと本人照会は通る）
    await env.DB.prepare("UPDATE member_roles SET revoked_at = NULL WHERE member_id = ?").bind(member.memberId).run();
    const restored = await fx.client(member).request("GET", `/api/v1/sync/operations/${applied.id}`);
    expect(restored.status).toBe(200);
  });
});
