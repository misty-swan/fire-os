import { env } from "cloudflare:workers";
import { applyD1Migrations } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import { LOAD_ADMIN, LOAD_MEMBER, REPRESENTATIVE_PROFILE, seedLoad, summarizeLoad, type RequestSample } from "../../scripts/seed-load";
import { LoadClient, idem, makeLoadApp, toJson } from "./helpers";

/**
 * 30端末の再接続集中を「通常」と「通信劣化」で計測する（T082、docs/14 D18・docs/08 CT-14・V06の拡張）。
 *
 * V06（tests/realtime.test.ts）は定常pollの更新反映遅延を測った。ここではその **再接続** を代表件数下で測る:
 * 30端末が同時に再開したとき（切断中のcommitのbacklogがある状態）の1要求あたりの遅延と回収の正しさ。
 * 「通信劣化」は **人工的なRTT注入＋端末1/3の初回要求の喪失（応答を放棄＝クライアント側timeout。
 * 1 RTT待って同じcursorで再送）** で模擬する。要求を投げた後で応答を放棄するため、サーバー側は処理を
 * 完遂してもクライアントは受け取れない（実回線の「応答ロスト」と同じ状態）＝ **at-least-onceの再送経路の実測**。
 * 喪失は失敗sample（ok=false）として記録し、p95の百分位に含める（成功要求だけの性能判定をしない）。
 * 実回線の帯域制限・パケットロス分布・電池最適化は含まない（docs/evidence/V07-performance.mdの限界節）。
 *
 * 合否はD18の開発案（更新反映p95 5秒）を開発目標として使う（承認済み合格値ではない）。
 */

let admin: LoadClient;
let member: LoadClient;

beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
  await seedLoad(env, REPRESENTATIVE_PROFILE);
  const app = makeLoadApp();
  admin = new LoadClient(app, env, LOAD_ADMIN);
  member = new LoadClient(app, env, LOAD_MEMBER);
});

interface EventPage {
  events: { id: string; entityType: string; entityId: string; entityVersion: number; eventType: string; sequence: number }[];
  resumeCursor: string;
  resyncRequired: boolean;
}

const json = async (r: Response) => (await r.json()) as { data?: Record<string, unknown>; error?: { code: string } };
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** 切断中に幹部がcommitする（backlogを作る。作成1件＋訂正3件＝4イベント。出動イベントがunit配信に流れる） */
async function commitBacklog(): Promise<{ ids: string[]; incidentId: string; version: number }> {
  const created = await admin.request("POST", "/api/v1/incidents", {
    kind: "training", occurredAt: "2026-10-17T04:00:00.000Z", summary: "再接続試験の架空出動",
  }, idem());
  expect(created.status).toBe(201);
  const incident = (await json(created)).data! as { id: string; version: number };
  const ids: string[] = [`incident:${incident.id}:1`]; // 作成のイベント（1 mutation 1 event）
  let version = incident.version;
  for (const step of [
    { status: "active", reason: "訓練を開始" },
    { summary: "再接続試験の架空出動（概要を訂正）", reason: "場所の誤記を訂正" },
    { status: "closed", reason: "訓練を終了" },
  ]) {
    const r = await admin.request("PATCH", `/api/v1/incidents/${incident.id}`, { version, ...step }, idem());
    expect(r.status).toBe(200);
    version = ((await json(r)).data! as { version: number }).version;
    ids.push(`incident:${incident.id}:${version}`);
  }
  return { ids, incidentId: incident.id, version };
}

/** 30端末が現在の末尾へ接続してcursorを取る */
async function mintCursors(): Promise<string[]> {
  const seq = ((await env.DB.prepare("SELECT event_sequence FROM units WHERE id = ?").bind(LOAD_MEMBER.unitId)
    .first<{ event_sequence: number }>())!).event_sequence;
  const cursors: string[] = [];
  for (let i = 0; i < REPRESENTATIVE_PROFILE.terminals; i++) {
    const r = await member.request("GET", `/api/v1/events?afterSequence=${seq}`);
    expect(r.status).toBe(200);
    cursors.push((await toJson<{ data: { resumeCursor: string } }>(r)).data.resumeCursor);
  }
  return cursors;
}

