import { createExecutionContext } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeAll, describe, expect, it } from "vitest";
import demoSource from "../scripts/demo.ts?raw";
import { stripJsonComments, type DeploymentConfig, type WranglerEnvConfig } from "../scripts/check-environment";
import {
  DEMO_DOC_KEY,
  DEMO_PERSIST_DIR,
  DEMO_PHOTO_KEY,
  DEMO_PROFILE,
  DEMO_SEED_IDS,
  collectDemoPrivacyRows,
  demoPhotoPng,
  demoResetRemovals,
  detectRealPersonalData,
  seedDemo,
  verifyDemoIsolation,
} from "../scripts/seed-demo";
import { createApp } from "../src/server/index";
import { DEMO_SECURITY_POLICY, securityPolicyForEnv } from "../src/server/security/limits";
import wranglerRaw from "../wrangler.jsonc?raw";
import { createRuntime, type WorkerRuntime } from "./helpers/runtime";

/**
 * 公開デモの分離と架空データ（T086、docs/13 RG-09・docs/07 §7「公開デモは架空人物/地点/写真のみ、
 * 本番/staging/demoを別Worker/D1/R2へ分離」・docs/16 TC-18）。
 *
 * - 入力・手順はブリーフどおり: 架空団員/施設/出動/文書/写真だけをseed（seedDemo）、
 *   production binding/token差替えとデモ濫用を試す。
 * - production分離の検査は scripts/check-environment.ts（T078の配置ゲート）と同じ純関数群を使わず、
 *   「demo設定・実行環境にproductionのD1/R2/Secret/tokenが現れないこと」を実値（実wrangler.jsoncの
 *   パース結果・実workerdのDB/R2）で確かめる。差替え（demoへproductionのdatabase_id/Secret名を混ぜる）は
 *   検出器が必ず拾うことをその場で試す（拾えなければ productionBindingsAccessible=true でFail）。
 * - realPersonalDataFound はseedした全行を走査した結果（collectDemoPrivacyRows）。走査漏れを防ぐため
 *   表ごとの行数を DEMO_PROFILE（create modeの期待値）と突き合わせる。検出器そのものの能力は
 *   合成行（実在風の氏名・実在ドメインのメール）で常時検査する（空を返す恒真にしない）。
 * - developmentIncompleteFeatures は「デモで動くべき機能の明示チェックリスト」（R15）。seedした架空
 *   データで主要動線（施設/点検/異常/活動/出動/文書/通知/帳票/同期ほか）が到達・表示できるかを1つずつ
 *   APIで確かめ、未達を配列に集める。恒久実装を排除するため検査項目は列挙型（空配列を返す固定値ではない）。
 * - デモ濫用: APP_ENV=demoのappは DEMO_SECURITY_POLICY（公開デモ用の開発設定）で動き、AI系の
 *   連打が429で防がれることを実要求で観測する（WAF/製品層は実Cloudflare接続後。X-V01/X-DEMO）。
 */

const secrets = ["BETTER_AUTH_SECRET", "CLOUDFLARE_API_TOKEN_STAGING", "CLOUDFLARE_API_TOKEN_PRODUCTION"];

let runtime: WorkerRuntime;
beforeAll(async () => {
  const { applyD1Migrations } = await import("cloudflare:test");
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
  // 架空団員/施設/出動/文書/写真だけをseed（実Cloudflare・実データには何も繋がない）
  await seedDemo(env);
  runtime = await createRuntime();
});

// 実wrangler.jsonc（コメント付きJSONCをそのまま読む。配置ゲートと同じ実値が対象）
const parsed = JSON.parse(stripJsonComments(wranglerRaw)) as WranglerEnvConfig & {
  env?: Record<string, WranglerEnvConfig>;
};
const localEnv: WranglerEnvConfig = {
  name: parsed.name,
  vars: parsed.vars,
  assets: parsed.assets,
  d1_databases: parsed.d1_databases,
  r2_buckets: parsed.r2_buckets,
  queues: parsed.queues,
  triggers: parsed.triggers,
};
const envs: Record<string, WranglerEnvConfig> = { local: localEnv, ...(parsed.env ?? {}) };
const demoConfig: DeploymentConfig = { envName: "demo", env: envs.demo!, others: envs, secrets };

