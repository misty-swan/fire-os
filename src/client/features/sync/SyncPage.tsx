import { useCallback, useEffect, useMemo, useState } from "react";
import { expireDueDrafts, DRAFT_RETENTION_NOTICE, draftExpiryLabel } from "../../offline/lifecycle";
import { runSyncPass, draftStatusLabel, draftSummaryLine, syncEvents, type SyncSummary } from "../../offline/sync-runner";
import { OPERATION_LABELS } from "../../offline/capture";
import { getDraftStore, IndexedDbDraftStore } from "../../offline/store";
import { DraftStoreError, type DraftScope, type LocalDraft } from "../../offline/types";
import { useOnline } from "../../components/AppShell";
import { ConfirmDialog } from "../../components/Overlay";
import { PageTitle } from "../../components/Page";
import { Banner, Button, Card, Chip, Notice } from "../../components/ui";
import { useMe } from "../../me";
import { ConflictPanel } from "./ConflictPanel";

/**
 * 同期の状況（T077、SCR-27 /app/sync。docs/03「端末下書き/未同期/応答不明/拒否/競合、手動再送/削除」）。
 *
 * prototypeに専用画面が無いため共通部品で構成（文書SCR-24・巡回計画SCR-25と同じ扱い。docs/03 §1.1-22）。
 * - 一覧は**この端末・この利用者**の下書きだけ（store.listがscopeで絞る。他者の下書きは復元しない＝SCR-27の制約）。
 * - 読む前に必ず期限切れを掃除する（T075レビューからの持ち越し事項: listは内部で期限切れを消さない）。
 * - 状態の語彙は同期操作（docs/11）と同じ: 未同期／送信中／応答不明／競合／拒否。「反映済み」の行は端末に
 *   残さないため一覧には現れず、反映は直前の同期のまとめ（applied＝サーバー確認済み）だけで伝える。
 * - 手動再送・削除は確認のうえ実行し、保留理由（memo.reason）を必ず添えて出す（黙って止めない）。
 * - 保存完了の表示はしない（appliedの行は削除済み。docs/16 T077「applied前に保存完了表示をしない」）。
 */

const STATUS_TONE: Record<string, "attention" | "ok" | "neutral" | "alert"> = {
  未同期: "attention",
  送信中: "neutral",
  応答不明: "attention",
  競合: "alert",
  拒否: "alert",
};

