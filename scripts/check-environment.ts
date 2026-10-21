// 環境配置の静的検査（T078）。RG-09（本番/デモ分離）・CT-15（CI/環境/migration）に対応する。
// - 純関数（checkEnvironment / findSecretsInBundle / deployGate）は試験（tests/deploy-config.test.ts）から
//   直接呼ぶ。CLI（`npm run check:environment`）は実ファイル（wrangler.jsonc / dist/client）を読んで
//   同じ純関数に渡す。Secretは値を持たず名前だけ扱う（.dev.vars / wrangler secret put / CIのEnvironment secrets）。
// - 検査内容: 必須binding（docs/02 §2）、APP_ENV一致、4環境の資源分離（demo→production参照の拒否）、
//   /apiをSPA fallbackへ流さない設定（runtime.test.tsが実測で二重に守る設定側の検査）、
//   Secret名がvars/ビルド成果物に現れないこと。1つでも失敗したらCI（配置ゲート）が停止する。
export type WranglerEnvConfig = {
  name?: string;
  vars?: Record<string, string>;
  assets?: { directory?: string; binding?: string; not_found_handling?: string; run_worker_first?: string[] };
  d1_databases?: Array<{ binding: string; database_name: string; database_id: string }>;
  r2_buckets?: Array<{ binding: string; bucket_name: string }>;
  ai?: { binding: string };
  queues?: { producers?: Array<{ binding: string; queue: string }> };
  triggers?: { crons?: string[] };
};

export type DeploymentConfig = {
  envName: string;
  env: WranglerEnvConfig;
  /** 他環境の設定。資源の兼用（demo→production参照等）を検出するために必須 */
  others: Record<string, WranglerEnvConfig>;
  /** 管理下のSecret名（値は持たない。.dev.vars / wrangler secret put / CIのEnvironment secretsの名前） */
  secrets: readonly string[];
};

export type CheckResult = { ok: boolean; failures: string[] };

export type EnvironmentCheck = {
  envName: string;
  ok: boolean;
  bindings: CheckResult;
  identity: CheckResult;
  crossEnvironment: CheckResult;
  apiRouting: CheckResult;
  secrets: CheckResult;
  /** 全カテゴリの失敗の集約（ok:falseの根拠） */
  failures: string[];
};

export type DeployCheck = { name: string; ok: boolean; failures?: readonly string[] };

export const KNOWN_ENVS = ["local", "demo", "staging", "production"] as const;
// localのSecretは乱数に開発用の目印 "dev-only-" を付ける（scripts/ensure-dev-vars.ts）。配置先に現れてはならない。
export const DEV_SECRET_MARKER = "dev-only-";

export function checkEnvironment(config: DeploymentConfig): EnvironmentCheck {
  const bindings = checkBindings(config);
  const identity = checkIdentity(config);
  const crossEnvironment = checkCrossEnvironment(config);
  const apiRouting = checkApiRouting(config);
  const secrets = checkSecrets(config);
  const failures = [bindings, identity, crossEnvironment, apiRouting, secrets].flatMap((r) => r.failures);
  return { envName: config.envName, ok: failures.length === 0, bindings, identity, crossEnvironment, apiRouting, secrets, failures };
}

