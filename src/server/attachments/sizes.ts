import type { ApiContext } from "../http";
import { sha256Hex } from "../mutations/hash";

/** 添付の上限（docs/07 §3.3の案。D20で実業務の形式・容量が確定したら見直す） */
export const ATTACHMENT_LIMITS = {
  /** 画像(jpeg/png/webp) */
  imageBytesMax: 10 * 1024 * 1024,
  /** ファイル(pdf/csv) */
  fileBytesMax: 20 * 1024 * 1024,
  /** 予約・intentの保持時間（15分案） */
  intentTtlMs: 15 * 60 * 1000,
} as const;

/** 許可する形式（SVG/HTML/実行形式は許可しない。docs/07 §3.3） */
export const CONTENT_TYPE_LIMITS: Record<string, { max: number; kind: "image" | "file" }> = {
  "image/jpeg": { max: ATTACHMENT_LIMITS.imageBytesMax, kind: "image" },
  "image/png": { max: ATTACHMENT_LIMITS.imageBytesMax, kind: "image" },
  "image/webp": { max: ATTACHMENT_LIMITS.imageBytesMax, kind: "image" },
  "application/pdf": { max: ATTACHMENT_LIMITS.fileBytesMax, kind: "file" },
  "text/csv": { max: ATTACHMENT_LIMITS.fileBytesMax, kind: "file" },
};

/** intent対象のうち、点検・異常への添付は現場写真を含み得るためSENSITIVE（docs/10 §3）。それ以外はBASIC */
export const SENSITIVE_TARGET_TYPES = new Set(["inspection", "issue"]);

/**
 * 実測容量の上限まで本文を読み、超えたら読むのをやめて打ち切る
 * （全部をメモリに載せてから判定すると、上限超の送信でWorkerのメモリ上限に達するため）。
 */
export async function readBodyCapped(
  body: ReadableStream<Uint8Array> | null,
  cap: number,
): Promise<{ bytes: Uint8Array; size: number } | { over: true }> {
  if (!body) return { over: true };
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > cap) {
      await reader.cancel();
      return { over: true };
    }
    chunks.push(value);
  }
  const all = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    all.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { bytes: all, size: total };
}

/** バイト列のsha256（16進）。本文はすでに上限まで読み終えたものを渡す */
export const sha256OfBytes = async (bytes: Uint8Array): Promise<string> => {
  const digest = await crypto.subtle.digest("SHA-256", bytes as BufferSource);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
};

/** 転送tokenの生成（応答の一回だけ見せる。DBにはhashだけ） */
export const newUploadToken = (): string => crypto.randomUUID().replaceAll("-", "") + crypto.randomUUID().replaceAll("-", "");

export const uploadTokenHash = (token: string): Promise<string> => sha256Hex(`upload-token:${token}`);

/**
 * 添付を保存するR2鍵。鍵はサーバー生成で不変。
 *  - staging: 試行ごとに別鍵（同じ鍵の上書き転送を構造的に不可能にする）
 *  - ready: 検査済み実体を内容hashで固定（T016。同じ内容は既存の鍵を再利用）
 */
export const stagingKeyFor = (unitId: string, attachmentId: string, attemptId: string) =>
  `staging/${unitId}/${attachmentId}/${attemptId}`;
export const readyKeyFor = (unitId: string, attachmentId: string, sha256: string) => `ready/${unitId}/${attachmentId}/${sha256}`;
