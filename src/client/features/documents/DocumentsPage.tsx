import { useEffect, useState } from "react";
import { Link, useLocation, useNavigate, useParams, useSearchParams } from "react-router";
import { api, apiCall, type ApiInput } from "../../api";
import { FormErrors } from "../../components/FormErrors";
import { LeaveConfirm } from "../../components/LeaveConfirm";
import { ConfirmDialog } from "../../components/Overlay";
import { MutationStatus } from "../../components/MutationStatus";
import { PageTitle, SubHeader } from "../../components/Page";
import { Banner, Button, Card, Chip, Icon, Notice, TextArea, TextField } from "../../components/ui";
import type { DocumentDto } from "../../../shared/contracts/content";
import type { DocumentDetailData } from "./DocumentVersionPanel";
import { useMe } from "../../me";
import { useMutation } from "../../useMutation";
import { fmtDay } from "../activities/time";
import { DOCUMENT_STATUS, DocumentVersionPanel } from "./DocumentVersionPanel";
import { AclRowsEditor, DocumentAccessPanel, rememberAcl, type AclRowInput } from "./DocumentAccessPanel";
import { randomUuid } from "../../uuid";

/**
 * 文書・規程（T069、SCR-24 /app/documents。docs/03 §2 SCR-24「許諾原本の登録/版/承認/撤回/ACL/閲覧」。
 * prototypeでは予告ページのため共通部品で構成。docs/03 §1.1-18）。
 *
 * 1画面を3つの入口（別入口=aliases。お知らせSCR-16と同じ方式）で扱う:
 *  - 一覧（/app/documents）: 可視文書のみ（API-90。非公開・撤回済みはサーバー側ACL前置で行に現れない）。
 *    検索q／状態の絞り込みはURLクエリにもつ（戻る・再読込で消えない）。
 *  - 作成（/app/documents/new）: 題名・分類・ACL（API-73。ACLは必須1件以上＝deny優先の投影に必要）。
 *  - 詳細（/app/documents/:id）: 版パネル（DocumentVersionPanel）と閲覧許可パネル（DocumentAccessPanel）と
 *    撤回（API-92。理由必須・確認ダイアログ。撤回後は詳細も404になるため成功したら一覧へ戻る）。
 *
 * 管理操作（作成・版・承認・撤回・ACL）の操作枠は幹部・管理者（PER-11＋幹部・管理者。docs/10）に出す。
 * 担当scopeの保持者は画面からは判定できないため、操作はサーバーが毎要求判定する（お知らせT046と同じ注記）。
 * 一般団員は閲覧のみ（可視文書だけが一覧・詳細に現れる）。
 */

/** 一覧の行の状態（API-90のstatus列挙。撤回済みは誰にも現れないため選択肢に置かない。docs/03 §1.1-18） */
const LIST_STATUS: { value: "" | "draft" | "approved"; label: string }[] = [
  { value: "", label: "すべて" },
  { value: "draft", label: "下書き" },
  { value: "approved", label: "承認済み" },
];

/** SCR-24の別入口（/app/documents、/new、/:id）。パスで一覧/フォーム/詳細を出し分ける */
export function DocumentsPage() {
  const params = useParams<{ id?: string }>();
  const location = useLocation();
  if (location.pathname === "/app/documents/new") return <DocumentEditor />;
  if (params.id) return <DocumentDetailRoute id={params.id} />;
  return <DocumentList />;
}