function checkBindings(config: DeploymentConfig): CheckResult {
  const failures: string[] = [];
  const env = config.env;
  const db = (env.d1_databases ?? []).filter((d) => d.binding === "DB");
  if (db.length !== 1) failures.push("DB bindingのD1を1つだけ設定してください");
  const files = (env.r2_buckets ?? []).filter((r) => r.binding === "FILES");
  if (files.length !== 1) failures.push("FILES bindingのR2を1つだけ設定してください");
  if (env.assets?.binding !== "ASSETS") failures.push("ASSETS bindingのassets設定が必要です");
  const jobs = (env.queues?.producers ?? []).filter((q) => q.binding === "JOBS_QUEUE");
  if (jobs.length !== 1) failures.push("JOBS_QUEUE bindingのqueue producerを1つだけ設定してください");
  if (config.envName === "local") {
    if (env.ai !== undefined) failures.push("localにAI bindingを置きません（Workers AIは常にCloudflare本体へ接続するため。docs/02 §2）");
  } else if (env.ai?.binding !== "AI") {
    failures.push("demo/staging/productionにはAI bindingが必要です");
  }
  // TEST_AUTH / TEST_MIGRATIONS は試験専用binding。wrangler設定（特に配置先環境）に書かない。
  if ((env.d1_databases ?? []).some((d) => d.binding === "TEST_MIGRATIONS")) failures.push("TEST_MIGRATIONS は試験専用bindingです。wrangler設定に書かないでください");
  if (env.vars !== undefined && "TEST_AUTH" in env.vars) failures.push("TEST_AUTH は試験専用bindingです。wrangler設定に書かないでください");
  return { ok: failures.length === 0, failures };
}

function checkIdentity(config: DeploymentConfig): CheckResult {
  const failures: string[] = [];
  if (!(KNOWN_ENVS as readonly string[]).includes(config.envName)) failures.push(`未知の環境名です: ${config.envName}（${KNOWN_ENVS.join(" / ")}）`);
  if (config.env.vars?.APP_ENV !== config.envName) failures.push(`vars.APP_ENV が環境名と一致しません: ${config.env.vars?.APP_ENV ?? "(無し)"} ≠ ${config.envName}`);
  if (!config.env.vars?.AUTH_BASE_URL) failures.push("vars.AUTH_BASE_URL が必要です");
  const workerName = config.env.name;
  if (!workerName || !workerName.includes(config.envName)) failures.push(`Worker名が環境名を含みません: ${workerName ?? "(無し)"}（fireos-<環境名>）`);
  return { ok: failures.length === 0, failures };
}

// 環境が持つ資源値（demo→production参照などの兼用検出用）。資源種別ごとに他環境と比較する。
type Resource = { kind: string; value: string };

function resourcesOf(env: WranglerEnvConfig): Resource[] {
  const resources: Resource[] = [];
  if (env.name) resources.push({ kind: "Worker名", value: env.name });
  for (const d of env.d1_databases ?? []) {
    resources.push({ kind: "D1 database_id", value: d.database_id });
    resources.push({ kind: "D1 database_name", value: d.database_name });
  }
  for (const r of env.r2_buckets ?? []) resources.push({ kind: "R2 bucket_name", value: r.bucket_name });
  for (const q of env.queues?.producers ?? []) resources.push({ kind: "queue名", value: q.queue });
  if (env.vars?.AUTH_BASE_URL) resources.push({ kind: "AUTH_BASE_URL", value: env.vars.AUTH_BASE_URL });
  return resources;
}

function checkCrossEnvironment(config: DeploymentConfig): CheckResult {
  const failures: string[] = [];
  const self = resourcesOf(config.env);
  // 資源名（database_id以外の名前）は自分の環境名を含むこと（fireos-demo 等）。取り違え（demoにproductionの名前を書く等）を検出する。
  for (const resource of self) {
    if (resource.kind === "AUTH_BASE_URL" || resource.kind === "D1 database_id") continue;
    if (!resource.value.includes(config.envName)) {
      failures.push(`${config.envName}設定の${resource.kind}が${config.envName}を指していません: ${resource.value}`);
    }
  }
  for (const [otherName, otherEnv] of Object.entries(config.others)) {
    if (otherName === config.envName) continue;
    const otherValues = new Set(resourcesOf(otherEnv).map((r) => `${r.kind}=${r.value}`));
    for (const resource of self) {
      if (otherValues.has(`${resource.kind}=${resource.value}`)) {
        failures.push(`${config.envName}の${resource.kind}（${resource.value}）が${otherName}と兼用です。環境のbinding・資源は分離してください（RG-09）`);
      }
    }
  }
  return { ok: failures.length === 0, failures };
}

