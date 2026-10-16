import { env } from "cloudflare:workers";
import { applyD1Migrations } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import { localTestAi } from "../src/server/ai/local-fake";
import type { RoleCode } from "../src/server/auth/authorize";
import type { AuthzPrincipal } from "../src/server/auth/principal";
import type { AppEnv } from "../src/server/env";
import type { ApiContext } from "../src/server/http";
import { seedEvaluationCorpus, type EvaluationCorpus } from "../src/server/search/evaluate";
import { parseRetrievalDataset, type RetrievalDataset, type RetrievalDatasetQuestion } from "../src/server/search/dataset";import { answerRag } from "../src/server/search/rag";
import { ragAnswerStates } from "../src/shared/states";
import type { ApiResponse } from "../src/shared/contracts/registry";
import { ragHoldoutJsonl } from "./fixtures/ai/generated-rag-holdout";
import { ROLE_IDS } from "./fixtures/core";
import { createFixture, type Identity, type TestFixture } from "./helpers/fixture";

/**
 * 固定dataset55問の全件回帰（B低3。tests/rag.test.tsの4ケース外挿を機械裏付けにする）。
 *
 * fake RAG（TEST_AI_FAKE相当の決定的応答＝chunk本文の引用だけ。src/server/ai/local-fake.ts）で
 * **55問全件**をanswerRagへ流し、次を数える:
 *  - 根拠あり（exact/paraphrase・unit A・可視）は期待出典付き回答（citationMatchRate===1）
 *  - 根拠なし（negation/no_evidence）・別unit・非公開・略語は全問abstained
 *    （略語は検索語に資料に無い略称を含むためAND一致が0件になる既知の限界＝T065の実測どおり。
 *    recall@5=0.581〔25/43〕の内訳はdocs/evidence/V04-retrieval.md・tests/retrieval-selection.test.ts）
 *  - 権限外（別unit・非公開）のchunk本文は全応答（回答本文・引用span）に現れない
 * 実AIでの品質評価（引用一致100%/漏えい0/捏造0）はtests/live/rag-quality.test.tsと
 * docs/evidence/V04-retrieval.mdの手順（V04の残手順）。
 */

let fx!: TestFixture;
let corpus!: EvaluationCorpus;
let dataset!: RetrievalDataset;
/** 非公開化する文書（正解docKey。exact質問の辞書順最初の1件。決定的に選ぶ） */
let privateDocKey!: string;

const NOW_ISO = "2026-10-16T00:00:00.000Z";
const EXPIRES_ISO = "2027-10-16T00:00:00.000Z";

beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
  fx = await createFixture("two-units");
  dataset = parseRetrievalDataset(ragHoldoutJsonl);
  corpus = await seedEvaluationCorpus(env, dataset, {
    A: fx.units.a.id,
    B: fx.units.b.id,
    ownerA: { userId: fx.units.a.people.admin.userId, memberId: fx.units.a.people.admin.memberId! },
    ownerB: { userId: fx.units.b.people.admin.userId, memberId: fx.units.b.people.admin.memberId! },
  });
  // 本番のFTS仮想表（0028）へ索引行を投入（rag.test.tsと同じ決定的投入）
  await seedFts(corpus.chunks);
  // 1件だけ非公開化する（ACL allow=団員のみ。実行者は管理者なのでallow一致無し＝非公開。
  // ACL行ありで一致無し→非公開＝docs/16 T062の4値判定）
  const firstExact = [...dataset.questions]
    .filter((q) => q.type === "exact" && q.expected.behavior === "found")
    .sort((a, b) => a.id.localeCompare(b.id))[0]!;
  privateDocKey = firstExact.expected.docKey!;
  expect(dataset.documents.find((d) => d.key === privateDocKey)!.unit).toBe("A");
  await env.DB.prepare(
    "INSERT INTO document_acl (id, unit_id, document_id, member_id, role_id, permission, effect, actor_user_id, actor_kind, created_at) VALUES (?, ?, ?, NULL, ?, 'PER-11', 'allow', ?, 'human', ?)",
  ).bind(
    crypto.randomUUID(), fx.units.a.id, corpus.chunks.find((c) => c.docKey === privateDocKey)!.documentId,
    ROLE_IDS.member, fx.units.a.people.admin.userId, NOW_ISO,
  ).run();
}, 300_000);

/** 本番のFTS仮想表（document_chunks_fts・trigram）への投入（rag.test.tsのseedFtsと同じ） */
async function seedFts(chunks: readonly EvaluationCorpus["chunks"][number][]): Promise<void> {
  const statements: D1PreparedStatement[] = [];
  const VALUES = "(?, ?, ?, ?, ?, ?, ?)";
  for (let at = 0; at < chunks.length; at += 8) {
    const group = chunks.slice(at, at + 8);
    const binds: unknown[] = [];
    for (const chunk of group) {
      binds.push(chunk.chunkId, chunk.unitId, chunk.versionId, chunk.documentId, chunk.pageNo, chunk.chunkNo, chunk.text);
    }
    statements.push(
      env.DB.prepare(
        `INSERT INTO document_chunks_fts (chunk_id, unit_id, version_id, document_id, page_no, chunk_no, text) VALUES ${group.map(() => VALUES).join(", ")}`,
      ).bind(...binds),
    );
  }
  for (let at = 0; at < statements.length; at += 60) {
    await env.DB.batch(statements.slice(at, at + 60));
  }
}

