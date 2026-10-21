import { describe, expect, it } from "vitest";
import demoResetYaml from "../.github/workflows/demo-reset.yml?raw";
import pkgRaw from "../package.json?raw";
import { buildRemoteWipeSql, buildSeedCommands, isInternalTableName, parseDemoSeedArgs } from "../scripts/seed-demo";

/**
 * demo seedの`--remote`対応と週次リセットworkflow（営業デモTask5）。
 *
 * - **実環境（実Cloudflare）には接続しない**。検査はすべて静的: ①scripts純関数（`buildSeedCommands` /
 *   `parseDemoSeedArgs` / `buildRemoteWipeSql`）が作るwranglerコマンド列と使い方の誤りの拒否、
 *   ②workflow yaml（`.github/workflows/demo-reset.yml`）の内容。yamlの読み込みはviteの?raw
 *   （tests/deploy-config.test.tsと同じ様式。実行ファイルには載らない）。
 * - 規律の固定（Task 1のGlobal Constraints）: `--remote` は `--env demo --confirm demo` が無いと動かない
 *   （scripts/bootstrap-admin.ts:26-28と同じ確認規律）。demo以外の環境名（staging/production）は
 *   --confirmが一致しても拒否する。local（`npm run demo` / `demo:reset`）のコマンド列は
 *   Task 3・4の物から**1文字も変えない**（byte-identicalの回帰）。
 * - ワイプ戦略: 週次リセットは全表DROP（sqlite内部表を除く。d1_migrationsも消えるため直後の
 *   migration適用でschemaを作り直す）→ migration → seed。R2は同じキーの上書きなので残格納は起こらない
 *   （wranglerにprefix一括削除・object一覧は無い。残作業の診はops/demo-deploy.md §3.1）。
 */

const localMode = { kind: "local", persist: ".wrangler/demo" } as const;
const remoteMode = { kind: "remote-demo", wipe: true } as const;

