import { SyncOperation } from "../../shared/contracts/sync";
import { syncOperationStates } from "../../shared/states";
import type { ApiRequest, ApiResponse } from "../../shared/contracts/registry";
import { resolvePrincipal } from "../auth/principal";
import { HttpError, defineRoute, ok, parseApiRequest, type ApiApp, type ApiContext } from "../http";
import { executeMutation, IDEMPOTENCY_TTL_MS } from "../mutations/execute";
import { canonicalRequestHash } from "../mutations/hash";
import { ALLOWLIST, type SyncCommandData } from "../sync/allowlist";
import { requirePermission } from "./invitations";

/**
 * 保留操作の同期（T076、docs/05 §2・API-81/82、docs/07 端末保持）。
 * - API-81: 保留操作を現在の認可で再検査して一回だけ適用し、sync_operations（docs/04:167）に
 *   結果を台帳として残す。台帳行は元業務mutationと同じbatchで書込み（MutationSpec.sideEffects）、
 *   適用済みの同キー再送は保存済みのSyncOperationを返す（docs/07「適用済operationの再送は同結果」）。
 * - API-82: 結果照会。本人/端末operationだけ（他人は存在も明かさない404）。
 * - /api/*は必ずJSONで応答する（AGENTS.md）。
 */

/**
 * 同期コマンドを適用する。
 *  1. 鍵の解決（台帳）: 同じuser/device/clientOperationIdの行があれば、hash一致・期限内なら保存済みの
 *     結果を返し、別本文は409 IDEMPOTENCY_MISMATCH、期限切れは409＋details.reason=key_expired
 *     （docs/05 §1。期限後は人が結果を確認して新しい操作を作る。docs/07、D14）。
 *  2. 未解決ならallowlistの元APIの契約で本文を検証し、元handlerと同じ認可・版・状態前提で
 *     MutationSpecを組み立て、台帳書込を同一batchに載せて実行する（元APIの認可/版/冪等/状態を省略しない）。
 *  3. 元APIの直接実行で同じ鍵が既に完了している場合はbatchが走らないため（docs/05 §2「同じキー/本文の
 *     再送は元HTTP status/dataを返す」）、台帳だけを後から埋める（業務効果は確定済みなので原子性の問題はない）。
 */
