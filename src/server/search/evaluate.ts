import { authorizedDocumentVersions } from "../documents/authorized";
import { chunkDocument } from "../documents/chunk";
import type { AuthzPrincipal } from "../auth/principal";
import type { AppEnv } from "../env";
import type { RetrievalDataset, RetrievalDatasetQuestion, RetrievalQuestionType } from "./dataset";
import {
  RETRIEVAL_TOPK_DEFAULT,
  type FtsTokenizer,
  type SearchBackend,
  type SearchDevelopmentConfig,
  validateRetrievalInput,
} from "./port";

/**
 * 検索方式の選定評価（T065、docs/06 §5、docs/14 D16、docs/16 T065、docs/evidence/V04-retrieval.md）。
 *
 * - **選定は証跡ベース**: 候補ごとに {datasetHash, metrics, measuredAt, evidence} を要求し、
 *   実測の無い候補の選定は拒否する（selectRetrievalBackend）。ローカル（workerd D1）で実測できるのは
 *   d1_fts のみで、Vectorize候補は実Cloudflare bindingが必要なため実測欠如＝選定不可
 *   （プリフライト裁定。実測を実測として偽装しない。モックで完了扱いにしない）。
 * - **D1 FTS5の実測**: 仮想表は本試験（evaluations harness）の中だけで作る（本番DDL/索引投入はT066）。
 *   unicode61 は日本語を分かち書きしない（語の部分一致が0になる）ため trigram と同じ固定dataset上で
 *   比較し、測定結果で tokenizer を選ぶ。
 * - **ACL前置**: 検索SQLはunitで絞り、raw結果は authorizedDocumentVersions で再検査して
 *   unauthorizedChunks を数える（0であること）。bypassUnitFilter の診断実行で「前置を外すと
 *   別unitのchunkが現れ、再検査が拒否する」ことも確かめられる（防御の実証）。
 */

export const RETRIEVAL_DATASET_VERSION = "rag-holdout-v1";
/** 選定結果の固定configの版（config/search-development.json） */
export const SELECTED_SEARCH_CONFIG_VERSION = "search-dev-v1";

/** dataset本文のsha256（16進。TextEncoder→UTF-8。生成スクリプトのnode:cryptoと同じ値になる） */
export async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// --- 評価用corpus（document_versions/document_chunksへ架空資料を投入する） -------------------

export interface CorpusChunk {
  chunkId: string;
  /** dataset上のunitの別名（A=主評価／B=別unit） */
  unitKey: "A" | "B";
  unitId: string;
  documentId: string;
  versionId: string;
  /** dataset上の資料の鍵（d001〜d100） */
  docKey: string;
  chunkNo: number;
  pageNo: number;
  section: string | null;
  text: string;
}

export interface EvaluationCorpus {
  unitIds: { A: string; B: string };
  chunks: CorpusChunk[];
  /** 正解根拠（docKey+pageNo+snippet）からchunkを特定する（人手ラベルの解決） */
  chunkFor(docKey: string, pageNo: number, snippet: string): CorpusChunk | undefined;
}

const NOW_ISO = "2026-10-16T00:00:00.000Z";
const EXPIRES_ISO = "2027-10-16T00:00:00.000Z";

/**
 * 固定datasetの資料を、承認済み＋索引済みの状態で評価用D1へ投入する
 * （attachmentsはdocument_versionsのFKの受け口として最小構成で作る。原本bytesは存在しない架空fixture）。
 */
