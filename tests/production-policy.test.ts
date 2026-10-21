import { describe, expect, it } from "vitest";
// 実ファイルのアンカー（?raw で読めたものだけを検査する＝存在の証明。docs/16 T088 の Files）。
// 実回答が無い現状では全ゲート不合格・全項目未承認＝allowed:false が正しい挙動であることを
// 実ファイルごと機械で保証する（回答・承認の捏造を恒久的に防ぐ）。
import policyRaw from "../config/production-policy.json?raw";
import exampleRaw from "../config/production-policy.example.json?raw";
import releaseDecisionRaw from "../docs/evidence/release-decision.md?raw";
import productionStartRaw from "../ops/production-start.md?raw";
import { textApprovalIssues } from "../scripts/check-adoption-proposal";
import {
  DECISION_IDS,
  GATE_NAMES,
  RG_GATE_IDS,
  validateProductionPolicy,
  type DecisionId,
  type DecisionRecord,
  type PolicyDecisionItem,
  type ProductionPolicy,
  type RgGateId,
} from "../src/server/policy/validate";

/**
 * 正式リリース判定（T088。docs/13_リリース判定基準.md v0.3・docs/16 T088）。
 *
 * - validateProductionPolicy（src/server/policy/validate.ts。docs/16 T088 の Interfaces）は
 *   docs/13 §2 の全ゲート（RG-01〜10）と docs/14 §2 の決定項目（D01〜D20）を全ANDで判定する純関数。
 *   ゲート1つでも不合格、決定1つでも承認不明・不一致なら allowed:false になり、
 *   失敗原因は短絡せず reasons に全て列挙されることを試す。
 * - docs/16 T088 手順1の入力: 「RG一つ不合格、承認不明、復元未実施、採否未記録」。
 *   完成後の実際の回答が揃って初めて allGatesAndDecisions が allowed:true になる（合成入力で確認）。
 * - 実ファイル（config/production-policy.json）は T087 のテンプレートから生成した判定時点の記録であり、
 *   回答は空欄・approved は false。ゆえに validateProductionPolicy の allowed:false は不具合ではなく、
 *   docs/13 §4「現在の全RGは未達であり、正式リリースを許可しない」どおりの正しい挙動である。
 * - 陽性対照: 各検出器は「注入した違反」を必ず拾うことをその場で試す（恒真断言にしない）。
 *   検出器ごとに合成入力のコピーへ違反を注入し、そのゲート/決定IDを引用する理由で落ちることを断言する。
 */

const exampleItems = JSON.parse(exampleRaw) as ProductionPolicy;

// 試験用の合成回答（実ファイルの回答欄は空欄のまま。ここで書く値は合成入力であり、実回答を装わない）
const syntheticAnswer = (id: DecisionId): string =>
  id === "D01"
    ? "MAP-10・AI-06・AI-07の3機能を含めて正式採用する（試験用の合成回答）。"
    : `${id} の推奨案どおりに了承する（試験用の合成回答）。`;

const allPassGates = (): ProductionPolicy["gates"] => {
  const gates = {} as ProductionPolicy["gates"];
  for (const id of RG_GATE_IDS) {
    gates[id] = { 名前: id, 判定: "合格", 根拠: ["試験用の合成根拠（docs/13 §2の各ゲート条件を満たすという設定）"] };
  }
  return gates;
};

const approvedItems = (): Record<DecisionId, PolicyDecisionItem> => {
  const items = {} as Record<DecisionId, PolicyDecisionItem>;
  for (const id of DECISION_IDS) {
    items[id] = { ...exampleItems[id], 回答: syntheticAnswer(id), approved: true };
  }
  return items;
};

/** 全ゲート合格＋D01〜D20承認済み（D01は3機能の採用を明示）の合成入力 */
const allPassPolicy = (): ProductionPolicy => ({
  meta: { 版: "test-production-policy", 日付: "2026-10-21", 注記: "試験用の合成入力（実ファイルではない）" },
  gates: allPassGates(),
  ...approvedItems(),
});

