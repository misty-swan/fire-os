import { describe, expect, it } from "vitest";
import { JOB_ERROR_LABELS } from "../src/client/features/ai/AiReviewsPage";
import { REPORT_JOB_ERROR_LABELS } from "../src/client/features/reports/ReportDraftPage";

/**
 * jobのerror_code（保留理由）の日本語対応表の試験（review round 1）。
 *
 * サーバーは課金上限の停止時に errorCode「budget_stopped」を返す
 * （src/server/jobs/handlers/classification.ts・report.ts）。対応表に未収録だと
 * フォールバック表示で生コードが団員に見えるため、両マップが日本語ラベルを持つことを
 * 試験で固定する（docs/06 §2「原本を失わず失敗表示する」。コードのまま見せない）。
 */
describe("job error labels (review round 1)", () => {
  it("budget_stopped_is_labelled_in_japanese_without_raw_code", () => {
    for (const [name, labels] of [
      ["JOB_ERROR_LABELS", JOB_ERROR_LABELS],
      ["REPORT_JOB_ERROR_LABELS", REPORT_JOB_ERROR_LABELS],
    ] as const) {
      const label = labels.budget_stopped;
      expect(label, `${name}にbudget_stoppedが無い（フォールバックで生コードが出る）`).toBeTypeOf("string"); // キーがある
      expect(label!.length, `${name}のbudget_stoppedが空`).toBeGreaterThan(0); // 空でない
      expect(label!.includes("budget_stopped"), `${name}が生コードを含む`).toBe(false); // 生コードをそのまま見せない
    }
  });

  it("budget_stopped_label_is_reason_neutral_because_the_client_cannot_know_the_stop_reason", () => {
    // ph7-review 再レビュー軽微1: サーバーは全ての停止理由（日次枠・通知枠・429許容・費用試算・手動停止）で
    // 同じerrorCode「budget_stopped」を返す（reasonsはjobに渡らない構造制約）。ラベルが特定の理由
    // （例: 月次上限）を断定すると、日次枠や手動停止の保留に誤った説明が見えるため中立語彙にする。
    for (const [name, labels] of [
      ["JOB_ERROR_LABELS", JOB_ERROR_LABELS],
      ["REPORT_JOB_ERROR_LABELS", REPORT_JOB_ERROR_LABELS],
    ] as const) {
      const label = labels.budget_stopped!;
      expect(label.includes("月次上限"), `${name}が理由を「月次上限」に固定している`).toBe(false);
      expect(label.includes("上限"), `${name}が停止の性質（上限/運用による停止）に触れていない`).toBe(true);
    }
  });
});
