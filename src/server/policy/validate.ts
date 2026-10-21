/**
 * 正式リリース判定（T088。docs/13_リリース判定基準.md v0.3・docs/16 T088）。
 *
 * - validateProductionPolicy(policy, decisions) は docs/13 §2 の全ゲート（RG-01〜10）と docs/14 §2 の
 *   決定項目（D01〜D20）を全ANDで判定する純関数（同期・I/Oなし・新規endpointなし。docs/16 T088の
 *   Interfaces どおり ProductionPolicy/DecisionRecord もこのmoduleで定義する）。
 *   ゲート1つでも不合格、決定1つでも承認不明（記録欠落・approved:false・回答空欄）・運用方針との
 *   不一致があれば allowed:false とし、失敗原因は短絡せず reasons に全て列挙する（docs/13 §3 手順2の
 *   「未定義/未実装/未実施/skipを列挙」に対応）。
 * - 採用範囲（docs/13 §1）: MAP-10/AI-06/AI-07 の3機能は D01 の採用確認待ちで除外しない。
 *   D01 が決まっていない間は判定対象の対象版を特定できないため、この3件を implicitlyExcludedRequirements
 *   （暗黙の対象外）に載せ allowed を false にする。これは無断除外ではなく「正式判定不可」の扱いである。
 *   D01 で明示的に除外と記録された場合は adoptionScope.explicitlyExcluded として可視化し
 *   implicitlyExcludedRequirements には載せない（暗黙の除外と明示的な除外を混ぜない＝正直な型）。
 *   D01 の回答が3機能の採否を言い切っていない場合は、その分を暗黙の対象外に戻す（部分的な回答で通さない）。
 * - D01 回答の読み取りは文単位（。/改行で分割）の決定的な規則だけを使う: 各機能IDを含む文に除外語
 *   （含めない/除外/対象外/見送り/外す等）があれば明示的な除外、次に否定随伴語（ません/ない/ぬ/不要/
 *   却下/辞退/見合わせ/未決/未定/後日/検討）があれば採用語（含め/採用/対象）があっても採用と読まず
 *   「明示されていない」扱いで暗黙の対象外にする（「対象にしません」「含めたくない」等の列挙外の否定形・
 *   未確定形を採用側に倒さないfail-closed。T088レビューA-3）。その後で採用語があれば採用、
 *   どれも無い（または言及自体が無い）場合も暗黙の対象外にする（閉じた側に倒す）。
 * - 現状の実ファイル（config/production-policy.json。回答空欄・approved:false・全ゲート不合格）を渡すと
 *   allowed:false・implicitlyExcludedRequirements=["MAP-10","AI-06","AI-07"] になる。これは docs/13 §4
 *   「現在の全RGは未達であり、本改訂をもって正式リリースを許可しない」どおりの正しい挙動であり不具合ではない。
 *   tests/production-policy.test.ts がこの実ファイルを読んで保証する（回答・承認の捏造の恒久的な防止）。
 */

/** docs/13 §2 の全ゲートID（全AND。例外での通過なし） */
export const RG_GATE_IDS = ["RG-01", "RG-02", "RG-03", "RG-04", "RG-05", "RG-06", "RG-07", "RG-08", "RG-09", "RG-10"] as const;
export type RgGateId = (typeof RG_GATE_IDS)[number];

/** docs/14 §2 の決定項目ID（D01〜D20。docs/13 §2 RG-08行の「D02〜20該当決定」の対象） */
export const DECISION_IDS = [
  "D01", "D02", "D03", "D04", "D05", "D06", "D07", "D08", "D09", "D10",
  "D11", "D12", "D13", "D14", "D15", "D16", "D17", "D18", "D19", "D20",
] as const;
export type DecisionId = (typeof DECISION_IDS)[number];

/** docs/13 §1: D01 の採用確認待ちで除外しない3機能（D01未決の間は暗黙の対象外＝正式判定不可） */
export const ADOPTION_PENDING_REQUIREMENT_IDS = ["MAP-10", "AI-06", "AI-07"] as const;

