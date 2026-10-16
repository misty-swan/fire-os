import { env } from "cloudflare:workers";
import { applyD1Migrations } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import { createFixture, type TestFixture } from "./helpers/fixture";
import { cursorKey, decodeSyncCursor, encodeSyncCursor, CURSOR_TTL_MS } from "../src/server/events/cursor";

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

/** domain_eventsの実行（SELECT …と同じ列の行）を読む（期待の組み立てと検算に使う。応答を写さない） */
const unitEvents = async (unitId: string) =>
  (await env.DB.prepare(
    "SELECT id, entity_type, entity_id, entity_version, event_type, payload_minimal, sequence, created_at " +
      "FROM domain_events WHERE unit_id = ? ORDER BY sequence",
  ).bind(unitId).all<Record<string, unknown>>()).results;

describe("認可済snapshot・イベント再開cursor・差分取得 (T072)", () => {
  it("snapshot_to_subscription_gap_never_loses_committed_event", async () => {
    const a = fx.units.a;
    const admin = a.people.admin; // 管理者（出動の登録・変更 PER-04、通知の下書き PER-12）
    const member = a.people.member; // 一般団員（同期の接続者。PER-13は全役割。通知は宛先でないので非可視）
    const otherUnitAdmin = fx.units.b.people.admin;

    // --- snapshot前の履歴を作る（活動1と出動1。どちらもmemberに可視な種別） ---
    const actRes = await fx.client(admin).request("POST", "/api/v1/activities", {
      title: "共同の排水ポンプ点検",
      kind: "活動",
      plannedStartsAt: "2099-11-01T01:00:00.000Z",
      locationText: "架空市河川敷",
      ownerMemberId: admin.memberId!,
      audienceMemberIds: [admin.memberId!, member.memberId!],
    }, idem());
    expect(actRes.status).toBe(201);
    const activityId = ((await json(actRes)).data! as { id: string }).id;

    const incRes = await fx.client(admin).request("POST", "/api/v1/incidents", {
      kind: "training", occurredAt: "2026-10-14T02:00:00.000Z", summary: "墜落警報訓練（架空）",
    }, idem());
    expect(incRes.status).toBe(201);
    const incident = (await json(incRes)).data! as { id: string; version: number };

    // recording→active（snapshot前の最後の変更）
    const toActive = await fx.client(admin).request("PATCH", `/api/v1/incidents/${incident.id}`, {
      version: incident.version, status: "active", reason: "訓練を開始",
    }, idem());
    expect(toActive.status).toBe(200);
    incident.version = ((await json(toActive)).data! as { version: number }).version;

    // --- snapshot（API-70）。親子とunits.event_sequenceを同一read batchで読み、snapshotCursorを受け取る ---
    const snapRes = await fx.client(member).request("GET", `/api/v1/incidents/${incident.id}`);
    expect(snapRes.status).toBe(200);
    const snapshot = (await json(snapRes)).data! as Record<string, unknown> & { snapshotCursor: string };
    // 契約3点の1つ: IncidentDetailにsnapshotCursorが載る（docs/05 §8）
    expect(typeof snapshot.snapshotCursor).toBe("string");
    expect(snapshot.snapshotCursor.length).toBeGreaterThan(0);
    expect(snapshot.version).toBe(incident.version);

    // snapshotCursorはunit/認可版/走査済sequence/期限を暗号化したopaque値。単位: unitの現在のevent_sequenceと
    // 同じbatchで読んだ位置を持つ（docs/05 §8）。実装の鍵導出とdecoderで中身を検算する（応答を写していない証拠にもなる）
    const key = await cursorKey(env.BETTER_AUTH_SECRET);
    const memberAuthz = ((await env.DB.prepare("SELECT authz_version FROM users WHERE id = ?").bind(member.userId)
      .first<{ authz_version: number }>())!).authz_version;
    const decoded = await decodeSyncCursor(key, snapshot.snapshotCursor);
    const seqAtSnapshot = ((await env.DB.prepare("SELECT event_sequence FROM units WHERE id = ?").bind(a.id)
      .first<{ event_sequence: number }>())!).event_sequence;
    // snapshotの瞬間の単調連番とcursor位置が一致すること＝親子と連番が同batchで確定している（snapshotSequenceAtomic）
    const snapshotSequenceAtomic =
      decoded !== null &&
      decoded.unitId === a.id &&
      decoded.authzVersion === memberAuthz &&
      decoded.lastSequence === seqAtSnapshot &&
      decoded.entityType === null && decoded.entityId === null &&
      Date.parse(decoded.expiresAt) > Date.now() &&
      Date.parse(decoded.expiresAt) <= Date.now() + CURSOR_TTL_MS + 1000;
    expect(snapshotSequenceAtomic).toBe(true);

    // --- snapshot後・接続前のcommit（通信断の隙間。再接続で回収できること） ---
    // 1) 出動をclosedへ（可視イベント1）
    const toClosed = await fx.client(admin).request("PATCH", `/api/v1/incidents/${incident.id}`, {
      version: incident.version, status: "closed", reason: "訓練を終了",
    }, idem());
    expect(toClosed.status).toBe(200);
    incident.version = ((await json(toClosed)).data! as { version: number }).version;
    // 2) 概要の訂正（可視イベント2）
    const summaryFix = await fx.client(admin).request("PATCH", `/api/v1/incidents/${incident.id}`, {
      version: incident.version, summary: "墜落警報訓練（架空・訂正）", reason: "概要の誤記を訂正",
    }, idem());
    expect(summaryFix.status).toBe(200);
    incident.version = ((await json(summaryFix)).data! as { version: number }).version;
    // 3) 不可視イベント: memberは宛先でない通知の下書き（admin宛）。イベントはmemberに非可視
    const notifRes = await fx.client(admin).request("POST", "/api/v1/notifications/drafts", {
      source: { type: "activity", id: activityId },
      body: "管理者宛の架空通知（団員には見えない）",
      audienceMemberIds: [admin.memberId!],
      channels: ["inapp"],
    }, idem());
    expect(notifRes.status).toBe(201);
    // 4) 別分団のcommit（他unit。絶対に流れない）
    const otherRes = await fx.client(otherUnitAdmin).request("POST", "/api/v1/incidents", {
      kind: "simulation", occurredAt: "2026-10-14T03:00:00.000Z", summary: "別分団の架空出動",
    }, idem());
    expect(otherRes.status).toBe(201);

    // 期待: snapshot以後にcommitされた可視イベント（出動の2件）だけが再生される
    const allA = await unitEvents(a.id);
    const committed = allA.filter((e) => Number(e.sequence) > seqAtSnapshot);
    const expectedCommittedIds = committed
      .filter((e) => e.entity_type === "incident" && e.entity_id === incident.id)
      .map((e) => String(e.id));
    expect(expectedCommittedIds.length).toBe(2);
    const hiddenSequences = committed
      .filter((e) => !(e.entity_type === "incident" && e.entity_id === incident.id))
      .map((e) => Number(e.sequence));
    // 同unitの非可視は通知の1件（別分団のイベントはそもそもこのunitの連番に現れない）
    expect(hiddenSequences.length).toBe(1);

    // --- 接続（API-80）。cursorの位置から現在のACLでfilterして差分を返す ---
    const connect = await fx.client(member).request("GET", `/api/v1/events?cursor=${encodeURIComponent(snapshot.snapshotCursor)}`);
    expect(connect.status).toBe(200);
    const page = (await json(connect)).data! as unknown as EventPage;
    const replayedVisibleIds = page.events.map((e) => e.id);
    // snapshotと接続の隙間にcommitされた可視イベントを取りこぼさない
    expect(replayedVisibleIds).toEqual(expectedCommittedIds);
    // 単調順（unit内のsequenceで整列）で、重複無し
    const replayedSequences = page.events.map((e) => e.sequence);
    expect([...replayedSequences].sort((x, y) => x - y)).toEqual(replayedSequences);
    expect(new Set(replayedSequences).size).toBe(replayedSequences.length);
    // 不可視イベント（通知・別分団）のsequence番号は露出しない（番号飛びは通信欠落と誤認させない。docs/05 §8）
    const hiddenSequenceNumbersExposed =
      page.events.some((e) => hiddenSequences.includes(e.sequence)) ||
      page.events.some((e) => e.entityType === "notification");
    expect(hiddenSequenceNumbersExposed).toBe(false);
    // ペイロードは最小値だけ（docs/04:166。本文を複製しない）
    for (const e of page.events) {
      expect(Object.keys(e).sort()).toEqual(
        ["id", "entityType", "entityId", "entityVersion", "eventType", "payload", "sequence", "createdAt"].sort(),
      );
      expect(JSON.stringify(e.payload)).not.toContain("訂正");
    }
    expect(page.resyncRequired).toBe(false);

    // --- 同じcursorの再送は同じ窓を返す（at-least-once。重複はentityVersion/sequenceでクライアントが畳む。
    // resumeCursorはAES-GCMのIVが毎回新しいため値は変わり得る。窓（events）の同値で確かめる） ---
    const repeat = await fx.client(member).request("GET", `/api/v1/events?cursor=${encodeURIComponent(snapshot.snapshotCursor)}`);
    const repeatPage = (await json(repeat)).data! as unknown as EventPage;
    expect(repeatPage.events).toEqual(page.events);

    // --- 続きの走査: resumeCursorからは新着なし（不可視の行で読み位置が進んでいることの確認） ---
    const again = await fx.client(member).request("GET", `/api/v1/events?cursor=${encodeURIComponent(page.resumeCursor)}`);
    expect(again.status).toBe(200);
    const nextPage = (await json(again)).data! as unknown as EventPage;
    expect(nextPage.events).toEqual([]);
    expect(nextPage.resyncRequired).toBe(false);
    // resumeCursorの位置は読み終えた最後の行（可視・非可視を問わない）に進んでいる
    const nextDecoded = await decodeSyncCursor(key, nextPage.resumeCursor);
    expect(nextDecoded?.lastSequence).toBe(seqAtSnapshot + committed.length);

    // --- 順序逆の再取得: 古いcursorを後から見ても同じ窓（決定的）。クライアントはentityVersionで重複検知する ---
    const stale = await fx.client(member).request("GET", `/api/v1/events?cursor=${encodeURIComponent(snapshot.snapshotCursor)}`);
    const stalePage = (await json(stale)).data! as unknown as EventPage;
    expect(stalePage.events).toEqual(page.events);

    // --- 新規commitがresumeCursorの続きから取れる（差分の継続） ---
    const reopen = await fx.client(admin).request("PATCH", `/api/v1/incidents/${incident.id}`, {
      version: incident.version, status: "recording", reason: "終了時刻の訂正のため記録を再開",
    }, idem());
    expect(reopen.status).toBe(200);
    incident.version = ((await json(reopen)).data! as { version: number }).version;
    const third = await fx.client(member).request("GET", `/api/v1/events?cursor=${encodeURIComponent(nextPage.resumeCursor)}`);
    const thirdPage = (await json(third)).data! as unknown as EventPage;
    expect(thirdPage.events.map((e) => e.id)).toEqual(
      (await unitEvents(a.id)).filter((e) => Number(e.sequence) > nextDecoded!.lastSequence)
        .filter((e) => e.entity_type === "incident").map((e) => String(e.id)),
    );

    // --- filterの採用: snapshotCursor（filter未結合）にentityTypeを付けて絞れる。位置はcursorが正（cursor勝ち） ---
    // （この時点で出動には3件のcommit（終了・訂正・再開）がある。afterSequence=999は無視）
    const filtered = await fx.client(member).request(
      "GET", `/api/v1/events?cursor=${encodeURIComponent(snapshot.snapshotCursor)}&afterSequence=999&entityType=incident&entityId=${incident.id}`,
    );
    expect(filtered.status).toBe(200);
    const filteredPage = (await json(filtered)).data! as unknown as EventPage;
    const expectedIncidentIds = (await unitEvents(a.id))
      .filter((e) => e.entity_type === "incident" && e.entity_id === incident.id && Number(e.sequence) > seqAtSnapshot)
      .map((e) => String(e.id));
    expect(expectedIncidentIds.length).toBe(3);
    expect(filteredPage.events.map((e) => e.id)).toEqual(expectedIncidentIds);
    expect(filteredPage.events.every((e) => e.entityType === "incident")).toBe(true);

    // --- 初回（cursor無し）: afterSequence 0から全可視イベント。通知は宛先でないmemberに現れない ---
    const fresh = await fx.client(member).request("GET", "/api/v1/events?afterSequence=0");
    expect(fresh.status).toBe(200);
    const freshPage = (await json(fresh)).data! as unknown as EventPage;
    expect(freshPage.events.every((e) => e.entityType !== "notification")).toBe(true);
    expect(freshPage.events.map((e) => e.sequence)).toEqual(
      (await unitEvents(a.id)).filter((e) => e.entity_type !== "notification").map((e) => Number(e.sequence)),
    );

    // --- 認可版の変更（役割変更等でusers.authz_versionが増えた状態。ここではDBで同じ状態を作る） ---
    await env.DB.prepare("UPDATE users SET authz_version = authz_version + 1 WHERE id = ?").bind(member.userId).run();
    const authzChanged = await fx.client(member).request("GET", `/api/v1/events?cursor=${encodeURIComponent(page.resumeCursor)}`);
    expect(authzChanged.status).toBe(409);
    expect((await json(authzChanged)).error?.code).toBe("RESYNC_REQUIRED");

    // --- 保持期間外のcursor（期限切れ。正しく暗号化された値） ---
    const nowIso = new Date().toISOString();
    const expiredCursor = await encodeSyncCursor(key, {
      unitId: a.id, authzVersion: memberAuthz + 1, entityType: null, entityId: null,
      lastSequence: seqAtSnapshot, expiresAt: new Date(Date.parse(nowIso) - CURSOR_TTL_MS).toISOString(),
    });
    const expired = await fx.client(member).request("GET", `/api/v1/events?cursor=${encodeURIComponent(expiredCursor)}`);
    expect(expired.status).toBe(409);
    expect((await json(expired)).error?.code).toBe("RESYNC_REQUIRED");

    // --- 改変cursor・別unitのcursorも同じ409（存在や中身を明かさない） ---
    const tampered = snapshot.snapshotCursor.slice(0, -3) + (snapshot.snapshotCursor.endsWith("aaa") ? "bbb" : "aaa");
    const tamperedRes = await fx.client(member).request("GET", `/api/v1/events?cursor=${encodeURIComponent(tampered)}`);
    expect(tamperedRes.status).toBe(409);
    expect((await json(tamperedRes)).error?.code).toBe("RESYNC_REQUIRED");

    const otherUnitCursor = await encodeSyncCursor(key, {
      unitId: fx.units.b.id, authzVersion: 1, entityType: null, entityId: null,
      lastSequence: 1, expiresAt: new Date(Date.parse(nowIso) + CURSOR_TTL_MS).toISOString(),
    });
    const crossUnit = await fx.client(member).request("GET", `/api/v1/events?cursor=${encodeURIComponent(otherUnitCursor)}`);
    expect(crossUnit.status).toBe(409);
    expect((await json(crossUnit)).error?.code).toBe("RESYNC_REQUIRED");

    // --- cursorと矛盾するfilterの指定（結合済みfilterと違う対象）は409（新しいstreamはsnapshotから） ---
    const boundCursor = await encodeSyncCursor(key, {
      unitId: a.id, authzVersion: memberAuthz + 1, entityType: "facility", entityId: null,
      lastSequence: seqAtSnapshot, expiresAt: new Date(Date.parse(nowIso) + CURSOR_TTL_MS).toISOString(),
    });
    const filterChanged = await fx.client(member).request(
      "GET", `/api/v1/events?cursor=${encodeURIComponent(boundCursor)}&entityType=incident`,
    );
    expect(filterChanged.status).toBe(409);
    expect((await json(filterChanged)).error?.code).toBe("RESYNC_REQUIRED");

    // --- 位置が先すぎるcursor（ unitの連番より先。DB復元など）は200でresyncRequiredを伝える ---
    await env.DB.prepare("UPDATE units SET event_sequence = 0 WHERE id = ?").bind(a.id).run();
    const aheadCursor = await encodeSyncCursor(key, {
      unitId: a.id, authzVersion: memberAuthz + 1, entityType: null, entityId: null,
      lastSequence: 999, expiresAt: new Date(Date.parse(nowIso) + CURSOR_TTL_MS).toISOString(),
    });
    const ahead = await fx.client(member).request("GET", `/api/v1/events?cursor=${encodeURIComponent(aheadCursor)}`);
    expect(ahead.status).toBe(200);
    const aheadPage = (await json(ahead)).data! as unknown as EventPage;
    expect(aheadPage.events).toEqual([]);
    expect(aheadPage.resyncRequired).toBe(true);
    // 元に戻す（この試験の後片付け。連番はこのunitの他の試験にも使われる）
    await env.DB.prepare("UPDATE units SET event_sequence = ? WHERE id = ?").bind(seqAtSnapshot + committed.length + 1, a.id).run();

    // --- 別分団の接続者に第1分団のイベントは現れない ---
    const otherUnitFresh = await fx.client(fx.units.b.people.member).request("GET", "/api/v1/events?afterSequence=0");
    expect(otherUnitFresh.status).toBe(200);
    const otherPage = (await json(otherUnitFresh)).data! as unknown as EventPage;
    expect(otherPage.events.length).toBeGreaterThan(0);
    expect(otherPage.events.every((e) => e.entityType === "incident" || e.entityType === "activity")).toBe(true);
  });
});
