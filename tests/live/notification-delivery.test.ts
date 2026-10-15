import { describe, expect, it } from "vitest";

/**
 * T051 / V06: 実チャネル（Web Push または email）での通知配送の確認。
 * 局所のworkers試験（tests/notification-delivery.test.ts）の代わりにはならない。環境が無ければ
 * 「未実施」として失敗する（スキップして完了扱いにしない）。手順は docs/evidence/V06-delivery.md。
 *
 * 現状（T051時点）: D13が未了承のため実チャネルは未選定・未実装。この試験は「実行条件」を
 * 明示して手順を残すもので、条件を満たさないなら必ず失敗する（fake adapterでの成功を
 * 実端末への到達として扱わない）。条件が揃ったら docs/evidence/V06-delivery.md の手順に沿って
 * provider（src/server/notifications/provider.ts へのregisterChannelProvider）を実装し、
 * この試験のexpectを実測に合わせて確定させる。
 *
 * 必要な環境変数（docs/evidence/V06-delivery.md「未実施の手順」参照）:
 *   LIVE_BASE_URL            配置したWorkerのhttps URL（既存live試験と同じ）
 *   LIVE_BOOTSTRAP_EMAIL     初期管理者の招待先メール
 *   LIVE_BOOTSTRAP_TOKEN     同CLIが一度だけ表示した招待token
 *   LIVE_DELIVERY_CHANNEL    実チャネルの選定（D13の了承後）: 'webpush' または 'email'
 *   さらにチャネルごとのSecret（Web Push: VAPID鍵／email: 送信APIのAPIキー）を wrangler secret put する
 */
const base = process.env.LIVE_BASE_URL;
const email = process.env.LIVE_BOOTSTRAP_EMAIL;
const token = process.env.LIVE_BOOTSTRAP_TOKEN;
const channel = process.env.LIVE_DELIVERY_CHANNEL;

function requireLive(): never {
  if (!base || !email || !token) {
    throw new Error(
      "実Cloudflareの環境が未設定のため、この試験は未実施です。LIVE_BASE_URL / LIVE_BOOTSTRAP_EMAIL / LIVE_BOOTSTRAP_TOKEN を設定してください（docs/evidence/V06-delivery.md）",
    );
  }
  if (!base.startsWith("https://")) throw new Error("LIVE_BASE_URL は https である必要があります");
  if (channel !== "webpush" && channel !== "email") {
    throw new Error(
      "実チャネルが未選定のため、この試験は未実施です。D13（通知チャネル・送信許可）の了承のうえ LIVE_DELIVERY_CHANNEL=webpush|email を設定してください（docs/evidence/V06-delivery.md）",
    );
  }
  throw new Error(
    "実チャネルのprovider（Web Push/email）は未実装のため、この試験は未実施です。docs/evidence/V06-delivery.md の手順で Secret・provider・実端末/実メールボックスの受信確認を先に実施し、このexpectを実測で確定してください",
  );
}

describe("実チャネルでの通知配送 (V06)", () => {
  it("approved_notification_reaches_the_real_device_and_provider_acceptance_is_recorded", async () => {
    // 環境が揃うまで必ず失敗する（未実施を「成功」にしない）。揃ったら以下の手順を実施してexpectを実測で確定する。
    requireLive();
    const origin = new URL(base!).origin;
    const post = async (path: string, body: unknown, headers: Record<string, string> = {}, cookie = "") =>
      fetch(`${origin}${path}`, {
        method: "POST",
        headers: { "content-type": "application/json", origin, ...(cookie ? { cookie } : {}), ...headers },
        body: JSON.stringify(body),
      });
    void post;

    // --- 手順（docs/evidence/V06-delivery.md）---
    // 1. 管理者でログイン（実セッション。既存live試験と同じ）
    // 2. 活動（架空データ）を作り、通知draft（API-63）→ 承認（API-64、実チャネルchannelで）
    // 3. 実端末でPush許可/実メールボックスで受信を確認し（人手）、証跡（スクリーンショット/受信ヘッダ）を保存
    // 4. job（API-86）がsucceeded、対象者のmyDeliveryがprovider_accepted（受付）で
    //    recipient.read_atがNULL（受付≠到達≠既読）であることをAPI応答で確定
    // 5. 拒否（許可なし端末）/不明（機内モード等）の宛先が failed→retry_wait / unknown になることを確認
    // 6. この文書と V06 の「未実施」を実測結果に書き換える
  });
});
