import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import {
  ROOT,
  computeCodeHash,
  evaluateGate,
  extractDocIds,
  loadIndex,
  loadManifest,
  parseRef,
  parsePorcelainZ,
  type AcceptanceManifest,
  type EvidenceIndex,
  type GateResult,
} from "../../scripts/acceptance-lib";

/**
 * 受入ゲート（T085。docs/08全章・docs/12・docs/13 RG-01〜07/09）。
 *
 * - manifest（tests/acceptance/manifest.json）が、正本から機械抽出した 54要件/AT・AT×CT・18TC・102API・28SCR・横断journey4本を
 *   実テストへ対応付けているかを静的に検査し（scripts/acceptance-lib.ts の checkCoverage）、
 * - その実テストが **今のコード** で実行され合格したかを、collect-evidence.ts が保存した証跡index
 *   （docs/evidence/acceptance-index.json）で照合する。コードがindex作成後に変わっていれば全件「未実行」として赤。
 * - skip・未実行・失敗・モック限定の外部確認を合格に数えない。実外部・実端末・人の手順は manifest.external に分け、
 *   ここでは合格に数えない（acceptance-results.md に「未実施」と明記。コントローラ裁定R3）。
 *
 * このspecはブラウザを使わない（ブラウザ試験の結果はindexに入っている）。各AT/TCは独立タイトルで判定する。
 */

const manifest = loadManifest();
const ids = extractDocIds();
let gate: GateResult | undefined;
const gateResult = () => (gate ??= evaluateGate(manifest, loadIndex()));

test("acceptance_gate_fails_on_skip_missing_route_or_unexecuted_case", () => {
  const { missingRequirementIds, missingApiIds, missingScreenIds, skippedOrUnexecutedCases, criticalOrHighUnresolvedIssues, coverage } = gateResult();
  // 正本の件数（ハードコードせず抽出したもの）を記録として残す
  console.log(`[acceptance] ${JSON.stringify(coverage.counts)}`);
  expect(missingRequirementIds).toEqual([]);
  expect(missingApiIds).toEqual([]);
  expect(missingScreenIds).toEqual([]);
  expect(skippedOrUnexecutedCases).toEqual([]);
  expect(criticalOrHighUnresolvedIssues).toEqual([]);
});

