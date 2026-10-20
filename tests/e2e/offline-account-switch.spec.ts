import { expect, test, type Page } from "@playwright/test";
import { acceptInvitationViaUi, inviteNewMember, isPhone, logoutViaUi, newUserContext, uniqueEmail } from "./helpers";

/**
 * 端末下書きのユーザー分離・ログアウト消去（T075、docs/07 端末保持・docs/14 D14・CT-10）。
 *
 * 共有端末を1つのブラウザcontextで再現し、利用者A→（ログアウト）→利用者Bと切り替える:
 *  - Aの下書きはAのログアウトでIndexedDBから消える（purge。appsはMenuPageのlogoutから lifecycle.purgeForLogout）
 *  - 消去が走らずに残った他人の下書きは、次の利用者のログイン時にも消える（MeGate → purgeForeignDrafts）
 *  - 本人の下書きだけが再起動（再読込）で復元する
 *
 * 下書きを作る画面（通信断入力）はT077の領域のため、このspecは**アプリが書くのと同じschema**で
 * IndexedDBへ直接行を置く（src/client/offline/store.ts の DRAFT_DB_NAME/DRAFT_STORES/index を固定。
 * schemaがずれるとpurgeが行を見つけられず、このspecは赤になる＝退化に気づける）。
 * 期限は必ず未来にしてある。起動時のexpireDueDrafts（TTL掃除）ではなく「purge」だけが消せる状態にするため。
 */

interface SeedRow {
  userId: string;
  clientOperationId: string;
  withBlob?: boolean;
}

/** アプリと同じschemaでDBを作り（既にあればそのまま）、Aの下書き（と必要なら写真）を置く */
async function seedDraft(page: Page, row: SeedRow): Promise<void> {
  await page.evaluate((row) => {
    // page.evaluateの中はモジュールの定数を参照できないため、store.ts（src/client/offline/store.ts）の
    // schemaをリテラルで固定する: DB fireos-drafts v1 / stores drafts・attachment_blobs / 索引 by_user・by_scope・by_expires
    const DB = "fireos-drafts";
    const DRAFTS = "drafts";
    const BLOBS = "attachment_blobs";
    const now = new Date().toISOString();
    const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(); // 未来＝TTLでは消えない
    const scope = { userId: row.userId, unitId: "架空市 第一分団", deviceId: "e2e-shared-device" };
    return new Promise<void>((resolve, reject) => {
      const open = indexedDB.open(DB, 1);
      open.onupgradeneeded = () => {
        const db = open.result;
        if (!db.objectStoreNames.contains(DRAFTS)) {
          const drafts = db.createObjectStore(DRAFTS, { keyPath: "clientOperationId" });
          drafts.createIndex("by_user", "scope.userId");
          drafts.createIndex("by_scope", ["scope.userId", "scope.unitId", "scope.deviceId"]);
          drafts.createIndex("by_expires", "expiresAt");
        }
        if (!db.objectStoreNames.contains(BLOBS)) {
          const blobs = db.createObjectStore(BLOBS, { keyPath: "blobKey" });
          blobs.createIndex("by_user", "scope.userId");
          blobs.createIndex("by_expires", "expiresAt");
        }
      };
      open.onerror = () => reject(open.error);
      open.onsuccess = () => {
        const db = open.result;
        try {
          const tx = db.transaction([DRAFTS, BLOBS], "readwrite");
          if (row.withBlob) {
            tx.objectStore(BLOBS).put({
              blobKey: `${row.clientOperationId}-blob`,
              data: new TextEncoder().encode("e2eの写真（架空）").buffer,
              contentType: "image/jpeg",
              byteSize: 18,
              scope,
              expiresAt,
            });
          }
          tx.objectStore(DRAFTS).put({
            scope,
            clientOperationId: row.clientOperationId,
            operationCode: "inspection.save", // 語彙はT076のallowlistで確定。ここでは保持の対象としてだけ使う
            targetId: "",
            baseVersion: 0,
            payload: { note: "e2e: 通信断で作った下書き（架空）" },
            payloadHash: "a".repeat(64),
            status: "local_draft",
            attachments: row.withBlob ? [{ blobKey: `${row.clientOperationId}-blob`, name: "点検写真.jpg", contentType: "image/jpeg", byteSize: 18 }] : [],
            createdAt: now,
            expiresAt,
          });
          tx.oncomplete = () => { db.close(); resolve(); };
          tx.onerror = () => { db.close(); reject(tx.error); };
          tx.onabort = () => { db.close(); reject(tx.error ?? new Error("aborted")); };
        } catch (e) {
          db.close();
          reject(e);
        }
      };
    });
  }, row);
}

