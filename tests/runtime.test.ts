import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createRuntime, type WorkerRuntime } from "./helpers/runtime";

describe("runtime (T001)", () => {
  let runtime: WorkerRuntime;
  beforeAll(async () => {
    runtime = await createRuntime();
  });
  afterAll(async () => {
    await runtime.dispose();
  });

  // 全試験を並列に起動した直後は、最初の要求（Workerの冷間起動）が5秒を超えることがある
  it("api_route_never_returns_spa", { timeout: 30_000 }, async () => {
    const appResponse = await runtime.fetch(new Request("http://example.com/app/unknown"));
    const apiResponse = await runtime.fetch(new Request("http://example.com/api/v1/unknown"));
    const authResponse = await runtime.fetch(new Request("http://example.com/api/auth/unknown"));

    expect(appResponse.headers.get("content-type")).toContain("text/html");
    expect(apiResponse.status).toBe(404);
    expect(apiResponse.headers.get("content-type")).toContain("application/json");
    expect(authResponse.headers.get("content-type")).not.toContain("text/html");
  });
});
