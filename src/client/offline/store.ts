import { LIMITS } from "../../shared/contracts/common";
import { syncOperationStates } from "../../shared/states";
import { DraftStoreError, type DraftScope, type DraftStore, type LocalDraft } from "./types";

/**
 * 端末下書きのIndexedDB実装（T075、docs/07 端末保持・docs/14 D14）。
 *
 * - DBは1つ（fireos-drafts）。drafts（下書き本体）とattachment_blobs（写真の実体）の2つのstoreに、
 *   scope（user/unit/device）とexpiresAtの索引を付ける。読みは必ずscopeで絞る＝別ユーザーの下書きは読めない。
 * - 写真は端末内の参照（blobKey）で下書きから指す。サーバーのattachmentIdは同期時（T076/T077）に確定する。
 *   実体はArrayBufferで保存する（EXIF等の端末メタデータは含めない。docs/07 §3の再構築方針と同じ整理）。
 * - 保持は7日（D14推奨案の検証設定。lifecycle.DRAFT_TTL_DAYS）。expire()は期限切れ行と写真を実削除する。
 * - purge()はscopeのうちuserIdだけを一致条件にする（unitId/deviceIdは使わない）。分団の異動や
 *   招待し直しでscopeの残りが変わっても、この端末に残した本人の分を確実に消すため（docs/07: ログアウト/切替で破棄）。
 * - D14: 端末を紛失したあとの遠隔消去（offline回収）は保証しない。ここで守るのは「ログアウト・切替・TTL」まで。
 * - 生のsession token等は保存しない（assertNoSecrets）。本命は契約（payloadは業務入力だけ）だが、浅い検査でうっかり入りを弾く。
 */

export const DRAFT_DB_NAME = "fireos-drafts";
export const DRAFT_DB_VERSION = 1;
/** store名。e2e（offline-account-switch.spec.ts）がこのschema固定で読み書きするので、変えるときは一緒に直す */
export const DRAFT_STORES = { drafts: "drafts", blobs: "attachment_blobs" } as const;

/** 写真1枚の上限。既存の添付経路と同じ「写真10MiB」（docs/07 §3の上限案・docs/05 API-26） */
export const MAX_PHOTO_BYTES = 10 * 1024 * 1024;
/** 1下書きの添付数上限。点検保存のattachmentIds（docs/05: LIMITS.arrayMax）と同じ */
export const MAX_DRAFT_ATTACHMENTS = LIMITS.arrayMax;

const TEXT_MAX = 200; // docs/05 ShortTextと同じ長さ上限
const HASH_RE = /^[0-9a-f]{64}$/;
/** payloadの欄名に認証情報が混ざっていないかの浅い検査。値ではなく欄名を見る（本文に「token」と書く利用者を弾かないため） */
const SECRET_KEY_RE = /(token|secret|password|session|cookie)/i;

function assertNonEmpty(name: string, value: string): void {
  if (!value || value.length > TEXT_MAX) throw new DraftStoreError("invalid", `${name}が空か長すぎます`);
}

/** payload（と添付の参照）を辿って、認証情報と思われる欄名があれば保存しない。docs/16 T075: 生session tokenをdraftへ保存しない */
function assertNoSecrets(value: unknown, depth = 0): void {
  if (depth > 8 || value === null || typeof value !== "object") return;
  for (const [key, child] of Object.entries(value)) {
    if (SECRET_KEY_RE.test(key)) throw new DraftStoreError("secret", `下書きに認証情報と思われる欄（${key}）は保存できません`);
    assertNoSecrets(child, depth + 1);
  }
}

function validate(draft: LocalDraft): void {
  assertNonEmpty("clientOperationId", draft.clientOperationId);
  assertNonEmpty("operationCode", draft.operationCode);
  assertNonEmpty("scope.userId", draft.scope.userId);
  assertNonEmpty("scope.unitId", draft.scope.unitId);
  assertNonEmpty("scope.deviceId", draft.scope.deviceId);
  if (!Number.isInteger(draft.baseVersion) || draft.baseVersion < 0) throw new DraftStoreError("invalid", "baseVersionが不正です");
  if (!HASH_RE.test(draft.payloadHash)) throw new DraftStoreError("invalid", "payloadHashはSHA-256（16進64桁）で指定してください");
  if (!syncOperationStates.includes(draft.status)) throw new DraftStoreError("invalid", "statusが不正です");
  if (Number.isNaN(Date.parse(draft.createdAt)) || Number.isNaN(Date.parse(draft.expiresAt))) throw new DraftStoreError("invalid", "日時が不正です");
  if (!Array.isArray(draft.attachments) || draft.attachments.length > MAX_DRAFT_ATTACHMENTS) {
    throw new DraftStoreError("limit", `1つの下書きに添付できるのは${MAX_DRAFT_ATTACHMENTS}枚までです`);
  }
  assertNoSecrets(draft.payload);
  assertNoSecrets(draft.attachments);
}

