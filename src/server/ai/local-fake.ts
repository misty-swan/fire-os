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
 * - **RAG（T067・API-76）の決定的応答**（プリフライト裁定4。docs/16 T067）: 入力がRAGの
 *   構造出力（response_formatのjson_schemaにcitationsを含む＝src/server/search/rag.tsの
 *   RAG_JSON_SCHEMA）のとき、**検索結果のchunk本文から質問語を含む行をそのまま引用して並べる**
 *   応答を返す。引用文字列はchunk本文の部分列そのものにしかなり得ない設計＝捏造不能
 *   （サーバー側の引用span完全一致検証を必ず通る）。chunkに質問語が無ければ citations 空で返す
 *   （＝根拠なしのabstain。chunk外の文を作らない）。**報告書生成のfake保留（偽の下書きを作らない）
 *   は変更しない**: 報告書生成（response_formatにtextだけのschema）は従来どおりJev分類の応答形を
 *   返すため、サーバー側検証が不適合で保留に落とす（docs/evidence/V04-llm.md。docs/03 §1.1）。
 * - **横断assistant（T068・API-77）の決定的応答**（プリフライト裁定5。docs/16 T068）: 入力が
 *   assistantの構造出力（json_schemaにusedReadingsを含む＝src/server/ai/assistant.tsの
 *   ASSISTANT_JSON_SCHEMA）のとき、**与えられた読み取り結果（<reading>本文）から質問語を含む行を
 *   そのまま引用して並べる応答**を返す。応答本文は読み取り本文の部分列にしかなり得ない＝捏造不能。
 *   **書込提案（proposals）は、質問が明示的に求めるとき（トリガー語）だけ**読み取りデータから派生させて
 *   出す（T070の確認画面のe2e用。コントローラ裁定・docs/03 §1.1の規約）:
 *   - 質問に「タスク」を含むとき＝最初に引用した読取の**題（最初の非空行そのもの）**を候補の題にするタスク提案を1件。
 *   - 質問に「通知」を含むとき＝読取に種別activityの記録が在るときだけ、その**題（最初の非空行そのもの）**を
 *     本文にする通知draftの提案を1件（源はactivity。通知の契約が対応している源のみ）。
 *   - 提案の根拠（usedReadings）にその読取の番号を必ず入れる（書込提案には根拠必須＝サーバー検証）。
 *   トリガー語が無ければ proposals は空（承認不要の形でも出さない。実行はAPI-31の承認だけ）。
 */
export function localTestAi(env: AppEnv): NonNullable<AppEnv["AI"]> | undefined {
  if (env.APP_ENV !== "local" || env.TEST_AI_FAKE !== "1") return undefined;
  return {
    run: async (model: string, input: { state?: unknown; questions?: unknown; messages?: unknown; response_format?: unknown }) => {
      void model;
      // RAGの構造出力（citationsを含むjson_schema）のときは決定的な引用応答を返す
      if (isRagCall(input)) return ragFakeResponse(input);
      // 横断assistantの構造出力（usedReadingsを含むjson_schema）のときは読み取りの引用だけを返す（提案は出さない）
      if (isAssistantCall(input)) return assistantFakeResponse(input);
      // 既存: 固定質問（docs/06 §2）を受けた形だけを模倣する。stateの中身は候補に反映しない（決定的な値）。
      // この応答形は報告書生成（messages＋{"text"}契約）には不適合のため、報告書生成jobは保留に落ちる
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

/** RAGの呼出しか（src/server/search/rag.tsのRAG_JSON_SCHEMAと同じ形のresponse_formatを持つか） */
function isRagCall(input: { response_format?: unknown }): boolean {
  const format = input.response_format as { json_schema?: { properties?: Record<string, unknown> } } | undefined;
  return format?.json_schema?.properties?.citations !== undefined;
}

interface RagFakeChunk {
  /** buildRagMessagesが振る1始まりの番号 */
  no: number;
  text: string;
}

/** user側の引用データ（<question>と<chunk id="N">）を取り出す（buildRagMessagesと同じ形のみを受け付ける） */
function parseRagInput(input: { messages?: unknown }): { question: string; chunks: RagFakeChunk[] } | null {
  const messages = input.messages as { role: string; content: string }[] | undefined;
  const user = messages?.find((m) => m.role === "user");
  if (!user) return null;
  const question = /<question>([\s\S]*?)<\/question>/.exec(user.content)?.[1];
  if (question === undefined) return null;
  const chunks: RagFakeChunk[] = [];
  for (const match of user.content.matchAll(/<chunk id="(\d+)">([\s\S]*?)<\/chunk>/g)) {
    chunks.push({ no: Number(match[1]!), text: match[2]! });
  }
  return { question, chunks };
}

/**
 * 決定的なRAG応答: 質問語（3字以上。trigramの一致条件と同じ）を含む行をchunkごとに1つ引用し、
 * その引用を並べた本文を返す。引用文字列はchunk本文の部分列そのもの＝サーバー検証を必ず通る。
 * 質問語を含むchunkが1つも無ければ citations 空で返す（chunk外の文は作らない＝捏造不能）。
 */
function ragFakeResponse(input: { messages?: unknown; response_format?: unknown }): { model: string; response: string; usage: { prompt_tokens: number; completion_tokens: number } } {
  const parsed = parseRagInput(input);
  const terms = (parsed?.question ?? "").trim().split(/\s+/).filter((t) => t.length >= 3);
  const citations: { chunk: number; quote: string }[] = [];
  const quotedLines: string[] = [];
  for (const chunk of parsed?.chunks ?? []) {
    // 質問語を含む行のうち、含む語数が最大の行（同点は先頭。決定的）を引用にする
    let best: { line: string; hits: number } | null = null;
    for (const line of chunk.text.split("\n")) {
      const hits = terms.filter((t) => line.includes(t)).length;
      if (hits > 0 && (best === null || hits > best.hits)) best = { line, hits };
    }
    if (best !== null) {
      citations.push({ chunk: chunk.no, quote: best.line });
      quotedLines.push(best.line);
    }
  }
  const answer = quotedLines.length > 0 ? quotedLines.join("\n") : "根拠となる資料が見つかりませんでした。";
  return {
    model: "fake-local-rag@2026-10-16",
    response: JSON.stringify({ answer, citations }),
    usage: { prompt_tokens: 96, completion_tokens: 48 },
  };
}

/** 横断assistantの呼出しか（src/server/ai/assistant.tsのASSISTANT_JSON_SCHEMAと同じ形のresponse_formatを持つか） */
function isAssistantCall(input: { response_format?: unknown }): boolean {
  const format = input.response_format as { json_schema?: { properties?: Record<string, unknown> } } | undefined;
  return format?.json_schema?.properties?.usedReadings !== undefined;
}

interface AssistantFakeReading {
  /** buildAssistantMessagesが振る1始まりの番号 */
  no: number;
  /** 読取の種別と記録ID（<reading>タグの属性。提案の源の特定に使う） */
  type: string;
  id: string;
  text: string;
}

/** user側の引用データ（<question>と<reading no="N" …>）を取り出す（buildAssistantMessagesと同じ形のみを受け付ける） */
function parseAssistantInput(input: { messages?: unknown }): { question: string; readings: AssistantFakeReading[] } | null {
  const messages = input.messages as { role: string; content: string }[] | undefined;
  if (!messages) return null;
  const user = messages.find((m) => m.role === "user");
  if (!user) return null;
  const question = /<question>([\s\S]*?)<\/question>/.exec(user.content)?.[1];
  if (question === undefined) return null;
  const readings: AssistantFakeReading[] = [];
  for (const match of user.content.matchAll(/<reading no="(\d+)"([^>]*)>([\s\S]*?)<\/reading>/g)) {
    const attrs = match[2] ?? "";
    readings.push({
      no: Number(match[1]!),
      type: /type="([^"]*)"/.exec(attrs)?.[1] ?? "",
      id: /id="([^"]*)"/.exec(attrs)?.[1] ?? "",
      text: match[3]!,
    });
  }
  return { question, readings };
}

