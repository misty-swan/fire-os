import { ResourceUsageList, ResourceUsageRow, type ResourceUsageListDto } from "../../shared/contracts/operations";
import { resolvePrincipal, type AuthzPrincipal } from "../auth/principal";
import { HttpError, defineRoute, ok, parseApiRequest, type ApiApp, type ApiContext } from "../http";
import { canonicalRequestHash } from "../mutations/hash";
import { executeMutation, type ExtraCondition, type MutationSpec, type RootGuard } from "../mutations/execute";
import { requirePermission } from "./invitations";

/**
 * 車両/機材の使用履歴と訂正（T042、docs/04:100、docs/05 API-57/22、docs/11 §3、docs/14 D15、docs/10 PER-04）。
 * - **全有効集合PUT（置換）**: リクエストのusages集合でoperationの有効(active)集合を置換する
 *   （docs/05 §1「ResourceUsageListのPUTはoperation版をガードし全有効集合を更新」）。
 *   id付きは既存行の更新、id無しは新規行、**来なかった既存行はstatus='cancelled'**で残す
 *   （物理削除は絶対にしない。docs/04:100「物理削除しない」）。cancelledは終端（再アクティブ化はしない）。
 * - **operation版ガード**: リクエストversionが出来事root（operations。activities/incidentsが共用）の
 *   現行版と不一致なら409。同version並行更新はrootの比較更新で一方だけ成功し、負け側は
 *   行・履歴・監査・outboxのすべてが残らない（1つのbatchで取消。docs/05 §2）。成功時はoperation版を増分する
 *   （docs/04:100「operation版も増分」）。出動/活動の作成（API-22）ではrootを同じbatchで作るため
 *   ガードも増分もしない。
 * - **全行編集権**: docs/05 API-57「有効全件/同unit/全対象編集権」。既存行の記録者と関係なく、
 *   この操作のPER-04（＋D08/D15の担当範囲）を検査し、足りなければ403で全体を拒否する（部分更新しない）。
 * - **検査**: 対象ちょうど一つ（Target契約のvehicle/equipmentを片側FKへ）、quantity>0、
 *   時間順序（used_from/used_to両方存在時。片方未知は保留）、対象の同unit・存在
 *   （存在しない/廃止資産は同じ404。docs/05 §1「存在を明かさない」）。
 * - **在庫の自動減算はしない**（docs/04:100・D15。台帳のequipment.quantityは使用で動かさない）。
 * - 変更の前後はresource_usage_eventsへ追記し（docs/04:100「変更前後を追記、operation更新と同commit」）、
 *   監査/outboxまで1つのbatchで確定する（docs/02 §4）。一mutation一event（使用履歴の別eventは出さない）。
 * - 集計はactive行だけを数える（docs/11 §3「集計は無効なoperationを除く」の使用履歴版）。
 */

/** resource_usagesの行（読み出し用。usage DTOへの変換とeventsの前後JSONで共用） */
export interface ResourceUsageRowShape {
  id: string; unit_id?: string; operation_id: string;
  vehicle_id: string | null; equipment_id: string | null;
  quantity: number; used_from: string | null; used_to: string | null;
  recorded_by_member_id: string; status: string; version: number;
}

/**
 * buildResourceUsageMutationの入力。API-57（既存operationの全集合PUT）とAPI-22（出動の作成と同時の
 * 使用履歴作成）で共用する。作成経路ではoperationを行と同じbatchで作るため、operationVersionに0を
 * 入れoperationCreatedInBatchをtrueにする（版ガードも増分もしない）。
 */
export interface ResourceUsageInput {
  principal: AuthzPrincipal;
  operationId: string;
  /** 現行のoperation版（docs/05 §1「operation版をガード」）。作成経路（API-22）では0 */
  operationVersion: number;
  /** operationをこのbatchで新規作成するときtrue（API-22。版ガード・増分・存在読みをしない） */
  operationCreatedInBatch?: boolean;
  /** 有効集合の全置換内容（docs/05 API-57「usages[{id?,Target,quantity,from?,to?}]」） */
  usages: { id?: string; target: { type: "facility" | "vehicle" | "equipment"; id: string }; quantity: number; from?: string; to?: string }[];
  /** 訂正・取消の理由（resource_usage_events.reason。作成経路では理由が無いためnull） */
  reason: string | null;
  idempotencyKey: string;
  /** requestHashの対象パス（docs/05 §2「正規化した本文（method/path、対象、baseVersion含む）」） */
  requestPath: string;
  /** requestHashの対象本文。API-57は解析済みのbody全体、作成経路はusage部分 */
  requestBody: unknown;
}