export async function applySyncCommand(c: ApiContext, input: ApiRequest<"API-81">): Promise<ApiResponse<"API-81">> {
  const p = await resolvePrincipal(c); // 毎要求D1から引き直す（停止・失権は401で止まる。docs/10 PER-13「オフライン操作も再認可」）
  // 経路入口のPER-13（docs/05 API-81「PER-13＋元操作」。API-80と同じ入口検査。台帳の再送経路は元操作の
  // 再検査を通らないため、ここでの検査が「現在の認可は再検査」（docs/05 §2）の最低保証になる。PH6レビューA中1）
  requirePermission(p, "PER-13", { unitId: p.unitId, type: "sync" });
  const cmd: SyncCommandData = input.body;

  // 1操作1鍵: Idempotency-KeyはclientOperationIdと同値（docs/05 §2。取違えると鍵が二重に増えるため拒否）
  if (input.headers["idempotency-key"] !== cmd.clientOperationId) {
    throw new HttpError("VALIDATION_ERROR", undefined, [{ field: "idempotency-key", reason: "client_operation_id_mismatch" }]);
  }
  // allowlist外のoperationCodeは400。同期経路から任意の操作を呼べない（docs/16 T076完了条件）。
  // hasOwnで調べる（"toString"等のObject.prototypeの鍵を許可リストの当たりとして扱わない）
  const entry = Object.hasOwn(ALLOWLIST, cmd.operationCode) ? ALLOWLIST[cmd.operationCode] : undefined;
  if (!entry) {
    throw new HttpError("VALIDATION_ERROR", undefined, [{ field: "operationCode", reason: "operation_not_allowed" }]);
  }

  // 台帳の鍵hash（同期コマンドの正規化hash）。元操作の組み立て前に「同キー別本文・期限切れ」を判定できる。
  // 元APIのrequestHashはidempotency_records側に（元handlerが）保存するので、こちらとは役割が違う
  const requestHash = await canonicalRequestHash({
    method: "POST", path: "/sync/commands",
    body: { operationCode: cmd.operationCode, targetId: cmd.targetId, baseVersion: cmd.baseVersion, payload: cmd.payload },
  });
  const nowIso = new Date().toISOString();

  const existing = await c.env.DB.prepare(
    "SELECT id, request_hash, result_json, expires_at FROM sync_operations WHERE user_id = ? AND device_id = ? AND client_operation_id = ?",
  ).bind(p.userId, cmd.deviceId, cmd.clientOperationId)
    .first<{ id: string; request_hash: string; result_json: string; expires_at: string }>();
  if (existing) {
    if (existing.request_hash !== requestHash) {
      throw new HttpError("IDEMPOTENCY_MISMATCH", undefined, [{ field: "clientOperationId", reason: "request_hash_mismatch" }]);
    }
    if (existing.expires_at <= nowIso) {
      throw new HttpError("IDEMPOTENCY_MISMATCH", undefined, [{ field: "clientOperationId", reason: "key_expired" }]);
    }
    // 適用済みの再送は保存済みの結果を返す（再実行しない）。本体は{id,status}だけで個人情報を含まず、
    // 利用者の有効性はresolvePrincipalの毎要求D1読み直しが担保する（docs/05 §2「現在の認可は再検査」）
    return SyncOperation.parse(JSON.parse(existing.result_json));
  }

  // 未解決: 元APIの契約検査→元handlerと同じ認可・状態前提でMutationSpecを組み立て（失敗は元APIと同じ400/403/404/409/422）
  const spec = await entry.build(c, p, cmd, cmd.clientOperationId);
  const syncOpId = crypto.randomUUID();

  // 台帳1行のINSERT（result_jsonは業務本文を複製しないSyncOperationだけ。docs/04:167「同期結果/冪等台帳」）。
  // OR IGNORE: UNIQUEの競合で業務効果ごと取り消さない。競合は同一クライアントの鍵の再利用（クライアントの誤り）
  // の同時ケースに限られ、そのときは台帳が漏れても次の再送の鍵解決で鍵ごと拒否される（二重効果にはならない）
  const ledgerInsert = (id: string, now: string) =>
    c.env.DB.prepare(
      "INSERT OR IGNORE INTO sync_operations (id, unit_id, user_id, device_id, client_operation_id, operation_code, target_id, base_version, request_hash, status, result_json, created_at, expires_at) " +
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'applied', json_object('id', ?, 'status', 'applied'), ?, ?)",
    ).bind(
      id, p.unitId, p.userId, cmd.deviceId, cmd.clientOperationId, cmd.operationCode, cmd.targetId,
      cmd.baseVersion, requestHash, id, now, new Date(new Date(now).getTime() + IDEMPOTENCY_TTL_MS).toISOString(),
    );

  // 台帳行は業務効果と同じbatchで確定する（docs/16 T076「sync結果と業務効果を同commit」）
  spec.sideEffects = (ctx) => [ledgerInsert(syncOpId, ctx.now)];
  const result = await executeMutation(c.env, p, spec);

  if (result.replayed) {
    // batchが走らなかった（同じ鍵が元APIの直接実行で完了済み。docs/05 §2）。台帳だけを後から埋め、
    // 実際の行（同時実行の勝者）を読んで返す
    await ledgerInsert(syncOpId, nowIso).run();
    const row = await c.env.DB.prepare(
      "SELECT id, status FROM sync_operations WHERE user_id = ? AND device_id = ? AND client_operation_id = ?",
    ).bind(p.userId, cmd.deviceId, cmd.clientOperationId).first<{ id: string; status: string }>();
    if (!row) throw new HttpError("INTERNAL_ERROR");
    return SyncOperation.parse({ id: row.id, status: row.status });
  }
  return SyncOperation.parse({ id: syncOpId, status: "applied" });
}

export function registerSyncRoutes(app: ApiApp): void {
  // --- API-81: 保留操作の適用（現在認可・重複検知。docs/05 API-81、docs/16 T076） ---
  defineRoute(app, "API-81", async (c) => {
    const input = await parseApiRequest(c, "API-81");
    const applied = await applySyncCommand(c, input);
    return ok(c, applied, {}, 200);
  });

  // --- API-82: 同期操作の結果照会（本人/端末operationのみ。docs/05 API-82「PER-13本人」） ---
  defineRoute(app, "API-82", async (c) => {
    const p = await resolvePrincipal(c);
    requirePermission(p, "PER-13", { unitId: p.unitId, type: "sync" }); // 経路入口のPER-13（API-80と同じ。PH6レビューA中1）
    const { params } = await parseApiRequest(c, "API-82");
    const row = await c.env.DB.prepare("SELECT id, status FROM sync_operations WHERE id = ? AND user_id = ?")
      .bind(params.id, p.userId)
      .first<{ id: string; status: (typeof syncOperationStates)[number] }>();
    if (!row) throw new HttpError("NOT_FOUND"); // 他人・存在しないIDも同じ404（存在を明かさない）
    return ok(c, SyncOperation.parse({ id: row.id, status: row.status }));
  });
}
