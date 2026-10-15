import { useMemo, useState } from "react";
import { Button, Card, TextArea, TextField } from "../../components/ui";
import { AttachmentUploader } from "../attachments/AttachmentUploader";
import { FormErrors } from "../../components/FormErrors";
import { MutationStatus } from "../../components/MutationStatus";
import { useMutation } from "../../useMutation";
import { instantFromInput, inputFromInstant } from "./time";

/**
 * 実績の入力・訂正フォーム（T039、SCR-09の実績欄。docs/05 API-09/42）。
 * - 作成（API-09）は未作成の活動に1回だけ。訂正（API-42）は参加者を**全置換**するPUT意味論なので、
 *   現行版の参加者全員を初期値に載せ、保存で全集合を送る（原本の版は不変。docs/11 §3）。
 * - 個人時間は全体時間と別の入力。空欄は未知として送らない（docs/05 §3「未知時刻は欠落表示」）。
 * - 添付は検査済み(ready)のものだけを保存時に紐付ける（docs/10 §3）。
 */

type ActualStatus = "unconfirmed" | "participated" | "absent";

const STATUS_WORDS: { word: string; value: ActualStatus }[] = [
  { word: "未確認", value: "unconfirmed" },
  { word: "実参加", value: "participated" },
  { word: "欠席", value: "absent" },
];
const wordOf = (v: ActualStatus) => STATUS_WORDS.find((s) => s.value === v)!.word;
const valueOf = (word: string) => STATUS_WORDS.find((s) => s.word === word)!.value;

/** 安定した同一性の「保存済み」状態（再描画でトーストを出し直さない） */
const SAVED = { kind: "saved" } as const;

export interface ActualParticipantInput {
  memberId: string;
  actualStatus: ActualStatus;
  individualStartsAt: string | null;
  individualEndsAt: string | null;
}

export interface ActualFormInitial {
  content: string;
  actualStartsAt: string | null;
  actualEndsAt: string | null;
  participants: ActualParticipantInput[];
}

