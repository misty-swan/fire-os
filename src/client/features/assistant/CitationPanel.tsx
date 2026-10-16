import { useEffect, useRef, useState } from "react";
import { Link } from "react-router";
import { api } from "../../api";
import { Chip, Icon } from "../../components/ui";
import type { ApiResponse } from "../../../shared/contracts/registry";

/**
 * 引用（RAGの出典）の表示（T070、SCR-28。docs/06 §5「根拠はdocumentId/version/chunk/page/section/quotedSpan付き」）。
 *
 * - API-76の応答にある引用（Citation）を「参照元」として出す。Citationは文書の題・版番号を持たないため、
 *   文書詳細（API-91）の応答から題と引用元版（documentVersionId→revisionNo・attachmentId）を引く。
 *   404なら「現在開けません」を出す（撤回・権限変更を偽装しない）。
 * - 版の文書詳細へのリンクは /app/documents/:id?revision=N（引用元版を辿る。T069）。
 * - 「原本を開く」はAPI-27（引用原文）。docs/06 §5「引用原文取得でも現ACLを検査」のとおり、開くたびに
 *   サーバーが現在の権限で再検査するため、表示時には開けた文書も撤回・権限変更の後は404になる。
 *   その場合は同じ枠内に404の案内を出す（アプリ外に袋小路を作らない）。
 * - 引用spanはchunk本文中の位置（quotedSpan）。本文の復元は画面では行わない（捏造しない。原文で確認する）。
 */

type CitationDto = ApiResponse<"API-76">["citations"][number];
type DocDetail = ApiResponse<"API-91">;

interface LoadedSource {
  detail: DocDetail | null;
  failed: boolean;
}

/** 引用1件の行（題・版の取得は同じ文書で1回にまとめるため、取得本体はCitationPanel側が保持する） */
function CitationRow({ citation, source }: { citation: CitationDto; source: LoadedSource | undefined }) {
  const [opening, setOpening] = useState(false);
  const [openFailed, setOpenFailed] = useState(false);
  const cited = source?.detail?.versions.find((v) => v.id === citation.documentVersionId) ?? null;

  const openOriginal = async (): Promise<void> => {
    if (!cited) return;
    setOpening(true);
    setOpenFailed(false);
    try {
      // 取得のたびにサーバーが現ACLを再検査する（docs/06 §5）。失効していれば404になる
      const res = await fetch(`/api/v1/attachments/${cited.attachmentId}/content`, { credentials: "same-origin" });
      if (!res.ok) {
        setOpenFailed(true);
        return;
      }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      window.open(url, "_blank", "noopener");
      window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
    } catch {
      setOpenFailed(true);
    } finally {
      setOpening(false);
    }
  };

  return (
    <li className="flex flex-col gap-2 border-b border-white/[.06] px-4 py-3.5 last:border-b-0">
      {source === undefined ? (
        <span className="text-[13px] text-ink-muted">出典の文書を確認しています…</span>
      ) : source.failed ? (
        <span className="flex items-center gap-2 text-[13px] font-medium text-ink-sub">
          <Icon name="folder_off" className="text-[18px] text-ink-muted" />
          出典の文書は現在開けません（撤回されたか、閲覧権限が変わりました）
        </span>
      ) : cited === null ? (
        <span className="text-[13px] text-ink-muted">引用元の版が見つかりません（版が取り消された可能性があります）</span>
      ) : (
        <span className="text-[14px] font-bold">{source.detail!.document.title}</span>
      )}
      {cited && (
        <>
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 font-mono text-[11px] text-ink-muted">
            <span>第{cited.revisionNo}版</span>
            {citation.pageNo !== undefined && <span>{citation.pageNo}頁</span>}
            {citation.section && <span>{citation.section}</span>}
            <span>
              引用位置 {citation.quotedSpan.start}〜{citation.quotedSpan.end}文字目
            </span>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Link
              to={`/app/documents/${citation.documentId}?revision=${cited.revisionNo}`}
              className="inline-flex min-h-11 items-center gap-1 rounded-pill bg-white/[.08] px-3 text-[12px] font-bold text-ink lg:min-h-9"
            >
              第{cited.revisionNo}版の文書を開く
              <Icon name="chevron_right" className="text-[15px]" />
            </Link>
            <button
              type="button"
              onClick={() => void openOriginal()}
              className="inline-flex min-h-11 items-center gap-1 rounded-pill bg-white/[.08] px-3 text-[12px] font-bold text-ink lg:min-h-9"
            >
              <Icon name="description" className="text-[15px]" />
              {opening ? "開いています…" : "原本を開く"}
            </button>
          </div>
          {openFailed && (
            <p role="alert" className="text-[12px] font-medium leading-[1.6] text-attention">
              この出典の原文は開けません（404）。文書が撤回されたか、閲覧権限が変わりました。引用原文は開くたびに現在の権限で改めて確認されます。
            </p>
          )}
        </>
      )}
    </li>
  );
}

export function CitationPanel({ citations }: { citations: readonly CitationDto[] }) {
  // 題・引用元版の取得（API-91。同じ文書は1回だけ読み、versionsから引用元版を引く）
  const [sources, setSources] = useState<Record<string, LoadedSource>>({});
  const requested = useRef<Set<string>>(new Set());
  const documentIds = [...new Set(citations.map((c) => c.documentId))].sort().join(",");

  useEffect(() => {
    let alive = true;
    for (const documentId of documentIds.split(",").filter((k) => k.length > 0)) {
      if (requested.current.has(documentId)) continue;
      requested.current.add(documentId);
      void (async () => {
        try {
          const d = await api("API-91", { params: { id: documentId }, query: {} });
          if (alive) setSources((p) => ({ ...p, [documentId]: { detail: d, failed: false } }));
        } catch {
          if (alive) setSources((p) => ({ ...p, [documentId]: { detail: null, failed: true } }));
        }
      })();
    }
    return () => {
      alive = false;
    };
  }, [documentIds]);

  return (
    <section aria-label="参照元" className="flex flex-col gap-2">
      <div className="flex items-center gap-2 px-0.5">
        <Chip tone="neutral" icon="menu_book">
          参照元
        </Chip>
        <span className="text-[11px] text-ink-muted">回答の根拠になった文書の出典です（版・頁・引用位置）</span>
      </div>
      <ul className="flex flex-col overflow-hidden rounded-[20px] bg-white/[.04] p-0 shadow-[inset_0_0_0_1px_rgba(255,255,255,.08)]">
        {citations.map((c, i) => (
          <CitationRow key={`${c.chunkId}:${i}`} citation={c} source={sources[c.documentId]} />
        ))}
      </ul>
    </section>
  );
}
