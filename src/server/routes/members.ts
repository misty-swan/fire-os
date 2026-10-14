import { Member, privateFieldNames, roleCodes } from "../../shared/contracts/auth";
import { authorize } from "../auth/authorize";
import { resolvePrincipal, type AuthzPrincipal } from "../auth/principal";
import { project } from "../auth/projection";
import { HttpError, defineRoute, ok, parseApiRequest, type ApiApp } from "../http";
import { canonicalRequestHash } from "../mutations/hash";
import { executeMutation } from "../mutations/execute";
import { disableUser } from "../auth/disable";
import { requirePermission } from "./invitations";

type MemberRow = {
  id: string; version: number; display_name: string; rank: string | null; squad: string | null; qualifications: string;
  joined_at: string | null; status: string; user_id: string | null;
};

const COLS = "m.id, m.version, m.display_name, m.rank, m.squad, m.qualifications, m.joined_at, m.status, m.user_id";

/** 変更系の応答（冪等レコードに保存される）に使うMember。許可列(privateFields)は含めない */
const MEMBER_JSON =
  "SELECT json_object('id', id, 'version', version, 'displayName', display_name, 'rank', rank, 'squad', squad, " +
  "'qualifications', json(qualifications), 'joinedOn', CASE WHEN joined_at IS NULL THEN NULL ELSE substr(joined_at, 1, 10) END, " +
  "'status', status, 'hasAccount', json(CASE WHEN user_id IS NULL THEN 'false' ELSE 'true' END)) FROM members WHERE id = ?";

const encodeCursor = (name: string, id: string) => btoa(unescape(encodeURIComponent(JSON.stringify([name, id])))).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
function decodeCursor(cursor: string): [string, string] {
  try {
    const v = JSON.parse(decodeURIComponent(escape(atob(cursor.replaceAll("-", "+").replaceAll("_", "/"))))) as unknown;
    if (Array.isArray(v) && v.length === 2 && typeof v[0] === "string" && typeof v[1] === "string") return [v[0], v[1]];
  } catch {
    /* 下で400 */
  }
  throw new HttpError("VALIDATION_ERROR", undefined, [{ field: "cursor", reason: "invalid_cursor" }]);
}
const likeEscape = (s: string) => s.replace(/[\\%_]/g, (c) => `\\${c}`);
const joinedAtOf = (d: string | null | undefined) => (d ? `${d}T00:00:00.000Z` : null);

