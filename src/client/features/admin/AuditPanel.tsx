import { useCallback, useEffect, useState } from "react";
import type { ApiResponse } from "../../../shared/contracts/registry";
import { ApiError, apiCall } from "../../api";
import { Banner, Button, Card, Icon, Notice } from "../../components/ui";
import type { MemberRow } from "../members/useMembers";

type Log = ApiResponse<"API-93">[number];

/** 行為の表示名。コードのまま見せない（未知のコードはそのまま出す） */
const ACTION_LABEL: Record<string, string> = {
  "member.create": "団員を登録",
  "member.update": "団員の情報を変更",
  "member.disable": "団員を停止（休団・退団）",
  "member.roles.replace": "役割・担当を変更",
  "member.private.view": "他人の連絡先を表示",
  "invitation.create": "招待を発行",
  "invitation.cancel": "招待を取消",
  "invitation.accept": "招待を受領",
  "user.sessions.revoke": "全セッションを失効",
  "bootstrap.issue": "初期管理者の招待を発行",
  // 認証イベント（PH1-A2・T086。docs/evidence/ph1-review.md A）。秘密（パスワード・token）は記録されない
  "auth.sign_in": "サインイン（成功・失敗）",
  "auth.two_factor.setup_started": "二要素認証の設定を開始",
  "auth.two_factor.enabled": "二要素認証を有効化",
  "auth.two_factor.backup_codes_regenerated": "回復コードを再発行",
  "auth.password_reset_requested": "パスワード再設定を要求",
  "auth.password_reset_completed": "パスワードを再設定",
};
const ENTITY_LABEL: Record<string, string> = { member: "団員", invitation: "招待", user: "利用者" };
const jst = (iso: string) => new Date(iso).toLocaleString("ja-JP", { timeZone: "Asia/Tokyo", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" });
const short = (id: string) => id.slice(0, 8);

/**
 * 監査ログの検索（API-93、追記専用・管理者のみ）。行為者・対象種別・期間で絞り、新しい順に追う。
 * 本文・氏名・連絡先は記録されていない（IDとコードだけ）ので、氏名は名簿から引いて表示する。
 */
export function AuditPanel({ enabled, members }: { enabled: boolean; members: MemberRow[] }) {
  const [rows, setRows] = useState<Log[]>([]);
  const [next, setNext] = useState<string | undefined>();
  const [state, setState] = useState<"idle" | "loading" | "error" | "forbidden">("idle");
  const [actor, setActor] = useState("");
  const [entityType, setEntityType] = useState("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");

  const nameOfUser = (userId: string | null) => (userId ? (members.find((m) => m.account?.userId === userId)?.displayName ?? "（不明な利用者）") : "システム");
  const nameOfMember = (id: string) => members.find((m) => m.id === id)?.displayName;

  const load = useCallback(
    async (cursor?: string) => {
      setState("loading");
      try {
        const r = await apiCall("API-93", {
          query: {
            limit: 25,
            ...(actor ? { actorId: actor } : {}),
            ...(entityType ? { entityType } : {}),
            ...(from ? { from: new Date(`${from}T00:00:00+09:00`).toISOString() } : {}),
            ...(to ? { to: new Date(`${to}T23:59:59.999+09:00`).toISOString() } : {}),
            ...(cursor ? { cursor } : {}),
          },
        });
        setRows((prev) => (cursor ? [...prev, ...r.data] : r.data));
        setNext(r.nextCursor);
        setState("idle");
      } catch (e) {
        setState(e instanceof ApiError && e.status === 403 ? "forbidden" : "error");
      }
    },
    [actor, entityType, from, to],
  );
  useEffect(() => {
    if (enabled) void load();
    // 絞り込みの変更は「絞り込む」で反映する。最初の表示と有効化のときだけ自動で読む
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled]);

  return (
    <Card className="flex flex-col gap-3.5 p-4 lg:p-5">
      <h3 className="flex items-center gap-2 text-[15px] font-bold">
        <Icon name="fact_check" className="text-[20px] text-ink-muted" />
        監査ログ
      </h3>
      <p className="text-[12px] leading-[1.6] text-ink-muted">誰が・いつ・何を変えたかの記録です（追記のみで、変更・削除はできません）。本文や連絡先は記録されません。</p>
      {!enabled ? (
        <Notice tone="warning" icon="lock">二要素認証の設定が済むまで、監査ログは表示できません。</Notice>
      ) : (
        <>
          <form
            onSubmit={(e) => { e.preventDefault(); void load(); }}
            className="grid grid-cols-1 gap-2.5 sm:grid-cols-2 lg:grid-cols-[1fr_1fr_1fr_1fr_auto] lg:items-end"
          >
            <label className="flex flex-col gap-1.5 text-[12px] font-bold text-ink-sub">
              行為者
              <select value={actor} onChange={(e) => setActor(e.target.value)} className="hairline h-11 rounded-xl bg-white/[.06] px-3 text-[14px] font-medium text-ink">
                <option value="">すべて</option>
                {members.filter((m) => m.account).map((m) => <option key={m.id} value={m.account!.userId}>{m.displayName}</option>)}
              </select>
            </label>
            <label className="flex flex-col gap-1.5 text-[12px] font-bold text-ink-sub">
              対象
              <select value={entityType} onChange={(e) => setEntityType(e.target.value)} className="hairline h-11 rounded-xl bg-white/[.06] px-3 text-[14px] font-medium text-ink">
                <option value="">すべて</option>
                <option value="member">団員</option>
                <option value="invitation">招待</option>
              </select>
            </label>
            <label className="flex flex-col gap-1.5 text-[12px] font-bold text-ink-sub">
              開始日
              <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} className="hairline h-11 rounded-xl bg-white/[.06] px-3 text-[14px] font-medium text-ink" />
            </label>
            <label className="flex flex-col gap-1.5 text-[12px] font-bold text-ink-sub">
              終了日
              <input type="date" value={to} onChange={(e) => setTo(e.target.value)} className="hairline h-11 rounded-xl bg-white/[.06] px-3 text-[14px] font-medium text-ink" />
            </label>
            <Button type="submit" variant="secondary" busy={state === "loading"} className="!h-11 !text-[13px] sm:col-span-2 lg:col-span-1 lg:!w-auto lg:px-5">
              絞り込む
            </Button>
          </form>
          {state === "forbidden" && <Banner tone="error" eyebrow="FORBIDDEN" role="alert" title="監査ログを表示できません">この操作は許可されていません。</Banner>}
          {state === "error" && <Banner tone="error" eyebrow="ERROR" role="alert" title="監査ログを取得できません">通信を確認してもう一度お試しください。</Banner>}
          <ol aria-label="監査ログ" className="flex flex-col">
            {rows.map((r) => (
              <li key={r.id} className="border-b border-white/5 py-2.5 last:border-0">
                <details>
                  <summary className="grid cursor-pointer list-none grid-cols-[1fr_auto] items-center gap-x-3 gap-y-0.5 lg:grid-cols-[170px_1fr_160px_auto]">
                    <span className="font-mono text-[11px] text-ink-muted lg:order-none">{jst(r.occurredAt)}</span>
                    <span className="text-[13px] font-bold">{ACTION_LABEL[r.action] ?? r.action}</span>
                    <span className="col-span-2 text-[12px] text-ink-sub lg:col-span-1">
                      {nameOfUser(r.actorId)}
                      <span className="text-ink-dim"> → {ENTITY_LABEL[r.entityType] ?? r.entityType}{nameOfMember(r.entityId) ? `：${nameOfMember(r.entityId)}` : ` ${short(r.entityId)}`}</span>
                    </span>
                    <span className="font-mono text-[11px] text-ink-dim">{r.entityVersion ? `v${r.entityVersion}` : ""}</span>
                  </summary>
                  <dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 rounded-xl bg-white/[.03] p-3 font-mono text-[11px] text-ink-sub">
                    <dt className="text-ink-dim">操作ID</dt><dd className="break-all">{r.mutationId}</dd>
                    <dt className="text-ink-dim">対象ID</dt><dd className="break-all">{r.entityId}</dd>
                    {r.eventType && (<><dt className="text-ink-dim">イベント</dt><dd>{r.eventType}</dd></>)}
                    {Object.entries(r.metadata).map(([k, v]) => (
                      <span key={k} className="contents"><dt className="text-ink-dim">{k}</dt><dd className="break-all">{String(v)}</dd></span>
                    ))}
                  </dl>
                </details>
              </li>
            ))}
          </ol>
          {state !== "loading" && rows.length === 0 && state !== "error" && <p className="text-[13px] text-ink-muted">該当する記録はありません。</p>}
          {next && (
            <Button variant="secondary" busy={state === "loading"} onClick={() => void load(next)} className="!h-11 !text-[13px]">
              さらに読み込む
            </Button>
          )}
        </>
      )}
    </Card>
  );
}
