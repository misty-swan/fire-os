// D1 migration の適用ラッパー。既定は localだけ。実環境(--remote)は環境名と --yes-i-know を明示しないと動かさない。
//   npm run migrate                      # ローカルD1へ適用
//   npm run migrate -- --env staging --remote --yes-i-know
import { readdirSync } from "node:fs";
import { spawnSync } from "node:child_process";

const args = process.argv.slice(2);
const flag = (name: string) => args.includes(name);
const value = (name: string) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};

// 1. migrationファイルの連番を検査（欠番・重複を拒否）
const files = readdirSync("drizzle").filter((f) => f.endsWith(".sql")).sort();
files.forEach((f, i) => {
  const expected = String(i + 1).padStart(4, "0");
  if (!f.startsWith(`${expected}_`)) {
    console.error(`migrationの連番が不正です: ${f}（${expected}_ で始まる必要があります）`);
    process.exit(1);
  }
});

// 2. 適用
const env = value("--env");
const remote = flag("--remote");
if (remote && (!env || !flag("--yes-i-know"))) {
  console.error("--remote は --env <名前> と --yes-i-know が必要です（誤って本番へ適用しないため）");
  process.exit(1);
}
const cmd = ["wrangler", "d1", "migrations", "apply", "DB", remote ? "--remote" : "--local", ...(env ? ["--env", env] : [])];
console.log(`> npx ${cmd.join(" ")}  (${files.length} files)`);
const r = spawnSync("npx", cmd, { stdio: "inherit" });
process.exit(r.status ?? 1);
