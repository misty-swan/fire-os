import { env } from "cloudflare:workers";
import { applyD1Migrations } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
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

interface IncidentData {
  id: string; version: number; operationId: string; activityId: string | null;
  kind: string; occurredAt: string; summary: string; status: string;
  createdBy: string; createdAt: string; updatedAt: string;
}

describe("模擬・訓練・実出動記録と状態API (T040)", () => {
  it("incident_kind_is_separate_from_status_and_never_dispatches", async () => {
    const a = fx.units.a;
    const admin = a.people.admin; // 管理者（PER-04: 幹部・管理者は所属内で報告可）
    const officer = a.people.officer; // 幹部（活動の担当になる団員）
    const member = a.people.member; // 一般団員（PER-04は本人分のみ→出動の新規登録は不可。PER-01閲覧は可）
    const otherUnit = fx.units.b.people.admin; // 別分団（存在も明かさない）

    // --- 3種別の登録（API-22。docs/11「simulation/training/actual_recordの種別と状態を分離」。
    // 種別は画面の区分（模擬/訓練/実出動記録）、状態はrecordingで始まる別契約） ---
    const seeds = [
      { kind: "simulation", occurredAt: "2026-10-01T09:00:00.000Z", summary: "架空市中央公園での水防演習（模擬）。調整池の越流を想定" },
      { kind: "training", occurredAt: "2026-10-05T02:00:00.000Z", summary: "架橋地区での墜落警報訓練。参集から縮退まで" },
      { kind: "actual_record", occurredAt: "2026-10-10T22:30:00.000Z", summary: "台風18号に伴う水位監視の事後記録" },
    ];
    const incidents: IncidentData[] = [];
    const kinds: string[] = [];
    for (const s of seeds) {
      const res = await fx.client(admin).request("POST", "/api/v1/incidents", s, idem());
      expect(res.status).toBe(201);
      const data = (await json(res)).data as unknown as IncidentData;
      kinds.push(data.kind);
      incidents.push(data);
      expect(data.status).toBe("recording"); // 作成直後はすべてrecording（種別とは独立）
      expect(data.version).toBe(1);
    }
    // 検収（ブリーフのassertion）: 3種別が明示される
    expect(kinds).toEqual(["simulation", "training", "actual_record"]);

    // 出来事rootは出動として作られ、集計対象（docs/04「共通出来事。無効時countable=0」）
    for (const inc of incidents) {
      const op = (await fx.rows("operations", { id: inc.operationId }))[0]!;
      expect(op.kind).toBe("incident");
      expect(op.status).toBe("recording");
      expect(op.countable).toBe(1);
    }

    // 一般団員は出動の新規登録ができない（docs/10 PER-04「一般団員は本人分のみ」。新しい出動は本人分ではない）
    const memberCreate = await fx.client(member).request("POST", "/api/v1/incidents", seeds[0], idem());
    expect(memberCreate.status).toBe(403);

    // --- 状態遷移（docs/11 出動イベントrecording行: recording→active/closed/voided、active→closed、
    // closed→recording（訂正）、voidedは閲覧のみ） ---
    const sim = incidents[0]!;
    const training = incidents[1]!;
    const actual = incidents[2]!;
    const patch = (inc: IncidentData, body: Record<string, unknown>) =>
      fx.client(admin).request("PATCH", `/api/v1/incidents/${inc.id}`, { version: inc.version, ...body }, idem());

    // recording→active→closed（訓練の実施→終了）
    let res = await patch(sim, { status: "active", reason: "模擬を開始" });
    expect(res.status).toBe(200);
    sim.version = ((await json(res)).data as unknown as IncidentData).version;
    expect(sim.version).toBe(2);
    res = await patch(sim, { status: "closed", reason: "模擬を終了" });
    expect((await json(res)).data).toMatchObject({ status: "closed", version: 3 });
    sim.version = 3;

    // 許可外の辺は422（docs/11に無いclosed→active。訂正で戻れるのはrecordingだけ）
    res = await patch(sim, { status: "active", reason: "closedからの直接再開はしない" });
    expect(res.status).toBe(422);
    expect((await json(res)).error?.code).toBe("INVALID_TRANSITION");

    // closed→recordingは訂正として許可（docs/11「closed→recording（訂正）」）
    res = await patch(sim, { status: "recording", reason: "終了時刻の訂正のため記録を再開" });
    expect((await json(res)).data).toMatchObject({ status: "recording", version: 4 });
    sim.version = 4;

    // 種別の訂正は状態と独立にできる（docs/04:95「種別訂正…を保持」。理由は必須＝契約で検証済み）
    res = await patch(sim, { kind: "training", reason: "関係機関との共同訓練だったことが判明" });
    expect((await json(res)).data).toMatchObject({ kind: "training", status: "recording", version: 5 });
    sim.version = 5;

    // 概要だけの訂正も可能（summaryの訂正。理由は必須＝docs/05 API-69「reason」）
    res = await patch(sim, { summary: "架空市中央公園での水防演習（共同訓練）。調整池の越流を想定", reason: "共同訓練としての概要に訂正" });
    expect((await json(res)).data).toMatchObject({ version: 6 });
    sim.version = 6;

    // 旧版は409（docs/05 §2「旧版409」。いまの版は6なので旧版5を送る）
    res = await fx.client(admin).request("PATCH", `/api/v1/incidents/${sim.id}`, {
      version: 5, summary: "古い版からの変更", reason: "競合する変更",
    }, idem());
    expect(res.status).toBe(409);

    // voidedへの遷移は無効化理由と共に（docs/11「訂正/無効化理由」。契約でreason必須）
    res = await patch(sim, { status: "voided", reason: "誤って二重登録したため無効化" });
    expect((await json(res)).data).toMatchObject({ status: "voided", version: 7 });
    sim.version = 7;

    // voidedは終端: 追加の変更（種別・概要・状態のいずれ）も422（docs/11「voidedは閲覧のみ」）
    const voidedMutation = await fx.client(admin).request("PATCH", `/api/v1/incidents/${sim.id}`, {
      version: 7, kind: "actual_record", summary: "voidedからの変更", reason: "終端からの変更は不可",
    }, idem());
    // 検収（ブリーフのassertion）
    expect(voidedMutation.status).toBe(422);

    // 無効化で出来事rootは集計対象から外れる（docs/04「無効時countable=0」）
    const simOp = (await fx.rows("operations", { id: sim.operationId }))[0]!;
    expect(simOp.status).toBe("voided");
    expect(simOp.countable).toBe(0);

    // recording→closedの直接遷移も許可（docs/11「recording→active/closed/voided」）
    res = await patch(training, { status: "closed", reason: "訓練を終了" });
    expect((await json(res)).data).toMatchObject({ status: "closed", version: 2 });
    training.version = 2;
    // closedからactiveへは行けない（docs/11の辺に無い。訂正はrecording経由のみ）
    res = await patch(training, { status: "active", reason: "closedからの再開はしない" });
    expect(res.status).toBe(422);

    // --- 履歴（incident_events。docs/04:95「種別訂正/操作元を保持」。失敗した変更は残らない） ---
    const simEvents = (
      await env.DB.prepare("SELECT * FROM incident_events WHERE incident_id = ? ORDER BY rowid").bind(sim.id)
        .all<Record<string, unknown>>()
    ).results;
    expect(simEvents.map((e) => e.action)).toEqual([
      "create", // 作成（初期状態の記録）
      "status", // recording→active
      "status", // active→closed
      "status", // closed→recording（訂正。422で失敗したactive→recordingは残らない）
      "kind", // 種別訂正
      "summary", // 概要訂正
      "status", // recording→voided
    ]);
    const voidedRow = simEvents[simEvents.length - 1]!;
    expect(voidedRow.reason).toBe("誤って二重登録したため無効化"); // 無効化理由が残る
    expect(JSON.parse(String(voidedRow.before_json))).toMatchObject({ status: "recording", kind: "training" });
    expect(JSON.parse(String(voidedRow.after_json))).toMatchObject({ status: "voided", kind: "training" });

    // --- 詳細（API-70。docs/05「参集/活動/使用履歴/イベント」。T040時点の構造） ---
    const detailRes = await fx.client(admin).request("GET", `/api/v1/incidents/${actual.id}`);
    expect(detailRes.status).toBe(200);
    const detail = (await json(detailRes)).data! as {
      kind: string; status: string; activity: unknown; participants: unknown[]; resourceUsages: unknown[]; events: unknown[];
    };
    expect(detail.kind).toBe("actual_record");
    expect(detail.status).toBe("recording");
    expect(detail.activity).toBeNull(); // 未リンク
    expect(detail.participants).toEqual([]); // 参集の書込はT041（API-23）。構造だけ用意
    expect(detail.resourceUsages).toEqual([]); // 使用履歴はT042（API-57）。表ごと後続で作る
    expect(detail.events).toHaveLength(1); // 作成の初行
    // 団員にも閲覧できる（docs/10 PER-01「所属内かつ公開対象」）
    const memberDetail = await fx.client(member).request("GET", `/api/v1/incidents/${actual.id}`);
    expect(memberDetail.status).toBe(200);
    // 別分団は存在も明かさない（docs/05 §1「存在を明かさない対象不可」）
    const otherDetail = await fx.client(otherUnit).request("GET", `/api/v1/incidents/${actual.id}`);
    expect(otherDetail.status).toBe(404);

    // --- 一覧（API-21。同unitのみ。種別/状態/期間で絞る） ---
    // 検収（ブリーフのassertion）: 別scope（別分団）の一覧は空
    const otherList = await fx.client(otherUnit).request("GET", "/api/v1/incidents");
    expect(otherList.status).toBe(200);
    const outOfScopeIncidents = ((await json(otherList)).data ?? []) as unknown[];
    expect(outOfScopeIncidents).toEqual([]);

    const listRes = await fx.client(admin).request("GET", "/api/v1/incidents");
    const all = ((await json(listRes)).data ?? []) as IncidentData[];
    expect(all.map((i) => i.id)).toEqual([sim.id, training.id, actual.id]); // occurred_at昇順
    // 団員の一覧も同unitの全件（PER-01。機微scopeの絞り込みはPH4以降の通知設計に依存しない範囲）
    const memberListRes = await fx.client(member).request("GET", "/api/v1/incidents");
    const memberList = ((await json(memberListRes)).data ?? []) as IncidentData[];
    expect(memberList.map((i) => i.id)).toEqual([sim.id, training.id, actual.id]);

    const byKind = ((await json(await fx.client(admin).request("GET", "/api/v1/incidents?kind=actual_record"))).data ??
      []) as IncidentData[];
    expect(byKind.map((i) => i.id)).toEqual([actual.id]);
    const byStatus = ((await json(await fx.client(admin).request("GET", "/api/v1/incidents?status=closed"))).data ??
      []) as IncidentData[];
    expect(byStatus.map((i) => i.id)).toEqual([training.id]); // voidedも一覧で閲覧可能（docs/11「voidedは閲覧のみ」）
    const byStatusVoided = ((await json(await fx.client(admin).request("GET", "/api/v1/incidents?status=voided"))).data ??
      []) as IncidentData[];
    expect(byStatusVoided.map((i) => i.id)).toEqual([sim.id]);
    // 期間はfrom包含/to排他（docs/05 §1）
    const byRange = ((await json(
      await fx.client(admin).request("GET", "/api/v1/incidents?from=2026-10-05T00:00:00.000Z&to=2026-10-10T00:00:00.000Z"),
    )).data ?? []) as IncidentData[];
    expect(byRange.map((i) => i.id)).toEqual([training.id]);

    // --- 既存活動へのリンク（API-22のactivityId。docs/04 activity_id UNIQUE/FK。
    // operationの統合（付替え）はAPI-71＝T043で共通処理へ接続） ---
    const activityRes = await fx.client(admin).request("POST", "/api/v1/activities", {
      title: "秋季の水防訓練",
      kind: "訓練",
      plannedStartsAt: "2026-10-05T01:00:00.000Z",
      locationText: "架空市架橋地区",
      ownerMemberId: officer.memberId!,
      audienceMemberIds: [member.memberId!],
    }, idem());
    expect(activityRes.status).toBe(201);
    const activity = (await json(activityRes)).data! as { id: string; title: string };

    const linkedRes = await fx.client(admin).request("POST", "/api/v1/incidents", {
      kind: "training", occurredAt: "2026-10-05T02:00:00.000Z", summary: "秋季の水防訓練の記録", activityId: activity.id,
    }, idem());
    expect(linkedRes.status).toBe(201);
    const linked = (await json(linkedRes)).data! as unknown as IncidentData;
    expect(linked.activityId).toBe(activity.id);

    const linkedDetail = (await json(await fx.client(admin).request("GET", `/api/v1/incidents/${linked.id}`))).data! as {
      activity: { id: string; title: string } | null;
    };
    expect(linkedDetail.activity).toMatchObject({ id: activity.id, title: activity.title });

    // 既にリンク済みの活動への二重リンクは409（docs/04 activity_id UNIQUE。docs/05 §1「競合リンク」）
    const duplicateLink = await fx.client(admin).request("POST", "/api/v1/incidents", {
      kind: "simulation", occurredAt: "2026-10-06T02:00:00.000Z", summary: "同じ活動への二重リンク", activityId: activity.id,
    }, idem());
    expect(duplicateLink.status).toBe(409);
    expect((await json(duplicateLink)).error?.code).toBe("DUPLICATE");

    // 存在しない/別unitのactivityIdは404
    const unknownActivity = await fx.client(admin).request("POST", "/api/v1/incidents", {
      kind: "training", occurredAt: "2026-10-06T02:00:00.000Z", summary: "存在しない活動へのリンク",
      activityId: crypto.randomUUID(),
    }, idem());
    expect(unknownActivity.status).toBe(404);
    const otherUnitActivity = await fx.client(admin).request("POST", "/api/v1/incidents", {
      kind: "training", occurredAt: "2026-10-06T02:00:00.000Z", summary: "別分団の活動へのリンク",
      activityId: fx.units.b.scopeIn.entityId, // 別unitの対象ID（存在しない活動として404になる）
    }, idem());
    expect(otherUnitActivity.status).toBe(404);

    // --- 出動命令の自動発行はしない（docs/11「正式指令を発行しない」。D08）。
    // 上記の登録・状態変更で、自分たちの業務変更（incident.*/activity.created）以外の
    // outbox（domain_events）行が1件も増えていないことを確認する ---
    const allEvents = (
      await env.DB.prepare("SELECT entity_type, event_type FROM domain_events WHERE unit_id = ?").bind(a.id)
        .all<{ entity_type: string; event_type: string }>()
    ).results;
    const implicitNotificationCount = allEvents.filter(
      (e) => !((e.entity_type === "incident" && e.event_type.startsWith("incident.")) || e.event_type === "activity.created"),
    ).length;
    // 検収（ブリーフのassertion）
    expect(implicitNotificationCount).toBe(0);
  });
});