/** API-02/03/04: 名簿。許可列(privateFields)は本人またはその団員を対象にした担当(scope)を持つ者の応答にだけ載せる */
export function registerMemberRoutes(app: ApiApp): void {
  // --- API-02 一覧（絞り込み・ページングはSQLで先に行う） ---
  defineRoute(app, "API-02", async (c) => {
    const p = await resolvePrincipal(c);
    const { query } = await parseApiRequest(c, "API-02");
    requirePermission(p, "PER-01", { unitId: p.unitId, type: "member" });

    const where = ["m.unit_id = ?"];
    const binds: unknown[] = [p.unitId];
    if (query.status) { where.push("m.status = ?"); binds.push(query.status); }
    if (query.squad) { where.push("m.squad = ?"); binds.push(query.squad); }
    if (query.q) {
      where.push("(m.display_name || ' ' || coalesce(m.squad, '') || ' ' || coalesce(m.rank, '') || ' ' || m.qualifications) LIKE ? ESCAPE '\\'");
      binds.push(`%${likeEscape(query.q)}%`);
    }
    if (query.cursor) {
      const [name, id] = decodeCursor(query.cursor);
      where.push("(m.display_name > ? OR (m.display_name = ? AND m.id > ?))");
      binds.push(name, name, id);
    }
    const rows = (await c.env.DB.prepare(`SELECT ${COLS} FROM members m WHERE ${where.join(" AND ")} ORDER BY m.display_name, m.id LIMIT ?`)
      .bind(...binds, query.limit + 1).all<MemberRow>()).results;
    const page = rows.slice(0, query.limit);
    const nextCursor = rows.length > query.limit ? encodeCursor(page[page.length - 1]!.display_name, page[page.length - 1]!.id) : undefined;
    const ids = JSON.stringify(page.map((r) => r.id));

    // 管理権(PER-07)を持つ者にだけ、役割と有効な招待を付ける
    const canManage = authorize(p, "PER-07", { unitId: p.unitId, type: "member" }).allowed;
    // 許可列は、本人または担当(scope)を持つ団員の分だけ読む（対象外の行は読まない）
    const readable = page.filter((r) => authorize(p, "PER-06", { unitId: p.unitId, type: "member_private", id: r.id, ownerMemberId: r.id }).allowed).map((r) => r.id);
    const [roles, invites, profiles] = await c.env.DB.batch([
      c.env.DB.prepare("SELECT mr.member_id, r.code FROM member_roles mr JOIN roles r ON r.id = mr.role_id WHERE mr.unit_id = ? AND mr.revoked_at IS NULL AND mr.member_id IN (SELECT value FROM json_each(?)) AND ?")
        .bind(p.unitId, ids, canManage ? 1 : 0),
      c.env.DB.prepare("SELECT member_id, id, version, expires_at FROM invitations WHERE unit_id = ? AND status = 'pending' AND member_id IN (SELECT value FROM json_each(?)) AND ?")
        .bind(p.unitId, ids, canManage ? 1 : 0),
      c.env.DB.prepare("SELECT member_id, allowed_fields FROM member_private_profiles WHERE unit_id = ? AND member_id IN (SELECT value FROM json_each(?))")
        .bind(p.unitId, JSON.stringify(readable)),
    ]);
    const roleMap = new Map<string, string[]>();
    for (const r of roles!.results as { member_id: string; code: string }[]) roleMap.set(r.member_id, [...(roleMap.get(r.member_id) ?? []), r.code]);
    const inviteMap = new Map((invites!.results as { member_id: string; id: string; version: number; expires_at: string }[]).map((i) => [i.member_id, i]));
    const profileMap = new Map((profiles!.results as { member_id: string; allowed_fields: string }[]).map((r) => [r.member_id, JSON.parse(r.allowed_fields) as Record<string, string>]));

    const data = page.map((r) => {
      const dto: Record<string, unknown> = {
        id: r.id, version: r.version, displayName: r.display_name, rank: r.rank, squad: r.squad,
        qualifications: JSON.parse(r.qualifications) as string[], joinedOn: r.joined_at ? r.joined_at.slice(0, 10) : null,
        status: r.status, hasAccount: r.user_id !== null,
      };
      if (canManage) {
        dto.roleCodes = (roleMap.get(r.id) ?? []).filter((x): x is (typeof roleCodes)[number] => (roleCodes as readonly string[]).includes(x));
        const inv = inviteMap.get(r.id);
        dto.invitation = inv ? { id: inv.id, version: inv.version, expiresAt: inv.expires_at } : null;
      }
      const fields = profileMap.get(r.id);
      if (fields && Object.keys(fields).length > 0) dto.privateFields = fields;
      return dto;
    });

    // 他人の許可列を返したことは監査に残す（内容は残さない）
    const viewed = data.filter((d) => d.privateFields && d.id !== p.memberId).map((d) => d.id as string);
    if (viewed.length > 0) {
      const now = new Date().toISOString();
      await c.env.DB.batch(
        viewed.map((id) =>
          c.env.DB.prepare(
            "INSERT INTO audit_logs (id, unit_id, actor_kind, actor_user_id, action, entity_type, entity_id, mutation_id, occurred_at, metadata_json) VALUES (?, ?, 'human', ?, 'member.private.view', 'member', ?, ?, ?, '{}')",
          ).bind(crypto.randomUUID(), p.unitId, p.userId, id, crypto.randomUUID(), now),
        ),
      );
    }
    return ok(c, project("API-02", p, data), { nextCursor });
  });

  // --- API-03 登録 ---
  defineRoute(app, "API-03", async (c) => {
    const p = await resolvePrincipal(c);
    const { body, headers } = await parseApiRequest(c, "API-03");
    requirePermission(p, "PER-06", { unitId: p.unitId, type: "member" });
    const id = crypto.randomUUID();
    const initial = Object.fromEntries(Object.entries(body.privateFields ?? {}).filter(([, v]) => typeof v === "string")) as Record<string, string>;
    const result = await executeMutation(c.env, p, {
      operationCode: "member.create",
      key: headers["idempotency-key"],
      requestHash: await canonicalRequestHash({ method: "POST", path: "/members", body }),
      expectedAuthzVersion: p.authzVersion,
      roots: [],
      created: [{ table: "members", id }],
      statements: (ctx) => [
        c.env.DB.prepare(
          "INSERT INTO members (id, unit_id, display_name, rank, squad, qualifications, joined_at, status, last_mutation_token, created_at, updated_at, created_by, actor_kind) " +
            "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'human')",
        ).bind(id, p.unitId, body.displayName, body.rank ?? null, body.squad ?? null, JSON.stringify(body.qualifications ?? []), joinedAtOf(body.joinedOn), body.status, ctx.attempt, ctx.now, ctx.now, p.userId),
        ...(Object.keys(initial).length > 0
          ? [c.env.DB.prepare(
              "INSERT INTO member_private_profiles (id, unit_id, member_id, allowed_fields, last_mutation_token, created_at, updated_at, created_by, actor_kind) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'human')",
            ).bind(crypto.randomUUID(), p.unitId, id, JSON.stringify(initial), ctx.attempt, ctx.now, ctx.now, p.userId)]
          : []),
      ],
      audit: { action: "member.create", entityType: "member", entityId: id, metadata: { status: body.status } },
      event: { entityType: "member", entityId: id, entityVersion: 1, eventType: "member.created", payload: { status: body.status } },
      response: { status: 201, sql: MEMBER_JSON, binds: [id], decode: (j) => Member.parse(j) },
    });
    return ok(c, result.data, {}, 201);
  });

  // --- API-04 変更（基本項目=管理者、許可列=本人または担当、状態=管理者。版が古ければ409） ---
  defineRoute(app, "API-04", async (c) => {
    const p = await resolvePrincipal(c);
    const { params, body, headers } = await parseApiRequest(c, "API-04");
    const current = await c.env.DB.prepare(`SELECT ${COLS} FROM members m WHERE m.id = ? AND m.unit_id = ?`).bind(params.id, p.unitId).first<MemberRow>();
    if (!current) throw new HttpError("NOT_FOUND"); // 別unitも同じ応答

    const { version, privateFields, status, reason, ...basic } = body;
    const basicKeys = Object.keys(basic).filter((k) => (basic as Record<string, unknown>)[k] !== undefined);
    const privKeys = Object.keys(privateFields ?? {}).filter((k) => (privateFields as Record<string, unknown>)[k] !== undefined);
    const statusChange = status !== undefined && status !== current.status;
    if (basicKeys.length + privKeys.length === 0 && !statusChange) {
      throw new HttpError("VALIDATION_ERROR", undefined, [{ field: "(body)", reason: "no_changes" }]);
    }
    if (basicKeys.length > 0) requirePermission(p, "PER-06", { unitId: p.unitId, type: "member", id: params.id });
    if (privKeys.length > 0) requirePermission(p, "PER-06", { unitId: p.unitId, type: "member_private", id: params.id, ownerMemberId: params.id });
    if (statusChange) {
      requirePermission(p, "PER-07", { unitId: p.unitId, type: "member", id: params.id });
      // 状態を変える操作には理由が要る（変更された行に残す。監査には複製しない）
      if (!reason) throw new HttpError("VALIDATION_ERROR", undefined, [{ field: "reason", reason: "reason_required" }]);
      if (current.user_id) {
        // アカウントのある団員：停止は「状態＋利用者の停止＋認可版の増分＋全セッション失効」を一体で行う（T012）。
        // 再開（active）は未提供：停止した認証を復活させる手順は別途設計する
        if (status === "active") throw new HttpError("INVALID_TRANSITION", undefined, [{ field: "status", reason: "reactivation_not_supported" }]);
        if (basicKeys.length + privKeys.length > 0) {
          throw new HttpError("VALIDATION_ERROR", undefined, [{ field: "status", reason: "status_change_must_be_alone" }]);
        }
        const u = await c.env.DB.prepare("SELECT authz_version FROM users WHERE id = ?").bind(current.user_id).first<{ authz_version: number }>();
        const out = await disableUser(c, p, {
          memberId: params.id, version, status: status as "paused" | "retired", reason,
          expectedAuthzVersion: u!.authz_version, key: headers["idempotency-key"],
          requestHash: await canonicalRequestHash({ method: "PATCH", path: `/members/${params.id}`, baseVersion: version, body }),
        });
        return ok(c, out.member);
      }
    }

    const sets: string[] = [];
    const setBinds: unknown[] = [];
    const col = (name: string, value: unknown) => { sets.push(`${name} = ?`); setBinds.push(value); };
    if (body.displayName !== undefined) col("display_name", body.displayName);
    if (body.rank !== undefined) col("rank", body.rank);
    if (body.squad !== undefined) col("squad", body.squad);
    if (body.qualifications !== undefined) col("qualifications", JSON.stringify(body.qualifications));
    if (body.joinedOn !== undefined) col("joined_at", joinedAtOf(body.joinedOn));
    if (statusChange) { col("status", status); col("status_reason", reason); }

    const changed = [...basicKeys, ...(status !== undefined ? ["status"] : []), ...(privKeys.length ? ["privateFields"] : [])].join(".");
    const result = await executeMutation(c.env, p, {
      operationCode: "member.update",
      key: headers["idempotency-key"],
      requestHash: await canonicalRequestHash({ method: "PATCH", path: `/members/${params.id}`, baseVersion: version, body }),
      expectedAuthzVersion: p.authzVersion,
      roots: [{ table: "members", id: params.id, expectedVersion: version }],
      // 状態を変えるとき、アカウントが付いていないことを書込と同じ瞬間に確認する（事前の読取との競合を防ぐ）
      conditions: statusChange
        ? [{ existsSql: "SELECT 1 FROM members WHERE id = ? AND unit_id = ? AND user_id IS NULL", binds: [params.id, p.unitId], failCode: "INVALID_TRANSITION" }]
        : [],
      statements: (ctx) => {
        const stmts = [
          c.env.DB.prepare(
            `UPDATE members SET ${[...sets, "version = version + 1", "last_mutation_token = ?", "updated_at = ?"].join(", ")} WHERE id = ? AND unit_id = ? AND version = ?`,
          ).bind(...setBinds, ctx.attempt, ctx.now, params.id, p.unitId, version),
        ];
        if (privKeys.length > 0) {
          stmts.push(
            c.env.DB.prepare(
              "INSERT INTO member_private_profiles (id, unit_id, member_id, allowed_fields, last_mutation_token, created_at, updated_at, created_by, actor_kind) " +
                "VALUES (?, ?, ?, '{}', ?, ?, ?, ?, 'human') ON CONFLICT (member_id) DO NOTHING",
            ).bind(crypto.randomUUID(), p.unitId, params.id, ctx.attempt, ctx.now, ctx.now, p.userId),
          );
          // キーは許可リストの固定名だけ（利用者の入力をSQLの文字列に入れない）
          let expr = "allowed_fields";
          const eb: unknown[] = [];
          for (const k of privateFieldNames) {
            const v = (privateFields as Record<string, string | null | undefined>)[k];
            if (v === undefined) continue;
            if (v === null) expr = `json_remove(${expr}, '$.${k}')`;
            else { expr = `json_set(${expr}, '$.${k}', ?)`; eb.push(v); }
          }
          stmts.push(
            c.env.DB.prepare(`UPDATE member_private_profiles SET allowed_fields = ${expr}, version = version + 1, last_mutation_token = ?, updated_at = ? WHERE member_id = ? AND unit_id = ?`)
              .bind(...eb, ctx.attempt, ctx.now, params.id, p.unitId),
          );
        }
        // 休団・退団にしたら、未使用の招待は取り消す（受領されて復活しないように）
        if (statusChange && status !== "active") {
          stmts.push(
            c.env.DB.prepare(
              "UPDATE invitations SET status = 'cancelled', cancelled_at = ?, cancel_reason = 'member_inactive', version = version + 1, updated_at = ?, last_mutation_token = ? WHERE member_id = ? AND unit_id = ? AND status = 'pending'",
            ).bind(ctx.now, ctx.now, ctx.attempt, params.id, p.unitId),
          );
        }
        return stmts;
      },
      audit: { action: "member.update", entityType: "member", entityId: params.id, metadata: { changed } },
      event: { entityType: "member", entityId: params.id, entityVersion: version + 1, eventType: "member.updated", payload: { changed } },
      response: { status: 200, sql: MEMBER_JSON, binds: [params.id], decode: (j) => Member.parse(j) },
    });
    return ok(c, result.data);
  });
}

export type { AuthzPrincipal };
