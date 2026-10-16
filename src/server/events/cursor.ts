import type { AuthzPrincipal } from "../auth/principal";

/**
 * 同期イベントの再開cursor（T072、docs/05 §8）。
 * unit/認可版/対象filter/走査済sequence/期限を**暗号化・認証**したopaque値。
 * HMAC署名（GIS等）ではなくAES-GCMで本文ごと暗号化するのは、cursorに認可版と対象filterが入るため
 * （利用者へ全イベント件数・非可視行・認可の内訳を見せない。docs/05 §8「利用者に…非可視行を示さない」）。
 * 鍵はBETTER_AUTH_SECRETからHKDFで導く（Secretを設定に書かない方針。GISのcursorと同じ発生源）。
 */

/** cursorの本体。利用者には暗号文だけが見える */
export interface SyncCursor {
  /** 対象unit（他unitのcursorでは接続できない） */
  unitId: string;
  /** 発行時の利用者の認可版。現在の値と違えば409 RESYNC_REQUIRED（docs/05 §8） */
  authzVersion: number;
  /** 対象filter（entityType/entityId）。nullは絞り無し（unit全体のstream） */
  entityType: string | null;
  entityId: string | null;
  /** 走査済sequence。この値より大きいsequenceを次に走査する（不可視行でも進む） */
  lastSequence: number;
  /** 有効期限（ISO8601。保持期間外は409 RESYNC_REQUIREDでsnapshotの再取得へ） */
  expiresAt: string;
}

/** cursorの保持期間。1日（日次利用の端末が日またぎで再開できる長さ。events表は削除されないため
 * 再開の下限はこの期限で決まる。docs/05 §8「保持期間外は409 RESYNC_REQUIRED」） */
export const CURSOR_TTL_MS = 24 * 60 * 60 * 1000;

/** cursor発行時刻。Workersの時計（試験ではworkerdの実時刻） */
const cursorExpiry = (nowIso: string): string => new Date(Date.parse(nowIso) + CURSOR_TTL_MS).toISOString();

/**
 * AES-GCMの鍵（256bit）。BETTER_AUTH_SECRETからHKDFで導く
 * （BETTER_AUTH_SECRET自体を鍵として使わず、用途ごとの導出に分ける。GIS cursorの`gis-cursor:`接頭辞と同じ発想）。
 */
export async function cursorKey(secret: string): Promise<CryptoKey> {
  const base = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), "HKDF", false, ["deriveKey"]);
  return crypto.subtle.deriveKey(
    { name: "HKDF", hash: "SHA-256", salt: new TextEncoder().encode("fireos-events-cursor"), info: new TextEncoder().encode("AES-GCM") },
    base,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

const b64url = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes)).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
const unb64url = (s: string) => Uint8Array.from(atob(s.replaceAll("-", "+").replaceAll("_", "/")), (c) => c.charCodeAt(0));

/** v1.<iv>.<暗文> の形。IVは毎回新しく（GCMのIV再利用を避ける。同じ位置でも暗文は変わり得る） */
export async function encodeSyncCursor(key: CryptoKey, cursor: SyncCursor): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const plain = new TextEncoder().encode(JSON.stringify(cursor));
  const encrypted = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, plain));
  return `v1.${b64url(iv)}.${b64url(encrypted)}`;
}

/** 改変・鍵違い・形式不正・型の不整合は全てnull（呼び出し側は409 RESYNC_REQUIREDにする） */
export async function decodeSyncCursor(key: CryptoKey, value: string): Promise<SyncCursor | null> {
  const [version, iv, encrypted] = value.split(".");
  if (version !== "v1" || !iv || !encrypted) return null;
  try {
    const plain = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: unb64url(iv) as BufferSource },
      key,
      unb64url(encrypted) as BufferSource,
    );
    const parsed = JSON.parse(new TextDecoder().decode(plain)) as SyncCursor;
    const ok =
      typeof parsed.unitId === "string" && parsed.unitId.length > 0 &&
      typeof parsed.authzVersion === "number" && Number.isInteger(parsed.authzVersion) && parsed.authzVersion >= 1 &&
      (parsed.entityType === null || (typeof parsed.entityType === "string" && parsed.entityType.length > 0)) &&
      (parsed.entityId === null || typeof parsed.entityId === "string") &&
      typeof parsed.lastSequence === "number" && Number.isInteger(parsed.lastSequence) && parsed.lastSequence >= 0 &&
      typeof parsed.expiresAt === "string" && !Number.isNaN(Date.parse(parsed.expiresAt));
    // entityIdがあるのにentityTypeが無い絞りは契約に無い（entityTypeだけの絞りは「種別すべて」で許す）
    if (!ok || (parsed.entityId !== null && parsed.entityType === null)) return null;
    return parsed;
  } catch {
    return null;
  }
}

/** principalから新しいcursorを作る（snapshot/readEvents共通。位置とfilterは呼び出し側が指定する） */
export function newSyncCursor(
  p: AuthzPrincipal,
  position: { entityType: string | null; entityId: string | null; lastSequence: number },
  nowIso: string,
): SyncCursor {
  return {
    unitId: p.unitId,
    authzVersion: p.authzVersion,
    entityType: position.entityType,
    entityId: position.entityId,
    lastSequence: position.lastSequence,
    expiresAt: cursorExpiry(nowIso),
  };
}