/** docs/13 §2 のゲート名（理由文の引用と、config/production-policy.json の gates.*.名前 との一致検査に使う） */
export const GATE_NAMES: Record<RgGateId, string> = {
  "RG-01": "全機能",
  "RG-02": "非機能",
  "RG-03": "全受入",
  "RG-04": "セキュリティ",
  "RG-05": "整合性/復旧",
  "RG-06": "AI品質",
  "RG-07": "地図/通知/同期/PWA",
  "RG-08": "許諾/体制",
  "RG-09": "本番/デモ分離",
  "RG-10": "阻害ゼロ",
};

/** 運用方針（config/production-policy.json）の1ゲート。判定は docs/13 §2 の合格条件に対する現時点の判定。 */
export type PolicyGate = {
  名前: string;
  判定: "合格" | "不合格";
  /** 合格根拠（docs/13 §3 手順2。担当者の自己申告だけで完了にしない。実在する証跡/承認を引用する） */
  根拠: string[];
  /** 実施済みと残手順の区別などの補足（任意） */
  注記?: string;
};

/** docs/14 §2 D01〜D20 の1項目。config/production-policy.example.json（T087テンプレート）と同じ6欄。 */
export type PolicyDecisionItem = {
  質問: string;
  現在の検証設定: string;
  代替案: string;
  意思決定者: string;
  /** 消防団の実回答。空欄の間は未承認として扱う */
  回答: string;
  approved: boolean;
};

export type PolicyMeta = {
  版: string;
  日付: string;
  注記: string;
  判定時点?: { 日付: string; 対象文書: string; "Git commit"?: string };
};

/** 運用方針の文書（meta＋RG-01〜10のゲート＋D01〜D20の項目）。 */
export type ProductionPolicy = {
  meta: PolicyMeta;
  gates: Record<RgGateId, PolicyGate>;
} & Record<DecisionId, PolicyDecisionItem>;

/** D01〜D20 の1件分の決定記録（docs/evidence/release-decision.md が台帳になる。docs/16 T088のInterfaces）。 */
export type DecisionRecord = {
  id: DecisionId;
  回答: string;
  approved: boolean;
  記録日?: string;
  記録者?: string;
};

/** D01〜D20 の1項目あたりの判定結果（reasons の分類用） */
export type DecisionFinding =
  | "approved"
  | "itemMissing"
  | "recordMissing"
  | "recordDuplicated"
  | "recordUnapproved"
  | "recordAnswerEmpty"
  | "itemUnapproved"
  | "answerMismatch";

/** D01 の採否記録の反映。明示的な除外を可視化して「無断除外でないこと」を示す（docs/13 §1）。 */
export type AdoptionScope = {
  /** D01 が承認済み・回答付き・運用方針と一致で決まっているか */
  decided: boolean;
  /** 明示的に採用すると記録された要件ID（ADOPTION_PENDING_REQUIREMENT_IDS の部分集合） */
  adopted: string[];
  /** 明示的に除外すると記録された要件ID（暗黙の対象外とは区別する） */
  explicitlyExcluded: string[];
};

export type PolicyValidation = {
  /** docs/13 §2 の全AND: 全ゲート合格 ＋ D01〜D20 全項目の承認済み・一致 ＋ D01 の採否の明示 */
  allowed: boolean;
  /** 失敗原因の全列挙（短絡しない。各理由は RG-/D- のIDを引用する。日本語） */
  reasons: string[];
  /** D01 が未決（または採否を明示していない）ために暗黙の対象外になっている要件ID */
  implicitlyExcludedRequirements: string[];
  /** D01 の採否記録の反映（明示的な除外を含む） */
  adoptionScope: AdoptionScope;
  gateResults: Record<RgGateId, "合格" | "不合格">;
  decisionResults: Record<DecisionId, DecisionFinding>;
};

