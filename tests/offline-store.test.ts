import "fake-indexeddb/auto";
import { IDBObjectStore } from "fake-indexeddb";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MeData } from "../src/client/me";
import { captureOfflineDraft, planFor } from "../src/client/offline/capture";
import { draftExpiryFrom, draftExpiryLabel, DRAFT_TTL_DAYS, purgeForeignDrafts } from "../src/client/offline/lifecycle";
import {
  DRAFT_DB_NAME,
  DRAFT_STORES,
  IndexedDbDraftStore,
} from "../src/client/offline/store";
import { DraftStoreError, type DraftScope, type LocalDraft } from "../src/client/offline/types";
import { randomUuid } from "../src/client/uuid";

/**
 * 端末下書き（T075、docs/07 端末保持・docs/14 D14）。
 *
 * IndexedDBの実意味論（transaction・index・structured clone）をjsdom上で通すため、
 * 試験では fake-indexeddb（実装無しでは動かない開発用の実装。devDependency）を使う。
 * ブラウザ終了は「接続を閉じて作り直す」ことで再現する（IndexedDBの中身は残る）。
 */

const DAY = 24 * 60 * 60 * 1000;
/** 試験用の固定「現在時刻」（実時刻に寄らないため） */
const NOW = Date.parse("2026-10-10T09:00:00.000Z");
const iso = (ms: number) => new Date(ms).toISOString();

const USER_A = "11111111-1111-4111-8111-111111111111";
const USER_B = "22222222-2222-4222-8222-222222222222";
const scopeA: DraftScope = { userId: USER_A, unitId: "架空市 第一分団", deviceId: "device-1" };
const scopeB: DraftScope = { userId: USER_B, unitId: "架空市 第一分団", deviceId: "device-1" };

let store: IndexedDbDraftStore;
/** 試験内で開いた接続。ブラウザ終了の再現として毎回すべて閉じる（開いたままだとdeleteDatabaseが詰まる） */
const stores: IndexedDbDraftStore[] = [];
const newStore = (): IndexedDbDraftStore => {
  const instance = new IndexedDbDraftStore();
  store = instance;
  stores.push(instance);
  return instance;
};

afterEach(async () => {
  for (const s of stores) await s.close().catch(() => undefined);
  stores.length = 0;
  // 試験ごとに端末を初期化する（fake-indexeddbは同じプロセスでDBを共有するため）
  await new Promise<void>((resolve, reject) => {
    const req = indexedDB.deleteDatabase(DRAFT_DB_NAME);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
    req.onblocked = () => resolve();
  });
});

/** 写真の代わり（中身は問わない。IndexedDBにはArrayBufferで入る） */
const bytes = (text: string): ArrayBuffer => new TextEncoder().encode(text).buffer as ArrayBuffer;

function draftOf(scope: DraftScope, clientOperationId: string, overrides: Partial<LocalDraft> = {}): LocalDraft {
  return {
    scope,
    clientOperationId,
    // 操作コードの語彙はT076のallowlistで確定する。ここでは下書きの保持そのものを試すので仮の値でよい
    operationCode: "inspection.save",
    targetId: "",
    baseVersion: 0,
    payload: { answers: [{ item: "標識", state: "ok" }], note: "通信断で作成した下書き" },
    payloadHash: "a".repeat(64),
    status: "local_draft",
    attachments: [],
    createdAt: iso(NOW),
    expiresAt: draftExpiryFrom(iso(NOW)),
    ...overrides,
  };
}

function openRawCount(): Promise<{ drafts: number; blobs: number }> {
  // 実装が消したといっている行が実際にDBから消えていることを、生のIndexedDB読みで裏どる
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DRAFT_DB_NAME);
    req.onsuccess = async () => {
      const db = req.result;
      try {
        const tx = db.transaction([DRAFT_STORES.drafts, DRAFT_STORES.blobs], "readonly");
        const drafts = await new Promise<number>((res, rej) => {
          const r = tx.objectStore(DRAFT_STORES.drafts).count();
          r.onsuccess = () => res(r.result);
          r.onerror = () => rej(r.error);
        });
        const blobs = await new Promise<number>((res, rej) => {
          const r = tx.objectStore(DRAFT_STORES.blobs).count();
          r.onsuccess = () => res(r.result);
          r.onerror = () => rej(r.error);
        });
        db.close();
        resolve({ drafts, blobs });
      } catch (e) {
        db.close();
        reject(e);
      }
    };
    req.onerror = () => reject(req.error);
  });
}

