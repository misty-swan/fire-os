import type { ErrorCode } from "../../shared/contracts/common";
import { systemClock, type Clock } from "../clock";
import type { AppEnv } from "../env";
import { HttpError } from "../http";
import { PRINCIPAL_EXISTS_SQL, assertIdent, assertionSql, rootUpdatedExistsSql } from "./assertion";

/** 認可済みの実行主体。認可判定そのもの(最新の所属・役割)はT008。ここでは「判定時の認可版が今も有効か」を検査する。 */
export interface Principal {
  userId: string;
  memberId: string;
  unitId: string;
  authzVersion: number;
}

export interface MutationContext {
  /** この試行専用の印(Idempotency-Keyとは別に毎試行採番) */
  attempt: string;
  /** 一mutation一event/監査を結ぶID */
  mutationId: string;
  now: string;
}

/** 比較更新の対象root。更新後に version=期待+1 かつ今回の印が付いていることを検査する。 */
export interface RootGuard {
  table: string;
  id: string;
  expectedVersion: number;
  /**
   * 比較更新が許す「前の状態」（例: status IN ('reported')）。失敗後の判定で、版は一致するのに
   * 状態がこの一覧に無ければ 422 INVALID_TRANSITION にする。指定が無い/一覧内なのに失敗した場合は内部障害。
   */
  allowedStates?: { column: string; values: readonly string[] };
}

/**
 * root以外の前提条件（対象ユーザーの認可版など）。**業務書込の前の状態**で評価する（batchの先頭側に置く）。
 * 偽なら failCode で失敗させる。失敗後の判定(diagnose)も取消後=書込前の状態で同じSQLを評価するので結果が一致する。
 */
export interface ExtraCondition {
  existsSql: string;
  binds: unknown[];
  failCode?: ErrorCode;
}

export interface MutationSpec<T> {
  operationCode: string;
  /** Idempotency-Key */
  key: string;
  /** canonicalRequestHash() の結果 */
  requestHash: string;
  /** 認可判定時の実行主体の認可版（通常は principal.authzVersion） */
  expectedAuthzVersion: number;
  roots: RootGuard[];
  conditions?: ExtraCondition[];
  /** 業務書込。root の UPDATE（version+1, last_mutation_token=ctx.attempt）を含める */
  statements: (ctx: MutationContext) => D1PreparedStatement[];
  audit: { action: string; entityType: string; entityId: string; metadata?: Record<string, string | number | boolean | null> };
  event: {
    entityType: string;
    entityId: string;
    entityVersion: number;
    eventType: string;
    payload?: Record<string, string | number | boolean | null>;
  };
  /**
   * 業務上の重複として 409 DUPLICATE にしてよい一意制約。「表.列」（複合なら全列）または部分索引の「index:索引名」で宣言する
   * （例: ["member_roles.member_id", "member_roles.role_id"]、["index:uq_member_roles_active"]）。
   * 失敗した制約の列が全て宣言に含まれる場合だけDUPLICATE。表単位にしないのは、同じ表に「分団内で一意」と
   * 「全体で一意（例: members.user_id）」が混在し、後者を重複と答えると他unitの存在を推測させるため。宣言外は500。
   */
  duplicateOn?: readonly string[];
  /** 応答はbatch内のSQLが組み立てる。sqlは1行1列(JSON文字列)を返すSELECT */
  response: { status: 200 | 201; sql: string; binds?: unknown[]; decode: (json: unknown) => T };
}

export interface MutationResult<T> {
  status: 200 | 201;
  data: T;
  /** 同じ鍵の再送で、保存済みの結果を返した */
  replayed: boolean;
}

export interface MutationDeps {
  clock?: Clock;
  newId?: () => string;
}

/** 冪等キーの保持期間（案。docs/05 §2） */
export const IDEMPOTENCY_TTL_MS = 7 * 24 * 60 * 60 * 1000;

const MAX_AUDIT_BYTES = 1024;

/** 監査/outboxに入れてよい文字列: ID・コード・状態名の形だけ（氏名・本文などの自由文を入れられないようにする） */
const CODE_LIKE = /^[A-Za-z0-9_.:-]{0,100}$/;

