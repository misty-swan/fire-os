import {
  ActivityResult,
  ActivityResultHistory,
  type ActivityResultDto,
  type ActivityResultParticipantDto,
  type ActivityResultRevisionDto,
} from "../../shared/contracts/operations";
import { planAttachmentLinks } from "../attachments/link";
import { resolvePrincipal } from "../auth/principal";
import type { AppEnv } from "../env";
import { HttpError, defineRoute, ok, parseApiRequest, type ApiApp } from "../http";
import { canonicalRequestHash } from "../mutations/hash";
import { executeMutation, type MutationSpec } from "../mutations/execute";
import { requirePermission } from "./invitations";

/**
 * 活動実績・実参加・訂正版（T037、docs/05 API-09/42/43、docs/04:91〜93、docs/11 実参加・§3、docs/10 PER-04、docs/14 D05）。
 * - 実績root（activity_results）は1活動1件（activity_id UNIQUE。docs/05 API-09「未作成のみ」。同時初回作成も409）。
 * - 訂正は原本revisionを不変のまま新revisionを作り、current_revision_idの切替をresultの版（resultVersion）ガード付き
 *   比較更新で行う（docs/11 §3「現在版pointerの切替もversionガード」。T031の点検訂正と同じ系。並行訂正は片方だけ）。
 * - 出欠（activity_attendance）と実参加（activity_actual_participants）は別物で、回答を実参加へコピーしない（docs/11 実参加行）。
 * - 全体時間（actual_*_at）と個人時間（individual_*_at）は別列。不明はNULLで保留し捏造しない（docs/04:92/93）。
 * - 実績の作成・訂正はactivities行（planned時刻・出欠・status・版）を一切変更しない。代わりに、読んだ予定の版
 *   （activityVersion）が今も有効かをbatch内の前提条件で検査する（activitiesは更新しないのでrootガードにできない）。
 * - 添付はready検査済みだけを活動へリンクする（docs/10 §3。activityはbasicの対象。点検・異常のみsensitive）。
 */

type ActualInputBody = {
  content: string;
  actualStartsAt?: string;
  actualEndsAt?: string;
  participants: {
    memberId: string;
    actualStatus: string;
    individualStartsAt?: string;
    individualEndsAt?: string;
  }[];
  attachmentIds: string[];
};

/** 時刻順序（docs/04:92「両時刻存在時ends>=starts」。DBのCHECKと同じ規則を入力で先に見て400にする） */
const endsBeforeStart = (startsAt?: string, endsAt?: string) =>
  startsAt !== undefined && endsAt !== undefined && endsAt < startsAt;

/**
 * ActualInputの業務検査（docs/05 §3「未知時刻は欠落表示」）。全体時間と個人時間の逆順は400、
 * 同一団員の重複はUNIQUE違反を500にしないため400にする。
 */
function validateActualInput(body: ActualInputBody): void {
  if (endsBeforeStart(body.actualStartsAt, body.actualEndsAt)) {
    throw new HttpError("VALIDATION_ERROR", undefined, [{ field: "actualEndsAt", reason: "end_before_start" }]);
  }
  const seen = new Set<string>();
  body.participants.forEach((participant, i) => {
    if (seen.has(participant.memberId)) {
      throw new HttpError("VALIDATION_ERROR", undefined, [{ field: `participants.${i}`, reason: "duplicate_member" }]);
    }
    seen.add(participant.memberId);
    if (endsBeforeStart(participant.individualStartsAt, participant.individualEndsAt)) {
      throw new HttpError("VALIDATION_ERROR", undefined, [
        { field: `participants.${i}.individualEndsAt`, reason: "end_before_start" },
      ]);
    }
  });
}

/** 実績の版1件（参加行込み）をSQLで組立てる（応答はbatch内のSQLが組み立てるため。activities.tsのACTIVITY_JSONと同じ方式） */
const revisionJson = (v: string) =>
  `json_object('id', ${v}.id, 'resultId', ${v}.result_id, 'revisionNo', ${v}.revision_no, ` +
  `'actualStartsAt', ${v}.actual_starts_at, 'actualEndsAt', ${v}.actual_ends_at, 'content', ${v}.content, ` +
  `'supersedesId', ${v}.supersedes_id, 'correctionReason', ${v}.correction_reason, 'createdAt', ${v}.created_at, ` +
  `'participants', (SELECT json_group_array(json_object('memberId', t.member_id, 'actualStatus', t.actual_status, ` +
  `'individualStartsAt', t.individual_starts_at, 'individualEndsAt', t.individual_ends_at)) FROM ` +
  `(SELECT member_id, actual_status, individual_starts_at, individual_ends_at FROM activity_actual_participants ` +
  `WHERE result_revision_id = ${v}.id ORDER BY member_id) t))`;

