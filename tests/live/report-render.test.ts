import { describe, expect, it } from "vitest";

/**
 * T058 / V07: 承認済み帳票の出力（API-61）の実表示確認。
 * 局所のworkers試験（tests/report-approval.test.ts）は「PDFとして妥当な先頭バイト（%PDF-）＋
 * 承認版のみ出せること＋CSVの内容正しさ」までしか確認しない。render.tsのPDFは標準CJKフォント
 * （HeiseiMin-W3／UniJIS-UCS2-H）を**非埋め込みで参照**するため、日本語の実表示は
 * ビューアのフォント代替に依存する＝実フォントでの検証が残る（局所完了。docs/14 D20）。
 * この試験は「実行条件」を明示して手順を残すもので、条件を満たさないなら必ず失敗する
 * （fakeでの成功を実表示での成功として扱わない）。docs/evidence/V07-report-render.md。
 *
 * 必要な環境（既存live試験と同じ）:
 *   LIVE_BASE_URL            実環境（demo/staging）のhttps URL
 *   LIVE_BOOTSTRAP_EMAIL     初期管理者の招待先メール
 *   LIVE_BOOTSTRAP_TOKEN     同CLIが一度だけ表示した招待token
 */
const base = process.env.LIVE_BASE_URL;
const email = process.env.LIVE_BOOTSTRAP_EMAIL;
const token = process.env.LIVE_BOOTSTRAP_TOKEN;

function requireLive(): never {
  if (!base || !email || !token) {
    throw new Error(
      "実環境が未設定のため、この試験は未実施です。LIVE_BASE_URL / LIVE_BOOTSTRAP_EMAIL / LIVE_BOOTSTRAP_TOKEN を設定してください（docs/evidence/V07-report-render.md）",
    );
  }
  if (!base.startsWith("https://")) throw new Error("LIVE_BASE_URL は https である必要があります");
  throw new Error(
    "帳票PDF/CSVの実表示検証は未実施です。docs/evidence/V07-report-render.md の手順で実表示（日本語の文字化け/欠落/改ページ）を確認し、このexpectを実測で確定してください",
  );
}

describe("承認済み帳票の実表示 (V07)", () => {
  it("rendered_report_pdf_shows_japanese_text_and_csv_opens_in_real_tools", async () => {
    // 環境が揃うまで必ず失敗する（未実施を「成功」にしない）。揃ったら以下の手順を実施してexpectを実測で確定する。
    requireLive();
    void base;
    void email;
    void token;

    // --- 手順（docs/evidence/V07-report-render.md）---
    // 1. 実環境（demo/staging）に配置し、管理者でログイン（実セッション。既存live試験と同じ）
    // 2. 架空データの活動＋実績（参加人数・時刻を含む）を作り、手動帳票（API-62）で下書きを作る
    // 3. API-60で request_review → approve し、承認版を作る（承認者欄に表示名が載ることを確認）
    // 4. API-61 format=pdf を実端末で開く: ①日本語の文字化け/欠落が無いこと（非埋め込みCJKフォント
    //    の代替が働くこと。欠ける場合はrender.tsのフォント方針をV07へ記録して再設計）
    //    ②20,000字近い本文で改ページが効くこと ③ activityTitleが=で始まるデータで無害化を確認
    // 5. API-61 format=csv を実Excel/Numbersで開く: 文字化けが無いこと、式が実行されないこと
    //    （=で始まるセルが ' で無害化されていること）、BOMにより日本語が正しく読めること
    // 6. 未承認の帳票（承認版が無いもの）でAPI-61がnot 200であることを実環境でも確認する
    // 7. 結果（スクリーンショット/開けたビューアと版）をV07へ記録し、このexpectを実測に書き換える
  });
});