function checkApiRouting(config: DeploymentConfig): CheckResult {
  const failures: string[] = [];
  const assets = config.env.assets;
  if (assets?.not_found_handling !== "single-page-application") {
    failures.push("assets.not_found_handling は single-page-application にしてください（アプリ配下だけSPA fallback）");
  }
  const workerFirst = assets?.run_worker_first ?? [];
  // 全経路の /*（demoのdocument CSP配信。wrangler.jsonc T089）でも /api と /api/* の明示（他環境の既定）
  // でも良い: どちらも「API要求は必ずWorkerへ届き、未定義APIがSPAのHTMLで成功に見えない」を満たす。
  const apiWorkerFirst = workerFirst.includes("/api") && workerFirst.includes("/api/*");
  const allWorkerFirst = workerFirst.includes("/*");
  if (!apiWorkerFirst && !allWorkerFirst) {
    failures.push("assets.run_worker_first に /api と /api/* の両方（または全経路の /*）が必要です（未定義APIがSPAのHTMLを返して成功に見えない防止。設定側はWorker側のJSON 404と二重）");
  }
  if (assets?.directory !== "./dist/client") failures.push("assets.directory は ./dist/client にしてください（WorkerとSPAを同一originに同居させる）");
  return { ok: failures.length === 0, failures };
}

function checkSecrets(config: DeploymentConfig): CheckResult {
  const failures: string[] = [];
  const vars = config.env.vars ?? {};
  for (const secret of config.secrets) {
    if (secret in vars) failures.push(`${secret} がvarsのキーにあります。Secretは設定に書かず、localは.dev.vars、他は wrangler secret put で設定してください`);
    for (const [key, value] of Object.entries(vars)) {
      if (value.includes(secret)) failures.push(`vars.${key} の値にSecret名（${secret}）が含まれています。Secretは設定に書きません`);
    }
  }
  for (const [key, value] of Object.entries(vars)) {
    if (value.startsWith(DEV_SECRET_MARKER)) failures.push(`vars.${key} が開発用Secret（${DEV_SECRET_MARKER}で始まる値）です。配置先環境に設定しません`);
  }
  return { ok: failures.length === 0, failures };
}

/** Secret名がテキスト（wrangler設定のvarsやdist/の成果物）に現れた箇所を返す。空なら漏えい無し。 */
export function findSecretsInBundle(secrets: readonly string[], texts: Record<string, string>): string[] {
  const found: string[] = [];
  for (const [path, content] of Object.entries(texts)) {
    for (const secret of secrets) {
      if (content.includes(secret)) found.push(`${secret} が ${path} に現れます`);
    }
  }
  return found.sort();
}

export type DeployGateResult = { allowed: boolean; blockers: string[] };

/** 検査結果の全てがokのときだけ配置を許す。1つでも失敗があれば blockers と共に拒否する（CI失敗＝自動停止）。 */
export function deployGate(checks: readonly DeployCheck[]): DeployGateResult {
  const blockers = checks
    .filter((check) => !check.ok)
    .map((check) => `${check.name}: ${(check.failures ?? ["検査失敗"]).join(" / ")}`);
  return { allowed: blockers.length === 0, blockers };
}

// ==== 以下、CLI（npm run check:environment）。試験からは呼ばれない（workerdにnode:fsは無いため動的import）。 ====

const CLI_DEFAULT_SECRETS = ["BETTER_AUTH_SECRET", DEV_SECRET_MARKER];

type ParsedWrangler = WranglerEnvConfig & { env?: Record<string, WranglerEnvConfig> };

type NodeFs = typeof import("node:fs");
async function lazyFs(): Promise<NodeFs> {
  const specifier = "node:" + "fs";
  return (await import(/* @vite-ignore */ specifier)) as NodeFs;
}

