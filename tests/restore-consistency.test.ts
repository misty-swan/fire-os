import { env } from "cloudflare:workers";
import { applyD1Migrations } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import { resolvePrincipal } from "../src/server/auth/principal";
import { buildBackupManifest } from "../src/server/backup/manifest";
import { applyRestore, readDump, restoreTableOrder, verifyRestore } from "../src/server/backup/restore";
import type { ApiContext } from "../src/server/http";
import "../src/server/jobs/handlers/attachment"; // 検査job handlerの登録（Cron/Queueと同じ登録点）
import "../src/server/jobs/handlers/attachment-cleanup"; // 実体削除job handlerの登録
import "../src/server/jobs/handlers/notification"; // 配送job handlerの登録
import { runDueJobs } from "../src/server/jobs/runner";
import {
  registerChannelProvider,
  type DeliveryResult,
  type NotificationProvider,
} from "../src/server/notifications/provider";
import { loginAs, type Browser } from "./helpers/auth";
import { createFixture, type Identity, type TestFixture } from "./helpers/fixture";

/**
 * 復元の整合と外部効果の照合（T079、docs/07 §7、docs/08 CT-08、docs/13 RG-05、docs/14 D10）。
 *
 * - 「バックアップが存在する」ことではなく、「復元した環境が契約どおりに振る舞う」ことを試す:
 *   ①参照切れ（FK）がない ②ready実体（R2不変キー）が揃っていてhashが一致する ③既送の通知が再送されない
 *   ④復元点より前の旧sessionが業務に入れない（復元後sessions失効。API-38のsession_revoked_before機構を再利用）。
 * - 復元先は試験用の2つ目のD1（DB_FRESH。実環境でいう「別環境へ復元」相当）。
 *   空のschemaへmigrationを適用し、元D1の論理ダンプ（readDump＝wrangler d1 export相当）を
 *   applyRestoreで入れてからverifyRestoreで照合する。R2は実体が不変キー＋削除猶予のため同一bucketを
 *   使い回す（実環境ではR2状態の別複製を使う。ops/backup-restore.md）。
 * - 検出能力の裏付け（positiveだけの合格を避ける）は2つ目のケースで入れる: ready実体の欠落・hash破損・
 *   孤児（参照しないready実体）・既送delivery行の消失・失効基準の改変を「復元事故」として注入し、
 *   verifyRestoreが全て報告すること。
 * - 実Cloudflare（実D1/R2）への復元演習はこの試験では代替できない。docs/evidence/V07-restore.md に
 *   未実施の手順として記録する（docs/evidence/V06-realtime.md の「未実施」節と同じ形式）。
 */
let fx: TestFixture;
beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
  fx = await createFixture("two-units");
});

// --- 試験用の記録型provider（notification-delivery.test.tsと同じ流儀） ---
interface FakeCall {
  deliveryKey: string;
  addressRef: string;
  body: string;
}
const fake = {
  calls: [] as FakeCall[],
  behaviors: new Map<string, (call: FakeCall, nth: number) => DeliveryResult | Promise<DeliveryResult>>(),
  on(addressRef: string, behave: (call: FakeCall, nth: number) => DeliveryResult | Promise<DeliveryResult>) {
    this.behaviors.set(addressRef, behave);
  },
  reset() {
    this.calls = [];
    this.behaviors.clear();
  },
};
const fakeProvider: NotificationProvider = {
  channel: "inapp",
  id: "fake-inapp",
  async send(input) {
    fake.calls.push(input);
    const nth = fake.calls.filter((c) => c.addressRef === input.addressRef).length;
    const behave = fake.behaviors.get(input.addressRef);
    return behave ? behave(input, nth) : { kind: "provider_accepted", providerId: "fake-inapp" };
  },
};
registerChannelProvider(fakeProvider);

const idem = () => ({ "idempotency-key": crypto.randomUUID() });
const json = async (r: Response) => (await r.json()) as { data?: Record<string, unknown> };

