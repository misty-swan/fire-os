import {
  MyNotification, Notification, ReadReceipt,
  type NotificationSourceType,
} from "../../shared/contracts/content";
import {
  canTransition, notificationApprovalTransitions, notificationChannels,
} from "../../shared/states";
import { cancelUnsentDeliveryStatements } from "../notifications/dispatcher";
import { authorize } from "../auth/authorize";
import { resolvePrincipal } from "../auth/principal";
import { HttpError, defineRoute, ok, parseApiRequest, type ApiApp, type ApiContext } from "../http";
import { enqueueJobStatement } from "../jobs/store";
import "../jobs/handlers/notification"; // 配送job（notification.deliver）handlerの登録（Cron/Queueと同じ登録点。T051）
import { canonicalJson, canonicalRequestHash, sha256Hex } from "../mutations/hash";
import { executeMutation } from "../mutations/execute";
import { requirePermission } from "./invitations";

/**
 * 通知本文・対象snapshotと明示承認API（T050、docs/05 API-63/64/65/67/100、docs/04 §3.4 139-142行、
 * docs/11 通知承認・配送、docs/10 PER-12、docs/14 D13、docs/07 §5）。
 * - draft（API-63）は源（未回答者抽出=activity／お知らせ=announcement／点検期限=inspection_due）から
 *   本文と対象を提案し（buildNotificationDraft）、宛先はaddress_ref（参照）だけを保存する
 *   （docs/04「連絡先生値をジョブへ複製しない」）。本文/対象の変更は新draftを作る（通知のUPDATEは無い）。
 * - 承認（API-64）は①承認固定（bodyHash/audienceHash/version一致。不一致は409）②draft→approved
 *   ③配送jobを1本だけ同batch登録（dedupe_key=`${unitId}|notification.deliver|<通知ID>|<承認時の版>`）。
 *   deliveries行の生成・provider呼出し・approved→dispatching遷移はT051の配送handlerが行う
 *   （docs/16 T050裁定。T050の試験はjob行の存在と本数のみ検査する）。取消はdraft→cancelledのみ
 *   （配送後の「未送分取消」はT051のdeliveries単位）。承認時に現読取/送信権限（PER-12）と
 *   対象団員の現在有効（active・同unit）を再検査する。
 * - 投影（API-65）: 送信者（PER-12）は全体（対象一覧・承認状態・配送job状態）、対象者（recipient本人）は
 *   自分の行のみ（本文・自分のreadAt・自分の配送状態まで。他者の宛先・配送を明かさない）。第三者は404。
 * - 既読（API-100）は本人recipientのみ（代理は403。docs/10 PER-12「既読は本人のみ」）、notificationVersion
 *   一致ガード（旧版409）、再読は初回readAtの同じ応答（行を増やさない。T045のannouncement既読流儀）。
 *   既読と配送は分離し、承認だけで読了/到達と表示しない（docs/07 §5）。
 */

/** 配送jobの種別と設定版。dedupeKeyは `${unitId}|notification.deliver|<通知ID>|<承認時の版>`（T051のhandler） */
const DELIVER_JOB_KIND = "notification.deliver";
const DELIVER_CONFIG_VERSION = "v1";

/** 対象者に見える承認状態（draft/cancelledは未送信のため対象者に存在を見せない。docs/16 T050裁定） */
const RECIPIENT_VISIBLE = ["approved", "dispatching", "finished", "failed"] as const;
const RECIPIENT_VISIBLE_SQL = `('${RECIPIENT_VISIBLE.join("', '")}')`;

type NotificationChannel = (typeof notificationChannels)[number];

/**
 * 宛先の参照（docs/04「連絡先生値をジョブへ複製しない」）。inappは本人の受信箱。生値は保存しない。
 *
 * 【到達不明（unknown）の試験/デモ用の規約（docs/03 §1.1に記録。T052）】
 * 実チャネル（Web Push/email）はD13未了承で未実装のため、「providerで宛先が解決できず送受の
 * 成否が不明になる」状態を実データで再現できない。そこでinappに限り、対象団員の班（squad）が
 * 「連絡先未登録」のときに限り宛先参照を内部試験値 `unknown:<memberId>#inbox` にする
 * （member_private_profiles由来の実連絡先ではない。Secretは無い）。inapp provider（provider.ts）は
 * address_refが `unknown:` 接頭辞のとき結果unknownを返す。班が通常値なら通常の参照になり、
 * 本番のinapp（内部成立）の挙動は変わらない（規約はdraft作成時の班値で固定される）。
 */
export const UNKNOWN_ADDRESS_SQUAD = "連絡先未登録";

export const addressRefFor = (channel: NotificationChannel, memberId: string, squad: string | null = null): string => {
  if (channel === "inapp" && squad === UNKNOWN_ADDRESS_SQUAD) return `unknown:${memberId}#inbox`;
  return `member:${memberId}#${channel === "inapp" ? "inbox" : channel}`;
};

interface NotificationRow {
  id: string; unit_id: string; version: number; source_type: string; source_id: string;
  body_revision: string; audience_hash: string; status: string; expires_at: string | null;
  approved_at: string | null; created_at: string; updated_at: string;
}

/** 存在しない/別unitの通知は同じ404（存在を明かさない。announcements.tsと同じ流儀） */
async function loadNotification(c: ApiContext, id: string, unitId: string): Promise<NotificationRow> {
  const row = await c.env.DB.prepare(
    "SELECT id, unit_id, version, source_type, source_id, body_revision, audience_hash, status, expires_at, approved_at, created_at, updated_at FROM notifications WHERE id = ?",
  ).bind(id).first<NotificationRow>();
  if (!row || row.unit_id !== unitId) throw new HttpError("NOT_FOUND");
  return row;
}