export async function seedEvaluationCorpus(
  env: Pick<AppEnv, "DB">,
  dataset: RetrievalDataset,
  ids: {
    A: string;
    B: string;
    /** unitごとのowner（attachments.ownerの複合FK〔unit_id, member_id〕がunit一致を要求するため） */
    ownerA: { userId: string; memberId: string };
    ownerB: { userId: string; memberId: string };
  },
): Promise<EvaluationCorpus> {
  const ownerOf = (docKey: string): { userId: string; memberId: string } => {
    const unit = dataset.documents.find((d) => d.key === docKey)!.unit;
    return unit === "A" ? ids.ownerA : ids.ownerB;
  };
  const docIds = new Map<string, string>();
  const versionIds = new Map<string, string>();
  const attachmentIdByDoc = new Map<string, string>();
  const unitIdOf = (docKey: string): string => {
    const unit = dataset.documents.find((d) => d.key === docKey)!.unit;
    return unit === "A" ? ids.A : ids.B;
  };

  const batches: D1PreparedStatement[][] = [];
  const statementsOf = (): D1PreparedStatement[] => {
    const b: D1PreparedStatement[] = [];
    batches.push(b);
    return b;
  };

  // attachments（FKの受け口。検査・R2には触れない）
  const attStmts = statementsOf();
  for (const doc of dataset.documents) {
    const attachmentId = crypto.randomUUID();
    attachmentIdByDoc.set(doc.key, attachmentId);
    const contentHash = await sha256Hex(`eval-corpus:${doc.key}`);
    docIds.set(doc.key, crypto.randomUUID());
    versionIds.set(doc.key, crypto.randomUUID());
    attStmts.push(
      env.DB.prepare(
        "INSERT INTO attachments (id, unit_id, owner_user_id, owner_member_id, intent_target_type, intent_target_id, content_type, byte_size, sha256, status, expires_at, classification, upload_token_hash, ready_key, created_at, updated_at, actor_kind) " +
          "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      ).bind(
        attachmentId, unitIdOf(doc.key), ownerOf(doc.key).userId, ownerOf(doc.key).memberId, "document", docIds.get(doc.key)!,
        "application/pdf", 1024, contentHash, "ready", EXPIRES_ISO, "basic", "0".repeat(64),
        `eval/fixtures/${doc.key}.pdf`, NOW_ISO, NOW_ISO, "system",
      ),
    );
  }

  // documents（root。status=approved。current_*のpointerは評価に使わないためNULLのまま）
  const docStmts = statementsOf();
  for (const doc of dataset.documents) {
    docStmts.push(
      env.DB.prepare(
        "INSERT INTO documents (id, unit_id, title, classification, status, policy_version, created_at, updated_at, actor_kind) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
      ).bind(docIds.get(doc.key)!, unitIdOf(doc.key), doc.title, "訓練資料（架空）", "approved", 1, NOW_ISO, NOW_ISO, "system"),
    );
  }

  // document_versions（承認済み。approved_by/atは承認列CHECKの要件）
  const verStmts = statementsOf();
  for (const doc of dataset.documents) {
    verStmts.push(
      env.DB.prepare(
        "INSERT INTO document_versions (id, unit_id, document_id, revision_no, attachment_id, status, approved_by, approved_at, license_ref, content_hash, created_at, updated_at, actor_kind) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      ).bind(
        versionIds.get(doc.key)!, unitIdOf(doc.key), docIds.get(doc.key)!, 1, attachmentIdByDoc.get(doc.key)!,
        "approved", ownerOf(doc.key).userId, NOW_ISO, "架空・自団体作成（検証用）", await sha256Hex(`eval-corpus:${doc.key}`),
        NOW_ISO, NOW_ISO, "system",
      ),
    );
  }

  // document_chunks（T064のchunkDocumentで計算。承認済み＋indexed=T066の索引後の状態を再現する）
  const chunkStmts = statementsOf();
  const corpus: CorpusChunk[] = [];
  for (const doc of dataset.documents) {
    const contentHash = await sha256Hex(`eval-corpus:${doc.key}`);
    const unitId = unitIdOf(doc.key);
    const versionId = versionIds.get(doc.key)!;
    const chunks = chunkDocument({
      versionId,
      documentId: docIds.get(doc.key)!,
      unitId,
      contentHash,
      extractorVersion: "retrieval-evaluation",
      pages: doc.pages.map((text, idx) => ({ pageNo: idx + 1, text })),
    });
    const VALUES = "(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)";
    for (let at = 0; at < chunks.length; at += 7) {
      const group = chunks.slice(at, at + 7);
      const binds: unknown[] = [];
      for (const chunk of group) {
        const chunkId = crypto.randomUUID();
        corpus.push({
          chunkId, unitKey: doc.unit, unitId, documentId: docIds.get(doc.key)!, versionId,
          docKey: doc.key, chunkNo: chunk.chunkNo, pageNo: chunk.pageNo!, section: chunk.section, text: chunk.text,
        });
        binds.push(
          chunkId, unitId, versionId, chunk.chunkNo, chunk.pageNo, chunk.section, chunk.text,
          JSON.stringify(chunk.sourceOffsets), "indexed", "eval-d1-fts:v1", NOW_ISO, NOW_ISO, "system",
        );
      }
      chunkStmts.push(
        env.DB.prepare(
          `INSERT INTO document_chunks (id, unit_id, version_id, chunk_no, page_no, section, text, source_offsets, index_status, index_key, created_at, updated_at, actor_kind) VALUES ${group
            .map(() => VALUES)
            .join(", ")}`,
        ).bind(...binds),
      );
    }
  }

  // バッチは文数を抑えて分割実行（ローカルD1の安定性。ステートメントは1文100bind内で組んである）
  for (const batch of batches) {
    for (let at = 0; at < batch.length; at += 60) {
      await env.DB.batch(batch.slice(at, at + 60));
    }
  }

  const byDocPage = new Map<string, CorpusChunk[]>();
  for (const chunk of corpus) {
    const key = `${chunk.docKey}#${chunk.pageNo}`;
    const list = byDocPage.get(key) ?? [];
    list.push(chunk);
    byDocPage.set(key, list);
  }
  return {
    unitIds: { A: ids.A, B: ids.B },
    chunks: corpus,
    chunkFor: (docKey, pageNo, snippet) => (byDocPage.get(`${docKey}#${pageNo}`) ?? []).find((c) => c.text.includes(snippet)),
  };
}

