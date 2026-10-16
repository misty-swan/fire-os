import { env } from "cloudflare:workers";
import { applyD1Migrations } from "cloudflare:test";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { AiEvaluation } from "../src/shared/contracts/ai";
import type { AppEnv } from "../src/server/env";
import { runDueJobs } from "../src/server/jobs/runner";
import "../src/server/jobs/handlers/classification"; // 分類job handlerの登録（Cron/Queueと同じ登録点）
import { createFixture, type Identity, type TestFixture } from "./helpers/fixture";

/**
 * Jev分類（T053、docs/06 §2/§3、docs/14 D12、docs/11 AI提案・永続ジョブ）。
 * 実Workers AI（env.AI）はローカルに無いため、試験ではJevの戻り値形を模倣するfakeを
 * env.AIへ注入し、**サーバー側の検証ロジック**（noul範囲・未知キー拒否・壊れ出力で
 * manual_review・usage保存等）を検証する。実呼出し・モデル版固定・日本語品質はV04の
 * 未実施手順として docs/evidence/V04-jev.md に記録する。
 */

let fx: TestFixture;

beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
  fx = await createFixture("two-units");
});

beforeEach(async () => {
  // 他の試験のjobを拾わないよう、未完了のjobを全て取消す（jobs.test.tsと同じ流儀）
  await env.DB.prepare(
    "UPDATE jobs SET status = 'cancelled', lease_token = NULL, lease_until = NULL WHERE status IN ('queued', 'running', 'retry_wait')",
  ).run();
  // jobの受付時刻（next_attempt_at）はenqueueJobの既定＝実時刻で記録されるため、runner用の
  // 固定クロックは実時刻より先に置く（固定日付のままでは実時刻がその日時を追い越した以降、
  // jobが永遠に未到来になりrunDueJobsが何もleaseしなくなる。2026-10-16T00:00Z固定で発生）
  fx.clock.set(new Date(Date.now() + 3_600_000).toISOString()); // 実時刻+1時間
});

const idem = () => ({ "idempotency-key": crypto.randomUUID() });
const json = async (r: Response) => (await r.json()) as {
  data?: unknown;
  error?: { code: string; details?: { field: string; reason: string }[] };
  meta?: { requestId: string; nextCursor?: string };
};

// --- 送信条件（D12）: 質問はサーバー固定（docs/06 §2の例そのもの）。テスト側で勝手に作れないことを見る ---
const FIXED_QUESTIONS = {
  category: {
    type: "choice",
    instructions: "報告の代表分類を選ぶ",
    criteria: { equipment_issue: "設備の問題", access_obstruction: "接近障害", missing_equipment: "収納物不足", no_issue: "異常報告なし", other: "その他" },
  },
  needs_check: {
    type: "noul",
    instructions: "追加確認が必要という記述があるか",
    criteria: { true: "未確認・曖昧・確認依頼", false: "追加確認の記述なし" },
  },
};

interface JevCall {
  model: string;
  input: { state?: unknown; questions?: unknown };
}

/** Jevの戻り値形を模倣するfake（試験内でenv.AIへ注入。呼出しを記録する） */
const fakeAi = (respond: (call: JevCall, index: number) => unknown, calls: JevCall[] = []): NonNullable<AppEnv["AI"]> =>
  ({
    run: async (model: string, input: { state: unknown; questions: unknown }) => {
      calls.push({ model, input });
      return respond({ model, input }, calls.length - 1);
    },
  }) as unknown as NonNullable<AppEnv["AI"]>;

/** fake AI（または無し＝localと同じ）で待機中のjobを実行する */
const runJobsWithAi = async (ai: NonNullable<AppEnv["AI"]> | undefined) => runDueJobs({ ...env, AI: ai } as typeof env, { clock: fx.clock });

const postClassification = async (who: Identity, body: Record<string, unknown>) =>
  fx.client(who).request("POST", "/api/v1/ai/classifications", body, idem());

const getJob = async (jobId: string) =>
  (await env.DB.prepare("SELECT id, status, attempts, error_code, result_ref, source_type, source_id, source_version, config_version FROM jobs WHERE id = ?")
    .bind(jobId).first<{ id: string; status: string; attempts: number; error_code: string | null; result_ref: string | null; source_type: string; source_id: string; source_version: number; config_version: string }>())!;