const bodyOf = (row: { body_revision: string }): string => (JSON.parse(row.body_revision) as { body: string }).body;

/** 対象者は同unitの実在団員だけ（存在しない/別unitは同じ404。重複は集合として畳む。announcements.ts流儀） */
async function requireAudienceMembers(c: ApiContext, unitId: string, memberIds: readonly string[]): Promise<void> {
  if (memberIds.length === 0) return;
  const rows = (
    await c.env.DB.prepare(
      `SELECT id, unit_id FROM members WHERE id IN (${memberIds.map(() => "?").join(",")})`,
    ).bind(...memberIds).all<{ id: string; unit_id: string }>()
  ).results;
  if (rows.length !== new Set(memberIds).size || rows.some((r) => r.unit_id !== unitId)) {
    throw new HttpError("NOT_FOUND");
  }
}

// --- buildNotificationDraft（docs/16 T050のInterface。本文/対象の提案組み立てまでを行う） ---

export interface NotificationDraftInput {
  /** 提案の対象unit（呼び出し側のprincipal.unitId） */
  unitId: string;
  source: { type: NotificationSourceType; id: string };
  /** 省略時は源からの既定文を提案する（docs/16 T050「入力＋源からの既定値提案のどちらでもよい」） */
  body?: string;
  /** 省略時は源からの対象提案（activity=未回答者抽出、announcement=対象snapshot）。inspection_dueは必須 */
  audienceMemberIds?: string[];
  channels: readonly NotificationChannel[];
}

export interface NotificationDraftProposal {
  sourceType: NotificationSourceType;
  sourceId: string;
  body: string;
  /** 重複を畳んで整列した対象（承認固定のaudienceHashはこの配列から作る） */
  audienceMemberIds: string[];
  channels: NotificationChannel[];
}

const sourceNotFound = () =>
  new HttpError("VALIDATION_ERROR", undefined, [{ field: "source", reason: "source_not_found" }]);

/** 点検期限の検出行の対象名（多形参照。docs/16 T050裁定「検出行から対象資産名と期限を読んで既定文を組み立てる」） */
async function assetDisplayName(
  db: D1Database, unitId: string, targetType: string, targetId: string,
): Promise<string | null> {
  if (targetType === "vehicle") {
    const row = await db.prepare("SELECT name FROM vehicles WHERE id = ? AND unit_id = ?").bind(targetId, unitId)
      .first<{ name: string }>();
    return row?.name ?? null;
  }
  if (targetType === "equipment") {
    const row = await db.prepare("SELECT name FROM equipment WHERE id = ? AND unit_id = ?").bind(targetId, unitId)
      .first<{ name: string }>();
    return row?.name ?? null;
  }
  if (targetType === "facility") {
    const row = await db
      .prepare("SELECT COALESCE(NULLIF(identifying_name, ''), management_number) AS name FROM facilities WHERE id = ? AND unit_id = ?")
      .bind(targetId, unitId).first<{ name: string | null }>();
    return row?.name ?? null;
  }
  return null;
}

/**
 * 源から本文と対象の提案を組み立てる（保存はしない。docs/16 T050裁定「提案組み立てまで」）。
 * 読めない源（存在しない/別unit/対象の解決に失敗）は400（docs/16 T050裁定）。
 */