/** answerRagへ渡すctx（rag.test.tsと同じ最小構成） */
const ragCtx = (who: Identity, ai: NonNullable<AppEnv["AI"]> | undefined): ApiContext =>
  ({
    env: { ...env, AI: ai },
    req: { header: (name: string) => (name === "x-test-identity" ? JSON.stringify({ userId: who.userId }) : undefined) },
    get: () => "rag-holdout-test",
  }) as unknown as ApiContext;

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

const chunkTextOf = async (chunkId: string) =>
  (await env.DB.prepare("SELECT text FROM document_chunks WHERE id = ?").bind(chunkId).first<{ text: string }>())?.text ?? null;

/** dataset上の正解文書のunit（A=主評価／B=別unit） */
const unitOf = (docKey: string) => dataset.documents.find((d) => d.key === docKey)!.unit;

describe("固定dataset55問の全件回帰 (T067・B低3)", () => {
  it("all_55_questions_answer_with_expected_sources_or_abstain", { timeout: 300_000 }, async () => {
    const admin = fx.units.a.people.admin; // PER-09（AI送信許可）＋PER-11保持者
    const fakeAi = localTestAi({ ...env, TEST_AI_FAKE: "1" })!;
    expect(fakeAi).toBeDefined();

    const expectedChunkOf = (q: RetrievalDatasetQuestion) =>
      corpus.chunkFor(q.expected.docKey!, q.expected.pageNo!, q.expected.snippet!)!;
    // 期待の区分: 根拠あり＝found・正解文書が実行者unit・可視・検索で拾える語彙（exact/paraphrase）。
    // それ以外（not_found・別unit・非公開・略語〔検索0件の既知限界〕）は全問abstained
    const shouldAnswer = (q: RetrievalDatasetQuestion): boolean =>
      q.expected.behavior === "found" &&
      q.expected.docKey !== null &&
      unitOf(q.expected.docKey) === "A" &&
      q.expected.docKey !== privateDocKey &&
      (q.type === "exact" || q.type === "paraphrase");

    expect(dataset.questions.length).toBe(55); // 固定dataset55問全件を流す
    const collectedTexts: string[] = [];
    let answerableCount = 0;
    let matchedCount = 0;
    const sorted = [...dataset.questions].sort((a, b) => a.id.localeCompare(b.id));
    for (const q of sorted) {
      const data: ApiResponse<"API-76"> = await answerRag(ragCtx(admin, fakeAi), { body: { query: q.query } });
      if (shouldAnswer(q)) {
        answerableCount++;
        expect(data.abstained, `${q.id}（${q.type}）は根拠ありの回答になる`).toBe(false);
        expect(data.citations.length, `${q.id} の引用`).toBeGreaterThan(0);
        if (data.citations.some((cit) => cit.chunkId === expectedChunkOf(q).chunkId)) matchedCount++;
        for (const cit of data.citations) {
          const text = (await chunkTextOf(cit.chunkId)) ?? "";
          collectedTexts.push(text.slice(cit.quotedSpan.start, cit.quotedSpan.end));
        }
      } else {
        expect(data.abstained, `${q.id}（${q.type}）は保留になる`).toBe(true);
        expect(data.citations, `${q.id} の引用は0`).toEqual([]);
      }
      collectedTexts.push(data.answer);
    }

    // citationMatchRate === 1（根拠あり全問が期待出典付き回答。全問保留で見かけ上合格にしない）
    expect(answerableCount).toBeGreaterThan(0);
    expect(matchedCount / answerableCount).toBe(1);

    // 権限外chunk本文0: 非公開文書とunit B（別unit）の正解snippetは全応答に現れない
    const forbidden = sorted
      .filter((q) => q.expected.snippet !== null && (q.expected.docKey === privateDocKey || unitOf(q.expected.docKey!) === "B"))
      .map((q) => ({ label: q.id, fragment: q.expected.snippet! }));
    expect(forbidden.length).toBeGreaterThan(0); // 断定条件が空でないことの確認
    const unauthorizedContentCount = collectedTexts.reduce(
      (n, text) => n + forbidden.filter((f) => text.includes(f.fragment)).length,
      0,
    );
    expect(unauthorizedContentCount).toBe(0); // 漏えい0

    // 保存行のstatus語彙はstates.ts（docs/11 §2転記の正本）どおり（D中2）
    const statuses = (
      await env.DB.prepare("SELECT DISTINCT status FROM rag_answers WHERE unit_id = ?").bind(fx.units.a.id).all<{ status: string }>()
    ).results.map((r) => r.status);
    expect(statuses.length).toBeGreaterThan(0);
    for (const status of statuses) expect(ragAnswerStates, `未知のstatus語彙 ${status}`).toContain(status);
    expect(statuses).toContain("answered");
    expect(statuses).toContain("abstained");
  });

  it("regression_summary_is_stable", async () => {
    // datasetの内訳の固定（決定的回帰の前提。生成スクリプトの更新時に意図せず崩さない）
    const byType = new Map<string, number>();
    for (const q of dataset.questions) byType.set(q.type, (byType.get(q.type) ?? 0) + 1);
    expect(Object.fromEntries(byType)).toEqual({
      exact: 15, paraphrase: 10, abbreviation: 10, negation: 6, no_evidence: 6, other_unit: 8,
    });
    // 非公開化の対象はunit Aの1文書（実行者からは見えない状態で全問を流す前提）
    expect(privateDocKey).toMatch(/^d\d{3}$/);
    expect(unitOf(privateDocKey)).toBe("A");
  });
});