/** 一覧（API-90。deny優先のACL前置はサーバー側。非公開文書は行・件数に現れない） */
function DocumentList() {
  const { me } = useMe();
  const canManage = me.roles.includes("officer") || me.roles.includes("admin");
  const [searchParams, setSearchParams] = useSearchParams();
  const status = (searchParams.get("status") ?? "") as "" | "draft" | "approved";
  const [qInput, setQInput] = useState(searchParams.get("q") ?? "");
  const q = searchParams.get("q") ?? "";

  const [items, setItems] = useState<DocumentDto[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [phase, setPhase] = useState<"loading" | "ready" | "error">("loading");

  const query = (): Partial<ApiInput<"API-90">["query"]> => ({
    limit: 50,
    ...(q ? { q } : {}),
    ...(status ? { status } : {}),
  });

  useEffect(() => {
    const ctrl = new AbortController();
    let alive = true;
    setPhase("loading");
    setItems([]);
    void (async () => {
      try {
        const res = await apiCall("API-90", { query: query() as ApiInput<"API-90">["query"] }, { signal: ctrl.signal });
        if (!alive) return;
        setItems(res.data as unknown as DocumentDto[]);
        setCursor(res.nextCursor ?? null);
        setPhase("ready");
      } catch (e) {
        if (alive && !(e instanceof DOMException && e.name === "AbortError")) setPhase("error");
      }
    })();
    return () => {
      alive = false;
      ctrl.abort();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q, status]);

  const loadMore = async () => {
    if (!cursor) return;
    setPhase("loading");
    try {
      const res = await apiCall("API-90", { query: { ...query(), cursor } as ApiInput<"API-90">["query"] });
      setItems((prev) => [...prev, ...(res.data as unknown as DocumentDto[])]);
      setCursor(res.nextCursor ?? null);
      setPhase("ready");
    } catch {
      setPhase("error");
    }
  };

  const setParam = (patch: { q?: string; status?: string }) => {
    const next = new URLSearchParams(searchParams);
    const q2 = patch.q !== undefined ? patch.q : q;
    const st = patch.status !== undefined ? patch.status : status;
    if (q2) next.set("q", q2);
    else next.delete("q");
    if (st) next.set("status", st);
    else next.delete("status");
    setSearchParams(next, { replace: true });
  };

  return (
    <div className="flex max-w-[720px] flex-col gap-4">
      <PageTitle
        eyebrow="2026 · DOCUMENTS"
        className="lg:[&_h2]:hidden"
        right={
          <span aria-hidden="true" className="grid size-11 place-items-center rounded-full bg-white/[.06]">
            <Icon name="folder" className="text-[21px] text-ink-muted" />
          </span>
        }
      >
        文書・規程
      </PageTitle>

      <div className="flex flex-wrap items-center gap-2">
        {/* 検索（API-90のq=題名の部分一致。Enterで反映しURLクエリにもつ） */}
        <form
          onSubmit={(e) => {
            e.preventDefault();
            setParam({ q: qInput.trim() });
          }}
          className="hairline flex h-[46px] min-w-0 flex-1 items-center gap-2 rounded-field bg-white/[.06] px-4"
        >
          <Icon name="search" className="flex-none text-[18px] text-ink-muted" />
          <input
            value={qInput}
            onChange={(e) => setQInput(e.target.value)}
            aria-label="題名で検索"
            placeholder="題名で検索"
            className="min-w-0 flex-1 border-none bg-transparent text-[14px] font-medium text-ink outline-none placeholder:text-ink-dim"
          />
        </form>
        <label className="hairline flex h-[46px] items-center gap-2 rounded-field bg-white/[.06] px-4">
          <span className="text-[12px] font-bold text-ink-sub">状態</span>
          <select
            aria-label="状態で絞る"
            value={status}
            onChange={(e) => setParam({ status: e.target.value })}
            className="min-w-0 border-none bg-transparent text-[14px] font-medium text-ink outline-none"
          >
            {LIST_STATUS.map((s) => (
              <option key={s.value} value={s.value}>
                {s.label}
              </option>
            ))}
          </select>
        </label>
        {canManage && (
          <Link
            to="/app/documents/new"
            className="inline-flex min-h-11 items-center gap-1.5 self-start rounded-pill bg-white/[.08] px-4 text-[13px] font-bold text-ink"
          >
            <Icon name="add" className="text-[17px]" />
            文書を作成
          </Link>
        )}
      </div>
      <p className="text-[12px] text-ink-muted">
        閲覧できる文書だけが表示されます（非公開の文書・撤回された文書は一覧に現れません）。
      </p>

      {phase === "loading" && (
        <div className="flex flex-col gap-2">
          {[1, 2, 3].map((n) => (
            <div key={n} className="h-20 animate-pulse rounded-[20px] bg-white/[.05]" />
          ))}
        </div>
      )}
      {phase === "error" && (
        <Banner tone="error" eyebrow="ERROR" role="alert" title="文書の一覧を取得できませんでした">
          通信を確認して、再読み込みしてください。
        </Banner>
      )}
      {phase === "ready" && items.length === 0 && (
        <Banner tone="info" eyebrow="EMPTY" title="文書はまだありません">
          {canManage ? "「文書を作成」から許諾のある原本を登録できます。" : "共有された文書がここに現れます。"}
        </Banner>
      )}

      <ul className="flex flex-col gap-2">
        {items.map((d) => {
          const meta = DOCUMENT_STATUS[d.status];
          return (
            <li key={d.id}>
              <Link
                to={`/app/documents/${d.id}`}
                className="flex items-center gap-3 rounded-[20px] bg-white/[.04] p-3.5 shadow-[inset_0_0_0_1px_rgba(255,255,255,.07)] hover:bg-white/[.07]"
              >
                <span className="flex min-w-0 flex-1 flex-col gap-1">
                  <span className="flex flex-wrap items-center gap-2">
                    <Chip tone={meta.tone}>{meta.label}</Chip>
                    {d.currentVersionId ? <Chip tone="ok">有効な承認版あり</Chip> : <Chip tone="neutral">承認版なし</Chip>}
                  </span>
                  <span className="truncate text-[15px] font-bold">{d.title}</span>
                  <span className="truncate font-mono text-[11px] text-ink-muted">
                    分類 {d.classification} · {fmtDay(d.createdAt)}
                  </span>
                </span>
                <Icon name="chevron_right" className="flex-none text-[20px] text-ink-dim" />
              </Link>
            </li>
          );
        })}
      </ul>

      {cursor && (
        <Button variant="secondary" busy={phase === "loading"} onClick={() => void loadMore()} className="max-lg:min-h-11">
          さらに読み込む
        </Button>
      )}
    </div>
  );
}

/** 文書の作成（API-73。root＋ACLを同時に作る。ACLは必須1件以上） */
function DocumentEditor() {
  const { me } = useMe();
  const navigate = useNavigate();
  const create = useMutation("API-73");
  const [title, setTitle] = useState("");
  const [classification, setClassification] = useState("");
  const [rows, setRows] = useState<AclRowInput[]>([{ key: randomUuid(), memberId: me.profile.memberId, effect: "allow" }]);
  const [touched, setTouched] = useState(false);
  const [completed, setCompleted] = useState(false);

  const errors: { field: string; reason: string }[] = [];
  if (touched) {
    if (!title.trim()) errors.push({ field: "title", reason: "題名を入力してください" });
    if (!classification.trim()) errors.push({ field: "classification", reason: "分類を入力してください" });
    if (rows.length === 0 || rows.some((r) => !r.memberId)) errors.push({ field: "acl", reason: "閲覧の対象を1人以上選んでください" });
  }

  const submit = async () => {
    setTouched(true);
    if (errors.length > 0) return;
    const r = await create.run({
      body: { title: title.trim(), classification: classification.trim(), acl: rows.map((r) => ({ memberId: r.memberId, permission: "read", effect: r.effect })) },
    });
    if (r) {
      // 現在のACLを読むAPIが無いため、作成時の内容を「この端末で最後に送った内容」として覚える（docs/03 §1.1-18）
      rememberAcl(r.data.id, rows);
      setCompleted(true);
      setTouched(false);
      await new Promise((r2) => setTimeout(r2, 1000)); // 「保存しました」のトーストが見える時間を確保してから戻る
      navigate(`/app/documents/${r.data.id}`);
    }
  };

  return (
    <div className="flex max-w-[720px] flex-col gap-5">
      <SubHeader title="文書の作成" sub="許諾のある原本を登録します（最初は下書き。版の承認で検索対象になります）" backTo="/app/documents" />
      <Card className="flex flex-col gap-4">
        <TextField name="title" label="題名" value={title} onChange={(e) => { setTouched(true); setTitle(e.target.value); }} placeholder="例: 訓練用の給水要領（架空）" />
        <TextField
          name="classification"
          label="分類"
          value={classification}
          onChange={(e) => { setTouched(true); setClassification(e.target.value); }}
          placeholder="例: 訓練資料"
          hint="短い語で書きます（例: 訓練資料、規程）。分類は閲覧許可の変更と一緒に後から変えられます。"
        />
        <div className="flex flex-col gap-2">
          <span className="text-[12px] font-bold text-ink-sub">閲覧の許可と拒否（ACL。1人以上）</span>
          <AclRowsEditor rows={rows} onChange={(next) => { setTouched(true); setRows(next); }} />
        </div>
        <Notice tone="info" icon="history_edu">
          原本は作成後の詳細画面から添付し、許諾の出典（licenseRef）を付けた「版」として登録します。
        </Notice>
        <FormErrors issues={errors} labels={{ title: "題名", classification: "分類", acl: "閲覧の許可と拒否" }} />
        <MutationStatus state={create.state} toastBottom={100} />
        <Button busy={create.saving} onClick={() => void submit()}>
          文書を作成する
        </Button>
      </Card>
      <LeaveConfirm dirty={touched && !completed} />
    </div>
  );
}

/** 詳細（API-91）。版パネル＋閲覧許可パネル＋撤回。?revision=N はAIの出典（引用元版）を辿る指定（T070） */
function DocumentDetailRoute({ id }: { id: string }) {
  const { me } = useMe();
  const canManage = me.roles.includes("officer") || me.roles.includes("admin");
  const [searchParams] = useSearchParams();
  // 引用元版の指定（CitationPanelからのリンク。無効な値・存在しない版はAPI-91が404で案内になる）
  const revisionRaw = searchParams.get("revision");
  const citedRevision = revisionRaw !== null && /^\d+$/.test(revisionRaw) ? Number(revisionRaw) : undefined;
  // 再読込（版の作成・承認・ACL変更のあと）でも直前の内容を消さない（トーストが見える時間を守る。
  // お知らせT046の詳細と同じ流儀。初回の取得失敗だけ「存在しないか閲覧できない」扱いにする）
  const [detail, setDetail] = useState<DocumentDetailData | null>(null);
  const [failed, setFailed] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);
  const reload = () => setReloadKey((k) => k + 1);

  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const d = await api("API-91", { params: { id }, query: citedRevision !== undefined ? { revision: citedRevision } : {} });
        if (alive) {
          setDetail(d);
          setFailed(false);
        }
      } catch {
        if (alive) setFailed((f) => f || detail === null);
      }
    })();
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, citedRevision, reloadKey]);

  if (detail === null) {
    if (failed) {
      return (
        <div className="flex max-w-[720px] flex-col gap-4">
          <SubHeader backTo="/app/documents" />
          <Banner tone="info" eyebrow="NOT FOUND" title="この文書は存在しないか、閲覧できません">
            非公開の文書、撤回された文書、または別の分団の文書です。
            <Link to="/app/documents" className="ml-1 underline">
              一覧へ戻る
            </Link>
          </Banner>
        </div>
      );
    }
    return (
      <div className="flex max-w-[720px] flex-col gap-3">
        <SubHeader backTo="/app/documents" />
        <div className="h-40 animate-pulse rounded-card bg-white/[.05]" />
        <div className="h-64 animate-pulse rounded-card bg-white/[.05]" />
      </div>
    );
  }
  return <DocumentDetail detail={detail} canManage={canManage} citedRevision={citedRevision} onChanged={reload} />;
}

