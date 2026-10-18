import { expect, test } from "@playwright/test";
import { loginViaUi, logoutViaUi } from "./helpers";
import {
  adminSeedPage,
  attachMatrix,
  enrollReturningUser,
  flowAttendanceAnswer,
  flowCitationOpen,
  flowInspectionSave,
  flowIssueConfirm,
  flowSyncRecover,
  grantOfficerRole,
  seedCitableDocument,
  seedRevisitScene,
  successRateOf,
  timedFlow,
  type FlowResult,
} from "./revisit-helpers";

/**
 * 再訪操作の検証（T083、NFR-01/02。accessibility.specのフロー群を「再訪」の条件で走らせる版）。
 *
 * 月1〜2回しか使わない団員は、前回の利用を覚えていない。そこで一度ログアウトし、もう一度ログインしてから
 * 出欠回答・写真点検・異常確認・引用（原本）閲覧・同期復旧を**説明なしで**完結させ、
 * 成功率（D18開発案値0.9以上）と各フローの操作数（NFR-02「少数操作で完了」）を測る。
 * 操作数の上限は、現在の導線の実測に余裕を持たせた回帰のガード（既存の導線が著しく増えることを検知する）で、
 * 承認済みの合格値ではない（docs/03・docs/13ではD18承認まで確定しない）。
 *
 * 実行project: phone-360 / desktop-1280 / tablet-768（T083で追加。実端末ではない＝chromiumのエミュレーション。
 * 実端末の手順はops/device-test-matrix.mdの番号付き残手順）。
 */

/** 各フローの操作数の上限（現在の導線の実測＋余裕。導線が著しく増えたら赤になる回帰ガード） */
const OPERATION_CAPS: Record<string, number> = {
  attendance_answer: 4, // 一覧を開く→行を開く→「参加」の3操作＋余裕1
  inspection_photo_save: 10, // 様式→結果→進む→写真→進む→保存の6操作＋画面遷移の直接指定を除く余裕
  issue_confirm: 4, // 行を開く→「確認する」の2操作＋余裕
  citation_original_open: 3, // 行を開く→「原本を開く」の2操作＋余裕
  sync_recover: 5, // 「未定」→同期の状況を開く→（必要なら）「もう一度送る」＋余裕
};

test("revisit_core_flows_complete_in_few_operations_after_relogin", async ({ browser, request }, testInfo) => {
  test.setTimeout(480_000);
  const viewport = testInfo.project.use.viewport!;
  const tag = crypto.randomUUID().slice(0, 6);

  // --- seed（accessibility.specと同じ舞台。管理者API＋管理者の画面〔seed専用のデスクトップ文脈〕） ---
  const scene = await seedRevisitScene(request, tag);
  const admin = await adminSeedPage(browser);
  await seedCitableDocument(admin.page, request, scene);
  const member = await enrollReturningUser(browser, viewport, scene);
  // 幹部権（点検様式の選択=PER-04・異常の確認=PER-05）。役割の付与は受領後（アカウント付きの団員にだけできる）
  await grantOfficerRole(request, scene);

  // --- 再訪: 一度ログアウトして、もう一度ログインしてから測る（前回の利用から時間が空った状態の再現） ---
  await logoutViaUi(member);
  await loginViaUi(member, scene.memberEmail);
  const heading = viewport.width < 1024 ? { level: 2 as const, name: "ホーム" } : { level: 1 as const, name: "ダッシュボード" };
  await expect(member.getByRole("heading", heading)).toBeVisible();

  // --- 再訪フロー5本（説明なしで完結できるか） ---
  const flows: FlowResult[] = [];
  flows.push(await timedFlow("attendance_answer", (f) => flowAttendanceAnswer(member, scene, request, f)));
  flows.push(await timedFlow("inspection_photo_save", (f) => flowInspectionSave(member, scene, request, f)));
  flows.push(await timedFlow("issue_confirm", (f) => flowIssueConfirm(member, scene, request, f)));
  flows.push(await timedFlow("citation_original_open", (f) => flowCitationOpen(member, scene, f)));
  flows.push(await timedFlow("sync_recover", (f) => flowSyncRecover(member, scene, request, f)));

  // --- 測定結果の保存（Interfaces: flowId/steps/duration/success/errors/device/version） ---
  const matrix = {
    device: `${testInfo.project.name}`,
    viewport: `${viewport.width}x${viewport.height}`,
    emulation: "chromium-emulated（実端末ではない）",
    relogged: true,
    coreTaskSuccessRate: { value: successRateOf(flows), threshold: "0.9（docs/14 D18の開発案値。承認済み合格値ではない）", flows },
    operationCaps: OPERATION_CAPS,
    appVersion: process.env.npm_package_version ?? "0.0.0",
  };
  attachMatrix(testInfo, "revisit-matrix.json", matrix);

  // --- 断言 ---
  // 成功率（5フローのため、4/5=0.8では足りず5/5が要る。落ちたフローはerrorsで切分けできる）
  expect(matrix.coreTaskSuccessRate.value).toBeGreaterThanOrEqual(0.9);
  // 操作数は上限内（NFR-02「少数操作で完了」の回帰ガード。実測値は添付のmatrixに残る）
  for (const flow of flows) {
    expect(flow.operations, `${flow.flowId} の操作数`).toBeLessThanOrEqual(OPERATION_CAPS[flow.flowId] ?? 99);
  }
  // 失敗フローの中身（全フロー成功のときは空配列）
  expect(flows.filter((r) => !r.success).map((r) => ({ flowId: r.flowId, errors: r.errors }))).toEqual([]);

  await member.context().close();
  await admin.close();
});