export async function buildNotificationDraft(
  ctx: ApiContext, input: NotificationDraftInput,
): Promise<NotificationDraftProposal> {
  const { unitId, source } = input;
  const channels = [...new Set(input.channels)];
  let body: string;
  let audience: string[];

  if (source.type === "activity") {
    // 未回答者抽出（T036/T047方式）: 活動の対象snapshot − 回答あり
    // （response='unanswered'の取り下げ行は未回答扱い＝docs/14 D23）
    const act = await ctx.env.DB.prepare("SELECT id, unit_id, title FROM activities WHERE id = ?").bind(source.id)
      .first<{ id: string; unit_id: string; title: string }>();
    if (!act || act.unit_id !== unitId) throw sourceNotFound();
    const [audienceRows, answeredRows] = await ctx.env.DB.batch([
      ctx.env.DB.prepare("SELECT member_id FROM activity_audience WHERE activity_id = ? AND unit_id = ?").bind(source.id, unitId),
      ctx.env.DB.prepare(
        "SELECT member_id FROM activity_attendance WHERE activity_id = ? AND unit_id = ? AND response != 'unanswered'",
      ).bind(source.id, unitId),
    ]);
    const answered = new Set((answeredRows!.results as { member_id: string }[]).map((r) => r.member_id));
    audience = [...new Set(
      (audienceRows!.results as { member_id: string }[]).map((r) => r.member_id).filter((id) => !answered.has(id)),
    )].sort();
    body = `${act.title}の出欠確認です。参加可否を予定ページから回答してください。`;
  } else if (source.type === "announcement") {
    // お知らせ（T045のrevision）からの引用。対象は現行版のsnapshot
    const ann = await ctx.env.DB.prepare("SELECT id, unit_id, title, body, revision_no FROM announcements WHERE id = ?")
      .bind(source.id).first<{ id: string; unit_id: string; title: string; body: string; revision_no: number }>();
    if (!ann || ann.unit_id !== unitId) throw sourceNotFound();
    const rev = await ctx.env.DB.prepare(
      "SELECT audience_snapshot FROM announcement_revisions WHERE announcement_id = ? AND revision_no = ?",
    ).bind(source.id, ann.revision_no).first<{ audience_snapshot: string }>();
    let snapshot: unknown;
    try {
      snapshot = JSON.parse(rev?.audience_snapshot ?? "");
    } catch {
      throw sourceNotFound();
    }
    if (!Array.isArray(snapshot) || snapshot.some((v) => typeof v !== "string")) throw sourceNotFound();
    audience = [...new Set(snapshot as string[])].sort();
    body = `${ann.title}\n${ann.body}`;
  } else {
    // 点検期限（T048の検出ログ）。検出行から対象資産名と期限日を読んで既定文を組み立てる
    const det = await ctx.env.DB.prepare(
      "SELECT id, unit_id, target_type, target_id, due_date FROM inspection_due_detections WHERE id = ?",
    ).bind(source.id).first<{ id: string; unit_id: string; target_type: string; target_id: string; due_date: string }>();
    if (!det || det.unit_id !== unitId) throw sourceNotFound();
    const name = await assetDisplayName(ctx.env.DB, unitId, det.target_type, det.target_id);
    if (!name) throw sourceNotFound();
    body = `${name}の点検期限（${det.due_date}）を過ぎています。点検を実施して結果を登録してください。`;
    // 対象は源から決められないため入力必須（docs/16 T050裁定）
    if (!input.audienceMemberIds) {
      throw new HttpError("VALIDATION_ERROR", undefined, [{ field: "audienceMemberIds", reason: "audience_required_for_source" }]);
    }
    audience = [...new Set(input.audienceMemberIds)].sort();
  }

  if (input.body !== undefined) body = input.body;
  if (input.audienceMemberIds !== undefined && source.type !== "inspection_due") {
    audience = [...new Set(input.audienceMemberIds)].sort();
  }
  // 空の対象の通知は作らない（全員回答済みの未回答抽出など）
  if (audience.length === 0) {
    throw new HttpError("INVALID_TRANSITION", undefined, [{ field: "audienceMemberIds", reason: "empty_audience" }]);
  }
  // 明示対象は同unitの実在団員だけ（存在しない/別unitは404。提案対象は源のsnapshotを信頼する）
  if (input.audienceMemberIds !== undefined) await requireAudienceMembers(ctx, unitId, audience);

  return { sourceType: source.type, sourceId: source.id, body, audienceMemberIds: audience, channels };
}

// --- 応答の組立（executeMutationのresponse.sql。batch内でJSONを組み立てる） ---

/** 送信者（PER-12）投影。対象一覧・承認hash・配送job状態を含む（API-63/64/65の送信者応答）。
 *  bodyHashはDBに列が無い（docs/04:139どおり）ため、呼び出し側で計算してbindする */
const SENDER_JSON =
  "SELECT json_object(" +
  "'id', id, 'version', version, 'status', status, 'sourceType', source_type, 'sourceId', source_id, " +
  "'body', json_extract(body_revision, '$.body'), 'bodyHash', ?, 'audienceHash', audience_hash, " +
  "'channels', json((SELECT json_group_array(channel) FROM (SELECT DISTINCT channel FROM notification_recipients " +
    "WHERE notification_id = notifications.id AND unit_id = notifications.unit_id) ORDER BY channel)), " +
  "'expiresAt', expires_at, 'approvedAt', approved_at, " +
  "'audienceMemberIds', json((SELECT json_group_array(member_id) FROM (SELECT DISTINCT member_id " +
    "FROM notification_recipients WHERE notification_id = notifications.id AND unit_id = notifications.unit_id) ORDER BY member_id)), " +
  "'recipients', json((SELECT json_group_array(json_object('memberId', member_id, 'channel', channel, " +
      "'addressRef', address_ref, 'readAt', read_at, 'deliveryStatus', (SELECT d.status FROM notification_deliveries d " +
        "WHERE d.recipient_id = recipients.id AND d.unit_id = recipients.unit_id " +
        "ORDER BY d.created_at DESC, d.id DESC LIMIT 1))) FROM (SELECT id, unit_id, member_id, channel, address_ref, read_at " +
      "FROM notification_recipients WHERE notification_id = notifications.id AND unit_id = notifications.unit_id) AS recipients " +
    "ORDER BY member_id, channel)), " +
  "'deliveryJob', json((SELECT json_object('jobId', j.id, 'status', j.status) FROM jobs j " +
    "WHERE j.unit_id = notifications.unit_id AND j.kind = 'notification.deliver' AND j.source_type = 'notification' " +
    "AND j.source_id = notifications.id ORDER BY j.created_at DESC, j.id DESC LIMIT 1)), " +
  "'createdAt', created_at, 'updatedAt', updated_at) AS j " +
  "FROM notifications WHERE id = ?";

/** 対象者本人の投影の本体（他者の宛先・配送・承認hashは載せない。API-65の対象者応答とAPI-67の一覧で共用） */
const MY_OBJECT_SQL =
  "json_object(" +
  "'id', n.id, 'version', n.version, 'status', n.status, 'sourceType', n.source_type, 'sourceId', n.source_id, " +
  "'body', json_extract(n.body_revision, '$.body'), " +
  "'channels', json((SELECT json_group_array(channel) FROM (SELECT DISTINCT channel FROM notification_recipients r0 " +
    "WHERE r0.notification_id = n.id AND r0.unit_id = n.unit_id) ORDER BY channel)), " +
  "'myReadAt', (SELECT r.read_at FROM notification_recipients r WHERE r.notification_id = n.id " +
    "AND r.unit_id = n.unit_id AND r.member_id = ?), " +
  "'myDelivery', json((SELECT json_object('status', d.status, 'attemptCount', d.attempt_count) " +
    "FROM notification_deliveries d JOIN notification_recipients r2 ON r2.id = d.recipient_id AND r2.unit_id = d.unit_id " +
    "WHERE r2.notification_id = n.id AND r2.unit_id = n.unit_id AND r2.member_id = ? " +
    "ORDER BY d.created_at DESC, d.id DESC LIMIT 1)), " +
  "'createdAt', n.created_at, 'updatedAt', n.updated_at) AS j";

