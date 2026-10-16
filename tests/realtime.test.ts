import { env } from "cloudflare:workers";
import { applyD1Migrations } from "cloudflare:test";
import { Context } from "hono";
import { beforeAll, describe, expect, it } from "vitest";
import { cursorKey, encodeSyncCursor, CURSOR_TTL_MS } from "../src/server/events/cursor";
import { EventTransport } from "../src/server/events/transport";
import type { ApiContext } from "../src/server/http";
import { createFixture, type TestFixture } from "./helpers/fixture";

let fx: TestFixture;
beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
  fx = await createFixture("two-units");
});

const idem = () => ({ "idempotency-key": crypto.randomUUID() });
const json = async (r: Response) =>
  (await r.json()) as {
    data?: Record<string, unknown>;
    error?: { code: string; details?: { field: string; reason: string }[] };
  };

interface SyncEvent {
  id: string; entityType: string; entityId: string; entityVersion: number;
  eventType: string; payload: Record<string, unknown>; sequence: number; createdAt: string;
}
interface EventPage {
  events: SyncEvent[];
  resumeCursor: string;
  resyncRequired: boolean;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * 30端末の更新配信と切断後snapshot回復 (T073、D16/D18・V06・CT-12)。
 *
 * 端末は「同じ団員が開いた30本の独立したpoll接続」（端末ごとのcursorとpoll周期を持つ）として模擬する。
 * 利用者アカウント単位の負荷（認証・セッション）や実回線の遅延は含まない＝V06の残手順
 * （tests/live/realtime-load.test.tsとdocs/evidence/V06-realtime.md）。ここで確かめるのは:
 *  - 配信の遅延がD18の開発案（p95 5秒）に収まること（poll周期2秒の根拠となる実測）
 *  - 切断/再接続集中・順序逆・旧版の再配信でも版が後退せず（entityVersionAfter >= entityVersionBefore）、
 *    不可視イベント（他分団・宛先外のお知らせ）が1行も露出しないこと（visibleLeakCount 0）
 *  - 失権（認可版の増分）・期限切れcursorは409 RESYNC_REQUIREDになり、snapshot（API-70）の取り直しで
 *    回復できること（resyncSnapshotCount > 0）
 *  - 輸送の契約（EventTransport.subscribe）が絞り付きでdrainできること（poll方式の正本経路はAPI-80。同じ走査核）
 */
describe("30端末の更新配信と切断後snapshot回復 (T073)", () => {
  it(
    "reconnect_ignores_old_entity_versions_and_resyncs_expired_cursor",
    async () => {
      const a = fx.units.a;
      const admin = a.people.admin; // 管理者（出動の変更 PER-04・お知らせ PER-03）
      const member = a.people.member; // 一般団員（30端末の接続者。PER-13は全役割）
      const otherUnitAdmin = fx.units.b.people.admin;

      // --- 準備: 出動1件（登録→出動中。イベント2件）を作り、memberがsnapshot（API-70）を取る ---
      const incRes = await fx.client(admin).request("POST", "/api/v1/incidents", {
        kind: "training", occurredAt: "2026-10-15T02:00:00.000Z", summary: "水防訓練（架空）",
      }, idem());
      expect(incRes.status).toBe(201);
      const incident = (await json(incRes)).data! as { id: string; version: number };
      const toActive = await fx.client(admin).request("PATCH", `/api/v1/incidents/${incident.id}`, {
        version: incident.version, status: "active", reason: "訓練を開始",
      }, idem());
      expect(toActive.status).toBe(200);
      incident.version = ((await json(toActive)).data! as { version: number }).version;

      const snapRes = await fx.client(member).request("GET", `/api/v1/incidents/${incident.id}`);
      expect(snapRes.status).toBe(200);
      const snapshot = (await json(snapRes)).data! as { version: number; snapshotCursor: string };

      // 不可視イベントの期待値を作る（この時点ではまだcommitしない。切断中に流す）
      const allEvents = async () =>
        (await env.DB.prepare(
          "SELECT id, entity_type, entity_id, entity_version, sequence FROM domain_events WHERE unit_id = ? AND entity_type = 'incident' AND entity_id = ? ORDER BY sequence",
        ).bind(a.id, incident.id).all<{ id: string; entity_version: number; sequence: number }>()).results;

      // --- 30端末が各自のcursorを取る（端末ごとに独立した接続。streamは絞り無し＝unit全体。SCR-12以外の配信も受ける） ---
      const TERMINALS = 30;
      const termCursor: string[] = [];
      for (let i = 0; i < TERMINALS; i++) {
        const r = await fx.client(member).request("GET", `/api/v1/events?cursor=${encodeURIComponent(snapshot.snapshotCursor)}`);
        expect(r.status).toBe(200);
        const page = (await json(r)).data! as unknown as EventPage;
        expect(page.events).toEqual([]); // snapshot位置は最新。初回の窓は空
        termCursor.push(page.resumeCursor);
      }

      // 受け取った全ページの検収（不可視の露出を数える。全phaseで共有する）
      let visibleLeakCount = 0;
      let unexpectedErrors = 0;
      const otherIncidentRes = await fx.client(otherUnitAdmin).request("POST", "/api/v1/incidents", {
        kind: "simulation", occurredAt: "2026-10-15T03:00:00.000Z", summary: "別分団の架空出動（流れないはず）",
      }, idem());
      expect(otherIncidentRes.status).toBe(201);
      const otherIncidentId = ((await json(otherIncidentRes)).data! as { id: string }).id;
      const tally = (page: EventPage) => {
        for (const e of page.events) {
          // 宛先外のお知らせ・通知と、他分団の出来事は1行も見えてはいけない（docs/05 §8のACL filter）
          if (e.entityType === "announcement" || e.entityType === "notification" || e.entityId === otherIncidentId) {
            visibleLeakCount++;
          }
        }
      };

      // --- 定常の更新配信: 30端末がpoll周期（2秒＋揺らめき）で回っているところへ、管理者が1回commitする ---
      // 端末のpoll周期は useIncidentUpdates と同じ2秒（docs/evidence/V06-realtime.mdの実測条件）
      const POLL_MS = 2000;
      const measured = incident.version + 1; // これからcommitする訂正の版
      const seen = new Array<boolean>(TERMINALS).fill(false);
      const latencies: number[] = [];
      let stop = false;
      const jitter = () => POLL_MS * 0.2 * Math.random();
      const loops = termCursor.map((cursor0, i) =>
        (async () => {
          let cursor = cursor0;
          while (!stop) {
            await sleep(POLL_MS + jitter());
            if (stop) break;
            const r = await fx.client(member).request("GET", `/api/v1/events?cursor=${encodeURIComponent(cursor)}`);
            if (r.status !== 200) { unexpectedErrors++; continue; }
            const page = (await json(r)).data! as unknown as EventPage;
            tally(page);
            cursor = page.resumeCursor;
            termCursor[i] = cursor;
            if (!seen[i] && page.events.some((e) => e.entityType === "incident" && e.entityId === incident.id && e.entityVersion === measured)) {
              seen[i] = true;
              latencies.push(Date.now() - t0);
            }
          }
        })(),
      );
      // ループが最初のsleepに入るのを待ってからcommitする（全端末が「ずれた位相」で回る。斉奏を崩す）
      await sleep(50);
      const t0 = Date.now();
      const fix = await fx.client(admin).request("PATCH", `/api/v1/incidents/${incident.id}`, {
        version: incident.version, summary: "水防訓練（架空・概要を訂正）", reason: "場所の誤記を訂正",
      }, idem());
      expect(fix.status).toBe(200);
      incident.version = ((await json(fix)).data! as { version: number }).version;
      const deadline = Date.now() + 15_000;
      while (seen.some((s) => !s) && Date.now() < deadline) await sleep(100);
      stop = true;
      await Promise.all(loops);
      expect(seen.every((s) => s)).toBe(true); // 30端末すべてが更新を受けた
      expect(unexpectedErrors).toBe(0);

      const sorted = [...latencies].sort((x, y) => x - y);
      const updateLatencyP95Seconds = sorted[Math.ceil(0.95 * sorted.length) - 1]! / 1000;

      // --- 切断 → 再接続集中: 全端末が止まっている間に3回のcommit＋不可視イベントを流す ---
      // （上でループを止めたのが切断。termCursorは切断直前の位置のまま）
      const commits: number[] = [];
      const commit = async (body: Record<string, unknown>) => {
        const r = await fx.client(admin).request("PATCH", `/api/v1/incidents/${incident.id}`, { version: incident.version, ...body }, idem());
        expect(r.status).toBe(200);
        incident.version = ((await json(r)).data! as { version: number }).version;
        commits.push(incident.version);
      };
      await commit({ status: "closed", reason: "訓練を終了" });
      await commit({ summary: "水防訓練（架空・最終）", reason: "概要を確定" });
      await commit({ status: "recording", reason: "終了時刻の訂正のため記録を再開" });
      // memberには見えないお知らせ（宛先=adminのみ）と、別分団のcommit（unitの外なのでそもそもstreamに現れない）
      const annRes = await fx.client(admin).request("POST", "/api/v1/announcements", {
        title: "管理者宛の架空のお知らせ", body: "団員の端末には配信されない（宛先外）", audienceMemberIds: [admin.memberId!],
      }, idem());
      expect(annRes.status).toBe(201);

      const expectedBacklog = (await allEvents()).filter((e) => e.entity_version > measured).map((e) => e.id);
      expect(expectedBacklog.length).toBe(3); // 切断中の3件（訂正1件は定常の配信で全端末が受取済み）

      // 再接続の集中（30端末が同時に再開。at-least-onceで窓が返る）
      const storm = await Promise.all(
        termCursor.map((c) => fx.client(member).request("GET", `/api/v1/events?cursor=${encodeURIComponent(c)}`)),
      );
      const client = { version: measured - 1 }; // 端末が表示している版（版比較の畳み込みの起点）
      for (const r of storm) {
        expect(r.status).toBe(200);
        const page = (await json(r)).data! as unknown as EventPage;
        tally(page);
        // 旧版の再配信・順序逆（同じ窓が後から届く）でも、**版は後退しない**: 新しい版だけ採用する
        for (const e of page.events) {
          if (e.entityType === "incident" && e.entityId === incident.id && e.entityVersion > client.version) {
            client.version = e.entityVersion;
          }
        }
        expect(page.events.map((e) => e.id)).toEqual(expectedBacklog);
      }

      // 順序逆の注入: いちばん古いcursor（第1段階の初期位置）を**後から**見直すと、同じ窓（旧版）がもう一度届く。
      // 採用規則により版は動かない（reconnect_ignores_old_entity_versions の本体）
      const stale = await fx.client(member).request("GET", `/api/v1/events?cursor=${encodeURIComponent(snapshot.snapshotCursor)}`);
      expect(stale.status).toBe(200);
      const stalePage = (await json(stale)).data! as unknown as EventPage;
      tally(stalePage);
      const entityVersionBefore = client.version;
      for (const e of stalePage.events) {
        if (e.entityType === "incident" && e.entityId === incident.id && e.entityVersion > client.version) {
          client.version = e.entityVersion;
        }
      }
      const entityVersionAfter = client.version;
      // 畳み込んだ版は最新に収束し、旧版の再配信で後退しない
      expect(entityVersionAfter).toBe(incident.version);
      expect(entityVersionAfter).toBeGreaterThanOrEqual(entityVersionBefore);

      // --- 輸送の契約: EventTransport.subscribe（poll方式の走査核。絞り付きdrain） ---
      const memberCtx = (query: string) =>
        new Context(
          new Request(`http://example.com/api/v1/events${query}`, {
            headers: { "x-test-identity": JSON.stringify(member) },
          }),
          { env },
        ) as unknown as ApiContext;
      let drained = 0;
      for await (const page of EventTransport.subscribe(memberCtx(""), {
        cursor: snapshot.snapshotCursor,
        filter: { entityType: "incident", entityId: incident.id },
      })) {
        tally(page);
        for (const e of page.events) {
          expect(e.entityType).toBe("incident"); // 絞りがcursorに焼かれている
          expect(e.entityId).toBe(incident.id);
          drained++;
        }
      }
      expect(drained).toBe(expectedBacklog.length + 1); // snapshot位置以後の全差分（切断中3件＋定常の訂正1件）

      // --- 失権（認可版の増分＝役割変更と同じ状態）と期限切れcursor: 409 → snapshotの取り直しで回復 ---
      const memberAuthz = ((await env.DB.prepare("SELECT authz_version FROM users WHERE id = ?").bind(member.userId)
        .first<{ authz_version: number }>())!).authz_version;
      await env.DB.prepare("UPDATE users SET authz_version = authz_version + 1 WHERE id = ?").bind(member.userId).run();

      // 期限切れcursor（正しく暗号化された値。失権と別の409理由）
      const lastSeq = (await allEvents()).at(-1)!.sequence;
      const key = await cursorKey(env.BETTER_AUTH_SECRET);
      const expiredCursor = await encodeSyncCursor(key, {
        unitId: a.id, authzVersion: memberAuthz + 1, entityType: null, entityId: null,
        lastSequence: lastSeq, expiresAt: new Date(Date.parse(new Date().toISOString()) - CURSOR_TTL_MS).toISOString(),
      });

      const revoked = await Promise.all(
        [...termCursor, expiredCursor].map((c) => fx.client(member).request("GET", `/api/v1/events?cursor=${encodeURIComponent(c)}`)),
      );
      let resyncSnapshotCount = 0;
      for (const r of revoked) {
        expect(r.status).toBe(409);
        expect((await json(r)).error?.code).toBe("RESYNC_REQUIRED");
        // 回復: snapshot（API-70）を取り直して、そのcursorで接続し直す（docs/05 §8「409 RESYNC_REQUIREDでsnapshotを再取得」）
        const snap = await fx.client(member).request("GET", `/api/v1/incidents/${incident.id}`);
        expect(snap.status).toBe(200);
        const fresh = (await json(snap)).data! as { version: number; snapshotCursor: string };
        const reconnect = await fx.client(member).request("GET", `/api/v1/events?cursor=${encodeURIComponent(fresh.snapshotCursor)}`);
        expect(reconnect.status).toBe(200);
        const page = (await json(reconnect)).data! as unknown as EventPage;
        tally(page);
        expect(page.resyncRequired).toBe(false);
        resyncSnapshotCount++;
      }
      // 最後の窓に旧版はもう残っていない（再接続後は新着なし）。畳み込んだ版は変わらない
      expect(entityVersionAfter).toBeGreaterThanOrEqual(entityVersionBefore);

      // --- ブリーフの4断言 ---
      expect(entityVersionAfter).toBeGreaterThanOrEqual(entityVersionBefore);
      expect(visibleLeakCount).toBe(0);
      expect(updateLatencyP95Seconds).toBeLessThanOrEqual(5);
      expect(resyncSnapshotCount).toBeGreaterThan(0);
    },
    120_000, // 30端末のpoll実測（数周期）と切断/再接続を含むため、規定より長くする
  );
});
