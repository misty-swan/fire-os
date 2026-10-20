import { expect, test, type Page } from "@playwright/test";
import {
  acceptInvitationViaUi,
  adminApiData,
  inviteNewMember,
  isPhone,
  loginViaUi,
  logoutViaUi,
  newUserContext,
  uniqueEmail,
} from "./helpers";

/**
 * 通信断入力・写真先行同期・競合解消（T077、SCR-27。docs/03同期・docs/07端末保持・docs/14 D14・CT-10/12）。
 *
 * 手順（docs/16 T077）: 通信断で点検/写真/本人出欠/参集の入力 → 別端末で同じ記録を更新 → 再接続。
 * 注入する故障と、それが何を再現するか（docs/03 §1.1-22の誠実さの注記と同じ内容）:
 *  - 通信断: ブラウザはオンラインのまま、元操作3つ（点検保存・本人出欠・参集）と同期APIのリクエストだけを
 *    遮断する（inspection.specの保存失敗試験と同じ方式。context.setOfflineはSW制御下の完全読込を壊すことが
 *    あるため使わない＝offline-account-switch.specの注記と同じ経験則）。
 *  - uploadready待ち: 端末内写真（seedしたblob）は同期時に予約→転送→検査（API-26/83/84→job API-86）を経て
 *    readyになってから親操作を送る。親（/sync/commands）が写真のcompletionより先に出ないことを
 *    リクエスト記録で断言する（parentSentBeforeReady=false）。
 *  - 応答不明: 参集の同期コマンドを1回だけ「サーバーへ転送（適用される）→応答を捨てる」（route.fetch→abort）。
 *    クライアントは同じclientOperationIdでの照会・再送で回復し、業務効果は必ず1回（二重適用0をAPIで断言）。
 *  - 失権: 別端末から本人の全セッション失効（API-38。管理者操作＝端末紛失時の失効）を注入する。
 *    再接続の最初の同期は401で止まり（順序制御の再認証が先）、下書きは壊れず・偽の完了表示を出さない。
 *    再ログイン後の起動時同期で回復する。
 *  - ログアウト: 未同期の下書きは端末に残さない（T075のpurge。持ち越さない）。
 *
 * 下書きの端末内スキーマは src/client/offline/store.ts の固定（offline-account-switch.specと同じ読み書き）。
 */

test.setTimeout(300_000); // 招待受領＋複数画面の操作＋同期の待ち（offline-account-switch.specと同じ扱い）

/** 端末ID（アプリのdeviceIdOfが発行するUUIDの代わりに固定値。seedした下書きを同じ端末としてlistさせる） */
const DEVICE_ID = "e2e-sync-device";

