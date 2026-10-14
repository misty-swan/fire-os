import { env } from "cloudflare:workers";
import { applyD1Migrations } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import "../src/server/jobs/handlers/attachment"; // 検査jobの登録（ready添付を作るため）
import { runDueJobs } from "../src/server/jobs/runner";
import { buildInspectionMutation } from "../src/server/inspections/build";
import { executeMutation, type Principal } from "../src/server/mutations/execute";
import { createFixture, type Identity, type TestFixture } from "./helpers/fixture";

let fx: TestFixture;
beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
  fx = await createFixture("two-units");
});

const idem = () => ({ "idempotency-key": crypto.randomUUID() });
const json = async (r: Response) => (await r.json()) as { data?: Record<string, unknown>; error?: { code: string; details?: { field: string; reason: string }[] } };

/** 検査を通る最小のPNG（eXIf等なし。内容の検査そのものはT016） */
const pngBytes = () => {
  const magic = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  let table: number[] = [];
  const crc32 = (bytes: Uint8Array) => {
    if (!table.length) {
      for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; table[n] = c >>> 0; }
    }
    let c = 0xffffffff;
    for (const b of bytes) c = table[(c ^ b) & 0xff]! ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type: string, data: Uint8Array) => {
    const out = new Uint8Array(12 + data.length);
    new DataView(out.buffer).setUint32(0, data.length);
    for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
    out.set(data, 8);
    new DataView(out.buffer).setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
    return out;
  };
  const ihdr = new Uint8Array(13);
  new DataView(ihdr.buffer).setUint32(0, 1);
  new DataView(ihdr.buffer).setUint32(4, 1);
  ihdr.set([8, 6, 0, 0, 0], 8);
  const parts = [magic, chunk("IHDR", ihdr), chunk("IDAT", new Uint8Array([0x78, 0x9c, 0x63, 0x60, 0x60, 0x60, 0x00, 0x00, 0x00, 0x04, 0x00, 0x01])), chunk("IEND", new Uint8Array(0))];
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
};

