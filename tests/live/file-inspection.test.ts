import { describe, expect, it } from "vitest";

/**
 * T016 / V02: 実Cloudflare（実R2・実Workers）での添付検査の確認。
 * 局所のworkerd試験（tests/file-inspection.test.ts）の代わりにはならない。環境が無ければ「未実施」として失敗する
 * （スキップして完了扱いにしない）。手順は docs/evidence/V02-files.md。
 *
 * 必要な環境変数:
 *   LIVE_BASE_URL          配置したWorkerのhttps URL
 *   LIVE_BOOTSTRAP_EMAIL   初期管理者の招待先メール
 *   LIVE_BOOTSTRAP_TOKEN   同CLIが一度だけ表示した招待token
 *   LIVE_R2_BUCKET         検査後のR2オブジェクトを直接照合するためのwrangler実行（未指定ならAPI応答だけで判定）
 */
const base = process.env.LIVE_BASE_URL;
const email = process.env.LIVE_BOOTSTRAP_EMAIL;
const token = process.env.LIVE_BOOTSTRAP_TOKEN;

function requireLive() {
  if (!base || !email || !token) {
    throw new Error(
      "実Cloudflareの環境が未設定のため、この試験は未実施です。LIVE_BASE_URL / LIVE_BOOTSTRAP_EMAIL / LIVE_BOOTSTRAP_TOKEN を設定してください（docs/evidence/V02-files.md）",
    );
  }
  if (!base.startsWith("https://")) throw new Error("LIVE_BASE_URL は https である必要があります");
  return { base, email, token };
}

/** EXIF(GPS)入りの最小JPEG。実写真情報を載せないため全て架空のバイト列 */
function jpegWithExif(): Uint8Array {
  const seg = (marker: number, payload: Uint8Array) => {
    const out = new Uint8Array(4 + payload.length);
    out[0] = 0xff; out[1] = marker;
    out[2] = (payload.length + 2) >> 8; out[3] = (payload.length + 2) & 0xff;
    out.set(payload, 4);
    return out;
  };
  const t = (s: string) => new TextEncoder().encode(s);
  const parts = [
    new Uint8Array([0xff, 0xd8]),
    seg(0xe1, t("Exif\x00\x00MM\x00\x2a\x00\x00\x00\x08\x00\x01\x88\x25\x00\x04\x00\x00\x00\x01\x00\x00\x00\x1a\x00\x00\x00\x00")),
    seg(0xe0, t("JFIF\x00\x01\x01\x00\x00\x01\x00\x01\x00\x00")),
    seg(0xda, new Uint8Array([0x00, 0x02, 0x00, 0x00])),
    new Uint8Array([0x12, 0x34, 0x00, 0xff, 0xd9]),
  ];
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

describe("実R2上の添付検査 (V02)", () => {
  it("exif_is_stripped_and_ready_object_is_served_with_real_r2", async () => {
    const live = requireLive();
    const origin = new URL(live.base).origin;
    const post = async (path: string, body: unknown, headers: Record<string, string> = {}, cookie = "") =>
      fetch(`${origin}${path}`, {
        method: "POST",
        headers: { "content-type": "application/json", origin, ...(cookie ? { cookie } : {}), ...headers },
        body: JSON.stringify(body),
      });

    // 管理者でログイン（実セッション）
    const signIn = await fetch(`${origin}/api/auth/sign-in/email`, {
      method: "POST",
      headers: { "content-type": "application/json", origin },
      body: JSON.stringify({ email: live.email, password: process.env.LIVE_PASSWORD ?? `live-${crypto.randomUUID()}-Aa1` }),
    });
    // 初回実行では管理者が未作成の可能性がある。その場合は未実施として失敗させる（skipしない）
    if (!signIn.ok) throw new Error(`実環境へのログインに失敗しました（${signIn.status}）。stagingの初期管理者を作ってください（docs/evidence/V02-files.md）`);
    const cookie = signIn.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");
    const auth = { cookie };

    // 予約→intent→転送→完了→検査（EXIF入りのJPEG）
    const draft = await (await post("/api/v1/attachment-drafts", { intendedEntityType: "facility" }, auth)).json() as { data: { id: string } };
    const intentRes = await post("/api/v1/attachments/upload-intents", {
      target: { type: "attachment_draft", id: draft.data.id }, contentType: "image/jpeg", byteSize: 100,
    }, auth);
    const intent = (await intentRes.json()) as { data: { id: string; uploadToken: string } };
    const up = await fetch(`${origin}/api/v1/attachments/${intent.data.id}/upload`, {
      method: "PUT",
      headers: { "content-type": "application/octet-stream", "x-upload-token": intent.data.uploadToken, ...auth },
      body: jpegWithExif() as BufferSource,
    });
    expect(up.status).toBe(200);
    const attempt = (await up.json()) as { data: { id: string; sha256: string } };
    const completion = await post(`/api/v1/attachments/${intent.data.id}/completion`, {
      version: 1, uploadAttemptId: attempt.data.id, sha256: attempt.data.sha256,
    }, auth, cookie);
    expect(completion.status).toBe(202);

    // 実際のCron/Queueで検査jobが走るのを待つ（stagingはCron毎分）
    let ready = false;
    for (let i = 0; i < 12 && !ready; i++) {
      await new Promise((r) => setTimeout(r, 10_000));
      const job = (await (await post(`/api/v1/jobs/${((await completion.json()) as { data: { job: { id: string } } }).data.job.id}`, {}, auth)).json()) as { data: { status: string } };
      ready = job.data.status === "succeeded";
    }
    expect(ready).toBe(true);

    // ready実体の取得（実R2→Workers経由の配信）。EXIFが無いこと
    const content = await fetch(`${origin}/api/v1/attachments/${intent.data.id}/content`, { headers: auth });
    expect(content.status).toBe(200);
    const bytes = new Uint8Array(await content.arrayBuffer());
    expect(new TextDecoder("latin1").decode(bytes)).not.toContain("Exif");
  });
});