const getEvaluation = async (jobId: string) =>
  env.DB.prepare("SELECT * FROM ai_evaluations WHERE job_id = ?").bind(jobId)
    .first<{ id: string; unit_id: string; job_id: string; source_type: string; source_id: string; source_version: number; input_hash: string; input_snapshot_ref: string | null; question_version: string; model_id: string; actual_model_version: string | null; output_json: string; status: string; usage_json: string | null }>();

/** AI処理の前後で設備・資産・異常の行が変わらないことの物差し（AIだけでは状態を変えない） */
const assetSnapshot = async () => ({
  facilities: await env.DB.prepare("SELECT id, verification_status, location_version, metadata, version, updated_at FROM facilities ORDER BY id").all(),
  vehicles: await env.DB.prepare("SELECT id, status, archived_at, version, updated_at FROM vehicles ORDER BY id").all(),
  equipment: await env.DB.prepare("SELECT id, status, archived_at, version, updated_at FROM equipment ORDER BY id").all(),
});
const rowDiffCount = (
  before: { facilities: { results: unknown[] }; vehicles: { results: unknown[] }; equipment: { results: unknown[] } },
  after: { facilities: { results: unknown[] }; vehicles: { results: unknown[] }; equipment: { results: unknown[] } },
) => {
  let diff = 0;
  for (const key of ["facilities", "vehicles", "equipment"] as const) {
    const a = before[key].results;
    const b = after[key].results;
    for (let i = 0; i < Math.max(a.length, b.length); i++) {
      if (JSON.stringify(a[i]) !== JSON.stringify(b[i])) diff++;
    }
  }
  return diff;
};

// --- 源データの用意（既存の経路だけを使う。T029〜T032と同じ作り方） ---

const seedFacility = async (unitId: string, by: string): Promise<string> => {
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  await env.DB.prepare(
    "INSERT INTO facilities (id, unit_id, type, management_number, latitude, longitude, location_note, location_source, created_at, updated_at, created_by, actor_kind) VALUES (?, ?, 'hydrant', ?, 35, 139, 'x', '架空台帳', ?, ?, ?, 'human')",
  ).bind(id, unitId, `F-${id.slice(0, 6)}`, now, now, by).run();
  return id;
};

/** 承認済みの施設点検様式（T027/T030の経路。検証設定どおりの架空schema） */
const seedFacilityTemplate = async (admin: Identity): Promise<string> => {
  const itemSchema = [
    { code: "exterior", label: "本体の外観", valueType: "select", required: true, allowedResults: ["ok", "needs_review"] },
    { code: "ground", label: "周辺の環境", valueType: "boolean", required: false },
  ];
  const res = await fx.client(admin).request("POST", "/api/v1/inspection-templates", { name: `様式${crypto.randomUUID().slice(0, 6)}`, targetType: "facility", itemSchema }, idem());
  const data = ((await res.json()) as { data?: { id: string; versions: { id: string }[] } }).data!;
  await fx.client(admin).request("POST", `/api/v1/inspection-templates/${data.id}/decision`, { version: 1, templateVersionId: data.versions[0]!.id, decision: "request_review", reason: "確認" }, idem());
  await fx.client(admin).request("POST", `/api/v1/inspection-templates/${data.id}/decision`, { version: 2, templateVersionId: data.versions[0]!.id, decision: "approve", reason: "確認した" }, idem());
  return data.versions[0]!.id;
};

const createInspection = async (
  admin: Identity, facilityId: string, templateVersionId: string, overrides: Record<string, unknown> = {},
): Promise<{ id: string; seriesVersion: number; note: string }> => {
  const input = {
    templateVersionId,
    inspectedAt: "2026-10-15T02:00:00.000Z",
    inspectorMemberId: admin.memberId!,
    result: "ok",
    checkItems: [{ code: "exterior", result: "ok" }],
    note: "自動試験の点検記録",
    createIssue: false,
    attachmentIds: [],
    ...overrides,
  };
  const res = await fx.client(admin).request("POST", `/api/v1/facilities/${facilityId}/inspections`, input, idem());
  expect(res.status, "点検の作成に失敗").toBe(201);
  const data = ((await json(res)).data!) as { id: string; seriesVersion: number };
  return { id: data.id, seriesVersion: data.seriesVersion, note: input.note as string };
};

