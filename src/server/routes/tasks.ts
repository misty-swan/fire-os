import { Task } from "../../shared/contracts/operations";
import { taskTransitions } from "../../shared/states";
import { authorize, type ResourceRef } from "../auth/authorize";
import { resolvePrincipal, type AuthzPrincipal } from "../auth/principal";
import type { AppEnv } from "../env";
import { HttpError, defineRoute, ok, parseApiRequest, type ApiApp } from "../http";
import { canonicalRequestHash } from "../mutations/hash";
import { executeMutation, type MutationContext } from "../mutations/execute";
import { requirePermission } from "./invitations";

/**
 * 業務タスクの作成と状態遷移（T049、docs/05 API-68/87、docs/11 業務タスク、docs/04:136）。
 * - 手動作成（API-68。sourceDecisionId省略）はstatus='open'・AI源（decision/effect）無しで作る。
 * - AI起点（sourceDecisionId付き）は「対応するreview_decisionsが同unitに存在し、decisionが承認済み」を
 *   要求する（docs/11「AI起点は承認effectから作成」）。決定が無い/pending提案のdecision偽造は422。
 *   review_decisions表はT053（PH4）で作成されるため、それまでは決定行が存在し得ず常に422になる
 *   （docs/16 T049裁定。approved経路の接続はT054が同一batchで行う）。
 * - 効果操作ID（effect_operation_id）は部分一意索引で一意。同effectの2回目の作成は拒否され二重効果0。
 *   T054共用の作成文はbuildTaskEffect（API-68のAI起点と同じ文を使う）。
 * - 変更（API-87）はversion比較更新。遷移はdocs/11の許可辺のみ（taskTransitions）、再開（done→in_progress）
 *   は理由必須、cancelledは終端。担当者変更はopen/assigned/in_progressから可能。
 * - 履歴（task_events）・監査・outboxは業務書込と同じbatchで確定する（docs/11 §1「成功時だけ履歴と監査」）。
 */

const TASK_JSON =
  "SELECT json_object(" +
  "'id', id, 'version', version, 'title', title, 'assigneeMemberId', assignee_member_id, 'status', status, " +
  "'dueDate', due_date, 'sourceEvaluationId', source_evaluation_id, 'sourceIssueId', source_issue_id, " +
  "'sourceDecisionId', source_decision_id, 'effectOperationId', effect_operation_id, 'createdAt', created_at, 'updatedAt', updated_at) " +
  "FROM tasks WHERE id = ?";

/** 担当者変更ができる状態（docs/16 T049裁定: open/assigned/in_progressから。done/cancelledでは422） */
const ASSIGNABLE_STATES: readonly string[] = ["open", "assigned", "in_progress"];

/**
 * docs/05 API-68/87「PER-04/10」: 手動の報告系（PER-04）と承認系（PER-10）のどちらかがあれば操作できる
 * （docs/10 PER-04/PER-10の和集合。一般団員は自分が担当のタスクをPER-04本人分で、幹部・管理者は所属内で、
 * 担当者は担当scopeがある対象だけ）。両方とも拒否のときだけ403。
 */
function requireTaskPermission(p: AuthzPrincipal, target: ResourceRef): void {
  const asReport = authorize(p, "PER-04", target);
  if (asReport.allowed) return;
  const asApproval = authorize(p, "PER-10", target);
  if (asApproval.allowed) return;
  throw new HttpError("FORBIDDEN", undefined, [{ field: "permission", reason: asReport.reason }]);
}

/** 担当は有効な団員だけ（休団・退団に割当てない。docs/10 PER-04/10の対象条件。issues T032と同じ規則） */
async function requireActiveAssignee(c: { env: Pick<AppEnv, "DB"> }, p: AuthzPrincipal, memberId: string): Promise<void> {
  const m = await c.env.DB.prepare("SELECT unit_id, status FROM members WHERE id = ?").bind(memberId)
    .first<{ unit_id: string; status: string }>();
  if (!m || m.unit_id !== p.unitId) throw new HttpError("NOT_FOUND");
  if (m.status !== "active") {
    throw new HttpError("INVALID_TRANSITION", undefined, [{ field: "assigneeMemberId", reason: "assignee_not_active" }]);
  }
}