const RESULT_JSON =
  `SELECT json_object('id', r.id, 'activityId', r.activity_id, 'version', r.version, ` +
  `'currentRevisionId', r.current_revision_id, 'createdAt', r.created_at, 'updatedAt', r.updated_at, ` +
  `'currentRevision', (SELECT ${revisionJson("v")} FROM activity_result_revisions v WHERE v.id = r.current_revision_id)) ` +
  `FROM activity_results r WHERE r.id = ?`;

interface ResultRow {
  id: string; unit_id: string; activity_id: string; current_revision_id: string;
  version: number; created_at: string; updated_at: string;
}
interface RevisionRow {
  id: string; unit_id: string; result_id: string; revision_no: number;
  actual_starts_at: string | null; actual_ends_at: string | null; content: string;
  supersedes_id: string | null; correction_reason: string | null; created_at: string;
}
interface ParticipantRow {
  result_revision_id: string; member_id: string; actual_status: string;
  individual_starts_at: string | null; individual_ends_at: string | null;
}

const toParticipant = (r: ParticipantRow): ActivityResultParticipantDto => ({
  memberId: r.member_id,
  actualStatus: r.actual_status as ActivityResultParticipantDto["actualStatus"],
  individualStartsAt: r.individual_starts_at,
  individualEndsAt: r.individual_ends_at,
});

const toRevision = (r: RevisionRow, participants: ParticipantRow[]): ActivityResultRevisionDto => ({
  id: r.id,
  resultId: r.result_id,
  revisionNo: r.revision_no,
  actualStartsAt: r.actual_starts_at,
  actualEndsAt: r.actual_ends_at,
  content: r.content,
  supersedesId: r.supersedes_id,
  correctionReason: r.correction_reason,
  participants: participants.map(toParticipant),
  createdAt: r.created_at,
});

const toResult = (r: ResultRow, currentRevision: ActivityResultRevisionDto): ActivityResultDto => ({
  id: r.id,
  activityId: r.activity_id,
  version: r.version,
  currentRevisionId: r.current_revision_id,
  currentRevision,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});

/** あるunitの活動の現在実績（訂正版＋参加行）を読む。無ければnull（API-07の詳細へ載せる） */
export async function loadActivityResult(env: AppEnv, unitId: string, activityId: string): Promise<ActivityResultDto | null> {
  const root = await env.DB.prepare("SELECT * FROM activity_results WHERE unit_id = ? AND activity_id = ?")
    .bind(unitId, activityId).first<ResultRow>();
  if (!root) return null;
  const revision = await env.DB.prepare("SELECT * FROM activity_result_revisions WHERE id = ?")
    .bind(root.current_revision_id).first<RevisionRow>();
  if (!revision) throw new HttpError("INTERNAL_ERROR"); // ポインタは同親の版のみを指す（docs/04:91）
  const participants = (
    await env.DB.prepare(
      "SELECT result_revision_id, member_id, actual_status, individual_starts_at, individual_ends_at " +
        "FROM activity_actual_participants WHERE result_revision_id = ? ORDER BY member_id",
    ).bind(revision.id).all<ParticipantRow>()
  ).results;
  return ActivityResult.parse(toResult(root, toRevision(revision, participants)));
}

/** 対象snapshotの団員だけを実参加にできる（docs/04 activity_audience。別unit/対象外は存在を明かさず404） */
const audienceCondition = (activityId: string, memberId: string) => ({
  existsSql: "SELECT 1 FROM activity_audience WHERE activity_id = ? AND member_id = ?",
  binds: [activityId, memberId],
  failCode: "NOT_FOUND" as const,
});

/** 参加行のINSERT（revision1件ぶん。単価はACTIVITYのaudienceInsertと同じ形） */
const participantInsert = (
  env: AppEnv, unitId: string, revisionId: string, userId: string, now: string,
  participant: ActualInputBody["participants"][number],
) =>
  env.DB.prepare(
    "INSERT INTO activity_actual_participants (id, unit_id, result_revision_id, member_id, actual_status, individual_starts_at, individual_ends_at, created_at, created_by, actor_kind) " +
      "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'human')",
  ).bind(
    crypto.randomUUID(), unitId, revisionId, participant.memberId, participant.actualStatus,
    participant.individualStartsAt ?? null, participant.individualEndsAt ?? null, now, userId,
  );