function assertSmallPrimitives(label: string, value: Record<string, unknown> | undefined) {
  if (!value) return;
  for (const [k, v] of Object.entries(value)) {
    const ok = v === null || ["string", "number", "boolean"].includes(typeof v);
    if (!ok) throw new Error(`${label} は値に入れ子や配列を持てません: ${k}`);
    if (typeof v === "string" && !CODE_LIKE.test(v)) {
      throw new Error(`${label}.${k} にはID・コード形式の値だけを入れてください（本文や氏名を複製しない）`);
    }
  }
  if (new TextEncoder().encode(JSON.stringify(value)).byteLength > MAX_AUDIT_BYTES) {
    throw new Error(`${label} が${MAX_AUDIT_BYTES}バイトを超えています。本文を複製せずIDだけを入れてください`);
  }
}

interface IdempotencyRow {
  id: string;
  canonical_request_hash: string;
  state: "reserved" | "completed" | "expired";
  response_status: number | null;
  response_json: string | null;
  expires_at: string;
}

async function findRecord(env: Pick<AppEnv, "DB">, p: Principal, spec: { operationCode: string; key: string }) {
  return env.DB.prepare(
    "SELECT id, canonical_request_hash, state, response_status, response_json, expires_at FROM idempotency_records " +
      "WHERE actor_user_id = ? AND operation_code = ? AND idempotency_key = ?",
  )
    .bind(p.userId, spec.operationCode, spec.key)
    .first<IdempotencyRow>();
}

/** 実行主体が今も有効か（失権・停止・認可版の変化を検出）。再送でも毎回検査する。 */
async function principalIsCurrent(env: Pick<AppEnv, "DB">, p: Principal, authzVersion: number): Promise<boolean> {
  const row = await env.DB.prepare(PRINCIPAL_EXISTS_SQL).bind(p.userId, authzVersion, p.memberId, p.unitId).first();
  return row !== null;
}

/** 既存の冪等レコードに対する結果。保存済みの応答を返すか、拒否する。 */
async function resolveExisting<T>(
  env: Pick<AppEnv, "DB">,
  p: Principal,
  spec: MutationSpec<T>,
  rec: IdempotencyRow,
  nowIso: string,
): Promise<MutationResult<T>> {
  // 失権後に旧レスポンス（個人情報を含み得る）を返さず、鍵の存在や本文の違いも明かさない。認可を最初に確かめる
  if (!(await principalIsCurrent(env, p, spec.expectedAuthzVersion))) throw new HttpError("FORBIDDEN");
  if (rec.canonical_request_hash !== spec.requestHash) throw new HttpError("IDEMPOTENCY_MISMATCH");
  // 期限後は暗黙に再実行しない。人が結果を確認して新しい操作を作る（docs/05 §2）
  if (rec.state === "expired" || rec.expires_at <= nowIso) {
    throw new HttpError("IDEMPOTENCY_MISMATCH", undefined, [{ field: "idempotency-key", reason: "key_expired" }]);
  }
  if (rec.state !== "completed" || rec.response_status === null || rec.response_json === null) {
    throw new HttpError("INTERNAL_ERROR");
  }
  return {
    status: rec.response_status as 200 | 201,
    data: spec.response.decode(JSON.parse(rec.response_json)),
    replayed: true,
  };
}

/**
 * 更新・冪等・監査・outboxを一つのD1 batchで確定する（docs/02 §4）。
 * batch内の順序: 認可版検査 → 冪等予約 → 前提条件(conditions) → 業務書込(比較更新) → root検査 → 監査 →
 * unit連番増分＋event → 連番検査 → 冪等確定(応答をSQLで組立) → 検査行の掃除 → 応答読出し。
 * どこかが失敗すればbatch全体が取り消される。失敗の理由は取消後の状態を読み直して判別する。
 */