// --- 構造検査を通るPNG（file-inspection.test.tsと同じ構成。magic/IHDR/IDAT/IEND＋CRC） ---
let CRC_TABLE: number[] | undefined;
function crc32(bytes: Uint8Array): number {
  if (!CRC_TABLE) {
    CRC_TABLE = [];
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      CRC_TABLE[n] = c >>> 0;
    }
  }
  let r = 0xffffffff;
  for (const b of bytes) r = CRC_TABLE[(r ^ b) & 0xff]! ^ (r >>> 8);
  return (r ^ 0xffffffff) >>> 0;
}
function pngChunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length);
  new DataView(out.buffer).setUint32(0, data.length);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(data, 8);
  new DataView(out.buffer).setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
  return out;
}
const validPng = (fill: number, size = 64): Uint8Array => {
  const ihdr = new Uint8Array(13);
  new DataView(ihdr.buffer).setUint32(0, 1); // width
  new DataView(ihdr.buffer).setUint32(4, 1); // height
  ihdr.set([8, 6, 0, 0, 0], 8);
  const idat = new Uint8Array(size).fill(fill);
  const out = [new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), pngChunk("IHDR", ihdr), pngChunk("IDAT", idat), pngChunk("IEND", new Uint8Array(0))];
  const total = out.reduce((n, p) => n + p.length, 0);
  const all = new Uint8Array(total);
  let o = 0;
  for (const p of out) {
    all.set(p, o);
    o += p.length;
  }
  return all;
};

/** 検査jobまで完走させたready添付（R2に不変ready keyが固定された状態）を作る */
async function makeReadyAttachment(who: Identity, bytes = validPng(1)) {
  const dRes = await fx.client(who).request("POST", "/api/v1/attachment-drafts", { intendedEntityType: "facility" }, idem());
  expect(dRes.status).toBe(201);
  const draft = (await json(dRes)).data! as { id: string };
  const iRes = await fx.client(who).request(
    "POST",
    "/api/v1/attachments/upload-intents",
    { target: { type: "attachment_draft", id: draft.id }, contentType: "image/png", byteSize: bytes.length },
    idem(),
  );
  expect(iRes.status).toBe(201);
  const intent = (await json(iRes)).data! as { id: string; uploadToken: string };
  const up = await fx.raw(who)(
    new Request(`http://example.com/api/v1/attachments/${intent.id}/upload`, {
      method: "PUT",
      headers: { "content-type": "application/octet-stream", "x-upload-token": intent.uploadToken },
      body: bytes as BufferSource,
    }),
  );
  expect(up.status).toBe(200);
  const attempt = (await json(up)).data! as { id: string; sha256: string };
  const cRes = await fx.client(who).request(
    "POST",
    `/api/v1/attachments/${intent.id}/completion`,
    { version: 1, uploadAttemptId: attempt.id, sha256: attempt.sha256 },
    idem(),
  );
  expect(cRes.status).toBe(202);
  await runDueJobs(env);
  const row = (await fx.rows("attachments", { id: intent.id }))[0]!;
  expect(row.status).toBe("ready");
  return { attachmentId: intent.id, readyKey: row.ready_key as string, sha256: row.sha256 as string, version: row.version as number };
}

/** 活動1件（対象snapshot付き。notification-delivery.test.tsと同じ流儀） */
async function createActivity(audienceMemberIds: string[]): Promise<string> {
  const a = fx.units.a;
  const res = await fx.client(a.people.admin).request("POST", "/api/v1/activities", {
    title: "復元試験用の訓練（架空）",
    kind: "training",
    plannedStartsAt: "2026-11-02T01:00:00.000Z",
    locationText: "架空市中央公園",
    ownerMemberId: a.people.officer.memberId!,
    audienceMemberIds,
  }, idem());
  expect(res.status).toBe(201);
  return ((await json(res)).data! as { id: string }).id;
}

interface NotificationDraft {
  id: string;
  version: number;
  bodyHash: string;
  audienceHash: string;
}

/** 通知draft（源=活動の未回答抽出）を作る */
async function createNotificationDraft(memberIds: string[]): Promise<NotificationDraft> {
  const activityId = await createActivity(memberIds);
  const res = await fx.client(fx.units.a.people.admin).request("POST", "/api/v1/notifications/drafts", {
    source: { type: "activity", id: activityId },
    channels: ["inapp"],
  }, idem());
  expect(res.status).toBe(201);
  return (await json(res)).data! as unknown as NotificationDraft;
}