// --- D1 FTS5の実測（仮想表は評価の中だけで作る。本番DDL/索引投入はT066） --------------------

const FTS_TABLES: Record<FtsTokenizer, string> = {
  trigram: "eval_chunks_fts_trigram",
  unicode61: "eval_chunks_fts_unicode61",
};

/** 2つのtokenizerの仮想表を作り直してcorpusの全chunkを投入する（評価の度に決定的な状態から始める） */
export async function buildEvaluationFtsTables(env: Pick<AppEnv, "DB">, corpus: EvaluationCorpus): Promise<void> {
  for (const [tokenizer, table] of Object.entries(FTS_TABLES) as [FtsTokenizer, string][]) {
    await env.DB.exec(`DROP TABLE IF EXISTS ${table}`);
    await env.DB.exec(`CREATE VIRTUAL TABLE ${table} USING fts5(chunk_id UNINDEXED, unit_id UNINDEXED, version_id UNINDEXED, document_id UNINDEXED, page_no UNINDEXED, chunk_no UNINDEXED, text, tokenize='${tokenizer}')`);
    const statements: D1PreparedStatement[] = [];
    const VALUES = "(?, ?, ?, ?, ?, ?, ?)";
    for (let at = 0; at < corpus.chunks.length; at += 8) {
      const group = corpus.chunks.slice(at, at + 8);
      const binds: unknown[] = [];
      for (const chunk of group) {
        binds.push(chunk.chunkId, chunk.unitId, chunk.versionId, chunk.documentId, chunk.pageNo, chunk.chunkNo, chunk.text);
      }
      statements.push(
        env.DB.prepare(`INSERT INTO ${table} (chunk_id, unit_id, version_id, document_id, page_no, chunk_no, text) VALUES ${group.map(() => VALUES).join(", ")}`).bind(...binds),
      );
    }
    for (let at = 0; at < statements.length; at += 60) {
      await env.DB.batch(statements.slice(at, at + 60));
    }
  }
}

interface FtsHit {
  chunkId: string;
  unitId: string;
  versionId: string;
  documentId: string;
  pageNo: number;
  chunkNo: number;
  text: string;
  /** bm25 rankの反転（高いほど関連が高い。AuthorizedChunk.scoreと同じ向き） */
  score: number;
}

/** 検索語をFTS5のMATCH式へ組み立てる（語ごとに引用符で括る＝句として一致。FTS構文の注入面を潰す） */
function matchExpression(query: string): string | null {
  const terms = query.trim().split(/\s+/).filter((t) => t.length > 0);
  if (terms.length === 0) return null;
  return terms.map((t) => `"${t.replace(/"/g, '""')}"`).join(" ");
}

