// 証跡の収集（T085）。`npm run collect:evidence` で、受入manifestが参照する全スイートを実際に実行し、
// 試験ごとの結果を証跡index（docs/evidence/acceptance-index.json）と人が読む表（docs/evidence/acceptance-results.md）へ保存する。
//
//   vitest（workers＝実workerd＋D1/Queues、client＝jsdom）→ test:load（T082の負荷runner）→ Playwright（業務e2e。受入ゲート自身は除く）
//   test:live は実Cloudflare(staging)のSecretが無ければ実行できない＝「未実施」と記録し合格に数えない（コントローラ裁定R4）
//
// オプション:
//   --only=vitest,load,e2e  指定スイートだけ**全体を**再実行し、同じコード（codeHash一致）の既存indexへ差し替えて保存する。
//                           差し替えた旧実行は discardedRuns に残す（フレーキーを隠さない）。一部の試験だけの再実行はしない。
//   --report-only           実行せず、既存indexと最新manifestから acceptance-results.md だけを作り直す
//
// 生の報告（JSON reporter）は test-results/acceptance/<日時>/ に置く（Git管理外）。indexにはその場所を「証跡」として記録する。
import { spawnSync, execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { pathToFileURL } from "node:url";
import { E2E_PORT } from "./e2e-port";
import {
  CODE_PATHS,
  INDEX_PATH,
  RESULTS_MD_PATH,
  ROOT,
  checkCoverage,
  computeCodeHash,
  dirtyCodeFilesNow,
  entryKey,
  evaluateGate,
  extractDocIds,
  git,
  loadIndex,
  loadManifest,
  parseRef,
  type AcceptanceManifest,
  type EvidenceEntry,
  type EvidenceIndex,
  type SuiteRun,
  type TestResult,
} from "./acceptance-lib";

export type { EvidenceIndex };

export interface EvidenceInput {
  suites: ("vitest" | "load" | "e2e")[];
  /** 既存indexを引き継ぐ（同じcodeHashのときだけ） */
  merge: boolean;
  outDir?: string;
}

const E2E_PROJECT_ARGS = ["--project=setup", "--project=phone-360", "--project=desktop-1280", "--project=tablet-768"];

const stamp = () => new Date().toISOString();

function run(cmd: string, args: string[], env: Record<string, string> = {}): number {
  console.log(`\n$ ${cmd} ${args.join(" ")}`);
  const r = spawnSync(cmd, args, { cwd: ROOT, stdio: "inherit", env: { ...process.env, ...env } });
  return r.status ?? 1;
}

/** e2eのポート（scripts/e2e-port.ts。既定8797）が使用中なら止めない（利用者の別のサーバーかもしれない）。e2eは自分でサーバーを立てる */
function e2ePortBusy(): boolean {
  try {
    const out = execFileSync("ss", ["-ltn"], { encoding: "utf8" });
    return new RegExp(`:${E2E_PORT}\\s`).test(out);
  } catch {
    return false;
  }
}

/** 試験の種類ごとの環境の記述（indexの fixture/model/question/browser/network 列） */
function describeEntry(kind: string, file: string, project: string) {
  const isAi = /ai|jev|rag|assistant|report|retrieval|document|evaluation/.test(file);
  if (kind === "e2e") {
    return {
      browser: `chromium (Playwright ${PW_VERSION}) project=${project}`,
      network: `loopback（wrangler dev :${E2E_PORT}・ローカルD1。実回線ではない）`,
      fixture: "架空データ（scripts/e2e-prepare.tsでD1再作成＋各specが画面/APIで作る架空名簿・施設・活動）",
      model: isAi ? "試験専用fake AI（TEST_AI_FAKE=1・src/server/ai/local-fake.ts。実モデルではない）" : "AI不使用",
      question: isAi ? "サーバー固定の質問版（src/server/ai/questions.ts QUESTION_VERSION等）" : "-",
    };
  }
  if (kind === "load") {
    return {
      browser: "なし（workerd＋D1。node側から30端末を模擬）",
      network: "loopback（実回線ではない。劣化回線は試験内の遅延注入）",
      fixture: "代表件数の架空seed（scripts/seed-load.ts）",
      model: "試験専用fake AI（TEST_AI_FAKE=1）",
      question: "サーバー固定の質問版",
    };
  }
  const client = file.endsWith(".tsx") || file === "tests/offline-store.test.ts";
  return {
    browser: client ? "jsdom（vitest client）" : "workerd（vitest workers・実D1/Queues）",
    network: client ? "なし（fetchは試験内のfake）" : "なし（app.fetch直呼び）",
    fixture: client ? "試験内の架空データ" : "架空fixture（tests/helpers/fixture.ts two-units等）",
    model: isAi ? "試験内で注入したfake AI binding（実モデルではない）" : "AI不使用",
    question: isAi ? "サーバー固定の質問版（QUESTION_VERSION / REPORT_PROMPT_VERSION）" : "-",
  };
}

let PW_VERSION = "";

interface VitestJson {
  testResults: { name: string; startTime: number; assertionResults: { ancestorTitles: string[]; title: string; status: string; duration?: number }[] }[];
}
function vitestEntries(kind: "vitest" | "load", reportPath: string): EvidenceEntry[] {
  const json = JSON.parse(readFileSync(reportPath, "utf8")) as VitestJson;
  const out: EvidenceEntry[] = [];
  for (const f of json.testResults) {
    const file = relative(ROOT, f.name);
    for (const a of f.assertionResults) {
      const title = [...a.ancestorTitles, a.title].join(" > ");
      const result: TestResult = a.status === "passed" ? "passed" : a.status === "failed" ? "failed" : "skipped";
      out.push({
        testId: `${kind}:${file}::${title}`,
        kind,
        file,
        title,
        project: kind === "load" ? "load" : file.endsWith(".tsx") || file === "tests/offline-store.test.ts" ? "client" : "workers",
        reqIds: [],
        result,
        durationMs: Math.round(a.duration ?? 0),
        startedAt: new Date(f.startTime).toISOString(),
        ...describeEntry(kind, file, ""),
        evidence: relative(ROOT, reportPath),
      });
    }
  }
  return out;
}

interface PwSuite {
  title: string;
  file: string;
  specs?: { title: string; file: string; tests: { projectName: string; status: string; results: { status: string; duration: number; startTime: string; attachments?: { name: string; path?: string }[] }[] }[] }[];
  suites?: PwSuite[];
}
function e2eEntries(reportPath: string): EvidenceEntry[] {
  const json = JSON.parse(readFileSync(reportPath, "utf8")) as { suites: PwSuite[] };
  const out: EvidenceEntry[] = [];
  const walk = (s: PwSuite, anc: string[], file: string) => {
    for (const sp of s.specs ?? []) {
      const f = `tests/${sp.file}`;
      const title = [...anc, sp.title].join(" > ");
      for (const t of sp.tests) {
        const last = t.results[t.results.length - 1];
        const status = (last?.status ?? "notRun") as TestResult;
        out.push({
          testId: `e2e:${f}::${title}@${t.projectName}`,
          kind: "e2e",
          file: f,
          title,
          project: t.projectName,
          reqIds: [],
          result: t.status === "skipped" ? "skipped" : status,
          durationMs: Math.round(last?.duration ?? 0),
          startedAt: last?.startTime ?? "",
          ...describeEntry("e2e", f, t.projectName),
          evidence: [relative(ROOT, reportPath), ...(last?.attachments ?? []).filter((a) => a.path).map((a) => relative(ROOT, a.path!))].join(" ; "),
        });
      }
    }
    for (const c of s.suites ?? []) walk(c, c.title && c.title !== c.file && !/\.(ts|tsx)$/.test(c.title) ? [...anc, c.title] : anc, file);
  };
  for (const s of json.suites) walk(s, [], s.file);
  return out;
}

const totalsOf = (entries: EvidenceEntry[]) => ({
  passed: entries.filter((e) => e.result === "passed").length,
  failed: entries.filter((e) => e.result === "failed" || e.result === "timedOut").length,
  skipped: entries.filter((e) => e.result === "skipped").length,
  other: entries.filter((e) => !["passed", "failed", "timedOut", "skipped"].includes(e.result)).length,
});

/** Interface（docs/16 T085）: collectEvidence(input:EvidenceInput):Promise<EvidenceIndex> */
export async function collectEvidence(input: EvidenceInput): Promise<EvidenceIndex> {
  const startedHash = computeCodeHash();
  const prev = loadIndex();
  const base: EvidenceIndex | null = input.merge && prev && prev.codeHash === startedHash ? prev : null;
  if (input.merge && !base) console.log("既存indexはコードが違う（または無い）ため引き継がず、全スイートを実行します");
  const suitesToRun = base ? input.suites : (["vitest", "load", "e2e"] as const).slice();
  const outDir = input.outDir ?? join(ROOT, "test-results", "acceptance", stamp().replace(/[:.]/g, "-"));
  mkdirSync(outDir, { recursive: true });
  PW_VERSION = execFileSync("npx", ["playwright", "--version"], { cwd: ROOT, encoding: "utf8" }).trim().replace(/^Version /, "");

  const runs: SuiteRun[] = [];
  const entries: EvidenceEntry[] = [];
  for (const suite of suitesToRun) {
    const started = stamp();
    let report = "";
    let command = "";
    let code = 0;
    let got: EvidenceEntry[] = [];
    if (suite === "vitest") {
      report = join(outDir, "vitest.json");
      command = `npx vitest --run --reporter=default --reporter=json --outputFile.json=${relative(ROOT, report)}`;
      code = run("npx", ["vitest", "--run", "--reporter=default", "--reporter=json", `--outputFile.json=${report}`]);
      if (existsSync(report)) got = vitestEntries("vitest", report);
    } else if (suite === "load") {
      report = join(outDir, "load.json");
      command = `npx vitest --run --config vitest.load.config.ts --reporter=default --reporter=json --outputFile.json=${relative(ROOT, report)}`;
      code = run("npx", ["vitest", "--run", "--config", "vitest.load.config.ts", "--reporter=default", "--reporter=json", `--outputFile.json=${report}`]);
      if (existsSync(report)) got = vitestEntries("load", report);
    } else {
      if (e2ePortBusy()) throw new Error(`${E2E_PORT}番が使用中です。e2eは自分でサーバーを起動するため、使用中のサーバーを止めるか、FIREOS_E2E_PORTで別の番号を指定して再実行してください（このscriptは止めません）`);
      report = join(outDir, "e2e.json");
      command = `npx playwright test ${E2E_PROJECT_ARGS.join(" ")} --reporter=list,json`;
      code = run("npx", ["playwright", "test", ...E2E_PROJECT_ARGS, "--reporter=list,json"], { PLAYWRIGHT_JSON_OUTPUT_NAME: report });
      if (existsSync(report)) got = e2eEntries(report);
    }
    const totals = totalsOf(got);
    runs.push({
      suite,
      command,
      status: code === 0 && totals.failed === 0 && got.length > 0 ? "passed" : "failed",
      ...(got.length === 0 ? { reason: "報告が得られなかった（runnerの異常終了）" } : {}),
      startedAt: started,
      finishedAt: stamp(),
      totals,
      report: relative(ROOT, report),
    });
    entries.push(...got);
  }
  // test:live（実Cloudflare）は Secret が無ければ実行しない＝未実施として記録（skipを成功扱いにしない）
  const liveVars = ["LIVE_BASE_URL", "LIVE_BOOTSTRAP_TOKEN", "LIVE_BOOTSTRAP_EMAIL"];
  const missingLive = liveVars.filter((v) => !process.env[v]);
  const liveRun: SuiteRun = {
    suite: "live",
    command: "npm run test:live",
    status: "notRun",
    reason: missingLive.length ? `未実施: 実Cloudflare(staging)のSecret未設定（${missingLive.join(", ")}）。合格に数えない（コントローラ裁定R4）` : "未実施: 本scriptは実環境へ接続しない（staging実行はT086/T088の手順で行う）",
    startedAt: stamp(),
    finishedAt: stamp(),
    totals: { passed: 0, failed: 0, skipped: 0, other: 0 },
    report: "",
  };

  const endedHash = computeCodeHash();
  if (endedHash !== startedHash) throw new Error("実行中にコードが変わりました（codeHash不一致）。変更を止めてから再実行してください");

  const replaced = new Set(suitesToRun);
  const keptRuns = base ? base.suites.filter((s) => !replaced.has(s.suite as never) && s.suite !== "live") : [];
  const keptEntries = base ? base.entries.filter((e) => !replaced.has(e.kind)) : [];
  const discarded = [...(base?.discardedRuns ?? []), ...(base ? base.suites.filter((s) => replaced.has(s.suite as never)) : [])];
  const dirty = dirtyCodeFilesNow();
  const ids = extractDocIds();
  const index: EvidenceIndex = {
    schema: 1,
    generatedAt: stamp(),
    commit: git(["rev-parse", "HEAD"]),
    codeHash: startedHash,
    dirtyCodeFiles: dirty,
    designVersion: ids.designVersion,
    environment: {
      node: process.version,
      platform: `${process.platform}-${process.arch}`,
      playwright: PW_VERSION,
      vitest: execFileSync("npx", ["vitest", "--version"], { cwd: ROOT, encoding: "utf8" }).trim(),
      wrangler: execFileSync("npx", ["wrangler", "--version"], { cwd: ROOT, encoding: "utf8" }).trim().split("\n").pop() ?? "",
    },
    suites: [...keptRuns, ...runs, liveRun],
    discardedRuns: discarded,
    entries: [...keptEntries, ...entries],
  };
  attachReqIds(index, loadManifest());
  return index;
}

/** 参照の逆引きで、各試験がどの要件・ケースの証拠かを記録する */
function attachReqIds(index: EvidenceIndex, manifest: AcceptanceManifest) {
  const cov = checkCoverage(manifest);
  const owners = new Map<string, Set<string>>();
  for (const [raw, set] of cov.refOwners) {
    let ref;
    try {
      ref = parseRef(raw);
    } catch {
      continue;
    }
    const k = entryKey(ref.kind, ref.file, ref.title);
    if (!owners.has(k)) owners.set(k, new Set());
    set.forEach((o) => owners.get(k)!.add(o));
  }
  for (const e of index.entries) e.reqIds = [...(owners.get(entryKey(e.kind, e.file, e.title)) ?? [])].sort();
}

// ---------------------------------------------------------------- acceptance-results.md

const cell = (s: string) => s.replace(/\|/g, "／").replace(/\n/g, " ");

export function renderResults(index: EvidenceIndex | null, manifest: AcceptanceManifest): string {
  const ids = extractDocIds();
  const gate = evaluateGate(manifest, index);
  const cov = gate.coverage;
  const ext = new Map(manifest.external.map((e) => [e.id, e]));
  const L: string[] = [];
  L.push("# 受入試験の結果（T085。開発版＝架空データ・ローカル）");
  L.push("");
  L.push("> **生成物**: `npm run collect:evidence` が証跡index（docs/evidence/acceptance-index.json）と受入manifest（tests/acceptance/manifest.json）から作る。手で編集しない（`npx tsx scripts/collect-evidence.ts --report-only` で作り直す）。");
  L.push(">");
  L.push("> **この表の「合格（局所）」は、架空データ・ローカル（workerd＋ローカルD1・Playwright chromium・fake AI）で参照先の実テストが今のコードで全部合格したという意味**で、docs/13 RG-03（正式リリースの受入合格）ではない。実外部・実端末・人の手順は「未実施」の列に残し、合格に数えない（コントローラ裁定R3）。test:live は Secret 未設定のため未実施（R4）。");
  L.push("");
  if (!index) {
    L.push("**証跡indexが無い。** `npm run collect:evidence` を実行すること。");
    return L.join("\n") + "\n";
  }
  L.push("## 実行環境と版");
  L.push("");
  L.push("| 項目 | 値 |");
  L.push("|---|---|");
  L.push(`| 収集日時 | ${index.generatedAt} |`);
  L.push(`| commit | ${index.commit}${index.dirtyCodeFiles.length ? `（未コミットのコード変更 ${index.dirtyCodeFiles.length}件を含む作業木で実行。内容はcodeHashで固定）` : ""} |`);
  L.push(`| codeHash | ${index.codeHash} |`);
  L.push(`| 設計版 | ${index.designVersion} |`);
  L.push(`| 実行環境 | node ${index.environment.node} / ${index.environment.platform} / Playwright ${index.environment.playwright} / ${index.environment.vitest} / wrangler ${index.environment.wrangler} |`);
  L.push(`| ゲート判定 | ${gate.indexState === "ok" && gate.skippedOrUnexecutedCases.length === 0 && gate.missingRequirementIds.length + gate.missingApiIds.length + gate.missingScreenIds.length + gate.criticalOrHighUnresolvedIssues.length === 0 ? "**緑**（開発版の範囲）" : `**赤**（${cell(gate.indexState)}）`} |`);
  L.push("");
  L.push("## スイート");
  L.push("");
  L.push("| スイート | 結果 | passed | failed | skipped | 開始 | 終了 | コマンド |");
  L.push("|---|---|---|---|---|---|---|---|");
  for (const s of index.suites) L.push(`| ${s.suite} | ${s.status === "notRun" ? `**未実施**（${cell(s.reason ?? "")}）` : s.status} | ${s.totals.passed} | ${s.totals.failed} | ${s.totals.skipped} | ${s.startedAt} | ${s.finishedAt} | \`${cell(s.command)}\` |`);
  if (index.discardedRuns.length) {
    L.push("");
    L.push("差し替えた過去の実行（同じコードでスイート全体を再実行した。フレーキーの記録として残す）:");
    L.push("");
    for (const s of index.discardedRuns) L.push(`- ${s.suite} ${s.startedAt}: ${s.status}（passed ${s.totals.passed} / failed ${s.totals.failed} / skipped ${s.totals.skipped}）`);
  }
  const skipped = index.entries.filter((e) => e.result === "skipped");
  if (skipped.length) {
    L.push("");
    L.push(`skipされた試験 ${skipped.length}件（いずれも証拠に使わない。manifest.knownSkips の分類）:`);
    L.push("");
    for (const e of skipped) {
      const k = manifest.knownSkips.find((s) => parseRef(s.test).title === e.title && s.project === e.project);
      L.push(`- ${e.file} › ${e.title}（${e.project}）: ${k ? `${k.reason}。証拠は ${k.evidenceProject} の合格` : "**未分類**"}`);
    }
  }
  L.push("");
  L.push("## 件数（正本から機械抽出）");
  L.push("");
  const c = cov.counts;
  L.push(`要件${c.requirements} / AT${c.acceptance} / CT${c.commonTests}（AT×CTの組${c.ctPairs}、うち notApplicable ${c.ctNotApplicable}） / 継続TC${c.legacy} / API${c.apis} / SCR${c.screens} / 横断journey${c.journeys} / 実外部の残手順${c.external}。参照している実テスト ${cov.allRefs.length}件。`);
  L.push("");
  L.push("## 受入（AT）");
  L.push("");
  L.push("| AT | 要件 | 開発版の判定 | シナリオの実テスト | CT（組数／notApplicable） | 未実施（実外部・実端末・人） |");
  L.push("|---|---|---|---|---|---|");
  for (const at of ids.acceptance) {
    const e = manifest.acceptance.find((a) => a.id === at.id);
    const probs = gate.perCase.get(at.id) ?? ["manifestに無い"];
    const na = e ? Object.entries(e.ct).filter(([, m]) => m.notApplicable).map(([k]) => k) : [];
    const exts = e ? [...new Set([...(e.external ?? []), ...Object.values(e.ct).flatMap((m) => m.external ?? [])])] : [];
    L.push(
      `| ${at.id} | ${at.reqId} | ${probs.length === 0 ? "合格（局所）" : `**不合格/未実行**（${probs.length}件）`} | ${e?.tests.length ?? 0} | ${at.cts.length}${na.length ? `／${na.join(",")}` : ""} | ${exts.length ? exts.map((x) => `${x}（${cell(ext.get(x)?.summary ?? "")}・${ext.get(x)?.owner ?? ""}）`).join("<br>") : "-"} |`,
    );
  }
  L.push("");
  L.push("## 継続シナリオ（TC-01〜18）");
  L.push("");
  L.push("| TC | 対応要件 | 開発版の判定 | 実テスト | 未実施（実外部・実端末・人） |");
  L.push("|---|---|---|---|---|");
  for (const tc of ids.legacy) {
    const e = manifest.legacy.find((l) => l.id === tc.id);
    const probs = gate.perCase.get(tc.id) ?? ["manifestに無い"];
    const exts = e?.external ?? [];
    L.push(`| ${tc.id} | ${tc.reqIds.join(",")} | ${probs.length === 0 ? "合格（局所）" : `**不合格/未実行**（${probs.length}件）`} | ${(e?.tests ?? []).map((t) => cell(t)).join("<br>")} | ${exts.length ? exts.map((x) => `${x}（${cell(ext.get(x)?.summary ?? "")}・${ext.get(x)?.owner ?? ""}）`).join("<br>") : "-"} |`);
  }
  L.push("");
  L.push("## 横断journey");
  L.push("");
  L.push("| id | 動線 | 判定 | 試験 |");
  L.push("|---|---|---|---|");
  for (const j of manifest.journeys) {
    const probs = gate.perCase.get(j.id) ?? [];
    L.push(`| ${j.id} | ${cell(j.name)} | ${probs.length === 0 ? "合格（局所）" : "**不合格/未実行**"} | ${cell(j.test)} |`);
  }
  L.push("");
  L.push("## notApplicable（docs/08 §2: 読取専用・純表示に不要なmutation試験を実施したことにしない）");
  L.push("");
  if (cov.notApplicable.length === 0) L.push("なし");
  for (const n of cov.notApplicable) L.push(`- ${n.pair}: ${cell(n.reason)}`);
  L.push("");
  L.push("## 実外部・実端末・人の残手順（未実施。合格に数えない）");
  L.push("");
  L.push("| id | 根拠 | 内容 | 担当 |");
  L.push("|---|---|---|---|");
  for (const e of manifest.external) L.push(`| ${e.id} | ${cell(e.source)} | ${cell(e.summary)} | ${e.owner} |`);
  L.push("");
  L.push("## 課題台帳（criticalOrHighUnresolvedIssues の出典。コントローラ裁定R7）");
  L.push("");
  L.push("| id | 重大度 | 状態 | 内容 | 出典 | 重大度の根拠 | 担当 |");
  L.push("|---|---|---|---|---|---|---|");
  for (const i of manifest.issues) L.push(`| ${i.id} | ${i.severity} | ${i.status} | ${cell(i.summary)} | ${cell(i.source)} | ${cell(i.basis)} | ${i.owner} |`);
  if (gate.skippedOrUnexecutedCases.length || gate.missingRequirementIds.length || gate.missingApiIds.length || gate.missingScreenIds.length) {
    L.push("");
    L.push("## ゲートの不合格理由");
    L.push("");
    for (const s of [...gate.missingRequirementIds, ...gate.missingApiIds, ...gate.missingScreenIds, ...gate.skippedOrUnexecutedCases].slice(0, 300)) L.push(`- ${cell(s)}`);
  }
  return L.join("\n") + "\n";
}

async function main() {
  const args = process.argv.slice(2);
  const manifest = loadManifest();
  if (args.includes("--report-only")) {
    writeFileSync(join(ROOT, RESULTS_MD_PATH), renderResults(loadIndex(), manifest));
    console.log(`${RESULTS_MD_PATH} を作り直しました`);
    return;
  }
  const only = args.find((a) => a.startsWith("--only="))?.slice(7).split(",") as EvidenceInput["suites"] | undefined;
  const index = await collectEvidence({ suites: only ?? ["vitest", "load", "e2e"], merge: !!only });
  writeFileSync(join(ROOT, INDEX_PATH), JSON.stringify(index, null, 1) + "\n");
  writeFileSync(join(ROOT, RESULTS_MD_PATH), renderResults(index, manifest));
  const g = evaluateGate(manifest, index, index.codeHash);
  console.log(`\n証跡index: ${INDEX_PATH}（${index.entries.length}件）`);
  for (const s of index.suites) console.log(`  ${s.suite}: ${s.status} passed=${s.totals.passed} failed=${s.totals.failed} skipped=${s.totals.skipped}${s.reason ? ` (${s.reason})` : ""}`);
  console.log(`ゲート: missingReq=${g.missingRequirementIds.length} missingApi=${g.missingApiIds.length} missingScr=${g.missingScreenIds.length} skippedOrUnexecuted=${g.skippedOrUnexecutedCases.length} criticalOrHigh=${g.criticalOrHighUnresolvedIssues.length}`);
  if (index.suites.some((s) => s.status === "failed")) process.exit(1);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((e) => {
    console.error(e instanceof Error ? e.message : e);
    process.exit(1);
  });
}
