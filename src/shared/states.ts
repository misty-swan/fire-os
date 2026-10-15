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
export const notificationApprovalStates = ["draft", "approved", "cancelled", "dispatching", "finished", "failed"] as const;
export const deliveryStates = ["pending", "sending", "provider_accepted", "failed", "unknown", "retry_wait"] as const;
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
  pending: ["sending"],
  sending: ["provider_accepted", "failed", "unknown"],
  provider_accepted: [],
  failed: ["retry_wait"],
  unknown: ["retry_wait"],
  retry_wait: ["sending"],
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
