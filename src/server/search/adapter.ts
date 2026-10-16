import type { AuthzPrincipal } from "../auth/principal";
import type { AppEnv } from "../env";
import { authorizedDocumentVersions } from "../documents/authorized";
import { FTS_TABLE } from "../jobs/handlers/document-index";
import {
  RETRIEVAL_TOPK_DEFAULT,
  parseSearchConfig,
  type AuthorizedChunk,
  type RetrievalInput,
  type RetrievalPort,
  type SearchConfig,
  type SearchDevelopmentConfig,
  validateRetrievalInput,
} from "./port";
import searchDevelopmentConfigJson from "../../../config/search-development.json";

/**
 * 選定した検索backendの本番経路（T066、docs/06 §5、docs/10 §4、docs/16 T065/T066）。
 * T065が選定した d1_fts（FTS5・trigram・drizzle/0028_search_index.sql）を
 * config/search-development.json（version=search-dev-v1）のとおりに接続する。
 *
 * 三重防御のうち検索側の2層（docs/10 §4「検索前フィルター＋生成前再検査」。3層目の引用取得時
 * 再検査はT067の原文取得経路）:
 *  ①検索SQLの前提条件: unit一致（principalの所属）＋ v.status='approved'（承認済み）＋
 *    d.status<>'withdrawn'（撤回除外）＋ c.index_status='indexed'（chunks側が正本。docs/16 T066
 *    プリフライト裁定4）＋ FTS行とchunks行の対応（c.id=f.chunk_id）。**索引が遅れても（deindex job
 *    より先に検索しても）このSQLが撤回・失効版を落とす**（docs/06 §5.5「D1側で即除外」）。
 *  ②hit後の再検査: 必ず authorizedDocumentVersions（src/server/documents/authorized.ts＝単一の正本）
 *    で現ACL・現承認版に突き合わせ、通った版のchunkだけを返す（topKは上限50＜80なので1回で足りる）。
 *  ③戻すのは②を通ったchunkだけ（非可視資料のスニペットをLLMへ渡さない＝docs/10 §3）。
 *
 * MATCH式は語ごとに二重引用符で括る（FTS5構文の注入面を潰す。T065のsearchFtsTableと同じ組立て）。
 * trigramは3字以上の語が部分一致する（2字語は一致しない＝T065実測の正直な限界。query構築は
 * 3字以上の語で行うこと＝T067への引継ぎ）。
 */

/** FTS行＋chunks結合の検索結果行（chunk本文・所在はchunks側の正本から返す） */
interface FtsJoinedRow {
  chunk_id: string; version_id: string; document_id: string;
  chunk_no: number; page_no: number | null; section: string | null; text: string; rank: number;
}

/** 検索語をFTS5のMATCH式へ組み立てる（語ごとに引用符で括る。空はnull＝0件として扱う） */
export function matchExpression(query: string): string | null {
  const terms = query.trim().split(/\s+/).filter((t) => t.length > 0);
  if (terms.length === 0) return null;
  return terms.map((t) => `"${t.replace(/"/g, '""')}"`).join(" ");
}

/**
 * 固定config（config/search-development.json。T065選定）の読み込み。
 * 静的importでbundleに埋め込む（帳票様式manifestと同じ方式。docs/04 §3.5末尾）。
 * 未知backend・空version・未知キーはparseSearchConfigが拒否する（起動時に落ちる＝fail-closed）。
 */
export const SEARCH_CONFIG: SearchDevelopmentConfig = parseFixedConfig(searchDevelopmentConfigJson);

function parseFixedConfig(json: unknown): SearchDevelopmentConfig {
  const parsed = parseSearchConfig(json);
  // 本番DDL（drizzle/0028_search_index.sql）はtrigramで作成済み。違うtokenizerのconfigは
  // 再評価（DDL＋全文書の再索引）なしには使えないため起動時に落とす
  if (parsed.tokenizer !== undefined && parsed.tokenizer !== "trigram") {
    throw new Error(`SearchConfig: 本番のFTS仮想表はtrigramで作成済みのため tokenizer=${parsed.tokenizer} は使えません（再評価とDDL改訂で対応）`);
  }
  return parsed;
}

