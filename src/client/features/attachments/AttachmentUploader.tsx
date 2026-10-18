import { useCallback, useEffect, useRef, useState } from "react";
import { ApiError, api } from "../../api";
import { Banner, Button, Icon } from "../../components/ui";
import { attachmentTargetTypes, type Attachment } from "../../../shared/contracts/assets";
import { randomUuid } from "../../uuid";

/**
 * 写真・PDFのアップロード（T018、docs/03 点検/添付、docs/07 §3）。
 * 「転送中」と「検査中」を別の状態として示し、検査が終わったものだけを ready として親へ渡す
 * （docs/16 T018: 未検査/拒否/未同期を保存済みと表示しない）。
 */

export type AttachmentTargetType = (typeof attachmentTargetTypes)[number];

interface Item {
  key: string;
  name: string;
  size: number;
  state: "waiting" | "uploading" | "checking" | "ready" | "rejected" | "expired" | "error";
  detail?: string;
  attachmentId?: string;
  blobUrl?: string;
}

const REJECT_REASONS: Record<string, string> = {
  png_bad_magic: "PNGとして壊れています",
  jpeg_bad_magic: "JPEGとして壊れています",
  webp_bad_magic: "WebPとして壊れています",
  pdf_bad_magic: "PDFとして壊れています",
  pdf_active_content: "スクリプト等を含むPDFは保存できません",
  csv_invalid_utf8: "UTF-8で読めないCSVです",
  csv_nul_byte: "読めない文字が含まれています",
  hash_mismatch: "転送中に内容が変わりました",
  png_crc_mismatch: "画像データが壊れています",
  png_truncated: "画像データが壊れています",
  jpeg_truncated: "画像データが壊れています",
  unsupported_content_type: "対応していない形式です",
};