const allApprovedDecisions = (): DecisionRecord[] =>
  DECISION_IDS.map((id) => ({ id, 回答: syntheticAnswer(id), approved: true, 記録日: "2026-10-21", 記録者: "試験用の合成記録" }));

const withGate = (policy: ProductionPolicy, id: RgGateId, gate: Partial<ProductionPolicy["gates"][RgGateId]>): ProductionPolicy => {
  const gates: ProductionPolicy["gates"] = { ...policy.gates };
  gates[id] = { ...gates[id], ...gate };
  return { ...policy, gates };
};

const withItem = (policy: ProductionPolicy, id: DecisionId, patch: Partial<PolicyDecisionItem>): ProductionPolicy => {
  const next: ProductionPolicy = { ...policy };
  next[id] = { ...next[id], ...patch };
  return next;
};

const withoutDecision = (decisions: DecisionRecord[], id: DecisionId): DecisionRecord[] => decisions.filter((d) => d.id !== id);

const withDecision = (decisions: DecisionRecord[], id: DecisionId, patch: Partial<DecisionRecord>): DecisionRecord[] =>
  decisions.map((d) => (d.id === id ? { ...d, ...patch } : d));

describe("production-policy (T088)", () => {
  it("formal_release_is_denied_if_any_gate_or_required_decision_is_missing", () => {
    // ---- docs/16 T088 手順1の4断言（変数名を含め原文どおり） ----
    // 入力: 「RG一つ不合格（RG-05 復元未実施）、承認不明（D10 の決定記録なし）、採否未記録（D01 未決）」
    const passingPolicy = allPassPolicy();
    const passingDecisions = allApprovedDecisions();

    // 復元未実施（RG-05 不合格）を1つ入れるだけで正式リリースは不可
    const oneMissingGate = validateProductionPolicy(
      withGate(passingPolicy, "RG-05", {
        判定: "不合格",
        根拠: ["docs/evidence/acceptance-results.md X-V07-RESTORE（実D1/R2での復元演習。未実施）"],
      }),
      passingDecisions,
    );
    expect(oneMissingGate.allowed).toBe(false);

    // 承認不明（D10 の決定記録が無い）を1つ入れるだけでも不可
    const oneMissingDecision = validateProductionPolicy(passingPolicy, withoutDecision(passingDecisions, "D10"));
    expect(oneMissingDecision.allowed).toBe(false);

    // 全ゲート合格＋D01〜D20承認済み（D01が3機能の採用を明示）で初めて許可される
    const allGatesAndDecisions = validateProductionPolicy(passingPolicy, passingDecisions);
    expect(allGatesAndDecisions.allowed).toBe(true);
    const implicitlyExcludedRequirements = allGatesAndDecisions.implicitlyExcludedRequirements;
    expect(implicitlyExcludedRequirements).toEqual([]);

    // 採否未記録（D01を未決のまま）にすると3機能は暗黙の対象外になり、正式判定も不可（docs/13 §1）
    const undecidedD01 = validateProductionPolicy(passingPolicy, withoutDecision(passingDecisions, "D01"));
    expect(undecidedD01.allowed).toBe(false);
    expect(undecidedD01.implicitlyExcludedRequirements).toEqual(["MAP-10", "AI-06", "AI-07"]);
    expect(undecidedD01.adoptionScope.decided).toBe(false);

    // ---- 実ファイルアンカー: 現状の実回答が無い状態では allowed:false が正しい挙動 ----
    const realPolicy = JSON.parse(policyRaw) as ProductionPolicy;
    expect(realPolicy.meta.版).toBe("production-policy-v1");
    expect(realPolicy.meta.日付).toBe("2026-10-21");
    const realValidation = validateProductionPolicy(realPolicy, []);
    expect(realValidation.allowed).toBe(false);
    // 実ファイルの全ゲートが不合格で、reasons が全ゲート・全決定を短絡せず列挙する
    for (const id of RG_GATE_IDS) {
      expect(realPolicy.gates[id].判定, id).toBe("不合格");
      expect(realValidation.gateResults[id], id).toBe("不合格");
      expect(realValidation.reasons.some((r) => r.includes(id)), id).toBe(true);
    }
    // 実ファイルの10ゲートの「名前」は validate.ts の GATE_NAMES と一致する（docs/13 §2の名前の重複の一致検査。F9/C-3）
    for (const id of RG_GATE_IDS) {
      expect(realPolicy.gates[id].名前, id).toBe(GATE_NAMES[id]);
    }
    for (const id of DECISION_IDS) {
      expect(realValidation.reasons.some((r) => r.includes(id)), id).toBe(true);
    }
    // D01が未決のため docs/13 §1 どおり3機能が暗黙の対象外（無断除外ではなく正式判定不可の扱い）
    expect(realValidation.implicitlyExcludedRequirements).toEqual(["MAP-10", "AI-06", "AI-07"]);
    expect(realValidation.adoptionScope.decided).toBe(false);

    // ---- 捏造防止: 実 config の D01〜D20 はテンプレート（example）と項目単位で完全一致。回答空欄・approved:false 厳密 ----
    for (const id of DECISION_IDS) {
      expect(realPolicy[id], `${id} の項目`).toEqual(exampleItems[id]);
      expect(realPolicy[id].回答, `${id} の回答`).toBe("");
      expect(realPolicy[id].approved, `${id} のapproved`).toBe(false);
    }

    // ---- 陽性対照1: ゲート1つの不合格は必ず拾う（全10ゲートを順に不合格へ反転） ----
    for (const id of RG_GATE_IDS) {
      const v = validateProductionPolicy(withGate(passingPolicy, id, { 判定: "不合格" }), passingDecisions);
      expect(v.allowed, id).toBe(false);
      expect(v.reasons.some((r) => r.includes(id)), `${id} を引用する理由`).toBe(true);
      expect(v.gateResults[id], id).toBe("不合格");
    }

    // ---- 陽性対照2: 決定記録の欠落（承認不明）は必ず拾う（全20項目を順に外す） ----
    for (const id of DECISION_IDS) {
      const v = validateProductionPolicy(passingPolicy, withoutDecision(passingDecisions, id));
      expect(v.allowed, id).toBe(false);
      expect(v.reasons.some((r) => r.includes(id)), `${id} を引用する理由`).toBe(true);
    }

    // ---- 陽性対照3: approved:false（承認不明の記録）と回答空欄の承認も拾う ----
    for (const id of DECISION_IDS) {
      const v = validateProductionPolicy(passingPolicy, withDecision(passingDecisions, id, { approved: false }));
      expect(v.allowed, id).toBe(false);
      expect(v.reasons.some((r) => r.includes(id) && r.includes("承認")), `${id} の承認不明`).toBe(true);
    }
    const emptyAnswer = validateProductionPolicy(
      withItem(passingPolicy, "D07", { 回答: "" }),
      withDecision(passingDecisions, "D07", { 回答: "" }),
    );
    expect(emptyAnswer.allowed).toBe(false);
    expect(emptyAnswer.reasons.some((r) => r.includes("D07") && r.includes("回答が空"))).toBe(true);

    // ---- 陽性対照4: 運用方針の項目と決定記録の不一致（回答の不一致・approved の片側だけ true）は拾う ----
    const answerMismatch = validateProductionPolicy(
      withItem(passingPolicy, "D07", { 回答: "了承しない（試験用の不一致回答）" }),
      passingDecisions,
    );
    expect(answerMismatch.allowed).toBe(false);
    expect(answerMismatch.reasons.some((r) => r.includes("D07") && r.includes("一致しません"))).toBe(true);
    const itemUnapproved = validateProductionPolicy(withItem(passingPolicy, "D11", { approved: false }), passingDecisions);
    expect(itemUnapproved.allowed).toBe(false);
    expect(itemUnapproved.reasons.some((r) => r.includes("D11") && r.includes("approved"))).toBe(true);

    // ---- 陽性対照5: 同一項目の決定記録の重複（1項目1回答の破り）と未知のIDは拒否する ----
    const duplicated = validateProductionPolicy(passingPolicy, [...passingDecisions, { ...passingDecisions[4]! }]);
    expect(duplicated.allowed).toBe(false);
    expect(duplicated.reasons.some((r) => r.includes("D05"))).toBe(true);
    const unknownId = validateProductionPolicy(passingPolicy, [
      ...passingDecisions,
      { id: "D21", 回答: "試験用の合成回答", approved: true } as unknown as DecisionRecord,
    ]);
    expect(unknownId.allowed).toBe(false);
    expect(unknownId.reasons.some((r) => r.includes("D21") && r.includes("未知"))).toBe(true);

    // ---- 陽性対照6: D01で明示的な除外を記録した場合は暗黙の対象外にしない（採用範囲を可視化して無断除外でないことを示す） ----
    const exclusionAnswer = "MAP-10・AI-06・AI-07は今回の正式採用の対象から除外すると記録する（利用者の明示的な訂正）。";
    const explicitExclusion = validateProductionPolicy(
      withItem(passingPolicy, "D01", { 回答: exclusionAnswer }),
      withDecision(passingDecisions, "D01", { 回答: exclusionAnswer }),
    );
    expect(explicitExclusion.allowed).toBe(true);
    expect(explicitExclusion.implicitlyExcludedRequirements).toEqual([]);
    expect(explicitExclusion.adoptionScope.decided).toBe(true);
    expect(explicitExclusion.adoptionScope.adopted).toEqual([]);
    expect(explicitExclusion.adoptionScope.explicitlyExcluded).toEqual(["MAP-10", "AI-06", "AI-07"]);
    // 全パス合成入力の採用範囲（対照。3機能とも明示採用）
    expect(allGatesAndDecisions.adoptionScope.decided).toBe(true);
    expect(allGatesAndDecisions.adoptionScope.adopted).toEqual(["MAP-10", "AI-06", "AI-07"]);
    expect(allGatesAndDecisions.adoptionScope.explicitlyExcluded).toEqual([]);

    // ---- 陽性対照7: D01の回答が3機能の採否を言い切っていない場合は暗黙の対象外に戻す（部分的な回答で通さない） ----
    const partialAnswer = "MAP-10は含めて採用する。";
    const partialD01 = validateProductionPolicy(
      withItem(passingPolicy, "D01", { 回答: partialAnswer }),
      withDecision(passingDecisions, "D01", { 回答: partialAnswer }),
    );
    expect(partialD01.allowed).toBe(false);
    expect(partialD01.implicitlyExcludedRequirements).toEqual(["AI-06", "AI-07"]);
    expect(partialD01.reasons.some((r) => r.includes("AI-06") && r.includes("明示"))).toBe(true);

    // ---- 陽性対照8: 短絡しない（ゲートと複数の決定の失敗原因を全て列挙する） ----
    const multiple = validateProductionPolicy(
      withGate(withItem(passingPolicy, "D11", { approved: false }), "RG-05", { 判定: "不合格" }),
      withoutDecision(withDecision(passingDecisions, "D11", { approved: false }), "D10"),
    );
    expect(multiple.allowed).toBe(false);
    expect(multiple.reasons.some((r) => r.includes("RG-05"))).toBe(true);
    expect(multiple.reasons.some((r) => r.includes("D10"))).toBe(true);
    expect(multiple.reasons.some((r) => r.includes("D11"))).toBe(true);

    // ---- 陽性対照9: 列挙外の否定形（「対象にしません」「含めたくない」）は採用と読まず暗黙の対象外にする（F4/A-3。fail-closed） ----
    for (const negatedAnswer of ["AI-06 は対象にしません。", "MAP-10 は含めたくない。"]) {
      const negatedD01 = validateProductionPolicy(
        withItem(passingPolicy, "D01", { 回答: negatedAnswer }),
        withDecision(passingDecisions, "D01", { 回答: negatedAnswer }),
      );
      expect(negatedD01.allowed, negatedAnswer).toBe(false);
      expect(negatedD01.adoptionScope.adopted, negatedAnswer).toEqual([]);
      expect(negatedD01.adoptionScope.explicitlyExcluded, negatedAnswer).toEqual([]);
      // 否定随伴語を含む文の機能も言及の無い機能も、どちらも暗黙の対象外（明示的な除外とは混ぜない）
      expect(negatedD01.implicitlyExcludedRequirements, negatedAnswer).toEqual(["MAP-10", "AI-06", "AI-07"]);
      expect(negatedD01.reasons.some((r) => r.includes("明示")), negatedAnswer).toBe(true);
    }
    // 対照: 普通の肯定文は従来どおり採用と読む（否定形の強化で肯定側を壊していないことの固定）
    const affirmativeAnswer = "MAP-10・AI-06・AI-07の3機能を含めて採用します。";
    const affirmativeD01 = validateProductionPolicy(
      withItem(passingPolicy, "D01", { 回答: affirmativeAnswer }),
      withDecision(passingDecisions, "D01", { 回答: affirmativeAnswer }),
    );
    expect(affirmativeD01.allowed).toBe(true);
    expect(affirmativeD01.implicitlyExcludedRequirements).toEqual([]);
    expect(affirmativeD01.adoptionScope.adopted).toEqual(["MAP-10", "AI-06", "AI-07"]);
    expect(affirmativeD01.adoptionScope.explicitlyExcluded).toEqual([]);
  });
});

