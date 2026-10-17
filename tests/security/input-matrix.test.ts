import { env } from "cloudflare:workers";
import { applyD1Migrations } from "cloudflare:test";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { ApiContext } from "../../src/server/http";
import { onError } from "../../src/server/http";
import { createFixture, type Identity, type TestFixture } from "../helpers/fixture";

/**
 * 入力matrix（T081、docs/07 §1「ログにtoken/パスワード…を無条件保存しない」、docs/05 API-55の式注入、
 * docs/10 §3の区分）。共通検証（256KiB上限・未知列・UUID形式・CSV式注入の無害化）と、
 * security headers・Origin検査・ログのredactionが、濫用的な入力でも壊れないことを試す。
 */

let fx: TestFixture;

beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
  fx = await createFixture("two-units");
});

const idem = () => ({ "idempotency-key": crypto.randomUUID() });
const jsonOf = async (res: Response): Promise<{ data?: unknown; error?: { code: string; details?: { field: string; reason: string }[] } }> => {
  try {
    return (await res.json()) as { error?: { code: string } };
  } catch {
    return {};
  }
};

const XSS_TITLE = `<script>alert("xss")</script>訓練のお知らせ`;
const XSS_BODY = `<img src=x onerror="fetch('https://evil.example')">架空の本文`;

const facilityBody = () => ({
  type: "hydrant", latitude: 35, longitude: 139, locationSource: "架空台帳", locationNote: "入力matrix",
  managementNumber: `MTX-${crypto.randomUUID().slice(0, 8)}`,
});