export function ActualResultForm({
  activityId,
  mode,
  activityVersion,
  resultVersion,
  audience,
  initial,
  onSaved,
  onDone,
  onCancel,
}: {
  activityId: string;
  mode: "create" | "correct";
  /** 作成時に検査する予定の版（AT-ACT-03「予定不変」の競合検査） */
  activityVersion: number;
  /** 訂正時の実績rootの版（現在版ポインタの切替ガード） */
  resultVersion?: number;
  /** 対象者（フォームの行。実参加にできるのは対象snapshotの団員だけ。docs/04） */
  audience: { memberId: string; displayName: string }[];
  /** 訂正の初期値（現行版）。作成時はnull（全員「未確認」から始める） */
  initial: ActualFormInitial | null;
  /** 保存が確定したら親が詳細を引き直す（フォームは開いたまま「保存済み」を出す） */
  onSaved: () => void;
  /** トーストが消えたら呼ぶ（親はフォームを閉じる） */
  onDone: () => void;
  onCancel: () => void;
}) {
  const byMember = useMemo(
    () => new Map((initial?.participants ?? []).map((p) => [p.memberId, p])),
    [initial],
  );
  const [content, setContent] = useState(initial?.content ?? "");
  const [startsAt, setStartsAt] = useState(inputFromInstant(initial?.actualStartsAt));
  const [endsAt, setEndsAt] = useState(inputFromInstant(initial?.actualEndsAt));
  const [status, setStatus] = useState<Record<string, ActualStatus>>(() =>
    Object.fromEntries(audience.map((m) => [m.memberId, byMember.get(m.memberId)?.actualStatus ?? "unconfirmed" as ActualStatus])),
  );
  const [indStart, setIndStart] = useState<Record<string, string>>(() =>
    Object.fromEntries(audience.map((m) => [m.memberId, inputFromInstant(byMember.get(m.memberId)?.individualStartsAt)])),
  );
  const [indEnd, setIndEnd] = useState<Record<string, string>>(() =>
    Object.fromEntries(audience.map((m) => [m.memberId, inputFromInstant(byMember.get(m.memberId)?.individualEndsAt)])),
  );
  const [reason, setReason] = useState("");
  const [attachmentIds, setAttachmentIds] = useState<string[]>([]);
  const [busyAttachments, setBusyAttachments] = useState(false);
  const [touched, setTouched] = useState(false);
  const [completed, setCompleted] = useState(false);
  const create = useMutation("API-09");
  const correct = useMutation("API-42");
  const save = mode === "create" ? create : correct;

  const startsInstant = instantFromInput(startsAt);
  const endsInstant = instantFromInput(endsAt);

  /** 送る参加行は「未確認以外」を選んだ人（未確認＝まだ確定していない人は行にしない） */
  const rows = audience
    .filter((m) => status[m.memberId] !== "unconfirmed")
    .map((m) => {
      const s = instantFromInput(indStart[m.memberId] ?? "");
      const e = instantFromInput(indEnd[m.memberId] ?? "");
      return {
        memberId: m.memberId,
        actualStatus: status[m.memberId] ?? ("unconfirmed" as const),
        ...(s ? { individualStartsAt: s } : {}),
        ...(e ? { individualEndsAt: e } : {}),
      };
    });

  const errors: { field: string; reason: string }[] = [];
  if (touched) {
    if (!content.trim()) errors.push({ field: "content", reason: "活動の内容を入力してください" });
    if (mode === "correct" && !reason.trim()) errors.push({ field: "reason", reason: "訂正の理由を入力してください" });
    if (startsInstant && endsInstant && endsInstant < startsInstant) errors.push({ field: "actualEndsAt", reason: "実施（終了）は実施（開始）以降にしてください" });
    rows.forEach((r, i) => {
      const s = instantFromInput(indStart[r.memberId] ?? "");
      const e = instantFromInput(indEnd[r.memberId] ?? "");
      if (s && e && e < s) errors.push({ field: `participants.${i}.individualEndsAt`, reason: `個人時間の終了は開始以降にしてください（${audience.find((m) => m.memberId === r.memberId)?.displayName}さん）` });
    });
  }

  const submit = async () => {
    setTouched(true);
    if (errors.length > 0 || busyAttachments) return;
    const base = {
      content: content.trim(),
      ...(startsInstant ? { actualStartsAt: startsInstant } : {}),
      ...(endsInstant ? { actualEndsAt: endsInstant } : {}),
      participants: rows,
      attachmentIds,
    };
    const result =
      mode === "create"
        ? await create.run({ params: { id: activityId }, body: { activityVersion, ...base } })
        : await correct.run({ params: { id: activityId }, body: { resultVersion: resultVersion!, ...base, reason: reason.trim() } });
    if (result) {
      setCompleted(true);
      setTouched(false);
      onSaved(); // 親が現行版を引き直す（フォームは「保存済み」の表示のまま残る）
      setTimeout(onDone, 2600); // トーストと同じ時間が過ぎたら入力欄を閉じる
    }
  };

  // 保存済みの表示の間は入力欄を出さない（選択肢の文言が画面に残って誤読させないため）
  if (completed) {
    return (
      <Card aria-label={mode === "create" ? "実績の入力" : "実績の訂正"} className="flex flex-col gap-3">
        <MutationStatus state={SAVED} toastBottom={100} />
        <p className="text-[13px] text-ink-sub">
          {mode === "create" ? "実績を記録しました。詳細に表示されます。" : "訂正版を記録しました。原本の版は残っています。"}
        </p>
      </Card>
    );
  }

  return (
    <Card aria-label={mode === "create" ? "実績の入力" : "実績の訂正"} className="flex flex-col gap-4">
      <p className="text-[12px] leading-[1.6] text-ink-muted">
        {mode === "create"
          ? "その日の実参加と活動の内容を記録します。出欠の回答はコピーされません（実参加は別の記録です）。"
          : "訂正は新しい版として保存され、原本の版は残ります。参加者はこの内容で全て入れ替わります。"}
      </p>
      <TextArea name="content" label="活動の内容" value={content} onChange={(e) => setContent(e.target.value)} placeholder="例: ポンプ車操法を実施。放水訓練と整備点検も実施" />
      <div className="grid gap-4 lg:grid-cols-2">
        <TextField name="actualStartsAt" label="実施（開始）" type="datetime-local" value={startsAt} onChange={(e) => setStartsAt(e.target.value)} />
        <TextField name="actualEndsAt" label="実施（終了）" type="datetime-local" value={endsAt} onChange={(e) => setEndsAt(e.target.value)} />
      </div>
      <p className="text-[12px] text-ink-muted">わからない時刻は空欄のままにしてください（未記載として保存し、推測しません）。</p>

      <div className="flex flex-col gap-2">
        <span className="text-[12px] font-bold text-ink-sub">実参加（対象者ごとの記録）</span>
        <ul className="flex flex-col gap-2">
          {audience.map((m) => (
            <li key={m.memberId} className="flex flex-col gap-2 rounded-[14px] bg-white/[.04] p-2.5">
              <div className="flex items-center gap-2">
                <span className="min-w-0 flex-1 truncate text-[14px] font-medium">{m.displayName}</span>
                <select
                  aria-label={`${m.displayName}さんの実参加`}
                  value={wordOf(status[m.memberId] ?? "unconfirmed")}
                  onChange={(e) => {
                    setTouched(true);
                    setStatus((prev) => ({ ...prev, [m.memberId]: valueOf(e.target.value) }));
                  }}
                  className="hairline h-[46px] max-lg:min-h-11 rounded-xl bg-white/[.06] px-3 text-[13px] font-medium text-ink outline-none"
                >
                  {STATUS_WORDS.map((s) => (
                    <option key={s.value} value={s.word}>
                      {s.word}
                    </option>
                  ))}
                </select>
              </div>
              {status[m.memberId] !== "unconfirmed" && (
                <div className="grid gap-2 lg:grid-cols-2">
                  <TextField
                    name={`ind-start-${m.memberId}`}
                    label={`${m.displayName}さんの個人開始（任意）`}
                    type="datetime-local"
                    value={indStart[m.memberId] ?? ""}
                    onChange={(e) => {
                      setTouched(true);
                      setIndStart((prev) => ({ ...prev, [m.memberId]: e.target.value }));
                    }}
                  />
                  <TextField
                    name={`ind-end-${m.memberId}`}
                    label={`${m.displayName}さんの個人終了（任意）`}
                    type="datetime-local"
                    value={indEnd[m.memberId] ?? ""}
                    onChange={(e) => {
                      setTouched(true);
                      setIndEnd((prev) => ({ ...prev, [m.memberId]: e.target.value }));
                    }}
                  />
                </div>
              )}
            </li>
          ))}
        </ul>
      </div>

      <div className="flex flex-col gap-2">
        <span className="text-[12px] font-bold text-ink-sub">写真・記録</span>
        <AttachmentUploader
          target={{ type: "activity", id: activityId }}
          onReady={(ids) => setAttachmentIds(ids)}
          onChange={setBusyAttachments}
        />
      </div>

      {mode === "correct" && (
        <TextArea
          name="correction-reason"
          label="訂正理由（必須）"
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          placeholder="例: 後半から参加していたため欠席扱いを訂正"
        />
      )}

      <FormErrors issues={errors} labels={{ content: "活動の内容", actualEndsAt: "実施（終了）", reason: "訂正理由" }} />
      {save.state.kind === "conflict" && (
        <div role="alert" className="hairline rounded-card bg-[rgba(255,195,92,.08)] p-3.5 text-[13px] text-[#ffdca0]">
          {mode === "create"
            ? "すでに実績が作られています（1活動1実績）。詳細を再読み込みして確認してください。"
            : "他の訂正と競合しています。詳細を再読み込みして最新の版を確認してください。"}
        </div>
      )}
      {save.state.kind === "rejected" && (
        <div role="alert" className="hairline rounded-card bg-[rgba(255,195,92,.08)] p-3.5 text-[13px] text-[#ffdca0]">
          この状態では実行できません。予定の版が変わっているか、対象者以外を実参加にしようとしています。再読み込みして確認してください。
        </div>
      )}
      {save.state.kind === "unknown" && (
        <div role="alert" className="hairline rounded-card bg-[rgba(255,195,92,.08)] p-3.5 text-[13px] text-[#ffdca0]">
          結果を確認できません。同じ内容で再送しても二重には登録されません。
        </div>
      )}
      <MutationStatus state={save.state.kind === "saved" ? SAVED : { kind: "idle" }} toastBottom={100} />
      <div className="flex flex-wrap gap-2">
        <Button busy={save.saving || busyAttachments} onClick={() => void submit()} className="min-w-[180px] flex-1">
          {mode === "create" ? "実績を保存" : "訂正を保存"}
        </Button>
        <Button variant="secondary" busy={save.saving} onClick={onCancel} className="max-lg:min-h-11 flex-none px-4">
          やめる
        </Button>
      </div>
    </Card>
  );
}
