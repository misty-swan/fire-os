import { describe, expect, it } from "vitest";

/**
 * T066 / V04: 実Cloudflare（staging）での索引の投入・検索・失効回収の確認。
 * 局所のworkers試験（tests/retrieval.test.ts・workerd＋実D1エンジン上のFTS5実測）の代わりには
 * ならない。環境が無ければ「未実施」として失敗する（スキップして完了扱いにしない）。
 * 手順は docs/evidence/V04-retrieval.md のT066節。
 *
 * 現状（T066時点）: 索引の投入/回収（document.index/deindex/reindex job・FTS5仮想表0028）と
 * 検索port（src/server/search/adapter.ts）は実装済み。ただし**検索のAPI（API-76）はT067**のため、
 * 実CloudflareでHTTPから確認できるのは ①migration 0028の適用 ②job経路の投入→回収 まで。
 * FTS MATCH経由の検索品質は、実測比較（Vectorize対比・実データ量でのrows read）と合わせて
 * V04の残手順。T067でAPI-76が実装されたら、この試験に検索（HTTP）のexpectを追加して確定させる。
 *
 * 必要な環境変数（既存live試験と同じ）:
 *   LIVE_BASE_URL          配置したWorkerのhttps URL
 *   LIVE_BOOTSTRAP_EMAIL   初期管理者の招待先メール
 *   LIVE_BOOTSTRAP_TOKEN   同CLIが一度だけ表示した招待token
 *
 * 手順（docs/evidence/V04-retrieval.md。すべて架空データで行う。実データを載せない）:
 *  1. `npx wrangler deploy --env staging` でWorkerを配置し、`npm run migrate -- --env staging --yes-i-know`
 *     で drizzle/0028_search_index.sql まで適用する（`sqlite_master` に document_chunks_fts があることを
 *     確認。FTS5仮想表のため `PRAGMA table_info` ではなく `SELECT * FROM document_chunks_fts LIMIT 1` 等）。
 *  2. 管理者でログイン（実セッション。既存live試験と同じ）し、文書（API-73）→原本PDF添付（API-26）→
 *     版作成（API-74）→ 申請・承認（API-75）まで進める。承認応答のindexJobIdを控える。
 *  3. Cron（またはQueue）でjobが回ることを待ち、API-86で indexJobId が succeeded・
 *     resultRef が `indexed:<N>` であることを確定する（投入）。
 *  4. （T067以降）API-76で検索し、添付したPDFの語でhitすることを確定する（検索）。
 *  5. 版を作り直して再承認し、旧版のhitが消えること（版変更。検索はT067以降）を確認する（更新）。
 *  6. 撤回（API-92）の応答のdeindexJobIdが succeeded・resultRef が `removed:<N>` になり、
 *     （T067以降）検索からも消えることを確定する（失効回収）。
 *  7. この文書と V04 の「未実施」を実測結果に書き換える。
 */
const base = process.env.LIVE_BASE_URL;
const email = process.env.LIVE_BOOTSTRAP_EMAIL;
const token = process.env.LIVE_BOOTSTRAP_TOKEN;

function requireLive(): never {
  if (!base || !email || !token) {
    throw new Error(
      "実Cloudflareの環境が未設定のため、この試験は未実施です。LIVE_BASE_URL / LIVE_BOOTSTRAP_EMAIL / LIVE_BOOTSTRAP_TOKEN を設定し、" +
        "docs/evidence/V04-retrieval.md T066節の手順（migration 0028適用→投入→検索〔T067以降〕→更新→撤回）を実施してください",
    );
  }
  if (!base.startsWith("https://")) throw new Error("LIVE_BASE_URL は https である必要があります");
  throw new Error(
    "実Cloudflareでの索引投入・検索・回収は未実施です。上記の手順（環境変数設定→migration 0028適用→API-73/26/74/75で投入→API-86で" +
      "document.index の succeeded と resultRef `indexed:<N>` を確定→〔T067以降〕API-76で検索→API-92で撤回→document.deindex の " +
      "succeeded と `removed:<N>` を確定）を実施し、expectを実測で確定してください",
  );
}

describe("実Cloudflareでの索引投入・検索・失効回収 (V04/T066)", () => {
  it("approved_document_is_indexed_and_withdrawal_is_reclaimed_on_live_d1", async () => {
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
