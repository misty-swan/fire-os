import { useEffect, useState } from "react";
import { Link, useParams } from "react-router";
import { api, ApiError } from "../../api";
import { SubHeader } from "../../components/Page";
import { Notice } from "../../components/ui";
import { Banner, Button, Card, Chip, Icon } from "../../components/ui";
import { facilityName, locationStatusLabel, type FacilityItem } from "../map/useFacilities";
import { buildMapsUrl } from "./location";

interface FacilityDetail extends FacilityItem {
  attachments: { id: string; status: string }[];
  locationHistory: {
    id: string; locationVersion: number; eventNo: number; latitude: number; longitude: number;
    locationSource: string; verificationStatus: "unverified" | "pending" | "verified" | "rejected";
    verifiedByMemberId: string | null; verifiedAt: string | null; reason: string; createdAt: string;
  }[];
}

/** 異常の状態（API-15のstatus。生のenumをそのまま見せない） */
const ISSUE_STATUS_LABELS: Record<string, string> = {
  reported: "確認待ち",
  under_review: "確認中",
  in_progress: "対応中",
  resolved: "対応実施",
  closed: "確認終了",
};

/** 点検結果の日本語ラベル（点検登録画面と同じ語彙。docs/11 点検結果） */
const INSPECTION_RESULT_LABELS: Record<string, { label: string; tone: "ok" | "alert" | "neutral" }> = {
  ok: { label: "良好", tone: "ok" },
  needs_review: { label: "異常あり", tone: "alert" },
  unknown: { label: "未確認", tone: "neutral" },
};

/** 現在版の点検結果（API-44の先頭1件。loading=取得中、none=記録0件、error=取得失敗） */
type LastInspection =
  | { state: "loading" }
  | { state: "none" }
  | { state: "error" }
  | { state: "found"; id: string; result: string; inspectedAt: string };

/**
 * 施設の詳細（T022/T034、SCR-04）。台帳・写真・位置（出典/確認対象版）・点検と異常の状態を
 * 混同しない表示（docs/03 SCR-04）。位置の確認/点検結果/異常対応を別の行で示す。
 */