const createIssue = async (who: Identity, title: string, description = "格納箱の前に資材が置かれていた（架空）"): Promise<string> => {
  const facilityId = await seedFacility(who.unitId, who.userId!);
  const res = await fx.client(who).request("POST", "/api/v1/issues", { target: { type: "facility", id: facilityId }, title, description, attachmentIds: [] }, idem());
  expect(res.status, "異常の起票に失敗").toBe(201);
  return (((await json(res)).data!) as { id: string }).id;
};

describe("Jev分類 (T053)", () => {
  it("jev_noul_value_is_not_a_confidence_field", async () => {
    const a = fx.units.a;
    const admin = a.people.admin;
    const templateVersionId = await seedFacilityTemplate(admin);
    const facilityId = await seedFacility(a.id, admin.userId!);
    // 「分からない」系の曖昧原文（docs/06 §6のsmoke例と同じ系列の架空文）
    const inspection = await createInspection(admin, facilityId, templateVersionId, { note: "分からない（架空の曖昧記述）", result: "unknown" });

    // 送信条件（D12）: 設備・資産の状態をAI処理が変えないことの比較対象
    const before = await assetSnapshot();

    const res = await postClassification(admin, { sourceType: "facility_inspection", sourceId: inspection.id, sourceVersion: inspection.seriesVersion, questionVersion: "v1" });
    expect(res.status).toBe(202); // 202は受付であり完了ではない（docs/05 §1）
    const job = ((await json(res)).data!) as { id: string; status: string };
    expect(job.status).toBe("queued");

    // 曖昧原文への応答を模倣: 代表分類はno_issue、confidenceは高め、しかしnoul（保留度）も高い。
    // confidence(0.99)を根拠に保留を省略してはいけない（docs/06「confidenceを…正答保証と表示しない」）
    const calls: JevCall[] = [];
    const summary = await runJobsWithAi(fakeAi(() => ({
      model: "jev-fake@2026-10-16",
      answers: {
        category: { choice: "no_issue", probabilities: { no_issue: 0.55, other: 0.45 }, confidence: 0.99 },
        needs_check: { noul: 0.9 },
      },
      usage: { prompt_tokens: 120, completion_tokens: 8 },
    }), calls));
    expect(summary.committed).toBe(1);

    const jobRow = await getJob(job.id);
    expect(jobRow.status).toBe("succeeded");

    // 固定質問をそのまま送る（state=最小化input、questions=サーバー固定）
    expect(calls).toHaveLength(1);
    expect(calls[0]!.model).toBe("typesafe/jev");
    expect(calls[0]!.input.questions).toEqual(FIXED_QUESTIONS);

    // 最小化input（D12）: 点検のnote＋項目コード等のみ。氏名・連絡先を含まない
    const state = calls[0]!.input.state as { note?: string; items?: { code: string; result: string }[] };
    expect(Object.keys(state).sort()).toEqual(["items", "note"]);
    expect(state.note).toBe("分からない（架空の曖昧記述）");
    expect(state.items).toEqual([{ code: "exterior", result: "ok" }]);
    const sent = JSON.stringify(state);
    expect(sent).not.toContain("架空 管理者"); // 氏名
    expect(sent).not.toContain(admin.memberId!); // 実行者のIDも不要（最小化）

    const ev = (await getEvaluation(job.id))!;
    const candidate = JSON.parse(ev.output_json) as {
      categories: { representative: string; probabilities: Record<string, number> | null; multipleIssues: boolean };
      needsReview: number;
      model: string;
      questionVersion: string;
      sourceVersion: number;
      usage: { promptTokens: number; completionTokens: number } | null;
      answers: Record<string, unknown>;
    };

    // noulは0〜1の保留度。booleanでもconfidenceでもない（docs/06 §2）
    const noulNeedsReview = candidate.needsReview;
    expect(noulNeedsReview).toBeGreaterThanOrEqual(0);
    expect(noulNeedsReview).toBeLessThanOrEqual(1);
    expect(noulNeedsReview).toBe(0.9); // noulそのもの

    // confidenceフィールドを作って保留判定に使っていない（noul=0.9の源であって0.99の源ではない）
    const inventedConfidenceFieldUsed =
      "confidence" in candidate ||
      candidate.needsReview === 0.99 ||
      typeof candidate.needsReview !== "number";
    expect(inventedConfidenceFieldUsed).toBe(false);

    // 保留（noul=0.9）は保留として保存され、no_issue/otherへ潰されない（docs/06「needs_manual_reviewはアプリ側保留状態」）
    expect(ev.status).toBe("pending"); // 人の承認待ち。AI出力は最終事実ではない
    expect(candidate.categories.representative).toBe("no_issue");

    // 実モデル版・質問版・元版・usageを保存する（docs/06 §3）
    expect(ev.model_id).toBe("typesafe/jev");
    expect(ev.actual_model_version).toBe("jev-fake@2026-10-16");
    expect(ev.question_version).toBe("v1");
    expect(ev.source_version).toBe(inspection.seriesVersion);
    expect(candidate.usage).toEqual({ promptTokens: 120, completionTokens: 8 });
    expect(JSON.parse(ev.usage_json!)).toEqual({ promptTokens: 120, completionTokens: 8 });
    // 生のanswersも別途残る（生出力の監査用。人の確定はreview_decisions＝T054）
    expect((candidate.answers.needs_check as { noul: number }).noul).toBe(0.9);
    // inputのhashと参照（docs/06 §3「最小化inputのhashと参照版を記録」）
    expect(ev.input_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(ev.input_snapshot_ref).toContain(inspection.id);

    // AIだけでは設備使用可否・状態を確定しない（docs/06 §1）
    const after = await assetSnapshot();
    const automaticFacilityStateChanges = rowDiffCount(before, after);
    expect(automaticFacilityStateChanges).toBe(0);
  });

  it("invalid_outputs_go_to_manual_review_and_keep_no_candidate", async () => {
    const admin = fx.units.a.people.admin;
    const cases: { name: string; output: unknown }[] = [
      { name: "noul_out_of_range", output: { model: "m", answers: { category: { choice: "no_issue" }, needs_check: { noul: 1.5 } } } },
      { name: "noul_is_boolean", output: { model: "m", answers: { category: { choice: "no_issue" }, needs_check: { noul: true } } } },
      { name: "noul_missing", output: { model: "m", answers: { category: { choice: "no_issue" }, needs_check: {} } } },
      { name: "answers_missing", output: { model: "m" } },
      { name: "empty_output", output: {} },
      { name: "not_an_object", output: "no_issue" },
      { name: "unknown_answer_key", output: { model: "m", answers: { category: { choice: "no_issue" }, needs_check: { noul: 0.1 }, sentiment: { score: 0.5 } } } },
      { name: "unknown_category", output: { model: "m", answers: { category: { choice: "ぜんぶ正常" }, needs_check: { noul: 0.1 } } } },
      { name: "unknown_top_level_key", output: { model: "m", answers: { category: { choice: "no_issue" }, needs_check: { noul: 0.1 } }, debug: { x: 1 } } },
      { name: "bare_score_without_scale", output: { model: "m", answers: { category: { choice: "no_issue", score: 0.7 }, needs_check: { noul: 0.1 } } } },
    ];
    for (const c of cases) {
      const issueId = await createIssue(admin, `壊れ出力の試験（${c.name}）`);
      const res = await postClassification(admin, { sourceType: "issue", sourceId: issueId, sourceVersion: 1, questionVersion: "v1" });
      expect(res.status, c.name).toBe(202);
      const { id: jobId } = ((await json(res)).data!) as { id: string };
      const summary = await runJobsWithAi(fakeAi(() => c.output));
      expect(summary.committed, c.name).toBe(1);
      const jobRow = await getJob(jobId);
      // 壊れ出力は保留（manual_review）で原本を維持する。候補は保存しない（docs/06 §2）
      expect(jobRow.status, c.name).toBe("manual_review");
      expect(jobRow.error_code, c.name).toBe("ai_output_invalid");
      expect(await getEvaluation(jobId), c.name).toBeNull();
    }
  });

  it("multiple_anomaly_probabilities_are_flagged_and_the_representative_is_kept", async () => {
    const admin = fx.units.a.people.admin;
    const issueId = await createIssue(admin, "蓋は正常だが周辺が資材で塞がれていた（架空）");
    const res = await postClassification(admin, { sourceType: "issue", sourceId: issueId, sourceVersion: 1, questionVersion: "v1" });
    expect(res.status).toBe(202);
    const { id: jobId } = ((await json(res)).data!) as { id: string };
    const summary = await runJobsWithAi(fakeAi(() => ({
      model: "m",
      answers: {
        category: {
          choice: "access_obstruction",
          probabilities: { access_obstruction: 0.6, equipment_issue: 0.3, missing_equipment: 0.05, no_issue: 0.05 },
        },
        needs_check: { noul: 0.1 },
      },
    })));
    expect(summary.committed).toBe(1);
    expect((await getJob(jobId)).status).toBe("succeeded");
    const candidate = JSON.parse((await getEvaluation(jobId))!.output_json) as {
      categories: { representative: string; multipleIssues: boolean };
      needsReview: number;
    };
    // 代表カテゴリと複数補助フラグは分離され、複数異常が単一分類へ隠されない（docs/06 §2）
    expect(candidate.categories.representative).toBe("access_obstruction");
    expect(candidate.categories.multipleIssues).toBe(true);
    expect(candidate.needsReview).toBe(0.1);
  });

  it("source_version_change_or_requester_permission_loss_becomes_stale", async () => {
    const a = fx.units.a;
    const admin = a.people.admin;
    const officer = a.people.officer;

    // --- 実行前に元版が変わったらstale（docs/11 永続ジョブのstale） ---
    const issueId = await createIssue(admin, "元版変更の試験（架空）");
    const res = await postClassification(admin, { sourceType: "issue", sourceId: issueId, sourceVersion: 1, questionVersion: "v1" });
    expect(res.status).toBe(202);
    const { id: staleJobId } = ((await json(res)).data!) as { id: string };
    const patched = await fx.client(admin).request("PATCH", `/api/v1/issues/${issueId}`, { version: 1, status: "under_review", reason: "確認を始めた（架空）" }, idem());
    expect(patched.status).toBe(200);
    const summary = await runJobsWithAi(fakeAi(() => ({ model: "m", answers: { category: { choice: "other" }, needs_check: { noul: 0.1 } } })));
    expect(summary.committed).toBe(1);
    const staleJob = await getJob(staleJobId);
    expect(staleJob.status).toBe("stale");
    expect(staleJob.error_code).toBe("source_changed");
    expect(await getEvaluation(staleJobId)).toBeNull();

    // --- 実行前に依頼者が権限を失ったらstale ---
    const issueId2 = await createIssue(admin, "権限喪失の試験（架空）");
    const res2 = await postClassification(officer, { sourceType: "issue", sourceId: issueId2, sourceVersion: 1, questionVersion: "v1" });
    expect(res2.status).toBe(202);
    const { id: lostJobId } = ((await json(res2)).data!) as { id: string };
    await env.DB.prepare("UPDATE users SET status = 'disabled', disabled_at = ? WHERE id = ?").bind(new Date().toISOString(), officer.userId).run();
    const summary2 = await runJobsWithAi(fakeAi(() => ({ model: "m", answers: { category: { choice: "other" }, needs_check: { noul: 0.1 } } })));
    expect(summary2.committed).toBe(1);
    const lostJob = await getJob(lostJobId);
    expect(lostJob.status).toBe("stale");
    expect(lostJob.error_code).toBe("requester_unauthorized");
    expect(await getEvaluation(lostJobId)).toBeNull();
    await env.DB.prepare("UPDATE users SET status = 'active', disabled_at = NULL WHERE id = ?").bind(officer.userId).run(); // 後続の試験に影響を残さない
  });

  it("without_the_ai_binding_the_job_lands_in_manual_review", async () => {
    // localはenv.AIを持たない（wrangler.jsoncの注記）。存在確認をして、無いならmanual_review（ENV契約）
    const admin = fx.units.a.people.admin;
    const issueId = await createIssue(admin, "AI無しの試験（架空）");
    const res = await postClassification(admin, { sourceType: "issue", sourceId: issueId, sourceVersion: 1, questionVersion: "v1" });
    expect(res.status).toBe(202);
    const { id: jobId } = ((await json(res)).data!) as { id: string };
    const summary = await runJobsWithAi(undefined);
    expect(summary.committed).toBe(1);
    const jobRow = await getJob(jobId);
    expect(jobRow.status).toBe("manual_review");
    expect(jobRow.error_code).toBe("ai_unavailable");
    expect(await getEvaluation(jobId)).toBeNull();
  });

  it("same_source_version_and_question_share_one_job", async () => {
    const admin = fx.units.a.people.admin;
    const issueId = await createIssue(admin, "重複依頼の試験（架空）");
    const first = await postClassification(admin, { sourceType: "issue", sourceId: issueId, sourceVersion: 1, questionVersion: "v1" });
    const second = await postClassification(admin, { sourceType: "issue", sourceId: issueId, sourceVersion: 1, questionVersion: "v1" });
    expect(first.status).toBe(202);
    expect(second.status).toBe(202);
    const firstJob = ((await json(first)).data!) as { id: string };
    const secondJob = ((await json(second)).data!) as { id: string };
    expect(secondJob.id).toBe(firstJob.id); // 同一元版＋質問版のdedupe（docs/06 §3）

    // 元版が進んだ後の再依頼は別jobになる（結果の採用条件が別になるため）
    await fx.client(admin).request("PATCH", `/api/v1/issues/${issueId}`, { version: 1, status: "under_review", reason: "確認を始めた（架空）" }, idem());
    const third = await postClassification(admin, { sourceType: "issue", sourceId: issueId, sourceVersion: 2, questionVersion: "v1" });
    expect(third.status).toBe(202);
    const thirdJob = ((await json(third)).data!) as { id: string };
    expect(thirdJob.id).not.toBe(firstJob.id);
    const count = (await env.DB.prepare(
      "SELECT count(*) AS n FROM jobs WHERE kind = 'ai.classify' AND unit_id = ? AND source_id = ?",
    ).bind(fx.units.a.id, issueId).first<{ n: number }>())!.n;
    expect(count).toBe(2);
  });

  it("classification_requests_are_validated_before_a_job_is_created", async () => {
    const a = fx.units.a;
    const admin = a.people.admin;
    const jobsBefore = (await env.DB.prepare("SELECT count(*) AS n FROM jobs WHERE kind = 'ai.classify'").first<{ n: number }>())!.n;

    // 未知の質問版（質問はサーバー固定。docs/06 §2）
    const issueId = await createIssue(admin, "入力検査の試験（架空）");
    const badQuestion = await postClassification(admin, { sourceType: "issue", sourceId: issueId, sourceVersion: 1, questionVersion: "v9" });
    expect(badQuestion.status).toBe(400);
    // 未知のsourceTypeは契約で400
    const badType = await postClassification(admin, { sourceType: "activity", sourceId: issueId, sourceVersion: 1, questionVersion: "v1" });
    expect(badType.status).toBe(400);
    // 存在しない源は404（存在を明かさない）
    const missing = await postClassification(admin, { sourceType: "issue", sourceId: crypto.randomUUID(), sourceVersion: 1, questionVersion: "v1" });
    expect(missing.status).toBe(404);
    // 別分団の源も404
    const otherUnitIssue = await createIssue(fx.units.b.people.admin, "別分団の異常（架空）");
    const crossUnit = await postClassification(admin, { sourceType: "issue", sourceId: otherUnitIssue, sourceVersion: 1, questionVersion: "v1" });
    expect(crossUnit.status).toBe(404);
    // 旧版は409（docs/05 §2「旧版409」）
    await fx.client(admin).request("PATCH", `/api/v1/issues/${issueId}`, { version: 1, status: "under_review", reason: "確認を始めた（架空）" }, idem());
    const staleVersion = await postClassification(admin, { sourceType: "issue", sourceId: issueId, sourceVersion: 1, questionVersion: "v1" });
    expect(staleVersion.status).toBe(409);

    const jobsAfter = (await env.DB.prepare("SELECT count(*) AS n FROM jobs WHERE kind = 'ai.classify'").first<{ n: number }>())!.n;
    expect(jobsAfter).toBe(jobsBefore); // 拒否された依頼はjobを作らない
  });

  it("ai_reviews_lists_pending_candidates_with_filters_and_keyset", async () => {
    const a = fx.units.a;
    const admin = a.people.admin;
    // この試験の期待を絶対件数にするため、自分の分団の既存評価を消す（review_decisionsはまだ無い＝子なし。
    // 他の試験が作った評価が一覧に混ざるのを防ぐための試験内の初期化）
    await env.DB.prepare("DELETE FROM ai_evaluations WHERE unit_id = ?").bind(a.id).run();
    // 候補を3件作る（noulとカテゴリの異なる架空出力）
    const outputs = [
      { choice: "access_obstruction", noul: 0.2 },
      { choice: "equipment_issue", noul: 0.5 },
      { choice: "no_issue", noul: 0.9 },
    ];
    const created: string[] = [];
    for (const [i, out] of outputs.entries()) {
      const issueId = await createIssue(admin, `一覧の試験${i + 1}（架空）`);
      const res = await postClassification(admin, { sourceType: "issue", sourceId: issueId, sourceVersion: 1, questionVersion: "v1" });
      const { id: jobId } = ((await json(res)).data!) as { id: string };
      created.push(jobId);
      const summary = await runJobsWithAi(fakeAi(() => ({
        model: "m",
        answers: { category: { choice: out.choice }, needs_check: { noul: out.noul } },
      })));
      expect(summary.committed).toBe(1);
    }

    const list = await fx.client(admin).request("GET", "/api/v1/ai/reviews");
    expect(list.status).toBe(200);
    const items = ((await json(list)).data!) as Record<string, unknown>[];
    expect(items).toHaveLength(3);
    // 新しい順（作成降順の安定keyset）
    expect(items.map((x) => x.jobId)).toEqual([...created].reverse());
    for (const item of items) {
      const parsed = AiEvaluation.parse(item); // 厳密DTO（docs/04:143）。未知列・欠け・型違いは失敗にする
      expect(parsed.status).toBe("pending"); // 候補は人未承認（docs/11 AI提案）
      expect(parsed.sourceType).toBe("issue");
      expect(parsed.inputHash).toMatch(/^[0-9a-f]{64}$/);
      expect(parsed.modelId).toBe("typesafe/jev");
      expect(typeof parsed.outputJson.needsReview).toBe("number");
      expect(parsed.usageJson === null || typeof parsed.usageJson.promptTokens === "number").toBe(true);
    }

    // フィルタ
    const approved = await fx.client(admin).request("GET", "/api/v1/ai/reviews?status=approved");
    expect(((await json(approved)).data!) as unknown[]).toHaveLength(0);
    const byType = await fx.client(admin).request("GET", "/api/v1/ai/reviews?sourceType=facility_inspection");
    expect(((await json(byType)).data!) as unknown[]).toHaveLength(0);
    const pending = await fx.client(admin).request("GET", "/api/v1/ai/reviews?status=pending&sourceType=issue");
    expect(((await json(pending)).data!) as unknown[]).toHaveLength(3);

    // keyset続き取得（limit=2 → 続き1件。重複なし）
    const page1 = await fx.client(admin).request("GET", "/api/v1/ai/reviews?limit=2");
    const page1Body = await json(page1);
    const page1Data = page1Body.data as Record<string, unknown>[];
    expect(page1Data).toHaveLength(2);
    expect(page1Body.meta?.nextCursor).toBeTruthy();
    const page2 = await fx.client(admin).request("GET", `/api/v1/ai/reviews?limit=2&cursor=${encodeURIComponent(page1Body.meta!.nextCursor!)}`);
    const page2Data = ((await json(page2)).data!) as Record<string, unknown>[];
    expect(page2Data).toHaveLength(1);
    const ids1 = new Set(page1Data.map((x) => x.id));
    expect(ids1.has(page2Data[0]!.id)).toBe(false);

    // 応答に氏名等の個人情報を複製しない
    const raw = JSON.stringify(items);
    expect(raw).not.toContain("架空 管理者");

    // PER-10が無い役割は403（docs/10 PER-10）
    const forbidden = await fx.client(a.people.member).request("GET", "/api/v1/ai/reviews");
    expect(forbidden.status).toBe(403);
    // 別分団は自分の分だけ（ここでは0件）
    const otherUnit = await fx.client(fx.units.b.people.admin).request("GET", "/api/v1/ai/reviews");
    expect(otherUnit.status).toBe(200);
    expect(((await json(otherUnit)).data!) as unknown[]).toHaveLength(0);
  });
});