describe("T081 入力matrix", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("stored_markup_is_served_as_json_and_csv_export_neutralizes_formulas", async () => {
    const officer = fx.units.a.people.officer;
    // XSS文字列を値として保存する（画面はReactのエスケープで表示。APIはJSONで返すことが契約）
    const created = await fx.client(officer).request("POST", "/api/v1/announcements", {
      title: XSS_TITLE, body: XSS_BODY, audienceMemberIds: [fx.units.a.people.member.memberId!],
    }, idem());
    expect(created.status).toBe(201);
    const announcementId = ((await jsonOf(created)).data as { id: string }).id!;
    // 公開して対象者の名簿に現れるようにする（draftは一覧に出ない。docs/11/14 D23）
    const publish = await fx.client(officer).request("PATCH", `/api/v1/announcements/${announcementId}`, {
      version: 1, status: "published",
    }, idem());
    expect(publish.status).toBe(200);

    const list = await fx.client(fx.units.a.people.member).request("GET", "/api/v1/announcements");
    expect(list.status).toBe(200);
    expect(list.headers.get("content-type") ?? "").toContain("application/json"); // HTMLとして配信しない
    const body = await list.text();
    expect(body).toContain("<img src=x onerror="); // 値は生のままJSONで運ばれる（表示側のエスケープが単一の防御点）
    expect(list.headers.get("x-content-type-options")).toBe("nosniff");

    // CSV式注入: =で始まる管理番号は、書き出しで'を前置される（docs/05 API-55。csvCell）
    const formula = `=HYPERLINK("https://evil.example","x")`;
    const facility = await fx.client(officer).request("POST", "/api/v1/facilities", {
      type: "hydrant", latitude: 35, longitude: 139, locationSource: "架空台帳", locationNote: "入力matrix", managementNumber: formula,
    }, idem());
    expect(facility.status).toBe(201);
    const exportRes = await fx.client(officer).request("GET", "/api/v1/facilities/export");
    expect(exportRes.status).toBe(200);
    const csv = await exportRes.text();
    const line = csv.split("\r\n").find((l) => l.includes("evil.example"));
    expect(line, "式注入セルが書き出しに現れない").toBeTruthy();
    // セルは'で始まるよう無害化され（csvCell）、区切りを含むため引用符で囲まれる
    expect(line!.startsWith(`hydrant,"'=`), `無害化されたセル: ${line}`).toBe(true);
  });

  it("oversized_and_malformed_payloads_are_rejected_without_500", async () => {
    const officer = fx.units.a.people.officer;
    // 256KiB超は読みながら打ち切って400（content-lengthがなくても）
    const huge = await fx.client(officer).request("POST", "/api/v1/facilities", "x".repeat(300 * 1024), idem());
    expect(huge.status).toBe(400);
    expect((await jsonOf(huge)).error?.details?.[0]?.reason).toBe("payload_too_large");
    // 壊れたJSONも400
    const broken = await fx.client(officer).request("POST", "/api/v1/facilities", '{"type": "hydrant",,', idem());
    expect(broken.status).toBe(400);
    // 深くネストしたJSONも500でなく400（JSON.parseのRangeErrorも検証違反として扱う）
    let nested = "[]";
    for (let i = 0; i < 20_000; i++) nested = `[${nested}]`;
    const deep = await fx.client(officer).request("POST", "/api/v1/facilities", nested, idem());
    expect(deep.status).toBe(400);
    // 巨大なquery値・契約外のqueryも400
    const bigQuery = await fx.client(officer).request("GET", `/api/v1/facilities?q=${"x".repeat(3000)}`);
    expect(bigQuery.status).toBe(400);
    const unknownQuery = await fx.client(officer).request("GET", "/api/v1/facilities?foo=1");
    expect(unknownQuery.status).toBe(400);
    expect((await jsonOf(unknownQuery)).error?.code).toBe("VALIDATION_ERROR"); // 契約外のqueryは拒否（理由はdetails）
    // 本文の形だけの注入（NoSQL風の演算子）も未知列として400
    const forged = await fx.client(officer).request("POST", "/api/v1/facilities", { $gt: "", type: "hydrant" }, idem());
    expect(forged.status).toBe(400);
  });

  it("path_traversal_and_forged_targets_stay_rejections", async () => {
    const actor: Identity = fx.units.a.people.officer;
    const probes: string[] = [
      `/api/v1/facilities/${encodeURIComponent("../../etc/passwd")}`,
      `/api/v1/facilities/x${encodeURIComponent("../../etc/passwd")}`,
      `/api/v1/attachments/${encodeURIComponent("../members/abc")}/content`,
      `/api/v1/members/${encodeURIComponent("<script>alert(1)</script>")}`,
      `/api/v1/reports/${encodeURIComponent("{}")}/content`,
    ];
    for (const path of probes) {
      const res = await fx.client(actor).request("GET", path);
      expect(res.status, `${path} のstatus`).toBeGreaterThanOrEqual(400);
      expect(res.status, `${path} のstatus`).toBeLessThan(500);
      expect((res.headers.get("content-type") ?? "").startsWith("application/json"), `${path} のcontent-type`).toBe(true);
    }
  });

  it("security_headers_and_origin_check_holds_and_error_logs_are_redacted", async () => {
    // --- headers（applySecurityの集約。全API応答に付く） ---
    const me = await fx.client(fx.units.a.people.admin).request("GET", "/api/v1/me");
    expect(me.status).toBe(200);
    expect(me.headers.get("x-content-type-options")).toBe("nosniff");
    expect(me.headers.get("x-frame-options")).toBe("DENY");
    expect(me.headers.get("referrer-policy")).toBe("no-referrer");
    expect(me.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
    expect(me.headers.get("cache-control")).toBe("no-store");
    expect(me.headers.get("x-request-id")).toBeTruthy();

    // --- Origin/CSRF検査は既存機構のまま効く（controller裁定4。移さず試験で担保） ---
    const officer = fx.units.a.people.officer;
    const evil = await fx.client(officer).request("POST", "/api/v1/facilities", facilityBody(), { ...idem(), origin: "https://evil.example" });
    expect(evil.status).toBe(403);
    expect((await jsonOf(evil)).error?.details?.[0]?.reason).toBe("cross_origin");
    const trusted = await fx.client(officer).request("POST", "/api/v1/facilities", facilityBody(), { ...idem(), origin: "http://example.com" });
    expect(trusted.status, `自originの要求は通る（${JSON.stringify(await jsonOf(trusted))}）`).toBe(201);

    // --- ログのredaction: 内部例外は本文（credential・SQL・要求値）を出さず、name+digestだけ ---
    const spy = vi.spyOn(console, "error");
    const secret = "password=hunter2; token=eyJhbGciOiJIUzI1NiJ9; phone=090-1234-5678";
    const stubCtx = {
      env,
      get: () => "redact-test-request",
      json: (payload: unknown, status: number, headers?: Record<string, string>) =>
        new Response(JSON.stringify(payload), { status, headers: { "content-type": "application/json", ...headers } }),
    } as unknown as ApiContext;
    const res = await onError(new Error(`internal boom: ${secret}`), stubCtx);
    expect(res.status).toBe(500);
    const logged = spy.mock.calls.map((args) => args.map((a) => String(a)).join(" ")).join("\n");
    expect(logged).toContain("redact-test-request"); // requestIdは突き合わせに残す
    expect(logged).toContain('"name":"Error"');
    expect(logged).not.toContain("hunter2");
    expect(logged).not.toContain("eyJhbGciOiJIUzI1NiJ9");
    expect(logged).not.toContain("090-1234-5678");
  });
});