/** 承認（API-64 approve＝配送job受付）してjob行を返す */
async function approveAndJob(draft: NotificationDraft) {
  const a = fx.units.a;
  const res = await fx.client(a.people.admin).request("POST", `/api/v1/notifications/${draft.id}/approval`, {
    version: draft.version, bodyHash: draft.bodyHash, audienceHash: draft.audienceHash, decision: "approve",
  }, idem());
  expect(res.status).toBe(202);
  const rows = await fx.rows("jobs", { dedupe_key: `${a.id}|notification.deliver|${draft.id}|${draft.version}` });
  expect(rows).toHaveLength(1);
  return { id: rows[0]!.id as string, dedupeKey: rows[0]!.dedupe_key as string };
}

/** 実行可能時刻を過去へ動かす（runDueJobsは実時刻基準。再試行の60秒待ちを実時間待たない） */
const makeRunnable = async (db: D1Database, jobId: string) => {
  await db.prepare("UPDATE jobs SET next_attempt_at = '2000-01-01T00:00:00.000Z' WHERE id = ?").bind(jobId).run();
};

/**
 * 復元先を「新規にschemaを作った空の環境」に戻す（実環境でいう空のpersist先への`wrangler d1 migrations apply`相当。
 * docs/07 §7「stagingでD1復元」。追記専用表（audit_logs等）は在り得ない行から復元できないため、
 * 復元のたびにschemaから作り直す。子表から先にDROPするのでFKとトリガーを壊さない）。
 */
async function resetRestoreTarget() {
  const order = await restoreTableOrder(env.DB_FRESH);
  for (const t of [...order].reverse()) {
    await env.DB_FRESH.prepare(`DROP TABLE IF EXISTS "${t}"`).run();
  }
  await env.DB_FRESH.prepare("DROP TABLE IF EXISTS d1_migrations").run();
  await applyD1Migrations(env.DB_FRESH, env.TEST_MIGRATIONS);
}

