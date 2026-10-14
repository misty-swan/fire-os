import { useEffect, useState } from "react";
import { Link, useNavigate, useParams } from "react-router";
import { api } from "../../api";
import { PageTitle } from "../../components/Page";
import { Notice } from "../../components/ui";
import { Banner, Button, Card, Chip, Icon } from "../../components/ui";
import { AttachmentViewer } from "../attachments/AttachmentUploader";
import { buildMapsUrl } from "./location";
import { facilityName, locationStatusLabel, type FacilityItem } from "../map/useFacilities";

interface FacilityDetail extends FacilityItem {
  attachments: { id: string; status: string }[];
  locationHistory: RevisionRow[];
}

interface RevisionRow {
  id: string;
  locationVersion: number;
  eventNo: number;
  latitude: number;
  longitude: number;
  locationSource: string;
  verificationStatus: "unverified" | "pending" | "verified" | "rejected";
  verifiedByMemberId: string | null;
  verifiedAt: string | null;
  reason: string;
  createdAt: string;
}

/**
 * 施設の詳細（T022、SCR-04。prototype Facility）。台帳・写真・位置の出典と確認対象版・履歴・外部経路。
 * 位置確認・点検結果・異常対応を混同しない表示（docs/03 SCR-04）。
 */
export function FacilityPage() {
  const params = useParams<{ id: string }>();
  const navigate = useNavigate();
  const id = params.id!;
  const [facility, setFacility] = useState<FacilityDetail | "loading" | "notfound">("loading");
  const [history, setHistory] = useState<RevisionRow[]>([]);
  const [reviewState, setReviewState] = useState<"idle" | "requesting" | "verifying" | "done" | "conflict" | "denied">("idle");

  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const data = (await api("API-12", { params: { id }, query: { limit: 50 } })) as unknown as FacilityDetail;
        if (!alive) return;
        setFacility(data);
        setHistory(data.locationHistory);
      } catch {
        if (alive) setFacility("notfound");
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
        <PageTitle eyebrow="FACILITY" className="lg:hidden">
          施設の詳細
        </PageTitle>
        <Banner tone="info" eyebrow="NOT FOUND" title="この施設は存在しないか、閲覧できません">
          <Link to="/app/map" className="underline">マップへ戻る</Link>
        </Banner>
      </div>
    );
  }

  const status = locationStatusLabel[facility.verificationStatus];
  const statusTone = status.tone === "ok" ? "ok" : status.tone === "attention" ? "attention" : status.tone === "alert" ? "alert" : "neutral";
  const review = async (decision: "request" | "verify") => {
    setReviewState(decision === "request" ? "requesting" : "verifying");
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
      setReviewState("done");
      navigate(0);
    } catch {
      setReviewState("conflict");
    }
  };

  return (
    <div className="flex max-w-[720px] flex-col gap-4">
      {/* スマホ: 等幅の小見出し＋画面名（PCはヘッダーが画面名を出す） */}
      <PageTitle eyebrow="FACILITY" className="lg:hidden">
        施設の詳細
      </PageTitle>
      {/* スマホ: 戻る＋対象名。PCはヘッダー。読み込み中/不在は画面名だけ */}
      <div className="lg:hidden">
        <SubHeaderBack title={typeof facility === "string" ? "—" : facilityName(facility)} />
      </div>
      {/* 写真エリア（prototype: 280px・斜線のプレースホルダー。写真があれば先頭を表示） */}
      <div className="relative -mx-4 flex h-[280px] items-center justify-center bg-[linear-gradient(180deg,#16233a,#0b1422)] lg:mx-0 lg:rounded-[20px]">
        <span aria-hidden="true" className="absolute inset-0 bg-[repeating-linear-gradient(135deg,rgba(255,255,255,.035)_0_2px,transparent_2px_12px)]" />
        {facility.attachments.length > 0 ? (
          <div className="relative z-10 flex gap-2 p-4">
            {facility.attachments.slice(0, 3).map((a, i) => (
              <AttachmentViewer key={a.id} id={a.id} label={`施設写真${i + 1}`} />
            ))}
          </div>
        ) : (
          <span className="font-mono text-[10px] tracking-[.1em] text-[#5a6780]">施設写真 · FACILITY PHOTO</span>
        )}
      </div>

      <div className="flex flex-col gap-2 px-1">
        <div className="flex items-center gap-2">
          <Chip tone="neutral">{facility.type === "hydrant" ? "消火栓" : facility.type === "cistern" ? "防火水槽" : "格納箱"}</Chip>
          <Chip tone={statusTone}>位置：{status.text}</Chip>
        </div>
        <h2 className="text-[26px] font-bold leading-[1.3]">{facilityName(facility)}</h2>
        <p className="text-[13px] text-ink-sub">{facility.locationNote}</p>
      </div>

      <Card className="grid grid-cols-2 gap-px overflow-hidden bg-white/[.07] p-0">
        <InfoCell label="管理番号" value={facility.managementNumber ?? "—"} mono />
        <InfoCell label="識別名" value={facility.identifyingName ?? "—"} />
        <InfoCell label="位置の出典" value={facility.locationSource} />
        <InfoCell label="確認対象の座標版" value={`v${facility.locationVersion}`} mono />
        <InfoCell label="緯度・経度（外部マップへ送る値）" value={`${facility.latitude}, ${facility.longitude}`} mono />
        <InfoCell label="最終確認" value={facility.lastVerifiedAt ? facility.lastVerifiedAt.slice(0, 10) : "—"} mono />
      </Card>

      {/* 位置確認の操作（docs/11: unverified→pending→verified。座標を変えると失効する） */}
      <Card className="flex flex-col gap-3" aria-label="位置確認">
        <span className="text-[14px] font-bold">位置の確認</span>
        {facility.verificationStatus === "verified" ? (
          <p className="text-[13px] text-ink-sub">この座標（v{facility.locationVersion}）は現地確認済みです。座標を変更すると確認はりセットされます。</p>
        ) : (
          <div className="flex flex-col gap-2">
            <p className="text-[13px] text-ink-sub">現地で座標と目印が合っているかを確認します（点検結果とは別の確認です）。</p>
            <div className="flex gap-2">
              {facility.verificationStatus === "unverified" && (
                <Button variant="secondary" busy={reviewState === "requesting"} onClick={() => void review("request")} className="max-lg:min-h-11">
                  確認を依頼
                </Button>
              )}
              {facility.verificationStatus === "pending" && (
                <Button busy={reviewState === "verifying"} onClick={() => void review("verify")} className="max-lg:min-h-11">
                  現地で確認した（確認済みにする）
                </Button>
              )}
              {reviewState === "conflict" && (
                <div role="alert" className="hairline rounded-card bg-[rgba(255,195,92,.08)] p-3 text-[13px] text-[#ffdca0]">
                  他の操作で更新されています。画面を再読込してください。
                </div>
              )}
            </div>
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

      {/* 位置の履歴（docs/04 facility_location_revisions。座標版ごとの確認の記録） */}
      <div className="flex flex-col gap-1 px-1">
        <span className="text-[14px] font-bold">位置の履歴</span>
        {history.length === 0 && <span className="text-[13px] text-ink-muted">履歴はまだありません。</span>}
        {history.map((h) => {
          const st = locationStatusLabel[h.verificationStatus];
          return (
            <div key={h.id} className="grid grid-cols-[18px_1fr] gap-3 py-3">
              <span aria-hidden="true" className={`mt-1.5 size-2.5 rounded-full ${h.verificationStatus === "verified" ? "bg-ok" : h.verificationStatus === "pending" ? "bg-attention" : "bg-white/30"}`} />
              <div className="flex flex-col gap-[3px]">
                <span className="font-mono text-[12px] font-semibold text-ink-muted">
                  {h.createdAt.slice(0, 10)} · 座標v{h.locationVersion}·{h.eventNo} · {st.text}
                </span>
                <span className="text-[14px] font-medium leading-[1.55]">{h.reason}</span>
              </div>
            </div>
          );
        })}
      </div>

      {/* 固定CTA（prototype「この施設を点検する」）。点検入力はSCR-06（T033） */}
      <div className="fixed inset-x-0 bottom-0 z-20 flex gap-2 bg-[linear-gradient(180deg,rgba(8,16,28,0),#08101c_35%)] px-5 pb-[30px] pt-3.5 max-lg:left-0 lg:static lg:bg-none lg:px-0">
        <Button onClick={() => navigate(`/app/facilities/${id}/inspections/new`)} className="max-lg:flex-1">
          <Icon name="fact_check" className="text-[21px]" />
          この施設を点検する
        </Button>
      </div>
      <Notice tone="info" icon="info" role="status">
        位置の確認・点検の結果・異常の対応は、それぞれ別の記録です。
      </Notice>
    </div>
  );
}

function SubHeaderBack({ title }: { title: string }) {
  const navigate = useNavigate();
  return (
    <div className="flex items-center gap-2.5">
      <button type="button" aria-label="戻る" onClick={() => navigate(-1)} className="grid size-11 flex-none place-items-center rounded-full bg-white/[.06]">
        <Icon name="arrow_back" className="text-[22px]" />
      </button>
      <span className="truncate text-[16px] font-bold">{title}</span>
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