function idb(): IDBFactory {
  // private mode等でIndexedDBが無い環境。失敗は呼び出し側へ返し、通常のWebアプリとしての動作は妨げない
  if (typeof indexedDB === "undefined") throw new DraftStoreError("unavailable", "この端末・ブラウザでは端末保存を利用できません");
  return indexedDB;
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = idb().open(DRAFT_DB_NAME, DRAFT_DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(DRAFT_STORES.drafts)) {
        const drafts = db.createObjectStore(DRAFT_STORES.drafts, { keyPath: "clientOperationId" });
        drafts.createIndex("by_user", "scope.userId");
        drafts.createIndex("by_scope", ["scope.userId", "scope.unitId", "scope.deviceId"]);
        drafts.createIndex("by_expires", "expiresAt");
      }
      if (!db.objectStoreNames.contains(DRAFT_STORES.blobs)) {
        const blobs = db.createObjectStore(DRAFT_STORES.blobs, { keyPath: "blobKey" });
        blobs.createIndex("by_user", "scope.userId");
        blobs.createIndex("by_expires", "expiresAt");
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(new DraftStoreError("unavailable", `端末保存を開けませんでした（${String(req.error?.name ?? "unknown")}）`));
  });
}

function requestAsPromise<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

/**
 * カーソルを最後まで回して（索引の鍵, 主キー）を集める。値（写真の実体など）をメモリへ読まないため
 * openKeyCursorを使う。cursor.continue()はrequestを返さないので、onsuccessの連鎖で集める。
 */
function collectCursorKeys(request: IDBRequest<IDBCursor | null>): Promise<Array<{ key: IDBValidKey; primaryKey: IDBValidKey }>> {
  return new Promise((resolve, reject) => {
    const rows: Array<{ key: IDBValidKey; primaryKey: IDBValidKey }> = [];
    request.onsuccess = () => {
      const cursor = request.result;
      if (!cursor) return resolve(rows);
      rows.push({ key: cursor.key, primaryKey: cursor.primaryKey });
      cursor.continue();
    };
    request.onerror = () => reject(request.error);
  });
}

/** transactionの確定を待つ。失敗はquota等の意味へ写像する（画面は「保存できなかった」と報告する。成功と表示しない） */
function transactionDone(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onabort = () => reject(tx.error ?? new DOMException("aborted", "AbortError"));
    tx.onerror = () => reject(tx.error);
  });
}

function asStoreError(e: unknown): DraftStoreError {
  if (e instanceof DraftStoreError) return e;
  const name = (e as { name?: string } | null)?.name ?? "";
  if (name === "QuotaExceededError") {
    return new DraftStoreError("quota", "端末の保存容量が足りません。写真を減らすか、端末の空き容量を確保してからもう一度保存してください");
  }
  return new DraftStoreError("io", `端末に保存できませんでした（${name || "unknown"}）`);
}

export interface DraftAttachmentInput {
  key: string;
  /** 写真の実体。EXIF等の端末メタデータを含まないよう、呼び出し側で再構築したものを受け取る */
  data: ArrayBuffer | ArrayBufferView;
  contentType: string;
  scope: DraftScope;
  /** 下書きと同じ期限（lifecycle.draftExpiryFrom）。下書きが消えたあとも写真を残さないため */
  expiresAt: string;
}

/** realm差（jsdom・古い実装）に寄らない大きさの取得。instanceofで判定しない */
function byteLengthOf(data: ArrayBuffer | ArrayBufferView): number {
  return ArrayBuffer.isView(data) ? data.byteLength : data.byteLength;
}

export class IndexedDbDraftStore implements DraftStore {
  private dbPromise: Promise<IDBDatabase> | null = null;

  private db(): Promise<IDBDatabase> {
    this.dbPromise ??= openDb();
    return this.dbPromise;
  }

  /** ブラウザ終了の再現（試験用）。以降の操作で再接続する */
  async close(): Promise<void> {
    if (!this.dbPromise) return;
    const db = await this.dbPromise;
    db.close();
    this.dbPromise = null;
  }

