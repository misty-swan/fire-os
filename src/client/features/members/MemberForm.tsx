import { useState, type FormEvent } from "react";
import { FormErrors, errorFor } from "../../components/FormErrors";
import { LeaveConfirm } from "../../components/LeaveConfirm";
import { MutationStatus } from "../../components/MutationStatus";
import { Button, TextField } from "../../components/ui";
import { useMutation } from "../../useMutation";
import type { MemberRow } from "./useMembers";

const split = (text: string) => text.split(/[,、\n]/).map((t) => t.trim()).filter(Boolean);

/** 氏名・役職・班・資格・入団日の入力（登録=API-03、基本項目の変更=API-04）。許可列は登録のときだけ入力できる。 */
export function MemberForm({ member, onSaved, onCancel }: { member?: MemberRow; onSaved: () => void; onCancel: () => void }) {
  const create = useMutation("API-03");
  const update = useMutation("API-04");
  const mut = member ? update : create;
  const [displayName, setDisplayName] = useState(member?.displayName ?? "");
  const [rank, setRank] = useState(member?.rank ?? "");
  const [squad, setSquad] = useState(member?.squad ?? "");
  const [quals, setQuals] = useState((member?.qualifications ?? []).join("、"));
  const [joinedOn, setJoinedOn] = useState(member?.joinedOn ?? "");
  const [phone, setPhone] = useState("");
  const [emergency, setEmergency] = useState("");
  const dirty = displayName !== (member?.displayName ?? "") || rank !== (member?.rank ?? "") || squad !== (member?.squad ?? "") || quals !== (member?.qualifications ?? []).join("、") || joinedOn !== (member?.joinedOn ?? "") || phone !== "" || emergency !== "";
  const issues = mut.state.kind === "invalid" ? mut.state.details : [];

  async function submit(e: FormEvent) {
    e.preventDefault();
    const priv = { ...(phone ? { phone } : {}), ...(emergency ? { emergencyContact: emergency } : {}) };
    const r = member
      ? await update.run({
          params: { id: member.id },
          body: {
            version: member.version,
            ...(displayName !== member.displayName ? { displayName } : {}),
            ...(rank !== (member.rank ?? "") ? { rank: rank || null } : {}),
            ...(squad !== (member.squad ?? "") ? { squad: squad || null } : {}),
            ...(quals !== member.qualifications.join("、") ? { qualifications: split(quals) } : {}),
            ...(joinedOn !== (member.joinedOn ?? "") ? { joinedOn: joinedOn || null } : {}),
          },
        })
      : await create.run({
          body: {
            displayName, status: "active",
            ...(rank ? { rank } : {}), ...(squad ? { squad } : {}),
            ...(split(quals).length ? { qualifications: split(quals) } : {}),
            ...(joinedOn ? { joinedOn } : {}),
            ...(Object.keys(priv).length ? { privateFields: priv } : {}),
          },
        });
    if (r) onSaved();
  }

  return (
    <form onSubmit={submit} noValidate className="flex flex-col gap-3.5">
      <LeaveConfirm dirty={dirty && mut.state.kind !== "saved"} />
      <FormErrors issues={issues} labels={{ displayName: "氏名", rank: "役職", squad: "班", qualifications: "資格・講習", joinedOn: "入団日" }} />
      <TextField name="displayName" label="氏名" value={displayName} onChange={(e) => setDisplayName(e.target.value)} error={errorFor(issues, "displayName")} autoComplete="off" />
      <div className="grid grid-cols-2 gap-3">
        <TextField name="rank" label="役職" value={rank} onChange={(e) => setRank(e.target.value)} error={errorFor(issues, "rank")} placeholder="例: 班長" />
        <TextField name="squad" label="班" value={squad} onChange={(e) => setSquad(e.target.value)} error={errorFor(issues, "squad")} placeholder="例: 2班" />
      </div>
      <TextField name="qualifications" label="資格・講習（「、」区切り）" value={quals} onChange={(e) => setQuals(e.target.value)} error={errorFor(issues, "qualifications")} hint="最大10件・各40文字まで" />
      <TextField name="joinedOn" label="入団日" type="date" value={joinedOn} onChange={(e) => setJoinedOn(e.target.value)} error={errorFor(issues, "joinedOn")} />
      {!member && (
        <fieldset className="flex flex-col gap-3 rounded-card bg-white/[.03] p-3.5">
          <legend className="px-1 text-[12px] font-bold text-ink-sub">連絡先（任意・本人と、その団員を担当する者だけが読めます）</legend>
          <TextField name="phone" label="電話番号" type="tel" value={phone} onChange={(e) => setPhone(e.target.value)} error={errorFor(issues, "privateFields.phone") ?? errorFor(issues, "phone")} className="font-mono" />
          <TextField name="emergencyContact" label="緊急連絡先" value={emergency} onChange={(e) => setEmergency(e.target.value)} error={errorFor(issues, "emergencyContact")} />
        </fieldset>
      )}
      <MutationStatus state={mut.state} toastBottom={100} />
      <div className="flex justify-end gap-2 pt-1">
        <button type="button" onClick={onCancel} className="h-[46px] rounded-pill bg-white/[.07] px-5 text-[13px] font-bold">
          キャンセル
        </button>
        <Button type="submit" busy={mut.saving} disabled={!displayName.trim() || (!!member && !dirty)} className="!h-[46px] !w-auto px-[22px] !text-[13px]">
          {mut.saving ? "保存しています…" : member ? "変更を保存" : "団員を登録"}
        </Button>
      </div>
    </form>
  );
}
