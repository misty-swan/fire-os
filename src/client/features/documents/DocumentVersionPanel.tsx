import { useCallback, useEffect, useState } from "react";
import type { z } from "zod";
import { api } from "../../api";
import { ConfirmDialog } from "../../components/Overlay";
import { MutationStatus } from "../../components/MutationStatus";
import { Banner, Button, Card, Chip, Notice, TextArea, TextField } from "../../components/ui";
import type { Job } from "../../../shared/contracts/common";
import type { DocumentDetail, DocumentVersionDto } from "../../../shared/contracts/content";
import { useMutation } from "../../useMutation";
import { fmtInstant } from "../activities/time";
import { AttachmentUploader } from "../attachments/AttachmentUploader";
import { useMemberNames } from "../notifications/names";

/** API-91応答の型（contractsにはtype aliasが無いためz.inferで受ける） */
export type DocumentDetailData = z.infer<typeof DocumentDetail>;

/**
 * 文書の版パネル（T069、SCR-24。docs/03 §2 SCR-24「許諾原本の登録/版/承認/撤回/ACL/閲覧」、
 * docs/11 報告書/文書版「承認版とdraftの別pointer」）。
 *
 * - 版の一覧（API-91。revision昇順）: 第N版・状態ピル・**有効な承認版／最新の下書きの別pointer**・
 *   許諾根拠（licenseRef。無い版は作れない＝docs/05 API-74）・原本のhash（content_hash）・承認者と日時・
 *   原本（API-27。取得のたびにACLを再検査する）へのリンクを出す。
 * - 抽出状態・索引状態は、この画面で版を作成（API-74の応答job）・承認（API-75の応答job）したときの
 *   job（API-86。依頼者本人だけが照会できる）を2.5秒ごとに読み直して出す。語彙は処理中／抽出済み／
 *   抽出不能（error_codeの日本語）／索引 待ち（pending）／索引済み（indexed）／反映できませんでした。
 *   画面を開き直したあとは依頼jobが引けないため「—」と出す（偽装しない。docs/03 §1.1-18）。
 * - 版の作成（API-74。202=受付で完了ではない）: 原本は検査済み（ready）の添付1つ＋許諾根拠（必須）。
 * - 申請（request_review）は定型理由で1クリック（docs/03 §1.1-16⑦の報告書と同じ流儀）。
 *   承認（approve）は確認ダイアログで対象版を明示してから（理由必須）、差戻し（changes_requested）は
 *   理由必須の確認ダイアログ。最終決定は一版一回（二重approveは409。T063）。
 * - 管理操作（版の作成・申請・承認・差戻し）の操作枠は幹部・管理者（canManage）に出す。担当scopeの
 *   保持者は画面からは判定できないためサーバーが毎要求判定する（お知らせT046と同じ注記）。
 */

/** 文書rootの状態（docs/11 documentStates。withdrawnは終端で詳細が404のため画面に出る機会は無いが語彙は網羅する） */
export const DOCUMENT_STATUS: Record<DocumentDetailData["document"]["status"], { label: string; tone: "neutral" | "ok" | "alert" }> = {
  draft: { label: "下書き", tone: "neutral" },
  approved: { label: "承認済み", tone: "ok" },
  withdrawn: { label: "撤回済み", tone: "alert" },
};

/** 版の状態（docs/11 contentVersionStates。superseded=旧承認版は承認列を保持したまま失効する） */
export const VERSION_STATUS: Record<DocumentVersionDto["status"], { label: string; tone: "neutral" | "ok" | "attention" | "alert" }> = {
  draft: { label: "下書き", tone: "neutral" },
  in_review: { label: "審査中", tone: "attention" },
  approved: { label: "承認済み", tone: "ok" },
  changes_requested: { label: "差戻し", tone: "alert" },
  superseded: { label: "旧版", tone: "neutral" },
  withdrawn: { label: "撤回済み", tone: "alert" },
};