export async function executeMutation<T>(
  env: Pick<AppEnv, "DB">,
  principal: Principal,
  spec: MutationSpec<T>,
  deps: MutationDeps = {},
): Promise<MutationResult<T>> {
  const clock = deps.clock ?? systemClock;
  const newId = deps.newId ?? (() => crypto.randomUUID());
  const now = clock.now();
  const nowIso = now.toISOString();

  // 開発者の誤用を、何も書く前に検出する
  for (const r of spec.roots) {
    assertIdent(r.table, "root.table");
    if (r.allowedStates) assertIdent(r.allowedStates.column, "root.allowedStates.column");
  }
  if (spec.roots.length === 0) throw new Error("roots が空です。更新対象のrootを1つ以上指定してください");
  if (spec.key.length < 1 || spec.key.length > 128) throw new Error("Idempotency-Key は1〜128文字です");
  assertSmallPrimitives("audit.metadata", spec.audit.metadata);
  assertSmallPrimitives("event.payload", spec.event.payload);

  // 1. 同じ鍵が既にあれば、再実行せず結果を返す（または拒否する）
  const existing = await findRecord(env, principal, spec);
  if (existing) return resolveExisting(env, principal, spec, existing, nowIso);

  // 2. 新規実行
  const ctx: MutationContext = { attempt: newId(), mutationId: newId(), now: nowIso };
  const recordId = newId();
  const expiresAt = new Date(now.getTime() + IDEMPOTENCY_TTL_MS).toISOString();
  const prep = (sql: string, ...binds: unknown[]) => env.DB.prepare(sql).bind(...binds);
  let seq = 0;
  const assertion = (existsSql: string, ...binds: unknown[]) => prep(assertionSql(existsSql), ctx.attempt, ++seq, ...binds);

  const stmts: D1PreparedStatement[] = [
    // (a) 認可判断の根拠(認可版)が今も有効
    assertion(PRINCIPAL_EXISTS_SQL, principal.userId, spec.expectedAuthzVersion, principal.memberId, principal.unitId),
    // (b) 冪等予約。同じ鍵が同時に来た場合はUNIQUE違反で失敗し、勝者の結果を再読込する
    prep(
      "INSERT INTO idempotency_records (id, unit_id, actor_user_id, operation_code, idempotency_key, canonical_request_hash, state, created_at, expires_at) " +
        "VALUES (?, ?, ?, ?, ?, ?, 'reserved', ?, ?)",
      recordId, principal.unitId, principal.userId, spec.operationCode, spec.key, spec.requestHash, nowIso, expiresAt,
    ),
    // (c) 前提条件。書込前の状態で評価する
    ...(spec.conditions ?? []).map((c) => assertion(c.existsSql, ...c.binds)),
    // (d) 業務書込（rootの比較更新を含む）
    ...spec.statements(ctx),
  ];
  // (e) 比較更新が本当に1行に効いたこと（0行更新を成功扱いにしない）
  for (const r of spec.roots) {
    stmts.push(assertion(rootUpdatedExistsSql(r.table), r.id, principal.unitId, r.expectedVersion + 1, ctx.attempt));
  }
  stmts.push(
    // (f) 監査（成功時のみ。本文は複製せずIDと短い値だけ）
    prep(
      "INSERT INTO audit_logs (id, unit_id, actor_kind, actor_user_id, action, entity_type, entity_id, mutation_id, occurred_at, metadata_json) " +
        "VALUES (?, ?, 'human', ?, ?, ?, ?, ?, ?, ?)",
      newId(), principalUnit(principal), principal.userId, spec.audit.action, spec.audit.entityType, spec.audit.entityId,
      ctx.mutationId, nowIso, JSON.stringify(spec.audit.metadata ?? {}),
    ),
    // (g) unitの連番を1増やし、同じ値でoutbox(domain_events)へ。一mutation一event
    prep("UPDATE units SET event_sequence = event_sequence + 1 WHERE id = ?", principal.unitId),
    prep(
      "INSERT INTO domain_events (id, unit_id, mutation_id, entity_type, entity_id, entity_version, event_type, payload_minimal, sequence, created_at) " +
        "SELECT ?, ?, ?, ?, ?, ?, ?, ?, event_sequence, ? FROM units WHERE id = ?",
      newId(), principal.unitId, ctx.mutationId, spec.event.entityType, spec.event.entityId, spec.event.entityVersion,
      spec.event.eventType, JSON.stringify(spec.event.payload ?? {}), nowIso, principal.unitId,
    ),
    assertion(
      "SELECT 1 FROM domain_events e JOIN units u ON u.id = e.unit_id WHERE e.unit_id = ? AND e.mutation_id = ? AND e.sequence = u.event_sequence",
      principal.unitId, ctx.mutationId,
    ),
    // (h) 冪等の確定。応答JSONはここでSQLが組み立てる（batch途中でJSへ値を戻せないため）
    prep(
      `UPDATE idempotency_records SET state = 'completed', response_status = ?, response_json = (${spec.response.sql}) WHERE id = ? AND state = 'reserved'`,
      spec.response.status, ...(spec.response.binds ?? []), recordId,
    ),
    // (i) 検査行の掃除と、保存した応答の読出し
    prep("DELETE FROM mutation_assertions WHERE attempt_token = ?", ctx.attempt),
    prep("SELECT response_json FROM idempotency_records WHERE id = ?", recordId),
  );

  let results: D1Result[];
  try {
    results = await env.DB.batch(stmts);
  } catch (err) {
    return diagnose(env, principal, spec, err, nowIso);
  }
  const row = results[results.length - 1]?.results[0] as { response_json?: string } | undefined;
  if (!row?.response_json) throw new HttpError("INTERNAL_ERROR");
  return { status: spec.response.status, data: spec.response.decode(JSON.parse(row.response_json)), replayed: false };
}

