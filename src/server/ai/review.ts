import { z } from "zod";
import { classificationCategories } from "../../shared/contracts/ai";
import { BusinessDate, Body, Id, Instant, LIMITS, Title } from "../../shared/contracts/common";
import { notificationSourceTypes } from "../../shared/contracts/content";
import { notificationChannels } from "../../shared/states";
import type { ApiRequest, ApiResponse } from "../../shared/contracts/registry";
import { authorize, type PermissionCode } from "../auth/authorize";
import { resolvePrincipal } from "../auth/principal";
import type { AppEnv } from "../env";
import { HttpError, type ApiContext } from "../http";
import { canonicalJson, canonicalRequestHash, sha256Hex } from "../mutations/hash";
import { executeMutation, type ExtraCondition } from "../mutations/execute";
import { addressRefFor, buildNotificationDraft, type NotificationDraftProposal } from "../routes/notifications";
import { taskEffectStatements } from "../routes/tasks";
import { requirePermission } from "../routes/invitations";
import { isKnownQuestionVersion } from "./questions";

/**
 * AI提案の決定（T054、docs/06 §3、docs/11 AI提案、docs/05 API-31、docs/04:145 review_decisions、
 * docs/10 PER-10「承認対象と反映先の両書込権」、CT-06、AT-AI-04）。
 *
 * decideAiProposal（API-31）は1つのexecuteMutationで確定する:
 *  ①review_decisions 1行（対象ちょうど一つ。evaluation_id/effect_operation_idの部分UNIQUEで
 *    二重決定・二重効果は409。決定語彙はdocs/11前提のapproved/approved_with_edit/rejectedへ変換。
 *    docs/16 T053裁定）
 *  ②ai_evaluations.statusの遷移（docs/04:143「遷移はT054以降」。pendingからのみ。生出力JSONは書換ない。
 *    人の確定分類・理由・reviewedAtはreview_decisions側の別保存＝docs/06 §3）
 *  ③確定分類の業務効果（confirm分類は異常側のissues.confirmed_categoryへ。docs/04:117。
 *    sourceが点検のときは異常起票を伴う場合だけlinked issue側へ書き、伴わなければ決定の保存だけ。
 *    docs/05 API-31行に記載）
 *  ④タスク作成（T049のtaskEffectStatements＝buildTaskEffectと同じ文。AI起点は承認effectから＝docs/11。
 *    effect_operation_idは決定とタスクで共有し、uq_task_effect_operationが二重効果0を保証する）
 *  ⑤通知draft作成（T050のbuildNotificationDraftで提案を組み立てdraftまで。配送jobは作らない＝
 *    自動送信0。実送信はAPI-64の対象/本文承認＝docs/06 §3「通知の実送信はAPI-64…まで行わない」）
 *
 * stale検査（docs/06 §3「元/権限/提案版変化でstale/409」）は同batchのconditionsで再検査する:
 * 元版（点検=series版・異常=issue版の現行version）・候補版（ai_evaluations.source_version）・
 * 質問版（既知の質問版）・承認者の権限（PER-10＋反映先の書込権）。変化があれば409で承認を失敗させ、
 * 旧提案の反映は0。提案をstaleへ遷移させる別操作（job再実行での再候補）はここでは行わない
 * （docs/16 T054裁定「承認自体は失敗させ、書換はしない」）。
 *
 * 表示権限と業務変更権は別検査にする（docs/16 T054裁定）: API-30の一覧はPER-10（ai_evaluation）、
 * API-31の実行はPER-10（承認対象＝元の対象）＋反映先の書込権（確定分類=PER-05、タスク=PER-04/10、
 * 通知draft=PER-12）。scope（担当）は対象ID付きの権限で効くため、取消は次の要求から403になる。
 */

/** confirmedPayloadの契約（docs/05 §3 ReviewInput「confirmedPayload」。確定予定値＝レビュー画面の表示値）。
 *  未知キーは400（注入文を効果に変換しない。CT-06「注入」）。rejectは効果を伴わないため空のみ。 */