// 陽性対照: ゲートが空振りしないこと（注入した欠陥をそれぞれ検出する）。manifest・indexは複製を書き換え、実ファイルは変えない
test("gate_detects_injected_skip_missing_title_routeless_api_stale_index_and_open_high_issue", () => {
  const probeDir = join(ROOT, "test-results", "acceptance-probe");
  mkdirSync(probeDir, { recursive: true });
  const probeFile = "test-results/acceptance-probe/probe.test.ts";
  writeFileSync(join(ROOT, probeFile), 'import { it } from "vitest";\nit.skip("probe_skipped_case", () => {});\nit("probe_plain_case", () => {});\n');
  try {
    const m = JSON.parse(JSON.stringify(manifest)) as AcceptanceManifest;
    const at = m.acceptance.find((a) => a.id === "AT-AUTH-01")!;
    at.tests.push(`${probeFile}::probe_skipped_case`); // skip宣言
    at.ct["CT-02"]!.tests!.push("tests/members.test.ts::名簿 (T011) > no_such_test_title"); // 不在のtitle
    m.apis["API-10"] = [`${probeFile}::probe_plain_case`]; // routeを叩かないファイル
    m.screens["SCR-03"] = []; // 画面の実テストが無い
    m.issues.push({ id: "PROBE", source: "probe", summary: "注入したhigh", severity: "high", status: "open", basis: "probe", owner: "-" });
    const index = loadIndex();
    const hash = computeCodeHash();
    const r = evaluateGate(m, index, hash);
    expect(r.skippedOrUnexecutedCases.some((x) => x.includes("probe_skipped_case") && x.includes("skip"))).toBe(true);
    expect(r.skippedOrUnexecutedCases.some((x) => x.includes("no_such_test_title"))).toBe(true);
    expect(r.missingApiIds.some((x) => x.startsWith("API-10 "))).toBe(true);
    expect(r.missingScreenIds.some((x) => x.startsWith("SCR-03 "))).toBe(true);
    expect(r.criticalOrHighUnresolvedIssues.some((x) => x.startsWith("PROBE"))).toBe(true);
    // 証跡: コードが変わった（hash不一致）なら全件「未実行」
    const stale = evaluateGate(manifest, index, "0".repeat(64));
    expect(stale.indexState).not.toBe("ok");
    expect(stale.perCase.get("AT-AUTH-01")!.length).toBeGreaterThan(0);
    // 以下は判定ロジックの陽性対照。収集済みindexを「今のコードの証跡」とみなした複製で行う（indexの鮮度に依存させない）
    expect(index, "証跡indexが無い（npm run collect:evidence）").toBeTruthy();
    const base: EvidenceIndex = { ...index!, codeHash: hash };
    // 証跡: スイートが失敗している（またはfailed>0）なら、参照先が全部合格でも赤（失敗した実行は数えない。B-I1）
    {
      const index = base;
      const failedSuite: EvidenceIndex = { ...index, suites: index.suites.map((r) => (r.suite === "load" ? { ...r, status: "failed" as const, totals: { ...r.totals, failed: 1 } } : r)) };
      const rf = evaluateGate(manifest, failedSuite, hash);
      expect(rf.indexState).toContain("load");
      expect(rf.skippedOrUnexecutedCases.some((x) => x.includes("合格していない"))).toBe(true);
      // project指定の無いe2e参照は、片方のprojectの記録だけでは合格にしない（phone-360とdesktop-1280の両方が必須。R14/B-I2）
      const e2eRef = manifest.acceptance.flatMap((a) => a.tests).find((t) => t.includes("tests/e2e/") && !/@[a-z]/.test(t.split("::")[1]!))!;
      const pr = parseRef(e2eRef);
      const onlyPhone: EvidenceIndex = { ...index, entries: index.entries.filter((e) => !(e.file === pr.file && e.title === pr.title && e.project === "desktop-1280")) };
      const rp = evaluateGate(manifest, onlyPhone, hash);
      expect(rp.skippedOrUnexecutedCases.some((x) => x.includes(pr.title) && x.includes("desktop-1280"))).toBe(true);
    }
    // 証跡: 参照先がskipped/failedの記録なら不合格（skipを証拠にしない）
    {
      const index = base;
      const ref = parseRef(manifest.acceptance[0]!.tests[0]!);
      const tampered: EvidenceIndex = { ...index, entries: index.entries.map((e) => (e.file === ref.file && e.title === ref.title ? { ...e, result: "skipped" as const } : e)) };
      const r2 = evaluateGate(manifest, tampered, hash);
      expect(r2.perCase.get(manifest.acceptance[0]!.id)!.some((x) => x.includes("skipped"))).toBe(true);
    }
  } finally {
    rmSync(probeDir, { recursive: true, force: true });
  }
});

// collect-evidenceが記録する未コミットのコードファイル名を壊さない（先頭が空白の状態欄・非ASCII・名前変更。T085レビュー第2ラウンド）
test("porcelain_paths_keep_the_first_character_and_non_ascii_names", () => {
  const out = " M docs/03_画面設計・遷移.md\0M  src/a.ts\0?? tests/new.test.ts\0R  scripts/new.ts\0scripts/old.ts\0";
  expect(parsePorcelainZ(out)).toEqual(["docs/03_画面設計・遷移.md", "src/a.ts", "tests/new.test.ts", "scripts/new.ts"]);
});

// 各AT（docs/08 §3）を独立タイトルで。ATのシナリオとCT列の各組の参照先が全部合格していること
for (const at of ids.acceptance) {
  test(`${at.id} ${at.reqId} ${at.scenario.slice(0, 40)}`, () => {
    const entry = manifest.acceptance.find((a) => a.id === at.id);
    expect(entry, `${at.id} がmanifestに無い`).toBeTruthy();
    const unmapped = at.cts.filter((c) => !entry!.ct[c] || (!entry!.ct[c]!.tests?.length && !entry!.ct[c]!.notApplicable));
    expect(unmapped, `${at.id} の未対応CT`).toEqual([]);
    expect(entry!.tests.length, `${at.id} のシナリオの実テスト`).toBeGreaterThan(0);
    expect(gateResult().perCase.get(at.id) ?? ["判定されていない"]).toEqual([]);
  });
}

// 継続TC-01〜18（docs/08 §4）を独立タイトルで
for (const tc of ids.legacy) {
  test(`${tc.id} ${tc.reqIds.join("/")}`, () => {
    const entry = manifest.legacy.find((l) => l.id === tc.id);
    expect(entry, `${tc.id} がmanifestに無い`).toBeTruthy();
    expect(entry!.tests.length).toBeGreaterThan(0);
    expect(gateResult().perCase.get(tc.id) ?? ["判定されていない"]).toEqual([]);
  });
}