/** 最小のPNG（1px。CRCを計算した実在形式。attachments.specと同じ作り方） */
function pngBytes(): Buffer {
  let table: number[] = [];
  const crc32 = (bytes: Uint8Array) => {
    if (!table.length) {
      for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; table[n] = c >>> 0; }
    }
    let c = 0xffffffff;
    for (const b of bytes) c = table[(c ^ b) & 0xff]! ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type: string, data: Buffer) => {
    const out = Buffer.alloc(12 + data.length);
    out.writeUInt32BE(data.length, 0);
    out.write(type, 4, "ascii");
    data.copy(out, 8);
    out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
    return out;
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(1, 0);
  ihdr.writeUInt32BE(1, 4);
  ihdr.set([8, 6, 0, 0, 0], 8);
  const parts = [Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", ihdr), chunk("IDAT", Buffer.from([0x78, 0x9c, 0x63, 0x60, 0x60, 0x60, 0x00, 0x00, 0x00, 0x04, 0x00, 0x01])), chunk("IEND", Buffer.alloc(0))];
  return Buffer.concat(parts);
}

/** payloadの正規化hash（src/server/mutations/hash.tsのcanonicalJsonと同じ形。payloadHashは端末側の整合用） */
function canonicalJson(value: unknown): string {
  if (value === null) return "null";
  switch (typeof value) {
    case "string": return JSON.stringify(value);
    case "boolean": return value ? "true" : "false";
    case "number": return JSON.stringify(value);
    case "object": {
      if (Array.isArray(value)) return `[${value.map((v) => canonicalJson(v)).join(",")}]`;
      const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
      return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(",")}}`;
    }
    default: throw new Error(`canonicalJson: 未対応の型 ${typeof value}`);
  }
}
const sha256Hex = async (text: string): Promise<string> =>
  [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)))].map((b) => b.toString(16).padStart(2, "0")).join("");

interface DraftRow {
  clientOperationId: string;
  operationCode: string;
  status: string;
}

/** アプリが書くのと同じschema（store.ts v1固定）で、その利用者の下書き行を読む（seed・状態断言の両方で使う） */
async function draftRows(page: Page, userId: string): Promise<DraftRow[]> {
  return page.evaluate(async (userId) => {
    const DB = "fireos-drafts";
    const DRAFTS = "drafts";
    const exists = await new Promise<boolean>((resolve) => {
      const req = indexedDB.open(DB);
      req.onsuccess = () => { const db = req.result; const ok = db.objectStoreNames.contains(DRAFTS); db.close(); resolve(ok); };
      req.onerror = () => resolve(false);
      req.onblocked = () => resolve(false);
    });
    if (!exists) return [];
    return new Promise<DraftRow[]>((resolve, reject) => {
      const open = indexedDB.open(DB);
      open.onerror = () => reject(open.error);
      open.onsuccess = () => {
        const db = open.result;
        const tx = db.transaction([DRAFTS], "readonly");
        const rows = tx.objectStore(DRAFTS).index("by_user").getAll(IDBKeyRange.only(userId));
        tx.oncomplete = () => {
          db.close();
          resolve((rows.result as DraftRow[]).map((r) => ({ clientOperationId: r.clientOperationId, operationCode: r.operationCode, status: r.status })));
        };
        tx.onerror = () => { db.close(); reject(tx.error); };
      };
    });
  }, userId);
}

/** 端末内写真つきの点検下書きを置く（通信断で撮った写真の再現。アプリのputAttachment/putと同じ形） */
async function seedInspectionDraft(
  page: Page,
  args: {
    userId: string;
    unitId: string;
    clientOperationId: string;
    facilityId: string;
    templateVersionId: string;
    inspectorMemberId: string;
    note: string;
  },
): Promise<void> {
  const png = pngBytes();
  const payload = {
    templateVersionId: args.templateVersionId,
    inspectedAt: new Date().toISOString(),
    inspectorMemberId: args.inspectorMemberId,
    result: "ok",
    checkItems: [{ code: "exterior", result: "ok" }],
    note: args.note,
    createIssue: false,
  };
  // ArrayBufferはpage.evaluateの引数で壊れるため、base64文字列として渡してブラウザ内でバイト列に戻す
  const pngB64 = png.toString("base64");
  const row = {
    scope: { userId: args.userId, unitId: args.unitId, deviceId: DEVICE_ID },
    clientOperationId: args.clientOperationId,
    operationCode: "facility_inspection.create",
    targetId: args.facilityId,
    baseVersion: 0,
    payload,
    payloadHash: await sha256Hex(canonicalJson(payload)),
    status: "local_draft",
    attachments: [{ blobKey: `${args.clientOperationId}-blob`, name: "点検写真.png", contentType: "image/png", byteSize: png.byteLength }],
    createdAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
  };
  const blobRow = {
    blobKey: `${args.clientOperationId}-blob`,
    data: null as ArrayBuffer | null, // evaluateの中でbase64から詰め替える
    contentType: "image/png",
    byteSize: png.byteLength,
    scope: row.scope,
    expiresAt: row.expiresAt,
  };
  await page.evaluate(({ row, blobRow, pngB64 }) => {
    blobRow.data = Uint8Array.from(atob(pngB64), (c) => c.charCodeAt(0)).buffer;
    const DB = "fireos-drafts";
    const DRAFTS = "drafts";
    const BLOBS = "attachment_blobs";
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
          tx.objectStore(BLOBS).put(blobRow);
          tx.objectStore(DRAFTS).put(row);
          tx.oncomplete = () => { db.close(); resolve(); };
          tx.onerror = () => { db.close(); reject(tx.error); };
          tx.onabort = () => { db.close(); reject(tx.error ?? new Error("aborted")); };
        } catch (e) { db.close(); reject(e); }
      };
    });
  }, { row, blobRow, pngB64 });
}

/** 通信断で落とす対象。form=元操作3つ＋同期API（写真の転送・検査は通す: フォームの写真を検査まで進めるため）。
 *  block=それに加えて写真の検査確定（completion）も遮断する: 端末内写真の下書きが「ready前」のまま止まり、
 *  親操作（写真先行ゲート）が効いていることを検証できるようにするため。読み取りは常に通す */
function blockedWrite(mode: "form" | "block", method: string, path: string): boolean {
  const op =
    (method === "POST" && /^\/api\/v1\/facilities\/[^/]+\/inspections$/.test(path)) ||
    (method === "PUT" && /^\/api\/v1\/activities\/[^/]+\/attendance\/me$/.test(path)) ||
    (method === "PUT" && /^\/api\/v1\/incidents\/[^/]+\/participants\/[^/]+$/.test(path)) ||
    (method === "POST" && path === "/api/v1/sync/commands");
  if (mode === "form") return op;
  return op || (method === "POST" && /^\/api\/v1\/attachments\/[^/]+\/completion$/.test(path));
}

// 幅: desktop限定（幅で変わる断言なし（流れ・データの断言））
test("offline_conflict_never_uses_last_write_wins", async ({ browser, request }, testInfo) => {
  const viewport = testInfo.project.use.viewport!;
  // shellが描けた（=API-01が終わった）ことの確認。スマホはh2、PCはh1（pwa-cache.specと同じ区別）
  const appHeading = isPhone(viewport) ? { level: 2 as const, name: "ホーム" } : { level: 1 as const, name: "ダッシュボード" };
  const tag = crypto.randomUUID().slice(0, 6);

  // --- seed: 団員A（招待）／施設＋承認済み様式／公開済み予定（対象=A）／出動 ---
  const emailA = uniqueEmail(`e2e-sync-a-${tag}`);
  const memberA = await inviteNewMember(request, `架空 同期 A ${tag}`, emailA);
  const facility = await adminApiData<{ id: string }>(request, "POST", "/api/v1/facilities", {
    type: "hydrant", latitude: 35.2, longitude: 139.2, locationSource: "架空市台帳", locationNote: `同期試験 ${tag}`, managementNumber: `SY-${tag}`,
  });
  const facilityId = facility.data.data.id;
  const tpl = await adminApiData<{ id: string; versions: { id: string }[] }>(request, "POST", "/api/v1/inspection-templates", {
    name: `様式 ${tag}`, targetType: "facility",
    itemSchema: [{ code: "exterior", label: "本体の外観", valueType: "select", required: true, allowedResults: ["ok", "needs_review"] }],
  });
  const template = tpl.data.data;
  await adminApiData(request, "POST", `/api/v1/inspection-templates/${template.id}/decision`, { version: 1, templateVersionId: template.versions[0]!.id, decision: "request_review", reason: "x" });
  await adminApiData(request, "POST", `/api/v1/inspection-templates/${template.id}/decision`, { version: 2, templateVersionId: template.versions[0]!.id, decision: "approve", reason: "x" });
  const activity = await adminApiData<{ id: string }>(request, "POST", "/api/v1/activities", {
    title: `同期試験の水防訓練 ${tag}`, kind: "訓練", plannedStartsAt: "2099-10-20T01:00:00.000Z", locationText: "架空市堤防",
    ownerMemberId: memberA.memberId, audienceMemberIds: [memberA.memberId], responseDueAt: "2098-01-01T00:00:00.000Z",
  });
  const activityId = activity.data.data.id;
  await adminApiData(request, "PATCH", `/api/v1/activities/${activityId}`, { version: 1, status: "scheduled", reason: "対象を確定して公開" });
  const incident = await adminApiData<{ id: string }>(request, "POST", "/api/v1/incidents", {
    kind: "training", occurredAt: new Date().toISOString(), summary: `同期試験の出来事 ${tag}`,
  });
  const incidentId = incident.data.data.id;

  // --- 端末1（この端末）: Aが招待を受領 ---
  const context1 = await newUserContext(browser, viewport);
  const page = await context1.newPage();
  page.on("dialog", (d) => void d.accept()); // 未保存離脱のbeforeunloadは「離れる」扱い（入力は下書きとして端末に残る）
  await acceptInvitationViaUi(page, emailA, memberA.token, { mfa: false });
  await expect(page.getByRole("heading", appHeading)).toBeVisible();
  await page.evaluate((deviceId) => localStorage.setItem("fireos.device-id", deviceId), DEVICE_ID);
  const unitId = await page.evaluate(async () => {
    const res = await fetch("/api/v1/me", { credentials: "same-origin" });
    return ((await res.json()) as { data: { unitId: string } }).data.unitId;
  });

  // Aは様式一覧（API-94=PER-04）を扱うため幹部権を付与する（管理者API。全置換なので役割はofficerだけになる）
  const memberRows = await adminApiData<{ id: string; version: number; account?: { userId: string; authzVersion: number } }[]>(
    request, "GET", `/api/v1/members?q=${encodeURIComponent(`架空 同期 A ${tag}`)}`,
  );
  const rowA = memberRows.data.data.find((m) => m.id === memberA.memberId)!;
  await adminApiData(request, "PUT", `/api/v1/members/${memberA.memberId}/roles`, {
    version: rowA.version, expectedAuthzVersion: rowA.account!.authzVersion, roleCodes: ["officer"], scopes: [], reason: "e2e: 点検様式を扱える権限で試験する（架空）",
  });

  // --- 通信断の注入（この端末だけ） ---
  const log: string[] = [];
  let mode: "form" | "block" | "drop-once" | "open" = "form";
  let dropped = false;
  await context1.route("**/api/v1/**", async (route) => {
    const req = route.request();
    const path = new URL(req.url()).pathname;
    const method = req.method();
    if (method === "POST" && path === "/api/v1/sync/commands") {
      const body = req.postDataJSON() as { operationCode?: string; clientOperationId?: string };
      log.push(`POST ${path} ${body.operationCode ?? "?"} ${body.clientOperationId ?? "?"}`);
    } else {
      log.push(`${method} ${path}`);
    }
    if ((mode === "form" || mode === "block") && blockedWrite(mode, method, path)) {
      await route.abort(); // リクエストは端末から出ない（未適用・応答なし）
      return;
    }
    if (mode === "drop-once" && method === "POST" && path === "/api/v1/sync/commands" && !dropped) {
      const body = req.postDataJSON() as { operationCode?: string };
      if (body.operationCode === "incident.participant.record") {
        dropped = true;
        await route.fetch(); // サーバーへは届く（適用される）
        await route.abort(); // 応答だけを捨てる（応答不明の再現）
        return;
      }
    }
    await route.fallback();
  });

  // --- 通信断の入力1: 点検の入力（画面。保存だけが遮断される。写真は通信できる体で検査まで済ませる） ---
  const seededCiOpId = `e2e-seed-${tag}`;
  await page.goto(`/app/facilities/${facilityId}/inspections/new`);
  await expect(page.getByRole("heading", { name: "点検登録" })).toBeVisible();
  await page.getByRole("button", { name: `様式 ${tag}` }).click();
  await page.getByRole("button", { name: "良好" }).click();
  await page.getByRole("button", { name: /写真・メモへ進む/ }).click();
  await page.setInputFiles('input[type="file"]', { name: "photo.png", mimeType: "image/png", buffer: pngBytes() });
  await expect(page.getByText("準備完了")).toBeVisible({ timeout: 45_000 });
  await page.getByLabel("メモ・特記事項").fill("通信断で入力した点検（架空）");
  await page.getByRole("button", { name: /確認へ進む/ }).click();
  await page.getByRole("button", { name: "点検を保存" }).click();
  // 保存は「結果を確認できません」（保存済みとは表示しない。docs/03 §1）
  await expect(page.getByText(/結果を確認できません/)).toBeVisible({ timeout: 20_000 });
  expect(await draftRows(page, memberA.memberId)).toHaveLength(1); // 画面の保存失敗が下書きになる（capture）

  // --- 通信断の入力1b: 端末内写真つきの点検下書きをseed（撮影済みでまだ送っていない状態の再現）。
  //     フォームの写真の検査が済んだあとでseedする（前に置くとフォームの写真まで検査できなくなる）。
  //     ここから先は検査確定（completion）も遮断するため、この写真は再接続まで ready にならない＝
  //     「ready前の親操作の試み」をリクエスト記録で検証できる（parentSentBeforeReady）。
  mode = "block";
  await seedInspectionDraft(page, {
    userId: memberA.memberId, unitId, clientOperationId: seededCiOpId, facilityId,
    templateVersionId: template.versions[0]!.id, inspectorMemberId: memberA.memberId, note: "端末で撮影した点検（架空）",
  });

  // --- 通信断の入力2: 本人出欠（参加。保存は遮断される） ---
  await page.goto(`/app/activities/${activityId}`);
  await page.getByRole("button", { name: "参加", exact: true }).click();
  await expect.poll(async () => (await draftRows(page, memberA.memberId)).length, { timeout: 15_000 }).toBe(3); // 点検＋seed＋出欠

  // --- 通信断の入力3: 参集の記録（参集中。保存は遮断される） ---
  await page.goto(`/app/incidents/${incidentId}`);
  await page.getByRole("button", { name: "自分の参集を記録" }).click();
  await page.getByRole("button", { name: "記録を保存" }).click();
  await expect.poll(async () => (await draftRows(page, memberA.memberId)).length, { timeout: 15_000 }).toBe(4); // ＋参集

  // --- SCR-27: 未同期の一覧（この端末・この利用者の4件。他者の下書きは復元しない） ---
  await page.goto("/app/sync");
  await expect(page.getByText("未同期 4件")).toBeVisible({ timeout: 15_000 });

  // 写真先行ゲートの証拠: 写真がreadyになっていない間（この時点まで）に、写真つき点検の親操作を
  // 一度も試みていないこと（ゲートが無いと起動時同期がready前に親を送ろうとして記録に残る）
  const phase1SeededSyncIdx = log.findIndex((l) => l.includes("/api/v1/sync/commands") && l.includes(seededCiOpId));
  expect(phase1SeededSyncIdx).toBe(-1);

  // --- 別端末（context2。同じAの2台目）: 出欠を先に更新して版を進める（競合の種）＋失権の注入 ---
  const context2 = await newUserContext(browser, viewport);
  const page2 = await context2.newPage();
  await loginViaUi(page2, emailA);
  await expect(page2.getByRole("heading", appHeading)).toBeVisible();
  await page2.goto(`/app/activities/${activityId}`);
  await page2.getByRole("button", { name: "未定", exact: true }).click();
  await expect.poll(async () => {
    const d = await adminApiData<{ attendance: { memberId: string; response: string; version: number }[] }>(request, "GET", `/api/v1/activities/${activityId}`);
    return d.data.data.attendance.find((r) => r.memberId === memberA.memberId)?.response ?? "none";
  }, { timeout: 15_000 }).toBe("undecided"); // 別端末の更新で版が進む（Aの下書きは baseVersion=0 のまま）
  // 端末紛失時の失権（API-38。管理者がAの全セッションを失効させる）
  const fresh = await adminApiData<{ id: string; account?: { userId: string; authzVersion: number } }[]>(
    request, "GET", `/api/v1/members?q=${encodeURIComponent(`架空 同期 A ${tag}`)}`,
  );
  const accountA = fresh.data.data.find((m) => m.id === memberA.memberId)!.account!;
  await adminApiData(request, "POST", `/api/v1/users/${accountA.userId}/session-revocations`, {
    expectedAuthzVersion: accountA.authzVersion, reason: "e2e: 端末紛失時の全セッション失効（架空）",
  });
  await context2.close();

  // --- 再接続1回目: 失権しているため同期は再認証（401）で止まる。下書きは壊れず・応答不明のまま ---
  await page.reload();
  await expect(page).toHaveURL(/\/login/, { timeout: 20_000 });
  const rowsWhileRevoked = await draftRows(page, memberA.memberId);
  expect(rowsWhileRevoked).toHaveLength(4);
  expect(rowsWhileRevoked.every((r) => r.status !== "applied")).toBe(true); // 偽の完了を作らない

  // --- 再接続2回目: 再ログイン後の起動時同期。応答不明（参集）を1回だけ注入して再読込 ---
  mode = "drop-once";
  await loginViaUi(page, emailA);
  await expect(page.getByRole("heading", appHeading)).toBeVisible();
  const t0 = Date.now();
  const firstSync = page.waitForRequest((r) => r.url().includes("/api/v1/sync/commands"), { timeout: 10_000 });
  await page.goto("/app/sync");
  await firstSync;
  const syncStartsWithinSeconds = (Date.now() - t0) / 1000;
  mode = "open";

  // 同期の完了: 出欠の下書きは競合で止まり（自動上書きしない）、他は反映される
  // （競合の語はカードの状態チップと比較パネルの両方に出るため最初の1つで待つ）
  await expect(page.getByText("競合", { exact: true }).first()).toBeVisible({ timeout: 90_000 });

  // サーバー側の断言1: 出欠は自動上書きされていない（別端末の「未定」・版1のまま。人が決めるまで変わらない）
  const detail = await adminApiData<{ attendance: { memberId: string; response: string; version: number }[] }>(
    request, "GET", `/api/v1/activities/${activityId}`,
  );
  const serverAttendance = detail.data.data.attendance.find((r) => r.memberId === memberA.memberId)!;
  const conflictAutomaticallyOverwritten = serverAttendance.response !== "undecided" || serverAttendance.version !== 1;
  // 下書きは競合のまま端末に残る（消さない・勝手に送り直さない）
  const conflictRows = (await draftRows(page, memberA.memberId)).filter((r) => r.operationCode === "attendance.respond");
  expect(conflictRows).toHaveLength(1);
  expect(conflictRows[0]!.status).toBe("conflict");

  // サーバー側の断言2: 点検は2件とも反映（seed分＋画面入力分）。親の送信は再接続後で、
  // 写真の検査確定（completion）より後（ready前の試みはphase1SeededSyncIdxで除外済み）
  const inspections = await adminApiData<{ id: string }[]>(request, "GET", `/api/v1/facilities/${facilityId}/inspections`);
  expect(inspections.data.data).toHaveLength(2);
  const seededSyncIdx = log.findIndex((l) => l.includes("/api/v1/sync/commands") && l.includes(seededCiOpId));
  const lastCompletionIdx = log.reduce((acc, l, i) => (l.includes("/completion") ? i : acc), -1);
  const parentSentBeforeReady =
    phase1SeededSyncIdx !== -1 ||
    !(seededSyncIdx > -1 && lastCompletionIdx > -1 && lastCompletionIdx < seededSyncIdx);

  // サーバー側の断言3: 参集は応答不明（適用→応答喪失）を経ても必ず1回（二重適用0）
  const incidentDetail = await adminApiData<{ participants: { memberId: string }[] }>(request, "GET", `/api/v1/incidents/${incidentId}`);
  expect(incidentDetail.data.data.participants.filter((p) => p.memberId === memberA.memberId)).toHaveLength(1);

  // --- SCR-27: 競合の比較（サーバー現値と下書き）と手動解消 ---
  await expect(page.getByText("この端末の入力")).toBeVisible({ timeout: 30_000 });
  await expect(page.getByText("現在サーバーにある値")).toBeVisible();
  const unsyncedLabelVisible = await page.getByText(/^未同期 1件/).isVisible().catch(() => false);

  // 手動解消: 現値の版で新しい操作として送り直す（新clientOperationId。旧版の自動上書きではない）
  await page.getByRole("button", { name: "現値の版で送り直す" }).click();
  await page.getByRole("button", { name: "送り直す", exact: true }).click();
  await expect(page.getByText(/反映 1件/)).toBeVisible({ timeout: 30_000 });
  await expect(page.getByText("同期待ちの入力はありません")).toBeVisible({ timeout: 30_000 });
  const resolved = await adminApiData<{ attendance: { memberId: string; response: string; version: number }[] }>(
    request, "GET", `/api/v1/activities/${activityId}`,
  );
  const resolvedRow = resolved.data.data.attendance.find((r) => r.memberId === memberA.memberId)!;
  expect(resolvedRow.response).toBe("attending"); // 人が選んだ解消の結果
  expect(resolvedRow.version).toBe(2); // 現値(1)の版での新しい操作

  // --- ログアウト: 未同期の下書きは端末に残さない ---
  await logoutViaUi(page);
  await expect.poll(async () => (await draftRows(page, memberA.memberId)).length, { timeout: 15_000 }).toBe(0);

  // --- ブリーフの4断言（docs/16 T077） ---
  expect(syncStartsWithinSeconds).toBeLessThanOrEqual(60);
  expect(conflictAutomaticallyOverwritten).toBe(false);
  expect(parentSentBeforeReady).toBe(false);
  expect(unsyncedLabelVisible).toBe(true);

  await context1.close();
});