describe("端末下書き store (T075)", () => {
  it("account_switch_and_expiry_never_restore_another_users_draft", async () => {
    store = newStore();

    // --- Aで写真付き点検・出欠・参集のdraftを作る（docs/07: 同期対象案の3種） ---
    const photoExpiresAt = draftExpiryFrom(iso(NOW));
    await store.putAttachment({
      key: "blob-inspection",
      data: bytes("Aが通信断で添えた点検写真"),
      contentType: "image/jpeg",
      scope: scopeA,
      expiresAt: photoExpiresAt,
    });
    await store.put(
      draftOf(scopeA, "op-inspection", {
        attachments: [{ blobKey: "blob-inspection", name: "点検写真.jpg", contentType: "image/jpeg", byteSize: 27 }],
      }),
    );
    await store.put(draftOf(scopeA, "op-attendance", { operationCode: "attendance.reply", payload: { response: "attending" } }));
    await store.put(draftOf(scopeA, "op-muster", { operationCode: "muster.respond", payload: { status: "参集中" } }));

    // --- ブラウザ終了→再起動: 接続を作り直しても、本人のdraftだけが復元される ---
    await store.close();
    const reopened = newStore();
    const restored = await reopened.list(scopeA);
    expect(restored.map((d) => d.clientOperationId).sort()).toEqual(["op-attendance", "op-inspection", "op-muster"]);
    // 写真も参照ごと復元する（実体はblob store。写真付きのまま同期に回せる）
    expect(restored.find((d) => d.clientOperationId === "op-inspection")!.attachments).toHaveLength(1);
    expect(await reopened.hasAttachment("blob-inspection")).toBe(true);

    // --- 7日経過: 期限切れのdraftは送信候補に現れない（自動送信されない。docs/16: 期限後は人が新操作を作る） ---
    await reopened.put(draftOf(scopeA, "op-expired", { createdAt: iso(NOW - 8 * DAY), expiresAt: iso(NOW - DAY) }));
    await reopened.putAttachment({
      key: "blob-old",
      data: bytes("期限の過ぎた写真"),
      contentType: "image/jpeg",
      scope: scopeA,
      expiresAt: iso(NOW - DAY),
    });
    await reopened.expire(iso(NOW));
    const afterExpire = await reopened.list(scopeA);
    const expiredAutoSendCount = afterExpire.filter((d) => d.status === "local_draft" && d.expiresAt <= iso(NOW)).length;
    expect(expiredAutoSendCount).toBe(0);
    // 期限切れの1本（とその写真）は消えている
    expect(afterExpire.map((d) => d.clientOperationId).sort()).toEqual(["op-attendance", "op-inspection", "op-muster"]);
    expect(await reopened.hasAttachment("blob-old")).toBe(false);

    // --- Bが同じ端末でログインしても、Aのdraftは読めない（読みはscopeで分離） ---
    const userBDrafts = await reopened.list(scopeB);
    expect(userBDrafts).toEqual([]);

    // --- Aのログアウト: purgeでAのdraftと写真を端末から消す（docs/07: ログアウト/ユーザー切替で破棄） ---
    await reopened.purge(scopeA);
    const logoutRemainingUserDrafts = await reopened.list(scopeA);
    expect(logoutRemainingUserDrafts).toEqual([]);
    expect(await reopened.hasAttachment("blob-inspection")).toBe(false);
    const raw = await openRawCount();
    expect(raw.drafts).toBe(0);
    expect(raw.blobs).toBe(0);

    // --- quota超過: 端末の保存容量が足りないときは「保存できなかった」と報告する（成功と表示しない） ---
    let quotaFailureReported = false;
    const originalPut = IDBObjectStore.prototype.put;
    IDBObjectStore.prototype.put = function () {
      // 実機で容量超過時に起きるのと同じ名前の失敗を、書き込み経路に注入する
      throw new DOMException("quota exceeded", "QuotaExceededError");
    };
    try {
      try {
        await reopened.put(draftOf(scopeA, "op-quota", { payload: { note: "容量超過で保存できないはず" } }));
      } catch (e) {
        quotaFailureReported = e instanceof DraftStoreError && e.kind === "quota";
      }
    } finally {
      IDBObjectStore.prototype.put = originalPut;
    }
    expect(quotaFailureReported).toBe(true);
  });

  it("login_sweeps_drafts_left_by_another_user_even_after_a_crash_skipped_logout", async () => {
    store = newStore();
    // クラッシュ等でログアウト消去が走らずAの下書きが残ってしまった端末を再現する
    await store.put(draftOf(scopeA, "op-crash-left"));
    await store.put(draftOf(scopeB, "op-b-own"));
    // Bのログイン直前に呼ぶ掃除（MeGateの取得成功時）。他人分だけを消し、本人分は残す
    await purgeForeignDrafts(USER_B, store);
    expect(await store.list(scopeA)).toEqual([]);
    expect((await store.list(scopeB)).map((d) => d.clientOperationId)).toEqual(["op-b-own"]);
  });

  it("photos_over_the_device_limits_are_reported_as_failures_and_saved_as_nothing", async () => {
    store = newStore();
    // 1枚の上限は既存の添付経路と同じ「写真10MiB」（docs/07 §3の上限案）
    const tooBig = new Uint8Array(10 * 1024 * 1024 + 1);
    await expect(
      store.putAttachment({ key: "blob-big", data: tooBig.buffer as ArrayBuffer, contentType: "image/jpeg", scope: scopeA, expiresAt: draftExpiryFrom(iso(NOW)) }),
    ).rejects.toMatchObject({ kind: "limit" });
    expect(await store.hasAttachment("blob-big")).toBe(false);

    // 1下書きの添付数上限は点検保存のattachmentIds上限（LIMITS.arrayMax=100）と同じ
    for (let i = 0; i < 100; i++) {
      await store.putAttachment({
        key: `blob-${i}`,
        data: bytes(`写真${i}`),
        contentType: "image/jpeg",
        scope: scopeA,
        expiresAt: draftExpiryFrom(iso(NOW)),
      });
    }
    const full = draftOf(scopeA, "op-full", {
      attachments: Array.from({ length: 100 }, (_, i) => ({ blobKey: `blob-${i}`, name: `p${i}.jpg`, contentType: "image/jpeg", byteSize: 6 })),
    });
    await store.put(full); // 100までは保存できる
    await expect(store.put({ ...full, clientOperationId: "op-over", attachments: [...full.attachments, { blobKey: "blob-0", name: "p100.jpg", contentType: "image/jpeg", byteSize: 6 }] })).rejects.toMatchObject({
      kind: "limit",
    });
  });

  it("a_draft_referencing_a_missing_photo_is_not_saved", async () => {
    store = newStore();
    // 写真が端末に無いのに参照だけの下書きを作らない（同期に回せない壊れた下書きを残さない）
    await expect(
      store.put(draftOf(scopeA, "op-ghost", { attachments: [{ blobKey: "missing", name: "x.jpg", contentType: "image/jpeg", byteSize: 1 }] })),
    ).rejects.toMatchObject({ kind: "invalid" });
    expect(await store.list(scopeA)).toEqual([]);
  });

  it("a_draft_cannot_carry_raw_session_credentials_in_its_payload", async () => {
    store = newStore();
    // 生session token等を下書きに保存しない（docs/16 T075）。うっかり入りを浅い検査で弾く（本命は契約: payloadは業務入力だけ）
    await expect(store.put(draftOf(scopeA, "op-token", { payload: { accessToken: "raw-session-token" } }))).rejects.toMatchObject({ kind: "secret" });
    await expect(store.put(draftOf(scopeA, "op-session", { payload: { nested: { sessionId: "s" } } }))).rejects.toMatchObject({ kind: "secret" });
    expect(await store.list(scopeA)).toEqual([]);
  });

  it("expiry_label_shows_remaining_days_and_marks_expired_drafts", () => {
    expect(DRAFT_TTL_DAYS).toBe(7); // docs/14 D14推奨案の検証設定（7日）
    expect(draftExpiryLabel(iso(NOW + 3 * DAY), iso(NOW))).toBe("残り3日");
    expect(draftExpiryLabel(iso(NOW + 12), iso(NOW))).toBe("今日まで");
    expect(draftExpiryLabel(iso(NOW - DAY), iso(NOW))).toBe("期限切れ（送信されません）");
  });
});

