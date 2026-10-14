import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "../../api";
import { ApiError } from "../../api";
import { PageTitle } from "../../components/Page";
import { Banner, Button, Card, Chip, Icon, Notice } from "../../components/ui";
import { useFacilities } from "../map/useFacilities";

/**
 * 施設のCSV取込み（T024、SCR-20。docs/03: プレビュー→確定→結果→再プレビュー）。
 * プレビューでは台帳は変更されない。プレビュー後に台帳が変わると確定は409になり、再プレビューを促す。
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

export function ImportPage() {
  const { items, reload } = useFacilities({});
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<PreviewResponse | null>(null);
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
      // 解析job（API-86）の結果から件数と確定用のpreviewHashを取り出す
      const parseJob = await waitJob(preview.jobId, 40);
      const match = /ready:([0-9a-f]{64}):(\d+)\/(\d+)/.exec(parseJob?.resultRef ?? "");
      if (parseJob?.status !== "succeeded" || !match) throw new Error("parse_failed");
      setPreview({
        id: preview.id, jobId: preview.jobId, version: 3, // pending(1)→parsing(2)→ready(3)
        previewHash: match[1]!, validRows: Number(match[2]), totalRows: Number(match[3]),
        errorRows: Number(match[3]) - Number(match[2]),
      });
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
          {preview.errorRows !== null && preview.errorRows > 0 && (
            <Notice tone="warning" icon="warning">エラーの行は取り込まれません。CSVを修正して再度プレビューできます。</Notice>
          )}
          <Button busy={phase === "committing"} onClick={() => void commit()} disabled={(preview.validRows ?? 0) === 0} className="self-start max-lg:min-h-11 px-6">
            {phase === "committing" ? "確定中…" : "この内容で確定する"}
          </Button>
        </Card>
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


