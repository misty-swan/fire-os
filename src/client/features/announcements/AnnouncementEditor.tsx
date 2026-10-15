import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router";
import { api, apiCall, ApiError, type ApiInput } from "../../api";
import { FormErrors } from "../../components/FormErrors";
import { LeaveConfirm } from "../../components/LeaveConfirm";
import { MutationStatus } from "../../components/MutationStatus";
import { SubHeader } from "../../components/Page";
import { Banner, Button, Card, Chip, Notice, TextArea, TextField } from "../../components/ui";
import { useMe } from "../../me";
import { useMutation } from "../../useMutation";
import type { AnnouncementDto } from "../../../shared/contracts/content";
import { fmtInstant, instantFromInput } from "../activities/time";

/**
 * お知らせの登録・編集フォーム（T046、SCR-16の別入口 /app/announcements/new と /app/announcements/:id/edit）。
 * 登録はAPI-25（最初はdraft。公開は詳細画面の確認ダイアログから。docs/11 お知らせ）。
 * 編集はAPI-72（version＋変更列のみ。title/body/対象の変更は新revisionになり、対象者の既読は新版で
 * 未確認に戻るため、その旨をフォームに注記する。docs/11「編集で新revision」「既読は版に束縛」）。
 * 添付は作成後の詳細画面から追加する（API-25にattachmentDraftIdが無いため保存前の添付は対象に紐付かない）。
 */

/** 状態は色と文字で示す（docs/11 お知らせ: draft/published/archived。archivedは終端） */
export const ANNOUNCEMENT_STATUS: Record<AnnouncementDto["status"], { label: string; tone: "neutral" | "ok" | "attention" }> = {
  draft: { label: "下書き", tone: "neutral" },
  published: { label: "公開中", tone: "ok" },
  archived: { label: "終了", tone: "attention" },
};

/**
 * お知らせの単一件取得（API-24の一覧を現行順にページ送りして探す。単一件のGET契約が無いため。
 * 上限20ページで打ち切ったら見つからない扱いにする。上限を超える一覧では詳細を開けない点はdocs/03に記録）。
 */
export async function loadAnnouncement(id: string, signal?: AbortSignal): Promise<AnnouncementDto> {
  let cursor: string | undefined;
  for (let page = 0; page < 20; page++) {
    const res = await apiCall("API-24", { query: { limit: 200, ...(cursor ? { cursor } : {}) } as ApiInput<"API-24">["query"] }, { signal });
    for (const row of res.data as unknown as AnnouncementDto[]) if (row.id === id) return row;
    cursor = res.nextCursor;
    if (!cursor) break;
  }
  throw new ApiError(404, "NOT_FOUND");
}

interface MemberOption {
  id: string;
  displayName: string;
  status: string;
}