describe("通信断下書きの写像 (T077・capture.planFor)", () => {
  /**
   * 参集（API-23）の下書きは**本人の記録だけ**に限る。
   *
   * 画面は代理で他団員の参集を記録できる（IncidentPage、D08 scope。API-23のparams.memberIdに誰の記録かが乗る）。
   * 一方、同期のallowlist（T076・src/server/sync/allowlist.ts）はAPI-23を**同期主体自身の**記録として
   * 再生する（memberIdはpayloadに載らず主体で決まる＝「代理（D08 scope）は同期しない」）。通信断で代理の
   * 参集をそのまま下書きにすると、再送時に**別人の参集記録**として黙って届いてしまうため、
   * 写像できない操作は下書きにしない（capture.tsの方針どおり。フォームの「結果を確認できません」表示が正として残る）。
   */
  // このjsdom環境にはlocalStorageが無く、そのままではdeviceIdOf()が呼び出しごとに新IDを発行する
  // （store.tsのfallback「下書きの分離はuserIdで効くので安全側」）。実端末と同じ「端末に恒久の
  // deviceIdがある」状態をメモリで再現して、captureが組み立てるscopeでlistできるようにする
  const memoryLocalStorage = new Map<string, string>();
  beforeEach(() => {
    memoryLocalStorage.clear();
    vi.stubGlobal("localStorage", {
      getItem: (key: string) => memoryLocalStorage.get(key) ?? null,
      setItem: (key: string, value: string) => void memoryLocalStorage.set(key, value),
    });
  });
  afterEach(() => vi.unstubAllGlobals());

  /** API-23の入力（契約そのもの。operations.ts API-23: params={id,memberId}、body={version,...}） */
  const musterInput = (memberId: string) => ({
    params: { id: "33333333-3333-4333-8333-333333333333", memberId },
    body: { version: 3, attendanceStatus: "mobilizing" },
  });
  const meOf = (memberId: string): Pick<MeData, "profile" | "unitName" | "unitId"> => ({
    profile: { memberId, displayName: "架空 記録", rank: null },
    unitName: "架空市 第一分団",
    unitId: "u1111111-1111-4111-8111-111111111111",
  });
  /** captureOfflineDraftが組み立てるscopeと同じ形（deviceIdはstoreの deviceIdOf()）。
   *  unitIdは**分団識別子（units.id）**で、表示名（unitName）ではない（T083・ph6-review A低3の決着。
   *  表示名は分団の改名で変わるため、下書きのscope識別子に使うと保存済みの下書きが一覧から消える） */
  const liveScopeOf = (userId: string): DraftScope => ({
    userId,
    unitId: "u1111111-1111-4111-8111-111111111111",
    deviceId: IndexedDbDraftStore.deviceIdOf(),
  });

  it("proxy_mobilization_is_never_captured_as_a_draft_but_self_mobilization_is", async () => {
    store = newStore();
    const me = meOf(USER_A);
    const liveScope = liveScopeOf(USER_A); // 先に確定させる（captureとlistで同じdeviceIdを指す）

    // --- 代理（他団員の参集を記録する操作）: planは作らず、下書きも置かない ---
    expect(planFor("API-23", musterInput(USER_B), me)).toBeNull();
    await expect(captureOfflineDraft(me, "API-23", musterInput(USER_B), "op-proxy", store)).resolves.toBe(false);
    expect(await store.list(liveScope)).toEqual([]);

    // --- 本人の参集: 従来どおり下書きになる（版はpayloadから抜いてbaseVersionへ＝assertNoVersionInPayloadと一致） ---
    const plan = planFor("API-23", musterInput(USER_A), me);
    expect(plan).toMatchObject({
      operationCode: "incident.participant.record",
      targetId: "33333333-3333-4333-8333-333333333333",
      baseVersion: 3,
      payload: { attendanceStatus: "mobilizing" },
    });
    expect(plan?.payload).not.toHaveProperty("version");
    await expect(captureOfflineDraft(me, "API-23", musterInput(USER_A), "op-self", store)).resolves.toBe(true);
    expect((await store.list(liveScope)).map((d) => d.clientOperationId)).toEqual(["op-self"]);
  });
});