describe("demo-reset (営業デモTask5)", () => {
  it("local_seed_commands_stay_byte_identical", () => {
    // local（npm run demo / demo:reset の初回起動経路）のコマンド列はTask 3・4の実装から変えない。
    // ここで固定する配列が「scripts/seed-demo.ts が実際に実行するargv」そのもの（wrangler本体より後ろ）
    const c = buildSeedCommands(localMode, { bucket: "fireos-local-files" });
    expect(c.d1Read("SELECT 1 AS x")).toEqual([
      "d1", "execute", "DB", "--local", "--persist-to", ".wrangler/demo", "--json", "--command", "SELECT 1 AS x",
    ]);
    expect(c.d1File("seed-demo.sql")).toEqual([
      "d1", "execute", "DB", "--local", "--persist-to", ".wrangler/demo", "--file", "seed-demo.sql",
    ]);
    expect(c.r2Put("demo/facility-photo-01.png", "image/png", "f.png")).toEqual([
      "r2", "object", "put", "fireos-local-files/demo/facility-photo-01.png",
      "--local", "--persist-to", ".wrangler/demo", "--file", "f.png", "--content-type", "image/png", "--force",
    ]);
    // localのmigrationは scripts/demo.ts が行うため、seed CLIはmigrationを呼ばない
    expect(c.d1Migrate()).toBeNull();
  });

  it("remote_seed_commands_target_only_the_demo_env", () => {
    // remote（demo環境確定済み）: D1は --env demo --remote、R2は --env demo --remote
    // （wrangler 4.150の r2 object put は --remoteと--envを受け付ける。npx wrangler r2 object put --help で確認済み）
    const c = buildSeedCommands(remoteMode, { bucket: "fireos-demo-files" });
    for (const args of [c.d1Read("SELECT 1"), c.d1File("seed-demo.sql")]) {
      expect(args).toContain("--env");
      expect(args).toContain("demo");
      expect(args).toContain("--remote");
      expect(args).not.toContain("--local");
      expect(args).not.toContain("--persist-to");
    }
    expect(c.d1Read("SELECT 1")).toEqual([
      "d1", "execute", "DB", "--env", "demo", "--remote", "--json", "--command", "SELECT 1",
    ]);
    expect(c.r2Put("demo/facility-photo-01.png", "image/png", "f.png")).toEqual([
      "r2", "object", "put", "fireos-demo-files/demo/facility-photo-01.png",
      "--env", "demo", "--remote", "--file", "f.png", "--content-type", "image/png", "--force",
    ]);
    // wipeの直後にはschemaが無い。migrationの全件再適用（d1_migrationsもDROPしているため）をremoteは必ず行う
    expect(c.d1Migrate()).toEqual(["d1", "migrations", "apply", "DB", "--env", "demo", "--remote"]);
  });

  it("remote_without_env_or_confirm_is_a_usage_error", () => {
    // 欠けは1つでも拒否（bootstrap-admin.tsと同じ規律）。エラー文は正しい使い方を案内する
    const bare = parseDemoSeedArgs(["--remote"]);
    if (!("usageError" in bare)) throw new Error("--remote単独は拒否されるべき");
    expect(bare.usageError).toContain("--env demo --confirm demo");

    const noConfirm = parseDemoSeedArgs(["--remote", "--env", "demo"]);
    if (!("usageError" in noConfirm)) throw new Error("--confirm欠けは拒否されるべき");
    expect(noConfirm.usageError).toContain("--confirm");

    const noEnv = parseDemoSeedArgs(["--remote", "--confirm", "demo"]);
    if (!("usageError" in noEnv)) throw new Error("--env欠けは拒否されるべき");
    expect(noEnv.usageError).toContain("--env");

    // --persist-to はローカル専用（remoteではローカルのpersistを使わない）
    const withPersist = parseDemoSeedArgs(["--remote", "--env", "demo", "--confirm", "demo", "--persist-to", ".wrangler/demo"]);
    if (!("usageError" in withPersist)) throw new Error("--persist-to付きのremoteは拒否されるべき");
    expect(withPersist.usageError).toContain("--persist-to");
  });

  it("remote_to_non_demo_env_is_refused_even_with_matching_confirm", () => {
    // demo環境以外への書込みは拒絶（Task 1のGlobal Constraints）。--confirmを揃えても env がdemoでなければ止める
    for (const env of ["production", "staging", "local"]) {
      const refused = parseDemoSeedArgs(["--remote", "--env", env, "--confirm", env]);
      if (!("usageError" in refused)) throw new Error(`--env ${env} は拒否されるべき`);
      expect(refused.usageError).toContain("demo");
      expect(refused.usageError).toContain(env);
    }
    // --env / --confirm / --wipe は --remote と一緒にだけ使える（localの使い方を壊さない）
    const noRemote = parseDemoSeedArgs(["--env", "demo", "--confirm", "demo"]);
    if (!("usageError" in noRemote)) throw new Error("--remote無しの--envは拒否されるべき");
    expect(noRemote.usageError).toContain("--remote");
    const localWipe = parseDemoSeedArgs(["--wipe"]);
    if (!("usageError" in localWipe)) throw new Error("localでの--wipeは拒否されるべき");
    expect(localWipe.usageError).toContain("--persist-to");

    // 正の対照: demo + confirm demo は通る。--wipeの有無がreset（wipeあり）とseed（ wipe無し）の違い
    const reset = parseDemoSeedArgs(["--remote", "--env", "demo", "--confirm", "demo", "--wipe"]);
    if (!("remoteDemo" in reset)) throw new Error("正しいremote引数は通るべき");
    expect(reset.wipe).toBe(true);
    const seed = parseDemoSeedArgs(["--remote", "--env", "demo", "--confirm", "demo"]);
    if (!("remoteDemo" in seed)) throw new Error("wipe無しのremote seedも通るべき");
    expect(seed.wipe).toBe(false);
    // --demo-password はremoteでも有効（リセット後に同じ資格情報へ戻す運用。検査はlocalと同じ規律）
    const short = parseDemoSeedArgs(["--remote", "--env", "demo", "--confirm", "demo", "--wipe", "--demo-password", "short"]);
    if (!("usageError" in short)) throw new Error("12文字未満はremoteでも拒否されるべき");
    expect(short.usageError).toContain("12文字以上");
    const fixed = parseDemoSeedArgs(["--remote", "--env", "demo", "--confirm", "demo", "--demo-password", "long-enough-pass"]);
    if (!("remoteDemo" in fixed)) throw new Error("固定パスワード付きのremoteは通るべき");
    expect(fixed.fixedDemoPassword).toBe("long-enough-pass");
  });

  it("wipe_sql_drops_all_user_tables_but_skips_sqlite_internals", () => {
    // 内部表の判定: sqlite自身の表（sqlite_%）とCloudflare管理の表（_で始まる。_cf_KV等）はDROPしない
    expect(isInternalTableName("sqlite_sequence")).toBe(true);
    expect(isInternalTableName("sqlite_stat1")).toBe(true);
    expect(isInternalTableName("_cf_KV")).toBe(true);
    expect(isInternalTableName("units")).toBe(false);
    expect(isInternalTableName("d1_migrations")).toBe(false);

    const sql = buildRemoteWipeSql(["units", "auth_users", "d1_migrations", "sqlite_sequence", "_cf_KV"]);
    expect(sql).toContain('DROP TABLE IF EXISTS "units";');
    expect(sql).toContain('DROP TABLE IF EXISTS "auth_users";');
    // d1_migrations もDROPする（直後の wrangler d1 migrations apply がschemaを全件作り直す）
    expect(sql).toContain('DROP TABLE IF EXISTS "d1_migrations";');
    expect(sql).not.toContain("sqlite_sequence");
    expect(sql).not.toContain("_cf_KV");
    // 識別子のquote逃し（表名に「"」が入っても文が壊れない）と参照制約の回避
    expect(buildRemoteWipeSql(['we"ird'])).toContain('DROP TABLE IF EXISTS "we""ird";');
    expect(sql).toContain("PRAGMA foreign_keys=OFF;");
  });

  it("workflow_resets_demo_weekly_with_demo_scoped_secrets_only", () => {
    // 週1回のcron（GitHub ActionsはUTCのみのためJST換算をコメントに書く）と手動起動の両方を持つ
    expect(demoResetYaml).toContain("workflow_dispatch");
    expect(demoResetYaml).toContain("JST");
    const cronLine = demoResetYaml.split("\n").find((l) => l.includes("cron:"))!;
    expect(cronLine).toMatch(/cron: *["']0 16 \* \* 0["']/); // 日曜16:00 UTC ＝ 月曜01:00 JST
    // cronの自動起動以外では何もしない（push起動の追加はしない）
    expect(demoResetYaml).not.toMatch(/(^|\n)\s+push:/);

    // 権限は最小限（deploy-config.test.tsと同じ断言）。同時実行の禁止
    expect(demoResetYaml).toMatch(/^permissions:\n {2}contents: read$/m);
    expect(demoResetYaml).toContain("group: demo-reset");
    expect(demoResetYaml).toContain("cancel-in-progress: false");

    // 実行コマンドとSecretの参照（wranglerは CLOUDFLARE_API_TOKEN / CLOUDFLARE_ACCOUNT_ID 環境変数を拾う）
    expect(demoResetYaml).toContain("npm run demo:reset:remote -- --confirm demo");
    expect(demoResetYaml).toContain("${{ secrets.CLOUDFLARE_API_TOKEN_DEMO }}");
    expect(demoResetYaml).toContain("${{ secrets.CLOUDFLARE_ACCOUNT_ID_DEMO }}");
    for (const line of demoResetYaml.split("\n")) {
      if (line.trimStart().startsWith("#")) continue; // 説明文にSecret名を書くことは許す（値は置けない）
      if (line.includes("CLOUDFLARE_API_TOKEN") || line.includes("CLOUDFLARE_ACCOUNT_ID")) {
        expect(line, line).toMatch(/\$\{\{ secrets\./); // 実行行は値を書かない。参照名だけ
      }
    }
    // 他環境のtoken・Secret名は現れない（demo専用のworkflowであること）
    expect(demoResetYaml).not.toContain("CLOUDFLARE_API_TOKEN_STAGING");
    expect(demoResetYaml).not.toContain("CLOUDFLARE_API_TOKEN_PRODUCTION");
    expect(demoResetYaml).not.toContain("BETTER_AUTH_SECRET");

    // npm scriptの正本（reset= --wipe付き、seed= wipe無し。Task 7の初回構築〔ops/demo-deploy.md §5.1〕はseedを使う）
    const pkg = JSON.parse(pkgRaw) as { scripts: Record<string, string> };
    expect(pkg.scripts["demo:reset:remote"]).toBe("tsx scripts/seed-demo.ts --remote --env demo --wipe");
    expect(pkg.scripts["demo:seed:remote"]).toBe("tsx scripts/seed-demo.ts --remote --env demo");
  });
});
