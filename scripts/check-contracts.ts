// 契約検査（T002）。`npm run check:contracts` で次を確認し、1つでも食い違えば失敗する。
//  1. 台帳のAPI-IDがAPI-01〜102と過不足なく一致する
//  2. docs/05 §4 の表（ID/method/path、成功dataに書かれた202/204）が台帳と一致する
//  3. openapi/fireos.json が台帳から生成した内容と一致する（古い生成物をCIで検出）
// `--write` を付けると openapi/fireos.json を再生成する。
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { buildOpenApi } from "../src/shared/contracts/openapi";
import { apiDef, apiIds } from "../src/shared/contracts/registry";
import { successStatusProblems } from "../src/shared/contracts/doc-check";

const OPENAPI_PATH = "openapi/fireos.json";
const DOC_PATH = "docs/05_API仕様書.md";
const problems: string[] = [];

// 1. ID（102はT052が追加したGET /tasks/me。台帳・docs/05・OpenAPIの3点を必ず一緒に変える）
const expected = Array.from({ length: 102 }, (_, i) => `API-${String(i + 1).padStart(2, "0")}`);
const missing = expected.filter((id) => !(apiIds as string[]).includes(id));
const extra = (apiIds as string[]).filter((id) => !expected.includes(id));
if (missing.length) problems.push(`台帳に無いAPI: ${missing.join(", ")}`);
if (extra.length) problems.push(`想定外のAPI: ${extra.join(", ")}`);

// 2. docs/05 の表
const rows = readFileSync(DOC_PATH, "utf8")
  .split("\n")
  .map((line) => line.match(/^\| (API-\d{2,3}) \| (\S+) (\S+) \|.*\| ([^|]*) \|$/))
  .filter((m): m is RegExpMatchArray => !!m);
if (rows.length !== 102) problems.push(`docs/05 の表の行数が102ではありません: ${rows.length}`);
for (const [, id, method, rawPath, successText] of rows) {
  const path = rawPath!.replace(/（.*$/, ""); // 「（v1外）」等の注記は比較に含めない
  const def = (apiIds as string[]).includes(id!) ? apiDef(id as never) : undefined;
  if (!def) continue;
  if (def.method !== method || def.path !== path) {
    problems.push(`${id}: docs=${method} ${path} / 台帳=${def.method} ${def.path}`);
  }
  problems.push(...successStatusProblems(id!, successText ?? "", def.success));
}

// 3. OpenAPI
const generated = JSON.stringify(buildOpenApi(), null, 2) + "\n";
if (process.argv.includes("--write")) {
  mkdirSync("openapi", { recursive: true });
  writeFileSync(OPENAPI_PATH, generated);
  console.log(`${OPENAPI_PATH} を再生成しました`);
} else {
  let current = "";
  try {
    current = readFileSync(OPENAPI_PATH, "utf8");
  } catch {
    problems.push(`${OPENAPI_PATH} がありません。npm run generate:contracts で生成してください`);
  }
  if (current && current !== generated) problems.push(`${OPENAPI_PATH} が台帳と一致しません。npm run generate:contracts で再生成してください`);
}

if (problems.length) {
  console.error("契約検査に失敗:\n- " + problems.join("\n- "));
  process.exit(1);
}
console.log(`契約検査OK: ${apiIds.length} API / docs/05 ${rows.length}行 / OpenAPI一致`);
