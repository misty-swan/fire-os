// 網羅検査（T085）。`npm run check:coverage` で、受入manifest（tests/acceptance/manifest.json）が
// 正本のID集合（docs/08のAT/CT/TC・docs/12の要件・契約台帳のAPI・画面台帳のSCR）を過不足なく実テストへ対応付けているかを
// **静的に**検査する（CIで実行。コントローラ裁定R10）。1つでも欠ければ exit 1。
//  - 参照先テストが実在し、skip/only/todo/fixme 宣言でないこと
//  - API参照先ファイルがそのroute（method＋path）を実際に叩く記述を持つこと
//  - 画面参照先（実ブラウザ試験）がその画面のパスへ行く記述を持つこと
//  - notApplicable は docs/08 §2 の読取専用・純表示に当たる組合せだけ（理由必須）
// 実行結果との照合（未実行・skip・失敗を合格にしない）は `--with-evidence` で行う（フルe2eの結果に依存するためCIには入れない）。
// 本体のゲートは tests/acceptance/all-requirements.spec.ts（同じ判定関数を使う）。
import { pathToFileURL } from "node:url";
import { checkCoverage as check, evaluateGate, extractDocIds, loadIndex, loadManifest, type AcceptanceManifest, type CoverageResult } from "./acceptance-lib";

export type { AcceptanceManifest, CoverageResult };

/** Interface（docs/16 T085）: checkCoverage(manifest:AcceptanceManifest):CoverageResult */
export function checkCoverage(manifest: AcceptanceManifest): CoverageResult {
  return check(manifest, extractDocIds());
}

function main() {
  const manifest = loadManifest();
  const ids = extractDocIds();
  const r = check(manifest, ids);
  const c = r.counts;
  console.log(
    `正本: 要件${c.requirements} / AT${c.acceptance} / CT${c.commonTests}（AT×CTの組${c.ctPairs}・うちnotApplicable ${c.ctNotApplicable}） / TC${c.legacy} / API${c.apis} / SCR${c.screens} / journey${c.journeys} / 実外部の残手順${c.external}`,
  );
  console.log(`design: ${ids.designVersion}`);
  const sections: [string, string[]][] = [
    ["欠けている要件・AT×CT・TC・journey", r.missingRequirementIds],
    ["実テストの無いAPI", r.missingApiIds],
    ["実ブラウザ試験の無い画面", r.missingScreenIds],
    ["無効な参照（不在・skip宣言・routeを叩かない等）", r.invalidRefs],
    ["構成の問題", r.structureProblems],
  ];
  let failed = false;
  for (const [label, items] of sections) {
    if (items.length === 0) continue;
    failed = true;
    console.log(`\n✗ ${label}: ${items.length}件`);
    for (const i of items) console.log(`  - ${i}`);
  }
  if (process.argv.includes("--with-evidence")) {
    const g = evaluateGate(manifest, loadIndex());
    console.log(`\n証跡index: ${g.indexState}`);
    for (const [label, items] of [
      ["skip・未実行・不合格", g.skippedOrUnexecutedCases],
      ["critical/highの未解決", g.criticalOrHighUnresolvedIssues],
    ] as [string, string[]][]) {
      if (items.length === 0) continue;
      failed = true;
      console.log(`\n✗ ${label}: ${items.length}件`);
      for (const i of items.slice(0, 200)) console.log(`  - ${i}`);
    }
  }
  if (failed) {
    console.log("\ncheck:coverage 失敗");
    process.exit(1);
  }
  console.log(`\ncheck:coverage 成功（参照テスト${r.allRefs.length}件）`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) main();
