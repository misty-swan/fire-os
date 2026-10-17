import { describe, expect, it } from "vitest";
import ciYaml from "../.github/workflows/ci.yml?raw";
import deployProductionYaml from "../.github/workflows/deploy-production.yml?raw";
import deployStagingYaml from "../.github/workflows/deploy-staging.yml?raw";
import {
  checkEnvironment,
  deployGate,
  findSecretsInBundle,
  type DeploymentConfig,
  type WranglerEnvConfig,
} from "../scripts/check-environment";
import { checkMigrationCompatibility, parseManifest } from "../scripts/check-migrations";

/**
 * 配置ゲートの静的検査（T078、docs/08 CT-15、docs/13 RG-09、docs/02 §2）。
 *
 * - GitHub Actionsはこの開発環境から未接続（実行実績なし）。よってworkflow yamlは「コード」として
 *   本試験が内容を検査する: 必須ゲートの存在・手動起動＋ガード・環境分離・Secret非同梱・失敗時停止。
 *   yamlの読み込みはviteの?raw（テキストとして実ファイルをそのまま検査する。実行ファイルには載らない）。
 * - checkEnvironment / checkMigrationCompatibility / findSecretsInBundle / deployGate は純関数。
 *   本試験は「注入した誤設定」（demo→productionのD1/R2/Secret参照、API SPA fallbackの破り、
 *   破壊migration・適用済み履歴の書き換え）を検査する。
 * - 実ファイル（wrangler.jsonc / drizzle / dist）に対する検査は `npm run check:environment` /
 *   `npm run check:migrations`（同一の純関数を使用）が行い、CIの必須ゲートとする。
 */

const secrets = ["BETTER_AUTH_SECRET", "CLOUDFLARE_API_TOKEN_STAGING", "CLOUDFLARE_API_TOKEN_PRODUCTION"];

// wrangler.jsoncの4環境と同じ形の設定（試験用の注入データ。仮database_idも本体と同じ値）
const localEnv: WranglerEnvConfig = {
  name: "fireos-local",
  vars: { APP_ENV: "local", AUTH_BASE_URL: "http://localhost:8787" },
  assets: { directory: "./dist/client", binding: "ASSETS", not_found_handling: "single-page-application", run_worker_first: ["/api", "/api/*"] },
  d1_databases: [{ binding: "DB", database_name: "fireos-local", database_id: "00000000-0000-0000-0000-000000000001" }],
  r2_buckets: [{ binding: "FILES", bucket_name: "fireos-local-files" }],
  queues: { producers: [{ binding: "JOBS_QUEUE", queue: "fireos-local-jobs" }] },
  triggers: { crons: ["* * * * *"] },
};
const demoEnv: WranglerEnvConfig = {
  name: "fireos-demo",
  vars: { APP_ENV: "demo", AUTH_BASE_URL: "https://fireos-demo.example.invalid" },
  assets: { directory: "./dist/client", binding: "ASSETS", not_found_handling: "single-page-application", run_worker_first: ["/api", "/api/*"] },
  d1_databases: [{ binding: "DB", database_name: "fireos-demo", database_id: "00000000-0000-0000-0000-000000000002" }],
  r2_buckets: [{ binding: "FILES", bucket_name: "fireos-demo-files" }],
  ai: { binding: "AI" },
  queues: { producers: [{ binding: "JOBS_QUEUE", queue: "fireos-demo-jobs" }] },
  triggers: { crons: ["* * * * *"] },
};
const stagingEnv: WranglerEnvConfig = {
  name: "fireos-staging",
  vars: { APP_ENV: "staging", AUTH_BASE_URL: "https://fireos-staging.example.invalid" },
  assets: { directory: "./dist/client", binding: "ASSETS", not_found_handling: "single-page-application", run_worker_first: ["/api", "/api/*"] },
  d1_databases: [{ binding: "DB", database_name: "fireos-staging", database_id: "00000000-0000-0000-0000-000000000003" }],
  r2_buckets: [{ binding: "FILES", bucket_name: "fireos-staging-files" }],
  ai: { binding: "AI" },
  queues: { producers: [{ binding: "JOBS_QUEUE", queue: "fireos-staging-jobs" }] },
  triggers: { crons: ["* * * * *"] },
};
const productionEnv: WranglerEnvConfig = {
  name: "fireos-production",
  vars: { APP_ENV: "production", AUTH_BASE_URL: "https://fireos-production.example.invalid" },
  assets: { directory: "./dist/client", binding: "ASSETS", not_found_handling: "single-page-application", run_worker_first: ["/api", "/api/*"] },
  d1_databases: [{ binding: "DB", database_name: "fireos-production", database_id: "00000000-0000-0000-0000-000000000004" }],
  r2_buckets: [{ binding: "FILES", bucket_name: "fireos-production-files" }],
  ai: { binding: "AI" },
  queues: { producers: [{ binding: "JOBS_QUEUE", queue: "fireos-production-jobs" }] },
  triggers: { crons: ["* * * * *"] },
};

