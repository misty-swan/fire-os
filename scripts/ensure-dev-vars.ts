// wrangler dev 用の .dev.vars（Git管理外）を、無ければ作る。localのSecretは乱数で、開発用の目印 "dev-only-" を付ける。
import { randomBytes } from "node:crypto";
import { existsSync, writeFileSync } from "node:fs";

const path = ".dev.vars";
if (existsSync(path)) {
  console.log(`${path} は既にあります（変更しません）`);
} else {
  writeFileSync(path, `BETTER_AUTH_SECRET=dev-only-${randomBytes(24).toString("hex")}\n`, { mode: 0o600 });
  console.log(`${path} を作成しました`);
}