/**
 * docs整合試験（T088 D2）: docs/evidence/release-decision.md と ops/production-start.md が
 * config/production-policy.json の判定（全ゲート不合格＝正式リリース不可・D01〜D20回答空欄・approved:false）
 * と整合していること、どちらの文書も承認を装う主張を含まないことを機械で守る。
 * - 承認主張の検出は T087 の scripts/check-adoption-proposal.ts の textApprovalIssues を再利用する
 *   （「未承認」等の語が同じ文にあっても主張を相殺しない・approved:false のフィールド参照だけが例外、
 *   というT087と同じ正直な否定の規則。両文書はこの検出器の未承認値トークン〔$5・RTO/RPO等〕の
 *   ラベル規約も同じく守る）。文書を直すときに正当な表現が拾われた場合は、検出器を緩めずに
 *   T087のホワイトリスト前例〔scripts/check-adoption-proposal.ts APPROVAL_CLAIM_WHITELIST〕と同様に
 *   ここへ例外の根拠をコメントで記録する。
 * - この試験は「v1の正直な現状」を固定する。回答を記録して production-policy.json を更新する改訂では、
 *   本試験と実ファイルアンカー（上のit）を docs/evidence/release-decision.md §5 ⑦ どおり一緒に更新する
 *   （現状のままだと改訂後の文書が承認の記録を含んで赤になる。それは試験が仕事をしている）。
 */
