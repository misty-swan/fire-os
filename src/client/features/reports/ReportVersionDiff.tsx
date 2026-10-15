import { Card, Chip } from "../../components/ui";
import type { ReportVersionDto } from "../../../shared/contracts/content";

/**
 * 報告書の版比較（T059、SCR-19「編集/版/承認/出力」。docs/03 §2 SCR-19「人数/時刻は元実績と比較」）。
 *
 * - 新旧版の本文差分は**行単位の簡易diff（一致/追加/削除）**。ライブラリは追加しない（コントローラ裁定2）。
 *   最長共通部分列（LCS）を動的計画法で求める素朴な実装で、行数の上限（DIFF_LINE_LIMIT）を超えたら
 *   打ち切って「続きは省略」と示す（帳票の本文は20,000字上限。誤った「一致」を作らないための打ち切り）。
 * - 差分のほかに、不足欄（missingFields）・元実績の版（sourceVersions）・様式/モデル/質問版/承認状態を
 *   並べて出す（docs/06 §4「本文を元実績と比較し、不足項目・引用参照を表示する」）。
 */

export type DiffRowType = "same" | "add" | "del";
export interface DiffRow {
  type: DiffRowType;
  text: string;
}

/** 差分を計算する行数の上限（片側。超えた部分は「続きは省略」になる。O(n·m)を数百行に収める） */
const DIFF_LINE_LIMIT = 400;

/**
 * 行単位の簡易diff（LCS。ライブラリ無し）。打ち切りがあることは戻り値の truncated で示す
 * （黙って省略しない。docs/03 §1「黙って切り捨てない」の共通規則）。
 */
export function lineDiff(before: string, after: string): { rows: DiffRow[]; truncated: boolean } {
  const a = before.split("\n");
  const b = after.split("\n");
  const truncated = a.length > DIFF_LINE_LIMIT || b.length > DIFF_LINE_LIMIT;
  // 上限を超える場合は先頭だけを比較する（残りは省略した旨を画面で出す）
  const as = a.slice(0, DIFF_LINE_LIMIT);
  const bs = b.slice(0, DIFF_LINE_LIMIT);
  const n = as.length;
  const m = bs.length;
  // dp[i][j] = as[i..] と bs[j..] のLCS長（下から埋める）
  const dp: Uint32Array[] = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i]![j] = as[i] === bs[j] ? dp[i + 1]![j + 1]! + 1 : Math.max(dp[i + 1]![j]!, dp[i]![j + 1]!);
    }
  }
  const rows: DiffRow[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (as[i] === bs[j]) {
      rows.push({ type: "same", text: as[i]! });
      i++;
      j++;
    } else if (dp[i + 1]![j]! >= dp[i]![j + 1]!) {
      rows.push({ type: "del", text: as[i]! });
      i++;
    } else {
      rows.push({ type: "add", text: bs[j]! });
      j++;
    }
  }
  while (i < n) rows.push({ type: "del", text: as[i++]! });
  while (j < m) rows.push({ type: "add", text: bs[j++]! });
  return { rows, truncated };
}

/** 版の状態の語彙（docs/11 報告書/文書版。prototypeの活動記録「下書き→確認待ち→承認」の語に揃える） */
export const REPORT_VERSION_STATUS: Record<
  ReportVersionDto["status"],
  { label: string; tone: "neutral" | "ok" | "attention" | "ai" }
> = {
  draft: { label: "下書き", tone: "neutral" },
  in_review: { label: "確認待ち", tone: "attention" },
  approved: { label: "承認済み", tone: "ok" },
  changes_requested: { label: "差戻し", tone: "attention" },
  superseded: { label: "置き換え済み", tone: "neutral" },
  withdrawn: { label: "取り下げ", tone: "neutral" },
};

const DIFF_META: Record<DiffRowType, { mark: string; className: string; label: string }> = {
  same: { mark: " ", className: "text-ink-sub", label: "変わらない行" },
  add: { mark: "+", className: "text-ok", label: "追加された行" },
  del: { mark: "−", className: "text-alert", label: "削除された行" },
};

/** 元実績の版の1行（版の保存値。docs/04:147 source_versions） */
function SourceVersionRow({ label, value }: { label: string; value: string | number }) {
  return (
    <span className="flex items-center gap-2 text-[12px]">
      <span className="text-ink-muted">{label}</span>
      <span className="font-mono text-ink-sub">{value}</span>
    </span>
  );
}

/**
 * 選択中の版（after）と直前の版（before）の比較。
 * before=null（最初の版）のときは「比較する前の版はありません」を出す。
 */
