import type { AppEnv } from "../env";
import { bumpDatasetRevision, insertLocationRevision } from "./facility-writes";
import { canonicalRequestHash } from "../mutations/hash";
import { executeMutation } from "../mutations/execute";
import { assertionSql, rootUpdatedExistsSql } from "../mutations/assertion";
import { requirePermission } from "./invitations";
import { resolvePrincipal } from "../auth/principal";
import { HttpError, defineRoute, ok, parseApiRequest, type ApiApp } from "../http";
import { registerJobHandler } from "../jobs/runner";
import { enqueueJobStatement, type JobOutcome, type LeasedJob } from "../jobs/store";
import { queryFacilities } from "../gis/query";
import { csvCell } from "../gis/csv";

/**
 * 施設CSV取込みの確定（T024、docs/05 API-54）。
 * previewHashと台帳版（dataset_revision）を検証してから、チャンクに分けて確定する。
 * 各チャンクは「開始時のdataset_revision」を検査して自分の分だけ版を進め、外側の変更を検出したら残りを止める。
 * チャンクの効果は行の committed_facility_id で固定するので、途中失敗からの再開で重複しない。
 */
export async function commitImport(job: LeasedJob, env: AppEnv): Promise<JobOutcome> {
  const batch = await env.DB.prepare("SELECT * FROM import_batches WHERE id = ?").bind(job.sourceId)
    .first<{ id: string; unit_id: string; status: string; version: number; conflict_resolution: string | null; base_dataset_revision: number | null }>();
  if (!batch || batch.unit_id !== job.unitId) return { kind: "stale", errorCode: "batch_missing" };
  if (batch.status === "committed") return { kind: "stale", errorCode: "already_committed" };
  if (batch.status !== "committing") return { kind: "stale", errorCode: "unexpected_status" };
  const baseRevision = batch.base_dataset_revision;
  if (baseRevision === null) return { kind: "manual_review", errorCode: "missing_base_revision" };

  const CHUNK = 20;
  let committed = 0;
  let chunkNo = 0;
  for (;;) {
    // 未確定の有効行を取り、版を1つ進める（1チャンク=1batch。外側の更新を検出したら止める）
    const pending = await env.DB.prepare(
      "SELECT id, row_no, normalized_json FROM import_rows WHERE batch_id = ? AND unit_id = ? AND error IS NULL AND committed_facility_id IS NULL ORDER BY row_no LIMIT ?",
    ).bind(batch.id, batch.unit_id, CHUNK).all<{ id: string; row_no: number; normalized_json: string }>();
    if (pending.results.length === 0) break;
    chunkNo++;
    // 期待する台帳版=commit開始時の基準版＋このbatchが既に確定したチャンク数（1チャンクで1増分。
    // チャンクはCHUNK行ずつrow_no順なので、確定済み行数からチャンク数を復元できる。再試行でも+selfの進捗を壊さない）。
    // 外側が台帳を触っていたらこの検査で失敗し、batch全体が取り消されてjobは再試行（最終的に手動確認）になる
    const committedSoFar = (await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM import_rows WHERE batch_id = ? AND unit_id = ? AND committed_facility_id IS NOT NULL",
    ).bind(batch.id, batch.unit_id).first<{ n: number }>())!.n;
    const expectedRevision = baseRevision + Math.ceil(committedSoFar / CHUNK);
    const attemptToken = `${job.id}:${chunkNo}`;
    let seq = 0;
    const assertion = (existsSql: string, ...binds: unknown[]) =>
      env.DB.prepare(assertionSql(existsSql)).bind(attemptToken, ++seq, ...binds);
    const stmts: D1PreparedStatement[] = [
      assertion("SELECT 1 FROM units WHERE id = ? AND dataset_revision = ?", batch.unit_id, expectedRevision),
    ];
    const updatedIds: string[] = [];
    for (const row of pending.results) {
      const n = JSON.parse(row.normalized_json) as {
        type: string; managementNumber: string | null; identifyingName: string | null;
        latitude: number; longitude: number; locationSource: string; locationNote: string;
      };
      if (batch.conflict_resolution === "overwrite") {
        const existing = await env.DB.prepare(
          "SELECT id, version, latitude, longitude, location_source, location_version FROM facilities WHERE unit_id = ? AND type = ? AND management_number = ?",
        ).bind(batch.unit_id, n.type, n.managementNumber)
          .first<{ id: string; version: number; latitude: number; longitude: number; location_source: string; location_version: number }>();
        if (existing) {
          // 座標または出典が変わるなら、位置確認は必ず失効する（docs/11「座標変更は必ず新locationVersion、旧確認を失効」）
          const locationChanged = existing.latitude !== n.latitude || existing.longitude !== n.longitude || existing.location_source !== n.locationSource;
          const newLocationVersion = existing.location_version + (locationChanged ? 1 : 0);
          const nowIso = new Date().toISOString();
          stmts.push(
            env.DB.prepare(
              "UPDATE facilities SET latitude = ?, longitude = ?, location_source = ?, location_note = ?, " +
                (locationChanged
                  ? "location_version = location_version + 1, verification_status = 'unverified', last_verified_at = NULL, verified_by_member_id = NULL, "
                  : "") +
                "version = version + 1, last_mutation_token = ?, updated_at = ? " +
                "WHERE id = ? AND unit_id = ? AND version = ?",
            ).bind(n.latitude, n.longitude, n.locationSource, n.locationNote, `import:${batch.id}`, nowIso, existing.id, batch.unit_id, existing.version),
            // 更新が本当に1行に効いたこと（0行更新を成功扱いにしない。docs/02 §4と同じ比較更新の検査。
            // 位置の変更の有無に依らず常に検査する。docs/11の位置履歴だけが位置変更の有無で分かれる）
            assertion(rootUpdatedExistsSql("facilities"), existing.id, batch.unit_id, existing.version + 1, `import:${batch.id}`),
            ...(locationChanged
              ? [insertLocationRevision(env, {
                    id: crypto.randomUUID(), unitId: batch.unit_id, facilityId: existing.id, locationVersion: newLocationVersion,
                    latitude: n.latitude, longitude: n.longitude, locationSource: n.locationSource,
                    verificationStatus: "unverified", verifiedByMemberId: null, verifiedAt: null,
                    reason: "CSV取込みで更新", actorUserId: null, now: nowIso,
                  })]
              : []),
          );
          updatedIds.push(`${row.id}:${existing.id}`);
          continue;
        }
      }
      const facilityId = crypto.randomUUID();
      const now = new Date().toISOString();
      stmts.push(
        env.DB.prepare(
          "INSERT INTO facilities (id, unit_id, type, management_number, identifying_name, latitude, longitude, location_note, location_source, location_version, verification_status, created_at, updated_at, created_by, actor_kind) " +
            "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 'unverified', ?, ?, NULL, 'system')",
        ).bind(facilityId, batch.unit_id, n.type, n.managementNumber, n.identifyingName, n.latitude, n.longitude, n.locationNote, n.locationSource, now, now),
        insertLocationRevision(env, {
          id: crypto.randomUUID(), unitId: batch.unit_id, facilityId, locationVersion: 1,
          latitude: n.latitude, longitude: n.longitude, locationSource: n.locationSource,
          verificationStatus: "unverified", verifiedByMemberId: null, verifiedAt: null,
          reason: "CSV取込みで登録", actorUserId: null, now,
        }),
      );
      updatedIds.push(`${row.id}:${facilityId}`);
    }
    stmts.push(bumpDatasetRevision(env, batch.unit_id));
    for (const pair of updatedIds) {
      const [rowId, facilityId] = pair.split(":");
      stmts.push(env.DB.prepare("UPDATE import_rows SET committed_facility_id = ? WHERE id = ? AND committed_facility_id IS NULL").bind(facilityId, rowId));
    }
    // 検査行の掃除（成功したチャンクにだけ実行される。失敗したbatchは全体が取り消されるため残らない）
    stmts.push(env.DB.prepare("DELETE FROM mutation_assertions WHERE attempt_token = ?").bind(attemptToken));
    try {
      await env.DB.batch(stmts);
    } catch {
      // 外側の変更（revisionの不一致）か、番号の重複。次の実行で現在の台帳と突き合わせ直す
      return { kind: "retryable", errorCode: "chunk_conflict" };
    }
    committed += pending.results.length;
  }

  // 監査（成功時のみ）とbatchの完了
  const done = await env.DB.batch([
    env.DB.prepare(
      "UPDATE import_batches SET status = 'committed', committed_rows = (SELECT COUNT(*) FROM import_rows WHERE batch_id = ? AND committed_facility_id IS NOT NULL), commit_version = COALESCE(commit_version, 1), version = version + 1, updated_at = ? " +
        "WHERE id = ? AND unit_id = ? AND status = 'committing'",
    ).bind(batch.id, new Date().toISOString(), batch.id, batch.unit_id),
    env.DB.prepare(
      "INSERT INTO audit_logs (id, unit_id, actor_kind, actor_user_id, action, entity_type, entity_id, mutation_id, occurred_at, metadata_json) VALUES (?, ?, 'system', NULL, 'facility.import.commit', 'import_batch', ?, ?, ?, json_object('committed', json(?)))",
    ).bind(crypto.randomUUID(), batch.unit_id, batch.id, crypto.randomUUID(), new Date().toISOString(), JSON.stringify(String(committed))),
  ]);
  if ((done[0]?.meta.changes ?? 0) !== 1) return { kind: "stale", errorCode: "source_changed" };
  return { kind: "succeeded", resultRef: `committed:${committed}` };
}