// D01 回答の文単位の採否判定語（docs/13 §1 の「明示的な訂正」を機械で確認できる形に限定する。
// 曖昧な場合は採用と読まず暗黙の対象外に戻す＝閉じた側に倒す）。判定の順序は 除外語 → 否定随伴語 → 採用語。
const ADOPTION_EXCLUSION_PATTERN = /(含めない|含めません|含まない|除外|対象外|採用しない|採用しません|見送り|見送る|外す|外し|外さ)/;
// 否定随伴語: これを含む文は採用語（含め/採用/対象）があっても採用と読まない（列挙外の否定形・未確定形の
// 取りこぼしを閉じた側に倒す。除外語の明示的な列挙と重ならない形は暗黙の対象外＝曖昧扱い。T088レビューA-3/F4）。
const ADOPTION_NEGATION_PATTERN = /(ません|ない|ぬ|不要|却下|辞退|見合わせ|未決|未定|後日|検討)/;
const ADOPTION_INCLUSION_PATTERN = /(含め|採用|対象)/;

function classifyAdoptionAnswer(answer: string): { adopted: string[]; explicitlyExcluded: string[]; ambiguous: string[] } {
  const sentences = answer
    .split(/[。\n]/)
    .map((s) => s.trim())
    .filter((s) => s !== "");
  const adopted: string[] = [];
  const explicitlyExcluded: string[] = [];
  const ambiguous: string[] = [];
  for (const reqId of ADOPTION_PENDING_REQUIREMENT_IDS) {
    const sentence = sentences.find((s) => s.includes(reqId));
    if (sentence === undefined) {
      ambiguous.push(reqId);
    } else if (ADOPTION_EXCLUSION_PATTERN.test(sentence)) {
      explicitlyExcluded.push(reqId);
    } else if (ADOPTION_NEGATION_PATTERN.test(sentence)) {
      // 「対象にしません」「含めたくない」「後日確定する」等の列挙外の否定形・未確定形は採用と読まず曖昧（暗黙の対象外）へ倒す
      ambiguous.push(reqId);
    } else if (ADOPTION_INCLUSION_PATTERN.test(sentence)) {
      adopted.push(reqId);
    } else {
      ambiguous.push(reqId);
    }
  }
  return { adopted, explicitlyExcluded, ambiguous };
}

/** 理由文へ注記を引用するときの長さ制限（理由の可読性優先。全文は実ファイルを参照させる） */
function noteExcerpt(note: string | undefined): string {
  if (note === undefined || note.trim() === "") return "";
  const trimmed = note.trim();
  return `〔${trimmed.length > 60 ? `${trimmed.slice(0, 60)}…` : trimmed}〕`;
}

/**
 * 運用方針と決定記録から正式リリースの可否を判定する（docs/13 §2 全AND・§3 判定手順）。
 * 純関数: I/O・時計・乱数に依存せず、引数の内容だけで決まる。
 */
