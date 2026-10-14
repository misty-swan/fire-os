import { z } from "zod";
import { Id, LIMITS, Version } from "../../shared/contracts/common";
import { resolvePrincipal } from "../auth/principal";
import { HttpError, defineRoute, ok, parseApiRequest, type ApiApp } from "../http";
import { canonicalRequestHash } from "../mutations/hash";
import { executeMutation } from "../mutations/execute";
import { requirePermission } from "./invitations";

/**
 * 点検様式の版と承認（T027、docs/05 API-94〜97、docs/11、D06）。
 * 様式root + 追記型の版。承認済みの版は不変（DBトリガー）。承認の流れは draft→in_review→approved/changes_requested。
 * 様式は架空の検証設定（D06未承認）。実団体の正式点検票として承認済みと表示しない。
 */

const TEMPLATE_JSON =
  "SELECT json_object(" +
  "'id', t.id, 'version', t.version, 'name', t.name, 'targetType', t.target_type, 'status', t.status, " +
  "'currentVersion', (SELECT json_object('id', v.id, 'revisionNo', v.revision_no, 'status', v.status, 'itemSchema', json(v.item_schema), 'approvedAt', v.approved_at) " +
  "FROM inspection_template_versions v WHERE v.id = t.current_version_id), " +
  "'versions', (SELECT json_group_array(json_object('id', v.id, 'revisionNo', v.revision_no, 'status', v.status, 'itemSchema', json(v.item_schema), 'approvedAt', v.approved_at, 'createdAt', v.created_at)) " +
  "FROM inspection_template_versions v WHERE v.template_id = t.id AND v.unit_id = t.unit_id ORDER BY v.revision_no)) " +
  "FROM inspection_templates t WHERE t.id = ?";

interface TemplateRow {
  id: string; unit_id: string; version: number; name: string; target_type: string; current_version_id: string | null; status: string;
}
interface VersionRow {
  id: string; unit_id: string; template_id: string; revision_no: number; item_schema: string;
  status: "draft" | "in_review" | "approved" | "changes_requested" | "superseded"; version: number;
}

