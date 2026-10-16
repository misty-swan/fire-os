import { env } from "cloudflare:workers";
import { applyD1Migrations } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import type { RoleCode } from "../src/server/auth/authorize";
import type { AuthzPrincipal } from "../src/server/auth/principal";
import {
  buildEvaluationFtsTables,
  evaluateD1FtsCandidate,
  runD1FtsQueries,
  seedEvaluationCorpus,
  selectRetrievalBackend,
  sha256Hex,
  vectorizeCandidateRecord,
} from "../src/server/search/evaluate";
import { parseRetrievalDataset, type RetrievalQuestionType } from "../src/server/search/dataset";
import { parseSearchConfig } from "../src/server/search/port";
import { ragHoldoutJsonl as runtimeRagHoldoutJsonl } from "../src/server/search/dataset/rag-holdout";
import searchDevelopmentConfigJson from "../config/search-development.json";
import { ragHoldoutJsonl } from "./fixtures/ai/generated-rag-holdout";
import { createFixture, type Identity, type TestFixture } from "./helpers/fixture";

/**
 * 検索方式の選定基盤（T065、docs/06 §5、docs/14 D16、docs/16 T065、docs/evidence/V04-retrieval.md）。
 *
 * - **選定試験が検証するのは機構**: ①両候補（d1_fts／vectorize）が同一の固定dataset hashで評価されること
 *   ②選定結果の unauthorizedChunks===0（ACL前置。docs/10 §3「検索スニペットは許可された元行だけから算出」）
 *   ③選定configのversionが記録されること ④根拠（実測）の無い候補の選定は拒否されること。
 * - **ローカル（workerd D1）で実測できるのは d1_fts のみ**（FTS5は実workerd D1で動く＝本試験が常時実測する）。
 *   Vectorize候補は実Cloudflare bindingが必要でローカル実測不可＝実測欠如のため選定不可（選定関数が拒否し、
 *   選定は実測のある d1_fts になる）。Vectorizeとの実測比較はdocs/evidence/V04-retrieval.mdの未実施手順。
 * - 固定datasetは決定的生成スクリプト（scripts/generate-retrieval-dataset.ts）と生成TSモジュールの
 *   二重管理（T061と同じ流儀）。資料100×20頁相当・RAG質問55件・質問種別6種を含み、正解根拠（chunk特定）
 *   と期待挙動（found/not_found）を人手ラベルとして持つ（すべて架空データ）。
 * - 索引/検索の実装本体はT066（本タスクは選定configを決めるまで。unicode61は日本語を分かち書きしない
 *   ことをtrigramとの実測比較で記録する）。
 */

let fx: TestFixture;
beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
  fx = await createFixture("two-units");
  const dataset = parseRetrievalDataset(ragHoldoutJsonl);
  corpus = await seedEvaluationCorpus(env, dataset, {
    A: fx.units.a.id,
    B: fx.units.b.id,
    ownerA: { userId: fx.units.a.people.admin.userId, memberId: fx.units.a.people.admin.memberId! },
    ownerB: { userId: fx.units.b.people.admin.userId, memberId: fx.units.b.people.admin.memberId! },
  });
  await buildEvaluationFtsTables(env, corpus);
});

let corpus: Awaited<ReturnType<typeof seedEvaluationCorpus>>;

/** 生成物の固定hash（生成スクリプトやseedを変えたら意図として更新する。再現性の保証） */
const RETRIEVAL_DATASET_SHA256 = "808631d64ea1f4ce89598a5d519b5ed0383bd38a9b00975d462f004b700bc860";

/** 質問種別ごとの最低件数（docs/16 T065「完全一致/言い換え/略語/否定/根拠なし/別unit」を含む） */
const TYPE_FLOORS: Record<RetrievalQuestionType, number> = {
  exact: 15,
  paraphrase: 10,
  abbreviation: 10,
  negation: 6,
  no_evidence: 6,
  other_unit: 8,
};
const FOUND_EXPECTED_TYPES: readonly RetrievalQuestionType[] = ["exact", "paraphrase", "abbreviation"];

/** authorizedDocumentVersionsへ渡す主体（document-extract.test.tsと同じ試験用の最小構成） */
const principalOf = (who: Identity): AuthzPrincipal => ({
  userId: who.userId,
  memberId: who.memberId ?? "",
  unitId: who.unitId,
  authzVersion: 1,
  roles: (who.roleCode ? [who.roleCode] : []) as RoleCode[],
  scopes: [],
  displayName: "試験主体",
  rank: null,
  unitName: "試験分団",
  mfaEnabled: true,
});

