import type { AppEnv } from "../../env";

/**
 * 点検期限の判定と超過検出（T048、docs/04:119、docs/05 API-56/18/19/28、docs/14 D06）。
 * - **期限は業務日（暦日）**: docs/04 §1「日付期限は業務日TEXT YYYY-MM-DDと明示し瞬間値と混同しない」。
 *   超過は「タイムゾーンの暦日で next_due_date < 今日」。期限当日23:59は未超過、翌日00:00で超過
 *   （docs/11/05期限・D06）。Intl.DateTimeFormatでタイムゾーンの暦日を計算するため夏時間の有無に依らない。
 * - **検出はCronから直接呼ぶ**（src/server/jobs/dispatch.ts の handleScheduled。毎分）。
 *   永続job（jobs表）を経由しない: 検出はSELECT（通常0行）＋重複排除INSERTで安価・冪等であり、
 *   AIは呼ばない（aiCalls=0）。attachment-cleanup.ts の sweepAttachments と同じ「Cron直呼びの段」。
 * - **検出の効果は記録まで**: 検出結果を inspection_due_detections
 *   （UNIQUE(unit_id,対象,予定版,期限日)）へ INSERT ... ON CONFLICT DO NOTHING で追記するだけ。
 *   通知（notifications）はT050で作られ、この表を通知draftの源にする。同じCronの再実行で
 *   検出候補を重複作成しない。scheduleの版が進んでいれば（周期変更など）新しい鍵として再度記録する。
 * - **停止資産は対象外**: docs/14 D24の確定どおり、廃止済み判定は archived_at IS NOT NULL OR
 *   status='廃止' の両建て（archived_atがサーバー側の正、status='廃止'はUI/API値）。
 */

/** 業務日のタイムゾーン（D06でAsia/Tokyoに固定。API-56の入力もこの値だけを受け付ける） */
export const BUSINESS_TIMEZONE = "Asia/Tokyo";

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * nowのタイムゾーンにおける暦日（YYYY-MM-DD）。
 * Intl.DateTimeFormatで「その瞬間がどの暦日か」を計算する（タイムゾーンのDBを持たず、Workersで使える）。
 * en-CAはYYYY-MM-DD形式で固定される。未知のタイムゾーンはRangeErrorになる（保存値はAPI-56の契約で
 * Asia/Tokyoに制約されるため、保存値からは起きない。開発者の誤用は例外で検出する）。
 */
