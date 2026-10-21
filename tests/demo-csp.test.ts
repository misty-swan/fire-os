import { env } from "cloudflare:workers";
import { createExecutionContext } from "cloudflare:test";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../src/server/index";
import { cspHeaderValue } from "../src/server/security/csp";
import { createRuntime, type WorkerRuntime } from "./helpers/runtime";
import wranglerJsonc from "../wrangler.jsonc?raw";

/**
 * demo環境のみCSP付与（T089 計画Task 6。docs/superpowers/plans/2026-10-21-public-demo-miyanoura.md Task 6）。
 *
 * - ポリシー文字列は純関数 `cspHeaderValue`（src/server/security/csp.ts）が生成する。許可リストは
 *   計画Task 6のブリーフどおり（maps・Google Fonts・blob/data写真）。'unsafe-eval' は持たない
 *   （production Reactに不要。dev viteはlocal=localにCSP無しのため無関係）。
 * - 付与箇所は静的配信（src/server/index.tsの `app.all("*")` → ASSETS.fetch）。**HTML（document）応答だけ**に
 *   付ける（subresourceのjs/cssにCSPは要らない。documentのCSPがpage全体の読み込みを統制する）。
 * - ②の「localで無し」は実際のWorker実行体（vitest cloudflare plugin。wrangler.jsoncの既定=APP_ENV local）で
 *   観測する（runtime.test.tsと同じ作法。e2e・試験が不変であることの裏付け）。
 * - ①demoの付与は createApp({ APP_ENV: "demo" }) で環境だけ差したappに実ASSETS（globalSetupがbuildした
 *   dist/client）を返させて観測する（demo-isolation.test.tsの6)と同じ作法）。
 * - 試験harness自体はAPP_ENV=localで動くため、demo値での実worker起動はこの方法（app factoryへのenv差し替え）
 *   が正本。実demoデプロイでの最終確認は計画Task 7の営業前チェックリスト（実URLで地図・フォント・写真）。
 */

const documentPath = "/app/unknown"; // 未知のURL=SPAのindex.html（runtime.test.tsと同じ経路）

// demo配信の再現: 実bindings（ASSETS/D1/…）はそのままに、環境識別子だけdemoへ差し替える。
// handlerは要求ごとの c.env.APP_ENV で分岐するため（principal.ts等と同じ作法）、実demoデプロイでは
// wrangler.jsonc env.demo の vars.APP_ENV=demo がここに来る。build-clientが作る実index.htmlを使う。
const demoRequestEnv = { ...env, APP_ENV: "demo" } as const;