const principalUnit = (p: Principal) => p.unitId;

/**
 * batchが失敗した後（全て取り消し済み）の状態を読み直し、理由を判別する。
 *  権限 → 403 / 同じ鍵の勝者 → その結果 / root無し・別unit → 404 / 版違い → 409 / 前提条件 → failCode /
 *  版は合っているが状態が許可された前の状態でない（allowedStatesで宣言）→ 422 INVALID_TRANSITION /
 *  duplicateOn に宣言した一意制約（表.列 / index:名前）のUNIQUE違反 → 409 DUPLICATE。
 *  エラー文だけから推測しない（全ての検査は同じ文言で失敗するため、内部の不具合を利用者の誤りに見せてしまう）。
 * どれでもなければ内部障害として扱い、409に偽装しない。
 */
async function diagnose<T>(
  env: Pick<AppEnv, "DB">,
  p: Principal,
  spec: MutationSpec<T>,
  err: unknown,
  nowIso: string,
): Promise<MutationResult<T>> {
  if (!(await principalIsCurrent(env, p, spec.expectedAuthzVersion))) throw new HttpError("FORBIDDEN");

  // 同じ鍵が同時に勝った（UNIQUE違反）なら、その結果を返す
  const winner = await findRecord(env, p, spec);
  if (winner) return resolveExisting(env, p, spec, winner, nowIso);

  for (const r of spec.roots) {
    const stateCol = r.allowedStates ? `, ${r.allowedStates.column} AS state` : "";
    const row = await env.DB.prepare(`SELECT unit_id, version${stateCol} FROM ${assertIdent(r.table, "root.table")} WHERE id = ?`)
      .bind(r.id)
      .first<{ unit_id: string; version: number; state?: string }>();
    // 存在しない/別unit: 存在を明かさないため同じ404
    if (!row || row.unit_id !== p.unitId) throw new HttpError("NOT_FOUND");
    if (row.version !== r.expectedVersion) throw new HttpError("VERSION_CONFLICT");
    if (r.allowedStates && !r.allowedStates.values.includes(String(row.state))) throw new HttpError("INVALID_TRANSITION");
  }
  for (const c of spec.conditions ?? []) {
    const ok = await env.DB.prepare(c.existsSql).bind(...c.binds).first();
    if (!ok) throw new HttpError(c.failCode ?? "VERSION_CONFLICT");
  }

  const message = String(err);
  // 宣言された一意制約だけを重複とする
  // 例: "UNIQUE constraint failed: member_roles.member_id, member_roles.role_id: SQLITE_CONSTRAINT" / "...failed: index 'uq_x': ..."
  const failed = message.match(/UNIQUE constraint failed: (.+?)(?:: SQLITE|$)/)?.[1];
  if (failed && spec.duplicateOn?.length) {
    const tokens = failed.split(", ").map((t) => t.replace(/^index '([^']+)'$/, "index:$1").trim());
    if (tokens.every((t) => spec.duplicateOn!.includes(t))) throw new HttpError("DUPLICATE");
  }

  // 理由が見つからない失敗は業務上の競合ではない。内部障害として扱う（詳細はログのみ）
  console.error(JSON.stringify({ operation: spec.operationCode, error: String(err) }));
  throw new HttpError("INTERNAL_ERROR");
}

/**
 * 保持期間(7日)を過ぎた冪等レコードは、応答本文(個人情報を含み得る)を消して expired にする。
 * 鍵とhashは残すので、期限後の同じ鍵の再送は再実行されず拒否される（docs/04・D21）。Cronから呼ぶ。
 */
export async function expireIdempotencyRecords(env: Pick<AppEnv, "DB">, nowIso: string): Promise<number> {
  const res = await env.DB.prepare(
    "UPDATE idempotency_records SET state = 'expired', response_status = NULL, response_json = NULL WHERE state = 'completed' AND expires_at <= ?",
  ).bind(nowIso).run();
  return res.meta.changes ?? 0;
}
