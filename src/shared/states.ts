// 状態辞書（docs/11 §2 の転記）。状態は自由文字列にせず、列挙とCHECKで制約する。
// 遷移表は「許可された辺」のみ。許可外は422 INVALID_TRANSITION、未知の状態は400。

export const locationVerificationStates = ["unverified", "pending", "verified", "rejected"] as const;
export const inspectionResults = ["ok", "needs_review", "unknown"] as const;
export const issueStates = ["reported", "under_review", "in_progress", "resolved", "closed"] as const;
export const activityStates = ["draft", "scheduled", "in_progress", "completed", "cancelled"] as const;
export const attendanceResponses = ["unanswered", "attending", "absent", "undecided"] as const;
export const actualParticipationStates = ["unconfirmed", "participated", "absent"] as const;
export const incidentStates = ["recording", "active", "closed", "voided"] as const;
export const incidentKinds = ["simulation", "training", "actual_record"] as const;
export const mobilizationStates = ["unconfirmed", "unavailable", "mobilizing", "arrived", "returned"] as const;
/** docs/04:100 resource_usages。cancelledは終端（行は残り、集計から外れる。docs/11 §3） */
export const resourceUsageStates = ["active", "cancelled"] as const;
/**
 * 車両・資機材のstatus（docs/11 §2の暫定扱い→T048で列挙。UI候補どおり 運用/在庫/修繕中/廃止）。
 * DBのCHECKはSQLiteが既存表へのALTER ADD CHECKを提供しないため追加せず、変更入力（API-48/50）で
 * 未知値を400にする。廃止の二重表現の正はarchived_at（サーバー側の廃止済み判定・超過検出のskipは
 * archived_at IS NOT NULL OR status='廃止' の両建て）、status='廃止'はUI/API値＝docs/14 D24。
 */
export const assetStatuses = ["運用", "在庫", "修繕中", "廃止"] as const;
/** docs/11 のAI処理ジョブ状態に、汎用ジョブ(T006)として stale(元版が変わり結果が使えない)を追加。 */
export const jobStates = ["queued", "running", "succeeded", "retry_wait", "manual_review", "cancelled", "stale"] as const;
export const aiProposalStates = ["pending", "approved", "approved_with_edit", "rejected", "stale"] as const;
export const taskStates = ["open", "assigned", "in_progress", "done", "cancelled"] as const;
export const contentVersionStates = ["draft", "in_review", "approved", "changes_requested", "superseded", "withdrawn"] as const;
export const attachmentStates = [
  "pending_upload", "uploaded", "checking", "ready", "rejected", "expired", "deleting", "deleted",
] as const;
export const announcementStates = ["draft", "published", "archived"] as const;
/**
 * 文書rootの状態（docs/04:149。docs/11「文書全体のstatusは各機能タスクで列挙とCHECKを追加」のT062実装。
 * D03未承認の検証設定）: draft=作成直後（版の承認はまだ）、approved=有効な承認版がある（RAG対象。
 * current_version_idが有効）、withdrawn=撤回（API-92。即時検索除外。終端）。
 * 承認（draft→approved）と撤回（draft/approved→withdrawn）の辺はT063が使う。T062では作成（draft）のみ。
 */
export const documentStates = ["draft", "approved", "withdrawn"] as const;
/**
 * document_chunks.index_status（T064で確定。docs/04:152、docs/06 §5。検索索引の処理状態で業務状態機械ではない。
 * D16の索引方式〔D1全文検索/Vectorizeの比較はT065/T066〕と一緒に使う）:
 * pending=抽出済みで索引化待ち（抽出直後の値。**検索可能を意味しない**。検索対象はT066が承認済み＋
 * authorizedDocumentVersionsで別途絞る）、indexed=T066の索引化が完了、removed=索引から外れた
 * （deindex/reindex・再抽出の後にT066が設定）。0027のCHECK語彙（未リリース連番のin-place追加。docs/16 T064）。
 */
export const documentChunkIndexStates = ["pending", "indexed", "removed"] as const;
/**
 * RAG回答のstatus（docs/04:154 rag_answers。docs/11 §2「RAG回答」行の転記＝正本。T067裁定1）:
 * answered=引用span検証と出力前ACL再検査を通った回答（citations>=1）、abstained=根拠不足・検索0件・
 * 引用span検証不可（限定retry後。引用0の固定文言）、withheld=出力前再検査で引用元が失権し回答を保留
 * （生成中の撤回を含む。answered→withheldの辺はdocs/16 T067「出力前再検査での失効」＝docs/11 §2）。
 * rag_answersは追記型（API-76は都度新行）で保存後の遷移は無い。0029のCHECK語彙も本列挙が正本。
 */
export const ragAnswerStates = ["answered", "abstained", "withheld"] as const;
export const notificationApprovalStates = ["draft", "approved", "cancelled", "dispatching", "finished", "failed"] as const;
/**
 * 配送（docs/04:141 notification_deliveries）。cancelledは「未送分の取消」（docs/11「未送分取消は
 * deliveries単位の取消」のT051実装。pending→cancelledのみで、送信済みを未送へ戻さない）。
 */
export const deliveryStates = ["pending", "sending", "provider_accepted", "failed", "unknown", "retry_wait", "cancelled"] as const;
/**
 * 通知チャネル（docs/14 D13「チャネル未承認」）。推奨案の「アプリ内」一経路（inapp）だけを
 * 検証設定として実装し（docs/07 §5「アプリ内通知＋Web Pushまたはemailの一経路」）、Web Push/emailの
 * 追加はD13の了承後にchannelの列挙・DBのCHECK・契約を一緒に拡げる（T050）。
 */
