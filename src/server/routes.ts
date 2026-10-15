import type { ApiApp } from "./http";
import { registerAuthRoutes } from "./routes/auth";
import { registerAuditRoutes } from "./routes/audit";
import { registerInvitationRoutes } from "./routes/invitations";
import { registerJobRoutes } from "./routes/jobs";
import { registerMemberRoutes } from "./routes/members";
import { registerRoleRoutes } from "./routes/member-roles";
import { registerRevocationRoutes } from "./routes/session-revocations";
import { registerMeRoutes } from "./routes/me";
import { registerUploadRoutes } from "./attachments/upload";
import { registerAttachmentRoutes } from "./routes/attachments";
import { registerFacilityWriteRoutes } from "./routes/facility-writes";
import { registerFacilityDetailRoutes } from "./routes/facility-detail";
import { registerFacilityListRoutes } from "./routes/facility-list";
import { registerImportPreviewRoutes } from "./routes/import-preview";
import { registerImportCommitRoutes, registerFacilityExportRoutes } from "./routes/import-commit";
import { registerAssetRoutes } from "./routes/assets";
import { registerInspectionTemplateRoutes } from "./routes/inspection-templates";
import { registerFacilityInspectionRoutes } from "./routes/facility-inspections";
import { registerAssetInspectionRoutes } from "./routes/asset-inspections";
import { registerInspectionCorrectionRoutes } from "./routes/inspection-corrections";
import { registerIssueRoutes } from "./routes/issues";
import { registerAttendanceRoutes } from "./routes/attendance";
import { registerActivityRoutes } from "./routes/activities";
import { registerActivityResultRoutes } from "./routes/activity-results";

// APIルートの登録点。各ドメインのroute登録関数を後続タスクがここへ追加する。
export function registerRoutes(app: ApiApp): void {
  registerAuthRoutes(app);
  registerJobRoutes(app);
  registerMeRoutes(app);
  registerInvitationRoutes(app);
  registerMemberRoutes(app);
  registerRoleRoutes(app);
  registerRevocationRoutes(app);
  registerAuditRoutes(app);
  registerUploadRoutes(app);
  registerAttachmentRoutes(app);
  // 固定パス（/facilities/export など）は /facilities/:id より先に照合する（docs/05 §1、Honoは登録順）
  registerImportCommitRoutes(app);
  registerFacilityExportRoutes(app);
  registerFacilityWriteRoutes(app);
  registerFacilityDetailRoutes(app);
  registerFacilityListRoutes(app);
  registerImportPreviewRoutes(app);
  registerAssetRoutes(app);
  registerInspectionTemplateRoutes(app);
  registerFacilityInspectionRoutes(app);
  registerAssetInspectionRoutes(app);
  registerInspectionCorrectionRoutes(app);
  registerIssueRoutes(app);
  // 固定パス（/activities/:id/attendance/me）は /activities/:id/attendance/:memberId より先に照合する（docs/05 §1、Honoは登録順）
  registerAttendanceRoutes(app);
  registerActivityRoutes(app);
  registerActivityResultRoutes(app);
}