describe("deviceIdOfのsecure context外フォールバック（T083実機確認）", () => {
  /** UUIDv4（バージョン4・バリアント10xxのビットまで見る） */
  const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
  const KEY = "fireos.device-id";
  let originalRandomUUID: (() => string) | undefined;

  // このjsdom環境にはlocalStorageが無い（capture.describeと同じ）。動く扱いのstub（Map保存）を用意する
  beforeEach(() => {
    originalRandomUUID = crypto.randomUUID;
    const memory = new Map<string, string>();
    vi.stubGlobal("localStorage", {
      getItem: (key: string) => memory.get(key) ?? null,
      setItem: (key: string, value: string) => void memory.set(key, value),
      removeItem: (key: string) => void memory.delete(key),
    });
  });
  afterEach(() => {
    // randomUUIDはcryptoのプロトタイプ実装のため、インスタンスのown propertyで退避・復元する
    Object.defineProperty(crypto, "randomUUID", { value: originalRandomUUID, configurable: true, writable: true });
    vi.unstubAllGlobals();
  });

  it("returns_a_uuid_without_crypto_randomuuid_insecure_contexts", () => {
    // 平文HTTP等のsecure context外の再現: randomUUIDが提供されない
    Object.defineProperty(crypto, "randomUUID", { value: undefined, configurable: true, writable: true });
    // 通常パス（localStorageが使える環境）: UUID形式で、保存されるため2回呼んでも同じ端末ID
    const first = IndexedDbDraftStore.deviceIdOf();
    expect(first).toMatch(UUID_V4);
    expect(IndexedDbDraftStore.deviceIdOf()).toBe(first);
  });

  it("randomUuid_helper_falls_back_without_crypto_randomuuid", () => {
    // 共有ヘルパー（src/client/uuid.ts）単体でも同じ保証（冪等キー等、store以外の呼び出し元の分）
    Object.defineProperty(crypto, "randomUUID", { value: undefined, configurable: true, writable: true });
    const id = randomUuid();
    expect(id).toMatch(UUID_V4);
    expect(randomUuid()).not.toBe(id);
  });

  it("still_returns_a_new_uuid_each_call_when_localstorage_is_unavailable", () => {
    Object.defineProperty(crypto, "randomUUID", { value: undefined, configurable: true, writable: true });
    // localStorage無効の環境でもUUID形式（呼び出しごとに新しいID。下書きの分離はuserIdで効くので安全側）
    vi.stubGlobal("localStorage", {
      getItem: () => { throw new Error("unavailable"); },
      setItem: () => { throw new Error("unavailable"); },
      removeItem: () => { throw new Error("unavailable"); },
    });
    const a = IndexedDbDraftStore.deviceIdOf();
    const b = IndexedDbDraftStore.deviceIdOf();
    expect(a).toMatch(UUID_V4);
    expect(b).toMatch(UUID_V4);
    expect(b).not.toBe(a);
  });
});
