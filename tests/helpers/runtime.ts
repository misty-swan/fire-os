import { exports } from "cloudflare:workers";

export interface WorkerRuntime {
  fetch(request: Request): Promise<Response>;
  dispose(): Promise<void>;
}

// exports.default は main Worker のdefault exportを指す(型定義がないため明示する)。
const worker = (exports as unknown as { default: Fetcher }).default;

// vitest-plugin(workerd)上で動いているアプリ本体へ、実HTTPリクエストと同じ形で問い合わせる。
export async function createRuntime(): Promise<WorkerRuntime> {
  return {
    fetch: (request) => worker.fetch(request),
    dispose: async () => {},
  };
}