const ConfirmedPayloadInput = z.object({
  /** 人の確定分類（省略時はAI候補の代表分類を確認したものとみなす。approve_with_editでは修正後の値） */
  confirmedCategory: z.enum(classificationCategories).optional(),
  /** 承認effectから作るタスク（API-68の入力と同じ形。T049のbuildTaskEffectへ渡す） */
  task: z.object({ title: Title, assigneeMemberId: Id.optional(), dueDate: BusinessDate.nullable().optional() }).strict().optional(),
  /** 承認effectから作る通知draft（API-63と同じ入力。源は通知が対応している種別のみ） */
  notification: z.object({
    source: z.object({ type: z.enum(notificationSourceTypes), id: Id }).strict(),
    body: Body.optional(),
    audienceMemberIds: z.array(Id).max(LIMITS.arrayMax).optional(),
    channels: z.array(z.enum(notificationChannels)).min(1).max(10),
    expiresAt: Instant.nullable().optional(),
  }).strict().optional(),
}).strict();

export type ConfirmedPayload = z.infer<typeof ConfirmedPayloadInput>;

/** API-31のdecision（docs/05 §3）→review_decisions.decision（docs/11語彙。docs/16 T053裁定の対応） */
const STORED_DECISION = {
  approve: "approved",
  approve_with_edit: "approved_with_edit",
  reject: "rejected",
} as const;

/** 決定理由（review_decisions.reasonは1〜2000のCHECK。docs/05 §1の理由上限に揃えて400で弾く） */
const REASON_MAX = 2000;
const DEFAULT_REASON = {
  approve: "AI提案どおり承認",
  approve_with_edit: "AI提案を修正して承認",
} as const;

/** 承認対象の提案（ai_evaluations行。404は存在しない/別unitで同じ＝存在を明かさない） */
interface CandidateRow {
  id: string;
  unit_id: string;
  source_type: string;
  source_id: string;
  source_version: number;
  question_version: string;
  output_json: string;
  status: string;
}

/** 確定分類の書込先（issues.confirmed_category。docs/04:117） */
interface CategoryTarget {
  issueId: string;
  issueVersion: number;
  currentCategory: string | null;
}

/** SQL式（permission条件の合成に使う。executeMutationのconditionsは1条件=1文のため） */
interface SqlExpr {
  sql: string;
  binds: unknown[];
}

/**
 * 権限条件（authorize.tsの流儀をSQLで同batch再検査する）: unitWide（幹部・管理者）または
 * 担当scope（対象ID付き。operator役割＋有効なscope行＋permission一致）。対象IDの無い操作は
 * unitWideのみ（API-63/68と同じ対象の渡し方を反映）。失敗は403 FORBIDDEN。
 */
function permissionExpr(
  p: { memberId: string; unitId: string },
  code: PermissionCode,
  target: { type: string; id?: string },
  nowIso: string,
): SqlExpr {
  const binds: unknown[] = [p.memberId, p.unitId];
  let sql =
    "(EXISTS (SELECT 1 FROM member_roles mr JOIN roles r ON r.id = mr.role_id " +
    "WHERE mr.member_id = ? AND mr.unit_id = ? AND mr.revoked_at IS NULL AND r.code IN ('officer','admin'))";
  if (target.id) {
    sql +=
      " OR EXISTS (SELECT 1 FROM scope_assignments s JOIN json_each(s.permissions) jp ON jp.value = ? " +
      "WHERE s.member_id = ? AND s.unit_id = ? AND s.entity_type = ? AND s.entity_id = ? AND s.revoked_at IS NULL " +
      "AND (s.expires_at IS NULL OR s.expires_at > ?) " +
      "AND EXISTS (SELECT 1 FROM member_roles mr2 JOIN roles r2 ON r2.id = mr2.role_id " +
      "WHERE mr2.member_id = s.member_id AND mr2.unit_id = s.unit_id AND mr2.revoked_at IS NULL AND r2.code = 'operator'))";
    binds.push(code, p.memberId, p.unitId, target.type, target.id, nowIso);
  }
  return { sql: `${sql})`, binds };
}

const asCondition = (expr: SqlExpr, failCode: ExtraCondition["failCode"]): ExtraCondition => ({
  existsSql: `SELECT 1 WHERE ${expr.sql}`,
  binds: expr.binds,
  failCode,
});