/**
 * 承認済みの決定（docs/04:145 review_decisions。AI起点タスクの作成源）を引く。
 * 表はT053で作成されるため、それまでは「表が無い＝承認済みdecisionは存在し得ない」でnullを返し、
 * 呼び出し側が422にする（docs/16 T049裁定。T053/T054以降は実検査に変わる。decisionの値は
 * docs/11 AI提案の承認済み/approved_with_edit。pending提案からの偽造はここで落ちる）。
 */
async function findApprovedDecision(
  db: D1Database,
  unitId: string,
  decisionId: string,
): Promise<{ id: string; evaluation_id: string | null; effect_operation_id: string } | null> {
  const exists = await db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'review_decisions'").first();
  if (!exists) return null;
  return db.prepare(
    "SELECT id, evaluation_id, effect_operation_id FROM review_decisions " +
      "WHERE id = ? AND unit_id = ? AND decision IN ('approved', 'approved_with_edit')",
  ).bind(decisionId, unitId).first<{ id: string; evaluation_id: string | null; effect_operation_id: string }>();
}

/** buildTaskEffect／taskEffectStatementsの呼び出し文脈。unitと作成者、周囲のmutationの試行印を束ねる */
export interface TaskEffectContext {
  env: Pick<AppEnv, "DB">;
  unitId: string;
  /** 作成者（users.id。監査列。AI起点では決定者の利用者） */
  actorUserId: string;
  /** 周囲のmutationの試行印・サーバー時刻（last_mutation_token/created_atに使う。executeMutationのstatements(ctx)） */
  mutation: MutationContext;
}

/** 承認済みAI起点のタスク作成1件分の入力（T054が承認decisionのconfirmed_payloadから組み立てる） */
export interface TaskEffectInput {
  /** 承認済み決定（review_decisions.id。API-68の承認検査を通った値） */
  decisionId: string;
  /** 決定の元になったAI評価（ai_evaluations.id。無い決定形ではnull） */
  evaluationId: string | null;
  /** 一意の効果操作ID（docs/04 effect_operation_id。同effectの再実行はUNIQUEで拒否＝二重効果0） */
  effectOperationId: string;
  /** 元異常（source_issue_id。任意。存在と同unit所属を検査する） */
  sourceIssueId: string | null;
  title: string;
  assigneeMemberId: string | null;
  /** 業務日（YYYY-MM-DD） */
  dueDate: string | null;
}

/**
 * 承認済みAI起点のタスク作成文（task本体＋task_events初行）。監査/outboxは積まない
 * （呼び出し側のmutationが一mutation一eventで1回だけ積む。docs/16 T049裁定）。
 * task_eventsの初行はdecision源を残す（docs/04「task_events…追記履歴」）。
 */
function taskEffectStatements(ctx: TaskEffectContext, input: TaskEffectInput): D1PreparedStatement[] {
  const taskId = crypto.randomUUID();
  return [
    ctx.env.DB.prepare(
      "INSERT INTO tasks (id, unit_id, source_evaluation_id, source_issue_id, title, assignee_member_id, status, due_date, source_decision_id, effect_operation_id, last_mutation_token, created_at, updated_at, created_by, actor_kind) " +
        "VALUES (?, ?, ?, ?, ?, ?, 'open', ?, ?, ?, ?, ?, ?, ?, 'human')",
    ).bind(taskId, ctx.unitId, input.evaluationId, input.sourceIssueId, input.title, input.assigneeMemberId, input.dueDate, input.decisionId, input.effectOperationId, ctx.mutation.attempt, ctx.mutation.now, ctx.mutation.now, ctx.actorUserId),
    ctx.env.DB.prepare(
      "INSERT INTO task_events (id, unit_id, task_id, action, before_json, after_json, actor_user_id, actor_kind, created_at) " +
        "VALUES (?, ?, ?, 'created', '{}', ?, ?, 'human', ?)",
    ).bind(crypto.randomUUID(), ctx.unitId, taskId, JSON.stringify({ status: "open", source: "ai_decision" }), ctx.actorUserId, ctx.mutation.now),
  ];
}

/**
 * 承認済みAI起点のタスク作成文（T054が同一batch内で呼ぶ共通関数。docs/16 T049のInterface）。
 * taskEffectStatementsの前に元異常の存在・同unit所属を検査する（AI起点の外側のmutationでも
 * 業務対象の所在を確認してから書込む。executeMutationのstatementsは同期のため、batch内で
 * 呼ぶ場合は同検査を前提条件（conditions）か呼び出し前に済ませtaskEffectStatementsを使う）。
 */