/** 1回の検索。unit前置（ACL前置の第1層）はbypassUnitFilterの診断時だけ外す */
async function searchFtsTable(
  env: Pick<AppEnv, "DB">,
  args: { tokenizer: FtsTokenizer; query: string; unitId?: string; topK: number },
): Promise<FtsHit[]> {
  const table = FTS_TABLES[args.tokenizer];
  const match = matchExpression(args.query);
  if (match === null) return [];
  const SELECT = `SELECT chunk_id, unit_id, version_id, document_id, page_no, chunk_no, text, rank FROM ${table} WHERE ${table} MATCH ?`;
  const rows = args.unitId === undefined
    ? (await env.DB.prepare(`${SELECT} ORDER BY rank LIMIT ?`).bind(match, args.topK).all<{
        chunk_id: string; unit_id: string; version_id: string; document_id: string; page_no: number; chunk_no: number; text: string; rank: number;
      }>()).results
    : (await env.DB.prepare(`${SELECT} AND unit_id = ? ORDER BY rank LIMIT ?`).bind(match, args.unitId, args.topK).all<{
        chunk_id: string; unit_id: string; version_id: string; document_id: string; page_no: number; chunk_no: number; text: string; rank: number;
      }>()).results;
  return rows.map((r) => ({
    chunkId: r.chunk_id, unitId: r.unit_id, versionId: r.version_id, documentId: r.document_id,
    pageNo: r.page_no, chunkNo: r.chunk_no, text: r.text, score: -r.rank,
  }));
}

// --- 指標と候補評価 -----------------------------------------------------------------------

export interface TypeRecall {
  found: number;
  total: number;
}
export interface NoEvidenceType {
  /** 検索結果が0件だった（期待どおり根拠無し扱いになった）質問の数 */
  clean: number;
  total: number;
}
export interface RetrievalMetrics {
  topK: number;
  queries: number;
  /** found期待（exact/paraphrase/abbreviation）で正解chunkがtopKに入った率 */
  recallAtK: number;
  recallByType: { exact: TypeRecall; paraphrase: TypeRecall; abbreviation: TypeRecall };
  /** not_found期待（negation/no_evidence/other_unit）の種別ごとの「0件でclean」の数 */
  noEvidenceCleanByType: { negation: NoEvidenceType; no_evidence: NoEvidenceType; other_unit: NoEvidenceType };
  /** 根拠無し扱いのはずの質問で何かを返した数（低いほどよい） */
  unexpectedHitsOnNoEvidence: number;
  /** raw検索結果のうちauthorizedDocumentVersionsが拒否したchunkの数（ACL前置の検証。0であること） */
  unauthorizedChunks: number;
  latencyMs: { p50: number; p95: number };
  /** d1_ftsのみ: tokenizer比較の実測（unicode61は日本語を分かち書きしない） */
  tokenizerComparison?: { unicode61: { recallAtK: number }; trigram: { recallAtK: number } };
}

export interface CandidateEvaluation {
  backend: SearchBackend;
  /** 評価に使った固定datasetのsha256（両候補が同一datasetであることの比較点） */
  datasetHash: string | null;
  /** 実測したときだけ非null（Vectorizeはローカル実測不可のため常にnull＝モックで偽装しない） */
  metrics: RetrievalMetrics | null;
  measuredAt: string | null;
  /** 実測の根拠（試験名・環境） */
  evidence: string | null;
  /** 実測できなかった理由（metrics:nullのときの人間向け説明） */
  notMeasuredReason: string | null;
  /** 実測から導いたconfigの候補（選定関数がそのまま固定configにする） */
  configHint: { tokenizer?: FtsTokenizer; topK?: number; modelId?: string } | null;
}

export interface PerQuestionResult {
  id: string;
  type: RetrievalQuestionType;
  expectedBehavior: "found" | "not_found";
  hitCount: number;
  /** found期待のみ: 正解chunkがtopKに入ったか */
  foundExpected: boolean | null;
}

export interface D1FtsRunOutcome {
  tokenizer: FtsTokenizer;
  metrics: RetrievalMetrics;
  unauthorizedChunks: number;
  rawHitCount: number;
  perQuestion: PerQuestionResult[];
}

export interface D1FtsQueryOptions {
  tokenizer: FtsTokenizer;
  topK: number;
  /** 診断用: unit前置を外して検索する（防御の実証。通常は使わない） */
  bypassUnitFilter?: boolean;
}

