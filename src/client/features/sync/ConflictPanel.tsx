import { useCallback, useEffect, useState } from "react";
import { ApiError, api } from "../../api";
import { ConfirmDialog } from "../../components/Overlay";
import { Banner, Button, Card, Chip } from "../../components/ui";
import { draftExpiryFrom } from "../../offline/lifecycle";
import { runSyncPass } from "../../offline/sync-runner";
import { getDraftStore } from "../../offline/store";
import { randomUuid } from "../../uuid";
import { DraftStoreError, type DraftScope, type LocalDraft } from "../../offline/types";
import { useMe } from "../../me";
import { draftSummaryLine } from "../../offline/sync-runner";
import { OPERATION_LABELS } from "../../offline/capture";

/**
 * 競合の解消（T077、SCR-27「他ユーザー下書きを復元せず、旧版を自動上書きしない」）。
 *
 * サーバーが409 VERSION_CONFLICTを返した下書きを、サーバーの現値と並べて比較し、人が選んで解消する:
 *  - 「現値の版で送り直す」: サーバーの現在の版を前提に**新しいclientOperationId**の操作として作り直す
 *    （旧版の自動上書き・last-write-winsではない。人の確認があって初めて新しい操作になる。docs/16 T077）。
 *  - 「破棄」: 下書きを消す（サーバーの値は変わらない）。
 * 取得契約が無い対象（点検の単件取得）は現値を出せない旨を正直に出す（成功に見せない。docs/03 §1.1-18と同じ方針）。
 */

const RESPONSE_LABELS: Record<string, string> = { attending: "参加", undecided: "未定", absent: "不参加", unanswered: "回答を取り下げ" };
const PARTICIPANT_LABELS: Record<string, string> = { unconfirmed: "未確認", mobilizing: "参集中", arrived: "参集済", returned: "帰還記録", unavailable: "出動不可" };

interface ServerCurrent {
  line: string;
  version: number;
}

