import { describe, expect, it } from "vitest";

/**
 * T053 / V04: 実Workers AI（env.AI = typesafe/jev）での分類の確認。
 * 局所のworkers試験（tests/jev.test.tsのfake注入）の代わりにはならない。環境が無ければ
 * 「未実施」として失敗する（スキップして完了扱いにしない）。手順は docs/evidence/V04-jev.md。
 *
 * 現状（T053時点）: D12（AI送信条件・評価集合・品質閾値）が未了承のため実データ/実呼出しは未実施。
 * この試験は「実行条件」を明示して手順を残すもので、条件を満たさないなら必ず失敗する
 * （fakeでの成功を実AIでの成功として扱わない）。条件が揃ったら docs/evidence/V04-jev.md の
 * 手順に沿って実呼出しを行い、このexpectを実測に合わせて確定させる。
 *
 * 必要な環境（docs/evidence/V04-jev.md「未実施の手順」参照）:
 *   LIVE_BASE_URL            AI binding（ai: { binding: "AI" }）を持つ環境のhttps URL（既存live試験と同じ）
 *   LIVE_BOOTSTRAP_EMAIL     初期管理者の招待先メール
 *   LIVE_BOOTSTRAP_TOKEN     同CLIが一度だけ表示した招待token
 *   さらにWorkers AIはwranglerログイン（実Cloudflare接続）を要求する。ローカルのworkerdには
 *   env.AIが無いため、この試験は局所では必ず失敗する（ai_unavailable＝正しい挙動）。
 */
const base = process.env.LIVE_BASE_URL;
const email = process.env.LIVE_BOOTSTRAP_EMAIL;
const token = process.env.LIVE_BOOTSTRAP_TOKEN;

function requireLive(): never {
  if (!base || !email || !token) {
    throw new Error(
      "実Cloudflareの環境が未設定のため、この試験は未実施です。LIVE_BASE_URL / LIVE_BOOTSTRAP_EMAIL / LIVE_BOOTSTRAP_TOKEN を設定してください（docs/evidence/V04-jev.md）",
    );
  }
  if (!base.startsWith("https://")) throw new Error("LIVE_BASE_URL は https である必要があります");
  throw new Error(
    "実Workers AI（typesafe/jev）の実呼出しは未実施です。D12（AI送信条件）の了承のうえ、docs/evidence/V04-jev.md の手順で " +
      "AI binding付き環境への配置と実呼出し（モデル版の固定可否・usageの実測・日本語品質）を先に実施し、このexpectを実測で確定してください",
  );
}

describe("実Workers AIでのJev分類 (V04)", () => {
  it("real_jev_run_returns_schema_valid_answers_and_usage_is_recorded", async () => {
    // 環境が揃うまで必ず失敗する（未実施を「成功」にしない）。揃ったら以下の手順を実施してexpectを実測で確定する。
    requireLive();
    void base;
    void email;
    void token;

    // --- 手順（docs/evidence/V04-jev.md）---
    // 1. AI binding付き環境（demo/staging）に配置し、管理者でログイン（実セッション。既存live試験と同じ）
    // 2. 架空データの点検（note＋明細）を作り、API-29で分類を依頼（202）
    // 3. API-86でjobがsucceededになること、ai_evaluationsの候補（categories/needsReview/usage）と
    //    実モデル版（actual_model_version）を実測で確定
    // 4. 壊れ出力・曖昧（noul高位）・範囲外がmanual_reviewになることを実応答で確認（docs/06 §2の検証項目）
    // 5. 応答のusage実測から入力token単価・1依頼あたりの費用をV04の表へ記入する
    // 6. 日本語品質（docs/06 §6のsmoke例6件）を試し、結果をV04の証跡として保存する
    // 7. この文書と V04 の「未実施」を実測結果に書き換える
  });
});
