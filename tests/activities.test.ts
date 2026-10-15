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
  (await r.json()) as { data?: Record<string, unknown>; error?: { code: string; details?: { field: string; reason: string }[] } };

describe("活動（予定）の公開・変更・中止 (T035)", () => {
  it("activity_cancellation_preserves_answers_and_audience", async () => {
    const a = fx.units.a;
    const admin = a.people.admin; // 管理者（分団長）。PER-03は所属内
    const officer = a.people.officer; // 幹部（予定の担当）
    const member = a.people.member; // 一般団員（対象者）
    const operator = a.people.operator; // 担当者（scopeは施設のみ。予定は担当外）

    // --- 対象者付き予定の作成（API-06。docs/11 開催はdraftで始まる） ---
    const audienceIds = [officer.memberId!, member.memberId!, operator.memberId!];
    const createRes = await fx.client(admin).request("POST", "/api/v1/activities", {
      title: "秋季の共同訓練",
      kind: "訓練",
      plannedStartsAt: "2026-10-20T01:00:00.000Z",
      locationText: "架空市中央公園",
      ownerMemberId: officer.memberId!,
      audienceMemberIds: audienceIds,
    }, idem());
    expect(createRes.status).toBe(201);
    const created = (await json(createRes)).data! as {
      id: string; version: number; operationId: string; status: string; ownerMemberId: string;
    };
    expect(created.status).toBe("draft");
    expect(created.version).toBe(1);
    expect(created.ownerMemberId).toBe(officer.memberId!);

    // 出来事root（operations）が予定と同じbatchで作られ、集計対象（countable=1。docs/04 §3.2）
    const opRow = (await fx.rows("operations", { id: created.operationId }))[0]!;
    expect(opRow.kind).toBe("activity");
    expect(opRow.status).toBe("draft");
    expect(opRow.countable).toBe(1);

    // 対象者はsnapshot（activity_audience）で固定される。名簿を変えても母数が変わらないことを後段で確認する
    const audienceSnapshot = await fx.rows("activity_audience", { activity_id: created.id });
    expect(audienceSnapshot.map((r) => r.member_id).sort()).toEqual([...audienceIds].sort());

    // 詳細（API-07）。対象snapshotと現在実績（実績APIはT037のため現時点でnull）を含む
    const detail = (await json(await fx.client(admin).request("GET", `/api/v1/activities/${created.id}`))).data! as {
      status: string; result: unknown; audience: string[];
    };
    expect(detail.status).toBe("draft");
    expect(detail.result).toBeNull();
    expect([...detail.audience].sort()).toEqual([...audienceIds].sort());

    // --- 公開: draft→scheduled（docs/11の許可辺。公開済の変更は理由が要る） ---
    const publish = await fx.client(admin).request("PATCH", `/api/v1/activities/${created.id}`, {
      version: 1, status: "scheduled", reason: "対象を確定して公開",
    }, idem());
    expect(publish.status).toBe(200);
    expect((await json(publish)).data).toMatchObject({ status: "scheduled", version: 2 });

    // 公開済みの内容変更に理由が無い場合は400（docs/05 API-39「公開済の変更理由」）
    const noReason = await fx.client(admin).request("PATCH", `/api/v1/activities/${created.id}`, {
      version: 2, plannedStartsAt: "2026-10-21T01:00:00.000Z",
    }, idem());
    expect(noReason.status).toBe(400);

    // --- 日時変更（公開後も理由付きで変更できる。docs/11「日時整合」） ---
    const reschedule = await fx.client(admin).request("PATCH", `/api/v1/activities/${created.id}`, {
      version: 2, plannedStartsAt: "2026-10-21T01:00:00.000Z", reason: "台風接近のため1日延期",
    }, idem());
    expect(reschedule.status).toBe(200);
    expect((await json(reschedule)).data).toMatchObject({ plannedStartsAt: "2026-10-21T01:00:00.000Z", version: 3 });

    // 逆時刻（終了<開始）は400。PATCHで片方だけ送っても「現在値＋入力」で検査する
    const invalidTime = await fx.client(admin).request("PATCH", `/api/v1/activities/${created.id}`, {
      version: 3, plannedEndsAt: "2026-10-20T00:00:00.000Z", reason: "誤入力",
    }, idem());
    expect(invalidTime.status).toBe(400);

    // --- 同時編集（旧版）は409 VERSION_CONFLICT（docs/05 §2「旧版409」） ---
    const staleEdit = await fx.client(admin).request("PATCH", `/api/v1/activities/${created.id}`, {
      version: 2, title: "古い版からの変更", reason: "競合する変更",
    }, idem());
    expect(staleEdit.status).toBe(409);

    // --- 担当外は403/404（docs/10 PER-03。幹部・管理者は所属内、担当はscope対象） ---
    const outOfScope = await fx.client(operator).request("PATCH", `/api/v1/activities/${created.id}`, {
      version: 3, title: "担当外から変更", reason: "権限が無い変更",
    }, idem());
    expect(outOfScope.status).toBe(403);
    const otherUnit = await fx.client(fx.units.b.people.admin).request("PATCH", `/api/v1/activities/${created.id}`, {
      version: 3, title: "別分団から変更", reason: "存在も明かさない",
    }, idem());
    expect(otherUnit.status).toBe(404);

    // --- 出欠行を作る。API-08（出欠）は次タスクT036で実装のため、ここではDBへ直接INSERTし、
    // 「中止で既存出欠を削除しない」(docs/11 §3)を検査する ---
    const now = new Date().toISOString();
    for (const m of [officer.memberId!, member.memberId!]) {
      await env.DB.prepare(
        "INSERT INTO activity_attendance (id, unit_id, activity_id, member_id, response, responded_at, created_at, updated_at, created_by, actor_kind) " +
          "VALUES (?, ?, ?, ?, 'attending', ?, ?, ?, ?, 'human')",
      ).bind(crypto.randomUUID(), a.id, created.id, m, now, now, now, admin.userId).run();
    }
    const attendanceBefore = (await fx.rows("activity_attendance", { activity_id: created.id })).length;
    expect(attendanceBefore).toBe(2);

    // 名簿変更（団員の休団）をしても対象snapshotは変わらない（docs/04「未回答母数は現在の名簿全件ではなく対象snapshot」）
    await env.DB.prepare("UPDATE members SET status = 'paused' WHERE id = ?").bind(member.memberId).run();

    // --- 中止: scheduled→cancelled（API-40。出欠は保持、operationはcountable=0） ---
    const cancel = await fx.client(admin).request("POST", `/api/v1/activities/${created.id}/cancellation`, {
      version: 3, reason: "台風のため中止",
    }, idem());
    expect(cancel.status).toBe(200);
    expect((await json(cancel)).data).toMatchObject({ status: "cancelled", version: 4 });

    // --- 検収（T035ブリーフのassertion） ---
    const audienceAfter = await fx.rows("activity_audience", { activity_id: created.id });
    const attendanceDeletedCount =
      attendanceBefore - (await fx.rows("activity_attendance", { activity_id: created.id })).length;
    expect(audienceAfter).toEqual(audienceSnapshot);
    expect(attendanceDeletedCount).toBe(0);
    expect(invalidTime.status).toBe(400);
    expect(staleEdit.status).toBe(409);

    // 出来事rootは中止で無効化（docs/11 §3「集計は無効なoperationを除く」）
    const opAfter = (await fx.rows("operations", { id: created.operationId }))[0]!;
    expect(opAfter.status).toBe("cancelled");
    expect(opAfter.countable).toBe(0);

    // 履歴（activity_events）: 作成・公開・日時変更・中止が追記型で残る。失敗した変更（400/409）は残らない
    const events = (
      await env.DB.prepare("SELECT * FROM activity_events WHERE activity_id = ? ORDER BY rowid").bind(created.id).all<Record<string, unknown>>()
    ).results;
    expect(events.map((e) => `${e.previous_status}->${e.next_status}`)).toEqual([
      "draft->draft", // 作成（初期状態の記録）
      "draft->scheduled", // 公開
      "scheduled->scheduled", // 公開済の日時変更（同じ状態どうし＋理由）
      "scheduled->cancelled", // 中止
    ]);
    expect(events[events.length - 1]!.reason).toBe("台風のため中止");

    // cancelledは終端（docs/11 開催）。訂正再開・再公開は不可
    const afterCancel = await fx.client(admin).request("PATCH", `/api/v1/activities/${created.id}`, {
      version: 4, status: "in_progress", reason: "中止からの再開はしない",
    }, idem());
    expect(afterCancel.status).toBe(422);

    // 出欠の可視性（docs/05 §1「Detailは親＋認可された子Page」）: PER-03の保持者は全行、本人は自分の行だけ
    const officerDetail = (await json(await fx.client(officer).request("GET", `/api/v1/activities/${created.id}`))).data! as {
      status: string; attendance: { memberId: string }[]; audience: string[];
    };
    expect(officerDetail.status).toBe("cancelled");
    expect(officerDetail.attendance).toHaveLength(2);
    expect([...officerDetail.audience].sort()).toEqual([...audienceIds].sort());
    // 休団にした団員を元に戻してから、本人分の可視行を確認する
    await env.DB.prepare("UPDATE members SET status = 'active' WHERE id = ?").bind(member.memberId).run();
    const memberDetail = (await json(await fx.client(member).request("GET", `/api/v1/activities/${created.id}`))).data! as {
      attendance: { memberId: string }[];
    };
    expect(memberDetail.attendance.map((r) => r.memberId)).toEqual([member.memberId]);
  });

  it("same_key_resend_returns_saved_response_for_update_and_cancel (docs/05 §2)", async () => {
    // docs/05 §2「同じキー/本文の再送は元HTTP status/dataを返し」: 応答が届かなかった操作のリトライが
    // 現在の状態を前提とした業務エラー（no_changes 400・cancelled→cancelled 422）になってはいけない
    const a = fx.units.a;
    const admin = a.people.admin;

    const createRes = await fx.client(admin).request("POST", "/api/v1/activities", {
      title: "再送試験用の予定",
      kind: "訓練",
      plannedStartsAt: "2026-11-10T01:00:00.000Z",
      locationText: "架空市第三体育館",
      ownerMemberId: admin.memberId!,
      audienceMemberIds: [admin.memberId!],
    }, idem());
    expect(createRes.status).toBe(201);
    const created = (await json(createRes)).data! as { id: string; version: number };

    // --- API-39: draft→scheduled。draftからの公開は理由が要らない（docs/11） ---
    const publishKey = crypto.randomUUID();
    const publishBody = { version: 1, status: "scheduled" };
    const publishRes = await fx.client(admin).request("PATCH", `/api/v1/activities/${created.id}`, publishBody, { "idempotency-key": publishKey });
    expect(publishRes.status).toBe(200);
    const published = (await json(publishRes)).data! as Record<string, unknown>;

    // 同キー再送: 適用済みで「変更点なし」になっても400ではなく元の応答
    const publishReplay = await fx.client(admin).request("PATCH", `/api/v1/activities/${created.id}`, publishBody, { "idempotency-key": publishKey });
    expect(publishReplay.status).toBe(200);
    expect((await json(publishReplay)).data).toEqual(published);
    // 再送で状態・版・イベントは動かない（更新のイベントは初回の1件だけ。再送で増えない）
    const afterReplay = (await fx.rows("activities", { id: created.id }))[0]!;
    expect(afterReplay.status).toBe("scheduled");
    expect(afterReplay.version).toBe(2);
    expect(await fx.rows("domain_events", { entity_type: "activity", entity_id: created.id, event_type: "activity.updated" })).toHaveLength(1);

    // --- API-40: 中止。同キー再送はcancelled→cancelledの422ではなく元の応答 ---
    const cancelKey = crypto.randomUUID();
    const cancelBody = { version: 2, reason: "台風接近のため中止" };
    const cancelRes = await fx.client(admin).request("POST", `/api/v1/activities/${created.id}/cancellation`, cancelBody, { "idempotency-key": cancelKey });
    expect(cancelRes.status).toBe(200);
    const cancelled = (await json(cancelRes)).data! as Record<string, unknown>;

    const cancelReplay = await fx.client(admin).request("POST", `/api/v1/activities/${created.id}/cancellation`, cancelBody, { "idempotency-key": cancelKey });
    expect(cancelReplay.status).toBe(200);
    expect((await json(cancelReplay)).data).toEqual(cancelled);
    const afterCancelReplay = (await fx.rows("activities", { id: created.id }))[0]!;
    expect(afterCancelReplay.status).toBe("cancelled");
    expect(afterCancelReplay.version).toBe(3);
    expect(await fx.rows("domain_events", { entity_type: "activity", entity_id: created.id, event_type: "activity.cancelled" })).toHaveLength(1);

    // 同キー別本文は409（docs/05 §2。保存済み応答の本文一致検査）
    const mismatch = await fx.client(admin).request("POST", `/api/v1/activities/${created.id}/cancellation`, {
      version: 2, reason: "別の理由での再送",
    }, { "idempotency-key": cancelKey });
    expect(mismatch.status).toBe(409);
    expect((await json(mismatch)).error?.code).toBe("IDEMPOTENCY_MISMATCH");
  });
});
