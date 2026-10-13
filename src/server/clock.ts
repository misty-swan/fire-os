// 時刻の注入点。業務コードは Date.now() を直接呼ばず Clock を受け取る（試験で固定時計を使うため）。
export interface Clock {
  now(): Date;
}
export const systemClock: Clock = { now: () => new Date() };

/** DBに保存するUTC ISO8601固定ミリ秒（例 2026-10-13T00:00:00.000Z）。 */
export const toDbTime = (d: Date): string => d.toISOString();
