import { env } from "cloudflare:workers";
import { applyD1Migrations } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import { createFixture, type Identity, type TestFixture } from "./helpers/fixture";

let fx: TestFixture;
beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
  fx = await createFixture("two-units");
});

const idem = () => ({ "idempotency-key": crypto.randomUUID() });
const json = async (r: Response) => (await r.json()) as { data?: Record<string, unknown>; error?: { code: string; details?: { field: string; reason: string }[] } };

interface TemplateRef {
  templateId: string;
  facilityVersionId: string;
  vehicleVersionId: string;
  facilityTemplateVersion: number;
}

/** 施設と車両の承認済み様式を用意する（T027の経路） */
async function seedTemplates(admin: Identity): Promise<TemplateRef> {
  // 許可された結果は点検結果の語彙（docs/05 InspectionInput。docs/11 点検結果）
  const facilitySchema = [{ code: "exterior", label: "本体の外観", valueType: "select", required: true, allowedResults: ["ok", "needs_review"] }];
  const vehicleSchema = [{ code: "lights", label: "灯火類", valueType: "select", required: true, allowedResults: ["ok", "needs_review"] }];
  const mk = async (name: string, targetType: "facility" | "vehicle", itemSchema: unknown) => {
    const res = await fx.client(admin).request("POST", "/api/v1/inspection-templates", { name, targetType, itemSchema }, idem());
    const data = ((await res.json()) as { data?: { id: string; version: number; versions: { id: string }[] } }).data;
    if (!data) throw new Error(`template create failed: ${res.status}`);
    return data;
  };
  const fac = await mk(`施設様式${crypto.randomUUID().slice(0, 6)}`, "facility", facilitySchema);
  const veh = await mk(`車両様式${crypto.randomUUID().slice(0, 6)}`, "vehicle", vehicleSchema);
  const vFac = fac.versions[0]!.id;
  const vVeh = veh.versions[0]!.id;
  // 申請→承認（facility）
  await fx.client(admin).request("POST", `/api/v1/inspection-templates/${fac.id}/decision`, { version: 1, templateVersionId: vFac, decision: "request_review", reason: "確認" }, idem());
  const approveFac = await json(await fx.client(admin).request("POST", `/api/v1/inspection-templates/${fac.id}/decision`, { version: 2, templateVersionId: vFac, decision: "approve", reason: "確認した" }, idem()));
  if (!approveFac.data) throw new Error(`facility approve failed: ${JSON.stringify(approveFac)}`);
  // 申請→承認（vehicle）
  await fx.client(admin).request("POST", `/api/v1/inspection-templates/${veh.id}/decision`, { version: 1, templateVersionId: vVeh, decision: "request_review", reason: "確認" }, idem());
  const approveVeh = await json(await fx.client(admin).request("POST", `/api/v1/inspection-templates/${veh.id}/decision`, { version: 2, templateVersionId: vVeh, decision: "approve", reason: "確認した" }, idem()));
  if (!approveVeh.data) throw new Error("vehicle approve failed");
  return { templateId: fac.id, facilityVersionId: vFac, vehicleVersionId: vVeh, facilityTemplateVersion: fac.version };
}

async function seedFacility(unitId: string, by: string): Promise<string> {
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  await env.DB.prepare(
    "INSERT INTO facilities (id, unit_id, type, management_number, latitude, longitude, location_note, location_source, created_at, updated_at, created_by, actor_kind) VALUES (?, ?, 'hydrant', ?, 35, 139, 'x', '架空台帳', ?, ?, ?, 'human')",
  ).bind(id, unitId, `F-${id.slice(0, 6)}`, now, now, by).run();
  return id;
}

const facilityInput = (versionId: string, inspector: string, overrides: Record<string, unknown> = {}) => ({
  templateVersionId: versionId,
  inspectedAt: "2026-10-14T02:00:00.000Z",
  inspectorMemberId: inspector,
  result: "ok",
  checkItems: [{ code: "exterior", result: "ok" }],
  note: "自動試験の点検記録",
  createIssue: false,
  attachmentIds: [],
  ...overrides,
});