const MY_JSON = `SELECT ${MY_OBJECT_SQL} FROM notifications n WHERE n.id = ?`;

// --- 署名付きcursor（announcements.tsと同じ流儀。条件を変えた続き取得・改変cursorは409 SNAPSHOT_CHANGED） ---

interface NotificationCursor {
  filterHash: string;
  createdAt: string;
  id: string;
}

const signingKey = (secret: string): Promise<CryptoKey> =>
  crypto.subtle.importKey("raw", new TextEncoder().encode(`notification-cursor:${secret}`), { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);

const b64url = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes)).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
const unb64url = (s: string) => Uint8Array.from(atob(s.replaceAll("-", "+").replaceAll("_", "/")), (ch) => ch.charCodeAt(0));

async function encodeCursor(key: CryptoKey, cursor: NotificationCursor): Promise<string> {
  const payload = b64url(new TextEncoder().encode(JSON.stringify(cursor)));
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(payload));
  return `${payload}.${b64url(new Uint8Array(sig))}`;
}

async function decodeCursor(key: CryptoKey, value: string): Promise<NotificationCursor | null> {
  const [payload, sig] = value.split(".");
  if (!payload || !sig) return null;
  try {
    const valid = await crypto.subtle.verify("HMAC", key, unb64url(sig) as BufferSource, new TextEncoder().encode(payload));
    if (!valid) return null;
    const parsed = JSON.parse(new TextDecoder().decode(unb64url(payload))) as NotificationCursor;
    if (typeof parsed.filterHash !== "string" || typeof parsed.createdAt !== "string" || typeof parsed.id !== "string") return null;
    return parsed;
  } catch {
    return null;
  }
}

