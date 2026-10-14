import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "../../api";
import { ApiError } from "../../api";
import { PageTitle } from "../../components/Page";
import { Banner, Button, Card, Chip, Icon, Notice } from "../../components/ui";
import { useFacilities } from "../map/useFacilities";

/**
 * 施設のCSV取込み（T024、SCR-20。docs/03: プレビュー→確定→結果→再プレビュー）。
 * プレビューでは台帳は変更されない。プレビュー後に台帳が変わると確定は409になり、再プレビューを促す。
 * 解析後は行番号付きのエラー（docs/03 SCR-20）を示し、台帳の書き出し（API-55）へも導線を作る。
 */

interface PreviewResponse {
  id: string;
  jobId: string;
  version: number;
  totalRows: number;
  validRows: number;
  errorRows: number;
  previewHash: string;
}

/** 行エラーの理由コード → 日本語（src/server/gis/csv.ts の validateFacilityRow と重複分） */
const ROW_ERROR_LABELS: Record<string, string> = {
  column_count: "列の数がヘッダーと一致しません",
  invalid_type: "種別は hydrant・cistern・box のどれかで指定してください",
  missing_ident: "管理番号か識別名のどちらかが必要です",
  management_number_too_long: "管理番号は100文字以内にしてください",
  identifying_name_too_long: "識別名は100文字以内にしてください",
  location_source_too_long: "位置の出典は100文字以内にしてください",
  location_note_too_long: "目印・場所のメモは1000文字以内にしてください",
  missing_coordinates: "緯度・経度が空です",
  invalid_latitude: "緯度が不正です（-90〜90の十進数）",
  invalid_longitude: "経度が不正です（-180〜180の十進数）",
  missing_source: "位置の出典が空です",
  missing_note: "目印・場所のメモが空です",
  duplicate_number_in_file: "同じ管理番号の行がファイルの中にもあります",
  duplicate_number_in_master: "同じ種別・管理番号が台帳に既にあります",
};

const rowErrorLabel = (code: string) => ROW_ERROR_LABELS[code] ?? `未対応のエラー（${code}）`;

/** 解析jobのresultRefから、件数と行エラー（先頭分。上限はresultRefの500字）を読む */
function parseResultRef(ref: string): {
  previewHash: string; validRows: number; totalRows: number;
  rowErrors: { rowNo: number; error: string }[]; rowErrorsTruncated: boolean;
} | null {
  const match = /ready:([0-9a-f]{64}):(\d+)\/(\d+)/.exec(ref);
  if (!match) return null;
  const prefix = `ready:${match[1]!}:${match[2]}/${match[3]}`;
  const rest = ref.slice(prefix.length);
  const truncated = rest.endsWith(":~");
  const body = truncated ? rest.slice(0, -":~".length) : rest;
  const rowErrors = body
    .split(";")
    .filter((p) => p !== "")
    .map((p) => {
      const [rowNo, code] = p.replace(/^:/, "").split("=");
      return { rowNo: Number(rowNo), error: code ?? "" };
    })
    .filter((e) => Number.isFinite(e.rowNo) && e.error !== "");
  return {
    previewHash: match[1]!,
    validRows: Number(match[2]),
    totalRows: Number(match[3]),
    rowErrors,
    rowErrorsTruncated: truncated,
  };
}