describe("検索方式の選定基盤 (T065)", () => {
  it("retrieval_selection_requires_same_fixed_dataset_and_acl", { timeout: 300_000 }, async () => {
    // === 固定dataset（コミット済みjsonl＝生成TSモジュール＝sha256記録値。二重管理の一致） ===
    const fixedHash = await sha256Hex(ragHoldoutJsonl);
    expect(fixedHash).toBe(RETRIEVAL_DATASET_SHA256);
    expect(runtimeRagHoldoutJsonl).toBe(ragHoldoutJsonl); // src側の生成モジュールも同一（手で編集したら落ちる）

    const dataset = parseRetrievalDataset(ragHoldoutJsonl);
    // 資料100×20頁相当（docs/16 T065の入力要件）
    expect(dataset.documents.length).toBe(100);
    expect(new Set(dataset.documents.map((d) => d.key)).size).toBe(100);
    for (const doc of dataset.documents) {
      expect(doc.pages.length).toBe(20);
      expect(doc.pages.every((p) => p.length > 0)).toBe(true);
    }
    expect(dataset.documents.filter((d) => d.unit === "A").length).toBe(80); // 主評価unit
    expect(dataset.documents.filter((d) => d.unit === "B").length).toBe(20); // 別unit（漏えい検証の distractor）
    // RAG質問50件以上・質問種別6種・正解根拠（chunk特定）と期待挙動の人手ラベル
    expect(dataset.questions.length).toBeGreaterThanOrEqual(50);
    for (const type of Object.keys(TYPE_FLOORS) as RetrievalQuestionType[]) {
      const rows = dataset.questions.filter((q) => q.type === type);
      expect(rows.length, `${type}の質問数`).toBeGreaterThanOrEqual(TYPE_FLOORS[type]);
    }
    const pageTextOf = (docKey: string, pageNo: number): string => {
      const doc = dataset.documents.find((d) => d.key === docKey);
      expect(doc).toBeDefined();
      return doc!.pages[pageNo - 1]!;
    };
    for (const q of dataset.questions) {
      expect(q.query.length).toBeGreaterThan(0);
      if (q.expected.behavior === "found") {
        expect([...FOUND_EXPECTED_TYPES, "other_unit" as const]).toContain(q.type);
        expect(q.expected.docKey).not.toBeNull();
        expect(q.expected.pageNo).not.toBeNull();
        expect(q.expected.snippet).not.toBeNull();
        // 正解根拠のラベルは実在の位置を指す（snippetはその頁のテキストに含まれ、正解chunkを特定できる）
        const pageText = pageTextOf(q.expected.docKey!, q.expected.pageNo!);
        expect(pageText.includes(q.expected.snippet!)).toBe(true);
        expect(corpus.chunkFor(q.expected.docKey!, q.expected.pageNo!, q.expected.snippet!)).toBeDefined();
        if (q.type === "other_unit") {
          expect(dataset.documents.find((d) => d.key === q.expected.docKey)!.unit).toBe("B");
        } else {
          expect(dataset.documents.find((d) => d.key === q.expected.docKey)!.unit).toBe("A");
        }
      } else {
        expect(q.expected.behavior).toBe("not_found");
      }
    }
    // 正解根拠のsnippetはcorpus中で一意（別文書・別頁の誤特定を防ぐラベル品質の保証）
    const allPageText = dataset.documents.flatMap((d) => d.pages.map((p) => ({ key: d.key, text: p })));
    for (const snippet of dataset.questions.filter((q) => q.expected.snippet).map((q) => q.expected.snippet!)) {
      const hits = allPageText.filter((p) => p.text.includes(snippet));
      expect(hits.length, `snippetの一意性: ${snippet.slice(0, 18)}…`).toBe(1);
    }

    // === 両候補を同一の固定datasetで比較（d1_ftsはローカル実測、vectorizeは実測欠如） ===
    const p = principalOf(fx.units.a.people.admin);
    const d1Fts = await evaluateD1FtsCandidate(env, p, corpus, dataset, fixedHash);
    const vectorize = vectorizeCandidateRecord(fixedHash);
    const comparedDatasetHashes = [d1Fts.datasetHash, vectorize.datasetHash];
    expect(comparedDatasetHashes).toEqual([fixedHash, fixedHash]); // ブリーフのassertion（同一固定dataset）
    expect(d1Fts.metrics).not.toBeNull();
    expect(d1Fts.evidence).not.toBeNull();
    expect(d1Fts.measuredAt).not.toBeNull();
    // Vectorize候補は実測が存在しない（モックで実測を偽装しない）
    expect(vectorize.metrics).toBeNull();
    expect(vectorize.measuredAt).toBeNull();
    expect(vectorize.notMeasuredReason).not.toBeNull();

    // 実測の内容（tokenizer比較。unicode61は日本語を分かち書きしない＝trigramが上回る）
    expect(d1Fts.metrics!.tokenizerComparison!.trigram.recallAtK).toBeGreaterThan(
      d1Fts.metrics!.tokenizerComparison!.unicode61.recallAtK,
    );
    expect(d1Fts.metrics!.tokenizerComparison!.unicode61.recallAtK).toBe(0); // 日本語部分一致は分かち書き無しでは拾えない
    expect(d1Fts.configHint!.tokenizer).toBe("trigram");
    // 完全一致はtrigramで拾える（固定dataset上の最低品質。数値は決定的）
    expect(d1Fts.metrics!.recallByType.exact.found).toBe(d1Fts.metrics!.recallByType.exact.total);
    // 略語は語彙が資料に無いためキーワード検索では拾えない（正直な限界の記録。Vectorize比較の動機）
    expect(d1Fts.metrics!.recallByType.abbreviation.found).toBe(0);
    // 否定・根拠なし・別unitは期待どおり根拠無し扱い（ヒットを作らない）
    expect(d1Fts.metrics!.unexpectedHitsOnNoEvidence).toBe(0);
    expect(d1Fts.metrics!.noEvidenceCleanByType.other_unit.total).toBeGreaterThanOrEqual(TYPE_FLOORS.other_unit);
    // 選定評価の検索（ACL前置つき）では権限外chunkは1件も現れない
    expect(d1Fts.metrics!.unauthorizedChunks).toBe(0);

    // === 根拠（実測）の無い候補の選定は拒否される ===
    let missingEvidenceSelectionRejected = false;
    try {
      selectRetrievalBackend([vectorize]);
    } catch {
      missingEvidenceSelectionRejected = true;
    }
    expect(missingEvidenceSelectionRejected).toBe(true); // ブリーフのassertion

    // === 実測のある候補での選定（d1_fts＋trigramが選ばれる） ===
    const selection = selectRetrievalBackend([d1Fts, vectorize]);
    expect(selection.backend).toBe("d1_fts");
    const selectedConfig = selection.config;
    expect(selectedConfig.version).not.toBe(""); // ブリーフのassertion（versionの記録）
    expect(selectedConfig.backend).toBe("d1_fts");
    expect(selectedConfig.tokenizer).toBe("trigram");
    expect(selectedConfig.topK).toBeGreaterThanOrEqual(1);
    expect(selection.evidence.evidence).not.toBeNull(); // 選定には実測の根拠が付く

    // === 選定configでの検索を重ねて実行し、ACL前置を再検証（ブリーフのassertion） ===
    const selectedResult = await runD1FtsQueries(env, p, corpus, dataset.questions, {
      tokenizer: selectedConfig.tokenizer!,
      topK: selectedConfig.topK!,
    });
    expect(selectedResult.unauthorizedChunks).toBe(0);
    expect(selectedResult.metrics.recallAtK).toBe(d1Fts.metrics!.recallAtK); // 同一条件で再現する

    // --- 防御の実証: unit前置を外すと別unitのchunkがraw結果に現れ、authorizedDocumentVersionsの
    //     再検査がそれを拒否する（docs/06 §5.5「索引削除が遅れてもD1再検査で漏らさない」の構造確認） ---
    const unfiltered = await runD1FtsQueries(env, p, corpus, dataset.questions, {
      tokenizer: selectedConfig.tokenizer!,
      topK: selectedConfig.topK!,
      bypassUnitFilter: true,
    });
    expect(unfiltered.unauthorizedChunks).toBeGreaterThan(0);
    // unfilteredでは別unit質問の正解chunkがraw結果に現れる（TYPE_FLOORS.other_unit件すべて）
    expect(
      unfiltered.perQuestion.filter((row) => row.type === "other_unit").every((row) => row.hitCount > 0),
    ).toBe(true);
    // 一方、scoped（ACL前置つき）の選定評価では別unit質問はすべて0件でclean
    expect(selectedResult.metrics.noEvidenceCleanByType.other_unit).toEqual({
      clean: TYPE_FLOORS.other_unit,
      total: TYPE_FLOORS.other_unit,
    });

    // === config/search-development.json（選定結果の固定config）の読み込み検証 ===
    const parsedConfig = parseSearchConfig(searchDevelopmentConfigJson);
    expect(parsedConfig.backend).toBe(selection.backend);
    expect(parsedConfig.version).toBe(selectedConfig.version);
    expect(parsedConfig.tokenizer).toBe(selectedConfig.tokenizer);
    expect(parsedConfig.topK).toBe(selectedConfig.topK);
    // ローダーは未知backend・空versionを拒否する（docs/05 §1「列挙外を拒否」）
    expect(() => parseSearchConfig({ ...searchDevelopmentConfigJson, backend: "elasticsearch" })).toThrow();
    expect(() => parseSearchConfig({ ...searchDevelopmentConfigJson, backend: 42 })).toThrow();
    expect(() => parseSearchConfig({ ...searchDevelopmentConfigJson, version: "" })).toThrow();
    expect(() => parseSearchConfig({ ...searchDevelopmentConfigJson, version: null })).toThrow();
    expect(() => parseSearchConfig({ ...searchDevelopmentConfigJson, unknownKey: true })).toThrow();
    // 固定configの記録datasetも同一であること（選定の根拠とconfigの対応）
    expect(searchDevelopmentConfigJson.datasetHash).toBe(fixedHash);
  });
});