// JSONCのコメント（// と //** */）だけを取り除く。文字列リテラル（https://... 等）の中は触らない。
// （T086でexport: 試験が実wrangler.jsoncを同じ手続きで読めるように。CLIと試験で解析を共有する）
export function stripJsonComments(jsonc: string): string {
  let out = "";
  let inString = false;
  for (let i = 0; i < jsonc.length; i++) {
    const ch = jsonc.charAt(i);
    if (inString) {
      out += ch;
      if (ch === "\\") {
        out += jsonc.charAt(i + 1);
        i++;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }
    if (ch === '"') {
      inString = true;
      out += ch;
      continue;
    }
    if (ch === "/" && jsonc.charAt(i + 1) === "/") {
      while (i < jsonc.length && jsonc.charAt(i) !== "\n") i++;
      out += "\n";
      continue;
    }
    if (ch === "/" && jsonc.charAt(i + 1) === "*") {
      i += 2;
      while (i < jsonc.length && !(jsonc.charAt(i) === "*" && jsonc.charAt(i + 1) === "/")) i++;
      i++;
      continue;
    }
    out += ch;
  }
  // 末尾カンマの除去（この設定ファイルの文字列内には ",}" 等が現れない前提）
  return out.replace(/,(\s*[}\]])/g, "$1");
}

function collectBundleTexts(fs: NodeFs, dir: string, out: Record<string, string>): number {
  const TEXT_EXTENSIONS = [".js", ".css", ".html", ".json", ".txt", ".svg", ".wasm", ".webmanifest", ".xml", ".map"];
  if (!fs.existsSync(dir)) return -1;
  let count = 0;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const path = `${dir}/${entry.name}`;
    if (entry.isDirectory()) {
      count += collectBundleTexts(fs, path, out);
    } else if (TEXT_EXTENSIONS.some((ext) => entry.name.endsWith(ext))) {
      out[path] = fs.readFileSync(path, "utf8");
      count++;
    }
  }
  return count;
}

async function main(): Promise<number> {
  const fs = await lazyFs();
  const secrets = [...CLI_DEFAULT_SECRETS];
  const args = process.argv.slice(2);
  while (args.includes("--secret")) {
    const index = args.indexOf("--secret");
    const name = args[index + 1];
    if (name) secrets.push(name);
    args.splice(index, 2);
  }

  const wrangler = JSON.parse(stripJsonComments(fs.readFileSync("wrangler.jsonc", "utf8"))) as ParsedWrangler;
  const local: WranglerEnvConfig = {
    name: wrangler.name,
    vars: wrangler.vars,
    assets: wrangler.assets,
    d1_databases: wrangler.d1_databases,
    r2_buckets: wrangler.r2_buckets,
    queues: wrangler.queues,
    triggers: wrangler.triggers,
  };
  const envs: Record<string, WranglerEnvConfig> = { local, ...(wrangler.env ?? {}) };

  const texts: Record<string, string> = {};
  for (const [envName, env] of Object.entries(envs)) {
    texts[`${envName} の [vars]`] = JSON.stringify(env.vars ?? {});
  }
  const bundleCount = collectBundleTexts(fs, "dist/client", texts);
  const problems: string[] = [];
  if (bundleCount < 0) problems.push("dist/client がありません。Secret検査の前に npm run build を実行してください");
  for (const [envName, env] of Object.entries(envs)) {
    problems.push(...checkEnvironment({ envName, env, others: envs, secrets }).failures);
  }
  problems.push(...findSecretsInBundle(secrets, texts));

  if (problems.length) {
    console.error("環境検査に失敗:\n- " + problems.join("\n- "));
    return 1;
  }
  console.log(`環境検査OK: ${Object.keys(envs).length}環境のbinding分離・API routing・Secret非同梱（dist ${bundleCount}ファイル含む）`);
  return 0;
}

const runningAsCli = typeof process !== "undefined" && process.argv[1]?.endsWith("check-environment.ts");
if (runningAsCli) {
  void main().then((code) => process.exit(code));
}
