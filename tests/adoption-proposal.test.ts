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
 * 導入提案資料・確認チェックリストの静的検査（T087、docs/09「完成後に消防団へ提案する順序」・
 * docs/13 RG-08/10・docs/14 §2 D01〜D20・docs/16 T087）。
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
  });
});
