import { z } from "zod";
import {
  BusinessDate, Id, IDEM, P_ID, Reason, ShortText, Version, defineApi, listQuery, noContent, obj, provisionalDto, Page,
} from "./common";
import { memberStates } from "../states";

/** docs/10: 固定4役割（D03）。業務役割への割当は別。 */
export const roleCodes = ["member", "operator", "officer", "admin"] as const;
const PerCode = z.string().regex(/^PER-(0[1-9]|1[0-4])$/);

export const Scope = obj({
  entityType: ShortText,
  entityId: Id,
  permissions: z.array(PerCode).min(1).max(14),
  expiresAt: z.iso.datetime().optional(),
});
/** 応答の担当。期限なしは null */
export const ScopeOut = obj({
  entityType: ShortText,
  entityId: Id,
  permissions: z.array(PerCode),
  expiresAt: z.string().nullable(),
});
/** 役割・担当を全置換した結果（API-37）。authzVersion は変更後の対象利用者の認可版 */
export const MemberRoles = obj({
  memberId: Id,
  version: z.number().int().min(1),
  authzVersion: z.number().int().min(1),
  roleCodes: z.array(z.enum(roleCodes)),
  scopes: z.array(ScopeOut),
});
/** 全セッション失効の結果（API-38）。completed=認証側のセッションを削除済み、pending=失敗して再試行待ち（業務側は新規要求を既に拒否） */
export const RevocationResult = obj({
  userId: Id,
  authzVersion: z.number().int().min(1),
  sessionRevocation: z.enum(["completed", "pending"]),
});

export const Me = obj({
  profile: obj({ memberId: Id, displayName: ShortText, rank: ShortText.nullable() }),
  /** 表示用の所属名（サイドバー/メニュー）。PH1でT008が追加（prototypeの分団カード） */
  unitName: ShortText,
  roles: z.array(z.enum(roleCodes)),
  authzVersion: z.number().int().min(0),
  policyVersion: z.string(),
  /** 二要素認証が有効か／この利用者に必須か（管理者）。必須で未設定なら管理系の操作は拒否される */
  mfaEnabled: z.boolean(),
  mfaRequired: z.boolean(),
});

/**
 * API-36 の固定版（V01）。認証ライブラリの公式スキーマに従い、業務envelope・Idempotency-Key対象外。
 * ここに無い経路は Worker が JSON 404 で終わらせる（自由なsign-up・外部連携・プロフィール更新等は公開しない）。
 * sign-up は招待tokenを持つ場合だけ通る（x-invitation-token）。
 */
export const authLibrary = {
  name: "better-auth",
  version: "1.7.7",
  basePath: "/api/auth",
  endpoints: [
    { method: "POST", path: "/sign-up/email", purpose: "招待に束縛した登録（x-invitation-token必須。自由登録は403）" },
    { method: "POST", path: "/sign-in/email", purpose: "メール＋パスワードのログイン（二要素が有効なら twoFactorRedirect）" },
    { method: "POST", path: "/sign-out", purpose: "ログアウト（このセッションを失効）" },
    { method: "GET", path: "/get-session", purpose: "認証identityの確認（業務の権限は /api/v1/me）" },
    { method: "POST", path: "/request-password-reset", purpose: "再設定tokenの発行要求（登録の有無を応答に出さない）" },
    { method: "POST", path: "/reset-password", purpose: "再設定tokenでパスワード変更（一回限り・成功後に全セッション失効）" },
    { method: "POST", path: "/change-password", purpose: "ログイン中の本人がパスワード変更（現在のパスワード必須）" },
    { method: "POST", path: "/two-factor/enable", purpose: "二要素の設定開始（パスワード再確認。TOTPと回復コードを返す）" },
    { method: "POST", path: "/two-factor/verify-totp", purpose: "TOTP確認（設定の完了、またはログインの二要素）" },
    { method: "POST", path: "/two-factor/verify-backup-code", purpose: "回復コードでログイン（各コード一回限り）" },
    { method: "POST", path: "/two-factor/generate-backup-codes", purpose: "回復コードの再発行（パスワード再確認。旧コードは無効）" },
    { method: "POST", path: "/two-factor/get-totp-uri", purpose: "TOTP登録URIの再表示（パスワード再確認）" },
    { method: "POST", path: "/two-factor/disable", purpose: "二要素の解除（パスワード再確認）" },
  ],
} as const;

/** D02の検証設定：保存できる個人情報（許可リスト）。増やすときは drizzle/0006 のトリガーも変更する */
export const privateFieldNames = ["phone", "emergencyContact"] as const;
const PrivateText = z.string().min(1).max(200);
/** 許可列だけ。null はその項目の削除。未知の列は400 */
export const PrivateFields = obj({ phone: PrivateText.nullable().optional(), emergencyContact: PrivateText.nullable().optional() });
export const Qualifications = z.array(z.string().min(1).max(40)).max(10);
/** 名簿の団員。privateFields は本人またはその団員を対象にした担当(scope)を持つ者の応答にだけ現れる。roleCodes/invitation は招待・権限の管理権(PER-07)を持つ者だけ */
export const Member = obj({
  id: Id,
  version: z.number().int().min(1),
  displayName: ShortText,
  rank: ShortText.nullable(),
  squad: ShortText.nullable(),
  qualifications: Qualifications,
  joinedOn: BusinessDate.nullable(),
  status: z.enum(memberStates),
  hasAccount: z.boolean(),
  roleCodes: z.array(z.enum(roleCodes)).optional(),
  invitation: obj({ id: Id, version: z.number().int().min(1), expiresAt: z.string() }).nullable().optional(),
  privateFields: obj({ phone: PrivateText.optional(), emergencyContact: PrivateText.optional() }).optional(),
});

