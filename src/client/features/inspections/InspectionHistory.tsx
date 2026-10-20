import { Link, useLocation } from "react-router";
import { Chip, Notice } from "../../components/ui";

/**
 * 点検の記録（T033の残作業をT085で接続。施設詳細SCR-04・資産詳細SCR-14で共用。docs/03 §1.1-27）。
 * - 新しい順。訂正前の原本も残る（追記型）。
 * - 「訂正済み」はこの原本を訂正した記録があるとき（supersededById）。isCurrent=false は「より新しい記録がある」
 *   という意味で、訂正済みではない（系列は対象ごとに1本なので新しい点検でもポインタが移る。T085レビューA-I1）。
 * - 訂正できるのは系列の現在版（isCurrent）だけ（API-46の版ガード）。correctTo を渡した画面だけ行に導線を出す。
 */
export interface InspectionHistoryRow {
  id: string;
  seriesVersion: number;
  templateVersionId: string;
  inspectedAt: string;
  result: string;
  note: string;
  items: { code: string; result: string }[];
  supersedesId: string | null;
  supersededById: string | null;
  isCurrent: boolean;
}

export const INSPECTION_RESULT_LABELS: Record<string, { label: string; tone: "ok" | "alert" | "neutral" }> = {
  ok: { label: "良好", tone: "ok" },
  needs_review: { label: "異常あり", tone: "alert" },
  unknown: { label: "未確認", tone: "neutral" },
};

const jstDayFormat = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Tokyo", year: "numeric", month: "2-digit", day: "2-digit" });
/** 業務日（日本時間の日付 YYYY-MM-DD。UTCの切り出しだと早朝の点検が前日に見えるため。T085レビューC3） */
export const jstDay = (iso: string): string => jstDayFormat.format(new Date(iso));

export function InspectionHistoryList({ rows, correctTo }: { rows: InspectionHistoryRow[]; correctTo?: (row: InspectionHistoryRow) => string }) {
  return (
    <ul aria-label="点検の記録" className="flex flex-col divide-y divide-white/[.06]">
      {rows.map((r) => {
        const meta = INSPECTION_RESULT_LABELS[r.result];
        return (
          <li key={r.id} className="flex flex-wrap items-center gap-2 py-2 text-[13px]">
            <span className="font-mono text-[12px] text-ink-sub">{jstDay(r.inspectedAt)}</span>
            <Chip tone={meta?.tone ?? "neutral"}>{meta?.label ?? "結果を確認中"}</Chip>
            {r.supersedesId && <span className="text-[11px] text-ink-muted">訂正後の記録</span>}
            {r.supersededById && <span className="text-[11px] text-ink-muted">訂正済み</span>}
            <span className="min-w-0 flex-1 truncate text-ink-sub">{r.note}</span>
            {correctTo && r.isCurrent && (
              <Link
                to={correctTo(r)}
                className="inline-flex min-h-11 items-center rounded-pill bg-white/[.08] px-3 text-[12px] font-bold text-ink lg:min-h-9"
              >
                訂正する
              </Link>
            )}
          </li>
        );
      })}
    </ul>
  );
}

/**
 * 点検の保存後、詳細画面に戻ったときに「異常の報告を作ったか」を示す（T085裁定R20）。
 * 訂正では、記録の履歴に既に異常の報告があればサーバーは新しく作らないため、実際の結果を表示する。
 */
export function InspectionIssueOutcome() {
  const location = useLocation();
  const outcome = (location.state as { inspectionIssueOutcome?: "created" | "already_raised" } | null)?.inspectionIssueOutcome;
  if (!outcome) return null;
  return (
    <Notice tone={outcome === "created" ? "warning" : "info"} icon="report" role="status">
      {outcome === "created"
        ? "異常の報告を作成しました。点検管理で確認できます。"
        : "この記録の履歴に異常の報告がすでにあるため、新しい異常の報告は作りませんでした。"}
    </Notice>
  );
}
