import { describe, expect, it } from "vitest";
// 出典として挙げてよい実在ファイル（?rawで読めたものだけを集合へ載せる＝存在の証明。
// ここに無いパスを出典に書くと productEvidenceMissing で検出する）
import acceptanceResultsRaw from "../docs/evidence/acceptance-results.md?raw";
import budgetDevelopmentRaw from "../config/budget-development.json?raw";
import costEstimateRaw from "../docs/evidence/cost-estimate.md?raw";
import demoDeployRaw from "../ops/demo-deploy.md?raw";
import decisionLedgerRaw from "../docs/14_設計判断・未決事項.md?raw";
import developmentCompletionRaw from "../docs/evidence/development-completion.md?raw";
import releaseCriteriaRaw from "../docs/13_リリース判定基準.md?raw";
import restoreEvidenceRaw from "../docs/evidence/V07-restore.md?raw";
import performanceEvidenceRaw from "../docs/evidence/V07-performance.md?raw";
import realtimeEvidenceRaw from "../docs/evidence/V06-realtime.md?raw";
import roadmapRaw from "../docs/09_ロードマップ・未決事項.md?raw";
import taskLedgerRaw from "../docs/16_実装タスク一覧.md?raw";
import userGuideRaw from "../docs/USER_GUIDE.md?raw";
// 検査対象の3ファイル（docs/16 T087のFiles）
import checklistRaw from "../docs/ADOPTION_CHECKLIST.md?raw";
import policyExampleRaw from "../config/production-policy.example.json?raw";
import proposalRaw from "../docs/ADOPTION_PROPOSAL.md?raw";
import { checkAdoptionProposal, type PolicyExampleDocument } from "../scripts/check-adoption-proposal";

/**
 * 導入提案資料・確認チェックリストの静的検査（T087、docs/09 §2・docs/13 §5・RG-08/10・
 * docs/14 §2 D01〜D20・docs/16 T087）。
 *
 * - 開発は完了しているが正式リリースではない。提案資料が「実測・証跡つきの完成品」と
 *   「まだ承認されていない運用の値（D01〜D20の推奨案・検証設定）」を混ぜないこと、
 *   D01〜D20を一項目一回答で確認できることを機械的に守る。連絡・送信・了承の捏造を防ぐ。
 * - 純関数（checkAdoptionProposal）は scripts/check-adoption-proposal.ts にあり、CLI
 *   （`npm run check:adoption-proposal`）が実ファイルを読んで同じ検査をする
 *   （tests/deploy-config.test.ts ↔ scripts/check-environment.ts と同じ構成）。
 * - 陽性対照: 各検出器は「注入した違反」を必ず拾うことをその場で試す（恒真断言にしない）。
 *   実ファイルへの一時的な違反注入（文書・approved:true・記入済み回答）での赤は
 *   task-87-d1-report.md に記録したとおり（注入後に戻している）。
 * - fix round 1: 「承認済み」主張の検出はD-IDの有無にかかわらない全ての文が対象（包括文・変形語・否定形も拾う。
 *   例外は「…済みとは扱わない」形の明示的な否定だけ=陽性対照6）。docs/14 §2 の未決D見出しと
 *   DECISION_IDS の一致も検査する（=陽性対照7）。
 * - review wave 1: 否定導入後に承認を述べる文・自然文体（を得ている/が済んだ/に至りました等）・断定語彙
 *   （本決まり等）・英語承認語（approved等）・例示JSONの厳格な型（approvedはboolean false厳密一致・回答は空文字列）・
 *   チェックリストの未知D行・チェックリスト↔例示JSONの質問一致 を検査する（=陽性対照9〜13）。
 */

const existingFiles: Record<string, string> = {
  "docs/09_ロードマップ・未決事項.md": roadmapRaw,
  "docs/13_リリース判定基準.md": releaseCriteriaRaw,
  "docs/14_設計判断・未決事項.md": decisionLedgerRaw,
  "docs/16_実装タスク一覧.md": taskLedgerRaw,
  "docs/USER_GUIDE.md": userGuideRaw,
  "docs/ADOPTION_PROPOSAL.md": proposalRaw,
  "docs/ADOPTION_CHECKLIST.md": checklistRaw,
  "config/budget-development.json": budgetDevelopmentRaw,
  "config/production-policy.example.json": policyExampleRaw,
  "docs/evidence/acceptance-results.md": acceptanceResultsRaw,
  "docs/evidence/cost-estimate.md": costEstimateRaw,
  "docs/evidence/development-completion.md": developmentCompletionRaw,
  "docs/evidence/V06-realtime.md": realtimeEvidenceRaw,
  "docs/evidence/V07-performance.md": performanceEvidenceRaw,
  "docs/evidence/V07-restore.md": restoreEvidenceRaw,
  "ops/demo-deploy.md": demoDeployRaw,
};
const existingPaths = new Set(Object.keys(existingFiles));

