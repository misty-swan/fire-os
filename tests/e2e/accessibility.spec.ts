import { expect, test } from "@playwright/test";
import { acceptInvitationViaUi, adminApiData, inviteNewMember, isPhone, newUserContext, uniqueEmail } from "./helpers";
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
  startAchromatopsia,
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
  // 各ページは**データ依存のDOM（マーカー・様式・指標など）が出てから**走査する（ph8レビューA低1。
  // #main表示直後の未取得DOMで走ると違反を取りこぼす＝false緑の方向）
  const criticalAccessibilityViolations: AxeViolationSummary[] = [];
  let seriousOrWorseTotal = 0;
  const markerName = new RegExp(scene.managementNumbers[0]!.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  const axePages: { label: string; path: string; ready: () => Promise<void> }[] = [
    { label: "ホーム", path: "/app", ready: () => expect(member.getByText("やること")).toBeVisible({ timeout: 30_000 }) },
    { label: "マップ", path: "/app/map", ready: () => expect(member.getByRole("button", { name: markerName }).first()).toBeVisible({ timeout: 30_000 }) },
    { label: "点検登録", path: `/app/facilities/${scene.facilityIds[0]}/inspections/new`, ready: () => expect(member.getByRole("button", { name: scene.templateName })).toBeVisible({ timeout: 30_000 }) },
    { label: "同期の状況", path: "/app/sync", ready: () => expect(member.getByText(/同期待ち/).first()).toBeVisible({ timeout: 30_000 }) },
  ];
  for (const { label, path, ready } of axePages) {
    await member.goto(path);
    await expect(member.locator("#main")).toBeVisible();
    await ready();
    const r = await collectCriticalViolations(member, criticalAccessibilityViolations);
    seriousOrWorseTotal += r.seriousOrWorse;
    await testInfo.attach(`axe-${label}`, { body: JSON.stringify(r), contentType: "application/json" });
  }
  // 測定の証跡（serious以下の件数を含む。criticalのみが断言対象）
  console.log(`[axe] ${JSON.stringify({ criticalAccessibilityViolations, seriousOrWorseTotal })}`);

  // --- 地図マーカーのテキストラベル（NFR-09。マーカーのaccessible name＋面上テキストの2点計上で欠落数0が合格。
  //     一覧の行ラベルはachromatopsia節と下の一覧代替フローで別途断言する）と、地図障害の一覧代替 ---
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
  // 適用はページ遷移の**後**（注入がナビゲーションで破棄されないよう、ズームと同じ順にする）。
  // CDPセッションは断言が終わるまで開いたままにし、全断言後に"none"を送ってからdetachする
  // （ph8レビューA中2/要確認1。適用の有効性＝描画が実際に変わることは、色つき要素の適用前後の
  // スクリーンショット差分で実証済み（2026-10-18・docs/evidence/V07-ux.md））
  await member.goto("/app/map");
  await expect(member.getByRole("button", { name: markerName }).first()).toBeVisible({ timeout: 30_000 });
  const achromatopsia = await startAchromatopsia(member);
  let achromatopsiaTextLabelsReadable = false;
  try {
    // 種別チップは色と形に加えて必ず文字を持つ（prototypeのfilters）
    await expect(member.getByRole("button", { name: /消火栓 \d+/ }).first()).toBeVisible();
    // 一覧の行も状態を文字（未確認/位置確認済み）で示す。色だけの表現に頼らない
    const toggle = member.getByRole("button", { name: "一覧" });
    if (await toggle.isVisible().catch(() => false)) await toggle.click();
    await expect(member.getByText("未確認").first()).toBeVisible();
    achromatopsiaTextLabelsReadable = true;
  } finally {
    await achromatopsia.reset();
  }

  // --- 200%文字拡大（NFR-02。出欠の操作が拡大しても隠れず・押せる） ---
  // 注入はページ遷移の**後**。CSS zoomは旧ドキュメントのdocumentElementへ効くため、
  // 注入の直後にgotoすると新ドキュメントで破棄され100%のまま断言することになる（ph8レビューA高1の修正）
  let coreControlUsableAt200Percent = false;
  let zoomMethod: "css-zoom-injected" | "not-applied" = "not-applied";
  try {
    await member.goto(`/app/activities/${scene.activityId}`);
    await expect(member.getByText("あなたの出欠")).toBeVisible();
    zoomMethod = await setTextZoomPercent(member, 200);
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
  await attachMatrix(testInfo, "ux-matrix.json", {
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

/**
 * 実機（iPhone・Safariページズーム200%相当の狭幅）で発見された欠陥の回帰（T083実機確認）:
 * 日付入力（input type=date）はブラウザ既定の固有幅（約192px）を持ち、TextFieldのinputに幅の
 * 制約クラス（w-full min-w-0）が無いとグリッドの最小幅が固有幅に引きずられ、検索カードから
 * はみ出す（240pxで+6px）。200pxまで狭めるとページ全体が横スクロールになる。
 */
test("inputs_stay_inside_the_search_card_at_narrow_widths", async ({ page }) => {
  const overshootOf = () =>
    page.evaluate(() => {
      const card = document.querySelector('[aria-label="予定の検索"]')!;
      const cardRect = card.getBoundingClientRect();
      const rights = [...card.querySelectorAll("input, select, label")]
        .filter((el) => el.getBoundingClientRect().width > 0)
        .map((el) => el.getBoundingClientRect().right - cardRect.right);
      return { scroll: document.documentElement.scrollWidth, inner: window.innerWidth, max: Math.max(...rights) };
    });

  await page.setViewportSize({ width: 240, height: 800 });
  await page.goto("/app/activities");
  await expect(page.locator('[aria-label="予定の検索"]')).toBeVisible();
  await expect(page.locator('[aria-label="予定の検索"] input').first()).toBeVisible();

  // ①240px: ページが横スクロールしない ②カード内の全入力欄・ラベルがカードの右端に収まる（+1pxは丸め許容）
  const at240 = await overshootOf();
  expect(at240.scroll).toBeLessThanOrEqual(at240.inner);
  expect(at240.max).toBeLessThanOrEqual(1);

  // 200px（iPhone 390pxでページズーム200%相当）でもページが横スクロールしない
  await page.setViewportSize({ width: 200, height: 800 });
  await expect(page.locator('[aria-label="予定の検索"] input').first()).toBeVisible();
  const at200 = await overshootOf();
  expect(at200.scroll).toBeLessThanOrEqual(at200.inner);
});

/**
 * 実機（iPhone Safari）で発見されたWebKit Bug 301648（未修正・iOSのみ）の回帰（T083実機確認）:
 * date/time系inputはネイティブ描画（appearance:auto）のままだとauthorのbox-sizing（box-border）が
 * 無効になり、padding込みの幅計算が誤ってカードからはみ出す。アプリ共通のフィールド様式で描画させる
 * ため、date入力はappearance: noneになる（docs/03 §1.1-24）。修正前はappearance=autoで落ちる。
 */
test("date_inputs_render_with_the_app_field_style_on_ios_browsers", async ({ page }) => {
  await page.goto("/app/activities");
  const from = page.locator('input[name="filter-from"]');
  await expect(from).toBeVisible();
  const style = await from.evaluate((el) => {
    const cs = getComputedStyle(el);
    return { appearance: cs.appearance, boxSizing: cs.boxSizing };
  });
  // ネイティブ描画をやめて、アプリ共通のフィールド様式（box-border・幅の制御可能）で描く
  expect(style.appearance).toBe("none");
  expect(style.boxSizing).toBe("border-box");
});

/**
 * 実機（iPhone・390幅）で発見された欠陥の回帰（T083実機確認）:
 * 活動分析の条件チップはChipが inline-flex flex-none で幅の上限を持たないため、長い日本語の
 * チップ（単位の説明）がコンテンツ幅（406px）のまま縮まず、画面幅を超えてページ全体が
 * 横スクロールになる（実機390幅でdocument.scrollWidth=426）。Chipに max-w-full を付けて
 * 親幅を超えなくする。はみ出すチップだけが日本語の既定の折り返し（文字単位）で複数行のpillになり、
 * 短いチップは1行のまま（prototypeどおりの見た目は不変）。
 */
test("analytics_conditions_stay_inside_the_screen_at_phone_width", async ({ browser, request }, testInfo) => {
  test.setTimeout(300_000);
  const viewport = testInfo.project.use.viewport!;
  const tag = crypto.randomUUID().slice(0, 6);
  const iso = (s: string) => new Date(s).toISOString();

  // --- analytics.spec.tsと同じ準備: 招待受領で一般団員を作り、集計の実データ（出来事1件）をseedする ---
  const email = uniqueEmail(`e2e-analytics-width-${tag}`);
  const { memberId, token } = await inviteNewMember(request, `架空 幅確認 ${tag}`, email);
  const ctx = await newUserContext(browser, viewport);
  const page = await ctx.newPage();
  await acceptInvitationViaUi(page, email, token, { mfa: false });
  await expect(page).toHaveURL(/\/app$/);

  const act = await adminApiData<{ id: string }>(request, "POST", "/api/v1/activities", {
    title: `幅確認の巡回点呼 ${tag}`, kind: `analytics-width-${tag}`, plannedStartsAt: iso("2026-05-20T01:00:00.000Z"),
    locationText: "架空市堤防", ownerMemberId: memberId, audienceMemberIds: [memberId],
  });
  expect(act.status).toBe(201);
  expect((await adminApiData(request, "PATCH", `/api/v1/activities/${act.data.data.id}`, {
    version: 1, status: "scheduled", reason: "対象を確定して公開",
  })).status).toBe(200);
  expect((await adminApiData(request, "POST", `/api/v1/activities/${act.data.data.id}/actual-results`, {
    activityVersion: 2, content: "巡回を実施（架空）。",
    actualStartsAt: iso("2026-05-20T01:00:00.000Z"), actualEndsAt: iso("2026-05-20T02:00:00.000Z"),
    participants: [{ memberId, actualStatus: "participated" }], attachmentIds: [],
  })).status).toBe(201);

  // --- 活動分析（SCR-26）。条件チップが実際に描かれてから画面幅を測る（読み込み中の寸法を数えない） ---
  await page.goto("/app/analytics");
  await expect(page.getByText("単位: 出来事（同じ出来事の活動と出動は1件）・延べ参加（出来事×団員）")).toBeVisible();
  const measured = await page.evaluate(() => ({
    // clientWidthはレイアウトビューポート（width=device-widthなら画面幅）で、内容がはみ出しても変わらない。
    // window.innerWidthはこのエミュレーションでは内容幅に膨らむため（はみ出し時の実測421）、比較に使えない
    scroll: document.documentElement.scrollWidth,
    client: document.documentElement.clientWidth,
  }));
  // 切分け用の証跡（修正前は421>360=実機の横スクロール（390幅で426>390）と同じ欠陥。この試験はphone-360の360幅）
  console.log(`[analytics-width] ${JSON.stringify({ ...measured, project: testInfo.project.name })}`);
  expect(measured.scroll).toBeLessThanOrEqual(measured.client);

  await ctx.close();
});