/** 読取本文の最初の非空行（提案の題・本文は読取データの部分列そのものにしかしない＝捏造不能） */
const firstLineOf = (text: string): string | null =>
  text.split("\n").map((l) => l.trim()).find((l) => l.length > 0) ?? null;

/**
 * 決定的な横断assistant応答: 質問語（3字以上。検索の一致条件と同じ）を含む行を読み取りごとに1つ引用し、
 * その引用を並べた本文を返す。応答本文は読み取り本文の部分列にしかなり得ない＝捏造不能
 * （記録外の文・注入文〔質問語を含まない〕は応答に現れない）。
 * 書込提案はトリガー語（「タスク」/「通知」）が質問に明示的に在るときだけ（docs/03 §1.1の規約）。
 */
function assistantFakeResponse(input: { messages?: unknown; response_format?: unknown }): { model: string; response: string; usage: { prompt_tokens: number; completion_tokens: number } } {
  const parsed = parseAssistantInput(input);
  const question = parsed?.question ?? "";
  const terms = question.trim().split(/\s+/).filter((t) => t.length >= 3);
  const usedReadings: number[] = [];
  const quotedLines: string[] = [];
  for (const reading of parsed?.readings ?? []) {
    // 質問語を含む行のうち、含む語数が最大の行（同点は先頭。決定的）を引用にする
    let best: { line: string; hits: number } | null = null;
    for (const line of reading.text.split("\n")) {
      const hits = terms.filter((t) => line.includes(t)).length;
      if (hits > 0 && (best === null || hits > best.hits)) best = { line, hits };
    }
    if (best !== null) {
      usedReadings.push(reading.no);
      quotedLines.push(best.line);
    }
  }
  const answer = quotedLines.length > 0 ? quotedLines.join("\n") : "根拠となる読み取りがありませんでした。";

  // 書込提案（トリガー語が在るときだけ。値は読取データから派生させ、根拠の読取をusedReadingsに入れる）
  const used = new Set(usedReadings);
  const proposals: unknown[] = [];
  if (question.includes("タスク") && usedReadings.length > 0) {
    const source = parsed?.readings.find((r) => r.no === usedReadings[0]);
    const title = source ? firstLineOf(source.text)?.slice(0, 200) : null; // 題名の上限（LIMITS.titleMax）に揃える
    if (source && title) {
      used.add(source.no);
      proposals.push({ kind: "task", title });
    }
  }
  if (question.includes("通知")) {
    const activity = parsed?.readings.find((r) => r.type === "activity");
    const body = activity ? firstLineOf(activity.text)?.slice(0, 20_000) : null; // 本文の上限（LIMITS.bodyMax）に揃える
    if (activity && body) {
      used.add(activity.no);
      proposals.push({ kind: "notification", source: { type: "activity", id: activity.id }, body, channels: ["inapp"] });
    }
  }

  return {
    model: "fake-local-assistant@2026-10-16",
    response: JSON.stringify({ answer, usedReadings: [...used], proposals }),
    usage: { prompt_tokens: 120, completion_tokens: 40 },
  };
}