const config = (envName: string, env: WranglerEnvConfig): DeploymentConfig => ({
  envName,
  env,
  others: { local: localEnv, demo: demoEnv, staging: stagingEnv, production: productionEnv },
  secrets,
});

// 適用済み2件の履歴（全環境共通のschema履歴を模した注入データ）
const appliedHistory = {
  "0001_core.sql": "CREATE TABLE units (id TEXT PRIMARY KEY, name TEXT NOT NULL);\nCREATE TABLE audit_log (id TEXT PRIMARY KEY);",
  "0002_jobs.sql": "CREATE TABLE jobs (id TEXT PRIMARY KEY, unit_id TEXT NOT NULL);",
};
const historyManifest = () => parseManifest({ ...appliedHistory });

describe("deploy-config (T078)", () => {
  it("demo_binding_or_incompatible_schema_blocks_deploy", () => {
    // 1) demoへproductionのD1/R2参照とSecretのvars混入を注入（docs/13 RG-09: 本番/デモ分離）
    const crossInjected = config("demo", {
      ...demoEnv,
      d1_databases: [{ binding: "DB", database_name: "fireos-production", database_id: "00000000-0000-0000-0000-000000000004" }],
      r2_buckets: [{ binding: "FILES", bucket_name: "fireos-production-files" }],
      vars: { ...demoEnv.vars, BETTER_AUTH_SECRET: "demo-config-that-leaks" },
    });
    const crossEnvironmentCheck = checkEnvironment(crossInjected);
    expect(crossEnvironmentCheck.ok).toBe(false);
    expect(crossEnvironmentCheck.crossEnvironment.ok).toBe(false);
    expect(crossEnvironmentCheck.secrets.ok).toBe(false);

    // 2) API SPA fallback設定の破り（run_worker_firstが無いと/api未定義routeがHTMLを返しうる）
    const spaInjected = config("demo", {
      ...demoEnv,
      assets: { directory: "./dist/client", binding: "ASSETS", not_found_handling: "none", run_worker_first: [] },
    });
    const spaFallbackCheck = checkEnvironment(spaInjected);
    expect(spaFallbackCheck.ok).toBe(false);
    expect(spaFallbackCheck.apiRouting.ok).toBe(false);

    // 3) 破壊migration（旧workerが必要とする列を、新workerの配備前に削除）
    const destructiveNext = historyManifest();
    destructiveNext.entries.push(...parseManifest({ "0003_breaking.sql": "-- 旧workerが必要とする列を削除する\nALTER TABLE units DROP COLUMN name;" }).entries);
    const incompatibleMigration = checkMigrationCompatibility(historyManifest(), destructiveNext);
    expect(incompatibleMigration.ok).toBe(false);

    // 4) 旧worker×新schemaのもう一つの形: 適用済み履歴の書き換え（適用済みDBと一致しなくなる）
    const rewrittenNext = parseManifest({
      ...appliedHistory,
      "0002_jobs.sql": "CREATE TABLE jobs (id TEXT PRIMARY KEY, unit_id TEXT NOT NULL, rewritten TEXT);",
      "0003_additive.sql": "ALTER TABLE jobs ADD COLUMN note TEXT;",
    });
    expect(checkMigrationCompatibility(historyManifest(), rewrittenNext).ok).toBe(false);

    // 5) Secret検査: 実配置と同じ形のvars/成果物テキストにはSecret名が現れない（空で正）
    const bundleTexts = {
      "wrangler.jsonc [vars] (demo)": JSON.stringify(demoEnv.vars),
      "dist/client/assets/index-abc123.js": 'const APP_ENV="demo";const AUTH_BASE_URL="https://fireos-demo.example.invalid";',
      "dist/client/index.html": "<!doctype html><title>FireOS</title>",
    };
    const secretsInBundle = findSecretsInBundle(secrets, bundleTexts);
    expect(secretsInBundle).toEqual([]);

    // 6) 失敗した検査がある状態では配置を許さない（CI失敗・誤接続・互換外migrationで自動停止）
    const { allowed: failedChecksAllowDeploy } = deployGate([
      { name: "crossEnvironment", ok: crossEnvironmentCheck.ok, failures: crossEnvironmentCheck.failures },
      { name: "apiRouting", ok: spaFallbackCheck.ok, failures: spaFallbackCheck.failures },
      { name: "migrationCompatibility", ok: incompatibleMigration.ok, failures: incompatibleMigration.failures },
    ]);
    expect(failedChecksAllowDeploy).toBe(false);
  });

  it("clean_environment_and_staged_expand_backfill_contract_pass", () => {
    // 正の対照: 正しい設定・段階化されたmigrationは通る（検査が常時失敗になっていないこと）
    for (const [envName, env] of [
      ["demo", demoEnv],
      ["staging", stagingEnv],
      ["production", productionEnv],
      ["local", localEnv],
    ] as const) {
      const check = checkEnvironment(config(envName, env));
      expect(check.ok, `${envName}: ${check.failures.join(" / ")}`).toBe(true);
    }

    // expand → backfill → contract（新worker配備後の削除）に段階化した破壊的変更は通る
    const stagedNext = parseManifest({
      ...appliedHistory,
      "0003_name_kana_expand.sql": "ALTER TABLE units ADD COLUMN kana TEXT;",
      "0004_name_kana_backfill.sql": "-- deploy: backfill\nUPDATE units SET kana = name WHERE kana IS NULL;",
      "0005_name_contract.sql": "-- deploy: contract\n-- requires: 0003\nALTER TABLE units DROP COLUMN name;",
    });
    const stagedCheck = checkMigrationCompatibility(historyManifest(), stagedNext);
    expect(stagedCheck.ok, stagedCheck.failures.join(" / ")).toBe(true);

    // Secret検査が空を返すのは「検出能力がある」ことの裏付けがあってこそ
    const leak = findSecretsInBundle(secrets, { "dist/client/assets/app.js": "window.__x='BETTER_AUTH_SECRET';" });
    expect(leak.length).toBeGreaterThan(0);

    const { allowed: cleanChecksAllowDeploy } = deployGate([
      { name: "crossEnvironment", ok: true },
      { name: "migrationCompatibility", ok: true },
    ]);
    expect(cleanChecksAllowDeploy).toBe(true);
  });

  it("workflows_keep_required_gates_and_block_secret_inline_and_cross_env", () => {
    // CIの必須ゲート（docs/16 T078: contract/typecheck/unit/Workers/e2e/build/Secret検査）
    const requiredGates = [
      "npm run typecheck",
      "npm run check:contracts",
      "npm run check:migrations",
      "npm run build",
      "npm run check:environment",
      "npx vitest --run",
      "npm run test:e2e",
    ];
    for (const gate of requiredGates) {
      expect(ciYaml).toContain(gate);
    }

    // 配置workflow: 手動起動のみ。verify（全ゲート）に依存し、verifyが失敗すればdeployは実行されない
    for (const yaml of [deployStagingYaml, deployProductionYaml]) {
      for (const gate of requiredGates) {
        expect(yaml).toContain(gate);
      }
      expect(yaml).toContain("workflow_dispatch");
      expect(yaml).toContain("needs: verify");
    }

    // 環境分離: 各workflowは自分の環境にしか触れない（docs/13 RG-09）
    expect(deployStagingYaml).toContain("environment: staging");
    expect(deployStagingYaml).toContain("--env staging --remote --yes-i-know");
    expect(deployStagingYaml.toLowerCase()).not.toContain("production");
    expect(deployProductionYaml).toContain("environment: production");
    expect(deployProductionYaml).toContain("--env production --remote --yes-i-know");
    expect(deployProductionYaml.toLowerCase()).not.toContain("staging");
    // productionは実行されない限り何もしない: push起動なし・confirm入力ガード・main限定
    expect(deployProductionYaml).not.toMatch(/(^|\n)\s+push:/);
    expect(deployProductionYaml).toContain("inputs.confirm == 'production'");
    expect(deployProductionYaml).toContain("refs/heads/main");

    // Secretの値をyamlへ書かない。token等の参照はGitHub Environment secretsの名前のみ
    for (const yaml of [ciYaml, deployStagingYaml, deployProductionYaml]) {
      expect(yaml).not.toContain("BETTER_AUTH_SECRET");
      expect(yaml).not.toContain("dev-only-");
      for (const line of yaml.split("\n")) {
        if (line.includes("CLOUDFLARE_API_TOKEN") || line.includes("CLOUDFLARE_ACCOUNT_ID")) {
          expect(line, line).toMatch(/\$\{\{ secrets\./);
        }
      }
    }
  });
});
