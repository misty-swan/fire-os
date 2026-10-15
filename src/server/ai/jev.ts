import type { ClassificationCategory } from "../../shared/contracts/ai";
import { classificationCategories } from "../../shared/contracts/ai";
import type { AppEnv } from "../env";
import { canonicalJson } from "../mutations/hash";
import { ANOMALY_CATEGORIES, JEV_ANSWER_KEYS, MULTIPLE_ISSUE_PROBABILITY, QUESTION_VERSION, jevQuestions } from "./questions";

/**
 * Jev（Workers AI `typesafe/jev`）の呼出しと応答検証（T053、docs/06 §2/§3）。
 *
 * - 呼出しは `env.AI.run("typesafe/jev", { state, questions })`。stateは呼び出し側が組み立てる
 *   **最小化input**（点検のnote＋項目コード等。氏名・連絡先を含めない＝docs/14 D12）。
 * - 戻り値（model/answers/usage）は**キー/型/数値範囲/許可カテゴリ/応答サイズを検証**し、
 *   未知型・空出力・未知キー・範囲外は候補にせず JevOutputError として保留（manual_review）へ
 *   回す（docs/06 §2「未知型/空出力/timeout/入力上限はmanual_reviewへ」）。
 * - noul（0〜1の保留度）はそのまま needsReview として保存する。choiceのconfidenceは検証だけして
 *   判定には使わない（docs/06「confidenceを現実の異常確率/正答保証と表示しない」）。
 * - 出力は最終事実ではない。ClassificationCandidateは人の承認（T054）までの候補に過ぎず、
 *   このモジュールは設備状態を一切変更しない。
 */

/** Cloudflareカタログのモデル名（docs/06 §2）。実モデル版の固定可否はV04で実証する */
export const JEV_MODEL = "typesafe/jev";

/** 応答サイズの上限（検証設定。実応答の実測はV04。docs/05 §1のJSON 256KiBより十分小さく置く） */
const MAX_OUTPUT_BYTES = 100_000;
/** 入力（state）サイズの上限（検証設定。Jevカタログのcontextは32,000 tokens＝docs/06 §2。実測はV04） */
const MAX_INPUT_BYTES = 100_000;

export interface ClassificationUsage {
  promptTokens: number;
  completionTokens: number;
}

/**
 * 分類候補（docs/16 T053のInterface）。**最終事実ではない**:
 * categories（代表＋確率＋複数異常フラグ）/ needsReview（noul）/ model（実モデル版）/
 * questionVersion / sourceVersion / usage。承認（T054）まで設備・異常へは反映されない。
 */
export interface ClassificationCandidate {
  categories: {
    representative: ClassificationCategory;
    probabilities: Partial<Record<ClassificationCategory, number>> | null;
    multipleIssues: boolean;
  };
  /** Jevのnoul（0〜1）そのもの。booleanでもchoiceのconfidenceでもない */
  needsReview: number;
  model: string;
  questionVersion: string;
  sourceVersion: number;
  usage: ClassificationUsage | null;
}

export interface ClassificationInput {
  /**
   * 最小化input（docs/06 §2のstate）。組み立ては呼び出し側（handlers/classification）が行い、
   * 氏名・連絡先・添付参照等を含めてはいけない（docs/14 D12「架空/許諾済・最小化本文」）。
   */
  state: Record<string, unknown>;
  /** 元版（結果の採用条件。実行時に元版が変わっていればjobはstaleになる） */
  sourceVersion: number;
}

/** 応答が契約外のときの保留理由（jobのerror_codeにする短いコードへはハンドラが変換する） */
export class JevOutputError extends Error {
  constructor(public readonly reason: "ai_output_invalid" | "input_too_large") {
    super(`jev output invalid: ${reason}`);
  }
}

/** AI呼出し自体の失敗（一時的。jobはretry_wait→再試行。docs/06 §3「失敗の再試行上限」） */
export class AiRunError extends Error {
  constructor(message: string) {
    super(`jev run failed: ${message}`);
  }
}