export const invitationStates = ["pending", "consumed", "cancelled"] as const;
/** 招待。生tokenは作成した応答の一回だけ（再送・一覧では null）。token_hash/email_hashは返さない */
export const Invitation = obj({
  id: Id,
  version: z.number().int().min(1),
  memberId: Id,
  status: z.enum(invitationStates),
  expiresAt: z.string(),
  token: z.string().nullable(),
});
/** 招待の受領結果。団員にリンクされ、役割が付いた状態 */
export const AccountLinkResult = obj({
  memberId: Id,
  linked: z.literal(true),
  roleCodes: z.array(z.enum(roleCodes)),
  authzVersion: z.number().int().min(1),
});

// 名簿・招待・役割（PH1で詳細化）。応答DTOは04/10の確定待ちのため provisional。
export const authApis = {
  "API-01": defineApi({
    method: "GET", path: "/me", permission: "PER-01", kind: "get", success: [200],
    request: obj({}), response: Me,
  }),
  "API-02": defineApi({
    method: "GET", path: "/members", permission: "PER-06", kind: "list", success: [200],
    request: obj({ query: listQuery({ q: ShortText.optional(), status: z.enum(memberStates).optional(), squad: ShortText.optional() }) }),
    response: Page(Member),
  }),
  "API-03": defineApi({
    method: "POST", path: "/members", permission: "PER-06", kind: "mutation", success: [201],
    request: obj({
      body: obj({
        displayName: ShortText, status: z.enum(memberStates), rank: ShortText.optional(),
        squad: ShortText.optional(), qualifications: Qualifications.optional(), joinedOn: BusinessDate.optional(),
        privateFields: PrivateFields.optional(),
      }),
      ...IDEM,
    }),
    response: Member,
  }),
  "API-04": defineApi({
    method: "PATCH", path: "/members/:id", permission: "PER-06/07", kind: "mutation", success: [200],
    request: obj({
      params: P_ID,
      body: obj({
        version: Version, displayName: ShortText.optional(), status: z.enum(memberStates).optional(),
        rank: ShortText.nullable().optional(), squad: ShortText.nullable().optional(),
        qualifications: Qualifications.optional(), joinedOn: BusinessDate.nullable().optional(),
        privateFields: PrivateFields.optional(),
        /** 休団・退団（利用停止）には必須。理由は変更された行に残し、監査には複製しない */
        reason: Reason.optional(),
      }),
      ...IDEM,
    }),
    response: Member,
  }),
  "API-33": defineApi({
    method: "POST", path: "/invitations", permission: "PER-07", kind: "mutation", success: [201],
    request: obj({
      body: obj({ memberId: Id, email: z.email(), expiresInHours: z.number().int().min(1).max(24 * 30) }),
      ...IDEM,
    }),
    // 生tokenは作成時の一回だけ返す
    response: Invitation,
  }),
  "API-34": defineApi({
    method: "POST", path: "/invitations/:id/cancel", permission: "PER-07", kind: "mutation", success: [200],
    request: obj({ params: P_ID, body: obj({ version: Version, reason: Reason }), ...IDEM }),
    response: Invitation,
  }),
  "API-35": defineApi({
    method: "POST", path: "/invitations/accept", permission: "token＋認証所有確認", kind: "mutation", success: [200],
    request: obj({
      body: obj({ token: z.string().min(16).max(512), verifiedAuthIdentity: ShortText }),
      ...IDEM,
    }),
    response: AccountLinkResult,
  }),
  // 認証ライブラリ(D04固定版)の公式スキーマに従う。業務envelope・Idempotency-Key対象外（T007で検証）。
  "API-36": defineApi({
    method: "ALL", path: "/api/auth/*", permission: "認証ライブラリ", kind: "external", success: [200],
    request: z.unknown(), response: noContent,
  }),
  "API-37": defineApi({
    method: "PUT", path: "/members/:id/roles", permission: "PER-07", kind: "mutation", success: [200],
    request: obj({
      params: P_ID,
      body: obj({
        version: Version, expectedAuthzVersion: z.number().int().min(0),
        roleCodes: z.array(z.enum(roleCodes)).min(1).max(roleCodes.length),
        scopes: z.array(Scope).max(100), reason: Reason,
      }),
      ...IDEM,
    }),
    response: MemberRoles,
  }),
  "API-38": defineApi({
    method: "POST", path: "/users/:id/session-revocations", permission: "PER-07/本人", kind: "mutation", success: [200],
    request: obj({
      params: P_ID,
      body: obj({ expectedAuthzVersion: z.number().int().min(0), reason: Reason }),
      ...IDEM,
    }),
    response: RevocationResult,
  }),
} as const;
