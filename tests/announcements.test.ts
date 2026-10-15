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
  (await r.json()) as { data?: unknown; error?: { code: string; details?: { field: string; reason: string }[] } };

describe("お知らせの公開対象・版・本人既読 (T045)", () => {
  it("read_receipt_is_bound_to_member_and_revision", async () => {
    const a = fx.units.a;
    const admin = a.people.admin; // 分団長（PER-03は所属内。お知らせの対象には入れない）
    const officer = a.people.officer; // 幹部（PER-03。対象外）
    const member = a.people.member; // 一般団員（対象者）
    const operator = a.people.operator; // 担当者（scopeは施設のみ＝お知らせの管理権なし。対象者）

    // --- 対象限定のdraft作成（API-25。対象はmember/operatorだけ。作成者・幹部は対象外） ---
    const createRes = await fx.client(admin).request("POST", "/api/v1/announcements", {
      title: "秋季訓練の持ち物について",
      body: "架空市中央公園に集合。長靴と軍手を持参すること。",
      audienceMemberIds: [member.memberId!, operator.memberId!],
    }, idem());
    expect(createRes.status).toBe(201);
    const created = (await json(createRes)).data! as {
      id: string; version: number; title: string; revisionNo: number; status: string;
      publishedAt: string | null; audienceMemberIds: string[];
    };
    expect(created.status).toBe("draft");
    expect(created.version).toBe(1);
    expect(created.revisionNo).toBe(1);
    expect(created.publishedAt).toBeNull();
    expect([...created.audienceMemberIds].sort()).toEqual([member.memberId!, operator.memberId!].sort());

    // 版と対象snapshot（docs/04:133/134）。対象は明示snapshotで固定する（名簿変更で対象を変えない）
    const revisions = await fx.rows("announcement_revisions", { announcement_id: created.id });
    expect(revisions).toHaveLength(1);
    expect(revisions[0]!.revision_no).toBe(1);
    expect(JSON.parse(String(revisions[0]!.audience_snapshot)).sort())
      .toEqual([member.memberId!, operator.memberId!].sort());
    const audienceRows = await fx.rows("announcement_audience", { announcement_id: created.id });
    expect(audienceRows.map((r) => r.member_id).sort()).toEqual([member.memberId!, operator.memberId!].sort());

    // 将来の公開日時(publishAt)付きでも作成できる。公開への遷移は自動でなくAPI-72の明示操作（docs/16 T045）
    const futureAt = "2026-12-01T00:00:00.000Z";
    const scheduled = await fx.client(admin).request("POST", "/api/v1/announcements", {
      title: "防災広報の掲載予定",
      body: "架空市の防災週間に合わせて掲載する。",
      audienceMemberIds: [member.memberId!],
      publishAt: futureAt,
    }, idem());
    expect(scheduled.status).toBe(201);
    expect((await json(scheduled)).data).toMatchObject({ status: "draft", publishedAt: futureAt, revisionNo: 1 });

    // draftはPER-03保持者だけ。対象者の一覧にdraftは現れない（docs/10 PER-03）
    const memberDraftList = (await json(await fx.client(member).request("GET", "/api/v1/announcements"))).data! as { id: string }[];
    expect(memberDraftList.some((row) => row.id === created.id)).toBe(false);
    // 公開前の既読は拒否（対象者でも存在を明かさない404）
    const draftRead = await fx.client(member).request("PUT", `/api/v1/announcements/${created.id}/read`, { revisionNo: 1 }, idem());
    expect(draftRead.status).toBe(404);

    // --- 公開（API-72。draft→published。公開は明示操作） ---
    const publishRes = await fx.client(admin).request("PATCH", `/api/v1/announcements/${created.id}`, {
      version: 1, status: "published",
    }, idem());
    expect(publishRes.status).toBe(200);
    const published = (await json(publishRes)).data! as {
      version: number; revisionNo: number; status: string; publishedAt: string;
    };
    expect(published.status).toBe("published");
    expect(published.version).toBe(2);
    expect(published.revisionNo).toBe(1); // 公開は内容変更でないため版はそのまま
    expect(typeof published.publishedAt).toBe("string"); // 指定が無いので公開操作時刻

    // --- 対象者の本人既読（API-66。版付き。docs/04:135「三つ組UNIQUE、本人のみ」） ---
    const memberReadRes = await fx.client(member).request("PUT", `/api/v1/announcements/${created.id}/read`, { revisionNo: 1 }, idem());
    expect(memberReadRes.status).toBe(200);
    const receipt = (await json(memberReadRes)).data! as { readAt: string; revisionNo: number };
    expect(receipt.revisionNo).toBe(1);
    // もう一度の既読は同じ領収書（初回readAtを保持し行を増やさない）
    const rereadRes = await fx.client(member).request("PUT", `/api/v1/announcements/${created.id}/read`, { revisionNo: 1 }, idem());
    expect(rereadRes.status).toBe(200);
    expect(((await json(rereadRes)).data! as { readAt: string }).readAt).toBe(receipt.readAt);
    expect(await fx.rows("announcement_reads", { announcement_id: created.id })).toHaveLength(1);

    // 対象者のもう一人（operator）も既読できる
    const operatorReadRes = await fx.client(operator).request("PUT", `/api/v1/announcements/${created.id}/read`, { revisionNo: 1 }, idem());
    expect(operatorReadRes.status).toBe(200);
    expect(await fx.rows("announcement_reads", { announcement_id: created.id })).toHaveLength(2);

    // --- 代理readは403（PER-03保持者でも対象者でなければ既読は作れない。既読は本人のみ） ---
    const proxyRead = await fx.client(officer).request("PUT", `/api/v1/announcements/${created.id}/read`, { revisionNo: 1 }, idem());
    expect(proxyRead.status).toBe(403);
    // 別分団は404（存在を明かさない）
    const crossUnitRead = await fx.client(fx.units.b.people.admin).request("PUT", `/api/v1/announcements/${created.id}/read`, { revisionNo: 1 }, idem());
    expect(crossUnitRead.status).toBe(404);

    // --- 改版と対象変更（API-72。title/body/対象の変更は新revision。docs/11「編集で新revision」） ---
    const reviseRes = await fx.client(admin).request("PATCH", `/api/v1/announcements/${created.id}`, {
      version: 2,
      title: "秋季訓練の持ち物について（訂正）",
      body: "集合時刻を変更。長靴と軍手を持参すること。",
      audienceMemberIds: [member.memberId!], // operatorを対象から外す
    }, idem());
    expect(reviseRes.status).toBe(200);
    const revised = (await json(reviseRes)).data! as {
      version: number; revisionNo: number; status: string; publishedAt: string; audienceMemberIds: string[];
    };
    expect(revised.revisionNo).toBe(2);
    expect(revised.version).toBe(3);
    expect(revised.status).toBe("published"); // 改版で公開が外れない（published→archived以外の遷移は無い）
    expect(revised.publishedAt).toBe(published.publishedAt); // 公開日時は公開操作時に確定（改版で変わらない）
    expect(revised.audienceMemberIds).toEqual([member.memberId!]);

    // 旧版は不変（変更原本保持。docs/04:133「親/版UNIQUE、変更原本保持」）
    const revRows = (
      await env.DB.prepare(
        "SELECT revision_no, title, body, audience_snapshot FROM announcement_revisions WHERE announcement_id = ? ORDER BY revision_no",
      ).bind(created.id).all<Record<string, unknown>>()
    ).results;
    expect(revRows.map((r) => r.revision_no)).toEqual([1, 2]);
    expect(revRows[0]!.title).toBe("秋季訓練の持ち物について");
    expect(JSON.parse(String(revRows[0]!.audience_snapshot))).toContain(operator.memberId);
    expect(JSON.parse(String(revRows[1]!.audience_snapshot))).toEqual([member.memberId]);

    // 対象は新revisionのsnapshotへ全置換（docs/04:134。operatorの行は消える）
    const audienceAfter = await fx.rows("announcement_audience", { announcement_id: created.id });
    expect(audienceAfter.map((r) => r.member_id)).toEqual([member.memberId]);
    // 既読は版に束縛するので対象変更でも消さない（docs/11「既読は版に束縛」）
    expect(await fx.rows("announcement_reads", { announcement_id: created.id })).toHaveLength(2);

    // --- 対象外は一覧・件数に現れない（publishedは対象者だけ。完了条件） ---
    const operatorList = (await json(await fx.client(operator).request("GET", "/api/v1/announcements"))).data! as { id: string }[];
    const outsideAudienceRows = operatorList.filter((row) => row.id === created.id);
    expect(outsideAudienceRows).toEqual([]);
    // 対象外になったoperatorの既読は404（存在を明かさない）
    const operatorReadAfter = await fx.client(operator).request("PUT", `/api/v1/announcements/${created.id}/read`, { revisionNo: 2 }, idem());
    expect(operatorReadAfter.status).toBe(404);

    // 対象者には現行版が見える（タイトル・版が上がっている）
    const memberList = (await json(await fx.client(member).request("GET", "/api/v1/announcements"))).data! as {
      id: string; revisionNo: number; title: string; status: string;
    }[];
    const visible = memberList.filter((row) => row.id === created.id);
    expect(visible).toHaveLength(1);
    expect(visible[0]!.revisionNo).toBe(2);
    expect(visible[0]!.title).toBe("秋季訓練の持ち物について（訂正）");

    // --- 旧版の既読は新版の未読（既読は版に束縛。docs/11 お知らせ行） ---
    const oldReadRes = await fx.client(member).request("PUT", `/api/v1/announcements/${created.id}/read`, { revisionNo: 1 }, idem());
    expect(oldReadRes.status).toBe(404);
    const newRevisionRead = await env.DB.prepare(
      "SELECT read_at FROM announcement_reads WHERE announcement_id = ? AND revision_no = 2 AND member_id = ?",
    ).bind(created.id, member.memberId).first<{ read_at: string }>();
    const newRevisionReadAt = newRevisionRead?.read_at ?? null;
    expect(newRevisionReadAt).toBeNull();

    // 新版は改めて既読を取る（旧版の既読は流用しない）
    const newReadRes = await fx.client(member).request("PUT", `/api/v1/announcements/${created.id}/read`, { revisionNo: 2 }, idem());
    expect(newReadRes.status).toBe(200);
    expect(((await json(newReadRes)).data! as { revisionNo: number }).revisionNo).toBe(2);
    expect(await fx.rows("announcement_reads", { announcement_id: created.id })).toHaveLength(3);

    // --- 権限: PER-03無しの対象者は変更できない（docs/10 PER-03） ---
    const memberPatch = await fx.client(member).request("PATCH", `/api/v1/announcements/${created.id}`, {
      version: 3, status: "archived",
    }, idem());
    expect(memberPatch.status).toBe(403);

    // --- archivedは終端（docs/11 お知らせ。draft→published/archived、published→archived） ---
    const archiveRes = await fx.client(admin).request("PATCH", `/api/v1/announcements/${created.id}`, {
      version: 3, status: "archived",
    }, idem());
    expect(archiveRes.status).toBe(200);
    expect((await json(archiveRes)).data).toMatchObject({ status: "archived", version: 4 });
    const republishRes = await fx.client(admin).request("PATCH", `/api/v1/announcements/${created.id}`, {
      version: 4, status: "published",
    }, idem());
    expect(republishRes.status).toBe(422);
    // archivedへの既読は拒否（対象者でも404）
    const archivedRead = await fx.client(member).request("PUT", `/api/v1/announcements/${created.id}/read`, { revisionNo: 2 }, idem());
    expect(archivedRead.status).toBe(404);

    // --- 作成/公開/改版/対象変更が通知を自動起動しない（通知はPH4。outbox/監査/ジョブに通知起因の行を作らない） ---
    const notificationEvents = (
      await env.DB.prepare(
        "SELECT count(*) AS n FROM domain_events WHERE entity_type = 'notification' OR event_type LIKE 'notification%'",
      ).first<{ n: number }>()
    )!.n;
    const notificationJobs = (
      await env.DB.prepare("SELECT count(*) AS n FROM jobs WHERE source_type = 'notification' OR kind LIKE '%notification%'")
        .first<{ n: number }>()
    )!.n;
    const implicitBroadcastCount = notificationEvents + notificationJobs;
    expect(implicitBroadcastCount).toBe(0);

    // お知らせ操作のoutboxは業務操作ごとに1件（一mutation一event）。再送・失敗・既読の再送は増やさない
    const eventTypes = (
      await env.DB.prepare("SELECT event_type FROM domain_events WHERE entity_id = ? ORDER BY rowid").bind(created.id).all<Record<string, unknown>>()
    ).results.map((r) => String(r.event_type));
    expect(eventTypes).toEqual([
      "announcement.created", // 作成（draft）
      "announcement.updated", // 公開（draft→published）
      "announcement.read", // member rev1
      "announcement.read", // operator rev1
      "announcement.updated", // 改版＋対象変更（revision 2）
      "announcement.read", // member rev2
      "announcement.updated", // archived
    ]);
  });

  it("announcement_response_carries_author_my_read_state_and_linked_attachments (T046)", async () => {
    // 画面（T046）が作成者・本人の現行版既読・リンク中の添付を表示するための応答拡張。
    // readAtは要求した本人の現行版だけ（旧版の既読は含めない＝改版で未読に戻る。docs/11「既読は版に束縛」）
    const a = fx.units.a;
    const admin = a.people.admin; // 作成者（PER-03。対象外）
    const member = a.people.member; // 対象者

    const createRes = await fx.client(admin).request("POST", "/api/v1/announcements", {
      title: "資機材の点検当日の持ち物",
      body: "軍手と筆記用具を持って集合してください。",
      audienceMemberIds: [member.memberId!, admin.memberId!], // 作成者も対象に含める（公開後に自分でも編集できる経路）
    }, idem());
    expect(createRes.status).toBe(201);
    // 応答（API-25）: 作成者のmemberId。本人既読は未読（null）。添付は空配列（Responseのbodyは一度しか読めない）
    const created = (await json(createRes)).data! as {
      id: string; createdByMemberId: string | null; readAt: string | null; attachments: unknown[];
    };
    expect(created.createdByMemberId).toBe(admin.memberId!);
    expect(created.readAt).toBeNull();
    expect(created.attachments).toEqual([]);
    const id = created.id;

    // 一覧（API-24）も同じ形。本人ごとに既読は変わる
    const listFor = async (client: ReturnType<typeof fx.client>) =>
      ((await json(await client.request("GET", "/api/v1/announcements"))).data! as {
        id: string; createdByMemberId: string | null; readAt: string | null; attachments: unknown[];
      }[]).find((row) => row.id === id)!;
    const adminBefore = await listFor(fx.client(admin));
    expect(adminBefore.createdByMemberId).toBe(admin.memberId!);
    expect(adminBefore.readAt).toBeNull();

    // 公開して対象者が既読を取ると、その本人の応答だけreadAtが入る（作成者には入らない）
    const publishRes = await fx.client(admin).request("PATCH", `/api/v1/announcements/${id}`, {
      version: 1, status: "published",
    }, idem());
    expect(publishRes.status).toBe(200);
    const memberReadRes = await fx.client(member).request("PUT", `/api/v1/announcements/${id}/read`, { revisionNo: 1 }, idem());
    expect(memberReadRes.status).toBe(200);

    const memberAfter = await listFor(fx.client(member));
    expect(memberAfter.readAt).toEqual(((await json(memberReadRes)).data! as { readAt: string }).readAt);
    const adminAfter = await listFor(fx.client(admin));
    expect(adminAfter.readAt).toBeNull(); // 他人の既読は応答に現れない

    // 改版（title変更＝新revision）で既読の本人も未読に戻る（現行版の既読だけを出すため）
    const reviseRes = await fx.client(admin).request("PATCH", `/api/v1/announcements/${id}`, {
      version: 2, title: "資機材の点検当日の持ち物（訂正）",
    }, idem());
    expect(reviseRes.status).toBe(200);
    const memberRevised = await listFor(fx.client(member));
    expect(memberRevised.readAt).toBeNull();

    // --- ready検査済みの添付をお知らせへリンクすると、応答のattachmentsに載る（docs/05 API-24/25/72。
    // API-25/72にattachmentIdsの入力経路は無いため、検査済みのready添付を直接リンクして応答投影を検査する） ---
    const photoId = crypto.randomUUID();
    const nowIso = new Date().toISOString();
    await env.DB.prepare(
      "INSERT INTO attachments (id, unit_id, owner_user_id, owner_member_id, intent_target_type, intent_target_id, ready_key, content_type, byte_size, sha256, status, expires_at, classification, upload_token_hash, created_at, updated_at, created_by, actor_kind) " +
        "VALUES (?, ?, ?, ?, 'announcement', ?, ?, 'image/png', 100, ?, 'ready', ?, ?, ?, ?, ?, ?, 'human')",
    ).bind(
      photoId, a.id, admin.userId, admin.memberId!, id, `ready/${photoId}`, "a".repeat(64),
      nowIso, "basic", "b".repeat(64), nowIso, nowIso, admin.userId,
    ).run();
    await env.DB.prepare(
      "INSERT INTO attachment_links (id, unit_id, attachment_id, entity_type, entity_id, linked_by, created_at, updated_at, created_by, actor_kind) " +
        "VALUES (?, ?, ?, 'announcement', ?, ?, ?, ?, ?, 'human')",
    ).bind(crypto.randomUUID(), a.id, photoId, id, admin.userId, nowIso, nowIso, admin.userId).run();

    const withPhoto = await listFor(fx.client(member));
    expect(withPhoto.attachments).toHaveLength(1);
    expect(withPhoto.attachments[0]).toMatchObject({ id: photoId, status: "ready", contentType: "image/png" });
    expect(typeof (withPhoto.attachments[0] as { linkId: string }).linkId).toBe("string"); // unlinkに渡すlinkId
  });

  it("same_key_resend_returns_saved_response_for_update_and_read (docs/05 §2)", async () => {
    // docs/05 §2「同じキー/本文の再送は元HTTP status/dataを返し」: 応答が届かなかった操作のリトライが
    // 現在の状態を前提とした業務エラー（archived 422・no_changes 400・既読の404）になってはいけない
    const a = fx.units.a;
    const admin = a.people.admin; // PER-03保持
    const member = a.people.member; // 対象者

    const createRes = await fx.client(admin).request("POST", "/api/v1/announcements", {
      title: "再送試験のお知らせ",
      body: "同キー再送は元の応答を返す（試験用・架空）。",
      audienceMemberIds: [member.memberId!],
    }, idem());
    expect(createRes.status).toBe(201);
    const created = (await json(createRes)).data! as { id: string };

    // --- API-72: 公開 → 同キー再送はno_changes 400ではなく元の応答 ---
    const publishKey = crypto.randomUUID();
    const publishBody = { version: 1, status: "published" };
    const publishRes = await fx.client(admin).request("PATCH", `/api/v1/announcements/${created.id}`, publishBody, { "idempotency-key": publishKey });
    expect(publishRes.status).toBe(200);
    const published = (await json(publishRes)).data! as Record<string, unknown>;

    const publishReplay = await fx.client(admin).request("PATCH", `/api/v1/announcements/${created.id}`, publishBody, { "idempotency-key": publishKey });
    expect(publishReplay.status).toBe(200);
    expect((await json(publishReplay)).data).toEqual(published);
    expect((await fx.rows("announcements", { id: created.id }))[0]!.version).toBe(2);
    // 再送で更新のイベントは増えない（作成のイベントと合わせて2件のまま）
    expect(await fx.rows("domain_events", { entity_type: "announcement", entity_id: created.id, event_type: "announcement.updated" })).toHaveLength(1);

    // --- API-66: 対象者の既読 → アーカイブ後の同キー再送でも元の領収（404ではなく） ---
    const readKey = crypto.randomUUID();
    const readRes = await fx.client(member).request("PUT", `/api/v1/announcements/${created.id}/read`, { revisionNo: 1 }, { "idempotency-key": readKey });
    expect(readRes.status).toBe(200);
    const receipt = (await json(readRes)).data! as { readAt: string; revisionNo: number };

    // アーカイブ（終端。別キー）
    const archiveRes = await fx.client(admin).request("PATCH", `/api/v1/announcements/${created.id}`, {
      version: 2, status: "archived",
    }, idem());
    expect(archiveRes.status).toBe(200);

    // アーカイブ後の既読（新しいキー＝新しい操作）は404（現在の状態で検査）
    const newKeyRead = await fx.client(member).request("PUT", `/api/v1/announcements/${created.id}/read`, { revisionNo: 1 }, idem());
    expect(newKeyRead.status).toBe(404);
    // 同キー再送は元の領収（docs/05 §2）
    const readReplay = await fx.client(member).request("PUT", `/api/v1/announcements/${created.id}/read`, { revisionNo: 1 }, { "idempotency-key": readKey });
    expect(readReplay.status).toBe(200);
    expect((await json(readReplay)).data).toEqual(receipt as unknown as Record<string, unknown>);
    expect(await fx.rows("announcement_reads", { announcement_id: created.id })).toHaveLength(1);

    // 同キー別本文は409（docs/05 §2。保存済み応答の本文一致検査）
    const mismatchRead = await fx.client(member).request("PUT", `/api/v1/announcements/${created.id}/read`, { revisionNo: 2 }, { "idempotency-key": readKey });
    expect(mismatchRead.status).toBe(409);
    expect((await json(mismatchRead)).error?.code).toBe("IDEMPOTENCY_MISMATCH");
    const mismatchPublish = await fx.client(admin).request("PATCH", `/api/v1/announcements/${created.id}`, {
      version: 1, status: "published", title: "別本文での再送",
    }, { "idempotency-key": publishKey });
    expect(mismatchPublish.status).toBe(409);
    expect((await json(mismatchPublish)).error?.code).toBe("IDEMPOTENCY_MISMATCH");
  });

  it("audience_ids_are_projected_to_managers_only (docs/05 §1)", async () => {
    // 対象者ID一覧（他対象者のIDを含む）は管理権限（PER-03）の応答だけに載せる。対象者には省略する
    const a = fx.units.a;
    const admin = a.people.admin; // PER-03保持（officer/adminは所属内で管理権）
    const member = a.people.member; // 対象者（PER-03非保持）
    const operator = a.people.operator; // 対象者（scopeは施設のみ＝お知らせの管理権なし）

    const createRes = await fx.client(admin).request("POST", "/api/v1/announcements", {
      title: "対象者一覧の投影試験",
      body: "対象者ID一覧は管理権限だけが受け取る（試験用・架空）。",
      audienceMemberIds: [member.memberId!, operator.memberId!, admin.memberId!], // 管理権限のまま対象にも入る
    }, idem());
    expect(createRes.status).toBe(201);
    const created = (await json(createRes)).data! as { id: string; audienceMemberIds?: string[] };
    // 管理権限の作成応答（API-25）には対象者一覧が含まれる
    expect([...(created.audienceMemberIds ?? [])].sort()).toEqual(
      [member.memberId!, operator.memberId!, admin.memberId!].sort(),
    );

    // 公開（API-72の応答も管理権限なので含まれる）
    const publishRes = await fx.client(admin).request("PATCH", `/api/v1/announcements/${created.id}`, {
      version: 1, status: "published",
    }, idem());
    expect(publishRes.status).toBe(200);
    const published = (await json(publishRes)).data! as { audienceMemberIds?: string[] };
    expect(Array.isArray(published.audienceMemberIds)).toBe(true);

    // 対象者（PER-03非保持）の一覧（API-24）には対象者ID一覧が現れない
    const memberList = (await json(await fx.client(member).request("GET", "/api/v1/announcements"))).data! as Record<string, unknown>[];
    const memberRow = memberList.find((r) => r.id === created.id)!;
    expect(memberRow).toBeTruthy();
    expect(memberRow).not.toHaveProperty("audienceMemberIds");
    // 本文・既読・添付など他の列は対象者にも載る
    expect(memberRow).toMatchObject({ title: "対象者一覧の投影試験", readAt: null, attachments: [] });

    // 管理権限の一覧には含まれる（管理者は対象にも入っているため公開行が見える）
    const adminList = (await json(await fx.client(admin).request("GET", "/api/v1/announcements"))).data! as Record<string, unknown>[];
    const adminRow = adminList.find((r) => r.id === created.id)!;
    expect(adminRow).toBeTruthy();
    expect([...(adminRow.audienceMemberIds as string[])].sort()).toEqual(
      [member.memberId!, operator.memberId!, admin.memberId!].sort(),
    );
  });
});