const ASSET_SQL = {
  vehicle: "SELECT unit_id FROM vehicles WHERE id = ? AND unit_id = ? AND archived_at IS NULL AND status != '廃止'",
  equipment: "SELECT unit_id FROM equipment WHERE id = ? AND unit_id = ? AND archived_at IS NULL AND status != '廃止'",
} as const;

/**
 * API-57の応答（ResourceUsageList＋operationVersion）をSQLで組み立てる（batch内の応答確定用。
 * docs/05 §1「Detailは親＋認可された子PageとnextCursor」）。cancelled行も残るため全行を返す
 * （docs/04:100「物理削除しない」。登録順＝rowid）。
 */
const USAGE_LIST_JSON =
  "SELECT json_object(" +
  "'usages', COALESCE((SELECT json_group_array(json_object(" +
  "'id', u.id, 'version', u.version, 'operationId', u.operation_id, " +
  "'target', json_object('type', CASE WHEN u.vehicle_id IS NOT NULL THEN 'vehicle' ELSE 'equipment' END, 'id', COALESCE(u.vehicle_id, u.equipment_id)), " +
  "'quantity', u.quantity, 'usedFrom', u.used_from, 'usedTo', u.used_to, " +
  "'recordedByMemberId', u.recorded_by_member_id, 'status', u.status)) " +
  "FROM (SELECT * FROM resource_usages WHERE unit_id = ? AND operation_id = ? ORDER BY rowid) u), json_array()), " +
  "'operationVersion', (SELECT version FROM operations WHERE id = ? AND unit_id = ?))";

/** resource_usagesの行をDTOへ（API-57/70の応答とAPI-51の子Pageで共用） */
export function toResourceUsageDto(r: ResourceUsageRowShape) {
  return ResourceUsageRow.parse({
    id: r.id, version: r.version, operationId: r.operation_id,
    target: { type: r.vehicle_id !== null ? "vehicle" : "equipment", id: r.vehicle_id ?? r.equipment_id },
    quantity: r.quantity, usedFrom: r.used_from, usedTo: r.used_to,
    recordedByMemberId: r.recorded_by_member_id, status: r.status,
  });
}

/** eventsの前後JSONに入れる行の業務形（対象・数量・時間・状態。docs/04:100「変更前後を追記」） */
const rowState = (r: { vehicle_id: string | null; equipment_id: string | null; quantity: number; used_from: string | null; used_to: string | null; status: string }) => ({
  target: { type: r.vehicle_id !== null ? "vehicle" : "equipment", id: r.vehicle_id ?? r.equipment_id },
  quantity: r.quantity, usedFrom: r.used_from, usedTo: r.used_to, status: r.status,
});

/**
 * 使用履歴の全有効集合PUTを1つのMutationSpecへ組み立てる（T042。API-57とAPI-22で共用）。
 * 検査はここで済ませ、batch内ではconditions（資産の再検査）と比較更新（operation版ガード）で
 * 並行変更を検出する。呼び出し側は返したspecをexecuteMutationへ渡す（API-57）、または
 * statements/created/conditionsを作成系のspecへ取り込む（API-22。同一batch・一mutation一event）。
 */