export function registerActivityResultRoutes(app: ApiApp): void {
  // --- API-09: 実績の作成（未作成のみ。root/re版/実参加/添付リンクを同じbatchで確定） ---
  defineRoute(app, "API-09", async (c) => {
    const p = await resolvePrincipal(c);
    const { params, body, headers } = await parseApiRequest(c, "API-09");
    const activity = await c.env.DB.prepare("SELECT unit_id, owner_member_id FROM activities WHERE id = ?").bind(params.id)
      .first<{ unit_id: string; owner_member_id: string }>();
    if (!activity || activity.unit_id !== p.unitId) throw new HttpError("NOT_FOUND");
    requirePermission(p, "PER-04", { unitId: p.unitId, type: "activity", id: params.id, ownerMemberId: activity.owner_member_id });
    validateActualInput(body);

    // docs/05 §2「同じキー/本文の再送は元HTTP status/dataを返し」: 鍵が既にある（=再送の）ときは
    // 現在の状態では不可になる変更（既存rootの再作成）でも保存済み応答を返す必要があるため、
    // 新しい操作のときだけ「未作成のみ」の状態前提を検査してからbatchに入る（T041/T042と同じ流儀）
    const knownKey = await c.env.DB.prepare(
      "SELECT 1 FROM idempotency_records WHERE actor_user_id = ? AND operation_code = ? AND idempotency_key = ?",
    ).bind(p.userId, "activity.result.create", headers["idempotency-key"]).first();

    // 未作成のみ（docs/05 API-09）。再作成は409。同時の初回作成はUNIQUE(unit,activity)＋duplicateOnでも409
    const existing = knownKey
      ? null
      : await c.env.DB.prepare("SELECT id FROM activity_results WHERE unit_id = ? AND activity_id = ?")
          .bind(p.unitId, params.id).first<{ id: string }>();
    if (existing) throw new HttpError("DUPLICATE");

    const resultId = crypto.randomUUID();
    const revisionId = crypto.randomUUID();
    const link = (body.attachmentIds?.length ?? 0) > 0
      ? await planAttachmentLinks(c.env, p.unitId, p.userId, {
          target: { type: "activity", id: params.id },
          attachmentIds: body.attachmentIds,
        })
      : null;

    const spec: MutationSpec<unknown> = {
      operationCode: "activity.result.create",
      key: headers["idempotency-key"],
      requestHash: await canonicalRequestHash({ method: "POST", path: `/activities/${params.id}/actual-results`, body }),
      expectedAuthzVersion: p.authzVersion,
      roots: [],
      // activity_result_revisionsは追記専用でlast_mutation_tokenを持たないため、created検査はrootで代用する
      // （同一batchなのでrootの作成検査が通れば版のINSERTも確定している。activities.tsの対象snapshotと同じ扱い）
      created: [{ table: "activity_results", id: resultId }],
      conditions: [
        // 実績は予定の行を更新しない（AT-ACT-03「予定不変」）。代わりに読んだ予定の版が今も有効かをbatch内で検査する
        {
          existsSql: "SELECT 1 FROM activities WHERE id = ? AND unit_id = ? AND version = ?",
          binds: [params.id, p.unitId, body.activityVersion],
          failCode: "VERSION_CONFLICT",
        },
        ...body.participants.map((participant) => audienceCondition(params.id, participant.memberId)),
        ...(link?.conditions ?? []),
      ],
      statements: (ctx) => [
        // root。current_revision_idは作成と同時に初版へ向ける（docs/04:91「revision pointerは同親の版のみ」）
        c.env.DB.prepare(
          "INSERT INTO activity_results (id, unit_id, activity_id, current_revision_id, version, last_mutation_token, created_at, updated_at, created_by, actor_kind) " +
            "VALUES (?, ?, ?, ?, 1, ?, ?, ?, ?, 'human')",
        ).bind(resultId, p.unitId, params.id, revisionId, ctx.attempt, ctx.now, ctx.now, p.userId),
        // 初版（revision_no=1）。訂正元と理由は持たない（docs/04:92「訂正は理由必須」は訂正版のみ）
        c.env.DB.prepare(
          "INSERT INTO activity_result_revisions (id, unit_id, result_id, revision_no, actual_starts_at, actual_ends_at, content, supersedes_id, correction_reason, actor_user_id, actor_kind, created_at) " +
            "VALUES (?, ?, ?, 1, ?, ?, ?, NULL, NULL, ?, 'human', ?)",
        ).bind(revisionId, p.unitId, resultId, body.actualStartsAt ?? null, body.actualEndsAt ?? null, body.content, p.userId, ctx.now),
        ...body.participants.map((participant) => participantInsert(c.env, p.unitId, revisionId, p.userId, ctx.now, participant)),
        ...(link ? link.statements(ctx) : []),
      ],
      audit: {
        action: "activity.result.create", entityType: "activity_result", entityId: resultId,
        metadata: { activityId: params.id, participants: body.participants.length },
      },
      event: { entityType: "activity_result", entityId: resultId, entityVersion: 1, eventType: "activity_result.created", payload: { activityId: params.id } },
      duplicateOn: [
        // 1活動1実績（docs/04:91「activity_id UNIQUE」。複合UNIQUEの全列を宣言する）
        "activity_results.unit_id", "activity_results.activity_id",
        ...(link ? link.duplicateOn : []),
      ],
      response: { status: 201, sql: RESULT_JSON, binds: [resultId], decode: (j) => ActivityResult.parse(j) },
    };
    const result = await executeMutation(c.env, p, spec);
    return ok(c, result.data, {}, 201);
  });

  // --- API-42: 訂正（新revision。原本不変。pointerの切替はresultの版ガード＋現在版条件） ---
  defineRoute(app, "API-42", async (c) => {
    const p = await resolvePrincipal(c);
    const { params, body, headers } = await parseApiRequest(c, "API-42");
    const activity = await c.env.DB.prepare("SELECT unit_id, owner_member_id FROM activities WHERE id = ?").bind(params.id)
      .first<{ unit_id: string; owner_member_id: string }>();
    if (!activity || activity.unit_id !== p.unitId) throw new HttpError("NOT_FOUND");
    requirePermission(p, "PER-04", { unitId: p.unitId, type: "activity", id: params.id, ownerMemberId: activity.owner_member_id });

    // 訂正対象の実績root。実績が無い活動の訂正は作成と混同させず404（作成はAPI-09）
    const root = await c.env.DB.prepare("SELECT * FROM activity_results WHERE unit_id = ? AND activity_id = ?")
      .bind(p.unitId, params.id).first<ResultRow>();
    if (!root) throw new HttpError("NOT_FOUND");
    const maxNo = await c.env.DB.prepare("SELECT MAX(revision_no) AS no FROM activity_result_revisions WHERE unit_id = ? AND result_id = ?")
      .bind(p.unitId, root.id).first<{ no: number | null }>();
    const nextRevisionNo = (maxNo?.no ?? 0) + 1;

    validateActualInput(body);
    const revisionId = crypto.randomUUID();
    const link = (body.attachmentIds?.length ?? 0) > 0
      ? await planAttachmentLinks(c.env, p.unitId, p.userId, {
          target: { type: "activity", id: params.id },
          attachmentIds: body.attachmentIds,
        })
      : null;

    const spec: MutationSpec<unknown> = {
      operationCode: "activity.result.correct",
      key: headers["idempotency-key"],
      requestHash: await canonicalRequestHash({ method: "POST", path: `/activities/${params.id}/actual-results/corrections`, body }),
      expectedAuthzVersion: p.authzVersion,
      roots: [
        // 現在版pointerの切替は版ガード付き比較更新（docs/11 §3）。並行訂正の第2はここで409になる
        { table: "activity_results", id: root.id, expectedVersion: body.resultVersion },
      ],
      conditions: [
        // 訂正元（supersedes_id）は現在版であること。読んだ後に他の訂正でpointerが進んでいたら409（docs/05 API-46と同じ系）
        {
          existsSql: "SELECT 1 FROM activity_results WHERE id = ? AND unit_id = ? AND current_revision_id = ?",
          binds: [root.id, p.unitId, root.current_revision_id],
          failCode: "VERSION_CONFLICT",
        },
        ...body.participants.map((participant) => audienceCondition(params.id, participant.memberId)),
        ...(link?.conditions ?? []),
      ],
      statements: (ctx) => [
        // 新訂正版。元版は一切更新しない（docs/11 §3「原本点検・実績版…UPDATEで書換えない」）
        c.env.DB.prepare(
          "INSERT INTO activity_result_revisions (id, unit_id, result_id, revision_no, actual_starts_at, actual_ends_at, content, supersedes_id, correction_reason, actor_user_id, actor_kind, created_at) " +
            "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'human', ?)",
        ).bind(
          revisionId, p.unitId, root.id, nextRevisionNo,
          body.actualStartsAt ?? null, body.actualEndsAt ?? null, body.content,
          root.current_revision_id, body.reason, p.userId, ctx.now,
        ),
        ...body.participants.map((participant) => participantInsert(c.env, p.unitId, revisionId, p.userId, ctx.now, participant)),
        c.env.DB.prepare(
          "UPDATE activity_results SET current_revision_id = ?, version = version + 1, last_mutation_token = ?, updated_at = ? " +
            "WHERE id = ? AND unit_id = ? AND version = ?",
        ).bind(revisionId, ctx.attempt, ctx.now, root.id, p.unitId, body.resultVersion),
        ...(link ? link.statements(ctx) : []),
      ],
      audit: {
        action: "activity.result.correct", entityType: "activity_result", entityId: root.id,
        metadata: { activityId: params.id, revisionNo: nextRevisionNo },
      },
      event: {
        entityType: "activity_result", entityId: root.id, entityVersion: body.resultVersion + 1,
        eventType: "activity_result.corrected", payload: { activityId: params.id, revisionNo: nextRevisionNo },
      },
      duplicateOn: [
        // 訂正枝は1つだけ（docs/04:92 supersedes_id UNIQUEの二重防御。競合は版ガードで先に409になる）
        "activity_result_revisions.supersedes_id",
        ...(link ? link.duplicateOn : []),
      ],
      response: { status: 201, sql: RESULT_JSON, binds: [root.id], decode: (j) => ActivityResult.parse(j) },
    };
    const result = await executeMutation(c.env, p, spec);
    return ok(c, result.data, {}, 201);
  });

  // --- API-43: 実績と版の取得（revision?で旧版も。docs/05:96「ActivityResult＋revisions」） ---
  defineRoute(app, "API-43", async (c) => {
    const p = await resolvePrincipal(c);
    const { params, query } = await parseApiRequest(c, "API-43");
    requirePermission(p, "PER-01", { unitId: p.unitId, type: "activity", id: params.id });
    const activity = await c.env.DB.prepare("SELECT unit_id FROM activities WHERE id = ?").bind(params.id)
      .first<{ unit_id: string }>();
    if (!activity || activity.unit_id !== p.unitId) throw new HttpError("NOT_FOUND");

    const root = await c.env.DB.prepare("SELECT * FROM activity_results WHERE unit_id = ? AND activity_id = ?")
      .bind(p.unitId, params.id).first<ResultRow>();
    if (!root) throw new HttpError("NOT_FOUND");
    // 全版と参加行を読んでから、応答に載せる版を絞る（revision指定は旧版も認可のうえ取得。docs/05:96）
    const all = (
      await c.env.DB.prepare("SELECT * FROM activity_result_revisions WHERE unit_id = ? AND result_id = ? ORDER BY revision_no")
        .bind(p.unitId, root.id).all<RevisionRow>()
    ).results;
    const ids = all.map((r) => r.id);
    const participantRows = ids.length === 0 ? [] : (
      await c.env.DB.prepare(
        `SELECT result_revision_id, member_id, actual_status, individual_starts_at, individual_ends_at FROM activity_actual_participants ` +
          `WHERE result_revision_id IN (${ids.map(() => "?").join(",")}) ORDER BY member_id`,
      ).bind(...ids).all<ParticipantRow>()
    ).results;
    const byRevision = new Map<string, ParticipantRow[]>();
    for (const row of participantRows) {
      const list = byRevision.get(row.result_revision_id) ?? [];
      list.push(row);
      byRevision.set(row.result_revision_id, list);
    }
    const revisions = all.map((r) => toRevision(r, byRevision.get(r.id) ?? []));
    const currentRevision = revisions.find((r) => r.id === root.current_revision_id);
    if (!currentRevision) throw new HttpError("INTERNAL_ERROR"); // ポインタは同親の版のみを指す（docs/04:91）
    const visible = query.revision === undefined ? revisions : revisions.filter((r) => r.revisionNo === query.revision);
    if (visible.length === 0) throw new HttpError("NOT_FOUND");

    const data = ActivityResultHistory.parse({
      result: toResult(root, currentRevision),
      revisions: visible,
    });
    return ok(c, data);
  });
}
