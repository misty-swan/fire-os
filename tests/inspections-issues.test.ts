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

/**
 * 完了確定（API-84）前の添付（検査jobが無く、背景のQueue consumerでreadyへ進まない）。「未検査は422」を
 * 決定的に試すため（T085: 完了確定済みの添付は全スイート実行中にconsumerがreadyへ進め、422の断言が201で落ちた）
 */
async function makeNotYetCompleted(who: Identity, intended: string): Promise<string> {
  const dRes = await fx.client(who).request("POST", "/api/v1/attachment-drafts", { intendedEntityType: intended }, idem());
  const draft = (await json(dRes)).data! as { id: string };
  const iRes = await fx.client(who).request(
    "POST", "/api/v1/attachments/upload-intents",
    { target: { type: "attachment_draft", id: draft.id }, contentType: "image/png", byteSize: pngBytes().byteLength }, idem(),
  );
  return ((await json(iRes)).data! as { id: string }).id;
}

/** 既存の業務対象を直targetにしたintent（SCR-06のuploaderと同じ経路）。転送と完了まで進める */
async function makeUploadedTo(who: Identity, target: { type: "facility"; id: string }): Promise<string> {
  const iRes = await fx.client(who).request(
    "POST", "/api/v1/attachments/upload-intents",
    { target, contentType: "image/png", byteSize: 100 }, idem(),
  );
  const intent = (await json(iRes)).data! as { id: string; uploadToken: string };
  const bytes = pngBytes();
  const up = await fx.raw(who)(new Request(`http://example.com/api/v1/attachments/${intent.id}/upload`, {
    method: "PUT", headers: { "content-type": "application/octet-stream", "x-upload-token": intent.uploadToken }, body: bytes as BufferSource,
  }));
  const attempt = (await json(up)).data! as { id: string; sha256: string };
  await fx.client(who).request("POST", `/api/v1/attachments/${intent.id}/completion`, { version: 1, uploadAttemptId: attempt.id, sha256: attempt.sha256 }, idem());
  return intent.id;
}