export function ImportPage() {
  const { items, reload } = useFacilities({});
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<PreviewResponse | null>(null);
  const [rowErrors, setRowErrors] = useState<{ rowNo: number; error: string }[]>([]);
  const [rowErrorsTruncated, setRowErrorsTruncated] = useState(false);
  const [phase, setPhase] = useState<"idle" | "uploading" | "inspecting" | "parsing" | "committing" | "committed" | "conflict" | "error">("idle");
  const [message, setMessage] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const waitJob = useCallback(async (jobId: string, steps = 60): Promise<{ status: string; resultRef: string | null } | null> => {
    for (let i = 0; i < steps; i++) {
      await new Promise((r) => setTimeout(r, 1500));
      const job = await api("API-86", { params: { id: jobId } }).catch(() => null);
      if (!job) continue;
      if (job.status === "succeeded") return { status: "succeeded", resultRef: job.resultRef };
      if (job.status === "manual_review" || job.status === "stale") throw new Error("job_failed");
    }
    return null;
  }, []);

  const runPreview = useCallback(async (f: File) => {
    setPhase("uploading");
    setMessage(null);
    setPreview(null);
    setRowErrors([]);
    setRowErrorsTruncated(false);
    try {
      const draft = await api("API-98", { body: { intendedEntityType: "import_batch" } });
      const intent = await api("API-26", { body: { target: { type: "attachment_draft", id: draft.id }, contentType: "text/csv", byteSize: f.size } });
      const up = await fetch(`/api/v1/attachments/${intent.id}/upload`, {
        method: "PUT", credentials: "same-origin",
        headers: { "content-type": "text/csv", "x-upload-token": intent.uploadToken ?? "" },
        body: f,
      });
      if (!up.ok) throw new Error("upload");
      const attempt = (await up.json()) as { data: { id: string; sha256: string } };
      setPhase("inspecting");
      const done = await api("API-84", { params: { id: intent.id }, body: { version: 1, uploadAttemptId: attempt.data.id, sha256: attempt.data.sha256 } });
      const inspect = await waitJob(done.job.id, 30);
      if (inspect?.status !== "succeeded") throw new Error("inspect_timeout");
      setPhase("parsing");
      const preview = (await api("API-53", { body: { csvAttachmentId: intent.id, templateVersion: "csv-facilities-v1" } })) as unknown as PreviewResponse;
      // 解析job（API-86）の結果から件数・確定用のpreviewHash・行エラーを取り出す
      const parseJob = await waitJob(preview.jobId, 40);
      const parsed = parseJob?.status === "succeeded" ? parseResultRef(parseJob.resultRef ?? "") : null;
      if (!parsed) throw new Error("parse_failed");
      setPreview({
        id: preview.id, jobId: preview.jobId, version: 3, // pending(1)→parsing(2)→ready(3)
        previewHash: parsed.previewHash, validRows: parsed.validRows, totalRows: parsed.totalRows,
        errorRows: parsed.totalRows - parsed.validRows,
      });
      setRowErrors(parsed.rowErrors);
      setRowErrorsTruncated(parsed.rowErrorsTruncated);
      setPhase("idle");
      setMessage(null);
    } catch (e) {
      setPhase("error");
      setMessage(
        e instanceof ApiError && e.status === 400
          ? "CSVの形式を確認してください（UTF-8、ヘッダー、100行以内）。"
          : "CSVの取り込みに失敗しました。時間を置いて再試行してください。",
      );
    }
  }, [waitJob]);

  const commit = useCallback(async () => {
    if (!preview?.previewHash) return;
    setPhase("committing");
    try {
      const commitRes = await api("API-54", { params: { id: preview.id }, body: { version: preview.version, previewHash: preview.previewHash, conflictResolution: "skip" } });
      const commitJob = await waitJob((commitRes as unknown as { jobId: string }).jobId, 60);
      if (commitJob?.status !== "succeeded") throw new Error("commit_timeout");
      setPhase("committed");
      reload();
    } catch {
      setPhase((prev) => (prev === "committing" ? "error" : prev));
      setPhase("conflict");
    }
  }, [preview, reload, waitJob]);

  return (
    <div className="flex max-w-[720px] flex-col gap-4">
      <PageTitle eyebrow="IMPORT" className="lg:hidden">施設CSV取込</PageTitle>

      <Card className="flex flex-col gap-3">
        <span className="text-[14px] font-bold">CSVの取り込み</span>
        <p className="text-[12px] leading-[1.6] text-ink-muted">
          1行目はヘッダー（type, management_number, identifying_name, latitude, longitude, location_source, location_note）。
          UTF-8・100行まで。プレビューでは台帳は変更されません。
        </p>
        <div className="flex items-center gap-3">
          <label className="flex min-h-11 cursor-pointer items-center gap-2 rounded-pill bg-white/[.08] px-4 text-[14px] font-bold max-lg:min-h-11 self-start">
            <Icon name="upload_file" className="text-[19px]" />
            CSVを選択
            <input
              ref={fileRef}
              type="file"
              accept=".csv,text/csv"
              className="sr-only"
              onChange={(e) => {
                setFile(e.target.files?.[0] ?? null);
                setPreview(null);
                setRowErrors([]);
                setRowErrorsTruncated(false);
                setPhase("idle");
                setMessage(null);
              }}
            />
          </label>
          {file && <span className="text-[13px] text-ink-sub">{file.name}（{file.size}バイト）</span>}
        </div>
        <Button busy={phase === "uploading" || phase === "inspecting" || phase === "parsing"} disabled={!file} onClick={() => file && void runPreview(file)} className="self-start max-lg:min-h-11 px-6">
          {phase === "uploading" ? "転送中…" : phase === "inspecting" ? "検査中…" : phase === "parsing" ? "解析中…" : "プレビュー"}
        </Button>
        {message && <Notice tone="warning" icon="error" role="status">{message}</Notice>}
      </Card>

      {preview?.totalRows !== null && preview && (
        <Card className="flex flex-col gap-3" aria-label="プレビュー結果">
          <div className="flex items-center justify-between">
            <span className="text-[14px] font-bold">プレビューの結果</span>
            <Chip tone="neutral">batch {preview.id.slice(0, 8)}</Chip>
          </div>
          <div className="grid grid-cols-3 gap-2 text-center">
            <div className="rounded-[14px] bg-white/[.05] p-3"><div className="font-mono text-[18px] font-bold">{preview.totalRows ?? "—"}</div><div className="text-[11px] text-ink-muted">全体</div></div>
            <div className="rounded-[14px] bg-ok/10 p-3"><div className="font-mono text-[18px] font-bold text-ok">{preview.validRows ?? "—"}</div><div className="text-[11px] text-ink-muted">取込可能</div></div>
            <div className="rounded-[14px] bg-[rgba(255,90,70,.1)] p-3"><div className="font-mono text-[18px] font-bold text-alert">{preview.errorRows ?? "—"}</div><div className="text-[11px] text-ink-muted">エラー</div></div>
          </div>
          {/* 行ごとのエラー（docs/03 SCR-20「行番号付き」） */}
          {rowErrors.length > 0 && (
            <div className="flex flex-col gap-1.5" aria-label="行のエラー">
              <span className="text-[12px] font-bold text-ink-sub">行のエラー（{rowErrorsTruncated ? "先頭分のみ" : `${rowErrors.length}件`}）</span>
              <ul className="fo-scroll max-h-56 overflow-y-auto rounded-[14px] bg-[rgba(255,90,70,.07)] p-2 shadow-[inset_0_0_0_1px_rgba(255,90,70,.25)]">
                {rowErrors.map((e) => (
                  <li key={e.rowNo} className="flex gap-2.5 px-1.5 py-1 text-[12px] leading-[1.6]">
                    <span className="flex-none font-mono font-semibold text-[#ffb0a4]">{e.rowNo}行目</span>
                    <span className="text-[#e7c9c4]">{rowErrorLabel(e.error)}</span>
                  </li>
                ))}
              </ul>
              {rowErrorsTruncated && <p className="text-[11px] text-ink-muted">表示は先頭分だけです。CSVを修正すると、次のプレビューで続きが分かります。</p>}
              <Notice tone="warning" icon="warning">エラーの行は取り込まれません。CSVを修正して再度プレビューできます。</Notice>
            </div>
          )}
          {rowErrors.length === 0 && preview.errorRows !== null && preview.errorRows > 0 && (
            <Notice tone="warning" icon="warning">エラーの行は取り込まれません。CSVを修正して再度プレビューできます。</Notice>
          )}
          <Button busy={phase === "committing"} onClick={() => void commit()} disabled={(preview.validRows ?? 0) === 0} className="self-start max-lg:min-h-11 px-6">
            {phase === "committing" ? "確定中…" : "この内容で確定する"}
          </Button>
        </Card>
      )}

      {/* 台帳の書き出し（API-55。GET CSV。same-originなのでcookieが付く）。プレビューが済んだら案内する */}
      {preview && (
        <a
          href="/api/v1/facilities/export"
          className="hairline flex min-h-11 items-center gap-2.5 self-start rounded-card bg-white/[.04] px-3.5 text-[13px] font-bold text-ink-sub hover:bg-white/[.07]"
        >
          <Icon name="download" className="text-[18px]" />
          現在の台帳を書き出す（CSV）
        </a>
      )}

      {phase === "committed" && (
        <Banner tone="success" eyebrow="COMMITTED" title="取り込みました">
          現在の台帳は {items.length}件です。マップで確認できます。
        </Banner>
      )}
      {phase === "conflict" && (
        <Banner tone="warning" eyebrow="CONFLICT" title="プレビュー後に台帳が変わりました">
          もう一度プレビューからやり直してください。
        </Banner>
      )}
      {phase === "error" && (
        <Banner tone="error" eyebrow="ERROR" title="確定できませんでした">時間を置いて再試行してください。</Banner>
      )}
    </div>
  );
}
