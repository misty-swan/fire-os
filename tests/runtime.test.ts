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

  it("api_route_never_returns_spa", async () => {
    const appResponse = await runtime.fetch(new Request("http://example.com/app/unknown"));
    const apiResponse = await runtime.fetch(new Request("http://example.com/api/v1/unknown"));
    const authResponse = await runtime.fetch(new Request("http://example.com/api/auth/unknown"));

    expect(appResponse.headers.get("content-type")).toContain("text/html");
    expect(apiResponse.status).toBe(404);
    expect(apiResponse.headers.get("content-type")).toContain("application/json");
    expect(authResponse.headers.get("content-type")).not.toContain("text/html");
  });
});
