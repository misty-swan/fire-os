import type { notificationChannels } from "../../shared/states";

/** 通知チャネル（docs/14 D13の検証設定＝アプリ内一経路。states.ts notificationChannelsが正本） */
export type NotificationChannel = (typeof notificationChannels)[number];

/** provider.sendの入力（docs/16 T051のInterface）。deliveryKeyは再試行で固定の効果キー（docs/02 §5） */
export interface DeliverySendInput {
  deliveryKey: string;
  addressRef: string;
  body: string;
}

/**
 * provider.sendの結果（docs/16 T051のInterface）。
 * - provider_accepted: providerが受け付けた（端末到達の保証ではない。docs/11「受付≠到達≠既読」）
 * - failed: providerが明確に拒否した（errorCodeはdeliveries.last_error_codeへ入る短いコード。再送待ちへ）
 * - unknown: 受付の成否が不明（タイムアウト等）。無条件に再送せず、照会/人確認に回す
 */
export type DeliveryResult =
  | { kind: "provider_accepted"; providerId?: string }
  | { kind: "failed"; errorCode: string }
  | { kind: "unknown" };

/**
 * 1チャネル1provider。sendは実チャネル次第で冪等でない（受け付けた通知を2回出し得る）ため、
 * dispatcher（dispatchNotification）が固定のdelivery_keyで台帳側の重複を防ぎ、
 * 同じdelivery_keyへの2回目のsendが起きないよう呼び出し側で制御する（docs/02 §5）。
 */
export interface NotificationProvider {
  channel: NotificationChannel;
  /** provider識別子（deliveries.provider_idへ記録。send結果のproviderIdを優先し、無ければこれを使う） */
  id: string;
  send(input: DeliverySendInput): Promise<DeliveryResult>;
}

const providers = new Map<NotificationChannel, NotificationProvider>();

/** チャネルのproviderを登録する（後入れ替え可。実チャネルの追加と試験用の差し替えに使う） */
export function registerChannelProvider(provider: NotificationProvider): void {
  providers.set(provider.channel, provider);
}

/** チャネルのprovider（未登録ならnull。dispatcherはその宛先を送らずjobの再試行で手動確認へ落とす） */
export function channelProvider(channel: NotificationChannel): NotificationProvider | null {
  return providers.get(channel) ?? null;
}

/**
 * inapp（アプリ内通知）の既定provider（docs/14 D13の検証設定＝アプリ内一経路。T050で実装済みのchannel）。
 * アプリ内はnotification_recipients行そのものが受信箱（API-67/100が読む）で、外部への送出が無い。
 * そのためsendは内部成立＝即座に受付済みを返す（providerIdは内部識別子）。
 * Web Push/emailの実providerはD13の了承後にregisterChannelProviderで追加する（docs/evidence/V06-delivery.md）。
 *
 * 【到達不明（unknown）の試験/デモ用の規約（docs/03 §1.1に記録。T052）】
 * 実チャネルが無いため「providerで宛先が解決できず、送受の成否が不明（unknown）になる」状態を実データで
 * 再現できない。そこでこのproviderに限り、address_refが `unknown:` 接頭辞（notifications.tsの
 * UNKNOWN_ADDRESS_SQUAD＝班が「連絡先未登録」の団員に付く内部試験値。実連絡先ではない。Secretは無い）
 * のときだけ結果unknownを返す。接頭辞が無い通常の参照は内部成立のままで、本番のinapp挙動は変わらない。
 * unknownの意味論（無条件再送しない・照会/人確認に回す）は実チャネルと同じで、画面の配送結果の
 * 「到達不明」表示と「結果を確認」導線の検証（T052のe2e）に使う。
 */
registerChannelProvider({
  channel: "inapp",
  id: "internal-inbox",
  async send({ addressRef }) {
    if (addressRef.startsWith("unknown:")) return { kind: "unknown" };
    return { kind: "provider_accepted", providerId: "internal-inbox" };
  },
});