export function FacilityPage() {
  const params = useParams<{ id: string }>();
  const id = params.id!;
  const [facility, setFacility] = useState<FacilityDetail | "loading" | "notfound">("loading");
  const [openIssues, setOpenIssues] = useState<{ id: string; title: string; status: string }[] | null>(null);
  const [lastInspection, setLastInspection] = useState<LastInspection>({ state: "loading" });
  /** 点検の記録（API-44の新しい順・最大20件。訂正前の原本も残る＝MAP-06「施設詳細に履歴が時系列表示される」。T085で接続） */
  const [history, setHistory] = useState<{ id: string; result: string; inspectedAt: string; note: string; supersedesId: string | null; isCurrent?: boolean }[]>([]);
  // 位置確認の結果。409(競合)・403(権限)・404(所在)・結果不明(通信断/5xx)を同じ「失敗」にしない（docs/03 §1.1）
  const [reviewState, setReviewState] = useState<"idle" | "busy" | "conflict" | "forbidden" | "missing" | "unknown">("idle");

  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const data = (await api("API-12", { params: { id }, query: { limit: 50 } })) as unknown as FacilityDetail;
        if (alive) setFacility(data);
      } catch {
        if (alive) setFacility("notfound");
      }
      // この施設の未終了の異常（API-15。limit: 200で既定50の打ち切りを避ける。閉じているものは枠に出さない）
      try {
        const issues = (await api("API-15", { query: { targetType: "facility", targetId: id, limit: 200 } })) as unknown as {
          id: string; title: string; status: string;
        }[];
        if (alive) setOpenIssues(issues.filter((i) => i.status !== "closed"));
      } catch {
        if (alive) setOpenIssues([]); // 一覧の取得に失敗しても詳細自体は見せる
      }
      // 現在版の点検結果（API-44のisCurrent。訂正は元の実施日時のまま新しい原本を作るため、新しい順の先頭が
      // 訂正前の原本になり得る＝T085で現在版の印を見るよう修正。記録が0件のときだけ「まだありません」）
      try {
        const inspections = (await api("API-44", { params: { id }, query: { limit: 20 } })) as unknown as {
          id: string; result: string; inspectedAt: string; isCurrent?: boolean; note: string; supersedesId: string | null;
        }[];
        const current = inspections.find((r) => r.isCurrent) ?? inspections[0];
        if (alive) setHistory(inspections as unknown as typeof history);
        if (alive) {
          setLastInspection(
            current
              ? { state: "found", id: current.id, result: current.result, inspectedAt: current.inspectedAt }
              : { state: "none" },
          );
        }
      } catch {
        if (alive) setLastInspection({ state: "error" }); // 通信断・5xxは記録0件と区別する（docs/03 §1.1）
      }
    })();
    return () => {
      alive = false;
    };
  }, [id]);

  if (facility === "loading") {
    return (
      <div className="flex flex-col gap-3">
        <div className="h-64 animate-pulse rounded-card bg-white/[.05]" />
        <div className="h-8 w-2/3 animate-pulse rounded bg-white/[.05]" />
      </div>
    );
  }
  if (facility === "notfound") {
    return (
      <div className="flex max-w-[720px] flex-col gap-4">
        <SubHeader backTo="/app/map" />
        <h2 className="text-[26px] font-bold leading-[1.3]">施設の詳細</h2>
        <Banner tone="info" eyebrow="NOT FOUND" title="この施設は存在しないか、閲覧できません">
          <Link to="/app/map" className="underline">マップへ戻る</Link>
        </Banner>
      </div>
    );
  }

  const status = locationStatusLabel[facility.verificationStatus];
  const statusTone = status.tone === "ok" ? "ok" : status.tone === "attention" ? "attention" : status.tone === "alert" ? "alert" : "neutral";
  // API-15は昇順のため、未終了の異常の「最新1件」は配列の末尾（docs/03 §1）
  const latestIssue = openIssues && openIssues.length > 0 ? openIssues[openIssues.length - 1]! : null;

  const review = async (decision: "request" | "verify") => {
    setReviewState("busy");
    try {
      await api("API-45", {
        params: { id },
        body: {
          version: facility.version,
          locationVersion: facility.locationVersion,
          decision,
          reason: decision === "request" ? "現地確認をお願いします" : "現地で位置を確認した",
        },
      });
      setReviewState("idle");
      window.location.reload(); // 確認状態を最新に（他の更新も反映）
    } catch (e) {
      const status = e instanceof ApiError ? e.status : 0;
      if (status === 409) setReviewState("conflict");
      else if (status === 403) setReviewState("forbidden");
      else if (status === 404) setReviewState("missing");
      else setReviewState("unknown"); // 通信断・5xx・応答が読めない
    }
  };

  return (
    <div className="flex max-w-[720px] flex-col gap-4">
      <div className="lg:hidden">
        <SubHeader title="施設の詳細" backTo="/app/map" />
      </div>

      {/* 写真エリア（prototype: 280px・斜線。写真があれば表示） */}
      <div className="relative -mx-4 flex h-[280px] items-center justify-center bg-[linear-gradient(180deg,#16233a,#0b1422)] max-lg:overflow-hidden lg:mx-0 lg:rounded-[20px]">
        <span aria-hidden="true" className="absolute inset-0 bg-[repeating-linear-gradient(135deg,rgba(255,255,255,.035)_0_2px,transparent_2px_12px)]" />
        {facility.attachments.length > 0 ? (
          <div className="relative z-10 flex gap-2 p-4">
            {facility.attachments.slice(0, 3).map((a, i) => (
              <img
                key={a.id}
                src={`/api/v1/attachments/${a.id}/content`}
                alt={`施設写真${i + 1}`}
                className="size-24 rounded-[12px] object-cover"
                loading="lazy"
              />
            ))}
          </div>
        ) : (
          <span className="font-mono text-[10px] tracking-[.1em] text-[#5a6780]">施設写真 · FACILITY PHOTO</span>
        )}
      </div>

      <div className="flex flex-col gap-2 px-1">
        <div className="flex flex-wrap items-center gap-2">
          <Chip tone="neutral">{facility.type === "hydrant" ? "消火栓" : facility.type === "cistern" ? "防火水槽" : "格納箱"}</Chip>
          <Chip tone={statusTone}>位置：{status.text}</Chip>
          <Link
            to={`/app/facilities/${id}/edit`}
            className="ml-auto inline-flex min-h-11 items-center gap-1.5 rounded-pill bg-white/[.08] px-3.5 text-[13px] font-bold text-ink lg:min-h-9"
          >
            <Icon name="edit" className="text-[17px]" />
            編集
          </Link>
        </div>
        <h2 className="text-[26px] font-bold leading-[1.3]">{facilityName(facility)}</h2>
        <p className="text-[13px] text-ink-sub">{facility.locationNote}</p>
      </div>

      {/* 異常報告の枠（prototype 詳細の「異常報告あり」。未終了の異常があるときだけ出す） */}
      {latestIssue && (
        <div className="flex items-start gap-2.5 rounded-[18px] bg-[rgba(255,90,70,.1)] p-3.5 shadow-[inset_0_0_0_1px_rgba(255,90,70,.3)]">
          <Icon name="report" className="text-[20px] text-alert" />
          <div className="flex min-w-0 flex-1 flex-col gap-1">
            <span className="text-[14px] font-bold text-[#ffb0a4]">異常報告あり（{openIssues!.length}件）</span>
            <span className="line-clamp-2 text-[13px] leading-[1.6] text-[#e7c9c4]">{latestIssue.title}</span>
            <span className="flex flex-wrap items-center gap-2 text-[12px] text-[#e7c9c4]">
              <Chip tone={latestIssue.status === "resolved" ? "ok" : "alert"}>{ISSUE_STATUS_LABELS[latestIssue.status] ?? "状態を確認中"}</Chip>
              <Link to="/app/issues" className="inline-flex min-h-11 items-center underline lg:min-h-9">異常一覧へ</Link>
              {/* AI分類の依頼・承認はAIレビュー（SCR-18）で行う（T055。点検→異常→AIレビューの導線。docs/03 §3） */}
              <Link to={`/app/ai/reviews?source=issue%3A${latestIssue.id}`} className="inline-flex min-h-11 items-center gap-1 underline lg:min-h-9">
                <Icon name="auto_awesome" className="text-[16px]" />
                AI分類をレビュー
              </Link>
            </span>
          </div>
        </div>
      )}

      {/* 状態の3行表示（docs/16 T034: 位置/点検結果/異常対応を混同しない） */}
      <Card className="flex flex-col gap-2.5" aria-label="状態">
        <div className="flex items-center justify-between text-[13px]">
          <span className="text-ink-sub">位置の確認</span>
          <Chip tone={statusTone}>{facility.verificationStatus === "verified" ? "確認済" : facility.verificationStatus === "pending" ? "確認中" : "未確認"}</Chip>
        </div>
        <div className="flex items-center justify-between gap-3 text-[13px]">
          <span className="text-ink-sub">点検結果</span>
          {lastInspection.state === "loading" && <span className="text-[12px] text-ink-muted">読み込み中…</span>}
          {lastInspection.state === "error" && (
            <span className="text-[12px] text-attention">結果を確認できません（通信を確認してください）</span>
          )}
          {lastInspection.state === "none" && (
            <span className="text-[12px] text-ink-muted">点検の記録はまだありません</span>
          )}
          {lastInspection.state === "found" && (
            <span className="flex flex-wrap items-center justify-end gap-2 text-[12px] text-ink-sub">
              <span className="font-mono">{lastInspection.inspectedAt.slice(0, 10)}</span>
              <Chip tone={INSPECTION_RESULT_LABELS[lastInspection.result]?.tone ?? "neutral"}>
                {INSPECTION_RESULT_LABELS[lastInspection.result]?.label ?? "結果を確認中"}
              </Chip>
            </span>
          )}
        </div>
        {lastInspection.state === "found" && (
          // 現在の点検の訂正（SCR-06の訂正モード。元の記録は書き換えない。T085でT033の残作業を接続）
          <div className="flex justify-end">
            <Link
              to={`/app/facilities/${id}/inspections/new?correct=${lastInspection.id}`}
              className="inline-flex min-h-11 items-center rounded-pill bg-white/[.08] px-3 text-[12px] font-bold text-ink lg:min-h-9"
            >
              点検を訂正する
            </Link>
          </div>
        )}
        <div className="flex items-center justify-between text-[13px]">
          <span className="text-ink-sub">異常対応</span>
          <Link to="/app/issues" className="inline-flex min-h-11 items-center gap-1 rounded-pill bg-white/[.08] px-2.5 text-[12px] font-bold text-ink lg:min-h-9">
            異常一覧へ
          </Link>
        </div>
      </Card>

      {history.length > 0 && (
        // 点検の記録（新しい順。訂正前の原本も残る。訂正は上の「点検を訂正する」から現在の記録だけ＝docs/03 §1.1-27）
        <Card className="flex flex-col gap-2">
          <span className="text-[14px] font-bold">点検の記録</span>
          <ul aria-label="点検の記録" className="flex flex-col divide-y divide-white/[.06]">
            {history.map((r) => (
              <li key={r.id} className="flex flex-wrap items-center gap-2 py-2 text-[13px]">
                <span className="font-mono text-[12px] text-ink-sub">{r.inspectedAt.slice(0, 10)}</span>
                <Chip tone={INSPECTION_RESULT_LABELS[r.result]?.tone ?? "neutral"}>{INSPECTION_RESULT_LABELS[r.result]?.label ?? "結果を確認中"}</Chip>
                {r.supersedesId && <span className="text-[11px] text-ink-muted">訂正後の記録</span>}
                {r.isCurrent === false && <span className="text-[11px] text-ink-muted">訂正済み</span>}
                <span className="min-w-0 flex-1 truncate text-ink-sub">{r.note}</span>
              </li>
            ))}
          </ul>
        </Card>
      )}

      <Card className="grid grid-cols-2 gap-px overflow-hidden bg-white/[.07] p-0">
        <InfoCell label="管理番号" value={facility.managementNumber ?? "—"} mono />
        <InfoCell label="識別名" value={facility.identifyingName ?? "—"} />
        <InfoCell label="位置の出典" value={facility.locationSource} />
        <InfoCell label="確認対象の座標版" value={`v${facility.locationVersion}`} mono />
        <InfoCell label="緯度・経度" value={`${facility.latitude}, ${facility.longitude}`} mono />
        <InfoCell label="最終確認" value={facility.lastVerifiedAt ? facility.lastVerifiedAt.slice(0, 10) : "—"} mono />
      </Card>

      {/* 位置の確認（docs/11: unverified→pending→verified。座標を変えると失効） */}
      <Card className="flex flex-col gap-3" aria-label="位置確認">
        <span className="text-[14px] font-bold">位置の確認</span>
        {facility.verificationStatus === "verified" ? (
          <p className="text-[13px] text-ink-sub">この座標（v{facility.locationVersion}）は現地確認済みです。座標を変更すると確認はリセットされます。</p>
        ) : (
          <div className="flex flex-col gap-2">
            <p className="text-[13px] text-ink-sub">現地で座標と目印が合っているかを確認します（点検結果とは別の確認です）。</p>
            <div className="flex gap-2">
              {facility.verificationStatus === "unverified" && (
                <Button variant="secondary" busy={reviewState === "busy"} onClick={() => void review("request")} className="max-lg:min-h-11">
                  確認を依頼
                </Button>
              )}
              {facility.verificationStatus === "pending" && (
                <Button busy={reviewState === "busy"} onClick={() => void review("verify")} className="max-lg:min-h-11">
                  現地で確認した（確認済みにする）
                </Button>
              )}
            </div>
            {reviewState === "conflict" && (
              <div role="alert" className="hairline rounded-card bg-[rgba(255,195,92,.08)] p-3 text-[13px] text-[#ffdca0]">
                他の操作で更新されています。画面を再読込してください。
              </div>
            )}
            {reviewState === "forbidden" && (
              <div role="alert" className="hairline rounded-card bg-[rgba(255,90,70,.08)] p-3 text-[13px] text-[#ffb0a4]">
                この操作は分団の管理者・幹部だけができます。
              </div>
            )}
            {reviewState === "missing" && (
              <div role="alert" className="hairline rounded-card bg-[rgba(255,90,70,.08)] p-3 text-[13px] text-[#ffb0a4]">
                この施設は、すでに削除されている可能性があります。
              </div>
            )}
            {reviewState === "unknown" && (
              <div role="alert" className="hairline rounded-card bg-[rgba(255,195,92,.08)] p-3 text-[13px] text-[#ffdca0]">
                結果を確認できません。通信を確認して、もう一度お試しください。同じ内容で再送しても二重には記録されません。
              </div>
            )}
          </div>
        )}
      </Card>

      <a
        href={buildMapsUrl(facility)}
        target="_blank"
        rel="noreferrer"
        className="hairline flex items-center gap-3 rounded-card bg-white/[.04] p-3.5 text-[13px] font-medium text-ink-sub"
      >
        <Icon name="directions" className="text-[20px] text-[#4f9bff]" />
        <span className="min-w-0 flex-1">Googleマップで経路を開く（座標 {facility.latitude}, {facility.longitude} を送ります）</span>
        <Icon name="open_in_new" className="text-[16px]" />
      </a>

      {/* 位置の履歴（docs/04 facility_location_revisions） */}
      <div className="flex flex-col gap-1 px-1">
        <span className="text-[14px] font-bold">位置の履歴</span>
        {facility.locationHistory.length === 0 && <span className="text-[13px] text-ink-muted">履歴はまだありません。</span>}
        {facility.locationHistory.map((h) => (
          <div key={h.id} className="grid grid-cols-[18px_1fr] gap-3 py-3">
            <span aria-hidden="true" className={`mt-1.5 size-2.5 rounded-full ${h.verificationStatus === "verified" ? "bg-ok" : h.verificationStatus === "pending" ? "bg-attention" : "bg-white/30"}`} />
            <div className="flex flex-col gap-[3px]">
              <span className="font-mono text-[12px] font-semibold text-ink-muted">
                {h.createdAt.slice(0, 10)} · 座標v{h.locationVersion}·{h.eventNo} · {h.verificationStatus === "verified" ? "確認済" : h.verificationStatus === "pending" ? "確認中" : "未確認"}
              </span>
              <span className="text-[14px] font-medium leading-[1.55]">{h.reason}</span>
            </div>
          </div>
        ))}
      </div>

      {/* 固定CTA（prototype「この施設を点検する」） */}
      <div className="sticky bottom-0 z-20 -mx-4 flex gap-2 bg-[linear-gradient(180deg,rgba(8,16,28,0),#08101c_35%)] px-4 pb-[30px] pt-3.5 max-lg:fixed max-lg:inset-x-0 max-lg:bottom-0 max-lg:m-0 max-lg:px-5">
        <Link
          to={`/app/facilities/${id}/inspections/new`}
          className="flex h-14 flex-1 items-center justify-center gap-2 rounded-pill bg-ember text-[16px] font-bold text-white shadow-[0_12px_28px_-8px_rgba(255,90,46,.7)]"
        >
          <Icon name="fact_check" className="text-[21px]" />
          この施設を点検する
        </Link>
      </div>
      <Notice tone="info" icon="info" role="status">
        位置の確認・点検の結果・異常の対応は、それぞれ別の記録です。
      </Notice>
    </div>
  );
}

function InfoCell({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="flex flex-col gap-1 bg-[#0d1626] p-3.5">
      <span className="text-[11px] font-medium text-ink-muted">{label}</span>
      <span className={`text-[15px] font-semibold ${mono ? "font-mono text-[14px]" : ""}`}>{value}</span>
    </div>
  );
}