export function ReportVersionDiff({
  before,
  after,
}: {
  before: ReportVersionDto | null;
  after: ReportVersionDto;
}) {
  const { rows, truncated } = before
    ? lineDiff(before.text, after.text)
    : { rows: [] as DiffRow[], truncated: false };
  const changed = rows.some((r) => r.type !== "same");

  return (
    <section className="flex flex-col gap-2" aria-label="直前の版との差分">
      <h3 className="text-[14px] font-bold">直前の版との差分</h3>
      {!before ? (
        <Card className="flex flex-col gap-1.5">
          <p className="text-[13px] text-ink-sub">これが最初の版のため、比較する前の版はありません。</p>
        </Card>
      ) : (
        <>
          {!changed && (
            <p className="text-[13px] text-ink-sub">本文は直前の版から変わっていません（記録欄の違いだけの可能性があります）。</p>
          )}
          {changed && (
            <div className="hairline flex flex-col gap-px overflow-hidden rounded-[16px] bg-white/[.04]" role="list" aria-label="本文の差分">
              {rows.map((r, idx) => {
                const meta = DIFF_META[r.type];
                return (
                  <div
                    key={idx}
                    role="listitem"
                    aria-label={meta.label}
                    className={`flex items-start gap-2 px-3 py-1.5 font-mono text-[13px] leading-[1.6] whitespace-pre-wrap ${meta.className} ${
                      r.type === "add" ? "bg-[rgba(58,208,143,.07)]" : r.type === "del" ? "bg-[rgba(255,122,102,.07)]" : ""
                    }`}
                  >
                    <span aria-hidden="true" className="w-3 flex-none select-none font-bold">
                      {meta.mark}
                    </span>
                    <span className="min-w-0 flex-1">{r.text === "" ? "（空行）" : r.text}</span>
                  </div>
                );
              })}
            </div>
          )}
          {truncated && (
            <p className="text-[12px] text-attention">
              本文が長いため、先頭{DIFF_LINE_LIMIT}行ぶんの差分だけを表示しています（続きは省略。記録は全行残っています）。
            </p>
          )}
        </>
      )}

      {/* 差分のほかに版の記録欄を並べる（docs/06 §4「不足項目・引用参照を表示する」） */}
      <Card className="flex flex-col gap-2" aria-label="版の記録の比較">
        <div className="grid gap-2 text-[12px] sm:grid-cols-2">
          <div className="flex flex-col gap-1">
            <span className="text-[11px] font-bold text-ink-muted">直前の版（第{before?.revisionNo ?? "—"}版）</span>
            {before ? <VersionMetaRow version={before} /> : <span className="text-ink-sub">—</span>}
          </div>
          <div className="flex flex-col gap-1">
            <span className="text-[11px] font-bold text-ink-muted">見ている版（第{after.revisionNo}版）</span>
            <VersionMetaRow version={after} />
          </div>
        </div>
        <div className="flex flex-col gap-1 border-t border-white/[.06] pt-2">
          <span className="text-[11px] font-bold text-ink-muted">元実績の版（この版を作るときに使った記録の版。サーバーが記録）</span>
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
            <SourceVersionRow label="予定の版" value={`v${after.sourceVersions.activityVersion}`} />
            <SourceVersionRow label="実績の版" value={`v${after.sourceVersions.resultVersion}`} />
            <SourceVersionRow label="実績の訂正番号" value={`第${after.sourceVersions.resultRevisionNo}版`} />
          </div>
        </div>
      </Card>
    </section>
  );
}

/** 1版ぶんの記録欄（様式/モデル/質問版/不足欄/承認状態。docs/03 SCR-19「様式/モデル/質問/版を表示」） */
function VersionMetaRow({ version }: { version: ReportVersionDto }) {
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-ink-sub">
      <span>
        状態 <Chip tone={REPORT_VERSION_STATUS[version.status].tone}>{REPORT_VERSION_STATUS[version.status].label}</Chip>
      </span>
      <span className="font-mono text-[11px]">様式 {version.templateVersion}</span>
      <span className="text-[11px]">
        {version.modelId ? `AI生成（モデル ${version.modelId}` : "手動で作成"}
        {version.modelId ? `・質問版 ${version.promptVersion ?? "記録なし"})` : ""}
      </span>
      {version.usageJson && (
        <span className="font-mono text-[11px] text-ink-muted">
          tokens {version.usageJson.promptTokens}/{version.usageJson.completionTokens}
        </span>
      )}
      <span className="text-[11px]">
        不足欄{" "}
        {version.missingFields.length > 0 ? (
          <span className="font-mono">{version.missingFields.join("・")}</span>
        ) : (
          "なし"
        )}
      </span>
    </div>
  );
}