/** 元版の再検査（点検はseries版・異常はissue版。API-29の受付と同じ版の定義）。失敗は409 */
function sourceFreshCondition(sourceType: string, sourceId: string, unitId: string, sourceVersion: number): ExtraCondition {
  if (sourceType === "issue") {
    return {
      existsSql: "SELECT 1 FROM issues WHERE id = ? AND unit_id = ? AND version = ?",
      binds: [sourceId, unitId, sourceVersion],
      failCode: "VERSION_CONFLICT",
    };
  }
  if (sourceType === "facility_inspection" || sourceType === "asset_inspection") {
    const table = sourceType === "facility_inspection" ? "facility_inspections" : "asset_inspections";
    return {
      existsSql:
        `SELECT 1 FROM ${table} i JOIN inspection_series s ON s.id = i.series_id AND s.unit_id = i.unit_id ` +
        "WHERE i.id = ? AND i.unit_id = ? AND s.version = ?",
      binds: [sourceId, unitId, sourceVersion],
      failCode: "VERSION_CONFLICT",
    };
  }
  throw new HttpError("NOT_FOUND"); // source_typeはDBのCHECKで保証される（到達しない）
}

/** 確定分類の書込先を決める（docs/05 API-31行の効果先。T054裁定）:
 *  issue源はその異常、点検源は異常起票を伴う場合だけlinked issue（起票は高々1つ）。 */
async function resolveCategoryTarget(env: AppEnv["DB"], unitId: string, sourceType: string, sourceId: string): Promise<CategoryTarget | null> {
  if (sourceType === "issue") {
    const row = await env.prepare("SELECT id, version, confirmed_category FROM issues WHERE id = ? AND unit_id = ?")
      .bind(sourceId, unitId).first<{ id: string; version: number; confirmed_category: string | null }>();
    return row ? { issueId: row.id, issueVersion: row.version, currentCategory: row.confirmed_category } : null;
  }
  const col = sourceType === "facility_inspection" ? "source_facility_inspection_id" : "source_asset_inspection_id";
  const rows = (
    await env.prepare(`SELECT id, version, confirmed_category FROM issues WHERE ${col} = ? AND unit_id = ?`)
      .bind(sourceId, unitId).all<{ id: string; version: number; confirmed_category: string | null }>()
  ).results;
  // 起点は高々一つ（docs/04:117）。複数ある場合は書込先を決められないため決定の保存だけにする
  return rows.length === 1 ? { issueId: rows[0]!.id, issueVersion: rows[0]!.version, currentCategory: rows[0]!.confirmed_category } : null;
}

/** AI候補の代表分類（confirmedCategory省略時の確定値。docs/04:143 output_json=候補本体） */
function representativeOf(outputJson: string): string {
  const parsed = JSON.parse(outputJson) as { categories?: { representative?: string } };
  return parsed.categories?.representative ?? "other";
}

/** confirmedPayloadの検査（未知キー400＝注入を効果に変えない。rejectは効果なし） */
function parseConfirmedPayload(decision: keyof typeof STORED_DECISION, raw: Record<string, unknown>): ConfirmedPayload {
  const result = ConfirmedPayloadInput.safeParse(raw);
  if (!result.success) {
    // 未知キー（strictのunrecognized_keys）はpathが空でキー名がmessage側に現れるため、
    // docs/05 §1のdetails形式（{field, reason}）へ正規化する
    const details = result.error.issues.map((i) => {
      const unknownKey = i.code === "unrecognized_keys" ? /Unrecognized key: "([^"]+)"/.exec(i.message)?.[1] : undefined;
      if (unknownKey) return { field: `confirmedPayload.${[...i.path, unknownKey].join(".")}`, reason: "unknown_field" };
      return { field: `confirmedPayload.${i.path.join(".")}`, reason: i.message };
    });
    throw new HttpError("VALIDATION_ERROR", undefined, details);
  }
  if (decision === "reject" && (result.data.confirmedCategory || result.data.task || result.data.notification)) {
    throw new HttpError("VALIDATION_ERROR", undefined, [{ field: "confirmedPayload", reason: "reject_has_no_effects" }]);
  }
  return result.data;
}