export function ConflictPanel({ draft, scope, onDone }: { draft: LocalDraft; scope: DraftScope; onDone: () => void }) {
  const { me } = useMe();
  const store = getDraftStore();
  const [current, setCurrent] = useState<ServerCurrent | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const [storeError, setStoreError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState<"resend" | "discard" | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setFailed(null);
    try {
      if (draft.operationCode === "attendance.respond") {
        const detail = await api("API-07", { params: { id: draft.targetId } });
        const row = detail.attendance.find((r) => r.memberId === me.profile.memberId);
        setCurrent(
          row
            ? { line: `出欠: ${RESPONSE_LABELS[row.response] ?? row.response}`, version: row.version }
            : { line: "あなたの出欠の記録はまだありません", version: 0 },
        );
        return;
      }
      if (draft.operationCode === "incident.participant.record") {
        const detail = await api("API-70", { params: { id: draft.targetId } });
        const row = detail.participants.find((r) => r.memberId === me.profile.memberId);
        setCurrent(
          row
            ? { line: `参集: ${PARTICIPANT_LABELS[row.attendanceStatus] ?? row.attendanceStatus}`, version: row.version }
            : { line: "あなたの参集の記録はまだありません", version: 0 },
        );
        return;
      }
      if (draft.operationCode === "facility_inspection.create") {
        // 対象の施設（作成なので競合は対象や様式の変化。施設の現行版を出す）
        const facility = await api("API-12", { params: { id: draft.targetId }, query: {} });
        setCurrent({ line: `施設: ${facility.managementNumber ?? facility.identifyingName ?? draft.targetId}`, version: facility.version });
        return;
      }
      // 点検の訂正（対象は点検の原本。単件の取得契約が無いため現値の比較はできない＝正直に注記する）
      setCurrent(null);
      setFailed("この操作の対象は画面で現値を取得できません（点検の単件取得が未提供のため）。元の記録を開いて確認してください。");
    } catch (e) {
      setCurrent(null);
      setFailed(e instanceof ApiError && e.status === 404 ? "対象が見つかりません（削除・変更された可能性があります）。" : "競合の相手の値を取得できませんでした。");
    }
  }, [draft.operationCode, draft.targetId, me.profile.memberId]);

  useEffect(() => {
    let alive = true;
    void (async () => {
      await load();
      if (!alive) return;
    })();
    return () => {
      alive = false;
    };
  }, [load]);

  /**
   * 現値の版を前提にした新しい操作を作り、同期する（旧操作の鍵は使わない＝docs/05「期限後は人が新操作を作る」と同じ整理）。
   * 端末の書き込みに失敗したときは成功と偽らない（SyncPageのremoveDraft「消せないときも一覧を実態に合わせる」と同じ方針）。
   */
  const resendAsNew = async () => {
    if (!current) return;
    setBusy(true);
    setStoreError(null);
    try {
      const now = new Date().toISOString();
      await store.put({
        ...draft,
        clientOperationId: randomUuid(),
        baseVersion: current.version,
        status: "local_draft",
        createdAt: now,
        expiresAt: draftExpiryFrom(now),
        memo: undefined,
      });
      try {
        await store.remove(draft.clientOperationId);
      } catch (e) {
        // 新しい操作は作れたが、元の記録を消せない。消えたふりをせず一覧を実態に合わせて出す
        setStoreError(
          e instanceof DraftStoreError
            ? `新しい操作は保存できましたが、元の記録を消せませんでした（${e.message}）`
            : "新しい操作は保存できましたが、元の記録を消せませんでした",
        );
        onDone();
        return;
      }
      setConfirming(null);
      onDone();
      void runSyncPass(scope).catch(() => undefined);
    } catch (e) {
      // 端末に書けない（容量不足・IndexedDB不可など）。何も変わっていないことを出す（確認dialogは実態どおり開いたまま）
      setStoreError(e instanceof DraftStoreError ? e.message : "端末に保存できませんでした。もう一度試してください");
    } finally {
      setBusy(false);
    }
  };

  const discard = async () => {
    setBusy(true);
    setStoreError(null);
    try {
      await store.remove(draft.clientOperationId);
      setConfirming(null);
      onDone();
    } catch (e) {
      // 消せないときも消えたふりをしない（SyncPageのremoveDraftと同じ）。下書きは競合のまま残り、確認dialogも実態どおり
      setStoreError(e instanceof DraftStoreError ? e.message : "端末の下書きを消せませんでした");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card className="flex flex-col gap-3" aria-label="競合の比較">
      <div className="flex items-center gap-2">
        <span className="text-[14px] font-bold">競合を解消する</span>
        <Chip tone="alert">競合</Chip>
      </div>
      <p className="text-[12px] leading-[1.7] text-ink-sub">
        サーバーの値が新しくなっています。両方を見比べて、どうするか選んでください。この画面が勝手に上書きすることはありません。
      </p>
      <div className="flex flex-col gap-1.5 rounded-field bg-white/[.04] p-3 text-[13px]">
        <div className="flex flex-wrap items-center gap-2">
          <Chip tone="neutral">この端末の入力</Chip>
          <span className="font-bold">{OPERATION_LABELS[draft.operationCode] ?? draft.operationCode}／{draftSummaryLine(draft)}</span>
          <span className="text-[11px] text-ink-muted">（第{draft.baseVersion}版を前提に作成）</span>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Chip tone="attention">現在サーバーにある値</Chip>
          {current ? (
            <>
              <span className="font-bold">{current.line}</span>
              <span className="text-[11px] text-ink-muted">（第{current.version}版）</span>
            </>
          ) : (
            <span className="text-ink-sub">{failed ?? "読み込んでいます…"}</span>
          )}
        </div>
      </div>
      {failed && current === null && (
        <Banner tone="warning" eyebrow="CONFLICT" role="status" title="現値を確認できません">
          {failed}
          <span className="mt-2 block">
            <Button variant="secondary" onClick={() => void load()} className="max-lg:min-h-11 px-4">再読み込み</Button>
          </span>
        </Banner>
      )}
      {storeError && (
        <Banner tone="error" eyebrow="ERROR" role="alert" title="端末の下書きを操作できません">
          {storeError}
        </Banner>
      )}
      <div className="flex flex-wrap gap-2">
        <Button
          onClick={() => setConfirming("resend")}
          disabled={current === null || busy}
          className="max-lg:min-h-11"
        >
          現値の版で送り直す
        </Button>
        <Button variant="secondary" onClick={() => setConfirming("discard")} disabled={busy} className="max-lg:min-h-11">
          破棄
        </Button>
      </div>

      {confirming === "resend" && current && (
        <ConfirmDialog
          title="現値の版で新しい操作として送り直します"
          confirmLabel="送り直す"
          busy={busy}
          onConfirm={() => void resendAsNew()}
          onCancel={() => setConfirming(null)}
        >
          <p>
            この端末の入力（{draftSummaryLine(draft)}）を、サーバーの現在の版（第{current.version}版）を前提に
            <strong className="font-bold">新しい操作</strong>として送ります。古い操作の記録はそのまま残り、この操作で上書きされるのは
            対象の現在値に対する1回の更新だけです。
          </p>
          <p>対象: {OPERATION_LABELS[draft.operationCode] ?? draft.operationCode}</p>
        </ConfirmDialog>
      )}
      {confirming === "discard" && (
        <ConfirmDialog
          title="この下書きを破棄します"
          confirmLabel="破棄する"
          busy={busy}
          danger
          onConfirm={() => void discard()}
          onCancel={() => setConfirming(null)}
        >
          <p>端末に置いた入力を消します。サーバーの現在の値は変わりません。破棄した入力は元に戻せません。</p>
        </ConfirmDialog>
      )}
    </Card>
  );
}
