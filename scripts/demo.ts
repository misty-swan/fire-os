// 手元で画面を見る用の起動コマンド（`npm run demo`）。架空データだけ・ローカルのD1だけで、実Cloudflareには何もつなげない。
//  初回：D1を作ってmigrationを適用し、初期管理者の招待リンクを表示する（一度しか表示されない）
//  2回目以降：前回のデータ（.wrangler/demo、Git管理外）のまま起動する
//  `npm run demo:reset` でデータを消して最初からやり直す
import { spawn, spawnSync } from "node:child_process";
import { existsSync, rmSync } from "node:fs";

const PERSIST = ".wrangler/demo";
const URL = "http://localhost:8787";
const sh = (cmd: string, args: string[]) => spawnSync(cmd, args, { encoding: "utf8" });

if (process.argv.includes("--reset")) {
  rmSync(PERSIST, { recursive: true, force: true });
  console.log("デモのデータを消しました");
}
sh("npx", ["tsx", "scripts/ensure-dev-vars.ts"]);

// 起動のたびに未適用のmigrationを流す（wranglerは適用済みを記録するため冪等。前回のデータは消さない）。
// 初回だけだと、古いデータで起動したときに後続PHで増えた表が無く500になる（activities等）。
const mig = sh("npx", ["wrangler", "d1", "migrations", "apply", "DB", "--local", "--persist-to", PERSIST]);
if (mig.status !== 0) throw new Error(mig.stderr || mig.stdout);

if (!existsSync(PERSIST)) {
  const b = sh("npx", [
    "tsx", "scripts/bootstrap-admin.ts", "--env", "local", "--persist-to", PERSIST,
    "--unit-name", "架空市 第一分団", "--admin-name", "架空 管理者", "--email", "admin@example.test",
  ]);
  if (b.status !== 0) throw new Error(b.stderr || b.stdout);
  const { token, expiresAt } = JSON.parse(b.stdout.trim().split("\n").pop()!) as { token: string; expiresAt: string };
  console.log("\n=== 初回：管理者を作る招待リンク（一度しか表示されません。期限 " + expiresAt + "）===");
  console.log(`${URL}/login#invite=${token}`);
  console.log("メールアドレスは admin@example.test、パスワードは12文字以上。続けて認証アプリで二要素認証を設定します。\n");
} else {
  console.log(`\n前回のデータで起動します。ログインは ${URL}/login （初回の招待リンクは再表示できません。最初からやり直すなら npm run demo:reset）\n`);
}

const build = sh("npm", ["run", "build"]);
if (build.status !== 0) throw new Error(build.stderr || build.stdout);
console.log(`起動します → ${URL}/login  （止めるときは Ctrl+C）\n`);
spawn("npx", ["wrangler", "dev", "--port", "8787", "--persist-to", PERSIST], { stdio: "inherit" });