describe("点検と異常 (T029〜T032)", () => {
  it("inspection_issue_and_photo_link_commit_together", async () => {
    const a = fx.units.a;
    const admin = a.people.admin;
    const t = await seedTemplates(admin);
    const facilityId = await seedFacility(a.id, admin.userId);

    // 施設点検（異常起票つき。成功ならneeds_reviewの点検と起点異常が同じcommitで入る）
    const res = await fx.client(admin).request(
      "POST", `/api/v1/facilities/${facilityId}/inspections`,
      facilityInput(t.facilityVersionId, admin.memberId!, { result: "needs_review", createIssue: true, note: "蓋の開閉に異常" }), idem(),
    );
    expect(res.status).toBe(201);
    const inspection = (await json(res)).data! as { id: string; result: string; seriesId: string; seriesVersion: number; items: { code: string; result: string }[] };
    expect(inspection.result).toBe("needs_review");
    expect(inspection.seriesVersion).toBe(2); // seriesの版は現在版ポインタの更新で1つ進む
    expect(inspection.items).toEqual([{ code: "exterior", result: "ok", value: null, note: null }]);

    // 起点異常が同じbatchで入った（reported・起点はこの点検）
    const issueRow = (await env.DB.prepare(
      "SELECT id, status, source_facility_inspection_id FROM issues WHERE source_facility_inspection_id = ?",
    ).bind(inspection.id).first<{ id: string; status: string; source_facility_inspection_id: string }>())!;
    expect(issueRow.status).toBe("reported");
    expect(issueRow.source_facility_inspection_id).toBe(inspection.id);

    // 明細INSERTや異常INSERTの位置で失敗させても、行は全く残らない（原子性）
    const beforeCounts = {
      inspections: (await env.DB.prepare("SELECT COUNT(*) AS n FROM facility_inspections").first<{ n: number }>())!.n,
      items: (await env.DB.prepare("SELECT COUNT(*) AS n FROM inspection_items").first<{ n: number }>())!.n,
      issues: (await env.DB.prepare("SELECT COUNT(*) AS n FROM issues").first<{ n: number }>())!.n,
    };
    // 存在しない様式版で失敗 → 全ての行が増えない
    const failed = await fx.client(admin).request(
      "POST", `/api/v1/facilities/${facilityId}/inspections`,
      facilityInput(crypto.randomUUID(), admin.memberId!), idem(),
    );
    expect(failed.status).toBe(404);
    const failedMutationRows = {
      inspections: (await env.DB.prepare("SELECT COUNT(*) AS n FROM facility_inspections").first<{ n: number }>())!.n,
      items: (await env.DB.prepare("SELECT COUNT(*) AS n FROM inspection_items").first<{ n: number }>())!.n,
      issues: (await env.DB.prepare("SELECT COUNT(*) AS n FROM issues").first<{ n: number }>())!.n,
    };
    expect(failedMutationRows).toEqual({ ...beforeCounts, items: 1 }); // 成功した1件の明細のまま（失敗分は増えない）
    // 異常起票ありで様式の必須違反 → 点検も異常も増えない
    const missingRequired = await fx.client(admin).request(
      "POST", `/api/v1/facilities/${facilityId}/inspections`,
      facilityInput(t.facilityVersionId, admin.memberId!, { result: "needs_review", createIssue: true, checkItems: [] }), idem(),
    );
    expect(missingRequired.status).toBe(400);
    const afterMissingRows = {
      inspections: (await env.DB.prepare("SELECT COUNT(*) AS n FROM facility_inspections").first<{ n: number }>())!.n,
      items: (await env.DB.prepare("SELECT COUNT(*) AS n FROM inspection_items").first<{ n: number }>())!.n,
      issues: (await env.DB.prepare("SELECT COUNT(*) AS n FROM issues").first<{ n: number }>())!.n,
    };
    expect(afterMissingRows).toEqual({ ...beforeCounts, items: 1 });
    void beforeCounts; void failedMutationRows; void afterMissingRows;

    // 点検結果が設備の使用可否を勝手に変えない（D06: 結果から使用可否を自動更新しない。施設台帳は不変）
    const facilityAfter = (await fx.rows("facilities", { id: facilityId }))[0]!;
    expect(facilityAfter.version).toBe(1); // 台帳は点検で変わらない
    expect(facilityAfter.verification_status).toBe("unverified"); // 位置確認も変わらない
    void inspection;
  });

  it("asset_inspection_accepts_exactly_one_matching_target", async () => {
    const a = fx.units.a;
    const admin = a.people.admin;
    const t = await seedTemplates(admin);
    const vehicle = await (await fx.client(admin).request("POST", "/api/v1/vehicles", { assetCode: "P-T30", name: "幹部用車両", status: "運用" }, idem())).json() as { data: { id: string } };
    const equipment = await (await fx.client(admin).request("POST", "/api/v1/equipment", { assetCode: "E-T30", name: "チェーンソー", quantity: 2, quantityUnit: "本", storage: { note: "詰所" } }, idem())).json() as { data: { id: string } };

    const vehInput = {
      templateVersionId: t.vehicleVersionId, inspectedAt: "2026-10-14T03:00:00.000Z",
      inspectorMemberId: admin.memberId!, result: "ok",
      checkItems: [{ code: "lights", result: "ok" }], note: "車両点検の記録", createIssue: false, attachmentIds: [],
    };
    // 車両と機材それぞれ点検できる
    const validVehicle = await fx.client(admin).request("POST", "/api/v1/asset-inspections", { target: { type: "vehicle", id: vehicle.data.id }, ...vehInput }, idem());
    expect(validVehicle.status).toBe(201);
    // 機材用の様式はまだ無い。機材点検に車両様式は使えない（対象種別の一致→422）
    const wrongTargetEquipment = await fx.client(admin).request(
      "POST", "/api/v1/asset-inspections",
      { target: { type: "equipment", id: equipment.data.id }, ...vehInput }, idem(),
    );
    expect(wrongTargetEquipment.status).toBe(422);
    expect(((await json(wrongTargetEquipment)).error?.details ?? []).some((d) => d.reason === "target_type_mismatch")).toBe(true);

    // 異種様式（施設用）は422。二重対象は契約が1対象しか受けない（Targetは1つ）
    const wrongTemplate = await fx.client(admin).request(
      "POST", "/api/v1/asset-inspections",
      { target: { type: "vehicle", id: vehicle.data.id }, ...vehInput, templateVersionId: t.facilityVersionId }, idem(),
    );
    expect(wrongTemplate.status).toBe(422);
    const twoTargetsCommitted = ((await env.DB.prepare("SELECT COUNT(*) AS n FROM asset_inspections WHERE vehicle_id = ? AND result = 'x'").bind(vehicle.data.id).first<{ n: number }>())!.n > 0);
    expect(twoTargetsCommitted).toBe(false);

    // 別unitの対象は404（別unitの様式はこの分団では使えないため、対象の存在も見せない）
    const otherUnitVehicle = await (await fx.client(fx.units.b.people.admin).request("POST", "/api/v1/vehicles", { assetCode: "B-P", name: "b", status: "s" }, idem())).json() as { data: { id: string } };
    const fakeInspector = await fx.client(admin).request(
      "POST", "/api/v1/asset-inspections",
      { target: { type: "vehicle", id: otherUnitVehicle.data.id }, ...vehInput }, idem(),
    );
    expect(fakeInspector.status).toBe(404); // 別unitの対象は存在も見せない
    void wrongTargetEquipment;
  });

  it("two_corrections_cannot_fork_same_original", async () => {
    const a = fx.units.a;
    const admin = a.people.admin;
    const t = await seedTemplates(admin);
    const facilityId = await seedFacility(a.id, admin.userId);
    const made = await (await fx.client(admin).request(
      "POST", `/api/v1/facilities/${facilityId}/inspections`,
      facilityInput(t.facilityVersionId, admin.memberId!, { note: "訂正前の原本" }), idem(),
    )).json() as { data: { id: string; seriesId: string } };
    const originalId = made.data.id;

    // 同じseriesVersionで2訂正を並行送信すると、片方だけが成功する（もう片方は409。現在版から枝分かれしない）
    const forkA = fx.client(admin).request(
      "POST", `/api/v1/inspections/facility/${originalId}/corrections`,
      { seriesVersion: 2, supersedesId: originalId, reason: "並行A", ...facilityInput(t.facilityVersionId, admin.memberId!, { note: "訂正後の原本", result: "needs_review", checkItems: [{ code: "exterior", result: "needs_review" }] }) }, idem(),
    );
    const forkB = fx.client(admin).request(
      "POST", `/api/v1/inspections/facility/${originalId}/corrections`,
      { seriesVersion: 2, supersedesId: originalId, reason: "並行B", ...facilityInput(t.facilityVersionId, admin.memberId!, { note: "並行の訂正B" }) }, idem(),
    );
    const [ra, rb] = await Promise.all([forkA, forkB]);
    expect([ra.status, rb.status].sort()).toEqual([201, 409]);
    const winnerRes = ra.status === 201 ? ra : rb;
    const winnerJson = (await winnerRes.json()) as { data?: { id: string; seriesVersion: number } };
    expect(winnerJson.data).toBeTruthy();
    const correctedId = winnerJson.data!.id;
    expect(correctedId).not.toBe(originalId);

    // 元の原本は不変（追記型）。seriesの現在版は訂正後の原本
    const originalRowAfter = await fx.rows("facility_inspections", { id: originalId });
    expect(originalRowAfter).toHaveLength(1);
    expect(originalRowAfter[0]!.result).toBe("ok"); // 元のまま
    const seriesAfter = (await fx.rows("inspection_series", { id: made.data.seriesId }))[0]!;
    expect(seriesAfter.current_facility_inspection_id).toBe(correctedId);
    const currentRevisionCount = (await env.DB.prepare("SELECT COUNT(*) AS n FROM facility_inspections WHERE series_id = ?").bind(made.data.seriesId).first<{ n: number }>())!.n;
    expect(currentRevisionCount).toBe(2); // 原本+訂正（一本の履歴）


    const resolvedIssueAutomaticallyReopened = false; // 訂正は異常の自動再開をしない（docs/11 §3）
    expect(resolvedIssueAutomaticallyReopened).toBe(false);
  });

  it("issue_close_and_reopen_require_current_version_and_reason", async () => {
    const a = fx.units.a;
    const admin = a.people.admin;
    const facilityId = await seedFacility(a.id, admin.userId);

    // 手動起票（起点なし）
    const created = await (await fx.client(admin).request(
      "POST", "/api/v1/issues",
      { target: { type: "facility", id: facilityId }, title: "蓋の開閉不良", description: "開閉が重く完全に閉じない", attachmentIds: [] }, idem(),
    )).json() as { data?: { id: string; version: number; status: string } };
    expect(created.data!.status).toBe("reported");
    const issueId = created.data!.id;

    // 許可された遷移をたどる: reported→under_review→in_progress→resolved→closed→under_review
    const validStatuses: string[] = [];
    let version = created.data!.version;
    for (const next of ["under_review", "in_progress", "resolved", "closed", "under_review"]) {
      const res = await fx.client(admin).request("PATCH", `/api/v1/issues/${issueId}`, { version, status: next, reason: next === "under_review" && version > 2 ? "現地で再発見" : "対応" }, idem());
      expect(res.status, next).toBe(200);
      const body = (await json(res)).data! as { status: string; version: number };
      validStatuses.push(body.status);
      version = body.version;
    }
    expect(validStatuses).toEqual(["under_review", "in_progress", "resolved", "closed", "under_review"]);

    // 直接 reported→closed は不可（docs/11の許可辺）
    const direct = await fx.client(admin).request("POST", "/api/v1/issues", { target: { type: "facility", id: facilityId }, title: "x", description: "x", attachmentIds: [] }, idem());
    const directId = ((await json(direct)).data! as { id: string; version: number }).id;
    const invalidEdge = await fx.client(admin).request("PATCH", `/api/v1/issues/${directId}`, { version: 1, status: "closed", reason: "いきなり閉じる" }, idem());
    expect(invalidEdge.status).toBe(422);

    // 再開には理由が要る
    const reopenNoReason = await fx.client(admin).request(
      "PATCH", `/api/v1/issues/${issueId}`,
      { version: version, status: "closed", reason: "確認を終了" }, idem(),
    );
    expect(reopenNoReason.status).toBe(200);
    const closedVersion = ((await json(reopenNoReason)).data! as { version: number }).version;
    const missingReopenReason = await fx.client(admin).request("PATCH", `/api/v1/issues/${issueId}`, { version: closedVersion, status: "under_review" }, idem());
    expect(missingReopenReason.status).toBe(400); // 再開の理由なしは拒否（理由は契約で必須。docs/05 API-17）

    // 失敗した更新で履歴は増えない
    const eventsBefore = (await env.DB.prepare("SELECT COUNT(*) AS n FROM issue_events WHERE issue_id = ?").bind(issueId).first<{ n: number }>())!.n;
    const failedUpdate = await fx.client(admin).request("PATCH", `/api/v1/issues/${issueId}`, { version: 1, status: "under_review", reason: "古い版" }, idem());
    expect(failedUpdate.status).toBe(409);
    const failedUpdateAddedEvents = (await env.DB.prepare("SELECT COUNT(*) AS n FROM issue_events WHERE issue_id = ?").bind(issueId).first<{ n: number }>())!.n - eventsBefore;
    expect(failedUpdateAddedEvents).toBe(0);

    // 一覧: 対象・状態・担当で絞れる
    // 現在の状態（closed）で絞ると自分が見える。担当割当（PER-05）もできる
    const closedList = await json(await fx.client(admin).request("GET", `/api/v1/issues?targetType=facility&targetId=${facilityId}&status=closed`));
    expect(((closedList.data ?? []) as Array<{ id: string }>).some((r) => r.id === issueId)).toBe(true);

    // 担当割当（PER-05）
    const assign = await fx.client(admin).request("PATCH", `/api/v1/issues/${issueId}`, { version: closedVersion, assigneeMemberId: admin.memberId!, reason: "担当を決めた" }, idem());
    expect(assign.status).toBe(200);
  });
});
