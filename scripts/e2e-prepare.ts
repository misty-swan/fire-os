// ブラウザ試験(Playwright)用の局所環境を作り直す：D1を空から作り、migrationを適用し、初期管理者の招待tokenを発行する。
// tokenは tests/e2e/.state/bootstrap.json（Git管理外）へ。auth.setup.ts がこれで管理者アカウントを作る。
import { spawnSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";

const PERSIST = ".wrangler/e2e";
const run = (cmd: string, args: string[]) => {
  const r = spawnSync(cmd, args, { encoding: "utf8" });
  if (r.status !== 0) {
    console.error(r.stdout, r.stderr);
    throw new Error(`失敗: ${cmd} ${args.join(" ")}`);
  }
  return r.stdout;
};

rmSync(PERSIST, { recursive: true, force: true });
rmSync("tests/e2e/.state", { recursive: true, force: true });
mkdirSync("tests/e2e/.state", { recursive: true });
run("npx", ["tsx", "scripts/ensure-dev-vars.ts"]);
run("npx", ["wrangler", "d1", "migrations", "apply", "DB", "--local", "--persist-to", PERSIST]);
const email = "admin@example.test";
const out = run("npx", [
  "tsx", "scripts/bootstrap-admin.ts", "--env", "local", "--persist-to", PERSIST,
  "--unit-name", "架空市 第一分団", "--admin-name", "架空 管理者", "--email", email,
]);
const json = JSON.parse(out.trim().split("\n").pop()!) as { token: string };
writeFileSync("tests/e2e/.state/bootstrap.json", JSON.stringify({ email, token: json.token }), { mode: 0o600 });
console.log("e2e環境を準備しました");