export async function buildResourceUsageMutation(
  c: ApiContext,
  input: ResourceUsageInput,
): Promise<MutationSpec<ResourceUsageListDto>> {
  const p = input.principal;
  const createdInBatch = input.operationCreatedInBatch === true;

  // 0) 同じ鍵の再送（docs/05 §2「同じキー/本文の再送は元HTTP status/dataを返し」）。
  // 鍵が既にある（=再送の）ときは現在の状態では不可になる変更（旧版・廃止済み資産・取消済み行）でも
  // 保存済み応答を返す必要があるため、状態前提の読み取りと検査を飛ばしてexecuteMutationへ渡す
  // （T041のincident-participantsと同じ流儀。spec組み立てに必要な最小の値だけ使う）
  const knownKey = await c.env.DB.prepare(
    "SELECT 1 FROM idempotency_records WHERE actor_user_id = ? AND operation_code = ? AND idempotency_key = ?",
  ).bind(p.userId, "operation.resource_usage.replace", input.idempotencyKey).first();

  // 1) 出来事rootの存在と現行版（docs/05 §1「operation版をガード」。作成経路では同じbatchで作るため読まない）。
  // ここでの確認は早期の400/404のためで、並行の確定判定はbatch内の比較更新（roots）が行う
  if (!knownKey && !createdInBatch) {
    const op = await c.env.DB.prepare("SELECT unit_id, version FROM operations WHERE id = ?").bind(input.operationId)
      .first<{ unit_id: string; version: number }>();
    if (!op || op.unit_id !== p.unitId) throw new HttpError("NOT_FOUND");
    if (op.version !== input.operationVersion) {
      throw new HttpError("VERSION_CONFLICT", undefined, [{ field: "version", reason: "operation_version_mismatch" }]);
    }
    // 取消済み(voided)の出動に紐づく出来事は読み取り専用（T091-S5。リンク後はincidents.operation_idが活動のoperationを指す）
    const voided = await c.env.DB.prepare(
      "SELECT 1 FROM incidents WHERE unit_id = ? AND operation_id = ? AND status = 'voided'",
    ).bind(p.unitId, input.operationId).first();
    if (voided) {
      throw new HttpError("INVALID_TRANSITION", undefined, [{ field: "status", reason: "voided_is_terminal" }]);
    }
  }

  // 2) 入力の検査（docs/04:100。対象ちょうど一つ/quantity>0/時間順序/重複id。違反は通ってから500にしない）。
  // 本文だけから決まる検査なので再送でも同じ結果になり、鍵の有無にかかわらず行う
  const seenIds = new Set<string>();
  for (const [index, u] of input.usages.entries()) {
    const label = `usages.${index}`;
    if (u.target.type !== "vehicle" && u.target.type !== "equipment") {
      throw new HttpError("VALIDATION_ERROR", undefined, [{ field: `${label}.target.type`, reason: "vehicle_or_equipment_required" }]);
    }
    if (!(u.quantity > 0)) {
      throw new HttpError("VALIDATION_ERROR", undefined, [{ field: `${label}.quantity`, reason: "positive_required" }]);
    }
    if (u.from && u.to && u.to < u.from) {
      throw new HttpError("VALIDATION_ERROR", undefined, [{ field: `${label}.to`, reason: "before_from" }]);
    }
    if (u.id) {
      if (seenIds.has(u.id)) {
        throw new HttpError("VALIDATION_ERROR", undefined, [{ field: `${label}.id`, reason: "duplicate_id" }]);
      }
      seenIds.add(u.id);
    }
  }

  // 3) 対象資産の存在・同unit・未廃止（docs/04:100「同unit」。存在しない/廃止は同じ404。存在を明かさない）。
  // batch内でも同じ条件を検査し、読み取り後の廃止・削除は500のFK違反でなく404になるようにする。
  // 再送（鍵あり）では状態前提の読み取りをしない（その間の廃止で再送が404になるのを避ける。docs/05 §2）
  const conditions: ExtraCondition[] = [];
  if (!knownKey) {
    // 読み取り後に取り消された出動への書き込みも落とす（T091-S5）
    conditions.push({
      existsSql:
        "SELECT 1 FROM units u WHERE u.id = ? AND NOT EXISTS " +
        "(SELECT 1 FROM incidents i WHERE i.unit_id = u.id AND i.operation_id = ? AND i.status = 'voided')",
      binds: [p.unitId, input.operationId],
      failCode: "INVALID_TRANSITION",
    });
  }
  const targets = new Map<string, { type: "vehicle" | "equipment"; id: string }>();
  if (!knownKey) {
    for (const u of input.usages) {
      // 上の検査でvehicle/equipment以外は400済み（対象ちょうど一つ）。ここでは存在検査の対象へだけ集める
      if (u.target.type === "facility") continue;
      const t: { type: "vehicle" | "equipment"; id: string } =
        u.target.type === "vehicle" ? { type: "vehicle", id: u.target.id } : { type: "equipment", id: u.target.id };
      targets.set(`${t.type}:${t.id}`, t);
    }
    for (const t of targets.values()) {
      const sql = t.type === "vehicle" ? ASSET_SQL.vehicle : ASSET_SQL.equipment;
      const row = await c.env.DB.prepare(sql).bind(t.id, p.unitId).first();
      if (!row) throw new HttpError("NOT_FOUND");
      conditions.push({ existsSql: sql, binds: [t.id, p.unitId], failCode: "NOT_FOUND" });
    }
  }

  // 4) 既存行の読み出し（全行。有効(active)集合が置換対象。cancelledは履歴として残る）。
  // 再送では読み直さない（その間の取消で再送が422になるのを避ける。docs/05 §2）
  const existing = knownKey
    ? []
    : (
      await c.env.DB.prepare(
        "SELECT id, unit_id, operation_id, vehicle_id, equipment_id, quantity, used_from, used_to, recorded_by_member_id, status, version " +
          "FROM resource_usages WHERE unit_id = ? AND operation_id = ? ORDER BY rowid",
      ).bind(p.unitId, input.operationId).all<ResourceUsageRowShape>()
    ).results;
  const byId = new Map(existing.map((r) => [r.id, r]));
  // 再送では行の存在・状態の前提も検査しない（docs/05 §2。取消済み行を含む本文の再送は保存済み応答を返す）
  if (!knownKey) {
    for (const u of input.usages) {
      if (!u.id) continue;
      const row = byId.get(u.id);
      // 他のoperation/存在しない行のidは404（docs/05 §1「存在を明かさない」。operation外の行は触れない）
      if (!row) throw new HttpError("NOT_FOUND", undefined, [{ field: "usages", reason: "unknown_usage_id" }]);
      // cancelledは終端（docs/04:100「active/cancelled」。取消行の再編集・復活はさせない）
      if (row.status !== "active") {
        throw new HttpError("INVALID_TRANSITION", undefined, [{ field: "usages", reason: "cancelled_is_terminal" }]);
      }
    }
  }

  // 5) 置換の計画（更新/新規/取消。物理削除はしない）
  interface Plan {
    id: string;
    row: ResourceUsageRowShape | null; // null=新規
    next: { vehicle_id: string | null; equipment_id: string | null; quantity: number; used_from: string | null; used_to: string | null; status: "active" | "cancelled" };
  }
  const plans: Plan[] = input.usages.map((u) => ({
    id: u.id ?? crypto.randomUUID(),
    row: u.id ? byId.get(u.id)! : null,
    next: {
      vehicle_id: u.target.type === "vehicle" ? u.target.id : null,
      equipment_id: u.target.type === "equipment" ? u.target.id : null,
      quantity: u.quantity, used_from: u.from ?? null, used_to: u.to ?? null, status: "active",
    },
  }));
  // 来なかった既存行はcancelled（docs/05 §1「抜けた既存行はcancelled」。対象・数量・時間は据え置き）
  for (const r of existing) {
    if (r.status === "active" && !seenIds.has(r.id)) {
      plans.push({ id: r.id, row: r, next: { vehicle_id: r.vehicle_id, equipment_id: r.equipment_id, quantity: r.quantity, used_from: r.used_from, used_to: r.used_to, status: "cancelled" } });
    }
  }
  const createdCount = plans.filter((pl) => !pl.row).length;
  const updatedCount = plans.filter((pl) => pl.row && pl.next.status === "active").length;
  const cancelledCount = plans.filter((pl) => pl.row && pl.next.status === "cancelled").length;

  const roots: RootGuard[] = createdInBatch
    ? [] // API-22: operations行をこのbatchで作る（executeMutationのcreated検査が存在を確かめる）
    : [{ table: "operations", id: input.operationId, expectedVersion: input.operationVersion }];

  const spec: MutationSpec<ResourceUsageListDto> = {
    operationCode: "operation.resource_usage.replace",
    key: input.idempotencyKey,
    requestHash: await canonicalRequestHash({
      method: createdInBatch ? "POST" : "PUT", path: input.requestPath,
      baseVersion: input.operationVersion, body: input.requestBody,
    }),
    expectedAuthzVersion: p.authzVersion,
    roots,
    // 新規行はINSERT後に「今回の試行の印付きで存在する」ことをexecuteMutationが検査する
    created: plans.filter((pl) => !pl.row).map((pl) => ({ table: "resource_usages", id: pl.id })),
    conditions,
    statements: (ctx) => {
      const stmts: D1PreparedStatement[] = [];
      for (const plan of plans) {
        const afterJson = JSON.stringify(rowState(plan.next));
        if (plan.row) {
          // 既存行の更新/取消（行の版はoperation版が正なので、比較更新の対象はoperations。docs/05 §1）
          stmts.push(
            c.env.DB.prepare(
              "UPDATE resource_usages SET vehicle_id = ?, equipment_id = ?, quantity = ?, used_from = ?, used_to = ?, status = ?, " +
                "version = version + 1, last_mutation_token = ?, updated_at = ? WHERE id = ? AND unit_id = ?",
            ).bind(
              plan.next.vehicle_id, plan.next.equipment_id, plan.next.quantity, plan.next.used_from, plan.next.used_to,
              plan.next.status, ctx.attempt, ctx.now, plan.id, p.unitId,
            ),
          );
        } else {
          stmts.push(
            c.env.DB.prepare(
              "INSERT INTO resource_usages (id, unit_id, operation_id, vehicle_id, equipment_id, quantity, used_from, used_to, " +
                "recorded_by_member_id, status, last_mutation_token, created_at, updated_at, created_by, actor_kind) " +
                "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?, ?, 'human')",
            ).bind(
              plan.id, p.unitId, input.operationId, plan.next.vehicle_id, plan.next.equipment_id, plan.next.quantity,
              plan.next.used_from, plan.next.used_to, p.memberId, ctx.attempt, ctx.now, ctx.now, p.userId,
            ),
          );
        }
        // 履歴（docs/04:100「変更前後を追記、operation更新と同commit」。incident_eventsと同じ流儀）
        stmts.push(
          c.env.DB.prepare(
            "INSERT INTO resource_usage_events (id, unit_id, usage_id, action, before_json, after_json, reason, actor_user_id, actor_kind, created_at) " +
              "VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'human', ?)",
          ).bind(
            crypto.randomUUID(), p.unitId, plan.id,
            plan.row ? (plan.next.status === "cancelled" ? "cancel" : "update") : "create",
            plan.row ? JSON.stringify(rowState(plan.row)) : "{}", afterJson,
            input.reason, p.userId, ctx.now,
          ),
        );
      }
      if (!createdInBatch) {
        // operation版を増分（docs/04:100「operation版も増分」。並行の同じ版はここで0行更新になり409）
        stmts.push(
          c.env.DB.prepare(
            "UPDATE operations SET version = version + 1, last_mutation_token = ?, updated_at = ? WHERE id = ? AND unit_id = ? AND version = ?",
          ).bind(ctx.attempt, ctx.now, input.operationId, p.unitId, input.operationVersion),
        );
      }
      return stmts;
    },
    audit: {
      action: "operation.resource_usage.replace", entityType: "operation", entityId: input.operationId,
      metadata: { created: createdCount, updated: updatedCount, cancelled: cancelledCount },
    },
    event: {
      entityType: "operation", entityId: input.operationId,
      entityVersion: createdInBatch ? 1 : input.operationVersion + 1,
      eventType: "operation.resource_usage.replaced",
      payload: { created: createdCount, updated: updatedCount, cancelled: cancelledCount },
    },
    // 応答はbatch内のSQLが組み立てる（増分後のoperation版と全行を含む）
    response: {
      status: 200, sql: USAGE_LIST_JSON,
      binds: [p.unitId, input.operationId, input.operationId, p.unitId],
      decode: (j) => ResourceUsageList.parse(j),
    },
  };
  return spec;
}

/**
 * API-57: 使用履歴の全有効集合PUT（docs/05 API-57「有効全件/同unit/全対象編集権」。T042）。
 * 活動・出動どちらの出来事root（operations）でも同じAPIで訂正できる（docs/04「operationを共有する」）
 */
export function registerResourceUsageRoutes(app: ApiApp): void {
  defineRoute(app, "API-57", async (c) => {
    const p = await resolvePrincipal(c);
    const { params, body, headers } = await parseApiRequest(c, "API-57");
    // 全行編集権（docs/05 API-57「全対象編集権」。既存行の記録者と関係なくこの操作のPER-04を検査し、
    // 足りなければ403で全体を拒否する。一般団員は本人分のみ（docs/10 PER-04）なので全集合PUTは不可）
    requirePermission(p, "PER-04", { unitId: p.unitId, type: "operation", id: params.id });
    const spec = await buildResourceUsageMutation(c, {
      principal: p, operationId: params.id, operationVersion: body.version,
      usages: body.usages, reason: body.reason,
      idempotencyKey: headers["idempotency-key"],
      requestPath: `/operations/${params.id}/resource-usages`, requestBody: body,
    });
    const result = await executeMutation(c.env, p, spec);
    return ok(c, result.data);
  });
}