export function businessDateIn(timezone: string, nowIso: string): string {
  const day = new Intl.DateTimeFormat("en-CA", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit" })
    .format(new Date(nowIso));
  if (!DATE_RE.test(day)) throw new Error(`暦日の計算に失敗しました: ${timezone} ${nowIso} -> ${day}`);
  return day;
}

/**
 * 期限超過の判定（docs/14 D06）。タイムゾーンの暦日で next_due_date < 今日 のとき true。
 * dueDateは業務日（YYYY-MM-DD）で、ISOの暦日は辞書順＝時系列順なので文字列比較でよい。
 * nowIsoは瞬間（UTC ISO8601）。timezoneは暦日を計算するタイムゾーン（API入力はAsia/Tokyoに固定）。
 */
export function isOverdue(dueDate: string, nowIso: string, timezone: string): boolean {
  if (!DATE_RE.test(dueDate)) throw new Error(`dueDateは業務日(YYYY-MM-DD)で指定してください: ${dueDate}`);
  return businessDateIn(timezone, nowIso) > dueDate;
}

/**
 * due=overdue（期限超過の現役資産）の共通WHERE。一覧（API-18/19のdue=overdue）とホームの件数
 * （API-28のinspectionDue）が**この関数を共有**することで、数値と一覧件数の不一致を作らない
 * （T047のactivityConditionsと同じ方式）。超過の定義はisOverdueと同じ（JST暦日で next_due_date < 今日）で、
 * 廃止資産（archived_at または status='廃止'。docs/14 D24の両建て）は数えない。
 * 識別子は呼び出し側の閉じたunionからのみ組み立てる（注入しない）。
 */
export function overdueAssetCondition(
  assetTable: "vehicles" | "equipment",
  todayJst: string,
): { where: string; binds: [string] } {
  const targetColumn = assetTable === "vehicles" ? "vehicle_id" : "equipment_id";
  return {
    where:
      `EXISTS (SELECT 1 FROM inspection_schedules s WHERE s.${targetColumn} = ${assetTable}.id AND s.next_due_date < ?) ` +
      `AND ${assetTable}.archived_at IS NULL AND ${assetTable}.status != '廃止'`,
    binds: [todayJst],
  };
}

export interface DueDetectionResult {
  /** 期限を超過している（現役対象の）scheduleの件数 */
  detected: number;
  /** 今回新たに inspection_due_detections へ記録できた件数（既記録はDO NOTHINGで数えない） */
  recorded: number;
}

interface OverdueRow {
  schedule_id: string;
  unit_id: string;
  version: number;
  next_due_date: string;
  target_type: "facility" | "vehicle" | "equipment";
  target_id: string;
}

/**
 * 期限超過の点検scheduleを検出して inspection_due_detections へ記録する（T048）。
 * Cronの毎分から呼ばれる。検出自体は1回のSELECT（通常0行。idx_schedules_dueで走査）と、
 * 見つかった行だけの重複排除INSERTで済み、AI・外部サービスは呼ばない。
 * 同時に2つのCronが走っても、第2のINSERTは自然キーのUNIQUEでDO NOTHINGになる（冪等）。
 */
export async function detectDueInspections(env: Pick<AppEnv, "DB">, nowIso: string): Promise<DueDetectionResult> {
  const today = businessDateIn(BUSINESS_TIMEZONE, nowIso);
  // 超過している（今日JSTより前の期限の）scheduleだけを読み、対象の現役判定（両建て）をEXISTSで行う
  const overdue = (
    await env.DB.prepare(
      "SELECT s.id AS schedule_id, s.unit_id, s.version, s.next_due_date, " +
        "CASE WHEN s.vehicle_id IS NOT NULL THEN 'vehicle' WHEN s.equipment_id IS NOT NULL THEN 'equipment' ELSE 'facility' END AS target_type, " +
        "COALESCE(s.vehicle_id, s.equipment_id, s.facility_id) AS target_id " +
        "FROM inspection_schedules s " +
        "WHERE s.next_due_date < ?1 AND (" +
        "(s.vehicle_id IS NOT NULL AND EXISTS (SELECT 1 FROM vehicles v WHERE v.unit_id = s.unit_id AND v.id = s.vehicle_id AND v.archived_at IS NULL AND v.status != '廃止')) OR " +
        "(s.equipment_id IS NOT NULL AND EXISTS (SELECT 1 FROM equipment e WHERE e.unit_id = s.unit_id AND e.id = s.equipment_id AND e.archived_at IS NULL AND e.status != '廃止')) OR " +
        "(s.facility_id IS NOT NULL AND EXISTS (SELECT 1 FROM facilities f WHERE f.unit_id = s.unit_id AND f.id = s.facility_id AND f.archived_at IS NULL)))",
    )
      .bind(today)
      .all<OverdueRow>()
  ).results;

  if (overdue.length === 0) return { detected: 0, recorded: 0 };

  // 重複排除INSERT（UNIQUE(unit_id,対象,予定版,期限日)）。既記録の行はDO NOTHINGで変えない
  const results = await env.DB.batch(
    overdue.map((row) =>
      env.DB.prepare(
        "INSERT INTO inspection_due_detections (id, unit_id, target_type, target_id, schedule_id, schedule_version, due_date, detected_at, actor_kind, created_at) " +
          "VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'system', ?) " +
          "ON CONFLICT (unit_id, target_type, target_id, schedule_version, due_date) DO NOTHING",
      ).bind(
        crypto.randomUUID(), row.unit_id, row.target_type, row.target_id,
        row.schedule_id, row.version, row.next_due_date, nowIso, nowIso,
      ),
    ),
  );
  const recorded = results.reduce((n, res) => n + (res.meta.changes ?? 0), 0);
  return { detected: overdue.length, recorded };
}
