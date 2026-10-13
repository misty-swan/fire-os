import { POLICY_VERSION } from "../auth/authorize";
import { resolvePrincipal } from "../auth/principal";
import { project } from "../auth/projection";
import { defineRoute, ok, parseApiRequest, type ApiApp } from "../http";

/** API-01: 現在のprofile/役割/認可版/ポリシー版。毎回D1の最新状態から作る（Cookieや認証ライブラリの値は使わない）。 */
export function registerMeRoutes(app: ApiApp): void {
  defineRoute(app, "API-01", async (c) => {
    const p = await resolvePrincipal(c);
    await parseApiRequest(c, "API-01");
    return ok(
      c,
      project("API-01", p, {
        profile: { memberId: p.memberId, displayName: p.displayName, rank: p.rank },
        unitName: p.unitName,
        roles: p.roles,
        authzVersion: p.authzVersion,
        policyVersion: POLICY_VERSION,
        mfaEnabled: p.mfaEnabled,
        mfaRequired: p.roles.includes("admin"),
      }),
    );
  });
}
