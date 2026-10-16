import { env } from "cloudflare:workers";
import { applyD1Migrations } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import type { MutationContext } from "../src/server/mutations/execute";
import { createFixture, type Identity, type TestFixture } from "./helpers/fixture";

let fx: TestFixture;
beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
  fx = await createFixture("two-units");
});

const idem = () => ({ "idempotency-key": crypto.randomUUID() });
const json = async (r: Response) =>
  (await r.json()) as { data?: Record<string, unknown>; error?: { code: string; details?: { field: string; reason: string }[] } };

describe("業務タスク (T049)", () => {
  /**
   * 手動タスク（API-68）の作成→割当→着手→完了→理由付き再開と、AI起点の分離（docs/11 業務タスク）。
   * - pending評価のdecision偽造（対応する承認済みreview_decisionsが無いsourceDecisionId付きの作成）は422
   *   （docs/11「AI起点は承認effectから作成」。review_decisions表はT053で作成のため、T049時点では
   *    「決定行が存在しない→422」で検証する。docs/16 T049裁定）
   * - 承認済みeffect（tasksPerEffectId=1）は、効果の一意ガードそのもの（同じeffect_operation_idでの
   *   2回目の作成が拒否される）をbuildTaskEffect＋UNIQUE制約で検証する。approved経路の接続はT054
   * - 担当外（PER-04/10どちらも担当scopeが無い担当者）の状態変更は403
   * - 許可外の遷移は422で、失敗した変更で状態履歴（task_events）は増えない
   */
  it("pending_ai_proposal_cannot_create_business_task", async () => {
    const a = fx.units.a;
    const admin = a.people.admin;

    // --- 手動作成（API-68。sourceDecisionId無し）: 最初はopen（docs/11 業務タスクの初期値） ---
    const createdRes = await fx.client(admin).request(
      "POST", "/api/v1/tasks",
      { title: "消火栓蓋の交換手配", dueDate: "2026-10-20" }, idem(),
    );
    expect(createdRes.status).toBe(201); // 実装前は未接続routeのJSON 404で赤になる
    const created = (await json(createdRes)).data! as {
      id: string; version: number; status: string; assigneeMemberId: string | null;
      dueDate: string | null; sourceDecisionId: string | null; effectOperationId: string | null;
    };
    expect(created.status).toBe("open");
    expect(created.version).toBe(1);
    expect(created.assigneeMemberId).toBeNull();
    expect(created.dueDate).toBe("2026-10-20");
    expect(created.sourceDecisionId).toBeNull(); // 手動作成はAI源（decision/effect）を持たない
    expect(created.effectOperationId).toBeNull();

    const taskId = created.id;
    const patch = (who: Identity, body: Record<string, unknown>) =>
      fx.client(who).request("PATCH", `/api/v1/tasks/${taskId}`, body, idem());
    const readTask = async () =>
      (await env.DB.prepare("SELECT status, version, assignee_member_id FROM tasks WHERE id = ?").bind(taskId)
        .first<{ status: string; version: number; assignee_member_id: string | null }>())!;

    // --- 割当（open→assigned。担当は同unitのactive団員） ---
    const assignedRes = await patch(admin, { version: 1, status: "assigned", assigneeMemberId: admin.memberId, reason: "担当を決めた" });
    expect(assignedRes.status).toBe(200);
    const assigned = (await json(assignedRes)).data! as { status: string; version: number; assigneeMemberId: string | null };
    expect(assigned.status).toBe("assigned");
    expect(assigned.version).toBe(2);
    expect(assigned.assigneeMemberId).toBe(admin.memberId);

    // --- 着手（assigned→in_progress）→ 完了（in_progress→done） ---
    const startedRes = await patch(admin, { version: 2, status: "in_progress", reason: "着手した" });
    expect(startedRes.status).toBe(200);
    expect(((await json(startedRes)).data! as { status: string }).status).toBe("in_progress");
    const doneRes = await patch(admin, { version: 3, status: "done", reason: "交換を完了した" });
    expect(doneRes.status).toBe(200);
    expect(((await json(doneRes)).data! as { status: string; version: number })).toMatchObject({ status: "done", version: 4 });

    // doneでは担当者変更できない（docs/16 T049裁定: 担当者変更はopen/assigned/in_progressから）
    const reassignOnDone = await patch(admin, { version: 4, assigneeMemberId: a.people.officer.memberId, reason: "完了後の担当変更" });
    expect(reassignOnDone.status).toBe(422);
    expect(((await json(reassignOnDone)).error?.details ?? []).some((d) => d.reason === "assignee_not_assignable")).toBe(true);

    // --- 再開（done→in_progress）は理由必須（docs/11 業務タスク「done→in_progress（再開理由）」） ---
    const reopenNoReason = await patch(admin, { version: 4, status: "in_progress" });
    expect(reopenNoReason.status).toBe(400); // 契約で理由は必須（task_events.reason ≤2000に揃えた上限）
    const reopenedRes = await patch(admin, { version: 4, status: "in_progress", reason: "部品が届かなかったため再開" });
    expect(reopenedRes.status).toBe(200);
    expect(((await json(reopenedRes)).data! as { status: string; version: number })).toMatchObject({ status: "in_progress", version: 5 });

    // --- 許可外の遷移は422（in_progress→assignedはdocs/11の許可辺に無い） ---
    const beforeHistory = await fx.rows("task_events", { task_id: taskId });
    const invalidTransition = await patch(admin, { version: 5, status: "assigned", reason: "許可されない遷移" });
    expect(invalidTransition.status).toBe(422);
    // 旧版（version 1）での比較更新も409で、どちらの失敗でも履歴は増えない（docs/11 §1「成功時だけ履歴と監査を追記」）
    const staleVersion = await patch(admin, { version: 1, status: "done", reason: "古い版" });
    expect(staleVersion.status).toBe(409);
    const taskHistoryAfterFailure = await fx.rows("task_events", { task_id: taskId });
    expect(taskHistoryAfterFailure).toEqual(beforeHistory);
    expect(await readTask()).toMatchObject({ status: "in_progress", version: 5 });

    // --- 担当外（PER-04/10の担当scopeが無い担当者）の状態変更は403 ---
    const outOfScope = await patch(a.people.operator, { version: 5, status: "done", reason: "担当外からの操作" });
    expect(outOfScope.status).toBe(403);
    expect(await fx.rows("task_events", { task_id: taskId })).toEqual(beforeHistory);

    // --- pending評価のdecision偽造: 承認済みdecision無しのAI起点作成は422（タスクも増えない） ---
    const tasksBeforePending = (await env.DB.prepare("SELECT COUNT(*) AS n FROM tasks").first<{ n: number }>())!.n;
    const pendingEffect = await fx.client(admin).request(
      "POST", "/api/v1/tasks",
      { title: "AI提案からのタスク", sourceDecisionId: crypto.randomUUID() }, idem(),
    );
    expect(pendingEffect.status).toBe(422);
    expect(((await json(pendingEffect)).error?.details ?? []).some((d) => d.reason === "decision_not_approved")).toBe(true);
    expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM tasks").first<{ n: number }>())!.n).toBe(tasksBeforePending);

    // --- 同effect再実行: 効果の一意ガード（docs/04 effect_operation_id非NULL UNIQUE） ---
    // approved経路（review_decisions）はT054が繋ぐため、ここでは承認済みAI起点と同じ作成文
    // （buildTaskEffect。T054が同一batchで呼ぶ共通関数）で同じeffect_operation_idを2回作り、
    // 2回目がUNIQUEで拒否されること（二重効果0。同effectのタスクは1件のまま）を検証する。
    // モジュールを遅延解決するのは、未実装のまま赤を確認する段階で「解決失敗」ではなく
    // 未接続routeの404（assertion）を赤の根拠にするため。
    const { buildTaskEffect } = await import("../src/server/routes/tasks");
    const effectOperationId = crypto.randomUUID();
    const decisionId = crypto.randomUUID();
    const ctx = (attempt: string) => ({
      env,
      unitId: a.id,
      actorUserId: admin.userId,
      mutation: { attempt, mutationId: crypto.randomUUID(), now: new Date().toISOString() } satisfies MutationContext,
    });
    const effectInput = {
      decisionId,
      evaluationId: null,
      effectOperationId,
      sourceIssueId: null,
      title: "承認済AI起点のタスク",
      assigneeMemberId: admin.memberId,
      dueDate: null,
    };
    await env.DB.batch(await buildTaskEffect(ctx("effect-1"), effectInput));
    await expect(env.DB.batch(await buildTaskEffect(ctx("effect-2"), effectInput))).rejects.toThrow(/UNIQUE/);
    const tasksPerEffectId = (await env.DB.prepare("SELECT COUNT(*) AS n FROM tasks WHERE effect_operation_id = ?")
      .bind(effectOperationId).first<{ n: number }>())!.n;
    expect(tasksPerEffectId).toBe(1);

    // AI起点の行は源（decision）を保持し、状態はopen（docs/04 tasks、docs/11 初期値）
    const aiTask = (await env.DB.prepare(
      "SELECT source_decision_id, source_evaluation_id, effect_operation_id, status FROM tasks WHERE effect_operation_id = ?",
    ).bind(effectOperationId).first<{ source_decision_id: string; source_evaluation_id: string | null; effect_operation_id: string; status: string }>())!;
    expect(aiTask.source_decision_id).toBe(decisionId);
    expect(aiTask.effect_operation_id).toBe(effectOperationId);
    expect(aiTask.status).toBe("open");

    // --- cancelledは終端（docs/11「cancelledは終端」） ---
    const secondRes = await fx.client(admin).request("POST", "/api/v1/tasks", { title: "資機材の注文" }, idem());
    expect(secondRes.status).toBe(201);
    const secondId = ((await json(secondRes)).data! as { id: string }).id;
    const cancelledRes = await fx.client(admin).request("PATCH", `/api/v1/tasks/${secondId}`, { version: 1, status: "cancelled", reason: "不要になった" }, idem());
    expect(cancelledRes.status).toBe(200);
    const afterCancel = await fx.client(admin).request("PATCH", `/api/v1/tasks/${secondId}`, { version: 2, status: "in_progress", reason: "取消後の変更" }, idem());
    expect(afterCancel.status).toBe(422);
  });

  /** T052: 自分の担当タスクの一覧（API-102。docs/03 SCR-21「自分の担当タスク一覧・期限・履歴」。API-28 myTasksと同じ条件） */
  it("my_task_list_serves_active_tasks_with_history", async () => {
    const a = fx.units.a;
    const admin = a.people.admin; // 分団長（PER-04。タスクを作ってmemberに割当てる）
    const member = a.people.member; // 担当者（PER-01で自分の分だけを読む）

    const createRes = await fx.client(admin).request("POST", "/api/v1/tasks", {
      title: "ポンプ車の定期点検の段取り", assigneeMemberId: member.memberId, dueDate: "2026-12-10",
    }, idem());
    expect(createRes.status).toBe(201); // 実装前は未接続routeのJSON 404で赤になる
    const created = (await json(createRes)).data! as { id: string; version: number };

    // --- 自分の担当タスクだけが現れる（作成者でないadminの一覧には出ない。assignee=本人の条件） ---
    const myList = (await json(await fx.client(member).request("GET", "/api/v1/tasks/me?limit=200"))).data as unknown as {
      id: string; title: string; status: string; dueDate: string | null; assigneeMemberId: string | null;
      events: { action: string; reason: string | null; after: Record<string, unknown> }[];
    }[];
    const mine = myList.find((row) => row.id === created.id);
    expect(mine).toBeDefined();
    expect(mine!.status).toBe("open");
    expect(mine!.dueDate).toBe("2026-12-10");
    expect(mine!.assigneeMemberId).toBe(member.memberId);
    // 履歴（task_events）が行に付く（API-70と同じ「詳細応答にevents」流儀。初行は作成）
    expect(mine!.events.length).toBeGreaterThanOrEqual(1);
    expect(mine!.events[0]!.action).toBe("created");

    // 進めても同じ行のeventsに積まれる（open→in_progress→done）
    for (const [version, status] of [[1, "in_progress"], [2, "done"]] as const) {
      const patchRes = await fx.client(admin).request("PATCH", `/api/v1/tasks/${created.id}`, {
        version, status, reason: "段取りを進めた",
      }, idem());
      expect(patchRes.status).toBe(200);
    }
    const afterList = (await json(await fx.client(member).request("GET", "/api/v1/tasks/me?limit=200"))).data as unknown as { id: string }[];
    // 完了済みは既定の一覧（＝ダッシュボードのmyTasks指標と同じ条件）から外れる
    expect(afterList.some((row) => row.id === created.id)).toBe(false);
    // status=doneで確認できる（再開の導線）。履歴には理由付きの状態変更が残る
    const doneQuery = (await json(await fx.client(member).request("GET", "/api/v1/tasks/me?status=done&limit=200"))).data as unknown as {
      id: string; events: { action: string; reason: string | null }[];
    }[];
    const doneRow = doneQuery.find((row) => row.id === created.id);
    expect(doneRow).toBeDefined();
    expect(doneRow!.events.map((e) => e.action)).toEqual(["created", "status.open_to_in_progress", "status.in_progress_to_done"]);
    expect(doneRow!.events[2]!.reason).toBe("段取りを進めた");

    // --- 担当でないタスクは自分の一覧に現れない（officerの担当・別分団とも） ---
    const officerTask = await fx.client(admin).request("POST", "/api/v1/tasks", {
      title: "幹部担当のタスク", assigneeMemberId: admin.memberId,
    }, idem());
    expect(officerTask.status).toBe(201);
    const officerTaskId = ((await json(officerTask)).data! as { id: string }).id;
    const memberAgain = (await json(await fx.client(member).request("GET", "/api/v1/tasks/me?limit=200"))).data as unknown as { id: string }[];
    expect(memberAgain.some((row) => row.id === officerTaskId)).toBe(false);
    // 未知のstatus指定は400（列挙外は拒否。docs/05 §1）
    const unknownStatus = await fx.client(member).request("GET", "/api/v1/tasks/me?status=archived");
    expect(unknownStatus.status).toBe(400);
    // 停止された利用者は主体を引けない（401。PER-01の前置）
    const suspended = await fx.client(a.people.suspended).request("GET", "/api/v1/tasks/me");
    expect(suspended.status).toBe(401);
  });

  /**
   * AI起点タスク（source_decision_id付き。承認effectと同じ作成文buildTaskEffectで作る）の状態変更も
   * 手動タスクと同じAPI-87で追跡できること（docs/16 T049完了条件「手動とAI起点の双方で変更/担当/理由を
   * 追跡可能」。PH4レビューB中1）。着手→完了→理由付き再開→担当変更の各履歴がtask_eventsへ積まれる。
   */
  it("ai_originated_task_tracks_status_changes_assignee_and_reason", async () => {
    const a = fx.units.a;
    const admin = a.people.admin;
    const { buildTaskEffect } = await import("../src/server/routes/tasks");
    const effectOperationId = crypto.randomUUID();
    const decisionId = crypto.randomUUID();
    const now = new Date().toISOString();
    await env.DB.batch(await buildTaskEffect(
      { env, unitId: a.id, actorUserId: admin.userId, mutation: { attempt: "ai-task-track", mutationId: crypto.randomUUID(), now } },
      { decisionId, evaluationId: null, effectOperationId, sourceIssueId: null, title: "AI起点の状態変更試験", assigneeMemberId: admin.memberId, dueDate: null },
    ));
    const aiTask = (await env.DB.prepare(
      "SELECT id, version, status FROM tasks WHERE effect_operation_id = ?",
    ).bind(effectOperationId).first<{ id: string; version: number; status: string }>())!;
    expect(aiTask.status).toBe("open");

    const patch = (body: Record<string, unknown>) =>
      fx.client(admin).request("PATCH", `/api/v1/tasks/${aiTask.id}`, body, idem());
    // 着手（open→in_progress）→完了→理由付き再開（done→in_progressは理由必須）→担当変更
    expect((await patch({ version: 1, status: "in_progress", reason: "AI起点も着手する" })).status).toBe(200);
    expect((await patch({ version: 2, status: "done", reason: "完了した" })).status).toBe(200);
    expect((await patch({ version: 3, status: "in_progress", reason: "追加対応のため再開" })).status).toBe(200);
    expect((await patch({ version: 4, assigneeMemberId: a.people.officer.memberId, reason: "担当を引き継ぐ" })).status).toBe(200);
    // 一覧（API-102）は担当（officer）の分だけが見える。履歴（events）付きで読み返す
    const readBack = (await json(await fx.client(a.people.officer).request("GET", "/api/v1/tasks/me?status=in_progress&limit=200"))).data as unknown as {
      id: string; status: string; assigneeMemberId: string | null; events: { action: string; reason: string | null }[];
    }[];
    const row = readBack.find((t) => t.id === aiTask.id)!;
    expect(row.status).toBe("in_progress");
    expect(row.assigneeMemberId).toBe(a.people.officer.memberId);
    // 履歴（task_events）に作成＋状態3回＋担当変更が追記され、再開と担当変更の理由が残る
    expect(row.events.map((e) => e.action)).toEqual([
      "created", "status.open_to_in_progress", "status.in_progress_to_done", "status.done_to_in_progress", "assignee.changed",
    ]);
    expect(row.events[3]!.reason).toBe("追加対応のため再開");
    expect(row.events[4]!.reason).toBe("担当を引き継ぐ");
    // DB上の源（decision/effect）は状態変更でも変わらない
    const after = (await env.DB.prepare(
      "SELECT source_decision_id, effect_operation_id FROM tasks WHERE id = ?",
    ).bind(aiTask.id).first<{ source_decision_id: string; effect_operation_id: string }>())!;
    expect(after.source_decision_id).toBe(decisionId);
    expect(after.effect_operation_id).toBe(effectOperationId);
  });

  /**
   * docs/05 §2「同じキー/本文の再送は元HTTP status/dataを返す」（PH4レビューA中1）:
   * タスク作成（API-68）の再送は、初回成功後に担当団員が非activeになっていても初回の201と同じ
   * タスクIDを返す。現行実装は鍵の既存に関係なくrequireActiveAssigneeが走るためFAILする。
   */
  it("resend_with_same_idempotency_key_returns_saved_task_even_if_assignee_became_inactive", async () => {
    const a = fx.units.a;
    const admin = a.people.admin;
    const assignee = a.people.unlinked; // アカウントの無い団員（API-04の状態変更は団員行だけに効く）
    const headers = { "idempotency-key": "resend-task-create-same-key-1" };
    const body = { title: "再送試験のタスク（架空）", assigneeMemberId: assignee.memberId };
    const first = await fx.client(admin).request("POST", "/api/v1/tasks", body, headers);
    expect(first.status).toBe(201);
    const saved = (await json(first)).data! as { id: string };

    // 初回成功後に担当団員が休団になる（API-04）
    const memberRow = (await fx.rows("members", { id: assignee.memberId }))[0]!;
    const pause = await fx.client(admin).request("PATCH", `/api/v1/members/${assignee.memberId}`, {
      version: memberRow.version as number, status: "paused", reason: "再送試験のため休団（架空）",
    }, idem());
    expect(pause.status).toBe(200);

    const resend = await fx.client(admin).request("POST", "/api/v1/tasks", body, headers);
    expect(resend.status).toBe(201); // 元HTTP status（現行実装は422 assignee_not_activeでFAIL）
    expect(((await json(resend)).data! as { id: string }).id).toBe(saved.id);
    // 再送でタスクは増えない
    expect(await fx.rows("tasks", { title: "再送試験のタスク（架空）" })).toHaveLength(1);
  });

  /**
   * docs/05 §2（同上）: cancelledへの遷移と担当変更を同時に行った要求（API-87）の再送は、
   * 現status=cancelled（担当変更の許可状態でない）でも初回の200を返す。
   * 現行実装は鍵の既存に関係なくASSIGNABLE_STATES検査が走るためFAILする。
   */
  it("resend_with_same_idempotency_key_returns_saved_update_even_if_task_is_cancelled", async () => {
    const a = fx.units.a;
    const admin = a.people.admin;
    const officer = a.people.officer;
    const created = await fx.client(admin).request("POST", "/api/v1/tasks", { title: "取消と担当変更の同時記録" }, idem());
    expect(created.status).toBe(201);
    const taskId = ((await json(created)).data! as { id: string }).id;

    const headers = { "idempotency-key": "resend-task-update-same-key-1" };
    const body = { version: 1, status: "cancelled", assigneeMemberId: officer.memberId, reason: "不要のため取消し（担当の後記録）" };
    const first = await fx.client(admin).request("PATCH", `/api/v1/tasks/${taskId}`, body, headers);
    expect(first.status).toBe(200);
    expect(((await json(first)).data! as { status: string }).status).toBe("cancelled");

    // 初回成功後に新しい担当が休団になる（初回には通った担当の検査を再送が再実行しないことを確認）
    const officerRow = (await fx.rows("members", { id: officer.memberId }))[0]!;
    const pause = await fx.client(admin).request("PATCH", `/api/v1/members/${officer.memberId}`, {
      version: officerRow.version as number, status: "paused", reason: "再送試験のため休団（架空）",
    }, idem());
    expect(pause.status).toBe(200);

    const resend = await fx.client(admin).request("PATCH", `/api/v1/tasks/${taskId}`, body, headers);
    expect(resend.status).toBe(200); // 元HTTP status（現行実装は422 assignee_not_assignableでFAIL）
    expect(((await json(resend)).data! as { status: string }).status).toBe("cancelled");
  });
});