/** 検査jobをもう一度走らせる（checkingへ戻して専用のdedupe keyで再登録。docs/07 §3.4の再入経路） */
async function rerunInspectJob(unitId: string, attachmentId: string) {
  const version = (await fx.rows("attachments", { id: attachmentId }))[0]!.version as number;
  await env.DB.prepare("UPDATE attachments SET status = 'checking' WHERE id = ?").bind(attachmentId).run();
  const now = new Date().toISOString();
  await env.DB.prepare(
    "INSERT INTO jobs (id, unit_id, kind, source_type, source_id, source_version, config_version, dedupe_key, status, attempts, max_attempts, next_attempt_at, created_at, updated_at) " +
      "VALUES (?, ?, 'attachment.inspect', 'attachment', ?, ?, 'v1', ?, 'queued', 0, 3, ?, ?, ?)",
  ).bind(crypto.randomUUID(), unitId, attachmentId, version, `${unitId}|attachment.inspect|rerun-${attachmentId}`, now, now, now).run();
  await runDueJobs(env);
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
      // 並行Aも良好のまま（T085裁定R17: 異常ありの系譜からの再起票は拒否されるため、後段の「異常を含む訂正」は良好→異常ありの訂正にする）
      { seriesVersion: 2, supersedesId: originalId, reason: "並行A", ...facilityInput(t.facilityVersionId, admin.memberId!, { note: "訂正後の原本" }) }, idem(),
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
    const uninspectedId = await makeNotYetCompleted(admin, "inspection"); // 検査前（ready前）
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
    const uninspectedId = await makeNotYetCompleted(admin, "issue"); // 検査前（ready前）
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

  it("facility_autolinked_photo_moves_to_inspection_on_save", async () => {
    const a = fx.units.a;
    const admin = a.people.admin;
    const t = await seedTemplates(admin);
    const facilityId = await seedFacility(a.id, admin.userId);

    // SCR-06のuploaderと同じ直target（既存施設）の写真は、検査jobの確定で施設へ自動リンクされる
    const photoId = await makeUploadedTo(admin, { type: "facility", id: facilityId });
    await runDueJobs(env);
    expect((await fx.rows("attachments", { id: photoId }))[0]!.status).toBe("ready");
    const autoLinks = await fx.rows("attachment_links", { attachment_id: photoId });
    expect(autoLinks).toHaveLength(1);
    expect(autoLinks[0]!.entity_type).toBe("facility");
    expect(autoLinks[0]!.entity_id).toBe(facilityId);

    // その写真をattachmentIds付きの点検保存に渡すと、施設リンクが外れて点検リンク1本へ移動する
    // （sensitiveの写真が施設の一覧に出ない。jobと保存のどちらが先でも最終状態を点検1本に決定論化。docs/10 §3）
    const res = await fx.client(admin).request(
      "POST", `/api/v1/facilities/${facilityId}/inspections`,
      facilityInput(t.facilityVersionId, admin.memberId!, { attachmentIds: [photoId] }), idem(),
    );
    expect(res.status).toBe(201);
    const inspection = (await json(res)).data! as { id: string };
    const links = await fx.rows("attachment_links", { attachment_id: photoId });
    expect(links).toHaveLength(1); // 有効リンクは点検の1本だけ（施設には残らない）
    expect(links[0]!.entity_type).toBe("inspection");
    expect(links[0]!.entity_id).toBe(inspection.id);
    expect(links[0]!.unlinked_at).toBeNull();
    expect((await fx.rows("attachments", { id: photoId }))[0]!.classification).toBe("sensitive");

    // 逆順（保存が先）も決定論: 点検へリンク済みの添付を検査jobが再確定しても施設リンクは作らない
    await rerunInspectJob(a.id, photoId);
    expect((await fx.rows("attachments", { id: photoId }))[0]!.status).toBe("ready");
    const afterRerun = await fx.rows("attachment_links", { attachment_id: photoId });
    expect(afterRerun).toHaveLength(1);
    expect(afterRerun[0]!.entity_type).toBe("inspection");
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
  // --- T085の網羅で見つけた欠落（API-44の機能試験が無かった。AT-MAP-05/06・TC-09） ---
  it("facility_inspection_history_pages_every_version_once_and_keeps_the_original (T085)", async () => {
    const a = fx.units.a;
    const admin = a.people.admin;
    const t = await seedTemplates(admin);
    const facilityId = await seedFacility(a.id, admin.userId);
    const post = (inspectedAt: string, note: string) => fx.client(admin).request(
      "POST", `/api/v1/facilities/${facilityId}/inspections`,
      facilityInput(t.facilityVersionId, admin.memberId!, { inspectedAt, note }), idem(),
    );
    // 3回の点検（時刻の異なる原本）と、最新の1件への訂正（追記型の訂正原本）
    const made: { id: string; seriesVersion: number }[] = [];
    for (const [at, note] of [["2026-10-01T01:00:00.000Z", "一回目"], ["2026-10-02T01:00:00.000Z", "二回目"], ["2026-10-03T01:00:00.000Z", "三回目"]] as const) {
      const r = await post(at, note);
      expect(r.status).toBe(201);
      made.push((await json(r)).data! as { id: string; seriesVersion: number });
    }
    const latest = made[2]!;
    const corrected = await fx.client(admin).request(
      "POST", `/api/v1/inspections/facility/${latest.id}/corrections`,
      { seriesVersion: latest.seriesVersion, supersedesId: latest.id, reason: "結果の記入誤り", ...facilityInput(t.facilityVersionId, admin.memberId!, { inspectedAt: "2026-10-03T01:00:00.000Z", result: "needs_review", checkItems: [{ code: "exterior", result: "needs_review" }], note: "三回目（訂正）" }) },
      idem(),
    );
    expect(corrected.status).toBe(201);
    const correctedId = ((await json(corrected)).data! as { id: string }).id;

    // limit=1で全cursorを完走: 4件（原本3＋訂正1）が重複・欠落なく、新しい順で一度ずつ返る
    const seen: { id: string; inspectedAt: string; supersedesId: string | null; result: string; note: string; isCurrent: boolean }[] = [];
    let cursor: string | undefined;
    for (let guard = 0; guard < 10; guard++) {
      const res = await fx.client(admin).request("GET", `/api/v1/facilities/${facilityId}/inspections?limit=1${cursor ? `&cursor=${cursor}` : ""}`);
      expect(res.status).toBe(200);
      const page = (await res.json()) as { data: typeof seen; meta: { nextCursor?: string } };
      seen.push(...page.data);
      cursor = page.meta.nextCursor;
      if (!cursor) break;
    }
    const ids = seen.map((r) => r.id);
    expect(new Set(ids).size).toBe(ids.length); // 重複なし
    expect(new Set(ids)).toEqual(new Set([...made.map((m) => m.id), correctedId])); // 欠落なし
    const times = seen.map((r) => r.inspectedAt);
    expect([...times].sort().reverse()).toEqual(times); // 新しい順
    // 訂正前の原本は不変で、訂正原本は元を指す（過去版を開ける）
    expect(seen.find((r) => r.id === latest.id)).toMatchObject({ result: "ok", note: "三回目", supersedesId: null, isCurrent: false });
    expect(seen.find((r) => r.id === correctedId)).toMatchObject({ result: "needs_review", supersedesId: latest.id, isCurrent: true });
    expect(seen.filter((r) => (r as unknown as { isCurrent: boolean }).isCurrent)).toHaveLength(1); // 系列の現在版はちょうど1件
    // 訂正済みはsupersededByIdで判定する（T085レビューA-I1）: 訂正していない古い点検はisCurrent=falseでも訂正済みではない
    const byId = new Map(seen.map((r) => [r.id, r as unknown as { supersededById: string | null; isCurrent: boolean }]));
    expect(byId.get(made[0]!.id)).toMatchObject({ isCurrent: false, supersededById: null });
    expect(byId.get(made[1]!.id)).toMatchObject({ isCurrent: false, supersededById: null });
    expect(byId.get(latest.id)).toMatchObject({ isCurrent: false, supersededById: correctedId });
    expect(byId.get(correctedId)).toMatchObject({ isCurrent: true, supersededById: null });
    // current=true は系列の現在版の1件だけ
    const currentOnly = (await (await fx.client(admin).request("GET", `/api/v1/facilities/${facilityId}/inspections?current=true`)).json()) as { data: { id: string }[] };
    expect(currentOnly.data.map((r) => r.id)).toEqual([correctedId]);
    // 結果での絞り込み・期間（from包含/to排他）
    const onlyReview = (await (await fx.client(admin).request("GET", `/api/v1/facilities/${facilityId}/inspections?result=needs_review`)).json()) as { data: { id: string }[] };
    expect(onlyReview.data.map((r) => r.id)).toEqual([correctedId]);
    const window = (await (await fx.client(admin).request("GET", `/api/v1/facilities/${facilityId}/inspections?from=2026-10-02T01:00:00.000Z&to=2026-10-03T01:00:00.000Z`)).json()) as { data: { id: string }[] };
    expect(window.data.map((r) => r.id)).toEqual([made[1]!.id]);
    // 別unitは存在を明かさない404。壊れたcursorは400
    expect((await fx.client(fx.units.b.people.admin).request("GET", `/api/v1/facilities/${facilityId}/inspections`)).status).toBe(404);
    expect((await fx.client(admin).request("GET", `/api/v1/facilities/${facilityId}/inspections?cursor=not-a-cursor`)).status).toBe(400);
  });

  // --- T085の網羅で見つけた欠落（資産点検の再送・写真。AT-AST-02のCT-04/CT-16） ---
  it("asset_inspection_resend_has_one_effect_and_links_only_ready_photos (T085)", async () => {
    const a = fx.units.a;
    const admin = a.people.admin;
    const t = await seedTemplates(admin);
    const vehicle = await (await fx.client(admin).request("POST", "/api/v1/vehicles", { assetCode: `P-T85-${crypto.randomUUID().slice(0, 4)}`, name: "架空の小型ポンプ車", status: "運用" }, idem())).json() as { data: { id: string } };
    const readyId = await makeUploaded(admin, "inspection");
    await runDueJobs(env);
    expect((await fx.rows("attachments", { id: readyId }))[0]!.status).toBe("ready");
    const body = {
      target: { type: "vehicle", id: vehicle.data.id },
      templateVersionId: t.vehicleVersionId, inspectedAt: "2026-10-14T03:00:00.000Z",
      inspectorMemberId: admin.memberId!, result: "ok",
      checkItems: [{ code: "lights", result: "ok" }], note: "車両点検（写真つき）", createIssue: false, attachmentIds: [readyId],
    };
    const key = { "idempotency-key": crypto.randomUUID() };
    const first = await fx.client(admin).request("POST", "/api/v1/asset-inspections", body, key);
    expect(first.status).toBe(201);
    const firstRow = (await json(first)).data! as { id: string; seriesVersion: number };
    const firstId = firstRow.id;
    // 同じ鍵・同じ本文の再送（応答消失の再試行）は同じ結果で、点検もリンクも増えない
    const again = await fx.client(admin).request("POST", "/api/v1/asset-inspections", body, key);
    expect(again.status).toBe(201);
    expect(((await json(again)).data! as { id: string }).id).toBe(firstId);
    expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM asset_inspections WHERE vehicle_id = ?").bind(vehicle.data.id).first<{ n: number }>())!.n).toBe(1);
    const links = (await fx.rows("attachment_links", { attachment_id: readyId })).filter((l) => l.unlinked_at === null);
    expect(links).toHaveLength(1);
    expect(links[0]!.entity_id).toBe(firstId);
    // 同じ鍵で別の本文は409（別の操作を同じ鍵で通さない）
    const mismatch = await fx.client(admin).request("POST", "/api/v1/asset-inspections", { ...body, note: "別の本文" }, key);
    expect(mismatch.status).toBe(409);
    // 未検査（ready前）の写真は422で、点検は増えない。完了確定（API-84）をしていない添付は検査jobが無く、
    // 背景のQueue consumerでreadyへ進むことも無い（試験の競合を作らない）
    const notReady = await makeNotYetCompleted(admin, "inspection");
    expect((await fx.rows("attachments", { id: notReady }))[0]!.status).not.toBe("ready");
    const rejected = await fx.client(admin).request("POST", "/api/v1/asset-inspections", { ...body, attachmentIds: [notReady] }, idem());
    expect(rejected.status).toBe(422);
    expect(((await json(rejected)).error?.code)).toBe("ATTACHMENT_NOT_READY");
    expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM asset_inspections WHERE vehicle_id = ?").bind(vehicle.data.id).first<{ n: number }>())!.n).toBe(1);

    // 資産の詳細（API-51）の点検履歴: 訂正すると原本は残り、現在版だけが訂正の対象になる（T030の残作業をT085で接続）
    const fixed = await fx.client(admin).request(
      "POST", `/api/v1/inspections/vehicle/${firstId}/corrections`,
      { seriesVersion: firstRow.seriesVersion, supersedesId: firstId, reason: "灯火類の結果を訂正", templateVersionId: t.vehicleVersionId, inspectedAt: "2026-10-14T03:00:00.000Z", inspectorMemberId: admin.memberId!, result: "needs_review", checkItems: [{ code: "lights", result: "needs_review" }], note: "車両点検（訂正）", createIssue: false, attachmentIds: [] },
      idem(),
    );
    expect(fixed.status).toBe(201);
    const fixedId = ((await json(fixed)).data! as { id: string }).id;
    const detail = (await (await fx.client(admin).request("GET", `/api/v1/assets/vehicle/${vehicle.data.id}`)).json()) as { data: { inspections: { id: string; isCurrent: boolean; supersedesId: string | null; result: string; items: { code: string; result: string }[] }[] } };
    expect(detail.data.inspections.map((r) => [r.id, r.isCurrent])).toEqual([[fixedId, true], [firstId, false]]);
    expect(detail.data.inspections[0]).toMatchObject({ supersedesId: firstId, result: "needs_review", items: [{ code: "lights", result: "needs_review" }] });
    expect(detail.data.inspections[1]).toMatchObject({ supersedesId: null, result: "ok", supersededById: fixedId }); // 原本は不変・訂正済み
    // 別分団には存在を明かさない
    expect((await fx.client(fx.units.b.people.admin).request("GET", `/api/v1/assets/vehicle/${vehicle.data.id}`)).status).toBe(404);
  });

  // --- T085の網羅で見つけた欠落（異常の起票・状態変更の再送。AT-AST-03のCT-04） ---
  it("issue_report_and_transition_resend_have_one_effect (T085)", async () => {
    const a = fx.units.a;
    const admin = a.people.admin;
    const facilityId = await seedFacility(a.id, admin.userId);
    const createBody = { target: { type: "facility", id: facilityId }, title: "表示板の破損", description: "架空の点検で見つけた表示板の割れ", attachmentIds: [] };
    const createKey = { "idempotency-key": crypto.randomUUID() };
    const c1 = await fx.client(admin).request("POST", "/api/v1/issues", createBody, createKey);
    const c2 = await fx.client(admin).request("POST", "/api/v1/issues", createBody, createKey);
    expect([c1.status, c2.status]).toEqual([201, 201]);
    const issue = (await json(c1)).data! as { id: string; version: number };
    expect(((await json(c2)).data! as { id: string }).id).toBe(issue.id);
    expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM issues WHERE facility_id = ?").bind(facilityId).first<{ n: number }>())!.n).toBe(1);
    const eventsOf = async () => (await env.DB.prepare("SELECT COUNT(*) AS n FROM issue_events WHERE issue_id = ?").bind(issue.id).first<{ n: number }>())!.n;
    const before = await eventsOf();
    const moveKey = { "idempotency-key": crypto.randomUUID() };
    const move = { version: issue.version, status: "under_review", reason: "確認を始める" };
    const m1 = await fx.client(admin).request("PATCH", `/api/v1/issues/${issue.id}`, move, moveKey);
    const m2 = await fx.client(admin).request("PATCH", `/api/v1/issues/${issue.id}`, move, moveKey);
    expect([m1.status, m2.status]).toEqual([200, 200]);
    expect(((await json(m2)).data! as { version: number }).version).toBe(((await json(m1)).data! as { version: number }).version);
    expect((await eventsOf()) - before).toBe(1); // 再送で履歴は増えない
    // 同じ鍵で別の遷移は409
    expect((await fx.client(admin).request("PATCH", `/api/v1/issues/${issue.id}`, { ...move, status: "in_progress" }, moveKey)).status).toBe(409);
  });
  // --- T085レビューA-I3（T031の既存欠陥）: 訂正の権限は元の原本の実施者で判定する ---
  it("member_cannot_correct_another_members_inspection_or_reassign_the_inspector (T085 A-I3)", async () => {
    const a = fx.units.a;
    const admin = a.people.admin;
    const member = a.people.member;
    const t = await seedTemplates(admin);
    const facilityId = await seedFacility(a.id, admin.userId);
    const countRows = async () => (await env.DB.prepare("SELECT COUNT(*) AS n FROM facility_inspections WHERE facility_id = ?").bind(facilityId).first<{ n: number }>())!.n;
    // 管理者が実施者の点検（他人の点検）
    const others = (await json(await fx.client(admin).request("POST", `/api/v1/facilities/${facilityId}/inspections`,
      facilityInput(t.facilityVersionId, admin.memberId!, { note: "管理者が実施した点検" }), idem()))).data! as { id: string; seriesVersion: number };
    const before = await countRows();
    // 一般団員が実施者欄に自分を書いて他人の点検を訂正しようとする → 403、何も書かれない
    const hijack = await fx.client(member).request("POST", `/api/v1/inspections/facility/${others.id}/corrections`,
      { seriesVersion: others.seriesVersion, supersedesId: others.id, reason: "他人の点検の書換え", ...facilityInput(t.facilityVersionId, member.memberId!, { note: "書換え" }) }, idem());
    expect(hijack.status).toBe(403);
    expect(await countRows()).toBe(before);
    expect((await fx.rows("inspection_series", { facility_id: facilityId }))[0]!.current_facility_inspection_id).toBe(others.id);
    // 本人の点検は本人が訂正できる
    const mine = (await json(await fx.client(member).request("POST", `/api/v1/facilities/${facilityId}/inspections`,
      facilityInput(t.facilityVersionId, member.memberId!, { note: "団員が実施した点検" }), idem()))).data! as { id: string; seriesVersion: number };
    expect(mine).toBeTruthy();
    // 本人の点検でも、実施者を他人に差し替える訂正は403
    const reassign = await fx.client(member).request("POST", `/api/v1/inspections/facility/${mine.id}/corrections`,
      { seriesVersion: mine.seriesVersion, supersedesId: mine.id, reason: "実施者の差替え", ...facilityInput(t.facilityVersionId, admin.memberId!) }, idem());
    expect(reassign.status).toBe(403);
    const own = await fx.client(member).request("POST", `/api/v1/inspections/facility/${mine.id}/corrections`,
      { seriesVersion: mine.seriesVersion, supersedesId: mine.id, reason: "本人の記入誤り", ...facilityInput(t.facilityVersionId, member.memberId!, { note: "訂正後" }) }, idem());
    expect(own.status).toBe(201);
  });
  // --- T085レビューA-I4/D5: 最近の異常を先頭n件で取れる（API-15 order=newest）。AIアシスタントの「記録を添える」が使う ---
  it("issue_list_newest_order_returns_recent_reports_first_and_pages_without_gaps (T085 D5)", async () => {
    const a = fx.units.a;
    const admin = a.people.admin;
    const facilityId = await seedFacility(a.id, admin.userId);
    const ids: string[] = [];
    for (let n = 0; n < 7; n++) {
      const r = await fx.client(admin).request("POST", "/api/v1/issues", { target: { type: "facility", id: facilityId }, title: `並び確認 ${n}`, description: "架空", attachmentIds: [] }, idem());
      ids.push(((await json(r)).data! as { id: string }).id);
      await new Promise((res) => setTimeout(res, 5)); // 作成時刻をずらす
    }
    const q = `targetType=facility&targetId=${facilityId}&status=reported`;
    const first = (await (await fx.client(admin).request("GET", `/api/v1/issues?${q}&order=newest&limit=5`)).json()) as { data: { id: string }[]; meta: { nextCursor?: string } };
    expect(first.data.map((r) => r.id)).toEqual([...ids].reverse().slice(0, 5)); // 最新が先頭（古い順だと最新は5件に入らない）
    const second = (await (await fx.client(admin).request("GET", `/api/v1/issues?${q}&order=newest&limit=5&cursor=${first.meta.nextCursor}`)).json()) as { data: { id: string }[]; meta: { nextCursor?: string } };
    expect(second.data.map((r) => r.id)).toEqual([...ids].reverse().slice(5)); // 続きは重複・欠落なし
    expect(second.meta.nextCursor).toBeUndefined();
    // 既定（oldest）は従来どおり古い順
    const oldest = (await (await fx.client(admin).request("GET", `/api/v1/issues?${q}&limit=5`)).json()) as { data: { id: string }[]; meta: { nextCursor: string } };
    expect(oldest.data.map((r) => r.id)).toEqual(ids.slice(0, 5));
    // 並びの違うcursorは400（取り違えた続きを返さない）
    expect((await fx.client(admin).request("GET", `/api/v1/issues?${q}&order=newest&cursor=${oldest.meta.nextCursor}`)).status).toBe(400);
  });
  // --- T085レビューA-m3: 「転送と完了確定は済んだが検査がまだ」の添付も422（決定的に作る: 完了確定の後、
  //     検査jobを取り消して状態をuploaded／checkingへ戻す。背景のQueue consumerにreadyへ進められない） ---
  it("completed_but_not_yet_scanned_attachment_is_rejected (T085 A-m3)", async () => {
    const a = fx.units.a;
    const admin = a.people.admin;
    const t = await seedTemplates(admin);
    const facilityId = await seedFacility(a.id, admin.userId);
    for (const state of ["uploaded", "checking"] as const) {
      const id = await makeUploaded(admin, "inspection"); // 転送＋完了確定（検査jobが登録される）
      await env.DB.prepare("UPDATE jobs SET status = 'cancelled' WHERE source_id = ? AND status IN ('queued', 'running', 'retry_wait')").bind(id).run();
      // 版も進める（既に走り出した検査jobが後から確定しようとしても元版不一致でstaleになり、readyへ進めない）
      await env.DB.prepare("UPDATE attachments SET status = ?, ready_key = NULL, version = version + 1 WHERE id = ?").bind(state, id).run();
      const before = (await env.DB.prepare("SELECT COUNT(*) AS n FROM facility_inspections").first<{ n: number }>())!.n;
      const res = await fx.client(admin).request("POST", `/api/v1/facilities/${facilityId}/inspections`,
        facilityInput(t.facilityVersionId, admin.memberId!, { attachmentIds: [id] }), idem());
      expect(res.status, state).toBe(422);
      expect((await json(res)).error?.code, state).toBe("ATTACHMENT_NOT_READY");
      expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM facility_inspections").first<{ n: number }>())!.n).toBe(before);
      expect(await fx.rows("attachment_links", { attachment_id: id })).toHaveLength(0);
    }
  });
  // --- T085裁定R17（レビューN3）: 訂正での異常の二重起票はサーバーでも拒否する（API-46直接・同期API-81も同じ組立て関数） ---
  it("correction_cannot_raise_a_second_issue_for_a_finding_already_raised (T085 R17)", async () => {
    const a = fx.units.a;
    const admin = a.people.admin;
    const t = await seedTemplates(admin);
    const facilityId = await seedFacility(a.id, admin.userId);
    const issuesOf = async () => (await env.DB.prepare("SELECT COUNT(*) AS n FROM issues WHERE facility_id = ?").bind(facilityId).first<{ n: number }>())!.n;
    const review = { result: "needs_review", checkItems: [{ code: "exterior", result: "needs_review" }] };
    // 異常ありの原本（起点の異常が1件）
    const made = (await json(await fx.client(admin).request("POST", `/api/v1/facilities/${facilityId}/inspections`,
      facilityInput(t.facilityVersionId, admin.memberId!, { ...review, createIssue: true, note: "異常ありの原本" }), idem()))).data! as { id: string; seriesVersion: number };
    expect(await issuesOf()).toBe(1);
    // 同じ所見の訂正でcreateIssue=true → 422（issue_already_raised）。何も書かれない
    const dup = await fx.client(admin).request("POST", `/api/v1/inspections/facility/${made.id}/corrections`,
      { seriesVersion: made.seriesVersion, supersedesId: made.id, reason: "メモの追記", ...facilityInput(t.facilityVersionId, admin.memberId!, { ...review, createIssue: true, note: "追記" }) }, idem());
    expect(dup.status).toBe(422);
    expect(((await json(dup)).error?.details ?? []).some((d) => d.field === "createIssue" && d.reason === "issue_already_raised")).toBe(true);
    expect(await issuesOf()).toBe(1);
    expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM facility_inspections WHERE facility_id = ?").bind(facilityId).first<{ n: number }>())!.n).toBe(1);
    // 起票なしの訂正は通る
    const fixed = await fx.client(admin).request("POST", `/api/v1/inspections/facility/${made.id}/corrections`,
      { seriesVersion: made.seriesVersion, supersedesId: made.id, reason: "メモの追記", ...facilityInput(t.facilityVersionId, admin.memberId!, { ...review, createIssue: false, note: "追記" }) }, idem());
    expect(fixed.status).toBe(201);
    const fixedRow = (await json(fixed)).data! as { id: string; seriesVersion: number };
    // 系譜の先（訂正の訂正）でも、元の所見の異常があるので起票は拒否
    const again = await fx.client(admin).request("POST", `/api/v1/inspections/facility/${fixedRow.id}/corrections`,
      { seriesVersion: fixedRow.seriesVersion, supersedesId: fixedRow.id, reason: "再訂正", ...facilityInput(t.facilityVersionId, admin.memberId!, { ...review, createIssue: true, note: "再訂正" }) }, idem());
    expect(again.status).toBe(422);
    expect(await issuesOf()).toBe(1);
    // 良好の原本を異常ありへ訂正するときは起票できる
    const facility2 = await seedFacility(a.id, admin.userId);
    const okOriginal = (await json(await fx.client(admin).request("POST", `/api/v1/facilities/${facility2}/inspections`,
      facilityInput(t.facilityVersionId, admin.memberId!, { note: "良好の原本" }), idem()))).data! as { id: string; seriesVersion: number };
    const raise = await fx.client(admin).request("POST", `/api/v1/inspections/facility/${okOriginal.id}/corrections`,
      { seriesVersion: okOriginal.seriesVersion, supersedesId: okOriginal.id, reason: "見落とし", ...facilityInput(t.facilityVersionId, admin.memberId!, { ...review, createIssue: true, note: "異常を見落としていた" }) }, idem());
    expect(raise.status).toBe(201);
    expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM issues WHERE facility_id = ?").bind(facility2).first<{ n: number }>())!.n).toBe(1);
  });

  // --- T085裁定R18: 元の実施者が休団・退団でも、訂正は元の実施者を保って通す（訂正した人は監査に別に残る） ---
  it("correction_keeps_an_inactive_original_inspector (T085 R18)", async () => {
    const a = fx.units.a;
    const admin = a.people.admin;
    const t = await seedTemplates(admin);
    const facilityId = await seedFacility(a.id, admin.userId);
    const inspector = a.people.officer.memberId!;
    const made = (await json(await fx.client(admin).request("POST", `/api/v1/facilities/${facilityId}/inspections`,
      facilityInput(t.facilityVersionId, inspector, { note: "幹部が実施" }), idem()))).data! as { id: string; seriesVersion: number };
    await env.DB.prepare("UPDATE members SET status = 'paused' WHERE id = ?").bind(inspector).run();
    try {
      const keep = await fx.client(admin).request("POST", `/api/v1/inspections/facility/${made.id}/corrections`,
        { seriesVersion: made.seriesVersion, supersedesId: made.id, reason: "記入の誤り", ...facilityInput(t.facilityVersionId, inspector, { note: "訂正" }) }, idem());
      expect(keep.status).toBe(201);
      const corrected = (await json(keep)).data! as { id: string; inspectorMemberId: string; seriesVersion: number };
      expect(corrected.inspectorMemberId).toBe(inspector); // 実施者は元のまま
      const audit = await env.DB.prepare("SELECT actor_user_id FROM audit_logs WHERE entity_id = ? ORDER BY occurred_at DESC LIMIT 1").bind(corrected.id).first<{ actor_user_id: string }>();
      expect(audit?.actor_user_id).toBe(admin.userId); // 訂正した人は監査に残る
      // 休団中の別の団員へ実施者を差し替える訂正は従来どおり422（例外は「元の実施者を保つ」ときだけ）
      const other = a.people.operator.memberId!;
      await env.DB.prepare("UPDATE members SET status = 'paused' WHERE id = ?").bind(other).run();
      const swap = await fx.client(admin).request("POST", `/api/v1/inspections/facility/${corrected.id}/corrections`,
        { seriesVersion: corrected.seriesVersion, supersedesId: corrected.id, reason: "差替え", ...facilityInput(t.facilityVersionId, other) }, idem());
      expect(swap.status).toBe(422);
      expect(((await json(swap)).error?.details ?? []).some((d) => d.reason === "inspector_not_active")).toBe(true);
    } finally {
      await env.DB.prepare("UPDATE members SET status = 'active' WHERE id IN (?, ?)").bind(inspector, a.people.operator.memberId!).run();
    }
  });
});