/** ある利用者の下書き・写真が端末に何行残っているか（purgeや掃除の結果を待つpollに使う） */
function remainingRows(page: Page, userId: string): Promise<{ drafts: number; blobs: number }> {
  return page.evaluate(async (userId) => {
    // seedDraftと同じschema固定（リテラル）
    const DB = "fireos-drafts";
    const DRAFTS = "drafts";
    const BLOBS = "attachment_blobs";
    const exists = await new Promise<boolean>((resolve) => {
      const req = indexedDB.open(DB);
      req.onsuccess = () => {
        const db = req.result;
        const ok = db.objectStoreNames.contains(DRAFTS) && db.objectStoreNames.contains(BLOBS);
        db.close();
        resolve(ok);
      };
      req.onerror = () => resolve(false);
      req.onblocked = () => resolve(false);
    });
    if (!exists) return { drafts: 0, blobs: 0 };
    return new Promise<{ drafts: number; blobs: number }>((resolve, reject) => {
      const open = indexedDB.open(DB);
      open.onerror = () => reject(open.error);
      open.onsuccess = () => {
        const db = open.result;
        const tx = db.transaction([DRAFTS, BLOBS], "readonly");
        const drafts = tx.objectStore(DRAFTS).index("by_user").getAll(IDBKeyRange.only(userId));
        const blobs = tx.objectStore(BLOBS).index("by_user").getAll(IDBKeyRange.only(userId));
        tx.oncomplete = () => {
          db.close();
          resolve({ drafts: drafts.result.length, blobs: blobs.result.length });
        };
        tx.onerror = () => { db.close(); reject(tx.error); };
      };
    });
  }, userId);
}

// 幅: desktop限定（幅で変わる断言なし（流れ・データの断言））
test("account_switch_never_leaves_or_shows_another_users_offline_draft", async ({ browser, request }, testInfo) => {
  test.setTimeout(300_000); // 招待受領×2＋ログイン×2のUI操作を含む（notifications.specと同じ扱い）
  const viewport = testInfo.project.use.viewport!;
  // shellが描けた（=API-01が終わった）ことの確認。スマホはh2、PCはh1（pwa-cache.specと同じ区別）
  const appHeading = isPhone(viewport) ? { level: 2 as const, name: "ホーム" } : { level: 1 as const, name: "ダッシュボード" };
  const tag = crypto.randomUUID().slice(0, 6);

  // --- seed: 利用者A・B（管理者APIで団員を作り、それぞれ招待を受領） ---
  const emailA = uniqueEmail(`e2e-draft-a-${tag}`);
  const emailB = uniqueEmail(`e2e-draft-b-${tag}`);
  const memberA = await inviteNewMember(request, `架空 下書 A ${tag}`, emailA);
  const memberB = await inviteNewMember(request, `架空 下書 B ${tag}`, emailB);

  // 共有端末（1つのブラウザcontextをA→Bで使い回す）
  const context = await newUserContext(browser, viewport);
  const page = await context.newPage();

  // --- Aで通信断のつもりで下書きを作る（作成UIはT077。ここでは端末保存の層を同じschemaで置く） ---
  await acceptInvitationViaUi(page, emailA, memberA.token, { mfa: false });
  await expect(page.getByRole("heading", appHeading)).toBeVisible();
  // setOfflineは使わない（Service Worker制御下のCDPエミュレーションは後続の完全遷移を偽失敗させることがある。
  // 通信断の入力と再接続はT077のoffline-sync.specで扱う。下書きの作成は端末内だけで完結し、ネットに依存しない）
  await seedDraft(page, { userId: memberA.memberId, clientOperationId: `e2e-a-photo-${tag}`, withBlob: true });
  await seedDraft(page, { userId: memberA.memberId, clientOperationId: `e2e-a-plain-${tag}` });
  expect(await remainingRows(page, memberA.memberId)).toEqual({ drafts: 2, blobs: 1 });

  // --- Aのログアウト: purgeでAの下書きと写真が端末から消える ---
  await logoutViaUi(page);
  await expect.poll(() => remainingRows(page, memberA.memberId), { timeout: 15_000 }).toEqual({ drafts: 0, blobs: 0 });

  // --- クラッシュ等でログアウト消去が走らなかった場合の再現: Aの行が残ったままBがログインする ---
  await seedDraft(page, { userId: memberA.memberId, clientOperationId: `e2e-a-crash-${tag}`, withBlob: true });
  expect(await remainingRows(page, memberA.memberId)).toEqual({ drafts: 1, blobs: 1 });

  // Bはこの共有端末での初回ログイン＝招待受領（受領フローがそのままBのログインになる）
  await acceptInvitationViaUi(page, emailB, memberB.token, { mfa: false });
  await expect(page.getByRole("heading", appHeading)).toBeVisible();
  // Bのログイン時の掃除で他人分だけが消える。Bの行はまだ無い
  await expect.poll(() => remainingRows(page, memberA.memberId), { timeout: 15_000 }).toEqual({ drafts: 0, blobs: 0 });

  // --- Bの下書きは本人の間は残り（再起動=再読込で復元）、Bのログアウトで消える ---
  await seedDraft(page, { userId: memberB.memberId, clientOperationId: `e2e-b-own-${tag}`, withBlob: true });
  await page.reload();
  await expect(page.getByRole("heading", appHeading)).toBeVisible();
  expect(await remainingRows(page, memberB.memberId)).toEqual({ drafts: 1, blobs: 1 });
  expect(await remainingRows(page, memberA.memberId)).toEqual({ drafts: 0, blobs: 0 });

  await logoutViaUi(page);
  await expect.poll(() => remainingRows(page, memberB.memberId), { timeout: 15_000 }).toEqual({ drafts: 0, blobs: 0 });

  await context.close();
});
