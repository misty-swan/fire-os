/**
 * RAG検索評価の固定dataset（T065、docs/06 §5、docs/16 T065）の型と読み込み。
 *
 * 正本は tests/fixtures/ai/rag-holdout.jsonl（決定的生成: scripts/generate-retrieval-dataset.ts）。
 * 試験・実行時は生成TSモジュール（tests/fixtures/ai/generated-rag-holdout.ts と
 * src/server/search/dataset/rag-holdout.ts。同一内容）をimportし、一致とsha256を試験が検証する
 * （T061と同じ二重管理）。ここには語彙の検査だけを置き、生成はしない（決定性は生成スクリプトが持つ）。
 *
 * datasetの構造:
 *  - document行: 資料100件×20頁相当（unit A=主評価80／unit B=別unit20。すべて架空データ）
 *  - question行: RAG質問55件。質問種別（exact/paraphrase/abbreviation/negation/no_evidence/other_unit）、
 *    検索に渡すquery（空白区切りの語）、正解根拠（docKey+pageNo+snippetでchunkを特定）と
 *    期待挙動（found/not_found）を人手ラベルとして持つ
 */

export type RetrievalQuestionType =
  | "exact"
  | "paraphrase"
  | "abbreviation"
  | "negation"
  | "no_evidence"
  | "other_unit";

export interface RetrievalDatasetDocument {
  /** 資料の鍵（d001〜d100。docKey） */
  key: string;
  /** 主評価unit（A）／別unit（B）。other_unit質問の正解はBにだけある */
  unit: "A" | "B";
  title: string;
  topic: string;
  /** 頁テキスト（20頁。chunkDocumentに入れる形そのもの） */
  pages: string[];
}

export interface RetrievalDatasetQuestion {
  id: string;
  type: RetrievalQuestionType;
  /** 自然文の質問（記録・生成評価用。検索には使わない） */
  text: string;
  /** 検索へ渡す語の列（空白区切り。両候補へ同一条件で渡す） */
  query: string;
  expected: {
    behavior: "found" | "not_found";
    /** 正解根拠の所在（not_foundのときnull） */
    docKey: string | null;
    pageNo: number | null;
    snippet: string | null;
  };
}

export interface RetrievalDataset {
  documents: RetrievalDatasetDocument[];
  questions: RetrievalDatasetQuestion[];
}

const QUESTION_TYPES: readonly RetrievalQuestionType[] = [
  "exact", "paraphrase", "abbreviation", "negation", "no_evidence", "other_unit",
];

/** jsonl（1行1件のdocument/question）を読み込む。未知の行種別・語彙外は拒否する（fail-closed） */
export function parseRetrievalDataset(jsonl: string): RetrievalDataset {
  const documents: RetrievalDatasetDocument[] = [];
  const questions: RetrievalDatasetQuestion[] = [];
  const lines = jsonl.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (line.length === 0) continue;
    let row: unknown;
    try {
      row = JSON.parse(line);
    } catch (err) {
      throw new Error(`datasetの${i + 1}行目がJSONとして不正です: ${(err as Error).message}`);
    }
    const record = row as Record<string, unknown>;
    if (record.kind === "document") {
      const unit = record.unit;
      if (unit !== "A" && unit !== "B") throw new Error(`datasetの${i + 1}行目: unitはA/B（実際: ${String(unit)}）`);
      if (typeof record.key !== "string" || typeof record.title !== "string" || typeof record.topic !== "string") {
        throw new Error(`datasetの${i + 1}行目: key/title/topicは文字列であること`);
      }
      if (!Array.isArray(record.pages) || record.pages.some((p) => typeof p !== "string")) {
        throw new Error(`datasetの${i + 1}行目: pagesは文字列の配列であること`);
      }
      documents.push({
        key: record.key,
        unit,
        title: record.title,
        topic: record.topic,
        pages: record.pages as string[],
      });
      continue;
    }
    if (record.kind === "question") {
      const type = record.type;
      if (!QUESTION_TYPES.includes(type as RetrievalQuestionType)) {
        throw new Error(`datasetの${i + 1}行目: 未知の質問種別 ${String(type)}`);
      }
      if (typeof record.id !== "string" || typeof record.text !== "string" || typeof record.query !== "string") {
        throw new Error(`datasetの${i + 1}行目: id/text/queryは文字列であること`);
      }
      const expected = record.expected as Record<string, unknown> | undefined;
      if (
        !expected ||
        (expected.behavior !== "found" && expected.behavior !== "not_found") ||
        (expected.behavior === "found" &&
          (typeof expected.docKey !== "string" || typeof expected.pageNo !== "number" || typeof expected.snippet !== "string"))
      ) {
        throw new Error(`datasetの${i + 1}行目: expectedラベルの形式が不正です`);
      }
      questions.push({
        id: record.id,
        type: type as RetrievalQuestionType,
        text: record.text,
        query: record.query,
        expected: {
          behavior: expected.behavior,
          docKey: (expected.docKey as string | null) ?? null,
          pageNo: (expected.pageNo as number | null) ?? null,
          snippet: (expected.snippet as string | null) ?? null,
        },
      });
      continue;
    }
    throw new Error(`datasetの${i + 1}行目: 未知の行種別 ${String(record.kind)}`);
  }
  return { documents, questions };
}
