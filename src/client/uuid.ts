/**
 * UUIDv4の生成。`crypto.randomUUID` は **secure context（HTTPS/localhost）でしか提供されない**ため、
 * 平文HTTPのLANアクセス（T083実機確認で発見。`http://192.168.x.x:8787` で描画が落ちていた）では
 * TypeErrorになる。クライアントの全UUID生成（冪等キー・deviceId・画面内の一時キー等）はこのヘルパー経由にする。
 *
 * フォールバックは `crypto.getRandomValues`（secure context外でも使えるCSPRNG）でUUIDv4を自作する
 * （バージョン4・バリアント10xxのビットを設定）ため、**推測不能性は randomUUID と同等**に保たれる
 * （docs/05の送信キー〔Idempotency-Key〕は「同じキー/本文の再送は元の応答」の冪等の鍵で、推測できないことが前提）。
 */
export function randomUuid(): string {
  if (typeof crypto.randomUUID === "function") return crypto.randomUUID();
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6]! & 0x0f) | 0x40; // バージョン4
  bytes[8] = (bytes[8]! & 0x3f) | 0x80; // バリアント10xx
  const hex = [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}