  /** 端末のdeviceId（同期操作のdeviceId＝API-81と同じ値）。推測不能なUUIDで、本人を特定する情報は含まない。ログアウトでも消さない */
  static deviceIdOf(): string {
    const key = "fireos.device-id";
    let value: string | null = null;
    try {
      value = localStorage.getItem(key);
      if (!value) {
        value = crypto.randomUUID();
        localStorage.setItem(key, value);
      }
    } catch {
      // localStorageが使えない環境では毎回新しいIDになる（下書きの分離はuserIdで効くので安全側）
      value ??= crypto.randomUUID();
    }
    return value;
  }

  /** 写真を端末に置く。上限超え・容量不足は失敗として報告する（黙って間引かない。docs/16 T075: 保存失敗） */
  async putAttachment(input: DraftAttachmentInput): Promise<void> {
    assertNonEmpty("key", input.key);
    assertNonEmpty("scope.userId", input.scope.userId);
    assertNonEmpty("scope.unitId", input.scope.unitId);
    assertNonEmpty("scope.deviceId", input.scope.deviceId);
    if (Number.isNaN(Date.parse(input.expiresAt))) throw new DraftStoreError("invalid", "日時が不正です");
    const byteLength = (input.data as object) == null ? 0 : byteLengthOf(input.data);
    if (byteLength === 0) throw new DraftStoreError("invalid", "写真の中身が空です");
    if (byteLength > MAX_PHOTO_BYTES) {
      throw new DraftStoreError("limit", "写真は1枚10MBまでです。写真を減らすか、サイズの小さいものを選んでください");
    }
    try {
      const db = await this.db();
      const tx = db.transaction(DRAFT_STORES.blobs, "readwrite");
      tx.objectStore(DRAFT_STORES.blobs).put({
        blobKey: input.key,
        data: input.data,
        contentType: input.contentType,
        byteSize: byteLength,
        scope: input.scope,
        expiresAt: input.expiresAt,
      });
      await transactionDone(tx);
    } catch (e) {
      throw asStoreError(e);
    }
  }

  async hasAttachment(key: string): Promise<boolean> {
    try {
      const db = await this.db();
      const tx = db.transaction(DRAFT_STORES.blobs, "readonly");
      return (await requestAsPromise(tx.objectStore(DRAFT_STORES.blobs).get(key))) != null;
    } catch (e) {
      throw asStoreError(e);
    }
  }

  /** 写真の実体を読む（T077の同期転送用）。参照が壊れている下書きはrunnerが人に報告する（黙って飛ばさない） */
  async getAttachment(key: string): Promise<{ data: ArrayBuffer; contentType: string; byteSize: number } | null> {
    assertNonEmpty("key", key);
    try {
      const db = await this.db();
      const tx = db.transaction(DRAFT_STORES.blobs, "readonly");
      const row = (await requestAsPromise(tx.objectStore(DRAFT_STORES.blobs).get(key))) as
        | { data: ArrayBuffer; contentType: string; byteSize: number }
        | undefined;
      return row ? { data: row.data, contentType: row.contentType, byteSize: row.byteSize } : null;
    } catch (e) {
      throw asStoreError(e);
    }
  }

  /**
   * 下書き1件と、その下書きだけが参照する写真を実削除する（T077。反映済み・人が削除した分）。
   * 送信済みの操作は端末に残さない（docs/07「まだ送っていない業務入力」だけを置く）ため、
   * appliedになった行はこのメソッドで消す。写真は他の下書きが同じblobKeyを参照しない前提
   * （capture時に1下書きごとの鍵にする。store.putAttachmentの呼び出し規約）で、参照する分だけ消す。
   */
  async remove(clientOperationId: string): Promise<void> {
    assertNonEmpty("clientOperationId", clientOperationId);
    try {
      const db = await this.db();
      const tx = db.transaction([DRAFT_STORES.drafts, DRAFT_STORES.blobs], "readwrite");
      const drafts = tx.objectStore(DRAFT_STORES.drafts);
      const row = (await requestAsPromise(drafts.get(clientOperationId))) as LocalDraft | undefined;
      drafts.delete(clientOperationId);
      if (row) {
        const blobs = tx.objectStore(DRAFT_STORES.blobs);
        for (const attachment of row.attachments ?? []) blobs.delete(attachment.blobKey);
      }
      await transactionDone(tx);
    } catch (e) {
      throw asStoreError(e);
    }
  }

  /** 下書きを保存する。参照する写真が端末に無い場合は保存しない（同期に回せない壊れた下書きを残さない） */
  async put(input: LocalDraft): Promise<void> {
    validate(input);
    try {
      const db = await this.db();
      const tx = db.transaction([DRAFT_STORES.drafts, DRAFT_STORES.blobs], "readwrite");
      const blobs = tx.objectStore(DRAFT_STORES.blobs);
      for (const attachment of input.attachments) {
        if ((await requestAsPromise(blobs.get(attachment.blobKey))) == null) {
          // transactionDoneはまだ待っていないので、ここで投げても未処理のrejectにならない
          tx.abort();
          throw new DraftStoreError("invalid", `参照する写真（${attachment.name}）がこの端末にありません。もう一度追加してください`);
        }
      }
      tx.objectStore(DRAFT_STORES.drafts).put(input);
      await transactionDone(tx);
    } catch (e) {
      if (e instanceof DraftStoreError) throw e;
      throw asStoreError(e);
    }
  }