describe("production-policy docs consistency (T088 D2)", () => {
  // 運用方針で「不合格」のゲートID（ハードコードせず実ファイルから読む）
  const failingGateIds = (): RgGateId[] => {
    const policy = JSON.parse(policyRaw) as ProductionPolicy;
    return RG_GATE_IDS.filter((id) => policy.gates[id].判定 === "不合格");
  };
  // 検出器: 不合格ゲートのうち判定記録に載っていないID
  const missingGateIdsIn = (doc: string): RgGateId[] => failingGateIds().filter((id) => !doc.includes(id));
  // 検出器: 「正式リリース不可」の明示が無いときの違反
  const denialMissing = (doc: string): string[] => (doc.includes("正式リリース不可") ? [] : ["正式リリース不可"]);
  // 検出器: T087と同じ規則での承認主張（両文書を別々に走査する）。
  // textApprovalIssues の失敗メッセージの文書名ラベルはT087の2文書前提（1引数が常に「提案資料」）のため、
  // 1文書ずつ走査して実ファイル名のラベルへ付け替える（検出規則自体はT087と同じ。F9/D2 Minor2）
  const approvalClaimsIn = (docLabel: string, doc: string): string[] =>
    textApprovalIssues(doc, "").map((m) => (m.startsWith("提案資料: ") ? `${docLabel}${m.slice("提案資料: ".length)}` : m));
  // 検出器: production-start.md の実行ゲートの文（「実行しない」/「実行禁止」を含む文が1つも無いときの違反）
  const gatingSentenceMissing = (doc: string): string[] => {
    const sentences = doc
      .split(/\n/)
      .flatMap((line) => line.split(/。|！|？/))
      .map((s) => s.trim())
      .filter((s) => s !== "");
    return sentences.some((s) => s.includes("実行しない") || s.includes("実行禁止"))
      ? []
      : ["実行しない／実行禁止を含む文がありません"];
  };

  it("release_decision_and_production_start_docs_match_the_policy_judgment", () => {
    // ---- docs/evidence/release-decision.md: 全10ゲートID・正式リリース不可・暗黙除外の3要件ID ----
    for (const id of RG_GATE_IDS) {
      expect(releaseDecisionRaw.includes(id), `${id} のゲート別判定`).toBe(true);
    }
    expect(denialMissing(releaseDecisionRaw)).toEqual([]);
    for (const reqId of ["MAP-10", "AI-06", "AI-07"]) {
      expect(releaseDecisionRaw.includes(reqId), `${reqId} の暗黙の対象外の明示`).toBe(true);
    }
    // 運用方針で不合格のゲートは全て判定記録に載っている（実ファイルからの一致検査。ハードコードしない）
    expect(missingGateIdsIn(releaseDecisionRaw)).toEqual([]);

    // ---- ops/production-start.md: 正本と機械検証への参照・実行ゲートの文 ----
    expect(productionStartRaw.includes("docs/13_リリース判定基準.md")).toBe(true);
    expect(productionStartRaw.includes("production-policy.json")).toBe(true);
    expect(
      productionStartRaw.includes("validateProductionPolicy") ||
        productionStartRaw.includes("tests/production-policy.test.ts"),
    ).toBe(true);
    expect(gatingSentenceMissing(productionStartRaw)).toEqual([]);

    // ---- 承認主張なし（T087と同じ検出器。両文書とも「了承済み」と読める文を含まない） ----
    expect([
      ...approvalClaimsIn("docs/evidence/release-decision.md: ", releaseDecisionRaw),
      ...approvalClaimsIn("ops/production-start.md: ", productionStartRaw),
    ]).toEqual([]);

    // ---- 陽性対照: 注入した違反を各検出器が必ず拾う（恒真断言にしない） ----
    // 1. ゲートIDを1つ消す（RG-07 を別の字句へ置換）と一致検査が落ちる
    const strippedGate = releaseDecisionRaw.split("RG-07").join("RG-XX");
    expect(missingGateIdsIn(strippedGate)).toEqual(["RG-07"]);
    // 2. 「正式リリース不可」を消すと不可の明示が無いと落ちる
    const softened = releaseDecisionRaw.split("正式リリース不可").join("正式リリースは許可されない");
    expect(denialMissing(softened)).toEqual(["正式リリース不可"]);
    // 3. 承認を装う文を注入するとT087の検出器が拾う（失敗メッセージの文書名ラベルは実ファイル名に付け替わる）
    const claimed = releaseDecisionRaw.split("正式リリース不可").join("正式リリース可（D01〜D20を了承済み）");
    const claims = approvalClaimsIn("docs/evidence/release-decision.md: ", claimed);
    expect(claims.length, "了承済みの注入は検出される").toBeGreaterThan(0);
    expect(claims.some((m) => m.includes("了承済み") && m.startsWith("docs/evidence/release-decision.md: "))).toBe(true);
    // 4. 実行ゲートの文を消すと production-start.md の停止条件が無いと落ちる
    const ungated = productionStartRaw.split("実行しない").join("控える").split("実行禁止").join("控える");
    expect(gatingSentenceMissing(ungated)).toEqual(["実行しない／実行禁止を含む文がありません"]);
  });
});
