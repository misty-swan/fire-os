import { env } from "cloudflare:workers";
import { applyD1Migrations } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import { validateItems } from "../src/server/inspections/validate-items";
import { createFixture, type Identity, type TestFixture } from "./helpers/fixture";

let fx: TestFixture;
beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
  fx = await createFixture("two-units");
});

const idem = () => ({ "idempotency-key": crypto.randomUUID() });
const json = async (r: Response) => (await r.json()) as { data?: Record<string, unknown>; error?: { code: string; details?: { field: string; reason: string }[] } };

/** 架空の様式（検証設定。正式点検票ではない） */
const facilitySchema = [
  { code: "exterior", label: "本体の外観", valueType: "select", required: true, allowedResults: ["良好", "要補修"] },
  { code: "water_level", label: "水位", valueType: "number", required: false },
] as const;
const vehicleSchema = [{ code: "lights", label: "灯火類", valueType: "select", required: true, allowedResults: ["良好", "要補修"] }] as const;

async function createTemplate(who: Identity, name: string, targetType: "facility" | "vehicle" | "equipment", schema: readonly unknown[]) {
  const res = await fx.client(who).request("POST", "/api/v1/inspection-templates", { name, targetType, itemSchema: schema }, idem());
  const data = (await json(res)).data as { id: string; version: number; versions: { id: string; revisionNo: number }[] } | undefined;
  return { status: res.status, versionId: data?.versions[0]?.id as string, id: data?.id as string, version: data?.version as number };
}