registerJobHandler("import.commit", commitImport);

export function registerImportCommitRoutes(app: ApiApp): void {
  defineRoute(app, "API-54", async (c) => {
    const p = await resolvePrincipal(c);
    const { params, body, headers } = await parseApiRequest(c, "API-54");
    requirePermission(p, "PER-03", { unitId: p.unitId, type: "facility" });
    const batch = await c.env.DB.prepare("SELECT * FROM import_batches WHERE id = ?").bind(params.id)
      .first<{ id: string; unit_id: string; status: string; version: number; preview_hash: string | null; base_dataset_revision: number | null }>();
    if (!batch || batch.unit_id !== p.unitId) throw new HttpError("NOT_FOUND");
    if (batch.preview_hash !== body.previewHash) {
      throw new HttpError("VALIDATION_ERROR", undefined, [{ field: "previewHash", reason: "preview_hash_mismatch" }]);
    }
    // 台帳がプレビュー時と変わっていれば確定しない（docs/03の「同時変更時再プレビュー」）
    const unit = await c.env.DB.prepare("SELECT dataset_revision FROM units WHERE id = ?").bind(p.unitId).first<{ dataset_revision: number }>();
    if (unit!.dataset_revision !== batch.base_dataset_revision) {
      throw new HttpError("VERSION_CONFLICT", undefined, [{ field: "previewHash", reason: "master_changed_after_preview" }]);
    }
    if (body.conflictResolution !== "skip" && body.conflictResolution !== "overwrite") {
      throw new HttpError("VALIDATION_ERROR", undefined, [{ field: "conflictResolution", reason: "unsupported_resolution" }]);
    }
    const commitJob = enqueueJobStatement(c.env, {
      unitId: p.unitId,
      kind: "import.commit",
      sourceType: "import_batch",
      sourceId: batch.id,
      sourceVersion: batch.version + 1,
      configVersion: "v1",
      requestedBy: p.userId,
      dedupeKey: `${p.unitId}|import.commit|import_batch|${batch.id}|${batch.version + 1}|v1`,
    });
    const result = await executeMutation(c.env, p, {
      operationCode: "facility.import.commit",
      key: headers["idempotency-key"],
      requestHash: await canonicalRequestHash({ method: "POST", path: `/facilities/imports/${params.id}/commit`, baseVersion: body.version, body }),
      expectedAuthzVersion: p.authzVersion,
      roots: [{ table: "import_batches", id: batch.id, expectedVersion: body.version, allowedStates: { column: "status", values: ["ready"] } }],
      statements: (ctx) => [
        c.env.DB.prepare(
          "UPDATE import_batches SET status = 'committing', conflict_resolution = ?, version = version + 1, last_mutation_token = ?, updated_at = ? WHERE id = ? AND unit_id = ? AND version = ? AND status = 'ready'",
        ).bind(body.conflictResolution, ctx.attempt, ctx.now, batch.id, p.unitId, body.version),
        commitJob.statement,
      ],
      audit: { action: "facility.import.commit", entityType: "import_batch", entityId: batch.id, metadata: { resolution: body.conflictResolution } },
      event: { entityType: "import_batch", entityId: batch.id, entityVersion: body.version + 1, eventType: "import_batch.commit_requested", payload: { resolution: body.conflictResolution } },
      response: {
        status: 202,
        sql: "SELECT json_object('id', b.id, 'status', b.status, 'jobId', (SELECT j.id FROM jobs j WHERE j.source_type = 'import_batch' AND j.source_id = b.id AND j.kind = 'import.commit' ORDER BY j.created_at DESC LIMIT 1)) FROM import_batches b WHERE b.id = ?",
        binds: [batch.id],
        decode: (j) => j as { id: string; status: string; jobId: string | null },
      },
    });
    try {
      await c.env.JOBS_QUEUE.send({ jobId: commitJob.id });
    } catch (err) {
      console.error(JSON.stringify({ event: "job_queue_send_failed", jobId: commitJob.id, error: String(err) }));
    }
    return ok(c, result.data, {}, 202);
  });
}

