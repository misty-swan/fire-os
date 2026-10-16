import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { parseSearchConfig, type SearchDevelopmentConfig } from "../src/server/search/port";
import { selectRetrievalBackend, type CandidateEvaluation } from "../src/server/search/evaluate";

/**
 * 検索方式の選定評価の実行入口（T065の薄いラッパ）。
 *
 * **実際のD1実測はworkers試験が実行する**（ローカルで実測できるのはworkerd D1上のd1_ftsのみ）:
 *
 *   npx vitest --run tests/retrieval-selection.test.ts -t retrieval_selection_requires_same_fixed_dataset_and_acl
 *
 * 本scriptでできること（Node側で決定的に確認できる範囲）:
 *   1. コミット済みdataset（tests/fixtures/ai/rag-holdout.jsonl）と生成TSモジュール2種
 *      （tests/src。T061と同じ二重管理）の一致とsha256の表示
 *   2. 固定datasetの統計表示（文書数・頁数・質問数・質問種別の内訳）
 *   3. config/search-development.json（選定結果の固定config）の読み込み検証（未知backend・空versionを拒否）
 *   4. --metrics <file> があれば、workers試験が記録した候補評価（CandidateEvaluation[]）を読んで
 *      selectRetrievalBackend（証跡ベースの選定）を実行し結果を表示する
 *
 * 使い方: npx tsx scripts/evaluate-retrieval.ts [--metrics candidates.json]
 */

const JSONL_PATH = "tests/fixtures/ai/rag-holdout.jsonl";
const GENERATED_TEST_PATH = "tests/fixtures/ai/generated-rag-holdout.ts";
const GENERATED_RUNTIME_PATH = "src/server/search/dataset/rag-holdout.ts";
const CONFIG_PATH = "config/search-development.json";

const fail = (message: string): never => {
  console.error(`NG: ${message}`);
  process.exit(1);
};

const jsonl = readFileSync(JSONL_PATH, "utf8");
const generatedTest = readFileSync(GENERATED_TEST_PATH, "utf8");
const generatedRuntime = readFileSync(GENERATED_RUNTIME_PATH, "utf8");
const sha256 = createHash("sha256").update(jsonl).digest("hex");

// 1. 生成TSモジュールと正本の一致（二重管理の一致。手で編集したらここで落ちる）
const bodyOf = (text: string): string | null => {
  const match = /export const ragHoldoutJsonl = (".*");/s.exec(text);
  return match ? (JSON.parse(match[1]!) as string) : null;
};
const testBody = bodyOf(generatedTest);
const runtimeBody = bodyOf(generatedRuntime);
if (testBody === null || runtimeBody === null) fail(`${GENERATED_TEST_PATH} / ${GENERATED_RUNTIME_PATH} の形式が不正です`);
if (testBody !== jsonl || runtimeBody !== jsonl) {
  fail("生成TSモジュールが正本のjsonlと一致しません。npx tsx scripts/generate-retrieval-dataset.ts で再生成してください");
}

// 2. 固定datasetの統計
const rows = jsonl
  .split("\n")
  .filter((line) => line.length > 0)
  .map((line) => JSON.parse(line) as Record<string, unknown>);
const docRows = rows.filter((row) => row.kind === "document");
const questionRows = rows.filter((row) => row.kind === "question");
const byType = new Map<string, number>();
for (const row of questionRows) {
  const type = row.type as string;
  byType.set(type, (byType.get(type) ?? 0) + 1);
}
console.log(`固定dataset: sha256=${sha256}`);
console.log(
  `  文書: ${docRows.length}件（unit A=${docRows.filter((row) => row.unit === "A").length}／unit B=${docRows.filter((row) => row.unit === "B").length}）`,
);
console.log(`  頁: ${docRows.reduce((sum, row) => sum + (row.pages as string[]).length, 0)}頁`);
console.log(`  質問: ${questionRows.length}件`);
for (const [type, count] of [...byType.entries()].sort()) {
  console.log(`    ${type}: ${count}件`);
}

// 3. 固定configの読み込み検証（未知backend・空version・未知キーを拒否する）
const loadConfig = (): SearchDevelopmentConfig => {
  try {
    return parseSearchConfig(JSON.parse(readFileSync(CONFIG_PATH, "utf8")));
  } catch (err) {
    return fail(`${CONFIG_PATH}が不正です: ${(err as Error).message}`);
  }
};
const config = loadConfig();
console.log(`固定config: backend=${config.backend} version=${config.version} tokenizer=${config.tokenizer ?? "-"} topK=${config.topK ?? "-"}`);
if (config.datasetHash !== sha256) {
  fail(`configのdatasetHash（${config.datasetHash}）がdatasetのsha256（${sha256}）と一致しません。選定を更新してください`);
}
for (const broken of [
  { ...config, backend: "elasticsearch" },
  { ...config, version: "" },
  { ...config, unknownKey: true },
]) {
  try {
    parseSearchConfig(broken);
    fail("ローダーが未知backend・空version・未知キーを拒否していません");
  } catch {
    // 拒否されるのが正しい
  }
}

// 4. 実測結果（workers試験の記録）があるなら選定を実行して表示する
const metricsIndex = process.argv.indexOf("--metrics");
if (metricsIndex >= 0) {
  const metricsPath = process.argv[metricsIndex + 1] ?? fail("--metricsには候補評価（CandidateEvaluation[]）のJSONファイルを渡してください");
  let candidates: CandidateEvaluation[];
  try {
    candidates = JSON.parse(readFileSync(metricsPath, "utf8")) as CandidateEvaluation[];
  } catch (err) {
    fail(`--metricsのファイルが読めません: ${(err as Error).message}`);
  }
  const selection = selectRetrievalBackend(candidates!);
  console.log("選定結果:");
  console.log(`  backend=${selection.backend} version=${selection.config.version}`);
  console.log(`  ${selection.rationale}`);
} else {
  console.log("D1実測はworkers試験で実行してください:");
  console.log("  npx vitest --run tests/retrieval-selection.test.ts -t retrieval_selection_requires_same_fixed_dataset_and_acl");
  console.log("Vectorizeとの実測比較は未実施（docs/evidence/V04-retrieval.md の「未実施手順」）");
}
