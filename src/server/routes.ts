import type { ApiApp } from "./http";
import { registerAuthRoutes } from "./routes/auth";
import { registerInvitationRoutes } from "./routes/invitations";
import { registerJobRoutes } from "./routes/jobs";
import { registerMemberRoutes } from "./routes/members";
import { registerRoleRoutes } from "./routes/member-roles";
import { registerRevocationRoutes } from "./routes/session-revocations";
import { registerMeRoutes } from "./routes/me";

// APIルートの登録点。各ドメインのroute登録関数を後続タスクがここへ追加する。
export function registerRoutes(app: ApiApp): void {
  registerAuthRoutes(app);
  registerJobRoutes(app);
  registerMeRoutes(app);
  registerInvitationRoutes(app);
  registerMemberRoutes(app);
  registerRoleRoutes(app);
  registerRevocationRoutes(app);
}
