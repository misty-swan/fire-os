import { useState } from "react";
import { useNavigate } from "react-router";
import { api } from "../../api";
import { FormErrors } from "../../components/FormErrors";
import { LeaveConfirm } from "../../components/LeaveConfirm";
import { SubHeader } from "../../components/Page";
import { Button, Card, Chip, Icon, TextField, TextArea } from "../../components/ui";
import { AttachmentUploader } from "../attachments/AttachmentUploader";
import { getCurrentPosition } from "./location";
import { useMutation } from "../../useMutation";

const TYPE_OPTIONS = [
  { value: "hydrant", label: "消火栓" },
  { value: "cistern", label: "防火水槽" },
  { value: "box", label: "格納箱" },
] as const;

/** 施設の登録（SCR-05）。種別/番号または識別名/座標(GPSは明示の一回)/出典/目印/写真。 */
export function FacilityEditorPage() {
  const navigate = useNavigate();
  const [type, setType] = useState<(typeof TYPE_OPTIONS)[number]["value"]>("hydrant");
  const [managementNumber, setManagementNumber] = useState("");
  const [identifyingName, setIdentifyingName] = useState("");
  const [latitude, setLatitude] = useState("");
  const [longitude, setLongitude] = useState("");
  const [locationSource, setLocationSource] = useState("");
  const [locationNote, setLocationNote] = useState("");
  const [gpsState, setGpsState] = useState<"idle" | "locating" | "denied" | "done">("idle");
  const [draftId, setDraftId] = useState<string | undefined>(undefined);
  const [readyIds, setReadyIds] = useState<string[]>([]);
  const [busyAttachments, setBusyAttachments] = useState(false);
  const [touched, setTouched] = useState(false);
  /** 保存が完了したら離脱確認を外す（保存後の自動遷移を確認ダイアログで止めない） */
  const [completedId, setCompletedId] = useState<string | null>(null);
  const create = useMutation("API-11");

  const latNum = Number(latitude);
  const lngNum = Number(longitude);
  const errors: { field: string; reason: string }[] = [];
  if (touched) {
    if (!managementNumber.trim() && !identifyingName.trim()) errors.push({ field: "managementNumber", reason: "管理番号か識別名のどちらかが必要です" });
    if (!latitude.trim() || !Number.isFinite(latNum) || latNum < -90 || latNum > 90) errors.push({ field: "latitude", reason: "緯度は -90〜90 で入力してください" });
    if (!longitude.trim() || !Number.isFinite(lngNum) || lngNum < -180 || lngNum > 180) errors.push({ field: "longitude", reason: "経度は -180〜180 で入力してください" });
    if (!locationSource.trim()) errors.push({ field: "locationSource", reason: "位置の出典を入力してください" });
  }

  const locate = async () => {
    setGpsState("locating");
    try {
      const pos = await getCurrentPosition();
      setLatitude(pos.coords.latitude.toFixed(6));
      setLongitude(pos.coords.longitude.toFixed(6));
      setGpsState("done");
      if (!locationSource.trim()) setLocationSource("GPS");
    } catch {
      setGpsState("denied"); // 拒否・timeoutは手入力へ（docs/03 §4）。watchPositionは使わない
    }
  };

  const submit = async () => {
    setTouched(true);
    if (errors.length > 0 || busyAttachments) return;
    const result = await create.run({
      body: {
        type,
        latitude: latNum,
        longitude: lngNum,
        locationSource: locationSource.trim(),
        locationNote: locationNote.trim() || "未記入",
        ...(managementNumber.trim() ? { managementNumber: managementNumber.trim() } : {}),
        ...(identifyingName.trim() ? { identifyingName: identifyingName.trim() } : {}),
        ...(draftId ? { attachmentDraftId: draftId } : {}),
      },
    });
    if (result) {
      setCompletedId((result.data as { id: string }).id);
      setTouched(false);
      // 離脱確認の番が降りてから遷移する（同じ目で見える速さ）
      await new Promise((r) => setTimeout(r, 30));
      navigate(`/app/facilities/${(result.data as { id: string }).id}`);
    }
  };

  const gpsHint =
    gpsState === "denied"
      ? "位置情報を使えませんでした（拒否か圏外）。緯度・経度を手入力してください。"
      : gpsState === "done"
        ? "端末の位置を座標に入れました。誤差に注意して現地で確認してください。"
        : "押したときの一回だけ端末の位置を取得します（常時の追跡・記録はしません）。";

  return (
    <div className="flex max-w-[720px] flex-col gap-5">
      <SubHeader title="施設の登録" sub="台帳に無い施設を追加します" backTo="/app/map" right={<Chip tone="neutral">位置：未確認</Chip>} />
      <Card className="flex flex-col gap-4">
        <div className="flex flex-col gap-2">
          <span className="text-[12px] font-bold text-ink-sub">種別</span>
          <div className="flex gap-2">
            {TYPE_OPTIONS.map((t) => (
              <button
                key={t.value}
                type="button"
                aria-pressed={type === t.value}
                onClick={() => setType(t.value)}
                className={`flex min-h-11 flex-1 items-center justify-center gap-2 rounded-field text-[14px] font-bold ${type === t.value ? "bg-ember text-white" : "bg-white/[.06] text-ink-sub"}`}
              >
                {t.label}
              </button>
            ))}
          </div>
        </div>
        <TextField name="managementNumber" label="管理番号（識別名どちらか必須）" value={managementNumber} onChange={(e) => setManagementNumber(e.target.value)} placeholder="例: K-112" />
        <TextField name="identifyingName" label="識別名（番号が無い施設）" value={identifyingName} onChange={(e) => setIdentifyingName(e.target.value)} placeholder="例: 架空商店街の格納箱" />
        <div className="flex items-end gap-2">
          <div className="min-w-0 flex-1">
            <TextField name="latitude" label="緯度" inputMode="decimal" value={latitude} onChange={(e) => setLatitude(e.target.value)} />
          </div>
          <div className="min-w-0 flex-1">
            <TextField name="longitude" label="経度" inputMode="decimal" value={longitude} onChange={(e) => setLongitude(e.target.value)} />
          </div>
          <Button variant="secondary" busy={gpsState === "locating"} onClick={() => void locate()} className="max-lg:min-h-11 flex-none px-4">
            <Icon name="my_location" className="text-[18px]" />
            GPS
          </Button>
        </div>
        <p className="text-[12px] text-ink-muted">{gpsHint}</p>
        <TextField name="locationSource" label="位置の出典" value={locationSource} onChange={(e) => setLocationSource(e.target.value)} placeholder="例: 架空市台帳 / 現地測量 / GPS" />
        <TextArea name="locationNote" label="目印・場所のメモ" value={locationNote} onChange={(e) => setLocationNote(e.target.value)} placeholder="例: 1丁目交差点の北西、表示板の下" />
        <div className="flex flex-col gap-2">
          <span className="text-[12px] font-bold text-ink-sub">写真</span>
          <AttachmentUploader
            target={{ type: "facility" }}
            onReady={(ids, draft) => {
              setReadyIds(ids);
              if (draft) setDraftId(draft);
            }}
            onChange={setBusyAttachments}
          />
          {readyIds.length > 0 && <p className="text-[12px] text-ink-muted">検査の済んだ写真{readyIds.length}件をこの施設に紐付けます。</p>}
        </div>
        <FormErrors issues={errors} />
        {create.state.kind === "conflict" && (
          <div role="alert" className="hairline rounded-card bg-[rgba(255,195,92,.08)] p-3.5 text-[13px] text-[#ffdca0]">
            同じ種別・番号の施設が既に登録されています。内容を確認してください。
          </div>
        )}
        {create.state.kind === "rejected" && (
          <div role="alert" className="hairline rounded-card bg-[rgba(255,195,92,.08)] p-3.5 text-[13px] text-[#ffdca0]">
            この状態では実行できません。写真の検査が終わっていない場合は、完了してからもう一度登録してください。
          </div>
        )}
        {create.state.kind === "unknown" && (
          <div role="alert" className="hairline rounded-card bg-[rgba(255,195,92,.08)] p-3.5 text-[13px] text-[#ffdca0]">
            結果を確認できません。同じ内容で再送しても二重登録にはなりません。
          </div>
        )}
        <Button busy={create.saving || busyAttachments} onClick={() => void submit()}>
          {create.state.kind === "processing" ? "処理中（完了ではありません）" : "登録する"}
        </Button>
      </Card>
      <LeaveConfirm dirty={touched && !completedId} />
    </div>
  );
}
