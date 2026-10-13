import { existsSync } from "node:fs";
import { execFileSync } from "node:child_process";

// Workers試験でSPA(React)の配信を実物で確認するため、dist/clientが無ければ一度だけビルドする。
export default function setup() {
  if (!existsSync("dist/client/index.html")) {
    execFileSync("npx", ["vite", "build"], { stdio: "inherit" });
  }
}
