import type { ClassificationCategory } from "../../shared/contracts/ai";

/**
 * Jevに送る質問定義（T053、docs/06 §2）。**質問はサーバー固定**で、クライアントは
 * 版（questionVersion）を指定するだけ。criteria/instructionsの文面はdocs/06 §2の例
 * （架空・実呼出し未実施）をそのまま使い、V04の実証で確定する。
 */

/** 現在の質問版。質問文・カテゴリを変えるときはこの版を進める（評価集合との対応はD12/V04） */
export const QUESTION_VERSION = "v1";
/** 受け付ける質問版の一覧（旧版は400 unknown_question_version。docs/06「質問/選択肢を含む…」） */
export const QUESTION_VERSIONS: readonly string[] = [QUESTION_VERSION];

export const isKnownQuestionVersion = (value: string): boolean => QUESTION_VERSIONS.includes(value);

/** Jevのquestions引数（docs/06 §2のJSON例どおり。choice=代表分類、noul=追加確認の要否） */
export const jevQuestions = {
  category: {
    type: "choice",
    instructions: "報告の代表分類を選ぶ",
    criteria: {
      equipment_issue: "設備の問題",
      access_obstruction: "接近障害",
      missing_equipment: "収納物不足",
      no_issue: "異常報告なし",
      other: "その他",
    },
  },
  needs_check: {
    type: "noul",
    instructions: "追加確認が必要という記述があるか",
    criteria: { true: "未確認・曖昧・確認依頼", false: "追加確認の記述なし" },
  },
} as const;
export type JevQuestions = typeof jevQuestions;

/** 質問answersのキー（これ以外の回答キーは未知キーとして拒否する） */
export const JEV_ANSWER_KEYS: readonly string[] = ["category", "needs_check"];

/** 複数異常フラグの判定対象（no_issue/otherは「異常の代表」ではない。docs/06 §2「代表カテゴリと複数補助フラグを分離」） */
export const ANOMALY_CATEGORIES: readonly ClassificationCategory[] = ["equipment_issue", "access_obstruction", "missing_equipment"];

/**
 * 複数異常フラグの閾値（アプリ側のレビュー補助表示のための値で、品質ゲートではない。
 * docs/06 §6の閾値（macro F1等）はV04/D12の評価で決めるもので、ここでは使わない）
 */
export const MULTIPLE_ISSUE_PROBABILITY = 0.2;