export async function buildTaskEffect(ctx: TaskEffectContext, input: TaskEffectInput): Promise<D1PreparedStatement[]> {
  if (input.sourceIssueId) {
    const issue = await ctx.env.DB.prepare("SELECT unit_id FROM issues WHERE id = ?").bind(input.sourceIssueId)
      .first<{ unit_id: string }>();
    if (!issue || issue.unit_id !== ctx.unitId) {
      throw new HttpError("NOT_FOUND", undefined, [{ field: "sourceIssueId", reason: "issue_not_found" }]);
    }
  }
  return taskEffectStatements(ctx, input);
}

export function registerTaskRoutes(app: ApiApp): void {
  // --- API-68: 手動/承認済みAI起点のタスク作成 ---
  defineRoute(app, "API-68", async (c) => {
    const p = await resolvePrincipal(c);
    const { body, headers } = await parseApiRequest(c, "API-68");
    requireTaskPermission(p, { unitId: p.unitId, type: "task" });
    if (body.assigneeMemberId) await requireActiveAssignee(c, p, body.assigneeMemberId);

    // AI起点は承認effectから作る（docs/11）。対応する承認済み決定が無ければ422（タスクは増えない）
    const decision = body.sourceDecisionId ? await findApprovedDecision(c.env.DB, p.unitId, body.sourceDecisionId) : null;

    if (body.sourceDecisionId && !decision) {
      throw new HttpError("INVALID_TRANSITION", undefined, [{ field: "sourceDecisionId", reason: "decision_not_approved" }]);
    }
    const source: "manual" | "ai_decision" = decision ? "ai_decision" : "manual";

    const id = crypto.randomUUID();
    const result = await executeMutation(c.env, p, {
      operationCode: "task.create",
      key: headers["idempotency-key"],
      requestHash: await canonicalRequestHash({ method: "POST", path: "/tasks", body }),
      expectedAuthzVersion: p.authzVersion,
      // 新規作成のみの操作（更新rootは無い。createdの存在検査で成功を確認する）
      roots: [],
      created: [{ table: "tasks", id }],
      // 承認済みeffectの二重適用（同effect_operation_idの2回目の作成）は業務上の重複=409 DUPLICATE
      duplicateOn: ["index:uq_task_effect_operation"],
      statements: (ctx) =>
        decision
          ? taskEffectStatements(
              { env: c.env, unitId: p.unitId, actorUserId: p.userId, mutation: ctx },
              {
                decisionId: body.sourceDecisionId!,
                evaluationId: decision.evaluation_id,
                effectOperationId: decision.effect_operation_id,
                sourceIssueId: null,
                title: body.title,
                assigneeMemberId: body.assigneeMemberId ?? null,
                dueDate: body.dueDate ?? null,
              },
            )
          : [
              c.env.DB.prepare(
                "INSERT INTO tasks (id, unit_id, source_evaluation_id, source_issue_id, title, assignee_member_id, status, due_date, source_decision_id, effect_operation_id, last_mutation_token, created_at, updated_at, created_by, actor_kind) " +
                  "VALUES (?, ?, NULL, NULL, ?, ?, 'open', ?, NULL, NULL, ?, ?, ?, ?, 'human')",
              ).bind(id, p.unitId, body.title, body.assigneeMemberId ?? null, body.dueDate ?? null, ctx.attempt, ctx.now, ctx.now, p.userId),
              c.env.DB.prepare(
                "INSERT INTO task_events (id, unit_id, task_id, action, before_json, after_json, actor_user_id, actor_kind, created_at) " +
                  "VALUES (?, ?, ?, 'created', '{}', ?, ?, 'human', ?)",
              ).bind(crypto.randomUUID(), p.unitId, id, JSON.stringify({ status: "open", source }), p.userId, ctx.now),
            ],
      audit: { action: "task.create", entityType: "task", entityId: id, metadata: { source, hasAssignee: !!body.assigneeMemberId } },
      event: { entityType: "task", entityId: id, entityVersion: 1, eventType: "task.created", payload: { source } },
      response: { status: 201, sql: TASK_JSON, binds: [id], decode: (j) => Task.parse(j) },
    });
    return ok(c, result.data, {}, 201);
  });

  // --- API-87: 状態遷移・担当変更（遷移検査・履歴・監査を同じbatchで） ---
  defineRoute(app, "API-87", async (c) => {
    const p = await resolvePrincipal(c);
    const { params, body, headers } = await parseApiRequest(c, "API-87");
    const current = await c.env.DB.prepare("SELECT id, unit_id, status, version, assignee_member_id FROM tasks WHERE id = ?").bind(params.id)
      .first<{ id: string; unit_id: string; status: string; version: number; assignee_member_id: string | null }>();
    if (!current || current.unit_id !== p.unitId) throw new HttpError("NOT_FOUND");
    requireTaskPermission(p, { unitId: p.unitId, type: "task", id: params.id, ownerMemberId: current.assignee_member_id ?? undefined });

    const statusChange = body.status !== undefined && body.status !== current.status;
    if (statusChange && !taskTransitions[current.status as keyof typeof taskTransitions].includes(body.status!)) {
      throw new HttpError("INVALID_TRANSITION", undefined, [{ field: "status", reason: "transition_not_allowed" }]);
    }
    // 担当者変更はopen/assigned/in_progressから（docs/16 T049裁定。done/cancelledでは422）
    const assigneeChange = body.assigneeMemberId !== undefined;
    if (assigneeChange && !ASSIGNABLE_STATES.includes(current.status)) {
      throw new HttpError("INVALID_TRANSITION", undefined, [{ field: "assigneeMemberId", reason: "assignee_not_assignable" }]);
    }
    if (body.assigneeMemberId) await requireActiveAssignee(c, p, body.assigneeMemberId);
    // 再開（done→in_progress）は理由必須（docs/11 業務タスク。理由は契約でも必須。ここでは空文字弾りを二重にする）
    const reopen = body.status === "in_progress" && current.status === "done";
    if (reopen && !body.reason?.trim()) {
      throw new HttpError("VALIDATION_ERROR", undefined, [{ field: "reason", reason: "reason_required" }]);
    }
    const changed = [
      ...(statusChange ? ["status"] : []),
      ...(assigneeChange ? ["assignee"] : []),
    ].join(".");

    const result = await executeMutation(c.env, p, {
      operationCode: "task.update",
      key: headers["idempotency-key"],
      requestHash: await canonicalRequestHash({ method: "PATCH", path: `/tasks/${params.id}`, baseVersion: body.version, body }),
      expectedAuthzVersion: p.authzVersion,
      roots: [{
        table: "tasks", id: params.id, expectedVersion: body.version,
        allowedStates: statusChange ? { column: "status", values: [current.status] } : undefined,
      }],
      statements: (ctx) => [
        c.env.DB.prepare(
          "UPDATE tasks SET " +
            "status = CASE WHEN ? = 1 THEN ? ELSE status END, " +
            "assignee_member_id = CASE WHEN ? = 1 THEN ? ELSE assignee_member_id END, " +
            "version = version + 1, last_mutation_token = ?, updated_at = ? " +
            "WHERE id = ? AND unit_id = ? AND version = ?",
        ).bind(statusChange ? 1 : 0, body.status ?? current.status, assigneeChange ? 1 : 0, body.assigneeMemberId ?? null, ctx.attempt, ctx.now, params.id, p.unitId, body.version),
        // 履歴（docs/04:138 task_events。変更の前後をID・状態の形で残す。本文は複製しない）
        c.env.DB.prepare(
          "INSERT INTO task_events (id, unit_id, task_id, action, before_json, after_json, reason, actor_user_id, actor_kind, created_at) " +
            "VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'human', ?)",
        ).bind(
          crypto.randomUUID(), p.unitId, params.id,
          statusChange ? `status.${current.status}_to_${body.status}` : "assignee.changed",
          JSON.stringify({ status: current.status, assignee: current.assignee_member_id }),
          JSON.stringify({ status: statusChange ? body.status : current.status, assignee: assigneeChange ? body.assigneeMemberId : current.assignee_member_id }),
          body.reason ?? null, p.userId, ctx.now,
        ),
      ],
      audit: { action: "task.update", entityType: "task", entityId: params.id, metadata: { changed, to: statusChange ? body.status! : current.status } },
      event: { entityType: "task", entityId: params.id, entityVersion: body.version + 1, eventType: "task.updated", payload: { changed } },
      response: { status: 200, sql: TASK_JSON, binds: [params.id], decode: (j) => Task.parse(j) },
    });
    return ok(c, result.data);
  });
}
