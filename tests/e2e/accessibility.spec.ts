import { expect, test } from "@playwright/test";
import { isPhone } from "./helpers";
import {
  adminSeedPage,
  collectCriticalViolations,
  countMarkerTextLabelsMissing,
  enrollReturningUser,
  flowAttendanceAnswer,
  flowCitationOpen,
  flowInspectionSave,
  flowIssueConfirm,
  flowSyncRecover,
  grantOfficerRole,
  probeKeyboardReachable,
  seedCitableDocument,
  seedRevisitScene,
  setVisionDeficiency,
  setTextZoomPercent,
  successRateOf,
  tabReaches,
  attachMatrix,
  timedFlow,
  type AxeViolationSummary,
  type FlowResult,
} from "./revisit-helpers";

/**
 * 実端末・アクセシビリティ・再訪操作の検証（T083、NFR-01/02/09、AT-NFR-01/02/09）。
 *
 * 月1〜2回しか使わない団員（班長）が**説明なしで**完結できるかを、e2eの語彙だけで測る:
 * 出欠回答・写真点検・異常確認・引用（原本）閲覧・同期復旧の5フローの成功、
 * 主要画面のaxe走査（critical違反0）、地図マーカー/一覧のテキストラベル（色だけに依存しない）、
 * コア操作のkeyboard到達、200%文字拡大、色除去（achromatopsia）を同じ試験で確認する。
 *
 * エミュレーションと実端末の区別（docs/16 T083）:
 * - この試験はchromiumのエミュレーション（360/768/1280）での結果。iOS/Androidの実端末・実スクリーンリーダーは
 *   この環境に無いため、ops/device-test-matrix.mdの番号付き残手順として残す（偽の完了記録を書かない）。
 * - 読み上げは実スクリーンリーダーの代わりに、axe（name/role）＋getByRoleの機械断言で代替する。
 * - 200%文字拡大はCDPのPage.setTextZoomFactorが本Chromiumに無いことを確認したため、rootへのCSS zoom注入で
 *   実施する（レイアウト全体が拡大するため文字ズームより厳しめ。docs/evidence/V07-ux.mdに手法を記録）。
 * - 色除去はCDP Emulation.setEmulatedVisionDeficiency('achromatopsia')で実施する。
 *
 * coreTaskSuccessRateの閾値0.9はdocs/14 D18の開発案値（操作成功率90%以上案）であって、
 * 承認済みの合格値ではない（docs/03・docs/13の合格値はD18承認まで確定しない）。
 */