describe("demo CSP (T089 計画Task 6)", () => {
  let runtime: WorkerRuntime;
  beforeAll(async () => {
    runtime = await createRuntime();
  });
  afterAll(async () => {
    await runtime.dispose();
  });

  it("policy_value_follows_brief_allowlist_and_maps_toggle_keeps_fonts", () => {
    // 許可リストはブリーフの原文どおり（script/style/font/img/worker/connect）
    const withMaps = cspHeaderValue({ mapsEnabled: true });
    expect(withMaps).toContain("script-src 'self' https://maps.googleapis.com");
    expect(withMaps).toContain("style-src 'self' 'unsafe-inline' https://fonts.googleapis.com");
    expect(withMaps).toContain("font-src 'self' https://fonts.gstatic.com data:");
    expect(withMaps).toContain("img-src 'self' data: blob: https://*.googleapis.com https://maps.gstatic.com");
    expect(withMaps).toContain("worker-src 'self'");
    expect(withMaps).toContain("connect-src 'self' https://maps.googleapis.com");
    // production Reactにevalは不要（ブリーフの禁止。dev viteはlocal=localはCSP無し）
    expect(withMaps).not.toContain("unsafe-eval");

    // mapsEnabled:false でもfonts系は許可のまま（フォント崩れ防止。③）
    const withoutMaps = cspHeaderValue({ mapsEnabled: false });
    expect(withoutMaps).toContain("https://fonts.googleapis.com");
    expect(withoutMaps).toContain("https://fonts.gstatic.com");
    // 地図系だけが外れる（キーの無いbuildで余分な許可を出さない）
    expect(withoutMaps).not.toContain("maps.googleapis.com");
    expect(withoutMaps).not.toContain("maps.gstatic.com");
    expect(withoutMaps).not.toContain("*.googleapis.com");
  });

  it("demo_environment_attaches_csp_to_html_document_responses", async () => {
    const demoApp = createApp({ APP_ENV: "demo" });
    const res = await demoApp.fetch(new Request(`http://example.com${documentPath}`), demoRequestEnv, createExecutionContext());

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    const csp = res.headers.get("content-security-policy");
    expect(csp).not.toBeNull();
    // 付与値は純関数と同一（attach側のmapsEnabledはtrue=demoはMapsキー入りのbuildで配信される）
    expect(csp).toBe(cspHeaderValue({ mapsEnabled: true }));
    // ブリーフ①: 全ドメインが載る
    expect(csp).toContain("maps.googleapis.com");
    expect(csp).toContain("fonts.googleapis.com");
    expect(csp).toContain("fonts.gstatic.com");
    expect(csp).toContain("blob:");
  });

  it("local_environment_has_no_csp_on_document_responses", async () => {
    // 実Worker実行体（APP_ENV=local。vitest pluginのwrangler.jsonc既定）で観測する（②。e2e不変の裏付け）
    const realLocal = await runtime.fetch(new Request(`http://example.com${documentPath}`));
    expect(realLocal.headers.get("content-type")).toContain("text/html");
    expect(realLocal.headers.get("content-security-policy")).toBeNull();

    // 付与箇所の分岐そのもの（localでは応答を無変更で通す）
    const localApp = createApp({ APP_ENV: "local" });
    const viaLocal = await localApp.fetch(new Request(`http://example.com${documentPath}`), env, createExecutionContext());
    expect(viaLocal.headers.get("content-type")).toContain("text/html");
    expect(viaLocal.headers.get("content-security-policy")).toBeNull();
  });

  it("demo_csp_stays_off_subresource_assets_and_api_responses", async () => {
    const demoApp = createApp({ APP_ENV: "demo" });
    const send = (path: string) => demoApp.fetch(new Request(`http://example.com${path}`), demoRequestEnv, createExecutionContext());

    // 静的subresource（js/css等の個別asset）には付けない（最小面。documentのCSPで統制する）
    const asset = await send("/manifest.webmanifest");
    expect(asset.status).toBe(200);
    expect(asset.headers.get("content-type")).not.toContain("text/html");
    expect(asset.headers.get("content-security-policy")).toBeNull();

    // API応答は既存の共通security headers（T081。default-src 'none'）のまま（demo値へ置き換えない）
    const api = await send("/api/v1/unknown");
    expect(api.status).toBe(404);
    expect(api.headers.get("content-type")).toContain("application/json");
    expect(api.headers.get("content-security-policy")).toContain("default-src 'none'");
    expect(api.headers.get("content-security-policy")).not.toBe(cspHeaderValue({ mapsEnabled: true }));
  });

  it("wrangler_config_routes_demo_documents_through_worker_and_keeps_local_asset_first", () => {
    // CSPはWorkerの応答箇所で付く。既定（asset-first）ではHTML（/ もSPA fallbackも）がasset層から
    // 直接返りWorkerを通らない＝demo CSPが実要求に1つも付かない（workerd実測。run_worker_firstの
    // 「gating trap」）。demoだけ全経路をWorker-firstにしたことを設定面で固定する。
    // （wrangler.jsoncはコメント付きJSONCなので、行コメントだけを落としてから読む）
    const config = JSON.parse(
      wranglerJsonc
        .split("\n")
        .filter((line) => !line.trim().startsWith("//"))
        .join("\n"),
    ) as { assets: { run_worker_first: string[] }; env: { demo: { assets: { run_worker_first: string[] } } } };
    // demoは全経路Worker-first（/*）。/api等との併記はwranglerがredundantで拒否するため単独の形
    expect(config.env.demo.assets.run_worker_first).toEqual(["/*"]);
    // local（=試験・e2eが使う既定env）はrouting不変（asset-firstのまま。CSP無しの配信経路）
    expect(config.assets.run_worker_first).not.toContain("/*");
  });
});