describe("復元の整合と外部効果の照合 (T079)", () => {
  it("restore_does_not_resend_notifications_or_revive_old_sessions", async () => {
    const a = fx.units.a;
    const admin = a.people.admin;
    const memberRef = `member:${a.people.member.memberId}#inbox`;
    const officerRef = `member:${a.people.officer.memberId}#inbox`;

    // --- seed 1: 通知（1人既送・1人拒否で再送待ち。配送途中の状態をbackup時点にする） ---
    fake.reset();
    fake.on(memberRef, () => ({ kind: "provider_accepted", providerId: "fake-inapp" }));
    fake.on(officerRef, (_call, nth) => (nth === 1 ? { kind: "failed", errorCode: "provider_rejected" } : { kind: "provider_accepted", providerId: "fake-inapp-retry" }));
    const draft = await createNotificationDraft([a.people.member.memberId!, a.people.officer.memberId!]);
    const deliverJob = await approveAndJob(draft);
    await makeRunnable(env.DB, deliverJob.id);
    expect((await runDueJobs(env)).committed).toBe(1);
    const deliveries = (await env.DB.prepare(
      "SELECT d.delivery_key, d.status, d.attempt_count FROM notification_deliveries d " +
        "JOIN notification_recipients r ON r.id = d.recipient_id AND r.unit_id = d.unit_id WHERE r.notification_id = ?",
    ).bind(draft.id).all<{ delivery_key: string; status: string; attempt_count: number }>()).results;
    const accepted = deliveries.find((d) => d.status === "provider_accepted")!;
    const retrying = deliveries.find((d) => d.status === "retry_wait")!;
    expect(accepted.attempt_count).toBe(1);
    expect(retrying.attempt_count).toBe(1);

    // --- seed 2: R2のready実体（検査済み・hash固定） ---
    const kept = await makeReadyAttachment(admin);

    // --- seed 3: 論理削除済み行（tombstone。cleanup jobは未実行＝削除猶予の状態） ---
    const removing = await makeReadyAttachment(admin, validPng(2));
    const delRes = await fx.client(admin).request("DELETE", `/api/v1/attachments/${removing.attachmentId}`, { version: removing.version, reason: "復元試験用の削除（架空）" }, idem());
    expect(delRes.status).toBe(204);
    expect(((await fx.rows("attachments", { id: removing.attachmentId }))[0]!.status)).toBe("deleting");

    // --- seed 4: 復元点より前の旧session（実ログイン。API-38の機構が拒否する側のsession） ---
    const browser: Browser = await loginAs({ userId: a.people.member.userId, unitId: a.id });
    expect((await browser.json("GET", "/api/v1/me")).status).toBe(200);

    // --- manifest（復元点。D1復元点/R2 key/hash/論理削除時刻/既送状態を記録） ---
    const manifest = await buildBackupManifest(env);
    expect(manifest.restorePointAt).toBeTruthy();
    expect(manifest.d1.tables["notification_deliveries"]).toBeGreaterThanOrEqual(2);
    expect(manifest.r2.map((r) => r.key)).toContain(kept.readyKey);
    expect(manifest.r2.map((r) => r.key)).toContain(removing.readyKey); // tombstoneの実体も復元点では保護対象
    expect(manifest.tombstones.map((t) => t.attachmentId)).toContain(removing.attachmentId);
    expect(manifest.deliveries.map((d) => d.deliveryKey)).toEqual(expect.arrayContaining([accepted.delivery_key, retrying.delivery_key]));
    expect(manifest.jobsUncertain).toBeGreaterThanOrEqual(2); // 配送の再送待ち＋tombstoneの削除job

    // --- 復元（別環境相当: DB_FRESHへ空のschemaを新規作成し、論理ダンプから復元） ---
    await resetRestoreTarget();
    const dump = await readDump(env.DB);
    const restorePointAt = manifest.restorePointAt;
    await applyRestore({ DB: env.DB_FRESH }, dump, { restorePointAt });
    const restoredEnv = { ...env, DB: env.DB_FRESH };

    // --- 照合（FK/hash/所属/job/外部配送差分/失効基準） ---
    const check = await verifyRestore({ env: restoredEnv, manifest });
    const { foreignKeyErrors, missingReadyObjects } = check;
    expect(foreignKeyErrors).toEqual([]);
    expect(missingReadyObjects).toEqual([]);
    expect(check.hashMismatches).toEqual([]);
    expect(check.countMismatches).toEqual([]);
    expect(check.aclViolations).toEqual([]);
    expect(check.jobIssues).toEqual([]);
    expect(check.deliveryDiffs).toEqual([]);
    expect(check.unrevokedSessions).toEqual([]);
    expect(check.ok).toBe(true);

    // --- 復元後にjobを回す: 既送deliveryは再送されない（deliveryKey照合）。未送分の再送だけが続く ---
    const callsAtRestore = fake.calls.length;
    const restoredJobId = (await env.DB_FRESH.prepare("SELECT id FROM jobs WHERE dedupe_key = ?").bind(deliverJob.dedupeKey).first<{ id: string }>())!.id;
    await makeRunnable(env.DB_FRESH, restoredJobId);
    const summary = await runDueJobs(restoredEnv);
    expect(summary.leased).toBeGreaterThanOrEqual(1);
    const resentAlreadyAcceptedDeliveries = fake.calls.slice(callsAtRestore).filter((c) => c.deliveryKey === accepted.delivery_key).length;
    // 拒否で再送待ちだった宛先（未送分）は、復元後も配送が続行される（止まったままにしない）
    expect(fake.calls.slice(callsAtRestore).some((c) => c.deliveryKey === retrying.delivery_key)).toBe(true);

    // --- 復元前の旧sessionは業務APIに入れない（復元後sessions失効。session_revoked_before経路） ---
    const req = new Request("http://example.com/api/v1/me", { headers: { cookie: browser.cookieHeader() } });
    const ctx = { env: restoredEnv, req: { raw: req, header: (name: string) => req.headers.get(name) } } as unknown as ApiContext;
    let oldSessionAccepted = true;
    let denialReason = "";
    try {
      await resolvePrincipal(ctx);
    } catch (err) {
      oldSessionAccepted = false;
      denialReason = ((err as { details?: { reason?: string }[] }).details ?? [])[0]?.reason ?? "";
    }
    expect(denialReason).toBe("session_revoked");

    // --- briefの4断言 ---
    expect(foreignKeyErrors).toEqual([]);
    expect(missingReadyObjects).toEqual([]);
    expect(resentAlreadyAcceptedDeliveries).toBe(0);
    expect(oldSessionAccepted).toBe(false);
  });

  it("verify_restore_detects_missing_object_lost_deliveries_and_unrevoked_sessions", async () => {
    // 検出能力の裏付け: positive（1つ目のケース）だけでは検査が空回りでも合格してしまうため、
    // 「復元事故」（実体欠落・hash破損・孤児・既送行の復元漏れ・失効基準の改変）を注入して
    // 全て報告されることを試す。
    const a = fx.units.a;
    const admin = a.people.admin;

    // 前ケースのtombstone削除jobを先に完走させておく（削除猶予の終了＝ready_keyが無い終端状態へ）
    await env.DB.prepare(
      "UPDATE jobs SET status = 'cancelled', lease_token = NULL, lease_until = NULL WHERE status IN ('queued', 'retry_wait', 'running') AND kind <> 'attachment.cleanup'",
    ).run();
    await runDueJobs(env);
    expect(await fx.rows("attachments", { status: "deleting" })).toHaveLength(0);

    // seed: ready添付2件（1件は実体を後で欠落させ、1件は破損させる）＋既送delivery
    fake.reset();
    const operatorRef = `member:${a.people.operator.memberId}#inbox`;
    const missing = await makeReadyAttachment(admin, validPng(3));
    const corrupt = await makeReadyAttachment(admin, validPng(4));
    const draft = await createNotificationDraft([a.people.operator.memberId!]);
    const deliverJob = await approveAndJob(draft);
    await makeRunnable(env.DB, deliverJob.id);
    expect((await runDueJobs(env)).committed).toBe(1);
    const sent = (await env.DB.prepare(
      "SELECT d.delivery_key FROM notification_deliveries d JOIN notification_recipients r ON r.id = d.recipient_id AND r.unit_id = d.unit_id WHERE r.notification_id = ?",
    ).bind(draft.id).all<{ delivery_key: string }>()).results;
    expect(sent).toHaveLength(1);
    expect(fake.calls.filter((c) => c.deliveryKey === sent[0]!.delivery_key)).toHaveLength(1);

    const manifest = await buildBackupManifest(env);
    expect(manifest.r2.map((r) => r.key)).toEqual(expect.arrayContaining([missing.readyKey, corrupt.readyKey]));

    // --- 復元事故の注入 ---
    const dump = await readDump(env.DB);
    dump["notification_deliveries"] = []; // ①既送delivery行の復元漏れ（再送が起きる事故）
    await resetRestoreTarget();
    await applyRestore({ DB: env.DB_FRESH }, dump, { restorePointAt: manifest.restorePointAt });
    await env.DB_FRESH.prepare("UPDATE users SET session_revoked_before = NULL").run(); // ②失効基準の改変（復元手順の省略）
    await env.FILES.delete(missing.readyKey); // ③実体の欠落（消失写真）
    await env.FILES.put(corrupt.readyKey, validPng(5) as BufferSource); // ④実体の破損（hash不一致。内容の違う実体を同じkeyへ戻した事故）
    await env.FILES.put("ready/orphan-demo/no-row", validPng(6) as BufferSource); // ⑤孤児（どの行も参照しないready実体。削除漏れ）

    const check = await verifyRestore({ env: { ...env, DB: env.DB_FRESH }, manifest });
    expect(check.ok).toBe(false);
    expect(check.missingReadyObjects).toContain(missing.readyKey);
    expect(check.hashMismatches.length).toBeGreaterThan(0);
    expect(check.hashMismatches[0]).toContain(corrupt.readyKey);
    expect(check.orphanReadyObjects).toContain("ready/orphan-demo/no-row");
    expect(check.deliveryDiffs).toEqual(expect.arrayContaining([expect.stringContaining(sent[0]!.delivery_key)]));
    expect(check.countMismatches).toEqual(expect.arrayContaining([expect.stringContaining("notification_deliveries")]));
    expect(check.unrevokedSessions.length).toBeGreaterThan(0);
  });
});