// --- 応答の検証（docs/06 §2「キー/型/数値範囲/許可カテゴリ/応答サイズを検証」） ---

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
/** booleanを数値として受理しない（noulは「booleanでも別confidence付きでもない」。docs/06 §2） */
const isUnitNumber = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= 1;
const isNonNegativeInt = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v) && v >= 0;
const isCategory = (v: string): v is ClassificationCategory => (classificationCategories as readonly string[]).includes(v);

export interface ValidatedJevOutput {
  model: string | null;
  category: {
    choice: ClassificationCategory;
    probabilities: Partial<Record<ClassificationCategory, number>> | null;
    confidence: number | null;
  };
  needsCheckNoul: number;
  usage: ClassificationUsage | null;
}

/**
 * 生の出力を検証する。許可された形以外はすべて拒否する（黙って捨てるキーを作らない）。
 * 戻り値のconfidenceは保存用に検証するだけで判定には使わない。
 */
export function validateJevOutput(raw: unknown): { ok: true; value: ValidatedJevOutput } | { ok: false } {
  if (!isRecord(raw)) return { ok: false };
  // 応答サイズ（応答本文は小さい。巨大な応答は契約外として拒否する）
  let text: string;
  try {
    text = canonicalJson(raw);
  } catch {
    return { ok: false }; // 有限でない数値等、正規化できないもの
  }
  if (new TextEncoder().encode(text).byteLength > MAX_OUTPUT_BYTES) return { ok: false };

  // トップレベルのキー（docs/06 §2「戻り値はmodel/answers/usage」）。未知キーは拒否
  const topKeys = Object.keys(raw);
  if (!topKeys.includes("answers")) return { ok: false };
  for (const k of topKeys) if (k !== "answers" && k !== "model" && k !== "usage") return { ok: false };
  if (raw.model !== undefined && (typeof raw.model !== "string" || raw.model.length < 1 || raw.model.length > 200)) return { ok: false };

  // usage（あれば非負整数の対。token単価の計算に使う）
  let usage: ClassificationUsage | null = null;
  if (raw.usage !== undefined) {
    if (!isRecord(raw.usage)) return { ok: false };
    const p = raw.usage.prompt_tokens;
    const cp = raw.usage.completion_tokens;
    if (!isNonNegativeInt(p) || !isNonNegativeInt(cp)) return { ok: false };
    usage = { promptTokens: p, completionTokens: cp };
  }

  // answers: 既知の質問キーちょうど（未知キー拒否・欠落拒否）
  const answers = raw.answers;
  if (!isRecord(answers)) return { ok: false };
  const answerKeys = Object.keys(answers).sort();
  if (answerKeys.length !== JEV_ANSWER_KEYS.length || !JEV_ANSWER_KEYS.every((k, i) => answerKeys[i] === k)) return { ok: false };

  // category（choice）: 許可カテゴリのみ。probabilities/confidenceは任意だが形が悪ければ拒否
  const category = answers.category;
  if (!isRecord(category)) return { ok: false };
  const catKeys = Object.keys(category);
  if (!catKeys.includes("choice")) return { ok: false };
  for (const k of catKeys) if (k !== "choice" && k !== "probabilities" && k !== "confidence") return { ok: false };
  const choice = category.choice;
  if (typeof choice !== "string" || !isCategory(choice)) return { ok: false };
  let probabilities: Partial<Record<ClassificationCategory, number>> | null = null;
  if (category.probabilities !== undefined) {
    if (!isRecord(category.probabilities)) return { ok: false };
    probabilities = {};
    for (const [k, v] of Object.entries(category.probabilities)) {
      if (!isCategory(k) || !isUnitNumber(v)) return { ok: false };
      probabilities[k] = v;
    }
  }
  let confidence: number | null = null;
  if (category.confidence !== undefined) {
    if (!isUnitNumber(category.confidence)) return { ok: false };
    confidence = category.confidence; // 検証だけ。判定には使わない
  }

  // needs_check（noul）: 0〜1の数値ちょうど1キー。boolean・confidence・欠落は拒否
  const needsCheck = answers.needs_check;
  if (!isRecord(needsCheck) || Object.keys(needsCheck).length !== 1 || !("noul" in needsCheck)) return { ok: false };
  if (!isUnitNumber(needsCheck.noul)) return { ok: false };

  return {
    ok: true,
    value: {
      model: (raw.model as string) ?? null,
      category: { choice, probabilities, confidence },
      needsCheckNoul: needsCheck.noul,
      usage,
    },
  };
}

