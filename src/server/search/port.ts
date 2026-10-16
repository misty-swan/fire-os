import type { AuthzPrincipal } from "../auth/principal";
import type { AppEnv } from "../env";

/**
 * 検索方式の共通interface（T065、docs/06 §5、docs/14 D16、docs/16 T065）。
 *
 * - **選定基盤の型だけをここに置く**。実装本体（索引の投入・検索・失効回収）はT066が
 *   `createRetrievalPort(env, config)` で実装する（本タスクは選定評価と固定configまで）。
 * - `RetrievalPort.search` は「**許可chunkだけ**」を返す型とする（docs/10 §3「検索スニペットは
 *   許可された元行だけから算出」）。実装は検索SQL／索引問合せの前にunit・ACLを前置し（docs/06 §5.3）、
 *   返却後も呼び出し側（T067の回答生成・引用原文取得）が authorizedDocumentVersions
 *   （src/server/documents/authorized.ts。単一の正本）で再検査する二重構えを前提とする。
 * - 権限判定そのものはportの内側で新設せず、既存のauthorized系と連携する（docs/16 T063の裁定）。
 */

/** 検索バックエンドの語彙（docs/14 D16「検索はD1全文/Vectorizeを比較」）。列挙外は拒否する */
export type SearchBackend = "d1_fts" | "vectorize";

/** D1のFTS5仮想表のtokenizer（docs/16 T065の実測比較: unicode61は日本語を分かち書きしない） */
export type FtsTokenizer = "trigram" | "unicode61";

/** 選定結果を固定するconfig（config/search-development.jsonの語彙。T066が読んで実装に渡す） */
export interface SearchConfig {
  backend: SearchBackend;
  /** Vectorizeバックエンド用のembeddingモデル（d1_ftsでは省略。実測で確定するまで設定しない） */
  modelId?: string;
  /** 選定の版（空文字は拒否。選定を更新したら上げる） */
  version: string;
}

/**
 * 開発選定の記録を含むconfig（config/search-development.json）。SearchConfigに選定の根拠欄を
 * 加えたもの。未知のキー・列挙外の値はparseSearchConfigが拒否する（docs/05 §1「未知JSON列・列挙外を拒否」）。
 */
export interface SearchDevelopmentConfig extends SearchConfig {
  /** d1_ftsのFTS5 tokenizer（実測比較でtrigramを選んだ。docs/evidence/V04-retrieval.md） */
  tokenizer?: FtsTokenizer;
  /** 検索のtopK（既定RETRIEVAL_TOPK_DEFAULT。上限RETRIEVAL_TOPK_MAX） */
  topK?: number;
  /** 選定を実施した日（ISO日付。記録用） */
  selectedAt?: string;
  /** 選定の根拠（試験名・証跡。根拠の無い選定はselectRetrievalBackendが拒否する） */
  basis?: string;
  /** 選定に使った固定datasetのsha256（tests/fixtures/ai/rag-holdout.jsonl） */
  datasetHash?: string;
}

/**
 * 検索が返す「許可されたchunk」（T064のdocument_chunks行＋所在。 AuthorizedChunk = 権限検査済みの意味）。
 * textは常に原本の頁テキストの部分列そのもの（T064のchunkDocument契約。引用spanの逆引きは
 * resolveCitationSpanで行う＝T067と試験が共有）。
 */
export interface AuthorizedChunk {
  /** document_chunks.id */
  chunkId: string;
  /** document_versions.id（T066/T067がauthorizedDocumentVersionsで再検査する鍵） */
  versionId: string;
  documentId: string;
  chunkNo: number;
  pageNo: number | null;
  section: string | null;
  text: string;
  /** 関連度のスコア（backend固有の尺度。高いほど関連が高い。d1_ftsはbm25 rankの反転） */
  score: number;
}

/** 検索への入力（API-76のquery/maxSources/documentIdsに対応。docs/05 §1の上限をport側でも保持する） */
export interface RetrievalInput {
  /** RAG質問（docs/05 §1「AI/RAG質問4,000文字」上限） */
  query: string;
  /** 返却件数（省略時RETRIEVAL_TOPK_DEFAULT） */
  topK?: number;
  /** 絞り込み対象のdocumentId（API-76のdocumentIds。authorizedDocumentVersionsの上限80と揃える） */
  documentIds?: string[];
}

/** 検索方式のport。実装（T066）は検索前にACLを前置し、許可chunkだけを返すこと */
export interface RetrievalPort {
  search(p: AuthzPrincipal, input: RetrievalInput): Promise<AuthorizedChunk[]>;
}