export const notificationChannels = ["inapp"] as const;
export const syncOperationStates = ["local_draft", "pending", "sending", "applied", "conflict", "rejected"] as const;
export const patrolPlanStates = ["draft", "confirmed", "cancelled"] as const;
/** docs/04 §3.1: 名簿の状態 */
export const memberStates = ["active", "paused", "retired"] as const;
export const reviewDecisions = ["approve", "approve_with_edit", "reject"] as const;

export type Transitions<S extends string> = Readonly<Record<S, readonly S[]>>;

export const locationVerificationTransitions: Transitions<(typeof locationVerificationStates)[number]> = {
  unverified: ["pending"],
  pending: ["verified", "rejected"],
  verified: ["unverified"],
  rejected: ["unverified"],
};
export const issueTransitions: Transitions<(typeof issueStates)[number]> = {
  reported: ["under_review"],
  under_review: ["in_progress", "closed"],
  in_progress: ["resolved"],
  resolved: ["closed", "in_progress"],
  closed: ["under_review"],
};
export const activityTransitions: Transitions<(typeof activityStates)[number]> = {
  draft: ["scheduled", "cancelled"],
  scheduled: ["in_progress", "cancelled"],
  in_progress: ["completed"],
  completed: ["in_progress"],
  cancelled: [],
};
export const actualParticipationTransitions: Transitions<(typeof actualParticipationStates)[number]> = {
  unconfirmed: ["participated", "absent"],
  participated: ["absent", "unconfirmed"],
  absent: ["participated", "unconfirmed"],
};
export const incidentTransitions: Transitions<(typeof incidentStates)[number]> = {
  recording: ["active", "closed", "voided"],
  active: ["closed"],
  closed: ["recording"],
  voided: [],
};
export const mobilizationTransitions: Transitions<(typeof mobilizationStates)[number]> = {
  unconfirmed: ["unavailable", "mobilizing", "arrived", "returned"],
  mobilizing: ["arrived", "unavailable"],
  arrived: ["returned"],
  unavailable: [],
  returned: [],
};
export const jobTransitions: Transitions<(typeof jobStates)[number]> = {
  queued: ["running", "cancelled"],
  running: ["succeeded", "retry_wait", "manual_review", "stale"],
  retry_wait: ["running", "cancelled"],
  succeeded: [],
  manual_review: [],
  cancelled: [],
  stale: [],
};
export const aiProposalTransitions: Transitions<(typeof aiProposalStates)[number]> = {
  pending: ["approved", "approved_with_edit", "rejected", "stale"],
  approved: [],
  approved_with_edit: [],
  rejected: [],
  stale: [],
};
export const taskTransitions: Transitions<(typeof taskStates)[number]> = {
  open: ["assigned", "in_progress", "cancelled"],
  assigned: ["in_progress", "cancelled"],
  in_progress: ["done"],
  done: ["in_progress"],
  cancelled: [],
};
export const contentVersionTransitions: Transitions<(typeof contentVersionStates)[number]> = {
  draft: ["in_review"],
  in_review: ["approved", "changes_requested"],
  changes_requested: [],
  approved: ["superseded", "withdrawn"],
  superseded: [],
  withdrawn: [],
};
export const attachmentTransitions: Transitions<(typeof attachmentStates)[number]> = {
  pending_upload: ["uploaded", "expired"],
  uploaded: ["checking", "deleting"],
  checking: ["ready", "rejected", "deleting"],
  ready: ["deleting"],
  rejected: ["deleting"],
  expired: ["deleting"],
  deleting: ["deleted"],
  deleted: [],
};
export const announcementTransitions: Transitions<(typeof announcementStates)[number]> = {
  draft: ["published", "archived"],
  published: ["archived"],
  archived: [],
};
export const notificationApprovalTransitions: Transitions<(typeof notificationApprovalStates)[number]> = {
  draft: ["approved", "cancelled"],
  approved: ["dispatching"],
  dispatching: ["finished", "failed"],
  cancelled: [],
  finished: [],
  failed: [],
};
export const deliveryTransitions: Transitions<(typeof deliveryStates)[number]> = {
  pending: ["sending", "cancelled"],
  sending: ["provider_accepted", "failed", "unknown"],
  provider_accepted: [],
  failed: ["retry_wait"],
  // unknownは終端（T051: 無条件に再送しない＝照会/人確認に回す。docs/11 配送行の辺列どおり）
  unknown: [],
  retry_wait: ["sending"],
  cancelled: [],
};
export const syncOperationTransitions: Transitions<(typeof syncOperationStates)[number]> = {
  local_draft: ["pending"],
  pending: ["sending"],
  sending: ["applied", "conflict", "rejected"],
  applied: [],
  conflict: [],
  rejected: [],
};
export const patrolPlanTransitions: Transitions<(typeof patrolPlanStates)[number]> = {
  draft: ["confirmed", "cancelled"],
  confirmed: [],
  cancelled: [],
};

/** 遷移が許可された辺か。同一状態への「遷移」は許可しない（変更なしは更新ではない）。 */
export function canTransition<S extends string>(table: Transitions<S>, from: S, to: S): boolean {
  return table[from].includes(to);
}