export function registerNotificationRoutes(app: ApiApp): void {
  // --- API-63: draft作成（本文/対象は源からの提案に任せられる。docs/05 API-63「Notification(draft)」） ---
  defineRoute(app, "API-63", async (c) => {
    const p = await resolvePrincipal(c);
    const { body, headers } = await parseApiRequest(c, "API-63");
    requirePermission(p, "PER-12", { unitId: p.unitId, type: "notification" });
    // docs/05 §2「同じキー/本文の再送は元HTTP status/dataを返す」: 鍵が既にある（=再送）ときは
    // 状態前提の提案組み立て（源の再読込・空対象/宛先の検査）を飛ばし、初回の201と同じ応答を
    // executeMutationのresolveExistingへ任せる（API-64/100・inspection-schedulesと同じT041流儀。
    // 源の対象者が初回成功後に全員回答済みになっても再送は422 empty_audienceにならない。
    // 同キー別本文はrequestHash不一致＝IDEMPOTENCY_MISMATCH、失権は403のまま）
    const knownKey = await c.env.DB.prepare(
      "SELECT 1 FROM idempotency_records WHERE actor_user_id = ? AND operation_code = ? AND idempotency_key = ?",
    ).bind(p.userId, "notification.draft", headers["idempotency-key"]).first();

    // 提案の組み立てとhash計算は新規実行のときだけ（再送では実行されず、使われない初期値のまま）
    const proposal = knownKey ? null : await buildNotificationDraft(c, {
      unitId: p.unitId,
      source: body.source,
      body: body.body,
      audienceMemberIds: body.audienceMemberIds,
      channels: body.channels,
    });
    const id = crypto.randomUUID();
    // 宛先参照は団員の班（squad）で決まる部分がある（到達不明の試験/デモ用規約。addressRefForの注記）
    const audienceRows = proposal?.audienceMemberIds.length
      ? (await c.env.DB.prepare(
          `SELECT id, squad FROM members WHERE id IN (${proposal.audienceMemberIds.map(() => "?").join(",")})`,
        ).bind(...proposal.audienceMemberIds).all<{ id: string; squad: string | null }>()).results
      : [];
    const squadOf = new Map(audienceRows.map((r) => [r.id, r.squad]));
    // 承認固定に使うhash（bodyHash=本文のSHA-256、audienceHash=対象memberId整列配列の正規化JSONのSHA-256）。
    // docs/04:139にhash列はaudience_hashしか無いためbodyHashは応答時に計算して載せる
    const bodyHash = proposal ? await sha256Hex(proposal.body) : "";
    const audienceHash = proposal ? await sha256Hex(canonicalJson(proposal.audienceMemberIds)) : "";

    const result = await executeMutation(c.env, p, {
      operationCode: "notification.draft",
      key: headers["idempotency-key"],
      requestHash: await canonicalRequestHash({ method: "POST", path: "/notifications/drafts", body }),
      expectedAuthzVersion: p.authzVersion,
      roots: [],
      created: [{ table: "notifications", id }],
      statements: (ctx) => [
        c.env.DB.prepare(
          "INSERT INTO notifications (id, unit_id, source_type, source_id, body_revision, audience_hash, status, expires_at, last_mutation_token, created_at, updated_at, created_by, actor_kind) " +
            "VALUES (?, ?, ?, ?, ?, ?, 'draft', ?, ?, ?, ?, ?, 'human')",
        ).bind(id, p.unitId, proposal!.sourceType, proposal!.sourceId, JSON.stringify({ body: proposal!.body }), audienceHash, body.expiresAt ?? null, ctx.attempt, ctx.now, ctx.now, p.userId),
        // 対象は明示snapshotで固定（member×channel。宛先はaddress_refの参照だけ。docs/04:140）
        ...proposal!.audienceMemberIds.flatMap((memberId) =>
          proposal!.channels.map((channel) =>
            c.env.DB.prepare(
              "INSERT INTO notification_recipients (id, unit_id, notification_id, member_id, channel, address_ref, actor_user_id, actor_kind, created_at) " +
                "VALUES (?, ?, ?, ?, ?, ?, ?, 'human', ?)",
            ).bind(crypto.randomUUID(), p.unitId, id, memberId, channel, addressRefFor(channel, memberId, squadOf.get(memberId) ?? null), p.userId, ctx.now),
          ),
        ),
        c.env.DB.prepare(
          "INSERT INTO notification_events (id, unit_id, notification_id, action, details, actor_user_id, actor_kind, created_at) " +
            "VALUES (?, ?, ?, 'draft.created', ?, ?, 'human', ?)",
        ).bind(crypto.randomUUID(), p.unitId, id, JSON.stringify({ sourceType: proposal!.sourceType, audienceCount: proposal!.audienceMemberIds.length, channels: proposal!.channels.join(",") }), p.userId, ctx.now),
      ],
      audit: {
        action: "notification.draft", entityType: "notification", entityId: id,
        // 再送（鍵既存）ではproposalが無いため、metadata/payloadは新規実行のときだけ組む（executeMutationの
        // CODE_LIKE検査がundefined値を拒むため、未使用のundefinedを入れたままにしない）
        ...(proposal ? { metadata: { sourceType: proposal.sourceType, audienceCount: proposal.audienceMemberIds.length, channels: proposal.channels.join(",") } } : {}),
      },
      event: {
        entityType: "notification", entityId: id, entityVersion: 1, eventType: "notification.draft_created",
        ...(proposal ? { payload: { sourceType: proposal.sourceType } } : {}),
      },
      response: { status: 201, sql: SENDER_JSON, binds: [bodyHash, id], decode: (j) => Notification.parse(j) },
    });
    return ok(c, result.data, {}, 201);
  });

  // --- API-64: 明示承認／取消／未送分取消（approveは202=永続job受付。cancel/cancel_unsentはjobを作らないため200） ---
  defineRoute(app, "API-64", async (c) => {
    const p = await resolvePrincipal(c);
    const { params, body, headers } = await parseApiRequest(c, "API-64");
    const current = await loadNotification(c, params.id, p.unitId);
    requirePermission(p, "PER-12", { unitId: p.unitId, type: "notification", id: params.id });
    const approve = body.decision === "approve";
    // 未送分取消（docs/11「未送分取消はdeliveries単位」）は承認状態を変えない自己辺のため
    // notificationApprovalTransitionsに無い。承認後の状態（approved/dispatching/finished/failed）から許可する。
    // 終端（finished/failed）でも未送（pending）の残があり得る（受付>=1でfinished等。docs/11 確定規則）
    const cancelUnsent = body.decision === "cancel_unsent";
    const cancelUnsentFrom: readonly string[] = ["approved", "dispatching", "finished", "failed"];
    // docs/05 §2「同じキー/本文の再送は元HTTP status/dataを返し」: 鍵が既にある（=再送の）ときは
    // 現在の状態では不可になる変更（二重承認・承認済みの取消）でも保存済み応答を返す必要があるため、
    // 新しい操作のときだけ状態前提を検査してからbatchに入る（T045/T041と同じ流儀）
    const knownKey = await c.env.DB.prepare(
      "SELECT 1 FROM idempotency_records WHERE actor_user_id = ? AND operation_code = ? AND idempotency_key = ?",
    ).bind(p.userId, "notification.approval", headers["idempotency-key"]).first();

    // 未送分取消の説明に使う宛先と、取消対象の事前件数（details用の案内値。batch内の確定数と瞬間的にずれ得る）
    const cancelUnsentRecipients = cancelUnsent
      ? (await c.env.DB.prepare(
          "SELECT id, channel FROM notification_recipients WHERE notification_id = ? AND unit_id = ?",
        ).bind(params.id, p.unitId).all<{ id: string; channel: string }>()).results
      : [];

    if (!knownKey) {
      // 旧版は先に409（docs/05 §2「旧版409」。executeMutationのdiagnoseと同じ順: 版→状態）
      if (body.version !== current.version) throw new HttpError("VERSION_CONFLICT");
      // 遷移はdocs/11の許可辺のみ（draft→approved/cancelled。approved→cancelledは無い＝docs/16 T050裁定）
      if (cancelUnsent) {
        if (!cancelUnsentFrom.includes(current.status)) {
          throw new HttpError("INVALID_TRANSITION", undefined, [{ field: "status", reason: "transition_not_allowed" }]);
        }
      } else if (!canTransition(notificationApprovalTransitions, current.status as keyof typeof notificationApprovalTransitions, approve ? "approved" : "cancelled")) {
        throw new HttpError("INVALID_TRANSITION", undefined, [{ field: "status", reason: "transition_not_allowed" }]);
      }
      // 承認固定: 承認者は「見た本文/対象」のhashを付ける。変わっていれば（別draftのhash・旧版）409
      // （hashはapproveだけが要求する。cancel/cancel_unsentは承認対象の固定を伴わない）
      if (approve && (await sha256Hex(bodyOf(current))) !== body.bodyHash) {
        throw new HttpError("VERSION_CONFLICT", undefined, [{ field: "bodyHash", reason: "stale_body_hash" }]);
      }
      if (approve && current.audience_hash !== body.audienceHash) {
        throw new HttpError("VERSION_CONFLICT", undefined, [{ field: "audienceHash", reason: "stale_audience_hash" }]);
      }
      // 承認時に対象団員が現在有効（active・同unit）かを再検査する（docs/16 T050裁定。
      // 退団済み・休団を配信対象に固定しない。配送直前の除外はT051。docs/07 §5）
      if (approve) {
        const inactive = await c.env.DB.prepare(
          "SELECT r.member_id FROM notification_recipients r JOIN members m ON m.id = r.member_id " +
            "WHERE r.notification_id = ? AND r.unit_id = ? AND (m.status != 'active' OR m.unit_id != ?) LIMIT 1",
        ).bind(params.id, p.unitId, p.unitId).first();
        if (inactive) {
          throw new HttpError("INVALID_TRANSITION", undefined, [{ field: "audienceMemberIds", reason: "recipient_not_active" }]);
        }
      }
    }

    // 承認1回につき配送jobは1本（dedupe_key=`${unitId}|notification.deliver|<通知ID>|<承認時の版>`。docs/16 T050裁定）
    const result = await executeMutation(c.env, p, {
      operationCode: "notification.approval",
      key: headers["idempotency-key"],
      requestHash: await canonicalRequestHash({ method: "POST", path: `/notifications/${params.id}/approval`, body }),
      expectedAuthzVersion: p.authzVersion,
      roots: [{
        table: "notifications", id: params.id, expectedVersion: body.version,
        allowedStates: { column: "status", values: cancelUnsent ? [...cancelUnsentFrom] : ["draft"] },
      }],
      conditions: [
        // batch内でも承認固定を再検査する（読んでからの競合で古い対象を承認させない。announcement既読と同じ流儀）
        ...(approve
          ? [{
              existsSql: "SELECT 1 FROM notifications WHERE id = ? AND unit_id = ? AND audience_hash = ?",
              binds: [params.id, p.unitId, body.audienceHash],
              failCode: "VERSION_CONFLICT" as const,
            }]
          : []),
        ...(approve
          ? [{
              existsSql:
                "SELECT 1 WHERE NOT EXISTS (SELECT 1 FROM notification_recipients r JOIN members m ON m.id = r.member_id " +
                "WHERE r.notification_id = ? AND r.unit_id = ? AND (m.status != 'active' OR m.unit_id != ?))",
              binds: [params.id, p.unitId, p.unitId],
              failCode: "INVALID_TRANSITION" as const,
            }]
          : []),
      ],
      statements: (ctx) => [
        ...(approve
          ? [c.env.DB.prepare(
              "UPDATE notifications SET status = 'approved', approved_by = ?, approved_at = ?, version = version + 1, last_mutation_token = ?, updated_at = ? " +
                "WHERE id = ? AND unit_id = ? AND version = ?",
            ).bind(p.userId, ctx.now, ctx.attempt, ctx.now, params.id, p.unitId, body.version)]
          : cancelUnsent
            ? [
                // 未送分取消は承認状態を変えず版だけ進める（並行の承認系操作と競合を見える化するため）
                c.env.DB.prepare(
                  "UPDATE notifications SET version = version + 1, last_mutation_token = ?, updated_at = ? " +
                    "WHERE id = ? AND unit_id = ? AND version = ?",
                ).bind(ctx.attempt, ctx.now, params.id, p.unitId, body.version),
                // dispatch.cancelledのactor_kindは'human'（同一mutation内のapproval.approved等と揃える。PH4レビューA低5）
                ...cancelUnsentDeliveryStatements(c.env.DB, p.unitId, params.id, cancelUnsentRecipients, ctx.now, "manual_cancel", "human"),
              ]
            : [c.env.DB.prepare(
                "UPDATE notifications SET status = 'cancelled', version = version + 1, last_mutation_token = ?, updated_at = ? " +
                  "WHERE id = ? AND unit_id = ? AND version = ?",
              ).bind(ctx.attempt, ctx.now, params.id, p.unitId, body.version)]),
        c.env.DB.prepare(
          "INSERT INTO notification_events (id, unit_id, notification_id, action, details, actor_user_id, actor_kind, created_at) " +
            "VALUES (?, ?, ?, ?, ?, ?, 'human', ?)",
        ).bind(
          crypto.randomUUID(), p.unitId, params.id,
          approve ? "approval.approved" : cancelUnsent ? "approval.unsent_cancelled" : "draft.cancelled",
          JSON.stringify({
            decision: body.decision,
            deliveryJob: approve ? "queued" : "none",
            ...(cancelUnsent ? { ensured: cancelUnsentRecipients.length } : {}),
          }), p.userId, ctx.now,
        ),
        // 配送jobを1本だけ同batchで登録。handler（deliveries生成・provider呼出し・approved→dispatching）はT051
        ...(approve
          ? [enqueueJobStatement(c.env, {
              unitId: p.unitId,
              kind: DELIVER_JOB_KIND,
              sourceType: "notification",
              sourceId: params.id,
              sourceVersion: body.version,
              configVersion: DELIVER_CONFIG_VERSION,
              requestedBy: p.userId,
              dedupeKey: `${p.unitId}|${DELIVER_JOB_KIND}|${params.id}|${body.version}`,
            }, new Date(ctx.now)).statement]
          : []),
      ],
      audit: {
        action: "notification.approval", entityType: "notification", entityId: params.id,
        metadata: {
          decision: body.decision,
          ...(approve ? { deliveryJob: "queued" } : {}),
          ...(cancelUnsent ? { ensured: cancelUnsentRecipients.length } : {}),
        },
      },
      event: {
        entityType: "notification", entityId: params.id, entityVersion: body.version + 1,
        eventType: approve ? "notification.approved" : cancelUnsent ? "notification.unsent_cancelled" : "notification.cancelled",
        payload: { decision: body.decision },
      },
      response: {
        status: approve ? 202 : 200,
        sql: SENDER_JSON,
        // bodyHashはapproveの要求値。cancel/cancel_unsentでは承認対象の固定を伴わないため現行本文から計算する
        binds: [approve ? body.bodyHash! : await sha256Hex(bodyOf(current)), params.id],
        decode: (j) => Notification.parse(j),
      },
    });
    return ok(c, result.data, {}, approve ? 202 : 200);
  });

  // --- API-67: 本人の一覧（API-65の対象者投影のPage。固定パス /notifications/me を
  // /notifications/:id より先に登録する。docs/05 §1「固定パスは同階層の:idより先に照合する（Honoは登録順）」） ---
  defineRoute(app, "API-67", async (c) => {
    const p = await resolvePrincipal(c);
    const { query } = await parseApiRequest(c, "API-67");
    requirePermission(p, "PER-01", { unitId: p.unitId, type: "notification" });

    // 送信者（作成者）側の一覧（sent=true。T086・PH4-B2）: draft/cancelledを含む自分の作成分の全状態。
    // 未読（受信箱の条件）との併用は意味が無いため400（黙って無視しない）
    if (query.sent === true && query.unread === true) {
      throw new HttpError("VALIDATION_ERROR", undefined, [{ field: "sent", reason: "sent_and_unread_exclusive" }]);
    }

    // WHERE句（カーソル条件も後でここへ追加する。recipient系の列は全てnの実列=GROUP BYの前で効く）
    const where: string[] = ["n.unit_id = ?"];
    const binds: unknown[] = [p.unitId];
    if (query.sent === true) {
      // 作成者本人の分だけ（他人の送信分は見せない）。myReadAt/myDeliveryは対象者行が無ければnull
      where.push("n.created_by = ?");
      binds.push(p.userId);
    } else {
      // 本人がrecipientの通知だけ（送信者でもrecipientでなければ現れない。API-67は「本人のみ」）
      where.push("r.member_id = ?", `n.status IN ${RECIPIENT_VISIBLE_SQL}`);
      binds.push(p.memberId);
    }
    if (query.status) {
      where.push("n.status = ?");
      binds.push(query.status);
    }
    if (query.unread === true) {
      // 未読だけ（T052。API-28のnotifications指標＝自分宛・未読の件数と同じ条件。docs/05 API-67行）
      where.push("r.read_at IS NULL");
    }

    const key = await signingKey(c.env.BETTER_AUTH_SECRET);
    const { cursor: cursorValue, ...filterOnly } = query;
    const filterHash = await sha256Hex(JSON.stringify(filterOnly));
    if (cursorValue) {
      const cursor = await decodeCursor(key, cursorValue);
      if (!cursor || cursor.filterHash !== filterHash) throw new HttpError("SNAPSHOT_CHANGED");
      // 新しい順（作成降順）の続き。同時刻はid降順で並べ、取りこぼしも重複も作らない
      where.push("(n.created_at < ? OR (n.created_at = ? AND n.id < ?))");
      binds.push(cursor.createdAt, cursor.createdAt, cursor.id);
    }

    // sent=trueではrecipient行とのJOINが要らない（作成者の分だけを並べる。対象者行が無いdraftも載る）
    const fromJoin = query.sent === true ? "" : " JOIN notification_recipients r ON r.notification_id = n.id AND r.unit_id = n.unit_id";
    const groupBy = query.sent === true ? "" : " GROUP BY n.id";

    // SELECT派生列（myReadAt/myDelivery）のbindが最も先（SQLの並び順）。WHERE句のbindはそのあと
    const rows = (
      await c.env.DB.prepare(
        `SELECT ${MY_OBJECT_SQL} FROM notifications n${fromJoin} ` +
          `WHERE ${where.join(" AND ")}${groupBy} ORDER BY n.created_at DESC, n.id DESC LIMIT ?`,
      ).bind(p.memberId, p.memberId, ...binds, query.limit + 1).all<{ j: string }>()
    ).results;

    const items = rows.slice(0, query.limit).map((r) => MyNotification.parse(JSON.parse(r.j)));
    if (rows.length > query.limit) {
      const last = items[items.length - 1]!;
      return ok(c, items, { nextCursor: await encodeCursor(key, { filterHash, createdAt: last.createdAt, id: last.id }) });
    }
    return ok(c, items);
  });

  // --- API-65: 単一件（送信者は全体、対象者は自分の行のみ、第三者は404。docs/16 T050裁定） ---
  defineRoute(app, "API-65", async (c) => {
    const p = await resolvePrincipal(c);
    const { params } = await parseApiRequest(c, "API-65");
    const current = await loadNotification(c, params.id, p.unitId);
    const manage = authorize(p, "PER-12", { unitId: p.unitId, type: "notification", id: params.id });
    if (manage.allowed) {
      const row = await c.env.DB.prepare(SENDER_JSON).bind(await sha256Hex(bodyOf(current)), params.id).first<{ j: string }>();
      return ok(c, Notification.parse(JSON.parse(row!.j)));
    }
    // 対象者には送信が確定した通知だけを見せる（draft/cancelledは対象者にも存在を見せない。docs/16 T050裁定）
    const recipient = await c.env.DB.prepare(
      "SELECT 1 FROM notification_recipients WHERE notification_id = ? AND unit_id = ? AND member_id = ?",
    ).bind(params.id, p.unitId, p.memberId).first();
    if (recipient && (RECIPIENT_VISIBLE as readonly string[]).includes(current.status)) {
      const row = await c.env.DB.prepare(MY_JSON).bind(p.memberId, p.memberId, params.id).first<{ j: string }>();
      return ok(c, MyNotification.parse(JSON.parse(row!.j)));
    }
    throw new HttpError("NOT_FOUND");
  });

  // --- API-100: 本人既読（版付き。本人recipientのみ。docs/05 API-100「notificationVersion;本人/対象/可視版」） ---
  defineRoute(app, "API-100", async (c) => {
    const p = await resolvePrincipal(c);
    const { params, body, headers } = await parseApiRequest(c, "API-100");
    const current = await loadNotification(c, params.id, p.unitId);
    const knownKey = await c.env.DB.prepare(
      "SELECT 1 FROM idempotency_records WHERE actor_user_id = ? AND operation_code = ? AND idempotency_key = ?",
    ).bind(p.userId, "notification.read", headers["idempotency-key"]).first();

    if (!knownKey) {
      // 未承認（draft）・取消済みは対象者にも存在を見せない（docs/16 T050裁定）
      if (!(RECIPIENT_VISIBLE as readonly string[]).includes(current.status)) throw new HttpError("NOT_FOUND");
      const recipient = await c.env.DB.prepare(
        "SELECT read_at FROM notification_recipients WHERE notification_id = ? AND unit_id = ? AND member_id = ?",
      ).bind(params.id, p.unitId, p.memberId).first<{ read_at: string | null }>();
      if (!recipient) {
        // 対象者でなければ404（存在を明かさない）。ただし管理権（PER-12）保持者による代理既読（本人以外の
        // 操作）は403で拒否する（既読は本人のみ。docs/10 PER-12。T045のannouncement流儀）
        const manage = authorize(p, "PER-12", { unitId: p.unitId, type: "notification", id: params.id });
        if (manage.allowed) throw new HttpError("FORBIDDEN", undefined, [{ field: "permission", reason: "read_is_self_only" }]);
        throw new HttpError("NOT_FOUND");
      }
      // version一致ガード（旧版409。docs/05 §2「旧版409」）
      if (body.notificationVersion !== current.version) throw new HttpError("VERSION_CONFLICT");
      // 既読済みなら初回readAtの同じ応答を返す（行を増やさず版も進めない）
      if (recipient.read_at) {
        return ok(c, ReadReceipt.parse({ readAt: recipient.read_at, notificationVersion: current.version }));
      }
    }

    const result = await executeMutation(c.env, p, {
      operationCode: "notification.read",
      key: headers["idempotency-key"],
      requestHash: await canonicalRequestHash({ method: "PUT", path: `/notifications/${params.id}/read`, body }),
      expectedAuthzVersion: p.authzVersion,
      roots: [{
        table: "notifications", id: params.id, expectedVersion: body.notificationVersion,
        allowedStates: { column: "status", values: RECIPIENT_VISIBLE },
      }],
      conditions: [
        {
          existsSql: "SELECT 1 FROM notification_recipients WHERE notification_id = ? AND unit_id = ? AND member_id = ?",
          binds: [params.id, p.unitId, p.memberId],
          failCode: "NOT_FOUND",
        },
      ],
      statements: (ctx) => [
        // read_atはrecipient行に記録する（docs/04:140「既読は本人recipient」）。集約の版を進めるのは
        // API-100のnotificationVersionガードの正本のため（並行の別対象者の既読は409になり、
        // 再試行で初回readAtの同じ応答を返す）
        c.env.DB.prepare(
          "UPDATE notifications SET version = version + 1, last_mutation_token = ?, updated_at = ? WHERE id = ? AND unit_id = ? AND version = ?",
        ).bind(ctx.attempt, ctx.now, params.id, p.unitId, body.notificationVersion),
        c.env.DB.prepare(
          "UPDATE notification_recipients SET read_at = ? WHERE notification_id = ? AND unit_id = ? AND member_id = ? AND read_at IS NULL",
        ).bind(ctx.now, params.id, p.unitId, p.memberId),
      ],
      audit: { action: "notification.read", entityType: "notification", entityId: params.id, metadata: { recipientMemberId: p.memberId } },
      event: {
        entityType: "notification", entityId: params.id, entityVersion: body.notificationVersion + 1,
        eventType: "notification.read", payload: { recipientMemberId: p.memberId },
      },
      response: {
        status: 200,
        sql: "SELECT json_object('readAt', read_at, 'notificationVersion', ?) FROM notification_recipients WHERE notification_id = ? AND unit_id = ? AND member_id = ?",
        binds: [body.notificationVersion, params.id, p.unitId, p.memberId],
        decode: (j) => ReadReceipt.parse(j),
      },
    });
    return ok(c, result.data);
  });
}
