import { env } from "cloudflare:workers";
import { applyD1Migrations } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import { apiDef, apiIds, type ApiId } from "../../src/shared/contracts/registry";
import { createApp } from "../../src/server/index";
import type { SecurityPolicy } from "../../src/server/security/limits";
import { canonicalJson, sha256Hex } from "../../src/server/mutations/hash";
import { createFixture, type Identity, type TestFixture } from "../helpers/fixture";

/**
 * 全APIの認可matrix（T081、docs/07 §1〜2、docs/10、docs/08 CT-01/02/16/17、RG-04）。
 *
 * **機械展開の正本は src/shared/contracts/registry.ts の台帳（102 API）**。docs/16の「101 API分類」は
 * 陳腐な表記で、ここでは台帳の実数をapiIdsで展開する（controller裁定1）。
 *
 * 分類（試験コード内の明示対応表CLASSIFICATION〔id→分類、全102件〕。網羅を試験自身が断言し、
 * 台帳にAPIを足したら対応表の追加が必須になる）:
 * | 分類 | 台帳上の定義 | 件数 | 試験 |
 * |---|---|---|---|
 * | PROTECTED | permissionにPER-xxを持つ（業務権限で守るroute） | 95 | 未認証/停止/別unit団員の3主体＋権限で拒否される役割の深掘り（403）＋本人unit外対象の深掘り（404）＋失権（停止・scope取消）の観測 |
 * | OWNER | permissionがPERでない（本人/token/依頼者/対象ACL/元対象編集権） | 6 | 未認証/停止の2主体（本人性・token束縛の拒否は invitations/auth-adapter/jobs/attachments の各ドメイン試験が担保。docs/evidence/security.md） |
 * | EXTERNAL | API-36（認証ライブラリ。method=ALL、/api/auth/*） | 1 | 招待token無しのsign-upが403（自由登録の拒否。未認証成功の断言に含める） |
 *
 * 各主体の断言は「成功しない・JSONの共通エラーで終わる・unit Aの対象を漏らさない・効果（冪等記録）を
 * 残さない」。HTTPのsetupが重すぎて現実的に叩けないrouteは**無い**（入力は台帳の契約shapeから導出し、
 * 401/400/403/404のどれかの拒否に落ちる。2xxは未認証では1件も許さない）。
 * rateLimitedの断言（429）は同テスト末尾で、厳しいpolicyを差したapp（createAppのsecurityPolicy引数。
 * Honoは登録順のためroutes前に適用される必要がある）による429観測に接続する。
 */

let fx: TestFixture;

beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
  fx = await createFixture("two-units");
});

const jsonOf = async (res: Response): Promise<{ data?: unknown; error?: { code: string; details?: { field: string; reason: string }[] }; meta?: { requestId?: string } }> => {
  try {
    return (await res.json()) as Record<string, never>;
  } catch {
    return {};
  }
};