/**
 * 検索portの実装を作る（ブリーフのInterface）。configのbackendはd1_ftsのみ対応
 * （vectorizeは実Cloudflare実測が未実施＝D16/V04の残手順。実測なしに実装を偽装しないため例外）。
 */
export function createRetrievalPort(env: AppEnv, config: SearchConfig): RetrievalPort {
  if (config.backend !== "d1_fts") {
    throw new Error(
      `SearchConfig: backend=${config.backend} は本番未実装です（実Cloudflareでの実測比較が完了するまで d1_fts のみ。docs/evidence/V04-retrieval.md）`,
    );
  }
  const devConfig = config as SearchDevelopmentConfig;
  const defaultTopK = devConfig.topK ?? RETRIEVAL_TOPK_DEFAULT;

  return {
    async search(p: AuthzPrincipal, input: RetrievalInput): Promise<AuthorizedChunk[]> {
      validateRetrievalInput(input);
      const topK = input.topK ?? defaultTopK;
      const match = matchExpression(input.query);
      if (match === null) return []; // 空クエリ（空白のみ）は0件。FTS MATCHに渡さない

      // ①検索SQLの前提条件（unit一致・承認済み・非withdrawn・indexed・行対応）。
      // 索引の更新が遅れていても、この条件が撤回・失権・未索引のchunkを落とす
      const documentFilter = input.documentIds && input.documentIds.length > 0
        ? ` AND ${FTS_TABLE}.document_id IN (${input.documentIds.map(() => "?").join(",")})`
        : "";
      const rows = (
        await env.DB.prepare(
          `SELECT ${FTS_TABLE}.chunk_id AS chunk_id, ${FTS_TABLE}.version_id AS version_id, v.document_id AS document_id, ` +
            "c.chunk_no AS chunk_no, c.page_no AS page_no, c.section AS section, c.text AS text, " +
            `${FTS_TABLE}.rank AS rank ` +
            `FROM ${FTS_TABLE} ` +
            "JOIN document_chunks c ON c.unit_id = " + FTS_TABLE + ".unit_id AND c.id = " + FTS_TABLE + ".chunk_id " +
            "AND c.version_id = " + FTS_TABLE + ".version_id AND c.index_status = 'indexed' " +
            "JOIN document_versions v ON v.unit_id = " + FTS_TABLE + ".unit_id AND v.id = " + FTS_TABLE + ".version_id " +
            "AND v.status = 'approved' " +
            "JOIN documents d ON d.unit_id = v.unit_id AND d.id = v.document_id AND d.status <> 'withdrawn' " +
            `WHERE ${FTS_TABLE} MATCH ? AND ${FTS_TABLE}.unit_id = ?` +
            documentFilter +
            ` ORDER BY ${FTS_TABLE}.rank LIMIT ?`,
        ).bind(match, p.unitId, ...(input.documentIds && input.documentIds.length > 0 ? input.documentIds : []), topK)
          .all<FtsJoinedRow>()
      ).results;

      // ②hit後の再検査（必ずauthorizedDocumentVersions。単一の正本に集約）
      const hitVersionIds = [...new Set(rows.map((r) => r.version_id))];
      const authorized = await authorizedDocumentVersions(env, p, hitVersionIds);
      const authorizedVersionIds = new Set(authorized.map((v) => v.id));

      // ③戻すのは承認済み・可視のchunkだけ（bm25 rankは低いほど良いため反転してscore化）
      return rows
        .filter((r) => authorizedVersionIds.has(r.version_id))
        .map((r) => ({
          chunkId: r.chunk_id,
          versionId: r.version_id,
          documentId: r.document_id,
          chunkNo: r.chunk_no,
          pageNo: r.page_no,
          section: r.section,
          text: r.text,
          score: -r.rank,
        }));
    },
  };
}