/** 固定datasetの全質問をd1_ftsで実行して指標を計算する（両候補の評価と選定後の再実行が使う） */
export async function runD1FtsQueries(
  env: Pick<AppEnv, "DB">,
  p: AuthzPrincipal,
  corpus: EvaluationCorpus,
  questions: readonly RetrievalDatasetQuestion[],
  options: D1FtsQueryOptions,
): Promise<D1FtsRunOutcome> {
  const perQuestion: PerQuestionResult[] = [];
  const latencies: number[] = [];
  const rawHits: FtsHit[] = [];
  for (const question of questions) {
    validateRetrievalInput({ query: question.query, topK: options.topK });
    const startedAt = Date.now();
    const hits = await searchFtsTable(env, {
      tokenizer: options.tokenizer,
      query: question.query,
      unitId: options.bypassUnitFilter ? undefined : p.unitId,
      topK: options.topK,
    });
    latencies.push(Date.now() - startedAt);
    rawHits.push(...hits);
    let foundExpected: boolean | null = null;
    if (question.expected.behavior === "found") {
      const target = corpus.chunkFor(question.expected.docKey!, question.expected.pageNo!, question.expected.snippet!);
      foundExpected = target !== undefined && hits.some((hit) => hit.chunkId === target.chunkId);
    }
    perQuestion.push({
      id: question.id,
      type: question.type,
      expectedBehavior: question.expected.behavior,
      hitCount: hits.length,
      foundExpected,
    });
  }

  // ACL前置の第2層: raw結果の版をauthorizedDocumentVersionsで再検査し、拒否されたchunkを数える
  let unauthorizedChunks = 0;
  const uniqueVersionIds = [...new Set(rawHits.map((hit) => hit.versionId))];
  const authorizedIds = new Set<string>();
  for (let at = 0; at < uniqueVersionIds.length; at += 80) {
    const authorized = await authorizedDocumentVersions(env, p, uniqueVersionIds.slice(at, at + 80));
    for (const version of authorized) authorizedIds.add(version.id);
  }
  for (const hit of rawHits) {
    if (!authorizedIds.has(hit.versionId)) unauthorizedChunks++;
  }

  const sorted = [...latencies].sort((a, b) => a - b);
  const latencyMs = {
    p50: sorted[Math.floor(sorted.length / 2)] ?? 0,
    p95: sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))] ?? 0,
  };
  const typeRecall = (type: RetrievalQuestionType): TypeRecall => {
    const rows = perQuestion.filter((row) => row.type === type);
    return { found: rows.filter((row) => row.foundExpected === true).length, total: rows.length };
  };
  const noEvidenceClean = (type: RetrievalQuestionType): NoEvidenceType => {
    const rows = perQuestion.filter((row) => row.type === type);
    return { clean: rows.filter((row) => row.hitCount === 0).length, total: rows.length };
  };
  const foundRows = perQuestion.filter((row) => row.expectedBehavior === "found");
  const foundTotal = foundRows.length;
  const foundHits = foundRows.filter((row) => row.foundExpected === true).length;
  const noEvidenceRows = perQuestion.filter((row) => row.expectedBehavior === "not_found");
  const metrics: RetrievalMetrics = {
    topK: options.topK,
    queries: perQuestion.length,
    recallAtK: foundTotal === 0 ? 0 : foundHits / foundTotal,
    recallByType: { exact: typeRecall("exact"), paraphrase: typeRecall("paraphrase"), abbreviation: typeRecall("abbreviation") },
    noEvidenceCleanByType: {
      negation: noEvidenceClean("negation"),
      no_evidence: noEvidenceClean("no_evidence"),
      other_unit: noEvidenceClean("other_unit"),
    },
    unexpectedHitsOnNoEvidence: noEvidenceRows.filter((row) => row.hitCount > 0).length,
    unauthorizedChunks,
    latencyMs,
  };
  return { tokenizer: options.tokenizer, metrics, unauthorizedChunks, rawHitCount: rawHits.length, perQuestion };
}

/**
 * d1_fts候補の実測（workerd D1。trigramとunicode61を同じ固定datasetで比較し、測定結果でtokenizerを選ぶ）。
 * buildEvaluationFtsTablesを先に呼んで仮想表を用意しておくこと。
 */
export async function evaluateD1FtsCandidate(
  env: Pick<AppEnv, "DB">,
  p: AuthzPrincipal,
  corpus: EvaluationCorpus,
  dataset: RetrievalDataset,
  datasetHash: string,
): Promise<CandidateEvaluation> {
  const trigram = await runD1FtsQueries(env, p, corpus, dataset.questions, { tokenizer: "trigram", topK: RETRIEVAL_TOPK_DEFAULT });
  const unicode61 = await runD1FtsQueries(env, p, corpus, dataset.questions, { tokenizer: "unicode61", topK: RETRIEVAL_TOPK_DEFAULT });
  const winner: FtsTokenizer = trigram.metrics.recallAtK >= unicode61.metrics.recallAtK ? "trigram" : "unicode61";
  return {
    backend: "d1_fts",
    datasetHash,
    metrics: {
      ...trigram.metrics,
      tokenizerComparison: {
        unicode61: { recallAtK: unicode61.metrics.recallAtK },
        trigram: { recallAtK: trigram.metrics.recallAtK },
      },
    },
    measuredAt: new Date().toISOString(),
    evidence: "tests/retrieval-selection.test.ts の workerd（ローカルD1）実測。docs/evidence/V04-retrieval.md",
    notMeasuredReason: null,
    configHint: { tokenizer: winner, topK: RETRIEVAL_TOPK_DEFAULT },
  };
}