describe("demo isolation (T086)", () => {
  it("demo_cannot_reach_production_or_expose_real_personal_data", async () => {
    // ---- 1) production binding/token差替えを試す（demo設定の実値検査） ----
    const iso = verifyDemoIsolation(demoConfig);
    expect(iso.productionResourceReferences, iso.productionResourceReferences.join(" / ")).toEqual([]);

    // 差替え攻撃: demoのD1をproductionの物へ替える・production Secret名をvarsへ混ぜる。
    // 検出器がどちらも拾うことをその場で証明する（拾えない検出器は分離を主張できない）
    const productionDb = envs.production!.d1_databases![0]!;
    const dbSwapped = verifyDemoIsolation({
      ...demoConfig,
      env: { ...envs.demo!, d1_databases: [{ binding: "DB", database_name: productionDb.database_name, database_id: productionDb.database_id }] },
    });
    expect(dbSwapped.productionBindingsAccessible).toBe(true);
    const tokenSwapped = verifyDemoIsolation({
      ...demoConfig,
      env: { ...envs.demo!, vars: { ...envs.demo!.vars, DEMO_MIGRATED_TOKEN: "CLOUDFLARE_API_TOKEN_PRODUCTION" } },
    });
    expect(tokenSwapped.productionBindingsAccessible).toBe(true);
    const swapDetected = dbSwapped.productionBindingsAccessible && tokenSwapped.productionBindingsAccessible;

    // 実設定ではproduction資源へ到達できない（差替え検出が効いていることも含めて）
    const productionBindingsAccessible = iso.productionBindingsAccessible || !swapDetected;
    expect(productionBindingsAccessible).toBe(false);

    // ---- 2) demo:reset の射程はdemoのpersistだけ（他環境・本番設定に触れない） ----
    const removals = demoResetRemovals();
    const demoSourceUsesSharedConstant = demoSource.includes("rmSync(DEMO_PERSIST_DIR");
    const demoResetLeavesProductionUntouched =
      !iso.resetTouchesOtherEnvironments &&
      removals.length === 1 &&
      removals.every((p) => p === DEMO_PERSIST_DIR) &&
      demoSourceUsesSharedConstant;
    expect(demoResetLeavesProductionUntouched).toBe(true);

    // ---- 3) seedした全行の走査（実在風データの検出。走査漏れは行数照合で落とす） ----
    const scan = await collectDemoPrivacyRows(env);
    for (const [table, expected] of Object.entries(DEMO_PROFILE)) {
      expect(scan.tableCounts[table] ?? 0, `走査漏れ: ${table}`).toBe(expected);
    }
    expect(scan.totalValues).toBeGreaterThan(500); // 空走査（恒真）でないことの下限
    // 検出器の能力は合成行で常時検査（実在風の氏名・実在ドメインのメールは必ず拾う）
    expect(detectRealPersonalData([{ table: "members", id: "x", values: { display_name: "山田 太郎" } }])).not.toEqual([]);
    expect(
      detectRealPersonalData([{ table: "members", id: "x", values: { note: "連絡先 taro.yamada@gmail.com です" } }]),
    ).not.toEqual([]);
    expect(detectRealPersonalData([{ table: "members", id: "x", values: { display_name: "架空 団員01" } }])).toEqual([]);

    const realPersonalDataFound = detectRealPersonalData(scan.rows);
    expect(realPersonalDataFound).toEqual([]);

    // ---- 4) 実行時の書き込み先はdemo自身のbindingだけ（D1はdemo unitのみ・R2はseedの2物体のみ） ----
    const strayUnits = await env.DB.prepare("SELECT COUNT(*) AS n FROM units WHERE id NOT IN (?, ?)")
      .bind(DEMO_SEED_IDS.unit, DEMO_SEED_IDS.unit2).first<{ n: number }>();
    expect(strayUnits!.n).toBe(0);
    const r2Keys = (await env.FILES.list()).objects.map((o) => o.key).sort();
    expect(r2Keys).toEqual([DEMO_DOC_KEY, DEMO_PHOTO_KEY]);

    // ---- 5) デモで動くべき機能の明示チェックリスト（R15。未達を集める） ----
    const identity = { userId: DEMO_SEED_IDS.adminUser };
    const get = async (path: string): Promise<{ status: number; json: () => Promise<any>; res: Response }> => {
      const res = await runtime.fetch(new Request(`http://example.com${path}`, { headers: { "x-test-identity": JSON.stringify(identity) } }));
      return { status: res.status, json: () => res.json(), res };
    };
    const page = async (path: string) => {
      const r = await get(path);
      return { status: r.status, body: await r.json() as { data?: unknown[]; events?: unknown[]; resumeCursor?: unknown; error?: { code: string } } };
    };
    const checks: { label: string; verify: () => Promise<string | null> }[] = [
      {
        label: "ホーム（API-28）",
        verify: async () => ((await page("/api/v1/dashboard")).status === 200 ? null : "指標が取れない"),
      },
      {
        label: "名簿（API-02）",
        verify: async () => {
          const p = await page("/api/v1/members");
          const rows = p.body.data ?? [];
          return p.status === 200 && rows.some((m) => (m as { displayName?: string }).displayName === "架空 団員01") ? null : "seed団員が一覧に現れない";
        },
      },
      {
        label: "地図データ源・施設一覧（API-10）",
        verify: async () => {
          const p = await page("/api/v1/facilities?bbox=138.9,34.9,140.1,36.1&limit=100");
          const rows = p.body.data ?? [];
          return p.status === 200 && rows.some((f) => (f as { managementNumber?: string }).managementNumber === "DF-0001") ? null : "seed施設が地図一覧に現れない";
        },
      },
      {
        label: "施設詳細（API-12）",
        verify: async () => ((await page(`/api/v1/facilities/${DEMO_SEED_IDS.facility}`)).status === 200 ? null : "施設詳細が開けない"),
      },
      {
        label: "点検（API-44）",
        verify: async () => {
          const p = await page(`/api/v1/facilities/${DEMO_SEED_IDS.facility}/inspections`);
          return p.status === 200 && (p.body.data ?? []).length > 0 ? null : "seed点検が一覧に現れない";
        },
      },
      {
        label: "異常（API-15）",
        verify: async () => {
          const p = await page("/api/v1/issues");
          const rows = p.body.data ?? [];
          return p.status === 200 && rows.some((i) => String((i as { title?: string }).title).includes("架空の消火栓の劣化")) ? null : "seed異常が一覧に現れない";
        },
      },
      {
        label: "活動（API-05）",
        verify: async () => {
          const p = await page("/api/v1/activities");
          const rows = p.body.data ?? [];
          return p.status === 200 && rows.some((a) => String((a as { title?: string }).title).includes("架空の水防訓練")) ? null : "seed活動が一覧に現れない";
        },
      },
      {
        label: "出動（API-21）",
        verify: async () => {
          const p = await page("/api/v1/incidents");
          const rows = p.body.data ?? [];
          return p.status === 200 && rows.some((i) => String((i as { summary?: string }).summary).includes("架空市での出動訓練")) ? null : "seed出動が一覧に現れない";
        },
      },
      {
        label: "文書（API-90）",
        verify: async () => {
          const p = await page("/api/v1/documents");
          const rows = p.body.data ?? [];
          return p.status === 200 && rows.some((d) => String((d as { title?: string }).title).includes("架空の資機材取扱説明書")) ? null : "seed文書が一覧に現れない";
        },
      },
      {
        label: "通知（API-67）",
        verify: async () => {
          const p = await page("/api/v1/notifications/me");
          const rows = p.body.data ?? [];
          return p.status === 200 && rows.some((n) => String((n as { body?: string }).body).includes("架空の防災訓練")) ? null : "seed通知が自分宛一覧に現れない";
        },
      },
      {
        label: "帳票（API-58）",
        verify: async () => {
          const p = await page(`/api/v1/reports/${DEMO_SEED_IDS.report}`);
          const data = p.body.data as { versions?: unknown[] } | undefined;
          return p.status === 200 && (data?.versions?.length ?? 0) > 0 ? null : "seed帳票が読めない";
        },
      },
      {
        label: "同期（API-80）",
        verify: async () => {
          const p = await page("/api/v1/events");
          const data = p.body.data as { events?: unknown[]; resumeCursor?: unknown } | undefined;
          return p.status === 200 && (data?.events?.length ?? 0) > 0 && typeof data?.resumeCursor === "string" ? null : "outboxから差分が取れない";
        },
      },
      {
        label: "お知らせ（API-24）",
        verify: async () => {
          const p = await page("/api/v1/announcements");
          const rows = p.body.data ?? [];
          return p.status === 200 && rows.some((a) => String((a as { title?: string }).title).includes("架空の訓練日程")) ? null : "seedお知らせが一覧に現れない";
        },
      },
      {
        label: "自分のタスク（API-102）",
        verify: async () => {
          const p = await page("/api/v1/tasks/me");
          const rows = p.body.data ?? [];
          return p.status === 200 && rows.some((t) => String((t as { title?: string }).title).includes("架空の異常確認")) ? null : "seedタスクが自分の一覧に現れない";
        },
      },
      {
        label: "車両（API-18）",
        verify: async () => {
          const p = await page("/api/v1/vehicles");
          const rows = p.body.data ?? [];
          return p.status === 200 && rows.some((v) => String((v as { name?: string }).name).includes("架空の資機材運搬車")) ? null : "seed車両が一覧に現れない";
        },
      },
      {
        label: "機材（API-19）",
        verify: async () => {
          const p = await page("/api/v1/equipment");
          const rows = p.body.data ?? [];
          return p.status === 200 && rows.some((e) => String((e as { name?: string }).name).includes("架空の消火ホース")) ? null : "seed機材が一覧に現れない";
        },
      },
      {
        label: "点検様式（API-94）",
        verify: async () => {
          const p = await page("/api/v1/inspection-templates");
          const rows = p.body.data ?? [];
          return p.status === 200 && rows.some((t) => String((t as { name?: string }).name).includes("架空の施設点検様式")) ? null : "seed様式が一覧に現れない";
        },
      },
      {
        label: "集計（API-52）",
        verify: async () => ((await page("/api/v1/analytics")).status === 200 ? null : "集計が取れない"),
      },
      {
        label: "写真の実体（API-27）",
        verify: async () => {
          const r = await get(`/api/v1/attachments/${DEMO_SEED_IDS.photoAttachment}/content`);
          const bytes = await r.res.arrayBuffer();
          return r.status === 200 && r.res.headers.get("content-type") === "image/png" && bytes.byteLength === demoPhotoPng().length
            ? null
            : "seed写真の実体がR2から読めない";
        },
      },
    ];
    const developmentIncompleteFeatures: string[] = [];
    for (const c of checks) {
      const miss = await c.verify();
      if (miss !== null) developmentIncompleteFeatures.push(`${c.label}: ${miss}`);
    }
    expect(developmentIncompleteFeatures).toEqual([]);

    // ---- 6) デモ濫用: 公開デモpolicyでAI系の連打を429で防ぐ（枠内は429にしない） ----
    expect(securityPolicyForEnv("demo")).toBe(DEMO_SECURITY_POLICY);
    expect(securityPolicyForEnv("local")).not.toBe(DEMO_SECURITY_POLICY);
    const demoApp = createApp({ APP_ENV: "demo" });
    const hammer = () =>
      demoApp.fetch(
        new Request("http://example.com/api/v1/ai/assistant", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" }),
        env,
        createExecutionContext(),
      );
    const cap = DEMO_SECURITY_POLICY.rateLimit.ai.requests;
    const statuses: number[] = [];
    for (let i = 0; i < cap + 2; i++) statuses.push((await hammer()).status);
    expect(statuses.slice(0, cap).every((s) => s !== 429)).toBe(true);
    expect(statuses.filter((s) => s === 429).length).toBeGreaterThanOrEqual(1);

    // ---- 7) ブリーフの4断言（変数・期待値は原文どおり） ----
    expect(productionBindingsAccessible).toBe(false);
    expect(realPersonalDataFound).toEqual([]);
    expect(demoResetLeavesProductionUntouched).toBe(true);
    expect(developmentIncompleteFeatures).toEqual([]);
  });
});
