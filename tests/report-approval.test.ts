import { env } from "cloudflare:workers";
import { applyD1Migrations } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import { createFixture, type Identity, type TestFixture } from "./helpers/fixture";

/**
 * 報告書の申請・承認・差戻し・承認版出力（T058、docs/11 報告書/文書版、docs/05 API-60/61）。
 *
 * docs/11の核心: 申請（request_review）はcontent_version_eventsへの追記だけで、
 * 決定行（review_decisions）は作らない＝最終決定を消費しない。審査の最終決定（approve）は
 * review_decisionsのreport_version_id非NULL UNIQUEで一版一回（二重approveは409）。
 * 差戻し後・承認後の訂正は新draft版（旧版不変）、承認済pointerは次版承認まで保持。
 * 承認時は元実績版を再検査（source_versionsと現行の不一致は409）。
 * 出力（API-61）は承認版のみ（未承認はnot 200）。
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

const versionRow = async (versionId: string) => (await fx.rows("report_versions", { id: versionId }))[0]!;
const reportRow = async (reportId: string) => (await fx.rows("reports", { id: reportId }))[0]!;
const savedSourceVersions = async (versionId: string) =>
  JSON.parse((await versionRow(versionId)).source_versions as string) as Record<string, number>;

describe("報告書の申請・承認・差戻し・承認版出力 (T058)", () => {
  it("submission_does_not_consume_final_decision_and_export_requires_approval", async () => {
    const a = fx.units.a;
    const admin = a.people.admin; // 幹部（作成＋PER-10の承認。unitWide）
    const officer = a.people.officer; // 予定の担当owner
    const member = a.people.member; // 一般団員（PER-11は全員。担当ではない）

    // --- 準備: 公開済みの予定と実績（T035/T037の流儀。参加は1名。CSV注入試験用にactivity名は=で始める） ---
    const createRes = await fx.client(admin).request("POST", "/api/v1/activities", {
      title: "=セル注入試験の活動（架空）",
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
      actualEndsAt: "2026-10-21T03:40:00.000Z",
      participants: [{ memberId: member.memberId!, actualStatus: "participated" }],
      attachmentIds: [],
    }, idem());
    expect(actualRes.status).toBe(201);

    const createReport = async () => fx.client(admin).request("POST", "/api/v1/reports/manual", {
      activityId,
      resultVersion: (await fx.rows("activity_results", { activity_id: activityId }))[0]!.version as number,
      templateVersion: "test-activity-v1",
      text: "参加人数は90名の大規模訓練（本文の数値は出力に使わない）。",
    }, idem());
    const manual = await createReport();
    expect(manual.status).toBe(201);
    const report1 = (await json(manual)).data! as {
      report: { id: string; version: number; currentDraftVersionId: string };
      versions: { id: string }[];
    };
    const v1 = report1.versions[0]!.id;

    /** API-60の入力（versionは帳票rootの現行版。reportVersionは対象版のrevision_no） */
    const decide = (reportId: string, body: Record<string, unknown>, who: Identity = admin) =>
      fx.client(who).request("POST", `/api/v1/reports/${reportId}/decision`, body, idem());

    // --- 1) 申請（request_review）: draft→in_review。content_version_eventsへ追記、決定行は作らない ---
    const submit = await decide(report1.report.id, {
      version: report1.report.version,
      reportVersion: 1,
      decision: "request_review",
      sourceVersions: await savedSourceVersions(v1),
      reason: "訓練が終了したため申請します",
    });
    expect(submit.status).toBe(200);
    expect((await versionRow(v1)).status).toBe("in_review");
    const requestEvents = await fx.rows("content_version_events", { report_version_id: v1, action: "request_review" });
    expect(requestEvents).toHaveLength(1);

    // 申請は最終決定（review_decisions）を作らない＝決定を消費しない（docs/11の核心）
    const submissionFinalDecisions = (await fx.rows("review_decisions", { report_version_id: v1 })).length;
    expect(submissionFinalDecisions).toBe(0);

    // in_reviewからの二重申請は422（許可外遷移。docs/11 §1）
    const resubmit = await decide(report1.report.id, {
      version: report1.report.version,
      reportVersion: 1,
      decision: "request_review",
      sourceVersions: await savedSourceVersions(v1),
      reason: "二重申請",
    });
    expect(resubmit.status).toBe(422);
    expect((await json(resubmit)).error?.code).toBe("INVALID_TRANSITION");

    // --- 2) 差戻し（changes_requested）: in_review→changes_requested。決定行は作らない（eventsに記録） ---
    const currentRootVersion = async () => (await reportRow(report1.report.id)).version as number;
    const requestChanges = await decide(report1.report.id, {
      version: await currentRootVersion(),
      reportVersion: 1,
      decision: "changes_requested",
      sourceVersions: await savedSourceVersions(v1),
      reason: "実施内容の記載が不足しています",
    });
    if (requestChanges.status !== 200) console.error("DBG changes_requested:", JSON.stringify(await json(requestChanges)));
    expect(requestChanges.status).toBe(200);
    expect((await versionRow(v1)).status).toBe("changes_requested");
    expect((await fx.rows("content_version_events", { report_version_id: v1, action: "changes_requested" }))).toHaveLength(1);
    expect((await fx.rows("review_decisions", { report_version_id: v1 })).length).toBe(0);

    // changes_requestedは終端（docs/11 contentVersionTransitions）。再決定は422
    const reDecide = await decide(report1.report.id, {
      version: await currentRootVersion(),
      reportVersion: 1,
      decision: "changes_requested",
      sourceVersions: await savedSourceVersions(v1),
      reason: "二重差戻し",
    });
    expect(reDecide.status).toBe(422);

    // --- 3) 承認版が無い帳票は出力できない（未承認はnot 200。docs/05 API-61「承認版のみ」） ---
    const unapprovedExport = await fx.client(admin).request("GET", `/api/v1/reports/${report1.report.id}/content?format=csv`);
    expect(unapprovedExport.status).not.toBe(200);

    // --- 4) 差戻し後の訂正は新draft版（旧版v1は不変。docs/11） ---
    const v1TextBefore = (await versionRow(v1)).text as string;
    const edit = await fx.client(admin).request("POST", `/api/v1/reports/${report1.report.id}/versions`, {
      version: await currentRootVersion(),
      text: "改稿: 巡視で異常なし。参加は1名。",
      missingFields: [],
      sourceVersions: {},
      reason: "差戻し対応",
    }, idem());
    expect(edit.status).toBe(201);
    const v2 = ((await json(edit)).data! as { id: string }).id;
    expect((await versionRow(v1)).text).toBe(v1TextBefore); // 旧版不変
    expect((await versionRow(v2)).revision_no).toBe(2);

    // --- 5) v2を申請してから元実績を変更 → 承認は409（元実績版の再検査。docs/11「引用元/実績版一致」） ---
    expect((await decide(report1.report.id, {
      version: await currentRootVersion(), reportVersion: 2, decision: "request_review",
      sourceVersions: await savedSourceVersions(v2), reason: "再申請",
    })).status).toBe(200);
    const correctRes = await fx.client(admin).request("POST", `/api/v1/activities/${activityId}/actual-results/corrections`, {
      resultVersion: (await fx.rows("activity_results", { activity_id: activityId }))[0]!.version as number,
      content: "堤防の巡視と水防訓練を実施（訂正）。",
      actualStartsAt: "2026-10-21T01:10:00.000Z",
      actualEndsAt: "2026-10-21T03:40:00.000Z",
      participants: [{ memberId: member.memberId!, actualStatus: "participated" }],
      attachmentIds: [],
      reason: "文言の訂正",
    }, idem());
    expect(correctRes.status).toBe(201);

    const approveStale = await decide(report1.report.id, {
      version: await currentRootVersion(), reportVersion: 2, decision: "approve",
      sourceVersions: await savedSourceVersions(v2), reason: "承認します",
    });
    expect(approveStale.status).toBe(409); // 保存したsource_versionsと現行実績の不一致
    // 入力を現行に合わせても、版が基づいたsource_versionsと一致しない承認は409
    const approveRewritten = await decide(report1.report.id, {
      version: await currentRootVersion(), reportVersion: 2, decision: "approve",
      sourceVersions: {
        activityVersion: (await fx.rows("activities", { id: activityId }))[0]!.version as number,
        resultVersion: (await fx.rows("activity_results", { activity_id: activityId }))[0]!.version as number,
        resultRevisionNo: 2,
      },
      reason: "入力だけ現行へ書き換えた承認",
    });
    expect(approveRewritten.status).toBe(409);
    expect((await fx.rows("review_decisions", { report_version_id: v2 })).length).toBe(0);

    // --- 6) 実績訂正後の新draft版（v3）を申請・承認。最終決定は一版一回 ---
    const edit2 = await fx.client(admin).request("POST", `/api/v1/reports/${report1.report.id}/versions`, {
      version: await currentRootVersion(),
      text: "再改稿: 訂正後の実績に基づく。参加人数は90名の大規模訓練（本文の数値は出力に使わない）。",
      missingFields: [],
      sourceVersions: {},
      reason: "元実績訂正への対応",
    }, idem());
    expect(edit2.status).toBe(201);
    const v3 = ((await json(edit2)).data! as { id: string }).id;
    // v3のsource_versionsはサーバーが訂正後の実績から計算している（訂正後のrevision_no=2）
    expect((await savedSourceVersions(v3)).resultRevisionNo).toBe(2);

    expect((await decide(report1.report.id, {
      version: await currentRootVersion(), reportVersion: 3, decision: "request_review",
      sourceVersions: await savedSourceVersions(v3), reason: "再申請",
    })).status).toBe(200);
    const approve = await decide(report1.report.id, {
      version: await currentRootVersion(), reportVersion: 3, decision: "approve",
      sourceVersions: await savedSourceVersions(v3), reason: "内容を確認しました",
    });
    expect(approve.status).toBe(200);
    expect((await versionRow(v3)).status).toBe("approved");
    expect((await versionRow(v3)).approved_by).toBe(admin.memberId);

    // 最終決定は一版一回（二重approveは409。docs/11「審査の最終決定は一版一回」）
    const doubleApprove = await decide(report1.report.id, {
      version: await currentRootVersion(), reportVersion: 3, decision: "approve",
      sourceVersions: await savedSourceVersions(v3), reason: "二重承認",
    });
    expect(doubleApprove.status).toBe(409);
    const finalDecisionsPerVersion = (await fx.rows("review_decisions", { report_version_id: v3 })).length;
    expect(finalDecisionsPerVersion).toBe(1);

    // 承認のevents（approved）が残る
    expect((await fx.rows("content_version_events", { report_version_id: v3, action: "approved" }))).toHaveLength(1);

    // --- 7) 承認版の出力（API-61）。数値はサーバー計算値（本文の「90名」を使わない）、=で始まるセルはescape ---
    const csvRes = await fx.client(member).request("GET", `/api/v1/reports/${report1.report.id}/content?format=csv`);
    expect(csvRes.status).toBe(200); // 担当外でも承認版は出せる（API-58「担当外は承認版だけが見える」と同じ）
    expect(csvRes.headers.get("content-type")).toContain("text/csv");
    // BOM（\uFEFF）はtext()のデコードで剥がれるため、先頭バイト（EF BB BF）で確認する
    const csvBytes = new Uint8Array(await csvRes.clone().arrayBuffer());
    expect([csvBytes[0], csvBytes[1], csvBytes[2]]).toEqual([0xef, 0xbb, 0xbf]);
    const csv = await csvRes.text();
    const csvLines = csv.replace(/^\uFEFF/, "").trim().split("\r\n");
    expect(csvLines[0]).toContain("activityTitle");
    expect(csvLines[0]).toContain("participantCount");
    const dataRow = csvLines[1]!.split(",");
    // 先頭セル（activityTitle）は=で始まるため式注入escapeされる（施設書き出しと同じ流儀）
    expect(dataRow[0]).toBe(`'=セル注入試験の活動（架空）`);
    // 参加人数はサーバー集計（participated行数=1。本文の「90名」は出力に現れない）
    expect(dataRow[1]).toBe("1");
    // 実施日時もサーバー計算（JST表記。元実績のactualStartsAt/actualEndsAtから）
    expect(dataRow[2]).toBe("2026-10-21 10:10〜2026-10-21 12:40");
    expect(csv).toContain("90名"); // 本文（summary欄）は人の入力のまま載る
    const headerCells = csvLines[0]!.split(",");
    const approverCell = dataRow[headerCells.indexOf("approver")];
    expect(approverCell).toBe("架空 管理者"); // 承認者欄（review_decisions.reviewer_member_idの表示名）

    const pdfRes = await fx.client(member).request("GET", `/api/v1/reports/${report1.report.id}/content?format=pdf`);
    expect(pdfRes.status).toBe(200);
    expect(pdfRes.headers.get("content-type")).toBe("application/pdf");
    const pdfHead = new TextDecoder().decode((await pdfRes.arrayBuffer()).slice(0, 5));
    expect(pdfHead).toBe("%PDF-");

    // 未承認の版は選べない（出力は常に承認版。API-61に版指定は無い）
    // 担当であっても、未承認の版だけの帳票は出力できない（項目4の別帳票で確認済み）

    // --- 8) 承認後の訂正は新draft版。承認済pointerは次版承認まで保持（docs/11） ---
    const lastApprovedVersionId = (await reportRow(report1.report.id)).current_approved_version_id as string;
    expect(lastApprovedVersionId).toBe(v3);
    const edit3 = await fx.client(admin).request("POST", `/api/v1/reports/${report1.report.id}/versions`, {
      version: await currentRootVersion(),
      text: "承認後の修正draft（まだ承認されていない）。",
      missingFields: [],
      sourceVersions: {},
      reason: "承認後の軽微な修正",
    }, idem());
    expect(edit3.status).toBe(201);
    const v4 = ((await json(edit3)).data! as { id: string }).id;
    expect((await versionRow(v3)).status).toBe("approved"); // 旧承認版は不変
    const currentApprovedPointer = (await reportRow(report1.report.id)).current_approved_version_id as string;
    expect(currentApprovedPointer).toBe(lastApprovedVersionId); // 新draft作成で承認版pointerを失わない
    expect(currentApprovedPointer).not.toBe(v4);
    // 承認済みの出力は新draft作成後も変わらず可能
    expect((await fx.client(admin).request("GET", `/api/v1/reports/${report1.report.id}/content?format=csv`)).status).toBe(200);

    // --- 9) 別帳票（承認版が無い）は担当でも出力できない（未承認はnot 200。再確認） ---
    const manual2 = await createReport();
    expect(manual2.status).toBe(201);
    const report2 = (await json(manual2)).data! as { report: { id: string } };
    const unapprovedExport2 = await fx.client(admin).request("GET", `/api/v1/reports/${report2.report.id}/content?format=pdf`);
    expect(unapprovedExport2.status).not.toBe(200);
  });

  /**
   * 複数ページのPDF（PH4レビューA中3）: 本文が1ページ（46行）を超える承認版では、
   * 全ページのPageオブジェクトの/Parent（Pagesへの参照）が解決される（%PAGES%が残らない）。
   * 現行実装は1ページ目の置換しかしないため、2ページ目以降に「/Parent %PAGES% 0 R」が残り
   * ビューアで開けない不正なPDFになる（FAILを確認してからループ化で直す）。
   */
  it("multipage_pdf_resolves_parent_on_every_page", async () => {
    const a = fx.units.a;
    const admin = a.people.admin; // 作成＋承認（PER-10）
    const member = a.people.member; // 担当外でも承認版は出せる（API-61）
    const officer = a.people.officer;

    // --- 公開済み予定＋実績＋手動draft（本文は60行＝改ページをまたぐ） ---
    const createRes = await fx.client(admin).request("POST", "/api/v1/activities", {
      title: "複数ページPDF試験の活動（架空）",
      kind: "訓練",
      plannedStartsAt: "2026-10-22T01:00:00.000Z",
      plannedEndsAt: "2026-10-22T04:00:00.000Z",
      locationText: "架空市堤防",
      ownerMemberId: officer.memberId!,
      audienceMemberIds: [officer.memberId!, member.memberId!],
    }, idem());
    expect(createRes.status).toBe(201);
    const activityId = ((await json(createRes)).data! as { id: string }).id;
    expect((await fx.client(admin).request("PATCH", `/api/v1/activities/${activityId}`, {
      version: 1, status: "scheduled", reason: "対象を確定して公開",
    }, idem())).status).toBe(200);
    expect((await fx.client(admin).request("POST", `/api/v1/activities/${activityId}/actual-results`, {
      activityVersion: 2,
      content: "堤防の巡視と水防訓練を実施（複数ページ試験用）。",
      actualStartsAt: "2026-10-22T01:10:00.000Z",
      actualEndsAt: "2026-10-22T03:40:00.000Z",
      participants: [{ memberId: member.memberId!, actualStatus: "participated" }],
      attachmentIds: [],
    }, idem())).status).toBe(201);

    const text = Array.from({ length: 60 }, (_, i) => `訓練の記録${i + 1}行目（架空の本文）`).join("\n");
    const manual = await fx.client(admin).request("POST", "/api/v1/reports/manual", {
      activityId,
      resultVersion: (await fx.rows("activity_results", { activity_id: activityId }))[0]!.version as number,
      templateVersion: "test-activity-v1",
      text,
    }, idem());
    expect(manual.status).toBe(201);
    const report = (await json(manual)).data! as { report: { id: string; version: number }; versions: { id: string }[] };
    const v1 = report.versions[0]!.id;
    const savedSourceVersions = JSON.parse((await fx.rows("report_versions", { id: v1 }))[0]!.source_versions as string) as Record<string, number>;
    const decide = (body: Record<string, unknown>) =>
      fx.client(admin).request("POST", `/api/v1/reports/${report.report.id}/decision`, body, idem());
    const currentRootVersion = async () => (await fx.rows("reports", { id: report.report.id }))[0]!.version as number;
    expect((await decide({ version: await currentRootVersion(), reportVersion: 1, decision: "request_review", sourceVersions: savedSourceVersions, reason: "申請します" })).status).toBe(200);
    expect((await decide({ version: await currentRootVersion(), reportVersion: 1, decision: "approve", sourceVersions: savedSourceVersions, reason: "内容を確認しました" })).status).toBe(200);

    // --- 承認版のPDF（本文60行＋欄は46行/ページで2ページになる） ---
    const pdfRes = await fx.client(member).request("GET", `/api/v1/reports/${report.report.id}/content?format=pdf`);
    expect(pdfRes.status).toBe(200);
    const bytes = new Uint8Array(await pdfRes.arrayBuffer());
    const raw = Array.from(bytes, (b) => String.fromCharCode(b)).join("");
    // %PAGES%はどのページにも残らない（全ページの/ParentがPagesオブジェクトの番号で解決済み）
    expect(raw.includes("%PAGES%")).toBe(false);
    // ページ数の整合: /Count 2（Pagesの宣言）とPageオブジェクト2件
    expect(raw).toContain("/Count 2");
    expect(raw.match(/\/Type \/Page[^s]/g)).toHaveLength(2);
  });

  /**
   * 同一帳票の2回目の承認（承認後訂正→再申請→再承認。docs/11 approved→superseded）:
   * API-60のapproveは旧承認版をsupersededへ遷める（承認列は不変のままstatusだけ遷む）。
   * 0024作成時の「approvedだけが承認列を持つ」CHECKのままだと、この遷移がCHECK違反になり
   * batch全体が失敗する（＝2回目の承認が常に失敗）。CHECKを「承認されたことがある版」へ
   * 拡張してから緑になる（0027/T063と同型の修正。FAILを確認してから直す）。
   */
  it("second_approval_supersedes_previous_approved_version", async () => {
    const a = fx.units.a;
    const admin = a.people.admin; // 作成＋承認（PER-10）
    const officer = a.people.officer; // 予定の担当owner

    // --- 公開済み予定＋実績＋手動draft（2回目の承認を試す1本の帳票） ---
    const createRes = await fx.client(admin).request("POST", "/api/v1/activities", {
      title: "再承認試験の活動（架空）",
      kind: "訓練",
      plannedStartsAt: "2026-10-24T01:00:00.000Z",
      plannedEndsAt: "2026-10-24T04:00:00.000Z",
      locationText: "架空市堤防",
      ownerMemberId: officer.memberId!,
      audienceMemberIds: [officer.memberId!],
    }, idem());
    expect(createRes.status).toBe(201);
    const activityId = ((await json(createRes)).data! as { id: string }).id;
    expect((await fx.client(admin).request("PATCH", `/api/v1/activities/${activityId}`, {
      version: 1, status: "scheduled", reason: "対象を確定して公開",
    }, idem())).status).toBe(200);
    expect((await fx.client(admin).request("POST", `/api/v1/activities/${activityId}/actual-results`, {
      activityVersion: 2,
      content: "堤防の巡視と水防訓練を実施（再承認試験用）。",
      actualStartsAt: "2026-10-24T01:10:00.000Z",
      actualEndsAt: "2026-10-24T03:40:00.000Z",
      participants: [{ memberId: officer.memberId!, actualStatus: "participated" }],
      attachmentIds: [],
    }, idem())).status).toBe(201);

    const manual = await fx.client(admin).request("POST", "/api/v1/reports/manual", {
      activityId,
      resultVersion: (await fx.rows("activity_results", { activity_id: activityId }))[0]!.version as number,
      templateVersion: "test-activity-v1",
      text: "初版の本文（架空）。",
    }, idem());
    expect(manual.status).toBe(201);
    const report = (await json(manual)).data! as { report: { id: string; version: number }; versions: { id: string }[] };
    const v1 = report.versions[0]!.id;
    const decide = (body: Record<string, unknown>) =>
      fx.client(admin).request("POST", `/api/v1/reports/${report.report.id}/decision`, body, idem());
    const currentRootVersion = async () => (await reportRow(report.report.id)).version as number;

    // --- 1回目の承認（v1がapprovedになり、承認済pointerがv1を指す） ---
    expect((await decide({
      version: await currentRootVersion(), reportVersion: 1, decision: "request_review",
      sourceVersions: await savedSourceVersions(v1), reason: "初版を申請します",
    })).status).toBe(200);
    expect((await decide({
      version: await currentRootVersion(), reportVersion: 1, decision: "approve",
      sourceVersions: await savedSourceVersions(v1), reason: "初版を承認します",
    })).status).toBe(200);
    expect((await versionRow(v1)).status).toBe("approved");
    expect((await reportRow(report.report.id)).current_approved_version_id).toBe(v1);

    // --- 承認後訂正で新draft版（v2）を作り、申請（docs/11「承認後の訂正は新draft版」） ---
    const edit = await fx.client(admin).request("POST", `/api/v1/reports/${report.report.id}/versions`, {
      version: await currentRootVersion(),
      text: "承認後訂正の本文（架空）。",
      missingFields: [],
      sourceVersions: {},
      reason: "承認後の文言訂正",
    }, idem());
    expect(edit.status).toBe(201);
    const v2 = ((await json(edit)).data! as { id: string }).id;
    expect((await versionRow(v1)).status).toBe("approved"); // 新draft作成で旧承認版は不変

    expect((await decide({
      version: await currentRootVersion(), reportVersion: 2, decision: "request_review",
      sourceVersions: await savedSourceVersions(v2), reason: "訂正版を申請します",
    })).status).toBe(200);

    // --- 2回目の承認: 旧承認版v1はsupersededへ、承認済pointerはv2へ切替（docs/11） ---
    const approve2 = await decide({
      version: await currentRootVersion(), reportVersion: 2, decision: "approve",
      sourceVersions: await savedSourceVersions(v2), reason: "訂正版を承認します",
    });
    expect(approve2.status).toBe(200);
    const v1Row = await versionRow(v1);
    expect(v1Row.status).toBe("superseded");
    expect(v1Row.approved_by).not.toBeNull(); // 承認列は不変のまま保持（docs/11 approved→superseded）
    expect(v1Row.approved_at).not.toBeNull();
    expect((await versionRow(v2)).status).toBe("approved");
    expect((await reportRow(report.report.id)).current_approved_version_id).toBe(v2);
    // 旧承認版にsupersededのeventsが残る（docs/04:148「superseded＝旧承認版の切替」）
    expect((await fx.rows("content_version_events", { report_version_id: v1, action: "superseded" }))).toHaveLength(1);
    // 承認済pointerは新承認版を指すため、出力（API-61）は引き続き可能
    expect((await fx.client(admin).request("GET", `/api/v1/reports/${report.report.id}/content?format=csv`)).status).toBe(200);
  });
});
