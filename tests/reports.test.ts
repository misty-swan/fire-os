import { env } from "cloudflare:workers";
import { applyD1Migrations } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import { getReportTemplate } from "../src/server/reports/templates";
import { createFixture, type TestFixture } from "./helpers/fixture";

let fx: TestFixture;
beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
  fx = await createFixture("two-units");
});

const idem = () => ({ "idempotency-key": crypto.randomUUID() });
const json = async (r: Response) =>
  (await r.json()) as { data?: Record<string, unknown>; error?: { code: string; details?: { field: string; reason: string }[] } };

/** 実績の現行版（root版・訂正番号）を読む（source_versionsの期待値組み立て用） */
async function loadResult(activityId: string) {
  const root = (await fx.rows("activity_results", { activity_id: activityId }))[0]!;
  const revision = (await fx.rows("activity_result_revisions", { id: root.current_revision_id as string }))[0]!;
  return { rootVersion: root.version as number, revisionNo: revision.revision_no as number, rootId: root.id as string };
}

describe("帳票様式artifactと手動下書き・不変版 (T056)", () => {
  it("report_template_is_allowlisted_and_old_versions_immutable", async () => {
    const a = fx.units.a;
    const admin = a.people.admin; // 幹部（PER-04/10/11所属内。手動帳票の作成と改版）
    const officer = a.people.officer; // 予定の担当owner（帳票の担当＝activity owner）
    const member = a.people.member; // 一般団員（PER-11は全役割だが、帳票の担当ではない）

    // --- 準備: 公開済みの予定と実績（T035/T037の流儀。docs/05 API-06/39/09） ---
    const createRes = await fx.client(admin).request("POST", "/api/v1/activities", {
      title: "秋季の水防訓練（報告書用）",
      kind: "訓練",
      plannedStartsAt: "2026-10-21T01:00:00.000Z",
      plannedEndsAt: "2026-10-21T04:00:00.000Z",
      locationText: "架空市堤防",
      ownerMemberId: officer.memberId!,
      audienceMemberIds: [officer.memberId!, member.memberId!],
    }, idem());
    expect(createRes.status).toBe(201);
    const activityId = ((await json(createRes)).data! as { id: string }).id;
    expect((await fx.client(admin).request("PATCH", `/api/v1/activities/${activityId}`, {
      version: 1, status: "scheduled", reason: "対象を確定して公開",
    }, idem())).status).toBe(200);

    const actualRes = await fx.client(admin).request("POST", `/api/v1/activities/${activityId}/actual-results`, {
      activityVersion: 2,
      content: "堤防の巡視と水防訓練を実施。",
      actualStartsAt: "2026-10-21T01:10:00.000Z",
      participants: [{ memberId: member.memberId!, actualStatus: "participated" }],
      attachmentIds: [],
    }, idem());
    expect(actualRes.status).toBe(201);
    const result1 = await loadResult(activityId);
    expect(result1.revisionNo).toBe(1);

    // サーバーがsource_versionsへ記録する期待値（作成時点の実績・予定の版。docs/16 T056「数値は実績からサーバー計算」）
    const activityVersionNow = (await fx.rows("activities", { id: activityId }))[0]!.version as number;
    const expectedSourceVersions = {
      activityVersion: activityVersionNow,
      resultVersion: result1.rootVersion,
      resultRevisionNo: result1.revisionNo,
    };

    // --- 1) 手動下書き（API-62。AI停止でも人の入力で帳票を作れる。docs/05 API-62） ---
    const manual = await fx.client(admin).request("POST", "/api/v1/reports/manual", {
      activityId,
      resultVersion: result1.rootVersion,
      templateVersion: "test-activity-v1",
      text: "参加人数1名。堤防の巡視と水防訓練を実施した。",
    }, idem());
    expect(manual.status).toBe(201);
    const report = (await json(manual)).data! as {
      report: { id: string; version: number; currentDraftVersionId: string };
      versions: { id: string; revisionNo: number; status: string; templateVersion: string }[];
    };
    expect(report.versions).toHaveLength(1);
    expect(report.versions[0]!.status).toBe("draft");
    expect(report.versions[0]!.templateVersion).toBe("test-activity-v1");
    expect(report.report.currentDraftVersionId).toBe(report.versions[0]!.id);

    // source_versionsはサーバーが読んだ実績の版（人の入力を信用しない。元実績の更新を検出できる）
    const sourceVersions = JSON.parse(
      (await fx.rows("report_versions", { id: report.versions[0]!.id }))[0]!.source_versions as string,
    );
    expect(sourceVersions).toEqual(expectedSourceVersions);

    // --- 2) 未知のtemplateVersionは422（allowlist外の受理をしない。docs/04 §3.5「存在しない版は422」） ---
    const unknownTemplate = await fx.client(admin).request("POST", "/api/v1/reports/manual", {
      activityId,
      resultVersion: result1.rootVersion,
      templateVersion: "unknown-v99",
      text: "許可されていない様式版。",
    }, idem());
    expect(unknownTemplate.status).toBe(422);
    expect((await json(unknownTemplate)).error?.code).toBe("UNAPPROVED_POLICY");

    // --- 3) 編集は新draft版を作り旧版は不変（docs/11「差戻し後/承認後訂正は新draft版、旧版不変」） ---
    const oldTextBefore = (await fx.rows("report_versions", { id: report.versions[0]!.id }))[0]!.text as string;
    const edit = await fx.client(admin).request("POST", `/api/v1/reports/${report.report.id}/versions`, {
      version: report.report.version,
      text: "改稿: 巡視で異常なしを確認。",
      missingFields: [],
      sourceVersions: {},
      reason: "内容を補正",
    }, idem());
    expect(edit.status).toBe(201);
    const v2 = (await json(edit)).data! as { id: string; revisionNo: number; status: string };
    expect(v2.revisionNo).toBe(2);
    expect(v2.id).not.toBe(report.versions[0]!.id);
    expect(v2.status).toBe("draft");

    const oldTextAfter = (await fx.rows("report_versions", { id: report.versions[0]!.id }))[0]!.text as string;
    expect(oldTextAfter).toBe(oldTextBefore);
    // DBでも旧版の本文は書換え不可（トリガー。docs/04:147「編集/承認版不変」）
    await expect(
      env.DB.prepare("UPDATE report_versions SET text = '改竄' WHERE id = ?").bind(report.versions[0]!.id).run(),
    ).rejects.toThrow(/immutable/);

    // --- 4) 元実績の更新を検出できる（source_versionsは作成時の版を指したまま。版の一致検査でずれが分かる） ---
    const correctRes = await fx.client(admin).request("POST", `/api/v1/activities/${activityId}/actual-results/corrections`, {
      resultVersion: result1.rootVersion,
      content: "堤防の巡視と水防訓練を実施（訂正）。",
      participants: [{ memberId: member.memberId!, actualStatus: "participated" }],
      attachmentIds: [],
      reason: "文言の訂正",
    }, idem());
    expect(correctRes.status).toBe(201);
    const result2 = await loadResult(activityId);
    expect(result2.revisionNo).toBe(2);
    const sourceVersionsAfterResultUpdate = JSON.parse(
      (await fx.rows("report_versions", { id: report.versions[0]!.id }))[0]!.source_versions as string,
    );
    expect(sourceVersionsAfterResultUpdate).toEqual(expectedSourceVersions);
    expect(sourceVersionsAfterResultUpdate.resultRevisionNo).not.toBe(result2.revisionNo);

    // --- 5) 未承認版は担当のみ（docs/05 API-58。担当=作成者＋activity担当owner。担当外はnot 200） ---
    const unapprovedViewer = await fx.client(member).request("GET", `/api/v1/reports/${report.report.id}`);
    expect(unapprovedViewer.status).not.toBe(200);
    // 担当（作成者＝admin／activity担当owner＝officer）は読める
    expect((await fx.client(admin).request("GET", `/api/v1/reports/${report.report.id}`)).status).toBe(200);
    expect((await fx.client(officer).request("GET", `/api/v1/reports/${report.report.id}`)).status).toBe(200);
    const officerView = (await json(
      await fx.client(officer).request("GET", `/api/v1/reports/${report.report.id}`),
    )).data! as { versions: { revisionNo: number; text: string }[] };
    expect(officerView.versions).toHaveLength(2); // 担当は旧版・新版の両方（docs/05「revision?;旧版も」の系列）

    // --- 様式artifactのallowlist・hash固定（docs/04 §3.5末尾。route経由の422と同じ規則の直接確認） ---
    const template = await getReportTemplate("test-activity-v1");
    expect(template.id).toBe("test-activity");
    expect(template.version).toBe("test-activity-v1");
    expect(template.hash).toMatch(/^[0-9a-f]{64}$/);
    expect(template.sourceRef).toContain("架空"); // 原様式参照は架空名（実団体の様式を示さない）
    expect(template.fictionalNote).toContain("実在の団体"); // 実団体承認済みと表示しない注記（docs/14 D06/D20）
    expect(template.fieldSchema.map((f) => f.code)).toContain("participantCount");
    await expect(getReportTemplate("unknown-v99")).rejects.toMatchObject({ code: "UNAPPROVED_POLICY" });
  });
  // --- T085の網羅で見つけた欠落（帳票の作成・改版の再送。AT-DOC-02のCT-04） ---
  it("manual_draft_and_new_version_resend_have_one_effect (T085)", async () => {
    const admin = fx.units.a.people.admin;
    const member = fx.units.a.people.member;
    const created = await fx.client(admin).request("POST", "/api/v1/activities", {
      title: "架空の夜警（再送確認）", kind: "夜警", plannedStartsAt: "2026-10-22T10:00:00.000Z",
      locationText: "架空市詰所", ownerMemberId: admin.memberId!, audienceMemberIds: [member.memberId!],
    }, idem());
    const activityId = ((await json(created)).data! as { id: string }).id;
    await fx.client(admin).request("PATCH", `/api/v1/activities/${activityId}`, { version: 1, status: "scheduled", reason: "公開" }, idem());
    await fx.client(admin).request("POST", `/api/v1/activities/${activityId}/actual-results`, {
      activityVersion: 2, content: "夜警を実施。", actualStartsAt: "2026-10-22T10:05:00.000Z",
      participants: [{ memberId: member.memberId!, actualStatus: "participated" }], attachmentIds: [],
    }, idem());
    const result = await loadResult(activityId);
    const body = { activityId, resultVersion: result.rootVersion, templateVersion: "test-activity-v1", text: "夜警を実施した（再送確認）。" };
    const key = { "idempotency-key": crypto.randomUUID() };
    const m1 = await fx.client(admin).request("POST", "/api/v1/reports/manual", body, key);
    const m2 = await fx.client(admin).request("POST", "/api/v1/reports/manual", body, key);
    expect([m1.status, m2.status]).toEqual([201, 201]);
    const report = ((await json(m1)).data! as { report: { id: string; version: number } }).report;
    expect(((await json(m2)).data! as { report: { id: string } }).report.id).toBe(report.id);
    expect(await fx.rows("reports", { activity_id: activityId })).toHaveLength(1);
    // 改版の再送も版を1つしか作らない（応答消失後の再試行で第3版が生まれない）
    const edit = { version: report.version, text: "夜警を実施。異常なし。", missingFields: [], sourceVersions: {}, reason: "追記" };
    const editKey = { "idempotency-key": crypto.randomUUID() };
    const e1 = await fx.client(admin).request("POST", `/api/v1/reports/${report.id}/versions`, edit, editKey);
    const e2 = await fx.client(admin).request("POST", `/api/v1/reports/${report.id}/versions`, edit, editKey);
    expect([e1.status, e2.status]).toEqual([201, 201]);
    expect(((await json(e2)).data! as { id: string }).id).toBe(((await json(e1)).data! as { id: string }).id);
    expect(await fx.rows("report_versions", { report_id: report.id })).toHaveLength(2);
    // 同じ鍵で別の本文は409
    expect((await fx.client(admin).request("POST", `/api/v1/reports/${report.id}/versions`, { ...edit, text: "別の本文" }, editKey)).status).toBe(409);
  });
});