/** 通知draftの宛先参照（T050と同じ規約。班による到達不明の試験値を含む） */
async function addressRefsFor(ctx: ApiContext, audienceMemberIds: readonly string[]): Promise<Map<string, string | null>> {
  if (audienceMemberIds.length === 0) return new Map();
  const rows = (
    await ctx.env.DB.prepare(`SELECT id, squad FROM members WHERE id IN (${audienceMemberIds.map(() => "?").join(",")})`)
      .bind(...audienceMemberIds).all<{ id: string; squad: string | null }>()
  ).results;
  return new Map(rows.map((r) => [r.id, r.squad]));
}

/**
 * AI提案の決定（API-31）。docs/16 T054のInterface。応答は決定ID・保存語彙・効果IDの
 * 一覧（effectIds＝review_decisions＋作成したタスク/通知draftのID。effectIds[0]が決定）。
 */
export async function decideAiProposal(ctx: ApiContext, input: ApiRequest<"API-31">): Promise<ApiResponse<"API-31">> {
  const p = await resolvePrincipal(ctx);
  const { params, body, headers } = input;

  // docs/05 §2「同じキー/本文の再送は元HTTP status/dataを返す」: 鍵が既にある（=再送）ときは
  // 状態前提の検査（担当の現在有効）を飛ばし、初回の200と同じ応答をexecuteMutationの
  // resolveExistingへ任せる（T041流儀。初回成功後に担当が休団・退団しても再送は422にならない。
  // 同キー別本文はIDEMPOTENCY_MISMATCH、失権は403のまま。候補の実在検査は候補行が追記型で
  // 消えないため再送でも同じ結果。stale検査はconditions側で新規実行だけが行う）
  const knownKey = await ctx.env.DB.prepare(
    "SELECT 1 FROM idempotency_records WHERE actor_user_id = ? AND operation_code = ? AND idempotency_key = ?",
  ).bind(p.userId, "ai_review.decision", headers["idempotency-key"]).first();

  // --- 提案の実在・同unit（存在しない/別unitは同じ404） ---
  const candidate = await ctx.env.DB.prepare(
    "SELECT id, unit_id, source_type, source_id, source_version, question_version, output_json, status FROM ai_evaluations WHERE id = ?",
  ).bind(params.id).first<CandidateRow>();
  if (!candidate || candidate.unit_id !== p.unitId) throw new HttpError("NOT_FOUND");

  // 提案版（docs/06 §3「承認要求はsourceVersion/proposalVersionを含む」）。提案は追記型で
  // 1提案=1行のため初回決定の前提版は常に1。1以外は409（決定の訂正はdocs/11「旧決定書換なし」の対象外）
  if (body.version !== 1) {
    throw new HttpError("VERSION_CONFLICT", undefined, [{ field: "version", reason: "proposal_version_stale" }]);
  }
  // 質問版の再検査（廃止された質問版の候補は採用できない＝stale/409）
  if (!isKnownQuestionVersion(candidate.question_version)) {
    throw new HttpError("VERSION_CONFLICT", undefined, [{ field: "questionVersion", reason: "unknown_question_version" }]);
  }

  const storedDecision = STORED_DECISION[body.decision];
  const confirmed = parseConfirmedPayload(body.decision, body.confirmedPayload);

  // 決定理由（review_decisions.reasonは1〜2000。却下は理由必須、承認は既定文）
  const reason = body.reviewNote?.trim() || (body.decision === "reject" ? "" : DEFAULT_REASON[body.decision]);
  if (!reason) throw new HttpError("VALIDATION_ERROR", undefined, [{ field: "reviewNote", reason: "reason_required" }]);
  if (reason.length > REASON_MAX) throw new HttpError("VALIDATION_ERROR", undefined, [{ field: "reviewNote", reason: "too_long" }]);

  // --- 表示権限と業務変更権の別検査（route側。承認対象＝元の対象に対するPER-10） ---
  requirePermission(p, "PER-10", { unitId: p.unitId, type: candidate.source_type, id: candidate.source_id });

  // --- 効果の組み立て（confirm分類/タスク/通知draft。rejectは効果0） ---
  const categoryTarget = body.decision === "reject" ? null : await resolveCategoryTarget(ctx.env.DB, p.unitId, candidate.source_type, candidate.source_id);
  const confirmedCategory =
    body.decision === "reject" ? undefined : (confirmed.confirmedCategory ?? representativeOf(candidate.output_json));

  // 反映先の書込権（確定分類=PER-05。docs/10 PER-10「承認対象と反映先の両書込権」）
  if (categoryTarget) {
    requirePermission(p, "PER-05", { unitId: p.unitId, type: "issue", id: categoryTarget.issueId });
  }

  // タスク（API-68と同じ権限の和集合と担当条件。docs/05 API-68「PER-04/10」）
  if (confirmed.task) {
    const asReport = authorize(p, "PER-04", { unitId: p.unitId, type: "task" });
    const asApproval = authorize(p, "PER-10", { unitId: p.unitId, type: "task" });
    if (!asReport.allowed && !asApproval.allowed) {
      throw new HttpError("FORBIDDEN", undefined, [{ field: "permission", reason: asReport.reason }]);
    }
    // 担当の現在有効検査は新規実行のときだけ（再送では保存済み応答を返す。A中1の鍵先読み）
    if (!knownKey && confirmed.task.assigneeMemberId) {
      const m = await ctx.env.DB.prepare("SELECT unit_id, status FROM members WHERE id = ?").bind(confirmed.task.assigneeMemberId)
        .first<{ unit_id: string; status: string }>();
      if (!m || m.unit_id !== p.unitId) throw new HttpError("NOT_FOUND");
      if (m.status !== "active") {
        throw new HttpError("INVALID_TRANSITION", undefined, [{ field: "assigneeMemberId", reason: "assignee_not_active" }]);
      }
    }
  }

  // 通知draft（T050の提案組み立てまで。送信はAPI-64の別承認。docs/06 §3）
  const nowIso = new Date().toISOString();
  let notifProposal: NotificationDraftProposal | null = null;
  let notifExpiresAt: string | null = null;
  let notifSquads = new Map<string, string | null>();
  if (confirmed.notification) {
    requirePermission(p, "PER-12", { unitId: p.unitId, type: "notification" });
    notifProposal = await buildNotificationDraft(ctx, {
      unitId: p.unitId,
      source: confirmed.notification.source,
      body: confirmed.notification.body,
      audienceMemberIds: confirmed.notification.audienceMemberIds,
      channels: confirmed.notification.channels,
    });
    notifExpiresAt = confirmed.notification.expiresAt ?? null;
    notifSquads = await addressRefsFor(ctx, notifProposal.audienceMemberIds);
  }

  // 承認固定hash（audience_hash。API-64の承認が一致を要求する＝通知の対象/本文の承認固定に使う）
  const notifAudienceHash = notifProposal ? await sha256Hex(canonicalJson(notifProposal.audienceMemberIds)) : null;

  // --- IDを採番し、effectIdsを確定させておく（応答はbatch内のSQLで組み立てる） ---
  const decisionId = crypto.randomUUID();
  const effectOperationId = body.decision === "reject" ? null : crypto.randomUUID();
  const taskId = confirmed.task ? crypto.randomUUID() : null;
  const notificationId = notifProposal ? crypto.randomUUID() : null;
  const effectIds = [decisionId, ...(taskId ? [taskId] : []), ...(notificationId ? [notificationId] : [])];

  // --- 同batchのconditions（stale検査＋権限の再検査。docs/16 T054裁定） ---
  const conditions: ExtraCondition[] = [
    // 候補版・質問版・pendingの再検査（引用したsourceVersionが候補自身の版であることも含む）
    {
      existsSql:
        "SELECT 1 FROM ai_evaluations WHERE id = ? AND unit_id = ? AND status = 'pending' AND source_version = ? AND question_version = ?",
      binds: [candidate.id, p.unitId, body.sourceVersion, candidate.question_version],
      failCode: "VERSION_CONFLICT",
    },
    // 元版の再検査（点検=series版・異常=issue版の現行version）
    sourceFreshCondition(candidate.source_type, candidate.source_id, p.unitId, body.sourceVersion),
    // 承認者の権限（PER-10）を同batchで再検査（scopeの取消はここでも403にする）
    asCondition(permissionExpr(p, "PER-10", { type: candidate.source_type, id: candidate.source_id }, nowIso), "FORBIDDEN"),
  ];
  if (categoryTarget) {
    // 反映先の書込権（確定分類=PER-05）
    conditions.push(asCondition(permissionExpr(p, "PER-05", { type: "issue", id: categoryTarget.issueId }, nowIso), "FORBIDDEN"));
  }
  if (confirmed.task) {
    // タスク作成はPER-04またはPER-10の和集合（API-68のrequireTaskPermissionと同じ）
    const asReport = permissionExpr(p, "PER-04", { type: "task" }, nowIso);
    const asApproval = permissionExpr(p, "PER-10", { type: "task" }, nowIso);
    conditions.push(asCondition({ sql: `${asReport.sql} OR ${asApproval.sql}`, binds: [...asReport.binds, ...asApproval.binds] }, "FORBIDDEN"));
  }
  if (notifProposal) {
    // 通知draftの作成権（PER-12）
    conditions.push(asCondition(permissionExpr(p, "PER-12", { type: "notification" }, nowIso), "FORBIDDEN"));
  }

  // 人の確定内容（生出力JSONとは別の保存。docs/06 §3「人の確定分類・理由・reviewedAtは生出力JSONと別保存」）
  const confirmedPayloadJson = JSON.stringify({
    ...(confirmedCategory ? { confirmedCategory } : {}),
    ...(confirmed.task ? { task: confirmed.task } : {}),
    ...(notifProposal ? { notification: { sourceType: notifProposal.sourceType, sourceId: notifProposal.sourceId, audienceCount: notifProposal.audienceMemberIds.length } } : {}),
    ...(categoryTarget ? { categoryTargetIssueId: categoryTarget.issueId } : {}),
  });

  const result = await executeMutation(ctx.env, p, {
    operationCode: "ai_review.decision",
    key: headers["idempotency-key"],
    requestHash: await canonicalRequestHash({ method: "POST", path: `/ai/reviews/${params.id}/decision`, body }),
    expectedAuthzVersion: p.authzVersion,
    // 確定分類の書込先があるときだけroot（issuesの比較更新。競合は409）
    roots: categoryTarget ? [{ table: "issues", id: categoryTarget.issueId, expectedVersion: categoryTarget.issueVersion }] : [],
    created: [
      { table: "review_decisions", id: decisionId },
      ...(taskId ? [{ table: "tasks", id: taskId }] : []),
      ...(notificationId ? [{ table: "notifications", id: notificationId }] : []),
    ],
    // 二重決定（evaluation_id UNIQUE）・二重効果（effect_operation_id UNIQUE）は業務上の重複=409
    duplicateOn: ["index:uq_review_decision_evaluation", "index:uq_review_decision_effect", "index:uq_task_effect_operation"],
    conditions,
    statements: (mctx) => [
      // ①決定1行（対象ちょうど一つ＝docs/04:145。却下はeffect_operation_id NULL）
      ctx.env.DB.prepare(
        "INSERT INTO review_decisions (id, unit_id, evaluation_id, decision, confirmed_payload, reviewer_member_id, reviewed_at, reason, effect_operation_id, last_mutation_token, created_at, updated_at, created_by, actor_kind) " +
          "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'human')",
      ).bind(decisionId, p.unitId, candidate.id, storedDecision, confirmedPayloadJson, p.memberId, mctx.now, reason, effectOperationId, mctx.attempt, mctx.now, mctx.now, p.userId),
      // ②提案の状態遷移（docs/04:143「遷移はT054以降」。pendingからだけ。生出力JSONは書換ない）
      ctx.env.DB.prepare("UPDATE ai_evaluations SET status = ? WHERE id = ? AND unit_id = ? AND status = 'pending'")
        .bind(storedDecision, candidate.id, p.unitId),
      // ③確定分類（異常側。confirmed_categoryは人の確定。生出力JSONとは別）
      ...(categoryTarget && confirmedCategory
        ? [
            ctx.env.DB.prepare(
              "UPDATE issues SET confirmed_category = ?, version = version + 1, last_mutation_token = ?, updated_at = ? " +
                "WHERE id = ? AND unit_id = ? AND version = ?",
            ).bind(confirmedCategory, mctx.attempt, mctx.now, categoryTarget.issueId, p.unitId, categoryTarget.issueVersion),
            ctx.env.DB.prepare(
              "INSERT INTO issue_events (id, unit_id, issue_id, action, before_json, after_json, note, actor_user_id, actor_kind, created_at) " +
                "VALUES (?, ?, ?, 'category.confirmed', ?, ?, NULL, ?, 'human', ?)",
            ).bind(
              crypto.randomUUID(), p.unitId, categoryTarget.issueId,
              JSON.stringify({ confirmedCategory: categoryTarget.currentCategory }),
              JSON.stringify({ confirmedCategory, decisionId }),
              p.userId, mctx.now,
            ),
          ]
        : []),
      // ④タスク（T049のtaskEffectStatements＝buildTaskEffectと同じ文。承認effectから＝docs/11）
      ...(confirmed.task && taskId
        ? taskEffectStatements(
            { env: ctx.env, unitId: p.unitId, actorUserId: p.userId, mutation: mctx },
            {
              decisionId,
              evaluationId: candidate.id,
              effectOperationId: effectOperationId!,
              sourceIssueId: categoryTarget?.issueId ?? null,
              title: confirmed.task.title,
              assigneeMemberId: confirmed.task.assigneeMemberId ?? null,
              dueDate: confirmed.task.dueDate ?? null,
            },
            taskId,
          )
        : []),
      // ⑤通知draft（draftまで。配送jobは作らない＝自動送信0。送信はAPI-64の別承認）
      ...(notifProposal && notificationId
        ? [
            ctx.env.DB.prepare(
              "INSERT INTO notifications (id, unit_id, source_type, source_id, body_revision, audience_hash, status, expires_at, last_mutation_token, created_at, updated_at, created_by, actor_kind) " +
                "VALUES (?, ?, ?, ?, ?, ?, 'draft', ?, ?, ?, ?, ?, 'human')",
            ).bind(notificationId, p.unitId, notifProposal.sourceType, notifProposal.sourceId, JSON.stringify({ body: notifProposal.body }), notifAudienceHash, notifExpiresAt, mctx.attempt, mctx.now, mctx.now, p.userId),
            ...notifProposal.audienceMemberIds.flatMap((memberId) =>
              notifProposal!.channels.map((channel) =>
                ctx.env.DB.prepare(
                  "INSERT INTO notification_recipients (id, unit_id, notification_id, member_id, channel, address_ref, actor_user_id, actor_kind, created_at) " +
                    "VALUES (?, ?, ?, ?, ?, ?, ?, 'human', ?)",
                ).bind(crypto.randomUUID(), p.unitId, notificationId, memberId, channel, addressRefFor(channel, memberId, notifSquads.get(memberId) ?? null), p.userId, mctx.now),
              ),
            ),
            ctx.env.DB.prepare(
              "INSERT INTO notification_events (id, unit_id, notification_id, action, details, actor_user_id, actor_kind, created_at) " +
                "VALUES (?, ?, ?, 'draft.created', ?, ?, 'human', ?)",
            ).bind(crypto.randomUUID(), p.unitId, notificationId, JSON.stringify({ sourceType: notifProposal.sourceType, audienceCount: notifProposal.audienceMemberIds.length, channels: notifProposal.channels.join(","), decisionId }), p.userId, mctx.now),
          ]
        : []),
    ],
    audit: {
      action: "ai_review.decision", entityType: "ai_evaluation", entityId: candidate.id,
      metadata: {
        decision: storedDecision,
        ...(effectOperationId ? { effectOperationId } : {}),
        ...(taskId ? { effectTask: 1 } : {}),
        ...(notificationId ? { effectNotification: 1 } : {}),
        ...(categoryTarget ? { effectCategory: 1 } : {}),
      },
    },
    event: {
      entityType: "ai_evaluation", entityId: candidate.id, entityVersion: 1,
      eventType: "ai_review.decided", payload: { decision: storedDecision },
    },
    response: {
      status: 200,
      sql: `SELECT json_object('decisionId', ?, 'decision', ?, 'effectIds', json_array(${effectIds.map(() => "?").join(",")}))`,
      binds: [decisionId, storedDecision, ...effectIds],
      decode: (j) => j as ApiResponse<"API-31">,
    },
  });
  return result.data;
}