/** API-55: 台帳の書き出し（CSV。式注入をescapeし、出力時にsnapshotを固定する） */
export function registerFacilityExportRoutes(app: ApiApp): void {
  defineRoute(app, "API-55", async (c) => {
    const p = await resolvePrincipal(c);
    const { query } = await parseApiRequest(c, "API-55");
    requirePermission(p, "PER-03", { unitId: p.unitId, type: "facility" });
    // 出力はこの瞬間の台帳snapshot。cursorをたどって全件を取得する
    const lines: string[] = ["type,management_number,identifying_name,latitude,longitude,location_source,location_note,location_version,verification_status,last_verified_at"];
    let cursor: string | undefined;
    let snapshotRevision = 0;
    for (;;) {
      const page = await queryFacilities(c.env, p.unitId, c.env.BETTER_AUTH_SECRET, { ...query, cursor, limit: 200 });
      snapshotRevision = page.snapshotRevision;
      for (const item of page.items as Record<string, unknown>[]) {
        lines.push([
          csvCell(String(item.type)),
          csvCell(item.managementNumber === null ? "" : String(item.managementNumber)),
          csvCell(item.identifyingName === null ? "" : String(item.identifyingName)),
          csvCell(String(item.latitude)),
          csvCell(String(item.longitude)),
          csvCell(String(item.locationSource)),
          csvCell(String(item.locationNote)),
          csvCell(String(item.locationVersion)),
          csvCell(String(item.verificationStatus)),
          csvCell(item.lastVerifiedAt === null ? "" : String(item.lastVerifiedAt)),
        ].join(","));
      }
      cursor = page.nextCursor;
      if (!cursor) break;
    }
    const csv = `\uFEFF${lines.join("\r\n")}\r\n`;
    const exportVersion = `${snapshotRevision}-${(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(csv))).byteLength}`;
    return new Response(csv, {
      headers: {
        "content-type": "text/csv; charset=utf-8",
        "content-disposition": `attachment; filename="facilities-${snapshotRevision}.csv"`,
        "cache-control": "private, no-store",
        "x-export-version": exportVersion,
      },
    });
  });
}
