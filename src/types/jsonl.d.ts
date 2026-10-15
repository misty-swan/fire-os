// 評価dataset（tests/fixtures/ai/*.jsonl）をテキストモジュールとしてimportするための宣言（T061）。
// 実際のバンドルはwrangler.jsoncのrules（type: Text）が行う（esbuild/MiniflareのTextローダー）。
declare module "*.jsonl" {
  const content: string;
  export default content;
}
