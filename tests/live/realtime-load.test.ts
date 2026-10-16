import { describe, expect, it } from "vitest";

/**
 * T073 / V06: 実Cloudflare（staging）での**30実端末**の更新配信と切断後snapshot回復の確認。
 * 局所のworkers試験（tests/realtime.test.ts。workerd＋ローカルD1で30本のpoll接続を模擬）の代わりには
 * ならない。実回線の遅延・実端末の電池/回線・同時接続の実挙動が含まれないためである。
 * 環境が無ければ「未実施」として失敗する（スキップして完了扱いにしない）。
 * 手順は docs/evidence/V06-realtime.md のT073節。
 *
 * 現状（T073時点）: 輸送方式はpoll（API-80のcursor再開・2秒周期＋backoff）に暫定固定。
 * このharnessが確かめること（実環境での確認項目）:
 *  1. 30実端末（実ブラウザ/実回線）が同じunitでpollしているとき、更新の反映遅延のp95がD18の開発案（5秒）以内
 *  2. 電波の切断/復帰・バックグラウンド復帰のあと、cursorの再開で取りこぼしがない（版が後退しない）
 *  3. 24時間以上前のcursor（期限切れ）・役割変更（失権）後の再接続は409 → snapshot（API-70）の取り直しで回復
 *  4. 30端末×pollのD1読み取り費用の概算（T082の代表件数測定の入力になる）
 *
 * 必要な環境変数（既存live試験と同じ）:
 *   LIVE_BASE_URL          配置したWorkerのhttps URL
 *   LIVE_BOOTSTRAP_EMAIL   初期管理者の招待先メール
 *   LIVE_BOOTSTRAP_TOKEN   同CLIが一度だけ表示した招待token
 *
 * 手順（docs/evidence/V06-realtime.md。すべて架空データで行う。実データを載せない）:
 *  1. `npx wrangler deploy --env staging` でWorkerを配置し、`npm run migrate -- --env staging --yes-i-know`
 *     でmigrationまで適用する（V01/V02の手順と共通）。
 *  2. 管理者でログインし、団員を30人分招待する（API-03→API-33。実端末は実ブラウザで招待を受領する。
 *     実端末が用意できない場合は、別ネットワーク（モバイル回線等）の実ブラウザ30セッションで代用し、
 *     その条件を証跡に明記する）。
 *  3. 30端末すべてで同じ出動記録（SCR-12）を開き、端末ごとのpoll周期（2秒）でAPI-80が回っていることを
 *     開発者ツールのネットワーク記録で確認する。
 *  4. 1端末から状態を変更し（API-69）、各端末の表示が変わるまでの時刻を30端末分記録する
 *     （Performance APIのタイムスタンプか、サーバーの監査ログと端末時計の対応）。p95を計算する。
 *  5. 端末の通信を切る（機内モード等）→ さらに変更を2回commit → 通信を戻す。表示が最新まで追いつき、
 *     版が後退しないことを確認する。
 *  6. 役割を変える（認可版を進める）→ 端末の次のpollが409 → 画面が自動で再同期する（表示は変化なし）ことを
 *     ネットワーク記録（409の後のAPI-70→API-80）で確認する。
 *  7. このharnessのexpectを上記の実測値で確定させ（p95の数値・取りこぼし0・回復成功）、
 *     docs/evidence/V06-realtime.md の「未実施」を実測結果に書き換える。
 */
const base = process.env.LIVE_BASE_URL;
const email = process.env.LIVE_BOOTSTRAP_EMAIL;
const token = process.env.LIVE_BOOTSTRAP_TOKEN;

function requireLive(): never {
  if (!base || !email || !token) {
    throw new Error(
      "実Cloudflareの環境が未設定のため、この試験は未実施です。LIVE_BASE_URL / LIVE_BOOTSTRAP_EMAIL / LIVE_BOOTSTRAP_TOKEN を設定し、" +
        "docs/evidence/V06-realtime.md T073節の手順（30実端末での更新反映p95実測・切断/再接続・失権後のsnapshot回復）を実施してください",
    );
  }
  if (!base.startsWith("https://")) throw new Error("LIVE_BASE_URL は https である必要があります");
  throw new Error(
    "実30端末での更新配信は未実施です。上記の手順（staging配置→団員30人の招待と実端末での受領→SCR-12を30端末で開く→" +
      "1端末からの変更で反映遅延p95を実測→切断/再接続で取りこぼし0を確認→役割変更後の409→snapshot再同期を確認）を実施し、" +
      "expectを実測で確定してください",
  );
}

describe("実Cloudflareでの30端末の更新配信と切断後snapshot回復 (V06/T073)", () => {
  it("thirty_real_terminals_receive_updates_within_p95_and_recover_via_snapshot", async () => {
    // 環境が揃うまで必ず失敗する（未実施を「成功」にしない）。揃ったら上記の手順を実施してexpectを実測で確定する。
    requireLive();
    const origin = new URL(base!).origin;
    const get = async (path: string, cookie = "") =>
      fetch(`${origin}${path}`, { method: "GET", headers: { origin, ...(cookie ? { cookie } : {}) } });
    void get;
  });
});