/** 添付を予約→転送→完了まで進める。runDueJobsUntilReadyで検査を通す（未検査のまま使う試験もある） */
async function makeUploaded(who: Identity, intended: string): Promise<string> {
  const dRes = await fx.client(who).request("POST", "/api/v1/attachment-drafts", { intendedEntityType: intended }, idem());
  const draft = (await json(dRes)).data! as { id: string };
  const bytes = pngBytes();
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

interface TemplateRef {
  templateId: string;
  facilityVersionId: string;
  vehicleVersionId: string;
  equipmentVersionId: string;
  facilityTemplateVersion: number;
}

/** 施設と車両・機材の承認済み様式を用意する（T027/T030の経路） */
async function seedTemplates(admin: Identity): Promise<TemplateRef> {
  // 許可された結果は点検結果の語彙（docs/05 InspectionInput。docs/11 点検結果）
  const facilitySchema = [
    { code: "exterior", label: "本体の外観", valueType: "select", required: true, allowedResults: ["ok", "needs_review"] },
    { code: "ground", label: "周辺の環境", valueType: "boolean", required: false },
  ];
  const vehicleSchema = [{ code: "lights", label: "灯火類", valueType: "select", required: true, allowedResults: ["ok", "needs_review"] }];
  const equipmentSchema = [{ code: "count", label: "数量の確認", valueType: "number", required: false }];
  const mk = async (name: string, targetType: "facility" | "vehicle" | "equipment", itemSchema: unknown) => {
    const res = await fx.client(admin).request("POST", "/api/v1/inspection-templates", { name, targetType, itemSchema }, idem());
    const data = ((await res.json()) as { data?: { id: string; version: number; versions: { id: string }[] } }).data;
    if (!data) throw new Error(`template create failed: ${res.status}`);
    return data;
  };
  const fac = await mk(`施設様式${crypto.randomUUID().slice(0, 6)}`, "facility", facilitySchema);
  const veh = await mk(`車両様式${crypto.randomUUID().slice(0, 6)}`, "vehicle", vehicleSchema);
  const eqp = await mk(`機材様式${crypto.randomUUID().slice(0, 6)}`, "equipment", equipmentSchema);
  const vFac = fac.versions[0]!.id;
  const vVeh = veh.versions[0]!.id;
  const vEqp = eqp.versions[0]!.id;
  const approve = async (id: string, versionId: string) => {
    await fx.client(admin).request("POST", `/api/v1/inspection-templates/${id}/decision`, { version: 1, templateVersionId: versionId, decision: "request_review", reason: "確認" }, idem());
    const done = await json(await fx.client(admin).request("POST", `/api/v1/inspection-templates/${id}/decision`, { version: 2, templateVersionId: versionId, decision: "approve", reason: "確認した" }, idem()));
    if (!done.data) throw new Error(`approve failed: ${id}`);
  };
  await approve(fac.id, vFac);
  await approve(veh.id, vVeh);
  await approve(eqp.id, vEqp);
  return { templateId: fac.id, facilityVersionId: vFac, vehicleVersionId: vVeh, equipmentVersionId: vEqp, facilityTemplateVersion: fac.version };
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
    expect(missingRequired.status).toBe(400); // 空配列は契約(400)で拒否
    // 項目が足りない明細（空配列でなく、必須の「exterior」が欠けた配列）も様式検査で拒否
    const missingItem = await fx.client(admin).request(
      "POST", `/api/v1/facilities/${facilityId}/inspections`,
      facilityInput(t.facilityVersionId, admin.memberId!, { result: "needs_review", createIssue: true, checkItems: [{ code: "ground", result: "ok" }] }), idem(),
    );
    expect(missingItem.status).toBe(400);
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

    // 異種様式（施設用）は422。その車両の原本は1行も増えない（二重対象・異種様式の失敗が残らない）
    const wrongTemplate = await fx.client(admin).request(
      "POST", "/api/v1/asset-inspections",
      { target: { type: "vehicle", id: vehicle.data.id }, ...vehInput, templateVersionId: t.facilityVersionId }, idem(),
    );
    expect(wrongTemplate.status).toBe(422);
    const vehicleInspectionRows = await env.DB.prepare("SELECT COUNT(*) AS n FROM asset_inspections WHERE vehicle_id = ?").bind(vehicle.data.id).first<{ n: number }>();
    expect(vehicleInspectionRows!.n).toBe(1); // 最初の成功1件のまま

    // 機材への正常点検（機材用の承認済み様式）。対象はちょうど一つ（equipment）
    const equipmentInput = {
      templateVersionId: t.equipmentVersionId, inspectedAt: "2026-10-14T04:00:00.000Z",
      inspectorMemberId: admin.memberId!, result: "ok",
      checkItems: [{ code: "count", result: "ok", value: 2 }], note: "機材点検の記録", createIssue: false, attachmentIds: [],
    };
    const validEquipment = await fx.client(admin).request(
      "POST", "/api/v1/asset-inspections", { target: { type: "equipment", id: equipment.data.id }, ...equipmentInput }, idem(),
    );
    expect(validEquipment.status).toBe(201);
    const equipmentSeries = await fx.rows("inspection_series", { equipment_id: equipment.data.id });
    expect(equipmentSeries).toHaveLength(1);
    expect(((await json(validEquipment)).data! as { seriesId: string }).seriesId).toBe(equipmentSeries[0]!.id);

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

    // 理由なしの訂正は契約で拒否（docs/11 §3「訂正理由を残す」）
    const noReason = await fx.client(admin).request(
      "POST", `/api/v1/inspections/facility/${correctedId}/corrections`,
      { seriesVersion: winnerJson.data!.seriesVersion, supersedesId: correctedId, reason: "", ...facilityInput(t.facilityVersionId, admin.memberId!) }, idem(),
    );
    expect(noReason.status).toBe(400);

    // 訂正で起点異常を作り（createIssue）、解決済み（closed）まで進めてから再訂正しても、
    // 異常は自動で再開・削除されない（docs/11 §3「既存異常の自動削除/再開を禁止」）
    const issueCorrection = await fx.client(admin).request(
      "POST", `/api/v1/inspections/facility/${correctedId}/corrections`,
      { seriesVersion: winnerJson.data!.seriesVersion, supersedesId: correctedId, reason: "異常を含む訂正",
        ...facilityInput(t.facilityVersionId, admin.memberId!, { result: "needs_review", checkItems: [{ code: "exterior", result: "needs_review" }], createIssue: true }) }, idem(),
    );
    expect(issueCorrection.status).toBe(201);
    const issueCorrectionId = ((await issueCorrection.json()) as { data: { id: string } }).data.id;
    const createdIssue = (await fx.rows("issues", { source_facility_inspection_id: issueCorrectionId }))[0]!;
    expect(createdIssue!.status).toBe("reported");
    const issueId = createdIssue!.id as string;
    const underReview = await fx.client(admin).request("PATCH", `/api/v1/issues/${issueId}`, { version: 1, status: "under_review", reason: "確認を始めた" }, idem());
    expect(underReview.status).toBe(200);
    const closed = await fx.client(admin).request("PATCH", `/api/v1/issues/${issueId}`, { version: 2, status: "closed", reason: "対応済み" }, idem());
    expect(closed.status).toBe(200);
    const eventsBefore = (await env.DB.prepare("SELECT COUNT(*) AS n FROM issue_events WHERE issue_id = ?").bind(issueId).first<{ n: number }>())!.n;

    // 現在版（訂正後の原本）をさらに訂正できる。系列は一本のまま進む
    const secondCorrection = await fx.client(admin).request(
      "POST", `/api/v1/inspections/facility/${issueCorrectionId}/corrections`,
      { seriesVersion: winnerJson.data!.seriesVersion + 1, supersedesId: issueCorrectionId, reason: "数値の誤り訂正", ...facilityInput(t.facilityVersionId, admin.memberId!) }, idem(),
    );
    expect(secondCorrection.status).toBe(201);

    // 解決済みの異常は訂正で再開も削除もされない
    const issueAfter = (await fx.rows("issues", { id: issueId }))[0]!;
    expect(issueAfter!.status).toBe("closed");
    expect(issueAfter!.source_facility_inspection_id).toBe(issueCorrectionId);
    const eventsAfter = (await env.DB.prepare("SELECT COUNT(*) AS n FROM issue_events WHERE issue_id = ?").bind(issueId).first<{ n: number }>())!.n;
    expect(eventsAfter).toBe(eventsBefore);

    // 過去版（もう訂正済みの旧原本）からさらに枝分かれしない。seriesの版は現在（版ガードを通る）なので、
    // 現在版ポインタの検査が409にする（docs/16 T031「過去版枝分かれ」）
    const staleFork = await fx.client(admin).request(
      "POST", `/api/v1/inspections/facility/${originalId}/corrections`,
      { seriesVersion: winnerJson.data!.seriesVersion + 2, supersedesId: originalId, reason: "過去版からの枝分かれ", ...facilityInput(t.facilityVersionId, admin.memberId!) }, idem(),
    );
    expect(staleFork.status).toBe(409);
    // 過去版からの枝分かれは現在版競合（VERSION_CONFLICT）。同じ409でも「同じ原本への2回目の訂正」(DUPLICATE)とは区別する
    expect(((await staleFork.json()) as { error?: { code?: string } }).error?.code).toBe("VERSION_CONFLICT");
    const revisionCountFinal = (await env.DB.prepare("SELECT COUNT(*) AS n FROM facility_inspections WHERE series_id = ?").bind(made.data.seriesId).first<{ n: number }>())!.n;
    expect(revisionCountFinal).toBe(4); // 原本+訂正+異常訂正+再訂正。過去版からの枝は増えていない
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

    // 対応記録の理由はDBのCHECK（issue_events.note ≤2000）に揃えた上限。超過は400（通ってから500にならない）
    const tooLongReason = await fx.client(admin).request(
      "PATCH", `/api/v1/issues/${issueId}`, { version: closedVersion, status: "closed", reason: "長".repeat(2001) }, idem(),
    );
    expect(tooLongReason.status).toBe(400);

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

  it("inspection_links_ready_attachments_and_rejects_uninspected_ones", async () => {
    const a = fx.units.a;
    const admin = a.people.admin;
    const t = await seedTemplates(admin);
    const facilityId = await seedFacility(a.id, admin.userId);

    // (a) ready添付をattachmentIdsで渡すと、点検と同じ確定でリンクが作られる（T029: 添付は業務と同時に確定）
    const readyId = await makeUploaded(admin, "inspection");
    await runDueJobs(env);
    const readyStatus = (await fx.rows("attachments", { id: readyId }))[0]!.status;
    expect(readyStatus).toBe("ready"); // 前提: 検査を通っている

    const res = await fx.client(admin).request(
      "POST", `/api/v1/facilities/${facilityId}/inspections`,
      facilityInput(t.facilityVersionId, admin.memberId!, { attachmentIds: [readyId] }), idem(),
    );
    expect(res.status).toBe(201);
    const inspection = (await json(res)).data! as { id: string };
    const links = await fx.rows("attachment_links", { attachment_id: readyId });
    expect(links).toHaveLength(1);
    expect(links[0]!.entity_type).toBe("inspection");
    expect(links[0]!.entity_id).toBe(inspection.id);
    expect(links[0]!.unlinked_at).toBeNull();
    // 点検・異常への添付はsensitiveを基本とする（docs/10 §3。basicからの引上げ）
    expect((await fx.rows("attachments", { id: readyId }))[0]!.classification).toBe("sensitive");

    // (b) 未検査（ready前）の添付を渡すと422で、点検も異常も増えない
    const uninspectedId = await makeUploaded(admin, "inspection"); // 完了済みだが検査jobは未実行
    const before = {
      inspections: (await env.DB.prepare("SELECT COUNT(*) AS n FROM facility_inspections").first<{ n: number }>())!.n,
      issues: (await env.DB.prepare("SELECT COUNT(*) AS n FROM issues").first<{ n: number }>())!.n,
    };
    const notReady = await fx.client(admin).request(
      "POST", `/api/v1/facilities/${facilityId}/inspections`,
      facilityInput(t.facilityVersionId, admin.memberId!, { attachmentIds: [uninspectedId] }), idem(),
    );
    expect(notReady.status).toBe(422);
    expect(((await json(notReady)).error?.code)).toBe("ATTACHMENT_NOT_READY");
    const after = {
      inspections: (await env.DB.prepare("SELECT COUNT(*) AS n FROM facility_inspections").first<{ n: number }>())!.n,
      issues: (await env.DB.prepare("SELECT COUNT(*) AS n FROM issues").first<{ n: number }>())!.n,
    };
    expect(after).toEqual(before); // 失敗した点検・異常は残らない
    expect(await fx.rows("attachment_links", { attachment_id: uninspectedId })).toHaveLength(0);
  });

  it("manual_issue_links_ready_attachments_and_rejects_uninspected_ones", async () => {
    const a = fx.units.a;
    const admin = a.people.admin;
    const t = await seedTemplates(admin);
    const facilityId = await seedFacility(a.id, admin.userId);

    // (a) 起点なしの手動起票: ready添付を異常の作成と同じ確定で紐付ける（docs/05 API-16 attachmentIds）
    const readyId = await makeUploaded(admin, "issue");
    await runDueJobs(env);
    expect((await fx.rows("attachments", { id: readyId }))[0]!.status).toBe("ready"); // 前提: 検査を通っている
    const created = await fx.client(admin).request(
      "POST", "/api/v1/issues",
      { target: { type: "facility", id: facilityId }, title: "写真つきの手動報告", description: "検査の済んだ写真を添えて起票", attachmentIds: [readyId] }, idem(),
    );
    expect(created.status).toBe(201);
    const issueId = ((await json(created)).data! as { id: string }).id;
    const links = await fx.rows("attachment_links", { attachment_id: readyId });
    expect(links).toHaveLength(1);
    expect(links[0]!.entity_type).toBe("issue");
    expect(links[0]!.entity_id).toBe(issueId);
    expect(links[0]!.unlinked_at).toBeNull();
    // 異常への添付はsensitiveを基本とする（docs/10 §3。basicからの引上げ。引下げはしない）
    expect((await fx.rows("attachments", { id: readyId }))[0]!.classification).toBe("sensitive");

    // (b) 起点つきの起票でも同じ（起点の対象一致は既存の規則のまま）
    const facilityInspection = await (await fx.client(admin).request(
      "POST", `/api/v1/facilities/${facilityId}/inspections`,
      facilityInput(t.facilityVersionId, admin.memberId!), idem(),
    )).json() as { data: { id: string } };
    const ready2 = await makeUploaded(admin, "issue");
    await runDueJobs(env);
    const withOrigin = await fx.client(admin).request(
      "POST", "/api/v1/issues",
      { target: { type: "facility", id: facilityId }, title: "起点つきの写真つき報告", description: "点検の後に手動で起票", originInspectionId: facilityInspection.data.id, attachmentIds: [ready2] }, idem(),
    );
    expect(withOrigin.status).toBe(201);
    expect(await fx.rows("attachment_links", { attachment_id: ready2 })).toHaveLength(1);

    // (c) 未検査（ready前）の添付は422で、異常もリンクも増えない
    const uninspectedId = await makeUploaded(admin, "issue"); // 完了済みだが検査jobは未実行
    const beforeIssues = (await env.DB.prepare("SELECT COUNT(*) AS n FROM issues").first<{ n: number }>())!.n;
    const notReady = await fx.client(admin).request(
      "POST", "/api/v1/issues",
      { target: { type: "facility", id: facilityId }, title: "未検査の添付", description: "ready前の写真は紐付かない", attachmentIds: [uninspectedId] }, idem(),
    );
    expect(notReady.status).toBe(422);
    expect(((await json(notReady)).error?.code)).toBe("ATTACHMENT_NOT_READY");
    expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM issues").first<{ n: number }>())!.n).toBe(beforeIssues);
    expect(await fx.rows("attachment_links", { attachment_id: uninspectedId })).toHaveLength(0);
  });

  it("inspection_note_limits_follow_the_db_checks", async () => {
    const a = fx.units.a;
    const admin = a.people.admin;
    const t = await seedTemplates(admin);
    const facilityId = await seedFacility(a.id, admin.userId);

    // 明細の備考はDBのCHECK（inspection_items.note 1..2000。未指定はNULL）に揃える。超過も空文字も400（500にならない）
    const tooLongItemNote = await fx.client(admin).request(
      "POST", `/api/v1/facilities/${facilityId}/inspections`,
      facilityInput(t.facilityVersionId, admin.memberId!, { checkItems: [{ code: "exterior", result: "ok", note: "長".repeat(2001) }] }), idem(),
    );
    expect(tooLongItemNote.status).toBe(400);
    const emptyItemNote = await fx.client(admin).request(
      "POST", `/api/v1/facilities/${facilityId}/inspections`,
      facilityInput(t.facilityVersionId, admin.memberId!, { checkItems: [{ code: "exterior", result: "ok", note: "" }] }), idem(),
    );
    expect(emptyItemNote.status).toBe(400);
    // 2000字ちょうどは通る（上限の固定値。docs/05 §1）
    const okItemNote = await fx.client(admin).request(
      "POST", `/api/v1/facilities/${facilityId}/inspections`,
      facilityInput(t.facilityVersionId, admin.memberId!, { checkItems: [{ code: "exterior", result: "ok", note: "長".repeat(2000) }] }), idem(),
    );
    expect(okItemNote.status).toBe(201);
    // 点検の本文（facility_inspections.note 1..20000）も空文字は400
    const emptyNote = await fx.client(admin).request(
      "POST", `/api/v1/facilities/${facilityId}/inspections`,
      facilityInput(t.facilityVersionId, admin.memberId!, { note: "" }), idem(),
    );
    expect(emptyNote.status).toBe(400);
  });

  it("manual_issue_records_only_matching_origin_inspection", async () => {
    const a = fx.units.a;
    const admin = a.people.admin;
    const t = await seedTemplates(admin);
    const facilityId = await seedFacility(a.id, admin.userId);
    const vehicle = await (await fx.client(admin).request("POST", "/api/v1/vehicles", { assetCode: "P-ORG", name: "起点試験車", status: "運用" }, idem())).json() as { data: { id: string } };

    // 施設点検と車両点検を1件ずつ作る（起点の候補）
    const facilityInspection = await (await fx.client(admin).request(
      "POST", `/api/v1/facilities/${facilityId}/inspections`,
      facilityInput(t.facilityVersionId, admin.memberId!), idem(),
    )).json() as { data: { id: string } };
    const vehicleInspection = await (await fx.client(admin).request(
      "POST", "/api/v1/asset-inspections",
      { target: { type: "vehicle", id: vehicle.data.id }, templateVersionId: t.vehicleVersionId, inspectedAt: "2026-10-14T05:00:00.000Z", inspectorMemberId: admin.memberId!, result: "ok", checkItems: [{ code: "lights", result: "ok" }], note: "車両点検", createIssue: false, attachmentIds: [] }, idem(),
    )).json() as { data: { id: string } };

    // (c) 同対象の起点点検は記録される
    const okRes = await fx.client(admin).request(
      "POST", "/api/v1/issues",
      { target: { type: "facility", id: facilityId }, title: "起点つきの報告", description: "点検で見つけた後に手動で起票", originInspectionId: facilityInspection.data.id, attachmentIds: [] }, idem(),
    );
    expect(okRes.status).toBe(201);
    const withOrigin = (await json(okRes)).data! as { id: string; originInspectionId: string | null };
    expect(withOrigin.originInspectionId).toBe(facilityInspection.data.id);
    expect((await fx.rows("issues", { id: withOrigin.id }))[0]!.source_facility_inspection_id).toBe(facilityInspection.data.id);

    // (d) 別対象（車両点検を施設の異常の起点に）は422。起点のない異常も作られない
    const beforeIssues = (await env.DB.prepare("SELECT COUNT(*) AS n FROM issues").first<{ n: number }>())!.n;
    const mismatch = await fx.client(admin).request(
      "POST", "/api/v1/issues",
      { target: { type: "facility", id: facilityId }, title: "別対象の起点", description: "車両点検を施設の起点にはできない", originInspectionId: vehicleInspection.data.id, attachmentIds: [] }, idem(),
    );
    expect(mismatch.status).toBe(422);
    expect(((await json(mismatch)).error?.details ?? []).some((d) => d.reason === "origin_target_mismatch")).toBe(true);
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM issues").first<{ n: number }>()).toEqual({ n: beforeIssues });

    // 存在しない点検を起点にするのは404
    const ghost = await fx.client(admin).request(
      "POST", "/api/v1/issues",
      { target: { type: "facility", id: facilityId }, title: "架空の起点", description: "存在しない点検ID", originInspectionId: crypto.randomUUID(), attachmentIds: [] }, idem(),
    );
    expect(ghost.status).toBe(404);
  });

  it("inspection_series_is_unique_per_target_and_reused", async () => {
    const a = fx.units.a;
    const admin = a.people.admin;
    const t = await seedTemplates(admin);
    const facilityId = await seedFacility(a.id, admin.userId);

    // (a) DB制約: 同じ対象に2行の系列は作れない（docs/04「対象一つ」。0014の部分一意索引）
    const now = new Date().toISOString();
    const insertSeries = (currentPointer: string) =>
      env.DB.prepare(
        "INSERT INTO inspection_series (id, unit_id, facility_id, current_facility_inspection_id, created_at, updated_at, created_by, actor_kind) VALUES (?, ?, ?, ?, ?, ?, ?, 'human')",
      ).bind(crypto.randomUUID(), a.id, facilityId, currentPointer, now, now, admin.userId);
    await insertSeries(crypto.randomUUID()).run();
    await expect(insertSeries(crypto.randomUUID()).run()).rejects.toThrow(/UNIQUE/);

    // (b) 既存の系列がある対象への点検は、その既存系列に載る（新しい系列を作らない）
    const first = await (await fx.client(admin).request(
      "POST", `/api/v1/facilities/${facilityId}/inspections`, facilityInput(t.facilityVersionId, admin.memberId!), idem(),
    )).json() as { data: { id: string; seriesId: string; seriesVersion: number } };
    // 直insertした系列が既にあるので、APIの点検はその系列を使う（versionも既存のまま+1で進む）
    const seriesForTarget = await fx.rows("inspection_series", { facility_id: facilityId });
    expect(seriesForTarget.length).toBe(1);
    expect(seriesForTarget[0]!.id).toBe(first.data.seriesId);
    expect(first.data.seriesVersion).toBe(2); // 現在版ポインタの更新で1つ進む
  });

  it("paused_members_cannot_be_inspector_or_assignee", async () => {
    const a = fx.units.a;
    const admin = a.people.admin;
    const t = await seedTemplates(admin);
    const facilityId = await seedFacility(a.id, admin.userId);

    // 休団（paused）の団員は点検の実施者になれない（docs/10 PER-04/05の対象条件）
    const pausedMemberId = a.people.operator.memberId!;
    await env.DB.prepare("UPDATE members SET status = 'paused' WHERE id = ?").bind(pausedMemberId).run();
    const res = await fx.client(admin).request(
      "POST", `/api/v1/facilities/${facilityId}/inspections`,
      facilityInput(t.facilityVersionId, pausedMemberId), idem(),
    );
    expect(res.status).toBe(422);
    expect(((await json(res)).error?.details ?? []).some((d) => d.reason === "inspector_not_active")).toBe(true);
    // 異常の担当にもなれない（PER-05）
    const issue = await (await fx.client(admin).request(
      "POST", "/api/v1/issues", { target: { type: "facility", id: facilityId }, title: "担当の試験", description: "休団者への割当て", attachmentIds: [] }, idem(),
    )).json() as { data: { id: string; version: number } };
    const assign = await fx.client(admin).request(
      "PATCH", `/api/v1/issues/${issue.data.id}`, { version: issue.data.version, assigneeMemberId: pausedMemberId, reason: "休団者に割当て" }, idem(),
    );
    expect(assign.status).toBe(422);
    expect(((await json(assign)).error?.details ?? []).some((d) => d.reason === "assignee_not_active")).toBe(true);
  });

  it("inspection_mutation_rolls_back_at_any_statement_position", async () => {
    const a = fx.units.a;
    const admin = a.people.admin;
    const t = await seedTemplates(admin);
    const facilityId = await seedFacility(a.id, admin.userId);
    const principal: Principal = { userId: admin.userId, memberId: admin.memberId!, unitId: a.id, authzVersion: 1 };

    // 明細・異常を含む点検のspecを直接組み立てる（T029の原子性。docs/02 §4「1つのbatchで確定」）
    const built = await buildInspectionMutation(env, principal, {
      target: { type: "facility", id: facilityId },
      input: {
        templateVersionId: t.facilityVersionId, inspectedAt: "2026-10-14T06:00:00.000Z", inspectorMemberId: admin.memberId!,
        result: "needs_review", checkItems: [{ code: "exterior", result: "needs_review" }], note: "原子性試験の点検", createIssue: true,
      },
      operationCode: "facility_inspection.create",
      idempotencyKey: crypto.randomUUID(),
      requestHashPath: `/facilities/${facilityId}/inspections`,
    });
    // 新規series+原本+明細+series更新+異常+異常履歴の6文のうち、明細の後(3)と異常の後(5)に失敗を差し込む
    const statementCount = built.spec.statements({ attempt: "probe", mutationId: "probe", now: new Date().toISOString() }).length;
    expect(statementCount).toBe(6);

    const counts = async () => ({
      series: (await env.DB.prepare("SELECT COUNT(*) AS n FROM inspection_series").first<{ n: number }>())!.n,
      inspections: (await env.DB.prepare("SELECT COUNT(*) AS n FROM facility_inspections").first<{ n: number }>())!.n,
      items: (await env.DB.prepare("SELECT COUNT(*) AS n FROM inspection_items").first<{ n: number }>())!.n,
      issues: (await env.DB.prepare("SELECT COUNT(*) AS n FROM issues").first<{ n: number }>())!.n,
      events: (await env.DB.prepare("SELECT COUNT(*) AS n FROM issue_events").first<{ n: number }>())!.n,
    });
    const before = await counts();

    const failAt = async (position: number) => {
      const spec = { ...built.spec, key: crypto.randomUUID() };
      const original = spec.statements;
      spec.statements = (ctx) => {
        const stmts = original(ctx);
        // 必ず失敗する文（CHECK(ok=1)違反）を指定位置に差し込む
        const failing = env.DB.prepare("INSERT INTO mutation_assertions (attempt_token, seq, ok) VALUES (?, 999, 0)").bind(ctx.attempt);
        return [...stmts.slice(0, position), failing, ...stmts.slice(position)];
      };
      await expect(executeMutation(env, principal, spec)).rejects.toBeTruthy();
    };

    // 明細INSERTの後で失敗 → 原本・明細・series・異常のどれも残らない
    await failAt(3);
    expect(await counts()).toEqual(before);
    // 異常INSERTの後で失敗 → 異常・履歴も含めて全て取り消される
    await failAt(5);
    expect(await counts()).toEqual(before);

    // 差し込み無しの同じspecは成功する（失敗注入のせいでないことの対照）
    const okResult = await executeMutation(env, principal, { ...built.spec, key: crypto.randomUUID() });
    expect(okResult.status).toBe(201);
    const after = await counts();
    expect(after.series).toBe(before.series + 1);
    expect(after.inspections).toBe(before.inspections + 1);
    expect(after.issues).toBe(before.issues + 1);
  });

  it("correction_conflict_is_detected_by_declared_series_version", async () => {
    const a = fx.units.a;
    const admin = a.people.admin;
    const t = await seedTemplates(admin);
    const facilityId = await seedFacility(a.id, admin.userId);
    const made = await (await fx.client(admin).request(
      "POST", `/api/v1/facilities/${facilityId}/inspections`,
      facilityInput(t.facilityVersionId, admin.memberId!), idem(),
    )).json() as { data: { id: string; seriesVersion: number } };
    expect(made.data.seriesVersion).toBe(2);

    // クライアントが宣言した古いseriesVersionでの訂正は409（docs/05 API-46の「series版ガード」。
    // サーバーが再読した現在版で黙って通さない。docs/16 T031）
    const staleVersion = await fx.client(admin).request(
      "POST", `/api/v1/inspections/facility/${made.data.id}/corrections`,
      { seriesVersion: 1, supersedesId: made.data.id, reason: "古い版を宣言した訂正", ...facilityInput(t.facilityVersionId, admin.memberId!, { note: "古い版の訂正" }) }, idem(),
    );
    expect(staleVersion.status).toBe(409);
    expect(((await json(staleVersion)).error?.code)).toBe("VERSION_CONFLICT");
    // 失敗した訂正で原本は増えない
    expect(await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM facility_inspections WHERE series_id = (SELECT series_id FROM facility_inspections WHERE id = ?)",
    ).bind(made.data.id).first<{ n: number }>()).toEqual({ n: 1 });

    // 最新のseriesVersionを宣言した訂正は成功する
    const current = await fx.client(admin).request(
      "POST", `/api/v1/inspections/facility/${made.data.id}/corrections`,
      { seriesVersion: made.data.seriesVersion, supersedesId: made.data.id, reason: "数値の誤り訂正", ...facilityInput(t.facilityVersionId, admin.memberId!, { note: "正しい訂正" }) }, idem(),
    );
    expect(current.status).toBe(201);
  });
});
