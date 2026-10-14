import { Id } from "../../shared/contracts/common";
import { CSV_MAX_ROWS, CSV_TEMPLATE_VERSION, parseFacilityCsv, validateFacilityRow } from "../gis/csv";
import { loadAttachment } from "../attachments/upload";
import { sha256OfBytes } from "../attachments/sizes";
import { resolvePrincipal } from "../auth/principal";
import { HttpError, defineRoute, ok, parseApiRequest, type ApiApp } from "../http";
import { canonicalRequestHash } from "../mutations/hash";
import { executeMutation } from "../mutations/execute";
import { enqueueJobStatement } from "../jobs/store";
import "../jobs/handlers/import"; // 解析・確定job handlerの登録（Cron/Queueと同じ登録点）
import { requirePermission } from "./invitations";

/**
 * 施設CSV取込みのプレビュー依頼（T023、docs/05 API-53）。
 * 解析は永続job（import.parse）で行い、業務台帳は変更しない。202は受付であり完了ではない。
 */
export function registerImportPreviewRoutes(app: ApiApp): void {
  defineRoute(app, "API-53", async (c) => {
    const p = await resolvePrincipal(c);
    const { body, headers } = await parseApiRequest(c, "API-53");
    requirePermission(p, "PER-03", { unitId: p.unitId, type: "facility" });
    if (body.templateVersion !== CSV_TEMPLATE_VERSION) {
      throw new HttpError("VALIDATION_ERROR", undefined, [{ field: "templateVersion", reason: "unsupported_template" }]);
    }
    // CSV添付はreadyで、この分団の・自分が読めるものだけ
    const att = await loadAttachment(c.env, body.csvAttachmentId, p.unitId);
    if (!att || att.content_type !== "text/csv" || (att.status !== "ready" && att.status !== "checking" && att.status !== "uploaded")) {
      throw new HttpError("NOT_FOUND");
    }
    if (att.status !== "ready") throw new HttpError("ATTACHMENT_NOT_READY");
    // 事前の行数チェック（上限超のCSVをjobに回さない）
    if (att.ready_key) {
      const obj = await c.env.FILES.get(att.ready_key);
      if (obj) {
        const bytes = new Uint8Array(await obj.arrayBuffer());
        const parsed = parseFacilityCsv(bytes, body.templateVersion);
        if (!parsed.ok) {
          throw new HttpError("VALIDATION_ERROR", undefined, [{ field: "csvAttachmentId", reason: parsed.error }]);
        }
      }
    }
    const id = crypto.randomUUID();
    const parseJob = enqueueJobStatement(c.env, {
      unitId: p.unitId,
      kind: "import.parse",
      sourceType: "import_batch",
      sourceId: id,
      sourceVersion: 1,
      configVersion: CSV_TEMPLATE_VERSION,
      requestedBy: p.userId,
      dedupeKey: `${p.unitId}|import.parse|import_batch|${id}|1|${CSV_TEMPLATE_VERSION}`,
    });
    const result = await executeMutation(c.env, p, {
      operationCode: "facility.import.preview",
      key: headers["idempotency-key"],
      requestHash: await canonicalRequestHash({ method: "POST", path: "/facilities/imports", body }),
      expectedAuthzVersion: p.authzVersion,
      roots: [],
      created: [{ table: "import_batches", id }],
      statements: (ctx) => [
        c.env.DB.prepare(
          "INSERT INTO import_batches (id, unit_id, attachment_id, template_version, status, last_mutation_token, created_at, updated_at, created_by, actor_kind) " +
            "VALUES (?, ?, ?, ?, 'pending', ?, ?, ?, ?, 'human')",
        ).bind(id, p.unitId, body.csvAttachmentId, body.templateVersion, ctx.attempt, ctx.now, ctx.now, p.userId),
        parseJob.statement,
      ],
      audit: { action: "facility.import.preview", entityType: "import_batch", entityId: id, metadata: { attachmentId: body.csvAttachmentId } },
      event: { entityType: "import_batch", entityId: id, entityVersion: 1, eventType: "import_batch.created" },
      response: {
        status: 202,
        sql: "SELECT json_object('id', b.id, " +
          "'jobId', (SELECT j.id FROM jobs j WHERE j.source_type = 'import_batch' AND j.source_id = b.id AND j.kind = 'import.parse' ORDER BY j.created_at DESC LIMIT 1), " +
          "'status', b.status, 'version', b.version, 'totalRows', b.total_rows, 'validRows', b.valid_rows, 'errorRows', b.error_rows, 'previewHash', b.preview_hash) " +
          "FROM import_batches b WHERE b.id = ?",
        binds: [id],
        decode: (j) => ({
          id: Id.parse((j as { id: string }).id),
          jobId: Id.parse((j as { jobId: string }).jobId),
          status: (j as { status: string | null }).status ?? null,
          version: (j as { version: number | null }).version ?? null,
          totalRows: (j as { totalRows: number | null }).totalRows ?? null,
          validRows: (j as { validRows: number | null }).validRows ?? null,
          errorRows: (j as { errorRows: number | null }).errorRows ?? null,
          previewHash: (j as { previewHash: string | null }).previewHash ?? null,
        }),
      },
    });
    try {
      await c.env.JOBS_QUEUE.send({ jobId: parseJob.id });
    } catch (err) {
      console.error(JSON.stringify({ event: "job_queue_send_failed", jobId: parseJob.id, error: String(err) }));
    }
    return ok(c, result.data, {}, 202);
  });
}
