import { drizzle, type DrizzleD1Database } from "drizzle-orm/d1";
import type { AppEnv } from "../env";
import * as core from "./schema/core";
import * as events from "./schema/events";
import * as jobs from "./schema/jobs";

export const schema = { ...core, ...events, ...jobs };
export type FireDb = DrizzleD1Database<typeof schema>;

/** 型付きクエリ用のDBハンドル。更新は mutations/execute.ts（原子batch）を通す。 */
export function createDb(env: Pick<AppEnv, "DB">): FireDb {
  return drizzle(env.DB, { schema });
}
