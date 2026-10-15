/**
 * 活動画面共通の日時の表示と入力値の変換。
 * 表示は端末の横軸（prototype: 「10/17（土）19:00」）、送信はUTCのInstant（docs/05 §1）。
 * 未知の時刻は空欄のまま扱い、捏造しない（docs/05 §3「未知時刻は欠落表示」）。
 */

const WEEKDAYS = ["日", "月", "火", "水", "木", "金", "土"] as const;

/** 「10/17（土）」 */
export function fmtDay(iso: string): string {
  const d = new Date(iso);
  return `${d.getMonth() + 1}/${d.getDate()}（${WEEKDAYS[d.getDay()]}）`;
}

/** 「19:00」 */
export function fmtHM(iso: string): string {
  const d = new Date(iso);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** 「10/17（土）19:00」 */
export function fmtInstant(iso: string): string {
  return `${fmtDay(iso)} ${fmtHM(iso)}`;
}

/** datetime-localの値 → Instant。空欄は未入力としてundefined（未知の時刻は送らない） */
export function instantFromInput(value: string): string | undefined {
  if (!value) return undefined;
  return new Date(value).toISOString();
}

/** Instant → datetime-localの値。null（未知）は空欄のまま */
export function inputFromInstant(iso: string | null | undefined): string {
  if (!iso) return "";
  const d = new Date(iso);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** date入力（YYYY-MM-DD）の0時、または翌日の0時（排他の上限）をInstantへ。API-05は半開区間[from, to) */
export function dayBoundaryToInstant(day: string, endExclusive = false): string | undefined {
  if (!day) return undefined;
  const d = new Date(`${day}T00:00:00`);
  if (endExclusive) d.setDate(d.getDate() + 1);
  return d.toISOString();
}

/** URLクエリのfrom/toは日付（YYYY-MM-DD）でもInstantでも受ける（T047のドリルダウンリンク用） */
export function boundFromQuery(value: string, endExclusive = false): string | undefined {
  if (value.includes("T")) return value;
  return dayBoundaryToInstant(value, endExclusive);
}

/** Instantがday（端末の横軸の日）に含まれるか（週ストリップの点灯用） */
export function isSameDay(iso: string, day: Date): boolean {
  const d = new Date(iso);
  return d.getFullYear() === day.getFullYear() && d.getMonth() === day.getMonth() && d.getDate() === day.getDate();
}