export function SyncPage() {
  const { me } = useMe();
  const online = useOnline();
  const store = getDraftStore();
  // scopeは認証済みme（API-01）から組み立てる（T075レビューからの持ち越し事項。単Idで絞る＝他者の行は絶対に読めない）
  const scope = useMemo<DraftScope>(
    () => ({ userId: me.profile.memberId, unitId: me.unitName, deviceId: IndexedDbDraftStore.deviceIdOf() }),
    [me.profile.memberId, me.unitName],
  );
  const [rows, setRows] = useState<LocalDraft[] | null>(null);
  const [storeError, setStoreError] = useState<string | null>(null);
  const [running, setRunning] = useState(false);
  const [summary, setSummary] = useState<SyncSummary | null>(null);
  const [deleting, setDeleting] = useState<LocalDraft | null>(null);
  const [busyDelete, setBusyDelete] = useState(false);

  const refresh = useCallback(async () => {
    try {
      // 一覧の前にも期限切れを掃除する（T075レビューからの持ち越し事項。listは内部で消さない）
      await expireDueDrafts(new Date().toISOString(), store);
      setRows(await store.list(scope));
      setStoreError(null);
    } catch (e) {
      setRows([]);
      setStoreError(e instanceof DraftStoreError ? e.message : "端末の保存を読み書きできませんでした");
    }
  }, [scope, store]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // 自動同期（MeGateが起動）の開始・終了を追いかけて、一覧とまとめを更新する
  useEffect(() => {
    const onStart = () => setRunning(true);
    const onDone = (e: Event) => {
      setRunning(false);
      const detail = (e as CustomEvent<SyncSummary>).detail;
      if (detail) setSummary(detail);
      void refresh();
    };
    syncEvents.addEventListener("start", onStart);
    syncEvents.addEventListener("done", onDone);
    return () => {
      syncEvents.removeEventListener("start", onStart);
      syncEvents.removeEventListener("done", onDone);
    };
  }, [refresh]);

  const syncNow = async () => {
    try {
      const s = await runSyncPass(scope);
      setSummary(s);
    } catch {
      // パス内部で失敗は分類済み（syncEvents経由で一覧は更新される）。ここでは何も成功扱いにしない
    }
  };

  const removeDraft = async () => {
    if (!deleting) return;
    setBusyDelete(true);
    try {
      await store.remove(deleting.clientOperationId);
      setDeleting(null);
      await refresh();
    } catch {
      await refresh(); // 消せないときも一覧を実態に合わせる（消えたふりはしない）
    } finally {
      setBusyDelete(false);
    }
  };

  /** 拒否された下書きの明示的な再送（人の操作。自動では送らない。結果はまた正直に分類される） */
  const retryRejected = async (draft: LocalDraft) => {
    try {
      await store.put({ ...draft, status: "pending", memo: { ...draft.memo, reason: undefined } });
    } catch (e) {
      // 端末に書けないときも「送信待ちに替えた」ふりをしない（removeDraft「消せないときも一覧を実態に合わせる」と同じ）。
      // 下書きは拒否のまま残り、失敗はrole=alertのstoreErrorで出す
      setStoreError(e instanceof DraftStoreError ? e.message : "端末の下書きを書き換えられませんでした");
      return;
    }
    void syncNow();
  };

  const unsyncedCount = rows?.length ?? 0;
  const now = new Date().toISOString();

  return (
    <div className="flex max-w-[720px] flex-col gap-4">
      <PageTitle eyebrow="2026 · SYNC" className="lg:[&_h2]:hidden">
        同期の状況
      </PageTitle>

      {!online && (
        <Notice tone="warning" icon="cloud_off" role="status">
          オフラインです。入力は端末に残り、通信が回復すると自動で送ります。
        </Notice>
      )}

      <Card className="flex flex-col gap-3 p-4">
        <div className="flex flex-wrap items-center gap-3">
          {/* 未同期の件数（この端末・この利用者の分だけ。SCR-27の一覧の主語） */}
          <p className="text-[16px] font-bold" role="status">
            未同期 {unsyncedCount}件
            <span className="ml-2 text-[12px] font-medium text-ink-muted">（この端末のあなたの下書きだけを扱います）</span>
          </p>
          <Button busy={running} onClick={() => void syncNow()} className="max-lg:min-h-11 ml-auto flex-none px-5">
            今すぐ同期
          </Button>
        </div>
        <p className="text-[12px] leading-[1.7] text-ink-muted">
          通信が回復したとき、アプリを開いたときに自動で送ります（60秒以内に始まります）。写真は検査が済んでから、
          その点検を送ります。同期の結果はサーバーの返事だけで判定し、推測で完了と表示しません。
        </p>
        {summary && summary.total > 0 && (
          <Banner tone={summary.applied > 0 ? "info" : "warning"} eyebrow="SYNC" role="status" title={`同期が完了しました（${summary.finishedAt.slice(11, 19)}）`}>
            反映 {summary.applied}件／競合 {summary.conflict}件／拒否 {summary.rejected}件／未実施 {summary.skipped}件。
            反映はサーバーが適用を確認できたものだけを数えています。
          </Banner>
        )}
        {storeError && (
          <Banner tone="error" eyebrow="ERROR" role="alert" title="端末の下書きを読めません">
            {storeError}
          </Banner>
        )}
      </Card>

      <Notice tone="info" icon="info" role="status">
        {DRAFT_RETENTION_NOTICE}。この画面はあなたがこの端末で保存した下書きだけを表示し、他の利用者の下書きは復元しません。
      </Notice>

      {rows === null ? (
        <p role="status" className="text-[13px] text-ink-muted">読み込んでいます…</p>
      ) : rows.length === 0 ? (
        <Card className="flex flex-col gap-2 p-4">
          <p className="text-[14px] text-ink-sub">同期待ちの入力はありません。</p>
          <p className="text-[12px] leading-[1.7] text-ink-muted">
            通信断のときに保存した点検・出欠・参集は、ここに並んで送信を待ちます。
          </p>
        </Card>
      ) : (
        <ul className="flex flex-col gap-3" aria-label="同期待ちの入力">
          {rows.map((draft) => (
            <li key={draft.clientOperationId}>
              <Card className="flex flex-col gap-3 p-4">
                <div className="flex flex-wrap items-center gap-2">
                  <Chip tone={STATUS_TONE[draftStatusLabel(draft)] ?? "neutral"}>{draftStatusLabel(draft)}</Chip>
                  <span className="text-[15px] font-bold">{OPERATION_LABELS[draft.operationCode] ?? draft.operationCode}</span>
                  <span className="ml-auto font-mono text-[11px] text-ink-muted">{draft.createdAt.slice(0, 16).replace("T", " ")}</span>
                </div>
                <p className="text-[13px] text-ink-sub">{draftSummaryLine(draft)}</p>
                <p className="flex flex-wrap gap-x-4 gap-y-1 text-[12px] text-ink-muted">
                  <span>対象: {draft.targetId === "" ? "（新規）" : `${draft.targetId.slice(0, 8)}…`}</span>
                  <span>写真: {draft.attachments.length}件</span>
                  <span>期限: {draftExpiryLabel(draft.expiresAt, now)}</span>
                </p>
                {draft.memo?.reason && (
                  <p className="rounded-field bg-white/[.04] p-2.5 text-[12px] leading-[1.7] text-ink-sub" role="status">
                    保留の理由: {draft.memo.reason}
                  </p>
                )}
                <div className="flex flex-wrap gap-2">
                  {draft.status === "conflict" ? (
                    <ConflictPanel draft={draft} scope={scope} onDone={() => void refresh()} />
                  ) : (
                    <>
                      {(draft.status === "local_draft" || draft.status === "pending" || draft.status === "sending") && (
                        <Button variant="secondary" onClick={() => void syncNow()} disabled={running} className="max-lg:min-h-11">
                          もう一度送る
                        </Button>
                      )}
                      {draft.status === "rejected" && (
                        <Button variant="secondary" onClick={() => void retryRejected(draft)} disabled={running} className="max-lg:min-h-11">
                          もう一度送る
                        </Button>
                      )}
                      <Button variant="secondary" onClick={() => setDeleting(draft)} className="max-lg:min-h-11">
                        削除
                      </Button>
                    </>
                  )}
                </div>
              </Card>
            </li>
          ))}
        </ul>
      )}

      <DeleteConfirm draft={deleting} busy={busyDelete} onCancel={() => setDeleting(null)} onConfirm={() => void removeDraft()} />
    </div>
  );
}

/** 削除の確認。応答不明の操作は「サーバーに届いたか分からない」ことを削除の前に必ず伝える */
function DeleteConfirm({
  draft,
  busy,
  onCancel,
  onConfirm,
}: {
  draft: LocalDraft | null;
  busy: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  if (!draft) return null;
  const unknown = draft.memo?.responseUnknown === true;
  return (
    <ConfirmDialog title="この下書きを削除します" confirmLabel="削除する" busy={busy} danger onConfirm={onConfirm} onCancel={onCancel}>
      {unknown ? (
        <p>
          この操作はサーバーに届いたか分かっていません（応答不明）。削除してもサーバー側の結果は変わりません。
          届いていれば記録は残ります。確認してから消す場合は、先に「もう一度送る」で結果を確かめてください。
        </p>
      ) : (
        <p>端末に置いた入力を消します。サーバーの記録は変わりません。削除した入力は元に戻せません。</p>
      )}
      <p>対象: {OPERATION_LABELS[draft.operationCode] ?? draft.operationCode}／{draftSummaryLine(draft)}</p>
    </ConfirmDialog>
  );
}