/** docs/05 §1「AI/RAG質問4,000文字」の共通上限（列ごとにDBのCHECKより広い共通上限を使う流儀） */
export const RETRIEVAL_QUERY_MAX_CHARS = 4000;
/** 検索の既定topK（選定評価と同じ値。実測はこの値で行った） */
export const RETRIEVAL_TOPK_DEFAULT = 5;
/** topKの上限（docs/05 §1「limit既定50/最大200」の検索側の運用上限） */
export const RETRIEVAL_TOPK_MAX = 50;
/** documentIds絞り込みの上限（authorizedDocumentVersionsのbind上限80と一致させる） */
export const RETRIEVAL_DOCUMENT_IDS_MAX = 80;

/** inputの値域を検査する（T066の実装と選定評価の両方が使う共通の入口検査） */
export function validateRetrievalInput(input: RetrievalInput): void {
  if (typeof input.query !== "string" || input.query.length === 0) {
    throw new Error("RetrievalInput: queryは1字以上の文字列であること");
  }
  if (input.query.length > RETRIEVAL_QUERY_MAX_CHARS) {
    throw new Error(`RetrievalInput: queryが上限（${RETRIEVAL_QUERY_MAX_CHARS}字）を超えています`);
  }
  if (input.topK !== undefined && (!Number.isInteger(input.topK) || input.topK < 1 || input.topK > RETRIEVAL_TOPK_MAX)) {
    throw new Error(`RetrievalInput: topKは1〜${RETRIEVAL_TOPK_MAX}の整数であること`);
  }
  if (input.documentIds !== undefined) {
    if (!Array.isArray(input.documentIds) || input.documentIds.length > RETRIEVAL_DOCUMENT_IDS_MAX) {
      throw new Error(`RetrievalInput: documentIdsは${RETRIEVAL_DOCUMENT_IDS_MAX}件まで`);
    }
    if (input.documentIds.some((id) => typeof id !== "string" || id.length === 0)) {
      throw new Error("RetrievalInput: documentIdsは空でない文字列の配列であること");
    }
  }
}

const BACKENDS: readonly SearchBackend[] = ["d1_fts", "vectorize"];
const TOKENIZERS: readonly FtsTokenizer[] = ["trigram", "unicode61"];

/**
 * 固定config（config/search-development.json）の読み込み検証。未知backend・空version・未知キーを拒否する。
 * bundleへの埋め込み（静的import）はT066が接続する（docs/16 T065）。まずは型と読み込み検証をここに置く。
 */
export function parseSearchConfig(input: unknown): SearchDevelopmentConfig {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new Error("SearchConfig: オブジェクトであること");
  }
  const ALLOWED = new Set(["backend", "modelId", "version", "tokenizer", "topK", "selectedAt", "basis", "datasetHash"]);
  const record = input as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (!ALLOWED.has(key)) throw new Error(`SearchConfig: 未知のキー「${key}」は拒否します`);
  }
  if (!BACKENDS.includes(record.backend as SearchBackend)) {
    throw new Error(`SearchConfig: backendは${BACKENDS.join("/")}のいずれか（実際: ${JSON.stringify(record.backend)}）`);
  }
  if (typeof record.version !== "string" || record.version.length === 0 || record.version.length > 100) {
    throw new Error("SearchConfig: versionは1〜100字の文字列であること（空は拒否）");
  }
  if (record.modelId !== undefined && (typeof record.modelId !== "string" || record.modelId.length === 0)) {
    throw new Error("SearchConfig: modelIdは空でない文字列であること");
  }
  if (record.tokenizer !== undefined && !TOKENIZERS.includes(record.tokenizer as FtsTokenizer)) {
    throw new Error(`SearchConfig: tokenizerは${TOKENIZERS.join("/")}のいずれか（実際: ${JSON.stringify(record.tokenizer)}）`);
  }
  if (
    record.topK !== undefined &&
    (typeof record.topK !== "number" || !Number.isInteger(record.topK) || record.topK < 1 || record.topK > RETRIEVAL_TOPK_MAX)
  ) {
    throw new Error(`SearchConfig: topKは1〜${RETRIEVAL_TOPK_MAX}の整数であること`);
  }
  for (const key of ["selectedAt", "basis", "datasetHash"] as const) {
    if (record[key] !== undefined && (typeof record[key] !== "string" || record[key].length === 0)) {
      throw new Error(`SearchConfig: ${key}は空でない文字列であること`);
    }
  }
  if (record.backend === "vectorize" && typeof record.modelId !== "string") {
    throw new Error("SearchConfig: backend=vectorizeのときはmodelId（embeddingモデル）が必須");
  }
  return record as unknown as SearchDevelopmentConfig;
}