/**
 * Vectorize候補の記録。**実測はしない**（実Cloudflare bindingが必要でローカルworkerdでは実測不可＝
 * プリフライト裁定。モックでembeddingや索引を偽装しない）。実測に必要な手順と再評価の合否基準は
 * docs/evidence/V04-retrieval.mdの「未実施手順」に記録する。
 */
export function vectorizeCandidateRecord(datasetHash: string): CandidateEvaluation {
  return {
    backend: "vectorize",
    datasetHash,
    metrics: null,
    measuredAt: null,
    evidence: null,
    notMeasuredReason:
      "Vectorize索引とWorkers AI embeddingは実Cloudflare bindingが必要で、ローカル（workerd D1）では実測できない。" +
      "実測手順・費用比較・再評価の合否基準はdocs/evidence/V04-retrieval.mdの「未実施手順」に記録。" +
      "実測が完了するまでこの候補は選定できない（根拠の無い選定はselectRetrievalBackendが拒否する）。",
    configHint: null,
  };
}

export interface RetrievalSelection {
  backend: SearchBackend;
  /** 選定結果を固定するconfig（config/search-development.jsonと一致する。T066が実装に使う） */
  config: SearchDevelopmentConfig;
  /** 選ばれた候補の実測（根拠） */
  evidence: CandidateEvaluation;
  rationale: string;
}

/**
 * 証跡ベースの選定。候補は全員が同一の固定datasetで評価されていること、選ぶ候補には実測
 * （metrics・measuredAt・evidence）と unauthorizedChunks===0 があることを要求し、満たさない候補の
 * 選定は例外で拒否する。実測のある候補が複数ならrecallAtKが最大のもの（同点はbackend名順で決定的）。
 */
export function selectRetrievalBackend(candidates: readonly CandidateEvaluation[]): RetrievalSelection {
  if (candidates.length === 0) throw new Error("選定には少なくとも1つの候補が必要です");
  const hashes = new Set(candidates.map((candidate) => candidate.datasetHash));
  if (hashes.size !== 1 || hashes.has(null)) {
    throw new Error("全候補が同一の固定dataset（datasetHash）で評価されている必要があります");
  }
  const measured = candidates.filter(
    (candidate) => candidate.metrics !== null && candidate.measuredAt !== null && candidate.evidence !== null,
  );
  if (measured.length === 0) {
    throw new Error(
      "実測（根拠）の無い候補は選定できません: " +
        candidates.map((candidate) => `${candidate.backend}（${candidate.notMeasuredReason ?? "根拠なし"}）`).join(", "),
    );
  }
  const eligible = measured.filter((candidate) => candidate.metrics!.unauthorizedChunks === 0);
  if (eligible.length === 0) {
    throw new Error("unauthorizedChunksが0でない候補は選定できません（ACL前置の要件）");
  }
  const ranked = [...eligible].sort(
    (a, b) => b.metrics!.recallAtK - a.metrics!.recallAtK || a.backend.localeCompare(b.backend),
  );
  const winner = ranked[0]!;
  const config: SearchDevelopmentConfig =
    winner.backend === "d1_fts"
      ? {
          backend: "d1_fts",
          version: SELECTED_SEARCH_CONFIG_VERSION,
          tokenizer: winner.configHint?.tokenizer ?? "trigram",
          topK: winner.configHint?.topK ?? RETRIEVAL_TOPK_DEFAULT,
        }
      : {
          backend: "vectorize",
          version: SELECTED_SEARCH_CONFIG_VERSION,
          modelId: winner.configHint?.modelId,
        };
  return {
    backend: winner.backend,
    config,
    evidence: winner,
    rationale:
      `固定dataset（sha256=${winner.datasetHash}）の実測で recall@${winner.metrics!.topK}=` +
      `${winner.metrics!.recallAtK.toFixed(3)}・unauthorizedChunks=0。根拠: ${winner.evidence}`,
  };
}