export function AttachmentUploader({
  target,
  onReady,
  onChange,
}: {
  /** 実体のある対象は {type, id}。まだ無い親は {type} のみ（予約を作って親の作成に渡す） */
  target: { type: AttachmentTargetType; id?: string };
  /** 全ての処理が終わったときに、readyになった添付と（親が無い場合の）予約IDを渡す */
  onReady?: (ids: string[], draftId?: string) => void;
  /** 状態の変化を親フォームへ知らせる（保存ボタンの抑止など） */
  onChange?: (busy: boolean) => void;
}) {
  const [items, setItems] = useState<Item[]>([]);
  const [error, setError] = useState<string | null>(null);
  const draftIdRef = useRef<string | undefined>(undefined);
  const itemsRef = useRef<Item[]>([]);
  itemsRef.current = items;
  const inputRef = useRef<HTMLInputElement>(null);

  const update = useCallback((key: string, patch: Partial<Item>) => {
    setItems((prev) => prev.map((it) => (it.key === key ? { ...it, ...patch } : it)));
  }, []);

  // readyの集合が変わったら親へ知らせる
  useEffect(() => {
    const readyIds = items.filter((i) => i.state === "ready" && i.attachmentId).map((i) => i.attachmentId!);
    onReady?.(readyIds, draftIdRef.current);
    const busy = items.some((i) => i.state === "waiting" || i.state === "uploading" || i.state === "checking");
    onChange?.(busy);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [items]);

  const runOne = useCallback(async (item: Item, file: File) => {
    try {
      // 1) 予約（親が無いときだけ。親がある対象へは直接intentを作る）
      let draftId = draftIdRef.current;
      if (!target.id && !draftId) {
        const draft = await api("API-98", { body: { intendedEntityType: target.type } });
        draftId = draft.id;
        draftIdRef.current = draft.id;
      }
      // 2) intent（形式・容量はここで案内できる）
      const intent = await api("API-26", {
        body: {
          target: target.id ? { type: target.type, id: target.id } : { type: "attachment_draft", id: draftId! },
          contentType: file.type || "application/octet-stream",
          byteSize: file.size,
        },
      });
      if (!intent.uploadToken) throw new ApiError(0, "RESPONSE_UNKNOWN");
      update(item.key, { state: "uploading", attachmentId: intent.id });
      // 3) 転送（バイナリ。失敗したら同じtokenで再試行できる）
      let lastError: unknown = null;
      for (let attemptNo = 0; attemptNo < 2; attemptNo++) {
        try {
          const up = await fetch(`/api/v1/attachments/${intent.id}/upload`, {
            method: "PUT",
            credentials: "same-origin",
            headers: { "content-type": file.type || "application/octet-stream", "x-upload-token": intent.uploadToken },
            body: file,
          });
          if (!up.ok) {
            const body = (await up.json().catch(() => ({}))) as { error?: { details?: { reason: string }[] } };
            const reason = body.error?.details?.[0]?.reason;
            if (up.status === 422) throw new Error(reason === "upload_window_expired" ? "expired" : "closed");
            if (up.status === 400 && reason === "actual_size_over_limit") throw new Error("toobig");
            throw new Error("upload_failed");
          }
          const attempt = (await up.json()) as { data: { id: string; sha256: string } };
          // 4) 完了確定（検査jobの受付。202=処理中）。応答のjobIDで検査の進行を見る
          const done = await api("API-84", {
            params: { id: intent.id },
            body: { version: 1, uploadAttemptId: attempt.data.id, sha256: attempt.data.sha256 },
          });
          rememberJobId(intent.id, done.job.id);
          lastError = null;
          break;
        } catch (e) {
          lastError = e;
          if (e instanceof Error && ["expired", "closed", "toobig"].includes(e.message)) break;
          // 通信断は一度だけ同じtokenでやり直す（docs/03: 同じ内容は同じ鍵で二重にならない）
        }
      }
      if (lastError) throw lastError;
      // 5) 検査待ち。job（API-86）の結果だけを見る。取得（API-27）は業務にリンクした後で、
      //    そのたびにACLを再検査する仕組みのため、未リンクのreadyはここでは取得できない（docs/07 §3.6）
      update(item.key, { state: "checking", attachmentId: intent.id });
      for (let i = 0; i < 40; i++) {
        await new Promise((r) => setTimeout(r, 1500));
        const job = await api("API-86", { params: { id: await jobIdOf(intent.id) } }).catch(() => null);
        if (!job) continue;
        if (job.status === "succeeded") {
          if (job.resultRef?.startsWith("rejected:")) {
            const reason = job.resultRef.slice("rejected:".length);
            update(item.key, { state: "rejected", detail: REJECT_REASONS[reason] ?? "この形式は保存できません" });
          } else {
            update(item.key, { state: "ready", attachmentId: intent.id });
          }
          return;
        }
        if (job.status === "manual_review" || job.status === "stale") {
          update(item.key, { state: "rejected", detail: "検査を完了できませんでした" });
          return;
        }
        // queued / running / retry_wait は継続
      }
      update(item.key, { state: "error", detail: "検査の結果を確認できませんでした" });
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) {
        update(item.key, { state: "error", detail: "ログインが切れました。再度ログインしてください" });
        return;
      }
      const msg = e instanceof Error && e.message === "expired" ? "保存の期限が過ぎました。もう一度追加してください"
        : e instanceof Error && e.message === "toobig" ? "サイズの上限（写真10MB・ファイル20MB）を超えています"
        : e instanceof ApiError && e.status === 400 ? "この形式は保存できません"
        : "転送できませんでした。通信を確認して再試行してください";
      update(item.key, { state: "error", detail: msg });
    }
  }, [target.id, target.type, update]);

  const startUpload = useCallback((files: FileList | null) => {
    setError(null);
    if (!files || files.length === 0) return;
    for (const file of Array.from(files)) {
      const key = `${file.name}:${file.size}:${randomUuid()}`;
      const item: Item = { key, name: file.name, size: file.size, state: "waiting" };
      setItems((prev) => [...prev, item]);
      void runOne(item, file);
    }
  }, [runOne]);

  const retry = useCallback((item: Item) => {
    // 元のFileは保持しない（端末の写真メタデータの取り扱いはD14）。取り直しを案内する
    update(item.key, { state: "error", detail: "端末からもう一度ファイルを選んでください" });
    inputRef.current?.click();
  }, [update]);

  const remove = useCallback((item: Item) => {
    setItems((prev) => {
      const next = prev.filter((i) => i.key !== item.key);
      return next;
    });
    // ready済みの削除は親画面の保存（unlink/削除）で行う。未readyの取り消しは表示から外すだけ
    if (item.blobUrl) URL.revokeObjectURL(item.blobUrl);
  }, []);

  const busy = items.some((i) => i.state === "waiting" || i.state === "uploading" || i.state === "checking");

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center gap-3">
        <Button
          variant="secondary"
          busy={busy}
          onClick={() => inputRef.current?.click()}
          className="max-lg:min-h-11 flex-none px-4"
          aria-label="写真を追加"
        >
          <Icon name="add_a_photo" className="text-[19px]" />
          写真を追加
        </Button>
        <span className="min-w-0 flex-1 text-[12px] leading-[1.6] text-ink-muted">JPEG・PNG・WebP・PDF・CSV（写真は10MBまで）</span>
        <input
          ref={inputRef}
          type="file"
          accept="image/jpeg,image/png,image/webp,application/pdf,text/csv"
          multiple
          className="sr-only"
          onChange={(e) => {
            startUpload(e.target.files);
            e.target.value = "";
          }}
        />
      </div>
      {error && <Banner tone="error" eyebrow="ERROR" title="追加できません">{error}</Banner>}
      {items.length > 0 && (
        <ul className="flex flex-col gap-2">
          {items.map((it) => (
            <li key={it.key} className="hairline flex items-center gap-3 rounded-card bg-white/[.04] p-2.5">
              {it.state === "ready" && it.blobUrl ? (
                <img src={it.blobUrl} alt="" className="size-14 flex-none rounded-[12px] object-cover" />
              ) : (
                <span aria-hidden="true" className="grid size-14 flex-none place-items-center rounded-[12px] bg-white/[.06]">
                  <Icon name={it.state === "checking" ? "fact_check" : it.state === "uploading" ? "cloud_upload" : "image"} className="text-[22px] text-ink-dim" />
                </span>
              )}
              <div className="min-w-0 flex-1">
                <p className="truncate text-[13px] font-bold">{it.name}</p>
                <p className="text-[12px] text-ink-muted" aria-live={it.state === "checking" || it.state === "uploading" ? "polite" : undefined}>
                  {it.state === "waiting" && "待機中"}
                  {it.state === "uploading" && "転送中…"}
                  {it.state === "checking" && "検査中…"}
                  {it.state === "ready" && "準備完了"}
                  {it.state === "rejected" && `保存できません（${it.detail ?? "検査で拒否されました"}）`}
                  {it.state === "expired" && "期限切れ。もう一度追加してください"}
                  {it.state === "error" && (it.detail ?? "失敗しました")}
                </p>
              </div>
              {(it.state === "error" || it.state === "expired") && (
                <button type="button" onClick={() => retry(it)} className="min-h-11 rounded-pill bg-white/[.08] px-3 text-[13px] font-bold max-lg:min-h-11">
                  再試行
                </button>
              )}
              {it.state !== "uploading" && it.state !== "checking" && (
                <button type="button" onClick={() => remove(it)} aria-label={`${it.name}を外す`} className="grid size-11 place-items-center rounded-full bg-white/[.06]">
                  <Icon name="close" className="text-[18px]" />
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** API-84の応答から受け取ったjobIDを使ってAPI-86で検査の進行を見る */
const jobIds = new Map<string, string>();
export function rememberJobId(attachmentId: string, jobId: string): void {
  jobIds.set(attachmentId, jobId);
}
async function jobIdOf(attachmentId: string): Promise<string> {
  const known = jobIds.get(attachmentId);
  if (known) return known;
  // API-84の応答から取りそこねた場合の保険（jobIDは応答にある。通常ここには来ない）
  throw new ApiError(0, "RESPONSE_UNKNOWN");
}

/** 検査済みの添付を表示する（docs/07 §3.6: 画像表示も検査済実体のみ） */
export function AttachmentViewer({ id, label }: { id: string; label?: string }) {
  const [url, setUrl] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let revoke: string | null = null;
    void (async () => {
      try {
        const response = await fetch(`/api/v1/attachments/${id}/content`, { credentials: "same-origin" });
        if (!response.ok) { setFailed(true); return; }
        const blob = await response.blob();
        revoke = URL.createObjectURL(blob);
        setUrl(revoke);
      } catch {
        setFailed(true);
      }
    })();
    return () => {
      if (revoke) URL.revokeObjectURL(revoke);
    };
  }, [id]);
  if (failed) {
    return (
      <div className="hairline grid size-20 place-items-center rounded-[12px] bg-white/[.06]">
        <Icon name="broken_image" className="text-[22px] text-ink-dim" />
      </div>
    );
  }
  if (!url) return <div aria-label={label ?? "写真を読み込み中"} className="size-20 animate-pulse rounded-[12px] bg-white/[.06]" />;
  return <img src={url} alt={label ?? "添付写真"} className="size-20 rounded-[12px] object-cover" />;
}

export type { Attachment };
