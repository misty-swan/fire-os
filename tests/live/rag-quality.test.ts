import { describe, expect, it } from "vitest";

/**
 * T067 / V04: 実Cloudflare（staging）での出典付きRAG回答の品質評価（docs/06 §6のRAG行）。
 * 局所のworkers試験（tests/rag.test.ts・決定的fake＋サーバー側検証）の代わりにはならない。
 * **環境が無ければ「未実施」として失敗する**（スキップして完了扱いにしない。既存live試験と同じ）。
 *
 * 評価の内容（docs/16 T067の開発閾値。RAG評価のai_evaluation_runs機構への追加〔docs/04:155の
 * kind語彙拡張='rag'〕は実モデル出力が存在するようになってから＝V04。プリフライト裁定3）:
 *  - 固定dataset（tests/fixtures/ai/rag-holdout.jsonl・sha256=808631d6…）の質問50問以上を
 *    実AI（stagingのenv.AI binding）で実行し、**サーバー側の決定的検証**（引用spanがchunk本文に
 *    正規化なしで完全一致・出力前ACL再検査）を通った回答だけを数える。
 *  - 開発閾値: citationMatchRate（回答の出典がdatasetの正解根拠と一致する割合）===1、
 *    権限外chunk（別unit・非公開・draft版）の漏えい0、捏造引用（検証を破棄された応答を除き、
 *    保存・応答に現れたchunk外の引用）0、根拠なし/略語質問はabstained（保留）。
 *
 * 必要な環境変数（既存live試験と同じ）:
 *   LIVE_BASE_URL          配置したWorkerのhttps URL
 *   LIVE_BOOTSTRAP_EMAIL   初期管理者の招待先メール
 *   LIVE_BOOTSTRAP_TOKEN   同CLIが一度だけ表示した招待token
 *
 * 手順（docs/evidence/V04-retrieval.md T067節。すべて架空データで行う。実データを載せない）:
 *  1. `npx wrangler deploy --env staging` で実AI bindingを持つWorkerを配置し、migration 0029まで適用する。
 *  2. 管理者でログインし、固定datasetの資料50件以上を API-73（文書）→API-26（原本添付）→API-74（版）→
 *     API-75（承認）で投入する（原本は dataset の pages を1頁1行のテキストPDFとして架空生成する。
 *     投入スクリプトの形はV04に記録）。Cron/Queueで document.extract／document.index job が
 *     succeeded になるまで待つ（API-86）。
 *  3. unit A相当の主体（PER-11）で API-76 にdatasetの質問（query）を順にPOSTする。
 *     各応答について: abstained=false の回答は citations が正解根拠（docKey/pageNo/snippet→chunk）と
 *     一致することを確認し、citationMatchRate=1・漏えい0・捏造0を集計する。
 *     no_evidence/other_unit質問は abstained=true（保留）であることを確認する。
 *  4. 団員主体（ACL絞り）で非公開文書・別unitの正解質問をPOSTし、回答・引用に権限外の内容が
 *     現れないこと（abstained）を確認する。
 *  5. 撤回（API-92）→ 保存済み回答の引用元が失権した状態で同質問をPOSTし、withheld（abstained=true
 *     ＋引用0）になることを確認する。
 *  6. この実測（50問の内訳・citationMatchRate・漏えい・捏造・abstained率・usage）を
 *     docs/evidence/V04-retrieval.md のT067節へ記録する。
 */
const base = process.env.LIVE_BASE_URL;
const email = process.env.LIVE_BOOTSTRAP_EMAIL;
const token = process.env.LIVE_BOOTSTRAP_TOKEN;

function requireLive(): never {
  if (!base || !email || !token) {
    throw new Error(
      "実Cloudflareの環境が未設定のため、この試験は未実施です。LIVE_BASE_URL / LIVE_BOOTSTRAP_EMAIL / LIVE_BOOTSTRAP_TOKEN を設定し、" +
        "docs/evidence/V04-retrieval.md T067節の手順（実AIで固定dataset 50問を投入→API-76で実行→引用一致100%/漏えい0/捏造0を集計）を実施してください",
    );
  }
  if (!base.startsWith("https://")) throw new Error("LIVE_BASE_URL は https である必要があります");
  throw new Error(
    "実CloudflareでのRAG品質評価（実AI・固定dataset 50問）は未実施です。上記の手順（migration 0029適用→API-73/26/74/75で資料投入→" +
      "document.extract/document.index jobのsucceeded確認→API-76で質問50問を実行→citationMatchRate===1・漏えい0・捏造0・" +
      "no_evidence/other_unit/非公開/生成中撤回のabstained確認→団員主体でのACL絞り確認→API-92撤回後のwithheld確認）を実施し、" +
      "expectを実測で確定してください。集計結果は docs/evidence/V04-retrieval.md T067節へ記録します",
  );
}

describe("実Cloudflareでの出典付きRAG回答の品質評価 (V04/T067)", () => {
  it("rag_answers_meet_quality_thresholds_on_live_ai", async () => {
    // 環境が揃うまで必ず失敗する（未実施を「成功」にしない）。揃ったら上記の手順を実施してexpectを実測で確定する。
    requireLive();
    const origin = new URL(base!).origin;
    const post = async (path: string, body: unknown, headers: Record<string, string> = {}, cookie = "") =>
      fetch(`${origin}${path}`, {
        method: "POST",
        headers: { "content-type": "application/json", origin, ...(cookie ? { cookie } : {}), ...headers },
        body: JSON.stringify(body),
      });
    void post;
  });
});
