import { env } from "cloudflare:workers";
import { applyD1Migrations } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import { createFixture, type Identity, type TestFixture } from "./helpers/fixture";

let fx: TestFixture;
beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
  fx = await createFixture("two-units");
});

// 最小のPNGシグネチャ付きダミー（内容の検査そのものはT016。ここでは転送と版管理を試す）
const pngBytes = (fill: number, size = 100) => {
  const b = new Uint8Array(size);
  b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
  b.fill(fill, 8);
  return b;
};
const sha256 = async (bytes: Uint8Array) => {
  const d = await crypto.subtle.digest("SHA-256", bytes as BufferSource);
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
};
const idem = () => ({ "idempotency-key": crypto.randomUUID() });

interface JsonBody {
  data?: Record<string, unknown>;
  error?: { code: string; details?: { field: string; reason: string }[] };
}
const json = async (r: Response): Promise<JsonBody> => (await r.json()) as JsonBody;

/** バイナリ(API-83)は専用の要求で送る（fixtureのclientはapplication/jsonを付けるため） */
const rawUpload = (who: Identity, attachmentId: string, token: string | undefined, bytes: Uint8Array) =>
  fx.raw(who)(
    new Request(`http://example.com/api/v1/attachments/${attachmentId}/upload`, {
      method: "PUT",
      headers: {
        "content-type": "application/octet-stream",
        ...(token ? { "x-upload-token": token } : {}),
      },
      body: bytes as BufferSource,
    }),
  );

const makeDraftAndIntent = async (who: Identity, intended: string, contentType = "image/png", byteSize = 100) => {
  const dRes = await fx.client(who).request("POST", "/api/v1/attachment-drafts", { intendedEntityType: intended }, idem());
  const draft = (await json(dRes)).data! as { id: string; version: number; expiresAt: string };
  const iRes = await fx.client(who).request(
    "POST",
    "/api/v1/attachments/upload-intents",
    { target: { type: "attachment_draft", id: draft.id }, contentType, byteSize },
    idem(),
  );
  return { draft, iRes, intent: (await json(iRes)).data as { id: string; uploadPath: string; uploadToken: string; expiresAt: string; version: number } | undefined };
};

