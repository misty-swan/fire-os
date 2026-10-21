// 初期管理者の作成CLI（docs/07 §2、ops/bootstrap-admin.md）。通常のAPIからは呼べない運用手順。
//   npm run bootstrap:admin -- --env local --unit-name "宮之浦分団" --admin-name "架空 岳志" --email admin@example.test
//   （remote）… --env staging --remote --confirm staging
// 環境の指定は必須。--remote は実環境のD1へ書くので --confirm <同じ環境名> も必要。tokenはこの標準出力に一度だけ表示する。
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { bootstrapStatements, BootstrapError, type BootstrapInput } from "../src/server/auth/bootstrap";
import { newInvitationToken } from "../src/server/auth/tokens";

const { values: a } = parseArgs({
  options: {
    env: { type: "string" }, remote: { type: "boolean", default: false }, confirm: { type: "string" },
    "unit-name": { type: "string" }, "admin-name": { type: "string" }, email: { type: "string" },
    hours: { type: "string" }, reissue: { type: "boolean", default: false }, "persist-to": { type: "string" },
  },
});

const fail = (msg: string): never => {
  console.error(`エラー: ${msg}`);
  process.exit(1);
};
const envName = a.env;
if (!envName || !["local", "demo", "staging", "production"].includes(envName)) fail("--env は local/demo/staging/production のいずれかを必ず指定してください");
if (a.remote && a.confirm !== envName) fail("--remote は実環境のD1へ書きます。--confirm に同じ環境名を指定してください");
if (!a.remote && envName !== "local") fail("local以外の環境は --remote が必要です（localのD1は --env local だけ）");
if (!a["unit-name"] || !a["admin-name"] || !a.email) fail("--unit-name / --admin-name / --email が必要です");

const input: BootstrapInput = {
  unitName: a["unit-name"]!, adminDisplayName: a["admin-name"]!, email: a.email!, reissue: a.reissue,
  expiresInHours: a.hours ? Number(a.hours) : undefined,
};

const lit = (v: unknown): string => {
  if (v === null || v === undefined) return "NULL";
  if (typeof v === "number") return String(v);
  return `'${String(v).replaceAll("'", "''")}'`;
};
const inline = (sql: string, binds: unknown[]): string => {
  let i = 0;
  return sql.replace(/\?/g, () => lit(binds[i++]));
};
const execute = (args: string[]) => spawnSync("npx", ["wrangler", "d1", "execute", "DB", ...args], { encoding: "utf8" });
const flags = [...(a.remote ? ["--remote"] : ["--local", ...(a["persist-to"] ? ["--persist-to", a["persist-to"]] : [])]), ...(envName === "local" ? [] : ["--env", envName!])];

// 再発行は既存の分団/団員を引く（remote/localどちらでも同じ手順）
let unitId: string = crypto.randomUUID();
let memberId: string = crypto.randomUUID();
if (input.reissue) {
  const r = execute([...flags, "--json", "--command", "SELECT unit_id, member_id FROM invitations WHERE kind = 'bootstrap' AND status = 'pending'"]);
  if (r.status !== 0) fail(`既存の初期招待を読めません: ${r.stderr || r.stdout}`);
  const rows = (JSON.parse(r.stdout) as { results: { unit_id: string; member_id: string }[] }[])[0]?.results ?? [];
  if (rows.length !== 1) fail("再発行できる未使用の初期招待がありません（nothing_to_reissue）");
  unitId = rows[0]!.unit_id;
  memberId = rows[0]!.member_id;
}

const token = newInvitationToken();
try {
  const ids = { unitId, memberId, invitationId: crypto.randomUUID(), mutationId: crypto.randomUUID(), auditId: crypto.randomUUID(), attempt: crypto.randomUUID() };
  const { stmts, expiresAt } = await bootstrapStatements(input, ids, new Date(), token);
  const dir = mkdtempSync(join(tmpdir(), "fireos-bootstrap-"));
  const file = join(dir, "bootstrap.sql");
  writeFileSync(file, stmts.map((s) => inline(s.sql, s.binds) + ";").join("\n") + "\n", { mode: 0o600 });
  const run = execute([...flags, "--file", file]);
  rmSync(dir, { recursive: true, force: true });
  if (run.status !== 0) {
    console.error(run.stderr || run.stdout);
    fail("実行に失敗しました。分団が既にある（already_bootstrapped）か、再発行の条件を満たしていません。ops/bootstrap-admin.md の復旧手順を確認してください");
  }
  // tokenはここで一度だけ。ログ・チャット・Gitに貼らない
  console.log(JSON.stringify({ unitId, memberId, expiresAt, token, note: "tokenは今だけ表示されます。安全な経路で本人に渡してください" }));
} catch (e) {
  if (e instanceof BootstrapError) fail(e.code);
  throw e;
}