/** 抽出・索引jobのerror_codeの日本語（T064/T066の実装語彙。未知コードは生の値を出す） */
const JOB_ERROR_LABELS: Record<string, string> = {
  document_ocr_required: "画像だけのPDFのため抽出できません（文字の読み取りは未対応です）",
  unextractable_document: "対応していない作りのPDFのため抽出できません",
  pdf_encrypted: "暗号化されたPDFのため抽出できません",
  hash_mismatch: "原本の内容が版の記録と一致しないため中止しました",
  attachment_not_ready: "原本の添付が検査済みでないため中止しました",
  attachment_unavailable: "原本の添付を参照できず中止しました",
  chunk_limit_exceeded: "分量が大きすぎるため抽出を保留しました",
  storage_unavailable: "保存先に接続できません（自動で再試行します）",
  chunks_pending: "抽出がまだのため索引化を待っています（自動で再試行します）",
  document_withdrawn: "文書が撤回されたため実行しませんでした",
  document_version_not_indexable: "有効な承認版でないため索引化しませんでした",
  source_changed: "版の記録が変わったため実行しませんでした",
};

const jobErrorLabel = (code: string | null) => (code ? (JOB_ERROR_LABELS[code] ?? code) : "理由の分からない失敗です");

/**
 * 版idごとに依頼したjobのid（抽出=API-74応答／索引=API-75 approve応答）。
 * jobの照会（API-86）は依頼した本人だけができるため、この画面で操作したときだけ追跡できる。
 * module直置きは詳細の再読込（パネルの再マウント）でも消さないための覚え書きで、ページの再読込で消える
 * （AttachmentUploader.jobIds・useMutation.pendingKeysと同じ流儀。docs/03 §1.1-18）。
 */
const trackedJobs = new Map<string, { extract?: string; index?: string }>();
const trackJob = (versionId: string, kind: "extract" | "index", jobId: string): void => {
  const t = trackedJobs.get(versionId) ?? {};
  t[kind] = jobId;
  trackedJobs.set(versionId, t);
};

/** job（API-86。依頼者本人だけが照会できる）の進行。完了したら停止する */
function useJobProgress(jobById: Record<string, Job>, setJob: (id: string, job: Job) => void) {
  const pendingIds = Object.values(jobById)
    .filter((j) => j.status === "queued" || j.status === "running" || j.status === "retry_wait")
    .map((j) => j.id)
    .sort();
  const key = pendingIds.join(",");
  useEffect(() => {
    const ids = key ? key.split(",") : [];
    if (ids.length === 0) return;
    const timer = setInterval(() => {
      void (async () => {
        for (const id of ids) {
          const job = await api("API-86", { params: { id } }).catch(() => null);
          if (job) setJob(id, job);
        }
      })();
    }, 2500);
    return () => clearInterval(timer);
  }, [key, setJob]);
}

/** result_ref `ready:<chunk数>:<頁数>`（T064。CSV解析jobの流儀）を読みやすい形にする */
const extractResult = (resultRef: string | null): string | null => {
  const m = /^ready:(\d+):(\d+)$/.exec(resultRef ?? "");
  return m ? `抽出済み（${m[1]}片・${m[2]}頁）` : null;
};