export function AnnouncementEditor(props: { mode: "create" } | { mode: "edit"; id: string }) {
  const navigate = useNavigate();
  const editing = props.mode === "edit";
  const id = props.mode === "edit" ? props.id : "";
  const { me } = useMe();

  const [loadState, setLoadState] = useState<"loading" | "ready" | "error">(editing ? "loading" : "ready");
  const [original, setOriginal] = useState<AnnouncementDto | null>(null);
  const [members, setMembers] = useState<MemberOption[]>([]);
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [publishAt, setPublishAt] = useState("");
  const [audience, setAudience] = useState<Set<string>>(() => new Set([me.profile.memberId]));
  const [touched, setTouched] = useState(false);
  /** 保存が確定したら離脱確認を外す（保存後の自動遷移を確認ダイアログで止めない） */
  const [completed, setCompleted] = useState(false);
  const create = useMutation("API-25");
  const update = useMutation("API-72");
  const save = editing ? update : create;

  // 名簿（対象者の選択肢。ActivityEditorPageの対象者と同じ流儀）。API-02は有効な団員を出す
  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const rows = (await api("API-02", { query: { limit: 200 } })) as unknown as MemberOption[];
        if (alive) setMembers(rows);
      } catch {
        if (alive) setMembers([]);
      }
    })();
    return () => {
      alive = false;
    };
  }, []);

  useEffect(() => {
    if (!editing) return;
    let alive = true;
    void (async () => {
      try {
        const data = await loadAnnouncement(id);
        if (!alive) return;
        setOriginal(data);
        setTitle(data.title);
        setBody(data.body);
        // 編集画面はPER-03保持者専用なので対象者一覧は必ず載る（docs/05 §1）。型上は任意のため空に広げる
        setAudience(new Set(data.audienceMemberIds ?? []));
        setLoadState("ready");
      } catch {
        if (alive) setLoadState("error");
      }
    })();
    return () => {
      alive = false;
    };
  }, [editing, id]);

  /** 選択肢は有効な団員。既に対象になっている団員（休団など）も外さずに出す（ActivityEditorPageと同じ） */
  const options = useMemo(() => {
    const byId = new Map(members.map((m) => [m.id, m]));
    for (const mid of audience) if (!byId.has(mid)) byId.set(mid, { id: mid, displayName: mid, status: "unknown" });
    return [...byId.values()].sort((a, b) => (a.status === "active" ? 0 : 1) - (b.status === "active" ? 0 : 1));
  }, [members, audience]);

  const publishInstant = instantFromInput(publishAt);

  /** 編集は変更のあった列だけを送る（API-72は部分更新）。対象は集合の比較 */
  const changes = useMemo(() => {
    const o = original;
    if (!o) return null;
    const diff: Record<string, unknown> = {};
    if (title.trim() !== o.title) diff.title = title.trim();
    if (body !== o.body) diff.body = body;
    // 編集は変更のあった列だけを送る（API-72は部分更新）。対象は集合の比較（対象者一覧は管理権限の応答に必ず載る）
    const originalAudience = o.audienceMemberIds ?? [];
    const audienceChanged = audience.size !== originalAudience.length || [...audience].some((mid) => !originalAudience.includes(mid));
    if (audienceChanged) diff.audienceMemberIds = [...audience];
    return diff;
  }, [original, title, body, audience]);

  const errors: { field: string; reason: string }[] = [];
  if (touched) {
    if (!title.trim()) errors.push({ field: "title", reason: "件名を入力してください" });
    if (!body.trim()) errors.push({ field: "body", reason: "本文を入力してください" });
    if (audience.size === 0) errors.push({ field: "audienceMemberIds", reason: "対象者を1人以上選んでください" });
    if (editing && changes !== null && Object.keys(changes).length === 0) errors.push({ field: "(body)", reason: "変更がありません。どこかを直してから保存してください。" });
  }
  const archived = original?.status === "archived";

  const submit = async () => {
    setTouched(true);
    if (errors.length > 0 || archived) return;
    if (editing && original) {
      if (Object.keys(changes ?? {}).length === 0) return;
      const result = await update.run({ params: { id }, body: { version: original.version, ...changes } as never });
      if (result) {
        setCompleted(true);
        setTouched(false);
        await new Promise((r) => setTimeout(r, 1000)); // 「保存しました」のトーストが見える時間を確保してから戻る
        navigate(`/app/announcements/${id}`);
      }
      return;
    }
    const result = await create.run({
      body: {
        title: title.trim(),
        body,
        audienceMemberIds: [...audience],
        ...(publishInstant ? { publishAt: publishInstant } : {}),
      },
    });
    if (result) {
      setCompleted(true);
      setTouched(false);
      await new Promise((r) => setTimeout(r, 1000));
      navigate(`/app/announcements/${(result.data as { id: string }).id}`);
    }
  };

  if (loadState === "loading") {
    return (
      <div className="flex max-w-[720px] flex-col gap-3">
        <SubHeader title={editing ? "お知らせの編集" : "お知らせの作成"} backTo="/app/announcements" />
        <div className="h-64 animate-pulse rounded-card bg-white/[.05]" />
      </div>
    );
  }
  if (loadState === "error") {
    return (
      <div className="flex max-w-[720px] flex-col gap-4">
        <SubHeader title="お知らせの編集" backTo="/app/announcements" />
        <Banner tone="info" eyebrow="NOT FOUND" title="このお知らせは存在しないか、閲覧できません" />
      </div>
    );
  }

  return (
    <div className="flex max-w-[720px] flex-col gap-5">
      <SubHeader
        title={editing ? "お知らせの編集" : "お知らせの作成"}
        sub={editing ? "本文と対象を修正します" : "対象者へのお知らせを作ります（最初は下書き）"}
        backTo={editing ? `/app/announcements/${id}` : "/app/announcements"}
        right={
          editing && original ? (
            <Chip tone={ANNOUNCEMENT_STATUS[original.status].tone}>
              {ANNOUNCEMENT_STATUS[original.status].label} 第{original.revisionNo}版
            </Chip>
          ) : (
            <Chip tone="neutral">下書きで作成</Chip>
          )
        }
      />
      <Card className="flex flex-col gap-4">
        <TextField name="title" label="件名" value={title} onChange={(e) => { setTouched(true); setTitle(e.target.value); }} placeholder="例: 秋季訓練の集合時刻について" />
        <TextArea name="body" label="本文" value={body} onChange={(e) => { setTouched(true); setBody(e.target.value); }} placeholder="日時・場所・持ち物など、対象者が知るべき内容を書きます" />
        {!editing && (
          <TextField
            name="publishAt"
            label="公開予定日時（わからなければ空欄。公開する瞬間の日時になります）"
            type="datetime-local"
            value={publishAt}
            onChange={(e) => { setTouched(true); setPublishAt(e.target.value); }}
          />
        )}

        <div className="flex flex-col gap-2">
          <span className="text-[12px] font-bold text-ink-sub">対象者（公開先。このメンバーで固定されます）</span>
          <ul className="flex flex-col gap-1">
            {options.map((m) => (
              <li key={m.id}>
                <label className="flex min-h-11 items-center gap-3 rounded-xl bg-white/[.04] px-3">
                  <input
                    type="checkbox"
                    className="size-5"
                    checked={audience.has(m.id)}
                    onChange={(e) => {
                      setTouched(true);
                      setAudience((prev) => {
                        const next = new Set(prev);
                        if (e.target.checked) next.add(m.id);
                        else next.delete(m.id);
                        return next;
                      });
                    }}
                  />
                  <span className="min-w-0 flex-1 truncate text-[14px] font-medium">
                    {m.displayName}
                    {m.id === me.profile.memberId && <span className="ml-1 text-[12px] text-ink-muted">（自分）</span>}
                    {m.status !== "active" && <span className="ml-1 text-[12px] text-ink-muted">（名簿で対象外）</span>}
                  </span>
                </label>
              </li>
            ))}
            {members.length === 0 && <li className="text-[12px] text-ink-muted">団員の一覧を読み込んでいます…</li>}
          </ul>
        </div>

        {!editing && (
          <Notice tone="info" icon="add_a_photo">
            写真やファイルは保存した後、詳細画面から追加できます。
          </Notice>
        )}
        {editing && original?.status === "published" && (
          <Notice tone="warning" icon="history">
            保存すると新しい版（第{(original?.revisionNo ?? 0) + 1}版）になります。対象者のだれが読んだかは版ごとに記録されるため、対象者は改めて「内容を確認」を行います。
          </Notice>
        )}
        {archived && (
          <Notice tone="warning" icon="lock">
            終了したお知らせは変更できません（下書き・公開中のときだけ編集できます）。
          </Notice>
        )}

        <FormErrors issues={errors} labels={{ title: "件名", body: "本文", audienceMemberIds: "対象者" }} />
        {save.state.kind === "conflict" && (
          <div role="alert" className="hairline rounded-card bg-[rgba(255,195,92,.08)] p-3.5 text-[13px] text-[#ffdca0]">
            他の操作で更新されています。画面を開き直して最新の内容を確認してください。この操作は保存されていません。
          </div>
        )}
        {save.state.kind === "rejected" && (
          <div role="alert" className="hairline rounded-card bg-[rgba(255,195,92,.08)] p-3.5 text-[13px] text-[#ffdca0]">
            この状態では実行できません（終了済みのお知らせの変更など）。最新の内容を確認してください。
          </div>
        )}
        {save.state.kind === "unknown" && (
          <div role="alert" className="hairline rounded-card bg-[rgba(255,195,92,.08)] p-3.5 text-[13px] text-[#ffdca0]">
            結果を確認できません。同じ内容で再送しても二重には登録されません。
          </div>
        )}
        <MutationStatus state={save.state.kind === "saved" ? save.state : { kind: "idle" }} toastBottom={100} />
        {!archived && (
          <Button busy={save.saving} onClick={() => void submit()}>
            {save.state.kind === "processing" ? "処理中（完了ではありません）" : editing ? "変更を保存" : "登録する"}
          </Button>
        )}
        {editing && !archived && (
          <p className="text-[12px] text-ink-muted">
            保存しても公開状態は変わりません（公開・終了は詳細画面から行います）。公開日時 {original?.publishedAt ? fmtInstant(original.publishedAt) : "は未公開"}。
          </p>
        )}
      </Card>
      <LeaveConfirm dirty={touched && !completed} />
    </div>
  );
}
