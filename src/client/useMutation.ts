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
  | { kind: "conflict"; code: string; details: { field: string; reason: string }[] }
  | { kind: "unauthenticated" }
  | { kind: "forbidden"; details: { field: string; reason: string }[] }
  | { kind: "invalid"; details: { field: string; reason: string }[] }
  /** 422: 入力は正しいが、対象の今の状態では実行できない（状態遷移・未承認設定・添付未検査） */
  | { kind: "rejected"; code: string; details: { field: string; reason: string }[] }
  | { kind: "limited" }
  /** 結果不明: 反映されたか分からない。同じ内容なら同じ送信キーで再送でき、二重登録にならない */
  | { kind: "unknown" };

export function stateFromError(e: ApiError): MutationState {
  if (e.status === 401) return { kind: "unauthenticated" };
  if (e.status === 403 || e.status === 404) return { kind: "forbidden", details: e.details };
  if (e.status === 409) return { kind: "conflict", code: e.code, details: e.details };
  if (e.status === 429) return { kind: "limited" };
  if (e.status === 422) return { kind: "rejected", code: e.code, details: e.details };
  if (e.status === 400) return { kind: "invalid", details: e.details };
  return { kind: "unknown" }; // 0(通信断)/5xx/読めない応答
}

/**
 * 結果が確定していない送信の鍵（API＋内容ごと）。部品の外に置くので、401でログイン画面へ移って
 * フォームが消えても残る。同じ内容を送り直すと同じ鍵になり、サーバーが二重登録を防ぐ。
 * 成功、または確定した拒否で消す。ページの再読込では消える（端末への保存はPH6の端末下書きで扱う）。
 */
const pendingKeys = new Map<string, string>();
/** 試験用: 保留中の鍵を消す（試験同士が干渉しないように） */
export const _resetPendingKeysForTest = () => pendingKeys.clear();

export function useMutation<I extends ApiId>(id: I) {
  const [state, setState] = useState<MutationState>({ kind: "idle" });
  const inFlight = useRef(false);
  const abort = useRef<AbortController | null>(null);

  useEffect(() => () => abort.current?.abort(), []);

  const run = useCallback(
    async (input: ApiInput<I>): Promise<ApiResult<I> | undefined> => {
      if (inFlight.current) return undefined; // 保存中の二重タップは無視
      inFlight.current = true;
      setState({ kind: "saving" });
      const signature = `${id}:${JSON.stringify(input)}`;
      // 結果が確定していない同じ内容があれば同じ鍵で再送（サーバーが二重実行を防ぐ）。内容が違えば別の鍵
      const key = pendingKeys.get(signature) ?? newIdempotencyKey();
      pendingKeys.set(signature, key);
      abort.current = new AbortController();
      try {
        const result = await apiCall(id, input, { idempotencyKey: key, signal: abort.current.signal });
        pendingKeys.delete(signature);
        setState(result.status === 202 ? { kind: "processing" } : { kind: "saved" });
        return result;
      } catch (e) {
        if (e instanceof DOMException && e.name === "AbortError") return undefined;
        const err = e instanceof ApiError ? e : new ApiError(0, "RESPONSE_UNKNOWN");
        const next = stateFromError(err);
        // 確定した拒否(400/403/404/409/422)のときだけ、その内容の鍵を捨てる。結果不明の後の401(再ログイン)や
        // 429(待機)では、前回が実は反映済みかもしれないので同じ鍵を残す（他の内容の鍵には触れない）
        if (["invalid", "forbidden", "conflict", "rejected"].includes(next.kind)) pendingKeys.delete(signature);
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