  /** 自分のscopeの下書きだけを読む（新しい順）。別ユーザーの行はscopeが違うため絶対に返さない */
  async list(scope: { userId: string; unitId: string; deviceId: string }): Promise<LocalDraft[]> {
    assertNonEmpty("scope.userId", scope.userId);
    assertNonEmpty("scope.unitId", scope.unitId);
    assertNonEmpty("scope.deviceId", scope.deviceId);
    try {
      const db = await this.db();
      const tx = db.transaction(DRAFT_STORES.drafts, "readonly");
      const index = tx.objectStore(DRAFT_STORES.drafts).index("by_scope");
      const rows = await requestAsPromise(index.getAll(IDBKeyRange.only([scope.userId, scope.unitId, scope.deviceId])));
      return (rows as LocalDraft[]).sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
    } catch (e) {
      throw asStoreError(e);
    }
  }

  /**
   * この端末から、指定した利用者の下書きと写真を全部消す（ログアウト・ユーザー切替。docs/07: データと鍵を破棄）。
   * scopeのうちuserIdだけを一致条件にする（unitId/deviceIdは絞り込みに使わない＝分団が変わっても確実に消える）。
   */
  async purge(scope: DraftScope): Promise<void> {
    assertNonEmpty("scope.userId", scope.userId);
    await this.purgeByUser(scope.userId);
  }

  /** ログイン時の掃除。ログアウト消去が走らずに残った「今の利用者以外」の行だけを消す（本人の下書きは残す） */
  async purgeOthers(keepUserId: string): Promise<void> {
    assertNonEmpty("keepUserId", keepUserId);
    try {
      const db = await this.db();
      const tx = db.transaction([DRAFT_STORES.drafts, DRAFT_STORES.blobs], "readwrite");
      for (const storeName of [DRAFT_STORES.drafts, DRAFT_STORES.blobs]) {
        const store = tx.objectStore(storeName);
        // 索引の鍵はscope.userId。本人以外の行だけを主キーで消す
        const rows = await collectCursorKeys(store.index("by_user").openKeyCursor());
        for (const row of rows) if (row.key !== keepUserId) store.delete(row.primaryKey);
      }
      await transactionDone(tx);
    } catch (e) {
      throw asStoreError(e);
    }
  }

  /** 期限切れの下書きと写真を実削除する（送信候補に現れない。期限後は人が新操作を作る。docs/16 T076） */
  async expire(now: string): Promise<void> {
    if (Number.isNaN(Date.parse(now))) throw new DraftStoreError("invalid", "日時が不正です");
    try {
      const db = await this.db();
      const tx = db.transaction([DRAFT_STORES.drafts, DRAFT_STORES.blobs], "readwrite");
      const expired = IDBKeyRange.upperBound(now);
      for (const storeName of [DRAFT_STORES.drafts, DRAFT_STORES.blobs]) {
        const store = tx.objectStore(storeName);
        const rows = await collectCursorKeys(store.index("by_expires").openKeyCursor(expired));
        for (const row of rows) store.delete(row.primaryKey);
      }
      await transactionDone(tx);
    } catch (e) {
      throw asStoreError(e);
    }
  }

  /** userIdで両storeの行を消す共通部品（purgeの本体） */
  private async purgeByUser(userId: string): Promise<void> {
    try {
      const db = await this.db();
      const tx = db.transaction([DRAFT_STORES.drafts, DRAFT_STORES.blobs], "readwrite");
      for (const storeName of [DRAFT_STORES.drafts, DRAFT_STORES.blobs]) {
        const store = tx.objectStore(storeName);
        const rows = await collectCursorKeys(store.index("by_user").openKeyCursor(IDBKeyRange.only(userId)));
        for (const row of rows) store.delete(row.primaryKey);
      }
      await transactionDone(tx);
    } catch (e) {
      throw asStoreError(e);
    }
  }
}

/** アプリ本体から使う単一の接続（lifecycle・T077の同期runnerと共有する） */
let shared: IndexedDbDraftStore | null = null;
export function getDraftStore(): IndexedDbDraftStore {
  shared ??= new IndexedDbDraftStore();
  return shared;
}