describe("添付の予約とアップロード (T015)", () => {
  it("ready_object_cannot_be_overwritten_by_late_upload", async () => {
    const a = fx.units.a;
    const admin = a.people.admin;
    const other = a.people.member; // 同じunitの一般団員

    // 親がまだ無い施設への写真を予約する
    const dRes = await fx.client(admin).request("POST", "/api/v1/attachment-drafts", { intendedEntityType: "facility" }, idem());
    expect(dRes.status).toBe(201);
    const draft = (await json(dRes)).data! as { id: string; version: number; expiresAt: string };
    expect(draft.version).toBe(1);
    expect(typeof draft.expiresAt).toBe("string");
    // 内部値（tokenのhash・R2鍵）が応答へ出ない
    expect(JSON.stringify(draft)).not.toMatch(/token|staging|ready/);

    // intent（15分案）。対象は予約したdraft。形式と容量の上限案（画像10MiB）
    const iRes = await fx.client(admin).request(
      "POST",
      "/api/v1/attachments/upload-intents",
      { target: { type: "attachment_draft", id: draft.id }, contentType: "image/png", byteSize: 100 },
      idem(),
    );
    expect(iRes.status).toBe(201);
    const intent = (await json(iRes)).data! as { id: string; uploadPath: string; uploadToken: string; expiresAt: string; version: number };
    expect(intent.uploadPath).toBe(`/api/v1/attachments/${intent.id}/upload`);
    expect(Object.keys(intent).sort()).toEqual(["expiresAt", "id", "uploadPath", "uploadToken", "version"]);

    // 同時2upload: 同じtokenでも各試行は別の不変staging keyへ行く（上書きしない）
    const bytesA = pngBytes(1);
    const bytesB = pngBytes(2);
    const [up1, up2] = await Promise.all([
      rawUpload(admin, intent.id, intent.uploadToken, bytesA),
      rawUpload(admin, intent.id, intent.uploadToken, bytesB),
    ]);
    expect(up1.status).toBe(200);
    expect(up2.status).toBe(200);
    const att1 = (await json(up1)).data! as { id: string; sha256: string; size: number; version: number };
    const att2 = (await json(up2)).data! as { id: string; sha256: string; size: number; version: number };
    expect(att1.id).not.toBe(att2.id);
    expect(att1.sha256).toBe(await sha256(bytesA));
    expect(att2.sha256).toBe(await sha256(bytesB));

    const attempts = await fx.rows("upload_attempts", { attachment_id: intent.id });
    expect(attempts).toHaveLength(2);
    const stagingKeys = attempts.map((r) => r.staging_key as string).sort();
    expect(stagingKeys[0]).not.toBe(stagingKeys[1]);
    // R2に実体があり、鍵ごとに中身が違う
    const objA = await env.FILES.get(attempts.find((r) => r.id === att1.id)!.staging_key as string);
    expect(new Uint8Array(await objA!.arrayBuffer())).toEqual(bytesA);

    // 実測容量超過：画像10MiB超は切って拒否し、attemptを残さない（まだ完了前なので転送は可能な状態）
    const big = new Uint8Array(10 * 1024 * 1024 + 1);
    big.set([0x89, 0x50, 0x4e, 0x47], 0);
    const overRes = await rawUpload(admin, intent.id, intent.uploadToken, big);
    expect(overRes.status).toBe(400);
    expect(((await json(overRes)).error?.details ?? []).some((d) => d.reason === "actual_size_over_limit")).toBe(true);
    expect((await fx.rows("upload_attempts", { attachment_id: intent.id })).every((r) => (r.byte_size as number) <= 10 * 1024 * 1024)).toBe(true);

    // completion（版ガード付きの選択）。検査jobが登録され、添付は検査待ちになる
    const cRes = await fx.client(admin).request(
      "POST",
      `/api/v1/attachments/${intent.id}/completion`,
      { version: 1, uploadAttemptId: att1.id, sha256: att1.sha256 },
      idem(),
    );
    expect(cRes.status).toBe(202);
    const completed = (await json(cRes)).data! as { attachment: { id: string; status: string; version: number }; job: { id: string; status: string } };
    expect(completed.attachment.status).toBe("uploaded");
    expect(completed.job.status).toBe("queued");
    const jobRow = await env.DB.prepare("SELECT kind, status, requested_by FROM jobs WHERE id = ?").bind(completed.job.id).first<{ kind: string; status: string; requested_by: string | null }>();
    expect(jobRow).toMatchObject({ kind: "attachment.inspect", status: "queued", requested_by: admin.userId });

    // 選択は1試行だけ。遅れて届いたもう一方のcompletionで選択を付け替えられない
    const late = await fx.client(admin).request(
      "POST",
      `/api/v1/attachments/${intent.id}/completion`,
      { version: 2, uploadAttemptId: att2.id, sha256: att2.sha256 },
      idem(),
    );
    expect(late.status).toBe(422);
    expect(((await json(late)).error?.details ?? []).some((d) => d.reason === "attempt_already_selected")).toBe(true);
    const rowsAfter = await fx.rows("upload_attempts", { attachment_id: intent.id });
    const selected = rowsAfter.filter((r) => r.status === "selected");
    expect(selected).toHaveLength(1);
    expect(selected[0]!.id).toBe(att1.id);

    // 選択済みの実体（ready候補）のhashは、遅れた転送では変わらない
    const lateUpload = await rawUpload(admin, intent.id, intent.uploadToken, pngBytes(3));
    expect(lateUpload.status).toBe(422);
    const lateAttempts = await fx.rows("upload_attempts", { attachment_id: intent.id });
    expect(lateAttempts).toHaveLength(2); // 新しい試行は増えない
    const objSelected = await env.FILES.get(selected[0]!.staging_key as string);
    expect(await sha256(new Uint8Array(await objSelected!.arrayBuffer()))).toBe(att1.sha256);
    expect((await fx.rows("attachments", { id: intent.id }))[0]!.selected_upload_attempt_id).toBe(att1.id);

    // 別ユーザー（同unit）の転送は不可。別unitは存在も見せない
    expect((await rawUpload(other, intent.id, intent.uploadToken, bytesA)).status).toBe(403);
    const otherAdmin = fx.units.b.people.admin;
    expect((await rawUpload(otherAdmin, intent.id, intent.uploadToken, bytesA)).status).toBe(404);

    // 申告容量の超過はintentの時点で拒否
    const overIntent = await fx.client(admin).request(
      "POST",
      "/api/v1/attachments/upload-intents",
      { target: { type: "attachment_draft", id: draft.id }, contentType: "image/png", byteSize: 10 * 1024 * 1024 + 1 },
      idem(),
    );
    expect(overIntent.status).toBe(400);
    expect(((await json(overIntent)).error?.details ?? []).some((d) => d.reason === "byte_size_over_limit")).toBe(true);

    // 期限切れのdraftではintentを作れない（予約の15分を過ぎたもの。試験では期限を直接過去へ動かす）
    await env.DB.prepare("UPDATE attachment_drafts SET expires_at = ? WHERE id = ?").bind("2020-01-01T00:00:00.000Z", draft.id).run();
    const expiredDraft = await fx.client(admin).request(
      "POST",
      "/api/v1/attachments/upload-intents",
      { target: { type: "attachment_draft", id: draft.id }, contentType: "image/png", byteSize: 100 },
      idem(),
    );
    expect(expiredDraft.status).toBe(422);
    expect(((await json(expiredDraft)).error?.details ?? []).some((d) => d.reason === "draft_expired")).toBe(true);
  });

  it("upload_requires_token_and_owner_and_known_type", async () => {
    const a = fx.units.a;
    const admin = a.people.admin;
    const { intent } = await makeDraftAndIntent(admin, "inspection", "image/jpeg", 64);

    // 誤ったtokenは403、token無しは契約違反の400
    expect((await rawUpload(admin, intent!.id, "wrong-token", pngBytes(9))).status).toBe(403);
    expect((await rawUpload(admin, intent!.id, undefined, pngBytes(9))).status).toBe(400);

    // 未対応の形式はintentの時点で拒否（SVG/HTML/実行形式は許可しない。docs/07 §3.3）
    const svg = await fx.client(admin).request(
      "POST",
      "/api/v1/attachments/upload-intents",
      { target: { type: "attachment_draft", id: (await makeDraftAndIntent(admin, "facility")).draft.id }, contentType: "image/svg+xml", byteSize: 10 },
      idem(),
    );
    expect(svg.status).toBe(400);
    expect(((await json(svg)).error?.details ?? []).some((d) => d.reason === "unsupported_content_type")).toBe(true);

    // 存在しないattachmentのupload/completionは404
    const ghost = crypto.randomUUID();
    expect((await rawUpload(admin, ghost, "x", pngBytes(1))).status).toBe(404);
    const ghostCompletion = await fx.client(admin).request("POST", `/api/v1/attachments/${ghost}/completion`, { version: 1, uploadAttemptId: ghost, sha256: "a".repeat(64) }, idem());
    expect(ghostCompletion.status).toBe(404);
  });

  it("draft_classification_follows_intent_and_link_checks_intended_target", async () => {
    const a = fx.units.a;
    const admin = a.people.admin;

    // (a) 点検を意図した予約の添付はsensitiveになる（docs/10 §3。点検・異常は現場写真を含み得る）
    const { intent: inspectionIntent } = await makeDraftAndIntent(admin, "inspection");
    expect(inspectionIntent).toBeTruthy();
    expect((await fx.rows("attachments", { id: inspectionIntent!.id }))[0]!.classification).toBe("sensitive");
    // 施設を意図した予約はbasicのまま（分類の引上げは点検・異常へのリンク時だけ）
    const { intent: facilityIntent } = await makeDraftAndIntent(admin, "facility");
    expect((await fx.rows("attachments", { id: facilityIntent!.id }))[0]!.classification).toBe("basic");

    // (b) 施設を意図した予約を点検へはリンクできない（docs/05「最終link先を検査」。意図と一致しない消費は422）
    const { planAttachmentLinks } = await import("../src/server/attachments/link");
    const facilityDraft = (await fx.rows("attachment_drafts", { intended_entity_type: "facility" })).at(-1)!;
    await expect(
      planAttachmentLinks(env, a.id, admin.userId, {
        target: { type: "inspection", id: crypto.randomUUID() },
        draftId: facilityDraft.id as string,
        targetCreatedInBatch: true,
      }),
    ).rejects.toMatchObject({ code: "INVALID_TRANSITION", details: [{ reason: "draft_intended_mismatch" }] });
    // 予約は消費されていない（422の後にそのまま施設へ使える）
    expect((await fx.rows("attachment_drafts", { id: facilityDraft.id as string }))[0]!.status).toBe("prepared");

    // 親の型とIDの片方だけでは予約を作れない（不整合な予約=DBのCHECK違反500を防ぐ）
    const halfParent = await fx.client(admin).request(
      "POST", "/api/v1/attachment-drafts", { intendedEntityType: "facility", parentType: "facility" }, idem(),
    );
    expect(halfParent.status).toBe(400);
    expect(((await json(halfParent)).error?.details ?? []).some((d) => d.reason === "parent_type_and_id_set_together")).toBe(true);
  });

  it("empty_upload_body_is_rejected_without_attempt", async () => {
    const admin = fx.units.a.people.admin;
    const { intent } = await makeDraftAndIntent(admin, "facility");
    // 0バイトの転送は400（attemptを作らないため500のUploadAttempt.parseにならない）
    const empty = await rawUpload(admin, intent!.id, intent!.uploadToken, new Uint8Array(0));
    expect(empty.status).toBe(400);
    expect(((await json(empty)).error?.details ?? []).some((d) => d.reason === "empty_body")).toBe(true);
    expect(await fx.rows("upload_attempts", { attachment_id: intent!.id })).toHaveLength(0);
  });
});