describe("30端末の再接続集中（通常と通信劣化） (T082)", () => {
  it(
    "reconnect_storm_recovers_the_backlog_within_the_development_target_in_normal_and_degraded_network",
    async () => {
      // --- 通常: 30端末が同時に再開（backlog=切断中の作成1＋訂正3の4イベント） ---
      const cursorsNormal = await mintCursors();
      const backlog = await commitBacklog();

      const t0 = Date.now();
      const normalSamples: RequestSample[] = [];
      const normal = await Promise.all(cursorsNormal.map(async (cursor) => {
        const startedAt = Date.now();
        const r = await member.request("GET", `/api/v1/events?cursor=${encodeURIComponent(cursor)}`);
        expect(r.status).toBe(200);
        const page = (await toJson<{ data: EventPage }>(r)).data;
        normalSamples.push({ api: "API-80", bucket: "poll", ok: true, status: r.status, durationMs: Date.now() - startedAt });
        return { page };
      }));
      const normalWallMs = Date.now() - t0;
      // summarizeLoadで集計する（このフェーズに失敗は無いが、劣化側と同じ百分位の正本を使う）
      const normalMetrics = summarizeLoad(normalSamples);
      const normalP95 = normalMetrics.buckets.poll.p95Ms;

      // 全端末が同じ窓（単調順・取りこぼしなし）で受領する（V06と同じ検収）
      for (const x of normal) {
        expect(x.page.events.map((e) => `${e.entityType}:${e.entityId}:${e.entityVersion}`)).toEqual(backlog.ids);
      }
      const versionNormal = normal.map((x) =>
        x.page.events.reduce((v, e) => (e.entityId === backlog.incidentId && e.entityVersion > v ? e.entityVersion : v), 0),
      );
      expect(Math.min(...versionNormal)).toBe(backlog.version); // 30端末すべてが最新版へ収束

      // --- 通信劣化: RTT注入＋端末1/3の初回要求を実際に喪失させる（T082修正ラウンド1） ---
      // 初回は要求を発射したまま応答を放棄する（クライアント側timeout。サーバーは処理を完遂しても
      // クライアントは受け取れない＝実回線の応答ロストと同じ状態）。1 RTT待って同じcursorで再送するので、
      // 再送端末はbacklogをもう一度受け取る（at-least-once。重複の畳み込みはクライアントの責務）。
      // 喪失は失敗sample（ok=false）として記録し、p95の百分位に含める（成功だけの判定をしない）。
      // 実回線の帯域・ロス分布・電池最適化は含まない（人工劣化の限界はV07に記録）
      const RTT_MS = 300; // 上下それぞれに掛ける片道目安（モバイル回線の典型的なRTTのオーダー）。timeout待ちも1 RTT
      const cursorsDegraded = await mintCursors();
      const backlog2 = await commitBacklog();

      const degradedStarted = Date.now();
      const degradedSamples: RequestSample[] = [];
      const droppedBodies: Promise<void>[] = [];
      const degraded = await Promise.all(cursorsDegraded.map(async (cursor, i) => {
        const url = `/api/v1/events?cursor=${encodeURIComponent(cursor)}`;
        if (i % 3 === 0) {
          await sleep(RTT_MS * (0.8 + Math.random() * 0.4)); // uplink（初回分）
          // 初回要求を発射して応答を放棄する（bodyは後始末だけする。中身は読まない＝クライアントは受け取れない）
          droppedBodies.push(
            member.request("GET", url).then(
              (r) => { void r.body?.cancel().catch(() => {}); },
              () => {}, // そもそも失敗しても「喪失」の扱いとして同じ
            ),
          );
          degradedSamples.push({ api: "API-80", bucket: "poll", ok: false, status: 0, durationMs: RTT_MS }); // 喪失（client timeout）
          await sleep(RTT_MS); // 1 RTT待って諦める（client timeout）
        }
        // 再送（喪失しなかった端末は初回）。**同じcursor**で要求する（at-least-onceの再送）
        const startedAt = Date.now();
        await sleep(RTT_MS * (0.8 + Math.random() * 0.4)); // uplink
        const r = await member.request("GET", url);
        await sleep(RTT_MS * (0.8 + Math.random() * 0.4)); // downlink
        expect(r.status).toBe(200);
        const page = (await toJson<{ data: EventPage }>(r)).data;
        degradedSamples.push({ api: "API-80", bucket: "poll", ok: true, status: r.status, durationMs: Date.now() - startedAt });
        return { page, retried: i % 3 === 0 };
      }));
      await Promise.all(droppedBodies); // 放棄した初回の後始末を待ってから検収する（テスト終了時の宙ぶらりんを作らない）
      const degradedWallMs = Date.now() - degradedStarted;
      // summarizeLoadは失敗sampleも百分位に投入する（成功要求だけの性能判定をしない＝docs/08 CT-14）
      const degradedMetrics = summarizeLoad(degradedSamples);
      const degradedP95 = degradedMetrics.buckets.poll.p95Ms;
      // 再送端末（10本）: 応答を放棄された初回の代わりに、同じcursorの再送で **backlogをもう一度** 受け取る
      for (const x of degraded) {
        expect(x.page.events.map((e) => `${e.entityType}:${e.entityId}:${e.entityVersion}`)).toEqual(backlog2.ids);
        if (x.retried) expect(x.page.events.length).toBe(backlog2.ids.length); // at-least-onceの再配信（窓全体）
      }
      expect(degradedMetrics.buckets.poll.failedCount).toBe(REPRESENTATIVE_PROFILE.terminals / 3); // 喪失10本が記録されている
      expect(degradedMetrics.omittedFailedRequests).toBe(0); // 失敗を集計から外していない

      console.log(`[reconnect] 通常: p95=${normalP95}ms wall=${normalWallMs}ms / 劣化(RTT300ms＋1/3初回喪失→再送): p95=${degradedP95}ms wall=${degradedWallMs}ms 失敗sample=${degradedMetrics.buckets.poll.failedCount}（p95に含む）`);
      // D18開発案（更新反映p95 5秒）を開発目標として使う。承認済み合格値ではない（V07の残手順で実測し直す）
      expect(normalP95).toBeLessThanOrEqual(5000);
      expect(degradedP95).toBeLessThanOrEqual(5000);
      // 劣化は通常より遅い（注入したRTTと喪失→再送の分。これが逆なら測定の作り込みが壊れている）
      expect(degradedP95).toBeGreaterThan(normalP95);
    },
    600_000,
  );
});