/** 文書の詳細の本体。撤回（API-92）だけは文書レベルの操作のためここに置く */
function DocumentDetail({
  detail,
  canManage,
  citedRevision,
  onChanged,
}: {
  detail: DocumentDetailData;
  canManage: boolean;
  /** AIの出典として開かれた引用元版（?revision=N。T070）。無ければ通常の詳細表示 */
  citedRevision?: number;
  onChanged: () => void;
}) {
  const navigate = useNavigate();
  const doc = detail.document;
  const withdraw = useMutation("API-92");
  const [confirmWithdraw, setConfirmWithdraw] = useState(false);
  const [withdrawReason, setWithdrawReason] = useState("");

  const meta = DOCUMENT_STATUS[doc.status];
  const draftPointer = detail.versions.find((v) => v.id === doc.currentDraftVersionId) ?? null;
  const approvedPointer = detail.versions.find((v) => v.id === doc.currentVersionId) ?? null;

  const submitWithdraw = async () => {
    if (!withdrawReason.trim()) return;
    const r = await withdraw.run({ params: { id: doc.id }, body: { version: doc.version, reason: withdrawReason.trim() } });
    if (r) {
      // 撤回後は詳細・原文・版の全GETが404になる（T063）ため、一覧へ戻す
      setConfirmWithdraw(false);
      navigate("/app/documents");
    }
  };

  return (
    <div className="flex max-w-[720px] flex-col gap-4">
      <SubHeader backTo="/app/documents" right={<Chip tone={meta.tone}>{meta.label}</Chip>} />

      <div className="flex flex-col gap-2 px-0.5">
        <span className="font-mono text-[11px] text-ink-muted">{fmtDay(doc.createdAt)} 登録</span>
        <h2 className="text-[26px] font-bold leading-[1.3]">{doc.title}</h2>
      </div>

      {/* 引用元版を開いているときの案内（T070。AIの参照元から辿った版であることを示す） */}
      {citedRevision !== undefined && (
        <Notice tone="ai" icon="auto_awesome">
          AIアシスタントの出典として 第{citedRevision}版 を開いています。表示中の版・原本はこの版のものです。
        </Notice>
      )}

      {/* 文書の現状（docs/11「承認版とdraftの別pointer」を別行で出す。policy_versionはACL・分類の改訂版） */}
      <Card className="flex flex-col gap-0 overflow-hidden p-0">
        <InfoRow icon="label">分類 {doc.classification}</InfoRow>
        <InfoRow icon="history" mono>
          閲覧許可の改訂 第{doc.policyVersion}版
        </InfoRow>
        <InfoRow icon="verified">
          {approvedPointer ? `有効な承認版 第${approvedPointer.revisionNo}版` : "有効な承認版 まだ無い"}
        </InfoRow>
        <InfoRow icon="edit_note">
          {draftPointer ? `最新の下書き版 第${draftPointer.revisionNo}版` : "最新の下書き版 無し"}
        </InfoRow>
      </Card>

      <DocumentVersionPanel detail={detail} canManage={canManage} onChanged={onChanged} />

      <DocumentAccessPanel detail={detail} canManage={canManage} onChanged={onChanged} />

      {/* 撤回（API-92。終端。撤回後は一覧・詳細・原文・検索・引用のすべてから即座に消える。docs/03 §1.1-18） */}
      {canManage && doc.status !== "withdrawn" && (
        <section className="flex flex-col gap-2" aria-label="撤回">
          <h3 className="text-[14px] font-bold">撤回</h3>
          <p className="text-[12px] text-ink-muted">
            誤って登録した場合などに使います。撤回すると、この文書は一覧・詳細・原文・検索・引用のすべてから直ちに見えなくなり、元に戻せません（記録と監査は残ります）。
          </p>
          <Button
            variant="secondary"
            className="!h-[46px] !w-auto self-start px-4 !text-[13px] !text-alert max-lg:min-h-11"
            onClick={() => {
              setWithdrawReason("");
              setConfirmWithdraw(true);
            }}
          >
            文書を撤回する
          </Button>
        </section>
      )}
      <MutationStatus state={withdraw.state} toastBottom={100} />

      {confirmWithdraw && (
        <ConfirmDialog
          title="この文書を撤回しますか"
          confirmLabel="撤回する"
          busy={withdraw.saving}
          danger
          confirmDisabled={!withdrawReason.trim()}
          onConfirm={() => void submitWithdraw()}
          onCancel={() => {
            setConfirmWithdraw(false);
            setWithdrawReason("");
          }}
        >
          <p>
            「{doc.title}」を撤回します。撤回すると詳細も開けなくなり、検索と引用（AIアシスタントの根拠）からも直ちに消えます。元に戻すことはできません。
          </p>
          <TextArea
            name="withdraw-reason"
            label="撤回の理由（必須）"
            value={withdrawReason}
            onChange={(e) => setWithdrawReason(e.target.value)}
          />
          {!withdrawReason.trim() && <p className="text-[12px] font-medium text-attention">理由を入力してください</p>}
        </ConfirmDialog>
      )}
    </div>
  );
}

/** 情報カードの1行（ActivityPageのInfoRowと同じprototype語彙：アイコン＋14px） */
function InfoRow({ icon, mono, children }: { icon: string; mono?: boolean; children: React.ReactNode }) {
  return (
    <div className="flex items-start gap-3 border-b border-white/[.06] px-4 py-3.5 last:border-b-0">
      <span aria-hidden="true" className="ms mt-0.5 text-[20px] text-ink-muted">
        {icon}
      </span>
      <div className={`min-w-0 flex-1 text-[14px] font-medium ${mono ? "font-mono" : ""}`}>{children}</div>
    </div>
  );
}
