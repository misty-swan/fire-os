import type { AppEnv } from "../env";

/**
 * 試験専用のfake AI（T055）。local かつ TEST_AI_FAKE=1 のときだけ、分類jobが
 * 候補を作れるようにする（実AI binding は local には無い＝wrangler.jsoncの注記。実Cloudflare未接続）。
 *
 * - e2e（Playwright × wrangler dev）は workers試験（tests/jev.test.tsのfake注入）と違って
 *   env.AI を外から注入できないため、wrangler dev の `--var TEST_AI_FAKE:1`
 *   （playwright.config.ts の webServer だけが付ける）で有効化する。
 *   demo/staging/production や普段の `npm run dev` / `npm run demo` では常に undefined（挙動は変わらない）。
 * - 応答は docs/06 §2 の戻り値形（model/answers/usage）を満たす決定的な値にする。実モデル版の欄
 *   （ai_evaluations.actual_model_version＝候補のmodel）に `fake-local@` 接頭辞を残すので、
 *   fake由来の候補は画面・記録で実AIの候補と区別が付く（偽装しない）。
 * - 候補はあくまで人の承認待ち（pending）として保存されるだけで、このfake自体は業務を
 *   一切確定させない（docs/06 §1「AIは紫、決めるのは人」。確定はAPI-31の承認だけ）。
 */
export function localTestAi(env: AppEnv): NonNullable<AppEnv["AI"]> | undefined {
  if (env.APP_ENV !== "local" || env.TEST_AI_FAKE !== "1") return undefined;
  return {
    run: async (model: string, input: { state?: unknown; questions?: unknown }) => {
      // 固定質問（docs/06 §2）を受けた形だけを模倣する。stateの中身は候補に反映しない（決定的な値）
      void model;
      void input;
      return {
        model: "fake-local@2026-10-16",
        answers: {
          category: {
            choice: "access_obstruction",
            probabilities: { access_obstruction: 0.7, equipment_issue: 0.15, missing_equipment: 0.05, no_issue: 0.05, other: 0.05 },
            confidence: 0.8,
          },
          needs_check: { noul: 0.15 },
        },
        usage: { prompt_tokens: 48, completion_tokens: 24 },
      };
    },
  } as unknown as NonNullable<AppEnv["AI"]>;
}