const policyExample = JSON.parse(policyExampleRaw) as PolicyExampleDocument;

const check = (overrides: Partial<Parameters<typeof checkAdoptionProposal>[0]> = {}) =>
  checkAdoptionProposal({
    proposal: proposalRaw,
    checklist: checklistRaw,
    policy: policyExample,
    pathExists: (p) => existingPaths.has(p),
    decisionLedger: decisionLedgerRaw,
    ...overrides,
  });

describe("adoption-proposal (T087)", () => {
  it("proposal_distinguishes_measured_product_from_unapproved_operation", () => {
    // ---- 実ドキュメントの3断言（ブリーフの変数・期待値どおり） ----
    const result = check();
    const unapprovedValuesPresentedAsApproved = result.unapprovedValuesPresentedAsApproved;
    const missingDecisionIds = result.missingDecisionIds;
    const productEvidenceMissing = result.productEvidenceMissing;
    expect(unapprovedValuesPresentedAsApproved).toEqual([]);
    expect(missingDecisionIds).toEqual([]);
    expect(productEvidenceMissing).toEqual([]);

    // ---- 陽性対照1: 未承認の判断を決定済みと装う文（D02に「了承済み」を添える） ----
    const fabricatedApproval = check({
      proposal: `${proposalRaw}\nD02 の個人情報項目は了承済みであり、全員共有名簿で運用を開始する。\n`,
    });
    expect(
      fabricatedApproval.unapprovedValuesPresentedAsApproved.some((f) => f.includes("D02") && f.includes("了承済み")),
    ).toBe(true);

    // ---- 陽性対照2: 例示JSONの approved:true と記入済み回答（T088前に回答が無いこと） ----
    const approvedFlipped: PolicyExampleDocument = { ...policyExample, D05: { ...policyExample.D05, approved: true } };
    expect(check({ policy: approvedFlipped }).unapprovedValuesPresentedAsApproved.some((f) => f.includes("D05"))).toBe(true);
    const answerFilled: PolicyExampleDocument = { ...policyExample, D11: { ...policyExample.D11, 回答: "了承する" } };
    expect(check({ policy: answerFilled }).unapprovedValuesPresentedAsApproved.some((f) => f.includes("D11"))).toBe(true);

    // ---- 陽性対照3: 未承認の値（$5）を未承認である旨の語なしで書く ----
    const unlabeledValue = check({ proposal: `${proposalRaw}\n月額上限は$5に決まっている。\n` });
    expect(unlabeledValue.unapprovedValuesPresentedAsApproved.some((f) => f.includes("$5"))).toBe(true);

    // ---- 陽性対照4: チェックリストのD行の欠落・重複・回答欄への記入（一項目一回答の破り） ----
    const withoutD07 = checklistRaw.replace(/^\| D07 \|.*\n/m, "");
    expect(check({ checklist: withoutD07 }).missingDecisionIds).toEqual([expect.stringContaining("D07")]);
    const d10Row = checklistRaw.match(/^\| D10 \|.*$/m)![0];
    expect(check({ checklist: checklistRaw.replace(d10Row, `${d10Row}\n${d10Row}`) }).missingDecisionIds.some((f) => f.includes("D10"))).toBe(true);
    const answeredRow = checklistRaw.replace(/^(\| D13 \|[^\n]*?)\|\s*\|$/m, "$1| 了承 |");
    expect(
      check({ checklist: answeredRow }).unapprovedValuesPresentedAsApproved.some((f) => f.includes("D13") && f.includes("記入")),
    ).toBe(true);

    // ---- 陽性対照5: 必須要素・出典・未実施明記の欠落（完成品を根拠に確認できる資料の破り） ----
    const withoutRole = proposalRaw.split("役割").join("担当割当");
    expect(check({ proposal: withoutRole }).productEvidenceMissing).toEqual([expect.stringContaining("役割")]);
    const ghostSource = check({
      proposal: `${proposalRaw}\n- 実測: 通常API p95=999ms〔出典: docs/evidence/MISSING.md〕\n`,
    });
    expect(ghostSource.productEvidenceMissing.some((f) => f.includes("docs/evidence/MISSING.md"))).toBe(true);
    const unsourced = check({ proposal: `${proposalRaw}\n- 実測では通常API p95=999ms だった。\n` });
    expect(unsourced.productEvidenceMissing.some((f) => f.includes("999ms"))).toBe(true);
    const hiddenNotImplemented = proposalRaw.replace("実環境のデモURLは未実施", "実環境のデモURLは準備中");
    expect(check({ proposal: hiddenNotImplemented }).productEvidenceMissing.some((f) => f.includes("デモURL"))).toBe(true);

    // ---- 陽性対照6: 包括文・変形語・否定形（fix round 1。D-IDが無くても承認済み主張は検出する） ----
    const blanketClaim = check({ proposal: `${proposalRaw}\n本提案の内容は確定している。\n` });
    expect(blanketClaim.unapprovedValuesPresentedAsApproved.some((f) => f.includes("確定している"))).toBe(true);
    const blanketAll = check({ proposal: `${proposalRaw}\n上記20件の確認事項はすべて了承済みである。\n` });
    expect(blanketAll.unapprovedValuesPresentedAsApproved.some((f) => f.includes("了承済"))).toBe(true);
    const variantZu = check({ proposal: `${proposalRaw}\n本件は承認済で進めます。\n` });
    expect(variantZu.unapprovedValuesPresentedAsApproved.some((f) => f.includes("承認済"))).toBe(true);
    // 否定形: 「未承認」などの語が同じ文にあっても主張を相殺させない
    const negatedClaim = check({ proposal: `${proposalRaw}\nD11 の月額上限は未承認ではなく承認されている。\n` });
    expect(negatedClaim.unapprovedValuesPresentedAsApproved.some((f) => f.includes("D11") && f.includes("承認されている"))).toBe(true);
    // 明示的な否定（docs/14流の「…済みとは扱わない」）は検出しない（過剰検出の防止。ホワイトリストを外すとこの断言が落ちる）
    const honestNegation = check({ proposal: `${proposalRaw}\nこの設定は承認済みとは扱いません。\n` });
    expect(honestNegation.unapprovedValuesPresentedAsApproved).toEqual([]);

    // ---- 陽性対照7: docs/14 §2 の未決D見出しとDECISION_IDSの一致（F2。将来のD追加・改名で更新を強制する） ----
    const ledgerWithoutD13 = decisionLedgerRaw.replace(/^### D13 .*$/m, "");
    expect(check({ decisionLedger: ledgerWithoutD13 }).missingDecisionIds.some((f) => f.includes("D13"))).toBe(true);
    const ledgerWithD99 = decisionLedgerRaw.replace(/^### D21 /m, "### D99 試験の未決項目\n### D21 ");
    expect(check({ decisionLedger: ledgerWithD99 }).missingDecisionIds.some((f) => f.includes("D99"))).toBe(true);

    // ---- 陽性対照8: 丁寧形・受動形・過去丁寧（fix round 2。再レビューの素通り例を全て検出する） ----
    const politeClaims = [
      "上記20件はすべて承認されています。",
      "本提案の内容は確定しています。",
      "D03 の役割設計は承認しています。",
      "点検票の正式様式は承認された。",
      "D11 の月額上限は決定されました。",
      "本件は承認しております。",
      "D02 の個人情報の扱いは了承していました。",
      "運用方針は確定しました。",
      "D13 の通知方針は了承します。", // 現在丁寧（します形）も主張
      "本提案は承認されます。", // 受動・非過去
    ];
    for (const sentence of politeClaims) {
      const r = check({ proposal: `${proposalRaw}\n${sentence}\n` });
      expect(r.unapprovedValuesPresentedAsApproved.some((f) => f.includes(sentence.replace("。", ""))), sentence).toBe(true);
    }
    // します形の正当な用法（T088で運用方針ファイルを確定する仕組みの説明）だけは検出しない
    // （ホワイトリストの字句を外すと、本文書の実例（提案資料§5）とこの対照の両方が落ちる）
    const policyFinalization = check({
      proposal: `${proposalRaw}\n回答を記録し、運用方針（production-policy.json）として確定します。\n`,
    });
    expect(policyFinalization.unapprovedValuesPresentedAsApproved).toEqual([]);

    // ---- 陽性対照9: 否定導入の後に承認を述べる文（review wave 1。「未承認ではなく$5に本決まり」型） ----
    const negatedThenClaim = check({ proposal: `${proposalRaw}\n月額上限は未承認ではなく$5に本決まりです。\n` });
    expect(negatedThenClaim.unapprovedValuesPresentedAsApproved.some((f) => f.includes("否定の後に承認"))).toBe(true);
    // 否定随伴語（未承認ではなく…）は値ラベルとして数えない→$5の無Label検出も発火する
    expect(negatedThenClaim.unapprovedValuesPresentedAsApproved.some((f) => f.includes("語なしで書いています"))).toBe(true);
    // 語幹の単独形でも、否定導入の後なら主張とみなす（「検証設定ではなく確定です」）
    const negatedBareStem = check({ proposal: `${proposalRaw}\nD11 の月額上限は検証設定ではなく確定です。\n` });
    expect(negatedBareStem.unapprovedValuesPresentedAsApproved.some((f) => f.includes("否定の後に承認"))).toBe(true);

    // ---- 陽性対照10: 自然文体の承認主張（review wave 1。を得ている/が済んだ/に至りました等） ----
    const naturalClaims = [
      "本件は承認を得ている。",
      "D02 の扱いは了承が済んだ。",
      "D17 の体制は合意に至りました。",
      "D06 の様式は了承をいただいている。",
      "本提案は合意に至る。",
      "D03 の運用は決まっています。",
    ];
    for (const sentence of naturalClaims) {
      const r = check({ proposal: `${proposalRaw}\n${sentence}\n` });
      expect(r.unapprovedValuesPresentedAsApproved.some((f) => f.includes(sentence.replace("。", ""))), sentence).toBe(true);
    }

    // ---- 陽性対照11: 英語の承認語（review wave 1。approved/accepted/confirmed。例外は approved:false の参照のみ） ----
    for (const sentence of ["D11 approved", "本提案は accepted です。", "The plan is confirmed."]) {
      const r = check({ proposal: `${proposalRaw}\n${sentence}\n` });
      expect(r.unapprovedValuesPresentedAsApproved.some((f) => f.includes("英語の承認語")), sentence).toBe(true);
    }
    const approvedFalseReference = check({
      proposal: `${proposalRaw}\n月額上限は config/budget-development.json の approved:false のとおりです（未承認の開発設定）。\n`,
    });
    expect(approvedFalseReference.unapprovedValuesPresentedAsApproved).toEqual([]);
    // docs/01 AI-06 の機能語「承認済み資料」（RAGの検索対象）は主張ではない（検出しない）
    const ragFeatureTerm = check({ proposal: `${proposalRaw}\nAI-06は承認済み資料を出典付きで検索する機能です。\n` });
    expect(ragFeatureTerm.unapprovedValuesPresentedAsApproved).toEqual([]);

    // ---- 陽性対照12: 例示JSONの厳格な型（review wave 1。approvedはboolean false厳密一致・回答は空文字列のみ） ----
    const approvedNumeric: PolicyExampleDocument = { ...policyExample, D03: { ...policyExample.D03, approved: 1 as unknown as boolean } };
    expect(check({ policy: approvedNumeric }).unapprovedValuesPresentedAsApproved.some((f) => f.includes("D03") && f.includes("boolean の false"))).toBe(true);
    const approvedString: PolicyExampleDocument = { ...policyExample, D13: { ...policyExample.D13, approved: "false" as unknown as boolean } };
    expect(check({ policy: approvedString }).unapprovedValuesPresentedAsApproved.some((f) => f.includes("D13") && f.includes("boolean の false"))).toBe(true);
    const answerNumeric: PolicyExampleDocument = { ...policyExample, D07: { ...policyExample.D07, 回答: 123 as unknown as string } };
    expect(check({ policy: answerNumeric }).unapprovedValuesPresentedAsApproved.some((f) => f.includes("D07") && f.includes("空文字列"))).toBe(true);
    const answerArray: PolicyExampleDocument = { ...policyExample, D20: { ...policyExample.D20, 回答: ["了承する"] as unknown as string } };
    expect(check({ policy: answerArray }).unapprovedValuesPresentedAsApproved.some((f) => f.includes("D20") && f.includes("空文字列"))).toBe(true);

    // ---- 陽性対照13: チェックリストの未知D行・チェックリスト↔例示JSONの質問一致（review wave 1） ----
    const d20Row = checklistRaw.match(/^\| D20 \|.*$/m)![0];
    const withExtraD21Row = checklistRaw.replace(
      d20Row,
      `${d20Row}\n| D21 | 台帳に無い追加項目 | （未承認の検証設定）試験 | 試験 | 試験 / 誰か | |`,
    );
    expect(check({ checklist: withExtraD21Row }).missingDecisionIds.some((f) => f.includes("D21"))).toBe(true);
    const tamperedQuestion: PolicyExampleDocument = { ...policyExample, D02: { ...policyExample.D02, 質問: "別の質問文" } };
    expect(check({ policy: tamperedQuestion }).missingDecisionIds.some((f) => f.includes("D02") && f.includes("一致しません"))).toBe(true);
  });
});
