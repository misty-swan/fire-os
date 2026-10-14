import type { AuthzPrincipal, ScopeGrant } from "./principal";

/**
 * 認可（docs/10）。判定 = 有効セッション AND 利用可能ユーザー/団員 AND 所属一致 AND 操作権限 AND 対象範囲 AND 項目許可 AND 状態前提。
 * 前の3つは resolvePrincipal が毎要求D1から引いた最新状態（停止・失効は主体が得られず 401）。ここでは残りを判定する。
 *
 * **表の値は「検証用の既定」で、業務承認ではない（D03未承認）**。docs/10 の△（管理主体の承認が必要）は最小権限で既定拒否にし、
 * 必要が確定した操作から付与する。変更するときは下の RULES と tests/authorization.test.ts の期待表、docs/10 を一緒に直す。
 * unitId/actorId/role をリクエストの自己申告から決めない（呼び出し側は principal だけを渡す）。
 */

export const POLICY_VERSION = "ph1-2026-10-14";

export const PERMISSION_CODES = [
  "PER-01", "PER-02", "PER-03", "PER-04", "PER-05", "PER-06", "PER-07",
  "PER-08", "PER-09", "PER-10", "PER-11", "PER-12", "PER-13", "PER-14",
] as const;
export type PermissionCode = (typeof PERMISSION_CODES)[number];
export type RoleCode = "member" | "operator" | "officer" | "admin";

/** 認可の対象。type は 'member'(名簿の基本項目) / 'member_private'(許可列) / 'facility' など。ownerMemberId は本人性の判定に使う */
export interface ResourceRef {
  unitId: string;
  type: string;
  id?: string;
  ownerMemberId?: string;
}

export type DenyReason = "other_unit" | "role" | "scope_required" | "not_owner" | "mfa_required";
export type Authorization = { allowed: true } | { allowed: false; reason: DenyReason };

interface Rule {
  /** 対象の範囲に関係なく許す役割（所属unit内） */
  unitWide?: readonly RoleCode[];
  /** 明示された担当(scope)があれば許す役割。scopeは「対象種別×対象ID×操作」に一致するもの */
  scoped?: readonly RoleCode[];
  /** 本人の対象だけ許す役割 */
  self?: readonly RoleCode[];
  /** 管理系の操作は二要素認証の済んだ利用者だけ（D04推奨：管理者MFA） */
  mfa?: boolean;
}

const ALL: readonly RoleCode[] = ["member", "operator", "officer", "admin"];
const MANAGERS: readonly RoleCode[] = ["officer", "admin"];

export const RULES: Record<PermissionCode, Rule> = {
  "PER-01": { unitWide: ALL },
  "PER-02": { self: ALL },
  "PER-03": { unitWide: MANAGERS, scoped: ["operator"] },
  "PER-04": { unitWide: MANAGERS, scoped: ["operator"], self: ["member"] },
  "PER-05": { unitWide: MANAGERS, scoped: ["operator"] },
  // PER-06 は対象の type で分岐する（下の authorize）。ここは役割による一般則を持たない
  "PER-06": {},
  "PER-07": { unitWide: ["admin"], mfa: true },
  "PER-08": { unitWide: ["admin"], scoped: ["operator"], mfa: true },
  "PER-09": { unitWide: MANAGERS, scoped: ["operator"], self: ["member"] },
  "PER-10": { unitWide: MANAGERS, scoped: ["operator"] },
  "PER-11": { unitWide: ALL },
  "PER-12": { unitWide: MANAGERS, scoped: ["operator"], self: ["member"] },
  "PER-13": { unitWide: ALL },
  "PER-14": { unitWide: MANAGERS, scoped: ["operator"] },
};

const hasRole = (p: AuthzPrincipal, roles: readonly RoleCode[] | undefined) => !!roles && p.roles.some((r) => roles.includes(r));

/** 担当(scope)に、対象×操作が明示されているか。期限切れ・取消済みは resolvePrincipal の段階で除かれている */
export function hasScope(p: AuthzPrincipal, action: PermissionCode, target: ResourceRef): boolean {
  if (!target.id) return false;
  return p.scopes.some((s: ScopeGrant) => s.entityType === target.type && s.entityId === target.id && s.permissions.includes(action));
}

/**
 * 操作 action を対象 target に対して許すか。不明・該当なしは拒否（deny優先）。
 * 管理者であることだけでは、機微データ（名簿の許可列など）を読めない（権限マトリクス §1）。
 */
export function authorize(p: AuthzPrincipal, action: PermissionCode, target: ResourceRef): Authorization {
  if (target.unitId !== p.unitId) return { allowed: false, reason: "other_unit" };
  const rule = RULES[action];
  if (rule.mfa && !p.mfaEnabled) return { allowed: false, reason: "mfa_required" };

  if (action === "PER-06") {
    // 名簿の許可列(PERSONAL): 本人、または**その団員を対象にした明示的な担当(scope)**を持つ者だけ。役割（管理者を含む）では開かない
    if (target.type === "member_private") {
      if (target.ownerMemberId && target.ownerMemberId === p.memberId) return { allowed: true };
      return hasScope(p, action, { ...target, type: "member", id: target.id }) ? { allowed: true } : { allowed: false, reason: "scope_required" };
    }
    // 名簿の基本項目(氏名・役職・状態)の登録/変更は管理者
    if (target.type === "member") {
      if (!hasRole(p, ["admin"])) return { allowed: false, reason: "role" };
      return p.mfaEnabled ? { allowed: true } : { allowed: false, reason: "mfa_required" }; // 管理者の操作は二要素必須
    }
    return { allowed: false, reason: "role" };
  }

  if (hasRole(p, rule.unitWide)) return { allowed: true };
  if (hasRole(p, rule.self) && target.ownerMemberId === p.memberId && target.ownerMemberId) return { allowed: true };
  if (hasRole(p, rule.scoped)) return hasScope(p, action, target) ? { allowed: true } : { allowed: false, reason: "scope_required" };
  if (hasRole(p, rule.self)) return { allowed: false, reason: "not_owner" };
  return { allowed: false, reason: "role" };
}

/** 一覧・件数の絞り込み。許可された対象だけを残す（全件取得後にUIで隠さず、サーバーで先に絞る原則の最小実装） */
export function filterAuthorized<T extends ResourceRef>(p: AuthzPrincipal, action: PermissionCode, refs: readonly T[]): T[] {
  return refs.filter((r) => authorize(p, action, r).allowed);
}
