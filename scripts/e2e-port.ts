// e2e（Playwrightのwebサーバー）の待受ポートの正本（T085裁定R19）。
// 利用者が別のプロジェクトを8787番で並行して動かすため、e2eは既定で8797番を使う（demo〔scripts/demo.ts〕は8787のまま）。
// 環境変数 FIREOS_E2E_PORT で変えられる。wrangler dev のinspectorも別の番号に固定し、他のwrangler devと衝突させない
// （FIREOS_E2E_INSPECTOR_PORT。既定9239）。playwright.config.ts・tests/e2e・scripts/collect-evidence.ts が参照する。
const numberFromEnv = (name: string, fallback: number): number => {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1 || n > 65535) throw new Error(`${name} はポート番号（1〜65535）で指定してください: ${raw}`);
  return n;
};

export const E2E_PORT = numberFromEnv("FIREOS_E2E_PORT", 8797);
export const E2E_INSPECTOR_PORT = numberFromEnv("FIREOS_E2E_INSPECTOR_PORT", 9239);
export const E2E_BASE = `http://localhost:${E2E_PORT}`;
