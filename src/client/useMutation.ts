import { useCallback, useEffect, useRef, useState } from "react";
import { ApiError, apiCall, newIdempotencyKey, type ApiInput, type ApiResult } from "./api";
import type { ApiId } from "../shared/contracts/registry";

/**
 * 保存操作の状態。「保存済み」と見える状態は saved だけ。
 * 202(受付)は processing、409は conflict、通信断・応答不明は unknown で、いずれも保存済みとは表示しない。
 */
export type MutationState =
  | { kind: "idle" }
  | { kind: "saving" }
  | { kind: "processing" }
  | { kind: "saved" }
  | { kind: "conflict"; code: string }
  | { kind: "unauthenticated" }
  | { kind: "forbidden" }
  | { kind: "invalid"; details: { field: string; reason: string }[] }
  | { kind: "limited" }
  /** 結果不明: 反映されたか分からない。同じ内容なら同じ送信キーで再送でき、二重登録にならない */
  | { kind: "unknown" };

export function stateFromError(e: ApiError): MutationState {
  if (e.status === 401) return { kind: "unauthenticated" };
  if (e.status === 403 || e.status === 404) return { kind: "forbidden" };
  if (e.status === 409) return { kind: "conflict", code: e.code };
  if (e.status === 429) return { kind: "limited" };
  if (e.status === 400 || e.status === 422) return { kind: "invalid", details: e.details };
  return { kind: "unknown" }; // 0(通信断)/5xx/読めない応答
}

export function useMutation<I extends ApiId>(id: I) {
  const [state, setState] = useState<MutationState>({ kind: "idle" });
  const inFlight = useRef(false);
  const pendingKey = useRef<{ signature: string; key: string } | null>(null);
  const abort = useRef<AbortController | null>(null);

  useEffect(() => () => abort.current?.abort(), []);

  const run = useCallback(
    async (input: ApiInput<I>): Promise<ApiResult<I> | undefined> => {
      if (inFlight.current) return undefined; // 保存中の二重タップは無視
      inFlight.current = true;
      setState({ kind: "saving" });
      const signature = JSON.stringify(input);
      // 直前が「結果不明」で内容が同じなら同じ鍵で再送（サーバーが二重実行を防ぐ）。内容が変われば新しい鍵
      const key = pendingKey.current?.signature === signature ? pendingKey.current.key : newIdempotencyKey();
      abort.current = new AbortController();
      try {
        const result = await apiCall(id, input, { idempotencyKey: key, signal: abort.current.signal });
        pendingKey.current = null;
        setState(result.status === 202 ? { kind: "processing" } : { kind: "saved" });
        return result;
      } catch (e) {
        if (e instanceof DOMException && e.name === "AbortError") return undefined;
        const err = e instanceof ApiError ? e : new ApiError(0, "RESPONSE_UNKNOWN");
        const next = stateFromError(err);
        // 確定した拒否(400/403/404/409/422)のときだけ鍵を捨てる。結果不明の後の401(再ログイン)や429(待機)では、
        // 前回が実は反映済みかもしれないので、同じ内容なら同じ鍵を使い続ける（二重登録を防ぐ）
        const definitive = ["invalid", "forbidden", "conflict"].includes(next.kind);
        pendingKey.current = definitive ? null : (pendingKey.current?.signature === signature ? pendingKey.current : { signature, key });
        setState(next);
        return undefined;
      } finally {
        inFlight.current = false;
      }
    },
    [id],
  );

  const reset = useCallback(() => setState({ kind: "idle" }), []);
  return { state, run, reset, saving: state.kind === "saving" };
}