describe("T081 全APIの権限・入力・濫用matrix", () => {
  it("every_business_route_rejects_cross_unit_and_stale_permissions", async () => {
    // --- 台帳からの機械展開と分類（上の表どおり） ---
    const PER_LIKE = /PER-\d{2}/;
    type Classification = "protected" | "owner" | "external";
    /**
     * 台帳の**全102件の明示分類表**（id→分類。docs/16の「101 API分類」は陳腐な表記のため不使用）。
     * 新規APIはここへ明示追加するまで型検査（satisfies Record<ApiId, …>）とこの試験の両方で落ちる
     * （分類の判断を強制する）。
     */
    const CLASSIFICATION = {
      // --- PROTECTED: permissionにPER-xx（docs/10の業務権限で守るroute） ---
      "API-01": "protected", "API-02": "protected", "API-03": "protected", "API-04": "protected", "API-05": "protected",
      "API-06": "protected", "API-07": "protected", "API-08": "protected", "API-09": "protected", "API-10": "protected",
      "API-11": "protected", "API-12": "protected", "API-13": "protected", "API-14": "protected", "API-15": "protected",
      "API-16": "protected", "API-17": "protected", "API-18": "protected", "API-19": "protected", "API-20": "protected",
      "API-21": "protected", "API-22": "protected", "API-23": "protected", "API-24": "protected", "API-25": "protected",
      "API-26": "protected", "API-28": "protected", "API-29": "protected", "API-30": "protected", "API-31": "protected",
      "API-32": "protected", "API-33": "protected", "API-34": "protected", "API-37": "protected", "API-38": "protected",
      "API-39": "protected", "API-40": "protected", "API-41": "protected", "API-42": "protected", "API-43": "protected",
      "API-44": "protected", "API-45": "protected", "API-46": "protected", "API-47": "protected", "API-48": "protected",
      "API-49": "protected", "API-50": "protected", "API-51": "protected", "API-52": "protected", "API-53": "protected",
      "API-54": "protected", "API-55": "protected", "API-56": "protected", "API-57": "protected", "API-58": "protected",
      "API-59": "protected", "API-60": "protected", "API-61": "protected", "API-62": "protected", "API-63": "protected",
      "API-64": "protected", "API-65": "protected", "API-67": "protected", "API-68": "protected", "API-69": "protected",
      "API-70": "protected", "API-71": "protected", "API-72": "protected", "API-73": "protected", "API-74": "protected",
      "API-75": "protected", "API-76": "protected", "API-77": "protected", "API-78": "protected", "API-79": "protected",
      "API-80": "protected", "API-81": "protected", "API-82": "protected", "API-83": "protected", "API-84": "protected",
      "API-85": "protected", "API-87": "protected", "API-88": "protected", "API-89": "protected", "API-90": "protected",
      "API-91": "protected", "API-92": "protected", "API-93": "protected", "API-94": "protected", "API-95": "protected",
      "API-96": "protected", "API-97": "protected", "API-98": "protected", "API-99": "protected", "API-102": "protected",
      // --- OWNER: permissionがPERでない（本人/token/依頼者/元対象ACL/元対象編集権） ---
      "API-27": "owner", "API-35": "owner", "API-66": "owner", "API-86": "owner", "API-100": "owner", "API-101": "owner",
      // --- EXTERNAL: 認証ライブラリ（method=ALL、/api/auth/*） ---
      "API-36": "external",
    } as const satisfies Record<ApiId, Classification>;

    // 網羅の断言（実効性のある検知）: 台帳の全idが表にあり、表の全idが台帳にある。
    // 新規APIの追加時に対応表を更新しなければ、この断言が未分類のidを挙げて落ちる
    expect(apiIds.filter((id) => !(id in CLASSIFICATION)), "台帳にあって分類表に無いid").toEqual([]);
    expect((Object.keys(CLASSIFICATION) as ApiId[]).filter((id) => !apiIds.includes(id)), "分類表にあって台帳に無いid").toEqual([]);
    // 分類と台帳の整合（表の陳腐化の検知）: protectedはPERを持ち、owner/externalは持たない
    const protectedRoutes = apiIds.filter((id) => CLASSIFICATION[id] === "protected");
    const ownerRoutes = apiIds.filter((id) => CLASSIFICATION[id] === "owner");
    const externalRoutes = apiIds.filter((id) => CLASSIFICATION[id] === "external");
    expect(protectedRoutes.every((id) => PER_LIKE.test(apiDef(id).permission)), "protectedなのにPERを持たないidがある").toBe(true);
    expect([...ownerRoutes, ...externalRoutes].every((id) => !PER_LIKE.test(apiDef(id).permission)), "owner/externalなのにPERを持つidがある").toBe(true);

    // --- 対象とマーカー（漏えい検査の種。unit Aの対象をunit B主体・未認証・停止主体が絶対に見ない） ---
    const hex = () => crypto.randomUUID().replaceAll("-", "").slice(0, 8);
    const markerNumber = `MTX-A-${hex()}`;
    const markerNote = `MTX-NOTE-${hex()}`;
    const seedFacility = async (id: string, unitId: string, by: string): Promise<void> => {
      const now = new Date().toISOString();
      await env.DB.prepare(
        "INSERT INTO facilities (id, unit_id, type, management_number, latitude, longitude, location_note, location_source, created_at, updated_at, created_by, actor_kind) VALUES (?, ?, 'hydrant', ?, 35, 139, ?, '架空台帳', ?, ?, ?, 'human')",
      ).bind(id, unitId, `${markerNumber}-${id.slice(0, 4)}`, markerNote, now, now, by).run();
    };
    const facilityA = crypto.randomUUID();
    // operatorの担当対象（scopeIn）にも実在の施設を置く（scope取消の観測で200→拒否を比較するため）
    const scopeInFacilityA = fx.units.a.scopeIn.entityId;
    await seedFacility(facilityA, fx.units.a.id, fx.units.a.people.admin.userId!);
    await seedFacility(scopeInFacilityA, fx.units.a.id, fx.units.a.people.admin.userId!);

    // --- probeの入力（台帳の契約shapeから導出。per-routeの重いsetupは作らない） ---
    const idem = () => `mtx-probe-${crypto.randomUUID()}`;
    const stubBody = (id: ApiId): Record<string, unknown> => {
      const map: Partial<Record<ApiId, Record<string, unknown>>> = {
        // 深掘りの403（役割で拒否されるactorに有効な本文を送り、VALIDATION_ERRORでなくFORBIDDENを観測する）
        "API-11": { type: "hydrant", latitude: 35, longitude: 139, locationSource: "架空台帳", locationNote: "matrix", managementNumber: `MTX-PROBE-${hex()}` },
        "API-03": { displayName: "matrix", status: "active" },
        "API-33": { memberId: fx.units.a.people.unlinked.memberId!, email: `matrix-${hex()}@example.test`, expiresInHours: 24 },
        "API-25": { title: "matrix", body: "matrix", audienceMemberIds: [fx.units.a.people.member.memberId!] },
      };
      return map[id] ?? {};
    };
    const shapeOf = (id: ApiId): Record<string, unknown> =>
      ((apiDef(id).request as unknown as { shape?: Record<string, unknown> }).shape ?? {});
    const paramFor = (id: ApiId, name: string): string => {
      if (name === "type") return "vehicle"; // /assets/:type/:id のtype。idは実在しないUUID（不在も404で統一）
      if (name === "linkId") return crypto.randomUUID();
      if (name === "memberId") return fx.units.a.people.member.memberId!; // 別unit団員の差替え
      if (name === "id") {
        const path = apiDef(id).path;
        if (path.startsWith("/facilities")) return facilityA; // unit Aの実在対象（別unit差替えの深掘り）
        if (path.startsWith("/members")) return fx.units.a.people.member.memberId!;
        return crypto.randomUUID();
      }
      return crypto.randomUUID();
    };
    const buildProbe = (id: ApiId): { method: string; path: string; body?: string; headers: Record<string, string> } => {
      const def = apiDef(id);
      const shape = shapeOf(id);
      const path = `/api/v1${def.path}`.replace(/:([A-Za-z]+)/g, (_, name: string) => paramFor(id, name));
      const headers: Record<string, string> = {};
      if ("headers" in shape) {
        headers["idempotency-key"] = idem();
        if (id === "API-83") headers["x-upload-token"] = `mtx-probe-${hex()}`;
      }
      // GET/DELETEに本文は送らない（契約にbodyの無いrouteは本文があるだけで400になるため）
      const hasBody = "body" in shape && def.method !== "GET" && def.method !== "DELETE";
      return { method: def.method === "ALL" ? "GET" : def.method, path, body: hasBody ? JSON.stringify(stubBody(id)) : undefined, headers };
    };

    const app = createApp(env);
    const send = async (probe: { method: string; path: string; body?: string; headers: Record<string, string> }, actor?: Identity): Promise<Response> =>
      app.fetch(
        new Request(`http://example.com${probe.path}`, {
          method: probe.method,
          headers: {
            "content-type": "application/json",
            ...probe.headers,
            ...(actor ? { "x-test-identity": JSON.stringify(actor) } : {}),
          },
          body: probe.body,
        }),
        env,
      );

    // --- 記録と断言の材料 ---
    const unauthorizedSuccessfulEffects: string[] = [];
    const leakedRowsOrFields: string[] = [];
    const probeFailures: string[] = [];
    const probed = new Set<ApiId>();
    const suspended = fx.units.a.people.suspended; // fixtureで users.status='disabled' 済み（停止＝失権の主体）
    const memberA = fx.units.a.people.member;
    const memberB = fx.units.b.people.member;
    const markers = [markerNumber, markerNote];

    const expectRejection = async (
      id: ApiId,
      actorName: string,
      actor: Identity | undefined,
      mode: "mustDeny" | "mayAllow",
    ): Promise<void> => {
      const probe = buildProbe(id);
      let res: Response;
      try {
        res = await send(probe, actor);
      } catch (err) {
        probeFailures.push(`${id} ${actorName}: 送信自体が失敗 ${String(err)}`);
        return;
      }
      const def = apiDef(id);
      const body = await jsonOf(res);
      const location = `${id}(${def.method} ${def.path}) ${actorName}`;
      if (mode === "mustDeny") {
        // 未認証・停止・権限で拒否される役割は成功しない（unauthorizedSuccessfulEffectsは必須断言の材料）
        if (res.status < 300) {
          (actor === undefined || actor === suspended ? unauthorizedSuccessfulEffects : probeFailures).push(`${location}: status=${res.status}`);
        }
        if (body.error?.code === undefined || !body.meta?.requestId) probeFailures.push(`${location}: 共通エラーenvelopeでない status=${res.status}`);
      } else {
        // 自unitの許され得る役割: 2xxは自unitの正常応答（漏えい検査だけ。envelopeはdata側）、それ以外はエラーenvelope
        if (res.status >= 500) probeFailures.push(`${location}: 500系 status=${res.status}`);
        if (res.status >= 300 && (body.error?.code === undefined || !body.meta?.requestId)) {
          probeFailures.push(`${location}: 共通エラーenvelopeでない status=${res.status}`);
        }
        if (res.status < 300 && body.meta?.requestId === undefined) probeFailures.push(`${location}: 成功envelopeにrequestIdが無い`);
      }
      const text = JSON.stringify(body);
      for (const marker of markers) {
        if (text.includes(marker)) leakedRowsOrFields.push(`${location}: ${marker}`);
      }
    };

    // --- PROTECTED: 未認証・停止・別unit団員の3主体で全routeを叩く ---
    // 権限で「member」が拒否されるPER（docs/10 §2の×/△を最小権限で。authorization.test.tsの期待表と同じ根拠）
    const MEMBER_DENIED = new Set(["PER-03", "PER-05", "PER-06", "PER-07", "PER-08", "PER-10", "PER-14"]);
    const primaryPer = (id: ApiId): string => apiDef(id).permission.match(PER_LIKE)![0]!;
    for (const id of protectedRoutes) {
      await expectRejection(id, "unauth", undefined, "mustDeny");
      await expectRejection(id, "suspended", suspended, "mustDeny");
      // memberはunit A/Bのどちらで叩くか: 拒否される権限なら自unit(memberA・必ず拒否)、
      // 許され得る権限なら別unit(memberB・自unit分は200になり得るので漏えい検査が主眼)
      const denied = MEMBER_DENIED.has(primaryPer(id));
      await expectRejection(id, denied ? "memberA" : "memberB", denied ? memberA : memberB, denied ? "mustDeny" : "mayAllow");
      probed.add(id);
    }
    // --- OWNER: 本人/token/依頼者/対象ACLのroute。未認証・停止で拒否されることだけ機械的に全件確認 ---
    for (const id of ownerRoutes) {
      await expectRejection(id, "unauth", undefined, "mustDeny");
      await expectRejection(id, "suspended", suspended, "mustDeny");
      probed.add(id);
    }
    // --- EXTERNAL (API-36): 招待token無しの自由sign-upは403（認証ライブラリのgate。auth-adapter試験の深掘りあり） ---
    const freeSignUp = await app.fetch(
      new Request("http://example.com/api/auth/sign-up/email", {
        method: "POST",
        headers: { "content-type": "application/json", origin: "http://example.com" },
        body: JSON.stringify({ email: `matrix-${hex()}@example.test`, password: "correct-horse-battery-1", name: "matrix" }),
      }),
      env,
    );
    if (freeSignUp.status !== 403) probeFailures.push(`API-36: 招待無しsign-upが403でない status=${freeSignUp.status}`);
    probed.add("API-36");

    const uncoveredProtectedRoutes = protectedRoutes.filter((id) => !probed.has(id));
    const unauthorizedEffects = unauthorizedSuccessfulEffects.length;

    // --- 深掘り1: 役割で拒否されるactorには「有効な本文」で到達した403 FORBIDDENを観測する ---
    // （{}のままでは400に落ちるrouteでも、契約どおりの本文なら認可の拒否まで進む。docs/10 §2の×行）
    const deny403: { id: ApiId; actor: Identity; label: string }[] = [
      { id: "API-11", actor: memberA, label: "施設作成PER-03" },
      { id: "API-03", actor: memberA, label: "名簿登録PER-06" },
      { id: "API-33", actor: memberA, label: "招待発行PER-07" },
      { id: "API-25", actor: memberA, label: "お知らせ作成PER-03" },
    ];
    for (const { id, actor, label } of deny403) {
      const probe = buildProbe(id);
      probe.body = JSON.stringify(stubBody(id));
      probe.headers["idempotency-key"] = idem();
      const res = await send(probe, actor);
      const body = await jsonOf(res);
      if (!(res.status === 403 && body.error?.code === "FORBIDDEN")) {
        probeFailures.push(`${id} 深掘り403(${label}): status=${res.status} code=${body.error?.code}`);
      }
    }

    // --- 深掘り2: 別unit差替え。unit Bの役割適格者（幹部）でもunit Aの実在対象には届かない（存在も404で隠す） ---
    const officerB = fx.units.b.people.officer;
    const crossGet = await send({ method: "GET", path: `/api/v1/facilities/${facilityA}`, headers: {} }, officerB);
    if (crossGet.status !== 404) probeFailures.push(`API-12 別unit GET: status=${crossGet.status}（404で存在を隠す）`);
    const crossPatch = await send(
      { method: "PATCH", path: `/api/v1/facilities/${facilityA}`, body: JSON.stringify({ version: 1, locationNote: "matrix" }), headers: { "idempotency-key": idem() } },
      officerB,
    );
    if (crossPatch.status !== 404) probeFailures.push(`API-13 別unit PATCH: status=${crossPatch.status}（404で存在を隠す）`);
    const crossExport = await send({ method: "GET", path: "/api/v1/facilities/export", headers: {} }, memberB);
    if (crossExport.status !== 403) probeFailures.push(`API-55 別unit export: status=${crossExport.status}（PER-03で拒否）`);
    const crossList = await jsonOf(await send({ method: "GET", path: "/api/v1/facilities?limit=200", headers: {} }, memberB));
    if (JSON.stringify(crossList).includes(markerNumber)) leakedRowsOrFields.push("API-10 別unit一覧にunit Aの施設が混入");

    // --- 深掘り3: 失権。authz_version増分つきの利用停止は業務routeの次の要求から401、scopeの取消は次の要求から403 ---
    // （authorization.test.tsがprincipal層で確認する内容を、業務routeのHTTPで観測する）
    const meFor = async (who: Identity) => send({ method: "GET", path: "/api/v1/me", headers: {} }, who);
    expect((await meFor(memberA)).status).toBe(200);
    await env.DB.prepare("UPDATE users SET status = 'disabled', disabled_at = ?, authz_version = authz_version + 1 WHERE id = ?").bind(new Date().toISOString(), memberA.userId).run();
    expect((await meFor(memberA)).status).toBe(401);
    await env.DB.prepare("UPDATE users SET status = 'active', disabled_at = NULL WHERE id = ?").bind(memberA.userId).run();
    expect((await meFor(memberA)).status).toBe(200);

    // operatorの担当対象では認可を通る（版不一致の409まで進む）が、scope取消の次の要求から403になる
    const reviewProbe = { method: "POST", path: `/api/v1/facilities/${scopeInFacilityA}/location-reviews`, body: JSON.stringify({ decision: "request", version: 1, locationVersion: 999, reason: "matrix" }), headers: { "idempotency-key": idem() } };
    const operatorA = fx.units.a.people.operator;
    const beforeRevoke = await send(reviewProbe, operatorA);
    if (beforeRevoke.status !== 409) probeFailures.push(`API-45 scope内: status=${beforeRevoke.status}（認可を通った409になる）`);
    await env.DB.prepare("UPDATE scope_assignments SET revoked_at = ? WHERE member_id = ?").bind(new Date().toISOString(), operatorA.memberId).run();
    const afterRevoke = await send(reviewProbe, operatorA);
    if (!(afterRevoke.status === 403 && (await jsonOf(afterRevoke)).error?.code === "FORBIDDEN")) {
      probeFailures.push(`API-45 scope取消後: status=${afterRevoke.status}（403になる）`);
    }

    // --- 深掘り4: 同期系（API-81/82）。同鍵再送が照会を兼ね、API-82の照会分岐は機能的に到達不能（ph6.md残課題の確認） ---
    const idemHeader = () => ({ "idempotency-key": crypto.randomUUID() });
    const activityRes = await fx.client(fx.units.a.people.admin).request("POST", "/api/v1/activities", {
      title: "matrix同期確認の訓練", kind: "訓練", plannedStartsAt: "2099-10-20T01:00:00.000Z", locationText: "架空市堤防",
      ownerMemberId: fx.units.a.people.admin.memberId!, audienceMemberIds: [memberA.memberId!],
      responseDueAt: "2098-01-01T00:00:00.000Z",
    }, idemHeader());
    expect(activityRes.status).toBe(201);
    const activityId = ((await jsonOf(activityRes)).data as { id: string }).id!;
    expect((await fx.client(fx.units.a.people.admin).request("PATCH", `/api/v1/activities/${activityId}`, {
      version: 1, status: "scheduled", reason: "対象を確定して公開",
    }, idemHeader())).status).toBe(200);
    const cmd = {
      clientOperationId: crypto.randomUUID(), deviceId: crypto.randomUUID(),
      operationCode: "attendance.respond", targetId: activityId, baseVersion: 0,
      payload: { response: "attending" }, payloadHash: await sha256Hex(canonicalJson({ response: "attending" })),
    };
    const postSync = (who: Identity) => fx.client(who).request("POST", "/api/v1/sync/commands", cmd, { "idempotency-key": cmd.clientOperationId });
    const first = await postSync(memberA);
    expect(first.status).toBe(200);
    const applied = (await jsonOf(first)).data as { id: string; status: string };
    expect(applied.status).toBe("applied");
    // 同鍵再送は保存済みの結果を返す（照会API-82を呼ばなくても結果は得られる＝「照会優先」の機能充足）
    const replayRes = await postSync(memberA);
    expect(replayRes.status).toBe(200);
    expect((await jsonOf(replayRes)).data).toEqual(applied as unknown as Record<string, unknown>);
    // API-82自体も正しく動く: 本人は照会でき、他人は存在も明かされない404
    const queryOwn = await send({ method: "GET", path: `/api/v1/sync/operations/${applied.id}`, headers: {} }, memberA);
    expect(queryOwn.status).toBe(200);
    expect(((await jsonOf(queryOwn)).data as { id: string }).id).toBe(applied.id);
    const queryOther = await send({ method: "GET", path: `/api/v1/sync/operations/${applied.id}`, headers: {} }, memberB);
    if (queryOther.status !== 404) probeFailures.push(`API-82 他人の照会: status=${queryOther.status}（404で存在を隠す）`);
    const attendanceEffects = (await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM attendance_events e JOIN activity_attendance a ON a.id = e.attendance_id WHERE a.activity_id = ?",
    ).bind(activityId).first<{ n: number }>())!.n;
    expect(attendanceEffects).toBe(1); // 再送・照会で効果は増えない

    // --- 効果の数え上げ: 未認証・停止・別unitの全probeで冪等記録が1行も増えない ---
    const recordedKeys = (await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM idempotency_records WHERE idempotency_key LIKE 'mtx-probe-%'",
    ).first<{ n: number }>())!.n;
    if (recordedKeys !== 0) probeFailures.push(`拒否された要求の冪等記録が${recordedKeys}行残っている`);

    // --- 厳しいpolicyの注入: policyを差し替えたapp（routesの登録前に適用される）で、同じ経路が429になる ---
    // ※ Honoは登録順に照合するため、routesの後からのapplySecurityでは既存routeの前に挟まらない。
    //   試験はcreateAppのsecurityPolicy引数で差す（index.ts、T082の緩和policyも同じ口）。
    const strict: SecurityPolicy = {
      rateLimit: {
        auth: { requests: 3, windowMs: 60_000 }, ai: { requests: 3, windowMs: 60_000 },
        search: { requests: 3, windowMs: 60_000 }, upload: { requests: 3, windowMs: 60_000 },
        default: { requests: 3, windowMs: 60_000 },
      },
    };
    const strictApp = createApp(env, strict);
    const hitStrict = async () => strictApp.fetch(
      new Request("http://example.com/api/v1/me", { headers: { "x-test-identity": JSON.stringify(fx.units.a.people.admin) } }),
      env,
    );
    expect((await hitStrict()).status).toBe(200);
    expect((await hitStrict()).status).toBe(200);
    expect((await hitStrict()).status).toBe(200);
    const rateLimited = await hitStrict();
    const rateBody = await jsonOf(rateLimited);

    // --- 断言（docs/16 T081の断言どおり） ---
    expect(uncoveredProtectedRoutes).toEqual([]);
    expect(unauthorizedEffects).toBe(0);
    expect(leakedRowsOrFields).toEqual([]);
    expect(rateLimited.status).toBe(429);
    // 追加の断言（試験自身の成立条件。失敗の詳細を1件ずつ残す）
    expect(rateBody.error?.code).toBe("RATE_LIMITED");
    expect(rateLimited.headers.get("retry-after")).toBeTruthy();
    expect(probeFailures).toEqual([]);
    if (probeFailures.length > 0) console.log("probeFailures:\n" + probeFailures.join("\n"));
  });
});