export function validateProductionPolicy(policy: ProductionPolicy, decisions: DecisionRecord[]): PolicyValidation {
  const reasons: string[] = [];

  // ---- ゲート（docs/13 §2 の全AND。1つでも不合格なら不可） ----
  const gateResults = {} as Record<RgGateId, "合格" | "不合格">;
  for (const id of RG_GATE_IDS) {
    const gate = policy.gates?.[id];
    if (!gate) {
      gateResults[id] = "不合格";
      reasons.push(`${id}（${GATE_NAMES[id]}）のゲート項目が運用方針にありません（docs/13 §2の全ゲートが必要）`);
      continue;
    }
    if (gate.判定 !== "合格") {
      gateResults[id] = "不合格";
      reasons.push(`${id}（${GATE_NAMES[id]}）が合格ではありません: 判定=${gate.判定}${noteExcerpt(gate.注記)}`);
      continue;
    }
    if (!Array.isArray(gate.根拠) || gate.根拠.filter((e) => typeof e === "string" && e.trim() !== "").length === 0) {
      gateResults[id] = "不合格";
      reasons.push(`${id}（${GATE_NAMES[id]}）に合格根拠がありません（docs/13 §3 手順2。担当者の自己申告だけで完了にしない）`);
      continue;
    }
    gateResults[id] = "合格";
  }

  // ---- 決定記録の受け口（未知のIDは拒否。同一IDの重複は1項目1回答の破れとして拒否） ----
  const recordsById = new Map<string, DecisionRecord[]>();
  for (const record of decisions) {
    if (!(DECISION_IDS as readonly string[]).includes(record.id)) {
      reasons.push(`決定記録に未知のIDがあります: ${String(record.id)}（D01〜D20 のIDのみを受け付ける）`);
      continue;
    }
    const same = recordsById.get(record.id) ?? [];
    same.push(record);
    recordsById.set(record.id, same);
  }
  for (const id of DECISION_IDS) {
    const same = recordsById.get(id) ?? [];
    if (same.length > 1) {
      reasons.push(`${id} の決定記録が${same.length}件あります（1項目1回答。重複する記録を承認とは扱わない）`);
    }
  }

  // ---- 決定項目（docs/13 §2 RG-08行・docs/14 §2。承認不明・不一致は不可） ----
  const decisionResults = {} as Record<DecisionId, DecisionFinding>;
  for (const id of DECISION_IDS) {
    const item = policy[id];
    const records = recordsById.get(id) ?? [];
    if (!item) {
      decisionResults[id] = "itemMissing";
      reasons.push(`${id} の運用方針の項目がありません（docs/14 §2 のD01〜D20が正本）`);
      continue;
    }
    if (records.length === 0) {
      decisionResults[id] = "recordMissing";
      reasons.push(`${id} の決定記録がありません（承認不明。docs/14 §2 の回答とapprovedを記録するまで承認済みとは扱わない）`);
      continue;
    }
    if (records.length > 1) {
      decisionResults[id] = "recordDuplicated";
      continue; // 理由は重複検出で追加済み
    }
    const record = records[0]!;
    if (record.approved !== true) {
      decisionResults[id] = "recordUnapproved";
      reasons.push(`${id} の決定記録が承認されていません（approved=false＝承認不明）`);
      continue;
    }
    if (typeof record.回答 !== "string" || record.回答.trim() === "") {
      decisionResults[id] = "recordAnswerEmpty";
      reasons.push(`${id} の決定記録の回答が空です（回答の無い承認は扱わない）`);
      continue;
    }
    if (item.approved !== true) {
      decisionResults[id] = "itemUnapproved";
      reasons.push(`${id} の運用方針の approved が true ではありません（決定記録と運用方針の両方を揃える）`);
      continue;
    }
    if (item.回答 !== record.回答) {
      decisionResults[id] = "answerMismatch";
      reasons.push(`${id} の回答が運用方針と決定記録で一致しません（不一致の承認は不可。同じ回答を両方へ記録する）`);
      continue;
    }
    decisionResults[id] = "approved";
  }

  // ---- 採用範囲（docs/13 §1。D01が決まるまで対象版を特定できず正式判定不可） ----
  const adoptionScope: AdoptionScope = { decided: false, adopted: [], explicitlyExcluded: [] };
  let implicitlyExcludedRequirements: string[] = [...ADOPTION_PENDING_REQUIREMENT_IDS];
  if (decisionResults.D01 === "approved") {
    const d01Answer = recordsById.get("D01")![0]!.回答;
    const classified = classifyAdoptionAnswer(d01Answer);
    adoptionScope.decided = true;
    adoptionScope.adopted = classified.adopted;
    adoptionScope.explicitlyExcluded = classified.explicitlyExcluded;
    if (classified.ambiguous.length === 0) {
      implicitlyExcludedRequirements = [];
    } else {
      implicitlyExcludedRequirements = classified.ambiguous;
      for (const reqId of classified.ambiguous) {
        reasons.push(`D01 の回答が ${reqId} の採否を明示していないため、暗黙の対象外として扱います（docs/13 §1。明示の記録が無い除外を承認に使わない）`);
      }
    }
  } else {
    reasons.push(
      `D01 が未決のため判定対象の対象版を特定できず、正式判定ができません（docs/13 §1。MAP-10・AI-06・AI-07 は暗黙の対象外＝無断除外ではないが、採否を D01 に記録するまで正式リリースは不可）`,
    );
  }

  return {
    allowed: reasons.length === 0,
    reasons,
    implicitlyExcludedRequirements,
    adoptionScope,
    gateResults,
    decisionResults,
  };
}