/** 検証済みの出力を候補へ正規化する（複数異常フラグはprobabilitiesから決定論的に導く） */
export function deriveCandidate(valid: ValidatedJevOutput, input: ClassificationInput): ClassificationCandidate {
  const probabilities = valid.category.probabilities;
  const flagged = probabilities
    ? ANOMALY_CATEGORIES.filter((c) => {
        const p = probabilities[c];
        return (p ?? 0) >= MULTIPLE_ISSUE_PROBABILITY;
      })
    : [];
  return {
    categories: {
      representative: valid.category.choice,
      probabilities,
      multipleIssues: flagged.length > 1,
    },
    needsReview: valid.needsCheckNoul,
    model: valid.model ?? JEV_MODEL,
    questionVersion: QUESTION_VERSION,
    sourceVersion: input.sourceVersion,
    usage: valid.usage,
  };
}

/**
 * 保存用のoutput_json（候補本体＋生出力answers。生出力は人の決定と別に残す＝docs/06 §3）。
 * DTOの ClassificationCandidateOutput と同じ形で、これをcanonicalJsonしてDBへ保存する。
 */
export function buildStoredCandidate(
  candidate: ClassificationCandidate,
  valid: ValidatedJevOutput,
): {
  categories: ClassificationCandidate["categories"];
  needsReview: number;
  model: string;
  questionVersion: string;
  sourceVersion: number;
  usage: ClassificationUsage | null;
  answers: Record<string, unknown>;
} {
  return {
    categories: candidate.categories,
    needsReview: candidate.needsReview,
    model: candidate.model,
    questionVersion: candidate.questionVersion,
    sourceVersion: candidate.sourceVersion,
    usage: candidate.usage,
    answers: {
      category: {
        choice: valid.category.choice,
        ...(valid.category.probabilities ? { probabilities: valid.category.probabilities } : {}),
        ...(valid.category.confidence !== null ? { confidence: valid.category.confidence } : {}),
      },
      needs_check: { noul: valid.needsCheckNoul },
    },
  };
}

/**
 * Jevを呼び、生出力の検証結果と候補の両方を返す（保存用。ハンドラが使う）。
 * 応答が契約外のときは JevOutputError（保留＝manual_reviewへ）、呼出し自体の失敗は
 * AiRunError（一時的＝retry_waitへ）。env.AIは呼び出し側が事前に存在確認する
 * （localはbindingが無いためhandlers/classificationがmanual_review ai_unavailableにする）。
 * この関数はD1へ書かず、外部効果はAI呼出しのみ（jobとしての確定はハンドラの責務）。
 */
export async function runJev(env: AppEnv, input: ClassificationInput): Promise<{ candidate: ClassificationCandidate; validated: ValidatedJevOutput }> {
  if (!env.AI) throw new JevOutputError("ai_output_invalid"); // 念のための拒否（通常は通らない）
  if (new TextEncoder().encode(canonicalJson(input.state)).byteLength > MAX_INPUT_BYTES) {
    throw new JevOutputError("input_too_large"); // 入力上限は保留へ（docs/06 §2）
  }
  let raw: unknown;
  try {
    raw = await env.AI.run(JEV_MODEL, { state: input.state, questions: jevQuestions });
  } catch (err) {
    throw new AiRunError(String(err)); // 通信・レート等の一時失敗。壊れ出力ではない
  }
  const validated = validateJevOutput(raw);
  if (!validated.ok) throw new JevOutputError("ai_output_invalid");
  return { candidate: deriveCandidate(validated.value, input), validated: validated.value };
}

/**
 * Jevを呼んで検証済みの分類候補を返す（docs/16 T053のInterface）。
 * 生出力（answers）まで必要な呼び出し側（job handler）は runJev を使う。
 */
export async function classifyInspection(env: AppEnv, input: ClassificationInput): Promise<ClassificationCandidate> {
  return (await runJev(env, input)).candidate;
}
