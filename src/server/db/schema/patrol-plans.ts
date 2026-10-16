import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { rootColumns } from "./core";

// 地域の点検巡回計画（docs/04:157、drizzle/0030_patrol_plans.sql、T071）。制約の正本はSQL。

/**
 * 巡回計画の案。statusはdraft→confirmed/cancelled（docs/11。confirmed/cancelledは終端で、
 * 変更は新しい案として作り直す＝docs/16 T071の裁定）。書き込みはAPI-78（作成）とAPI-79（決定）だけ。
 */
export const patrolPlans = sqliteTable(
  "patrol_plans",
  {
    id: text("id").primaryKey(),
    unitId: text("unit_id").notNull(),
    /** 巡回の業務日（YYYY-MM-DD。docs/04 §1） */
    planDate: text("plan_date").notNull(),
    /** 目的（1〜200。docs/05 API-78のobjective） */
    objective: text("objective").notNull(),
    status: text("status", { enum: ["draft", "confirmed", "cancelled"] }).notNull(),
    /** 決定（確定/取消）の時刻。draftではNULL（SQLのCHECKでstatusと対） */
    decidedAt: text("decided_at"),
    /** 決定者（users）。draftではNULL */
    decidedBy: text("decided_by"),
    ...rootColumns,
  },
  (t) => [index("idx_patrol_plans_unit_date").on(t.unitId, t.planDate)],
);

/**
 * 巡回の立ち寄り順（docs/04:157「stop側plan_id/facility_id/position。順序一意」）。
 * positionは1始まりでplan内一意、facilityは同じplanに1回だけ（SQLのUNIQUE索引）。
 * 案作成時にサーバーが最近傍順を提案して保存し、確定時に人が送った順序で同じbatch内で作り直す。
 */
export const patrolPlanStops = sqliteTable(
  "patrol_plan_stops",
  {
    id: text("id").primaryKey(),
    unitId: text("unit_id").notNull(),
    planId: text("plan_id").notNull(),
    facilityId: text("facility_id").notNull(),
    position: integer("position").notNull(),
    actorUserId: text("actor_user_id"),
    actorKind: text("actor_kind", { enum: ["human", "system"] }).notNull(),
    createdAt: text("created_at").notNull(),
  },
  (t) => [
    index("idx_patrol_plan_stops_facility").on(t.facilityId),
    index("idx_patrol_plan_stops_plan").on(t.planId, t.position),
  ],
);
