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
import { registerInspectionScheduleRoutes } from "./routes/inspection-schedules";
import { registerInspectionTemplateRoutes } from "./routes/inspection-templates";
import { registerFacilityInspectionRoutes } from "./routes/facility-inspections";
import { registerAssetInspectionRoutes } from "./routes/asset-inspections";
import { registerInspectionCorrectionRoutes } from "./routes/inspection-corrections";
import { registerIssueRoutes } from "./routes/issues";
import { registerTaskRoutes } from "./routes/tasks";
import { registerAttendanceRoutes } from "./routes/attendance";
import { registerActivityRoutes } from "./routes/activities";
import { registerActivityResultRoutes } from "./routes/activity-results";
import { registerActivityListRoutes } from "./routes/activity-list";
import { registerIncidentRoutes } from "./routes/incidents";
import { registerParticipantRoutes } from "./routes/incident-participants";
import { registerResourceUsageRoutes } from "./routes/resource-usages";
import { registerOperationLinkRoutes } from "./routes/incident-activity";
import { registerAnnouncementRoutes } from "./routes/announcements";
import { registerNotificationRoutes } from "./routes/notifications";
import { registerClassificationRoutes } from "./routes/ai-classification";
import { registerDashboardRoutes } from "./routes/dashboard";

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
  // PUT /assets/:type/:id/inspection-schedule（API-56）は /assets/:type/:id（API-51）とpathが重なるため
  // asset routesの後に登録する（methodが異なるため照合順の影響はない。docs/05 API-56）
  registerInspectionScheduleRoutes(app);
  registerInspectionTemplateRoutes(app);
  registerFacilityInspectionRoutes(app);
  registerAssetInspectionRoutes(app);
  registerInspectionCorrectionRoutes(app);
  registerIssueRoutes(app);
  registerTaskRoutes(app);
  // 固定パス（/activities/:id/attendance/me）は /activities/:id/attendance/:memberId より先に照合する（docs/05 §1、Honoは登録順）
  registerAttendanceRoutes(app);
  registerActivityRoutes(app);
  registerActivityResultRoutes(app);
  registerActivityListRoutes(app);
  registerIncidentRoutes(app);
  registerParticipantRoutes(app);
  registerResourceUsageRoutes(app);
  registerOperationLinkRoutes(app);
  registerAnnouncementRoutes(app);
  // GET /notifications/me（API-67）は /notifications/:id（API-65）とpathが重なるため先に登録する（docs/05 §1、Honoは登録順）
  registerNotificationRoutes(app);
  registerClassificationRoutes(app);
  registerDashboardRoutes(app);
}