export function DocumentVersionPanel({ detail, canManage, onChanged }: { detail: DocumentDetailData; canManage: boolean; onChanged: () => void }) {
  const names = useMemberNames();
  const doc = detail.document;
  const createVersion = useMutation("API-74");
  const decision = useMutation("API-75");

  // 依頼したjob（API-86）の現状。追跡できるjobは版ごとの覚え書き（trackedJobs）から取り直す
  const [jobById, setJobById] = useState<Record<string, Job>>({});
  const setJob = useCallback((id: string, job: Job) => setJobById((prev) => ({ ...prev, [id]: job })), []);
  useEffect(() => {
    let alive = true;
    void (async () => {
      for (const v of detail.versions) {
        const t = trackedJobs.get(v.id);
        if (!t) continue;
        for (const jobId of [t.extract, t.index]) {
          if (!jobId) continue;
          const job = await api("API-86", { params: { id: jobId } }).catch(() => null);
          if (alive && job) setJob(jobId, job);
        }
      }
    })();
    return () => {
      alive = false;
    };
  }, [detail.versions, setJob]);
  useJobProgress(jobById, setJob);

  // 版の作成フォーム（原本1つ＋許諾根拠）
  const [uploadEpoch, setUploadEpoch] = useState(0);
  const [attachmentId, setAttachmentId] = useState<string | undefined>(undefined);
  const [licenseRef, setLicenseRef] = useState("");

  // 承認・差戻しの確認ダイアログ
  const [approveTarget, setApproveTarget] = useState<DocumentVersionDto | null>(null);
  const [approveReason, setApproveReason] = useState("");
  const [rejectTarget, setRejectTarget] = useState<DocumentVersionDto | null>(null);
  const [rejectReason, setRejectReason] = useState("");

  const submitVersion = async () => {
    if (!attachmentId || !licenseRef.trim() || createVersion.saving) return;
    const r = await createVersion.run({
      params: { id: doc.id },
      body: { version: doc.version, attachmentId, licenseRef: licenseRef.trim() },
    });
    if (r) {
      // 202=受付で完了ではない（docs/05 §1）。応答の抽出jobを追跡し、版の一覧を取り直す
      trackJob(r.data.version.id, "extract", r.data.job.id);
      setJob(r.data.job.id, r.data.job);
      setLicenseRef("");
      setAttachmentId(undefined);
      setUploadEpoch((e) => e + 1);
      onChanged();
    }
  };

  const submitReview = async (v: DocumentVersionDto) => {
    // 申請（draft→in_review）は決定行を作らない（docs/11の核心。T063）。定型理由で1クリック
    const r = await decision.run({
      params: { id: doc.id },
      body: { version: doc.version, documentVersion: v.revisionNo, decision: "request_review", reason: "内容を確認しました。承認の審査をお願いします。" },
    });
    if (r) onChanged();
  };

  const submitApprove = async () => {
    if (!approveTarget || !approveReason.trim()) return;
    const r = await decision.run({
      params: { id: doc.id },
      body: { version: doc.version, documentVersion: approveTarget.revisionNo, decision: "approve", reason: approveReason.trim() },
    });
    if (r) {
      if (r.data.indexJobId) {
        trackJob(r.data.versionId, "index", r.data.indexJobId);
      }
      setApproveTarget(null);
      setApproveReason("");
      onChanged();
    }
  };

  const submitReject = async () => {
    if (!rejectTarget || !rejectReason.trim()) return;
    const r = await decision.run({
      params: { id: doc.id },
      body: { version: doc.version, documentVersion: rejectTarget.revisionNo, decision: "changes_requested", reason: rejectReason.trim() },
    });
    if (r) {
      setRejectTarget(null);
      setRejectReason("");
      onChanged();
    }
  };

  const nameOf = (id: string | null) => (id ? (names?.get(id) ?? null) : null);

  return (
    <section className="flex flex-col gap-2" aria-label="版">
      <h3 className="text-[14px] font-bold">版</h3>
      <p className="text-[12px] text-ink-muted">
        版は常に新しい下書きとして作ります（旧版の原本・許諾・hashは変わりません）。承認すると有効な承認版が切り替わり、検索の対象になります。
      </p>

      {detail.versions.length === 0 && (
        <Banner tone="info" eyebrow="EMPTY" title="まだ版がありません">
          {canManage ? "原本を添付して最初の版を作成してください。" : "幹部が原本を登録すると、ここに現れます。"}
        </Banner>
      )}

      <ul className="flex flex-col gap-2">
        {detail.versions.map((v) => {
          const status = VERSION_STATUS[v.status];
          const isApprovedPointer = doc.currentVersionId === v.id;
          const isDraftPointer = doc.currentDraftVersionId === v.id;
          // 抽出・索引の状態（追跡できるときだけ。docs/03 §1.1-18）
          const t = trackedJobs.get(v.id);
          const extractJob = t?.extract ? jobById[t.extract] : undefined;
          const indexJob = t?.index ? jobById[t.index] : undefined;
          let extractLabel: string;
          if (!extractJob) extractLabel = "—";
          else if (extractJob.status === "succeeded") extractLabel = extractResult(extractJob.resultRef) ?? "抽出済み";
          else if (extractJob.status === "manual_review" || extractJob.status === "stale") extractLabel = `抽出不能（${jobErrorLabel(extractJob.errorCode)}）`;
          else if (extractJob.status === "cancelled") extractLabel = "中止しました";
          else extractLabel = "処理中";
          let indexLabel: string;
          if (!indexJob) indexLabel = "—";
          else if (indexJob.status === "succeeded") indexLabel = "索引済み（indexed）";
          else if (indexJob.status === "manual_review" || indexJob.status === "stale") indexLabel = `索引に反映できませんでした（${jobErrorLabel(indexJob.errorCode)}）`;
          else if (indexJob.status === "cancelled") indexLabel = "中止しました";
          else indexLabel = "索引 待ち（pending）";

          return (
            <li key={v.id}>
              <Card className="flex flex-col gap-2.5">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-mono text-[12px] font-bold">第{v.revisionNo}版</span>
                  <Chip tone={status.tone}>{status.label}</Chip>
                  {isApprovedPointer && <Chip tone="ok" icon="verified">有効な承認版</Chip>}
                  {isDraftPointer && !isApprovedPointer && <Chip tone="neutral" icon="edit_note">最新の下書き</Chip>}
                  {v.approvedAt && (
                    <span className="font-mono text-[11px] text-ink-muted">
                      {nameOf(v.approvedBy) ?? "読み込み中…"} · {fmtInstant(v.approvedAt)} に承認
                    </span>
                  )}
                </div>
                <dl className="flex flex-col gap-1.5 text-[13px]">
                  <div className="flex gap-2">
                    <dt className="flex-none text-ink-muted">許諾根拠</dt>
                    <dd className="min-w-0 break-all font-medium">{v.licenseRef}</dd>
                  </div>
                  <div className="flex gap-2">
                    <dt className="flex-none text-ink-muted">原本のhash</dt>
                    <dd className="min-w-0 break-all font-mono text-[12px]" title={v.contentHash}>
                      {v.contentHash.slice(0, 16)}…
                    </dd>
                  </div>
                  <div className="flex gap-2">
                    <dt className="flex-none text-ink-muted">抽出状態</dt>
                    <dd className="min-w-0 font-medium">{extractLabel}</dd>
                  </div>
                  <div className="flex gap-2">
                    <dt className="flex-none text-ink-muted">索引</dt>
                    <dd className="min-w-0 font-medium">{indexLabel}</dd>
                  </div>
                </dl>
                <div className="flex flex-wrap items-center gap-2">
                  <a
                    href={`/api/v1/attachments/${v.attachmentId}/content`}
                    className="inline-flex min-h-11 items-center gap-1.5 self-start rounded-pill bg-white/[.08] px-4 text-[13px] font-bold text-ink hover:bg-white/[.12]"
                  >
                    原本を開く
                  </a>
                  {canManage && v.status === "draft" && isDraftPointer && (
                    <Button
                      variant="secondary"
                      busy={decision.saving}
                      className="!h-[46px] !w-auto px-4 !text-[13px] max-lg:min-h-11"
                      onClick={() => void submitReview(v)}
                    >
                      承認を申請する
                    </Button>
                  )}
                  {canManage && v.status === "in_review" && (
                    <>
                      <Button
                        busy={decision.saving}
                        className="!h-[46px] !w-auto px-4 !text-[13px] max-lg:min-h-11"
                        onClick={() => {
                          setApproveReason("");
                          setApproveTarget(v);
                        }}
                      >
                        承認する
                      </Button>
                      <Button
                        variant="secondary"
                        className="!h-[46px] !w-auto px-4 !text-[13px] max-lg:min-h-11"
                        onClick={() => {
                          setRejectReason("");
                          setRejectTarget(v);
                        }}
                      >
                        差戻す
                      </Button>
                    </>
                  )}
                </div>
              </Card>
            </li>
          );
        })}
      </ul>

      {/* 版の作成（PER-11＋幹部・管理者。原本はreadyの添付1つ＋許諾根拠必須。docs/05 API-74） */}
      {canManage && (
        <Card className="flex flex-col gap-3">
          <h4 className="text-[14px] font-bold">新しい版を作成</h4>
          <AttachmentUploader key={uploadEpoch} target={{ type: "document", id: doc.id }} onReady={(ids) => setAttachmentId(ids[0])} />
          <p className="text-[12px] text-ink-muted">
            1つの版に付けられる原本は1つです（複数追加したときは先頭の原本を使います）。検査の済んだ原本だけで版を作れます。
          </p>
          <TextField
            name="licenseRef"
            label="許諾の出典（必須）"
            value={licenseRef}
            onChange={(e) => setLicenseRef(e.target.value)}
            placeholder="例: 宮之浦分団 検証用許諾（架空）"
            hint="原本の利用許諾の出典（誰の何という許諾か）を短い語で書きます。無い版は作れません。"
          />
          <Button
            busy={createVersion.saving}
            disabled={!attachmentId || !licenseRef.trim()}
            onClick={() => void submitVersion()}
          >
            {createVersion.state.kind === "processing" ? "処理中（完了ではありません）" : "版を作成する"}
          </Button>
          <p className="text-[12px] text-ink-muted">
            版の作成は受け付け（処理中）で完了ではなく、原本の文字の抽出はそのあと行われます。抽出の進行は上の版の一覧に反映されます。
          </p>
        </Card>
      )}

      <Notice tone="info" icon="visibility">
        抽出・索引の進行状況は、この画面で版を作成・承認したあとに追跡できる範囲で表示されます（jobの照会は依頼した本人だけができます）。画面を開き直したあとは「—」で、最新の進行状況は表示できません。
      </Notice>

      <MutationStatus state={createVersion.state} toastBottom={100} />
      <MutationStatus state={decision.state} toastBottom={100} />

      {/* 承認（最終決定は一版一回。確認ダイアログで対象版を明示してから。docs/03 §1.1-16⑦と同じ流儀） */}
      {approveTarget && (
        <ConfirmDialog
          title="この版を承認しますか"
          confirmLabel="承認する"
          busy={decision.saving}
          confirmDisabled={!approveReason.trim()}
          onConfirm={() => void submitApprove()}
          onCancel={() => {
            setApproveTarget(null);
            setApproveReason("");
          }}
        >
          <p>第{approveTarget.revisionNo}版を有効な承認版として切り替えます。承認後はこの版の記録はもう変わりません（旧承認版は旧版になります）。</p>
          <div className="hairline rounded-card bg-white/[.04] p-3 text-[13px]">
            <p>対象版 第{approveTarget.revisionNo}版</p>
            <p className="break-all">許諾根拠 {approveTarget.licenseRef}</p>
            <p className="break-all font-mono text-[12px]">原本のhash {approveTarget.contentHash.slice(0, 16)}…</p>
          </div>
          <TextArea
            name="approve-reason"
            label="承認の理由（必須）"
            value={approveReason}
            onChange={(e) => setApproveReason(e.target.value)}
          />
          {!approveReason.trim() && <p className="text-[12px] font-medium text-attention">理由を入力してください</p>}
        </ConfirmDialog>
      )}

      {/* 差戻し（in_review→changes_requested。終端のため訂正は新しい版で行う。docs/11） */}
      {rejectTarget && (
        <ConfirmDialog
          title="この版を差戻しますか"
          confirmLabel="差戻す"
          busy={decision.saving}
          danger
          confirmDisabled={!rejectReason.trim()}
          onConfirm={() => void submitReject()}
          onCancel={() => {
            setRejectTarget(null);
            setRejectReason("");
          }}
        >
          <p>第{rejectTarget.revisionNo}版を差戻します。差戻しは終端のため、訂正は新しい版を作って行います（この版はもう承認できません）。</p>
          <TextArea
            name="reject-reason"
            label="差戻しの理由（必須）"
            value={rejectReason}
            onChange={(e) => setRejectReason(e.target.value)}
          />
          {!rejectReason.trim() && <p className="text-[12px] font-medium text-attention">理由を入力してください</p>}
        </ConfirmDialog>
      )}
    </section>
  );
}