test("returning_user_finishes_inspection_and_attendance_without_hidden_controls", async ({ browser, request }, testInfo) => {
  test.setTimeout(540_000);
  const viewport = testInfo.project.use.viewport!;
  const device = `${testInfo.project.name}`;
  const tag = crypto.randomUUID().slice(0, 6);

  // --- seed: 施設3件＋承認済み様式＋公開済み予定＋異常1件（管理者API。画面の操作は団員が行う） ---
  const scene = await seedRevisitScene(request, tag);
  // --- seed: 引用閲覧用の文書（管理者の画面。ACLに団員を含める。seed専用のデスクトップ文脈。下の注記） ---
  const admin = await adminSeedPage(browser);
  await seedCitableDocument(admin.page, request, scene);

  // --- 団員の初回受領（招待→アカウント作成。ここからの操作はすべて団員の端末） ---
  const member = await enrollReturningUser(browser, viewport, scene);
  // 幹部権（点検様式の選択=PER-04・異常の確認=PER-05）。役割の付与は受領後（アカウント付きの団員にだけできる）
  await grantOfficerRole(request, scene);

  // --- 再訪フロー5本（説明なしで完結できるか。各フローの成功を記録する） ---
  const flows: FlowResult[] = [];
  flows.push(await timedFlow("attendance_answer", (f) => flowAttendanceAnswer(member, scene, request, f)));
  flows.push(await timedFlow("inspection_photo_save", (f) => flowInspectionSave(member, scene, request, f)));
  flows.push(await timedFlow("issue_confirm", (f) => flowIssueConfirm(member, scene, request, f)));
  flows.push(await timedFlow("citation_original_open", (f) => flowCitationOpen(member, scene, f)));
  flows.push(await timedFlow("sync_recover", (f) => flowSyncRecover(member, scene, request, f)));
  const coreTaskSuccessRate = successRateOf(flows);
  // --- axe走査（critical違反の測定源。フローで使った画面＋ホーム/マップ） ---
  const criticalAccessibilityViolations: AxeViolationSummary[] = [];
  let seriousOrWorseTotal = 0;
  const axePages: [string, string][] = [
    ["ホーム", "/app"],
    ["マップ", "/app/map"],
    ["点検登録", `/app/facilities/${scene.facilityIds[0]}/inspections/new`],
    ["同期の状況", "/app/sync"],
  ];
  for (const [label, path] of axePages) {
    await member.goto(path);
    await expect(member.locator("#main")).toBeVisible();
    const r = await collectCriticalViolations(member, criticalAccessibilityViolations);
    seriousOrWorseTotal += r.seriousOrWorse;
    testInfo.attach(`axe-${label}`, { body: JSON.stringify(r), contentType: "application/json" });
  }

  // --- 地図マーカー/一覧のテキストラベル（NFR-09。欠落数0が合格）と、地図障害の一覧代替 ---
  await member.goto("/app/map");
  // 読み込み中に数えない: 地図面のマーカーが実際に描かれるまで待つ（toBeHiddenは要素がまだ無くても通るため）
  await expect(member.getByRole("button", { name: new RegExp(scene.managementNumbers[0]!.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")) }).first()).toBeVisible({ timeout: 30_000 });
  const markerTextLabelsMissing = await countMarkerTextLabelsMissing(member, scene.managementNumbers);
  // 地図障害（地図が使えない状態）の代替として、**一覧だけで**目的の施設から詳細→点検の導線まで進める
  // （本アプリの地図面はプレースホルダーで実地図タイルへの依存が無いため、「地図を見ずに操作する」形で再現する。
  //  実端末での地図タイル障害の再現はops/device-test-matrix.mdの残手順）
  const listToggle = member.getByRole("button", { name: "一覧" });
  const listAlternativeWorks = await timedFlow("map_failure_list_alternative", async (f) => {
    f.step("一覧へ切り替える（PCは一覧が常設）");
    if (await listToggle.isVisible().catch(() => false)) {
      f.op("「一覧」ボタン");
      await listToggle.click();
    }
    await expect(member.getByText("施設一覧", { exact: true }).first()).toBeVisible();
    f.step("一覧の行から目的の施設を開く");
    const target = member.getByRole("button", { name: new RegExp(scene.managementNumbers[0]!) }).first();
    f.op("施設の行を開く");
    await target.click();
    if (isPhone(viewport)) {
      // スマホは行を押すと施設の詳細へ遷移する（MapPageのlistRow）。詳細の固定CTA（この施設を点検する）まで確認する
      await expect(member).toHaveURL(new RegExp(`/app/facilities/${scene.facilityIds[0]}$`), { timeout: 15_000 });
      f.step("点検の導線（この施設を点検する）が一覧代替でも届く");
      // 詳細の固定CTAはリンク（prototype「この施設を点検する」。FacilityPageの固定CTA）
      await expect(member.getByRole("link", { name: "この施設を点検する" })).toBeVisible();
    } else {
      // PCは右パネルに詳細が出て、CTAは「点検を依頼」（prototype Desktop。マップの選択と同じ導線）
      await expect(member.getByText("位置出典")).toBeVisible({ timeout: 15_000 });
      f.step("点検の導線（点検を依頼）が一覧代替でも届く");
      await expect(member.getByRole("button", { name: /点検を依頼/ })).toBeVisible();
    }
  });

  // --- keyboard到達（構造の確認＋Tabを実際に押して目的の操作へ届くか） ---
  const unreachableCoreControls: string[] = [];
  // 出欠（本人の出欠は PER-02。予定の詳細で確かめる）
  await member.goto(`/app/activities/${scene.activityId}`);
  await expect(member.getByText("あなたの出欠")).toBeVisible();
  await probeKeyboardReachable("出欠の「参加」", member.getByRole("button", { name: "参加", exact: true }), unreachableCoreControls);
  await probeKeyboardReachable("出欠の「未定」", member.getByRole("button", { name: "未定", exact: true }), unreachableCoreControls);
  if (!(await tabReaches(member, "参加"))) unreachableCoreControls.push("出欠の「参加」（Tabで到達できない）");
  // 点検登録の主要操作（様式の一覧は読み込み後に描かれるため、出てから確かめる。次の段の操作も同様）
  await member.goto(`/app/facilities/${scene.facilityIds[0]}/inspections/new`);
  await expect(member.getByRole("heading", { name: "点検登録" })).toBeVisible();
  const templateButton = member.getByRole("button", { name: scene.templateName });
  await expect(templateButton).toBeVisible({ timeout: 30_000 });
  await probeKeyboardReachable("点検の様式の選択", templateButton, unreachableCoreControls);
  await templateButton.click();
  await member.getByRole("button", { name: "良好" }).click(); // 次の段の操作は結果を選ぶと出る（点検登録の画面構成）
  const nextStep = member.getByRole("button", { name: /写真・メモへ進む/ });
  await expect(nextStep).toBeVisible({ timeout: 15_000 });
  await probeKeyboardReachable("点検の「写真・メモへ進む」導線", nextStep, unreachableCoreControls);
  // マップ（マーカーと一覧切替。マーカーが描かれてから確かめる）
  await member.goto("/app/map");
  await expect(member.getByRole("button", { name: new RegExp(scene.managementNumbers[0]!.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")) }).first()).toBeVisible({ timeout: 30_000 });
  await probeKeyboardReachable("マップのマーカー", member.getByRole("button", { name: new RegExp(scene.managementNumbers[0]!) }), unreachableCoreControls);
  await probeKeyboardReachable("マップの「一覧」切替", member.getByRole("button", { name: "一覧" }), unreachableCoreControls);
  // 文書の原本（引用。詳細画面の「原本を開く」）
  await member.goto("/app/documents");
  await member.getByRole("link", { name: new RegExp(scene.documentTitle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")) }).click();
  await expect(member.getByRole("heading", { name: scene.documentTitle })).toBeVisible();
  await probeKeyboardReachable("文書の「原本を開く」", member.getByRole("link", { name: "原本を開く" }), unreachableCoreControls);

  // --- 色除去（NFR-09。achromatopsiaで全色を無彩色にしても、文字で状態が読める） ---
  await setVisionDeficiency(member, "achromatopsia");
  let achromatopsiaTextLabelsReadable = false;
  try {
    await member.goto("/app/map");
    // 種別チップは色と形に加えて必ず文字を持つ（prototypeのfilters）。チップが描かれてから確かめる
    await expect(member.getByRole("button", { name: /消火栓 \d+/ }).first()).toBeVisible({ timeout: 30_000 });
    // 一覧の行も状態を文字（未確認/位置確認済み）で示す。色だけの表現に頼らない
    const toggle = member.getByRole("button", { name: "一覧" });
    if (await toggle.isVisible().catch(() => false)) await toggle.click();
    await expect(member.getByText("未確認").first()).toBeVisible();
    achromatopsiaTextLabelsReadable = true;
  } finally {
    await setVisionDeficiency(member, "none");
  }

  // --- 200%文字拡大（NFR-02。出欠の操作が拡大しても隠れず・押せる） ---
  const zoomMethod = await setTextZoomPercent(member, 200);
  let coreControlUsableAt200Percent = false;
  try {
    await member.goto(`/app/activities/${scene.activityId}`);
    await expect(member.getByText("あなたの出欠")).toBeVisible();
    const attend = member.getByRole("button", { name: "参加", exact: true });
    await expect(attend).toBeVisible();
    await expect(attend).toBeEnabled();
    await attend.click();
    await expect(attend).toHaveAttribute("aria-pressed", "true");
    coreControlUsableAt200Percent = true;
  } finally {
    await member.evaluate(() => {
      (document.documentElement.style as CSSStyleDeclaration & { zoom: string }).zoom = "";
    });
  }

  // --- 測定結果の保存（Interfaces: flowId/steps/duration/success/errors/device/version） ---
  attachMatrix(testInfo, "ux-matrix.json", {
    device,
    viewport: `${viewport.width}x${viewport.height}`,
    emulation: "chromium-emulated（実端末ではない）",
    zoomMethod,
    coreTaskSuccessRate: { value: coreTaskSuccessRate, threshold: "0.9（docs/14 D18の開発案値。承認済み合格値ではない）", flows },
    mapFailureListAlternative: listAlternativeWorks,
    criticalAccessibilityViolations,
    seriousOrWorseViolationsTotal: seriousOrWorseTotal,
    markerTextLabelsMissing,
    unreachableCoreControls,
    achromatopsiaTextLabelsReadable,
    coreControlUsableAt200Percent,
    appVersion: process.env.npm_package_version ?? "0.0.0",
  });

  // --- ブリーフの4断言（docs/16 T083） ---
  expect(criticalAccessibilityViolations).toEqual([]);
  expect(coreTaskSuccessRate).toBeGreaterThanOrEqual(0.9);
  expect(markerTextLabelsMissing).toBe(0);
  expect(unreachableCoreControls).toEqual([]);
  // 同時に確かめた追加の断言（失敗時の切分け用に出す）
  expect(listAlternativeWorks.success).toBe(true);
  expect(achromatopsiaTextLabelsReadable).toBe(true);
  expect(coreControlUsableAt200Percent).toBe(true);

  await member.context().close();
  await admin.close();
});