describe("点検様式の版と承認 (T027)", () => {
  it("approved_template_is_immutable_and_required_items_enforced", async () => {
    const a = fx.units.a;
    const admin = a.people.admin;
    const officer = a.people.officer;

    // 施設用と車両用の様式を作る（重複codeは契約が400で拒否する）
    const dupCode = await fx.client(admin).request(
      "POST", "/api/v1/inspection-templates",
      { name: "壊れた様式", targetType: "facility", itemSchema: [
        { code: "x", label: "x", valueType: "text", required: true },
        { code: "x", label: "x2", valueType: "text", required: false },
      ] }, idem(),
    );
    expect(dupCode.status).toBe(400);

    const facility = await createTemplate(admin, "消防水利点検（検証用）", "facility", facilitySchema);
    expect(facility.status).toBe(201);
    const vehicle = await createTemplate(officer, "車両点検（検証用）", "vehicle", vehicleSchema);
    expect(vehicle.status).toBe(201);
    const templateId = facility.id;
    const v1 = { id: facility.versionId };

    // 申請 → 承認（PER-10。幹部・管理者）
    const request = await fx.client(officer).request(
      "POST", `/api/v1/inspection-templates/${templateId}/decision`,
      { version: 1, templateVersionId: v1.id, decision: "request_review", reason: "様式の確認をお願いします" }, idem(),
    );
    expect(request.status).toBe(200);
    const approve = await fx.client(admin).request(
      "POST", `/api/v1/inspection-templates/${templateId}/decision`,
      { version: 2, templateVersionId: v1.id, decision: "approve", reason: "内容を確認した" }, idem(),
    );
    expect(approve.status).toBe(200);
    const approvedSchemaBefore = ((await json(approve)).data!.itemSchema as unknown[]).length;

    // 二重承認は409（同じ版への並行の決定。承認済みの版への新しい決定は422になる）
    const duplicateDecision = await fx.client(admin).request(
      "POST", `/api/v1/inspection-templates/${templateId}/decision`,
      { version: 2, templateVersionId: v1.id, decision: "approve", reason: "もう一度" }, idem(),
    );
    expect(duplicateDecision.status).toBe(409);
    // 二重承認はrootの版ガード（version=2は既に消化済み）でVERSION_CONFLICT
    expect((await json(duplicateDecision)).error?.code).toBe("VERSION_CONFLICT");

    // 承認済みの版は不変（DBトリガー）。直接のUPDATE/DELETEも拒否される
    const approvedSchemaAfter = (await fx.rows("inspection_template_versions", { id: v1.id }))[0]!.item_schema as string;
    expect(JSON.parse(approvedSchemaAfter)).toHaveLength(approvedSchemaBefore);
    await expect(env.DB.prepare("UPDATE inspection_template_versions SET item_schema = '[]' WHERE id = ?").bind(v1.id).run())
      .rejects.toThrow(/immutable/);
    await expect(env.DB.prepare("DELETE FROM inspection_template_versions WHERE id = ?").bind(v1.id).run())
      .rejects.toThrow(/immutable/);

    // 改版: 新しい下書き版（承認済み版のschemaは変わらない）。申請/承認の決定でも様式rootの版は進む
    const templateVersionNow = ((await fx.rows("inspection_templates", { id: templateId }))[0]!.version) as number;
    const newVersion = await fx.client(admin).request(
      "POST", `/api/v1/inspection-templates/${templateId}/versions`,
      { version: templateVersionNow, itemSchema: [...facilitySchema, { code: "note2", label: "備考", valueType: "text", required: false }], reason: "備考欄を追加" }, idem(),
    );
    expect(newVersion.status).toBe(201);
    const v2 = (await json(newVersion)).data! as { id: string; revisionNo: number };
    expect(v2.revisionNo).toBe(2);
    expect(v2.id).not.toBe(v1.id);
    expect(JSON.parse((await fx.rows("inspection_template_versions", { id: v1.id }))[0]!.item_schema as string)).toHaveLength(approvedSchemaBefore);

    // 対象種別の一致: 施設用の様式は車両に使えない（T029/T030の点検保存で422。ここではvalidateItemsの単体で規則を固定）
    const wrongTargetCheck = validateItems(JSON.parse((await fx.rows("inspection_template_versions", { id: v1.id }))[0]!.item_schema as string), [
      { code: "lights", result: "良好" }, // 車両用の項目。施設用の様式には無い
    ]);
    expect(wrongTargetCheck.valid).toBe(false);
    // 別の様式の版IDでAPI-97を呼ぶと404（他様式の版はこの様式の決定対象にならない。版の状態も変わらない）
    const wrongTargetTemplate = await fx.client(admin).request(
      "POST", `/api/v1/inspection-templates/${templateId}/decision`,
      { version: 2, templateVersionId: vehicle.versionId, decision: "approve", reason: "別様式の版を承認しようとする" }, idem(),
    );
    expect(wrongTargetTemplate.status).toBe(404);
    expect(((await json(wrongTargetTemplate)).error?.code)).toBe("NOT_FOUND");
    expect((await fx.rows("inspection_template_versions", { id: vehicle.versionId }))[0]!.status).toBe("draft");

    // 必須明細の検査（T029の保存でも同じ関数を使う）
    const schema = JSON.parse((await fx.rows("inspection_template_versions", { id: v1.id }))[0]!.item_schema as string) as Parameters<typeof validateItems>[0];
    const missingRequired = validateItems(schema, [{ code: "water_level", result: "ok", value: 3 }]); // exterior が無い
    expect(missingRequired.valid).toBe(false);
    expect(missingRequired.errors.map((e) => e.reason)).toContain("required_item_missing");
    const typeMismatch = validateItems(schema, [
      { code: "exterior", result: "良好" },
      { code: "water_level", result: "ok", value: "三メートル" }, // numberの項目に文字列
    ]);
    expect(typeMismatch.valid).toBe(false);
    expect(typeMismatch.errors.map((e) => e.reason)).toContain("value_type_mismatch");
    const okItems = validateItems(schema, [
      { code: "exterior", result: "良好" },
      { code: "water_level", result: "ok", value: 3 },
    ]);
    expect(okItems.valid).toBe(true);

    // 権限: 一般団員は様式を作れない（PER-03）。承認は幹部以上（PER-10）
    const byMember = await fx.client(a.people.member).request(
      "POST", "/api/v1/inspection-templates", { name: "x", targetType: "equipment", itemSchema: vehicleSchema }, idem(),
    );
    expect(byMember.status).toBe(403);
    const memberApprove = await fx.client(a.people.member).request(
      "POST", `/api/v1/inspection-templates/${vehicle.id}/decision`,
      { version: 1, templateVersionId: vehicle.versionId, decision: "approve", reason: "x" }, idem(),
    );
    expect(memberApprove.status).toBe(403);

    // 一覧（API-94）: 対象種別で絞れる
    const list = await fx.client(admin).request("GET", "/api/v1/inspection-templates?targetType=facility");
    expect(list.status).toBe(200);
    const listData = ((await json(list)).data ?? []) as { id: string }[];
    expect(listData.some((t) => t.id === templateId)).toBe(true);
    expect(listData.every((t) => t.id !== vehicle.id)).toBe(true);
  });

  it("unapproved_template_version_rejects_inspection_save", async () => {
    const a = fx.units.a;
    const admin = a.people.admin;

    // 点検先の施設（直接用意する）
    const facilityId = crypto.randomUUID();
    const now = new Date().toISOString();
    await env.DB.prepare(
      "INSERT INTO facilities (id, unit_id, type, management_number, latitude, longitude, location_note, location_source, created_at, updated_at, created_by, actor_kind) " +
        "VALUES (?, ?, 'hydrant', ?, 35, 139, 'x', '架空台帳', ?, ?, ?, 'human')",
    ).bind(facilityId, a.id, `T027-${facilityId.slice(0, 6)}`, now, now, admin.userId).run();

    // 契約の点検結果の語彙で承認を進める様式（docs/05 InspectionInput）
    const schema = [{ code: "exterior", label: "本体の外観", valueType: "select", required: true, allowedResults: ["ok", "needs_review"] }];
    const template = await createTemplate(admin, "承認前試験の様式", "facility", schema);
    expect(template.status).toBe(201);
    const input = {
      templateVersionId: template.versionId, inspectedAt: "2026-10-14T07:00:00.000Z", inspectorMemberId: admin.memberId!,
      result: "ok", checkItems: [{ code: "exterior", result: "ok" }], note: "未承認様式での保存試験", createIssue: false, attachmentIds: [],
    };

    // draftの版では保存できない（422 INVALID_TRANSITION。docs/16 T027完了条件「未承認版での点検保存は422」）
    const draftSave = await fx.client(admin).request("POST", `/api/v1/facilities/${facilityId}/inspections`, input, idem());
    expect(draftSave.status).toBe(422);
    expect(((await json(draftSave)).error?.details ?? []).some((d) => d.reason === "template_not_approved")).toBe(true);
    // 点検も増えていない
    expect(await fx.rows("facility_inspections", { facility_id: facilityId })).toHaveLength(0);

    // in_reviewでも保存できない
    await fx.client(admin).request(
      "POST", `/api/v1/inspection-templates/${template.id}/decision`,
      { version: 1, templateVersionId: template.versionId, decision: "request_review", reason: "確認のお願い" }, idem(),
    );
    const inReviewSave = await fx.client(admin).request("POST", `/api/v1/facilities/${facilityId}/inspections`, input, idem());
    expect(inReviewSave.status).toBe(422);
    expect(await fx.rows("facility_inspections", { facility_id: facilityId })).toHaveLength(0);

    // 承認後は保存できる
    await fx.client(admin).request(
      "POST", `/api/v1/inspection-templates/${template.id}/decision`,
      { version: 2, templateVersionId: template.versionId, decision: "approve", reason: "内容を確認した" }, idem(),
    );
    const approvedSave = await fx.client(admin).request("POST", `/api/v1/facilities/${facilityId}/inspections`, input, idem());
    expect(approvedSave.status).toBe(201);
    expect(await fx.rows("facility_inspections", { facility_id: facilityId })).toHaveLength(1);
  });
});