export function registerInspectionTemplateRoutes(app: ApiApp): void {
  // --- API-95: 様式の作成（draft版1を同時に作る） ---
  defineRoute(app, "API-95", async (c) => {
    const p = await resolvePrincipal(c);
    const { body, headers } = await parseApiRequest(c, "API-95");
    requirePermission(p, "PER-03", { unitId: p.unitId, type: "inspection_template" });
    const id = crypto.randomUUID();
    const versionId = crypto.randomUUID();
    const result = await executeMutation(c.env, p, {
      operationCode: "inspection_template.create",
      key: headers["idempotency-key"],
      requestHash: await canonicalRequestHash({ method: "POST", path: "/inspection-templates", body }),
      expectedAuthzVersion: p.authzVersion,
      roots: [],
      created: [
        { table: "inspection_templates", id },
        { table: "inspection_template_versions", id: versionId },
      ],
      duplicateOn: ["inspection_templates.unit_id", "inspection_templates.name"],
      statements: (ctx) => [
        c.env.DB.prepare(
          "INSERT INTO inspection_templates (id, unit_id, name, target_type, status, last_mutation_token, created_at, updated_at, created_by, actor_kind) " +
            "VALUES (?, ?, ?, ?, 'draft', ?, ?, ?, ?, 'human')",
        ).bind(id, p.unitId, body.name, body.targetType, ctx.attempt, ctx.now, ctx.now, p.userId),
        c.env.DB.prepare(
          "INSERT INTO inspection_template_versions (id, unit_id, template_id, revision_no, item_schema, status, last_mutation_token, created_at, updated_at, created_by, actor_kind) " +
            "VALUES (?, ?, ?, 1, ?, 'draft', ?, ?, ?, ?, 'human')",
        ).bind(versionId, p.unitId, id, JSON.stringify(body.itemSchema), ctx.attempt, ctx.now, ctx.now, p.userId),
      ],
      audit: { action: "inspection_template.create", entityType: "inspection_template", entityId: id, metadata: { target: body.targetType } },
      event: { entityType: "inspection_template", entityId: id, entityVersion: 1, eventType: "inspection_template.created", payload: { target: body.targetType } },
      response: { status: 201, sql: TEMPLATE_JSON, binds: [id], decode: (j) => j as Record<string, unknown> },
    });
    return ok(c, result.data, {}, 201);
  });

  // --- API-96: 新しい下書き版（旧版は不変のまま） ---
  defineRoute(app, "API-96", async (c) => {
    const p = await resolvePrincipal(c);
    const { params, body, headers } = await parseApiRequest(c, "API-96");
    requirePermission(p, "PER-03", { unitId: p.unitId, type: "inspection_template", id: params.id });
    const template = await c.env.DB.prepare("SELECT * FROM inspection_templates WHERE id = ?").bind(params.id)
      .first<TemplateRow>().then((r) => (r && r.unit_id === p.unitId ? r : null));
    if (!template) throw new HttpError("NOT_FOUND");
    const nextRevision = await c.env.DB.prepare("SELECT COALESCE(MAX(revision_no), 0) + 1 AS n FROM inspection_template_versions WHERE template_id = ?")
      .bind(template.id).first<{ n: number }>();
    const versionId = crypto.randomUUID();
    const result = await executeMutation(c.env, p, {
      operationCode: "inspection_template.version.create",
      key: headers["idempotency-key"],
      requestHash: await canonicalRequestHash({ method: "POST", path: `/inspection-templates/${params.id}/versions`, baseVersion: body.version, body }),
      expectedAuthzVersion: p.authzVersion,
      roots: [{ table: "inspection_templates", id: template.id, expectedVersion: body.version }],
      created: [{ table: "inspection_template_versions", id: versionId }],
      statements: (ctx) => [
        c.env.DB.prepare(
          "INSERT INTO inspection_template_versions (id, unit_id, template_id, revision_no, item_schema, status, last_mutation_token, created_at, updated_at, created_by, actor_kind) " +
            "VALUES (?, ?, ?, ?, ?, 'draft', ?, ?, ?, ?, 'human')",
        ).bind(versionId, p.unitId, template.id, nextRevision!.n, JSON.stringify(body.itemSchema), ctx.attempt, ctx.now, ctx.now, p.userId),
        c.env.DB.prepare(
          "UPDATE inspection_templates SET version = version + 1, last_mutation_token = ?, updated_at = ? WHERE id = ? AND unit_id = ? AND version = ?",
        ).bind(ctx.attempt, ctx.now, template.id, p.unitId, body.version),
      ],
      audit: { action: "inspection_template.version.create", entityType: "inspection_template", entityId: template.id, metadata: { revisionNo: nextRevision!.n } },
      event: { entityType: "inspection_template", entityId: template.id, entityVersion: body.version + 1, eventType: "inspection_template_version.created", payload: { revisionNo: nextRevision!.n } },
      response: {
        status: 201,
        sql: "SELECT json_object('id', v.id, 'revisionNo', v.revision_no, 'status', v.status, 'itemSchema', json(v.item_schema), 'templateVersion', t.version) " +
          "FROM inspection_template_versions v JOIN inspection_templates t ON t.id = v.template_id WHERE v.id = ?",
        binds: [versionId],
        decode: (j) => j as Record<string, unknown>,
      },
    });
    return ok(c, result.data, {}, 201);
  });

  // --- API-97: 承認の決定（申請/承認/差戻し）。承認の二重決定は版ガードで409 ---
  defineRoute(app, "API-97", async (c) => {
    const p = await resolvePrincipal(c);
    const { params, body, headers } = await parseApiRequest(c, "API-97");
    requirePermission(p, "PER-10", { unitId: p.unitId, type: "inspection_template", id: params.id });
    const template = await c.env.DB.prepare("SELECT * FROM inspection_templates WHERE id = ?").bind(params.id)
      .first<TemplateRow>().then((r) => (r && r.unit_id === p.unitId ? r : null));
    if (!template) throw new HttpError("NOT_FOUND");
    const version = await c.env.DB.prepare("SELECT * FROM inspection_template_versions WHERE id = ? AND template_id = ?")
      .bind(body.templateVersionId, template.id)
      .first<VersionRow>().then((r) => (r && r.unit_id === p.unitId ? r : null));
    if (!version) throw new HttpError("NOT_FOUND");
    // docs/11 の許可辺: draft→in_review、in_review→approved/changes_requested
    const allowedStates = {
      request_review: ["draft"],
      approve: ["in_review"],
      changes_requested: ["in_review"],
    } as const;
    const nextStatus = { request_review: "in_review", approve: "approved", changes_requested: "changes_requested" } as const;
    // docs/05 API-97のversionは様式rootの版。rootを版ガードし、版行は状態遷移の条件で守る
    // （承認済みの版rowはトリガーで不変。二重決定はrootの版ガードで409になる）
    const result = await executeMutation(c.env, p, {
      operationCode: "inspection_template.decision",
      key: headers["idempotency-key"],
      requestHash: await canonicalRequestHash({ method: "POST", path: `/inspection-templates/${params.id}/decision`, baseVersion: body.version, body }),
      expectedAuthzVersion: p.authzVersion,
      roots: [{ table: "inspection_templates", id: template.id, expectedVersion: body.version, allowedStates: { column: "status", values: ["draft", "active"] } }],
      conditions: [
        {
          existsSql: `SELECT 1 FROM inspection_template_versions WHERE id = ? AND unit_id = ? AND status IN (${allowedStates[body.decision].map(() => "?").join(", ")})`,
          binds: [version.id, p.unitId, ...allowedStates[body.decision]],
          failCode: "INVALID_TRANSITION",
        },
      ],
      statements: (ctx) => [
        c.env.DB.prepare(
          "UPDATE inspection_template_versions SET status = ?, " +
            "approved_by_member_id = CASE WHEN ? = 'approve' THEN ? ELSE approved_by_member_id END, " +
            "approved_at = CASE WHEN ? = 'approve' THEN ? ELSE approved_at END, " +
            "version = version + 1, last_mutation_token = ?, updated_at = ? " +
            "WHERE id = ? AND unit_id = ? AND version = ?",
        ).bind(nextStatus[body.decision], body.decision, p.memberId, body.decision, ctx.now, ctx.attempt, ctx.now, version.id, p.unitId, version.version),
        // 承認のときだけ、様式の現在承認版ポインタと状態を更新する
        c.env.DB.prepare(
          "UPDATE inspection_templates SET current_version_id = CASE WHEN ? = 'approve' THEN ? ELSE current_version_id END, " +
            "status = CASE WHEN ? = 'approve' THEN 'active' ELSE status END, " +
            "version = version + 1, last_mutation_token = ?, updated_at = ? WHERE id = ? AND unit_id = ? AND version = ?",
        ).bind(body.decision, version.id, body.decision, ctx.attempt, ctx.now, template.id, p.unitId, template.version),
      ],
      audit: { action: `inspection_template.${body.decision}`, entityType: "inspection_template", entityId: template.id, metadata: { versionId: version.id } },
      event: { entityType: "inspection_template", entityId: template.id, entityVersion: template.version + 1, eventType: `inspection_template_${body.decision}`, payload: { versionId: version.id } },
      response: {
        status: 200,
        sql: "SELECT json_object('id', v.id, 'revisionNo', v.revision_no, 'status', v.status, 'itemSchema', json(v.item_schema), 'approvedAt', v.approved_at, 'templateVersion', t.version) " +
          "FROM inspection_template_versions v JOIN inspection_templates t ON t.id = v.template_id WHERE v.id = ?",
        binds: [version.id],
        decode: (j) => j as Record<string, unknown>,
      },
    });
    return ok(c, result.data);
  });

  // --- API-94: 一覧（対象種別・状態。承認版を含む） ---
  defineRoute(app, "API-94", async (c) => {
    const p = await resolvePrincipal(c);
    const { query } = await parseApiRequest(c, "API-94");
    requirePermission(p, "PER-04", { unitId: p.unitId, type: "inspection_template" });
    const where = ["unit_id = ?"];
    const binds: unknown[] = [p.unitId];
    if (query.targetType) { where.push("target_type = ?"); binds.push(query.targetType); }
    if (query.status) { where.push("status = ?"); binds.push(query.status); }
    const rows = (
      await c.env.DB.prepare(
        `SELECT id FROM inspection_templates WHERE ${where.join(" AND ")} ORDER BY id LIMIT ?`,
      ).bind(...binds, LIMITS.listLimitMax).all<{ id: string }>()
    ).results;
    const rows2 = await c.env.DB.batch(rows.map((r) => c.env.DB.prepare(TEMPLATE_JSON + " ").bind(r.id)));
    const data = rows2.map((res) => {
      const row = res.results[0] as Record<string, unknown> | undefined;
      if (!row) return null;
      // json_objectの結果は文字列で返る。列名がSQL文になる環境でも最初の値を取り出して解析する
      const first = Object.values(row)[0];
      return typeof first === "string" ? (JSON.parse(first) as Record<string, unknown>) : (first as Record<string, unknown>);
    });
    return ok(c, data.filter(Boolean));
  });
}

// 契約の再検査（バージョン入力の形）。ここでは使わないが、将来の緩め方を防ぐための注記
export const _versionInputSchema = z.object({ version: Version, templateVersionId: Id });
