import { useCallback, useEffect, useState } from "react";
import type { ApiResponse } from "../../../shared/contracts/registry";
import { ApiError, apiCall } from "../../api";

export type MemberRow = ApiResponse<"API-02">[number];

export const STATUS_LABEL: Record<MemberRow["status"], string> = { active: "在団", paused: "休団", retired: "退団" };
export const ROLE_LABEL = { admin: "管理者", officer: "幹部", operator: "担当者", member: "一般団員" } as const;
export const ROLE_OPTIONS = ["member", "operator", "officer", "admin"] as const;

export type LoadState = { kind: "loading" } | { kind: "ready"; rows: MemberRow[] } | { kind: "error"; status: number };

/** 名簿の取得（管理画面と名簿で共有）。1分団30名未満なので1ページ(最大200)で足りる。再取得は reload。 */
export function useMembers() {
  const [state, setState] = useState<LoadState>({ kind: "loading" });
  const reload = useCallback(async () => {
    try {
      const rows: MemberRow[] = [];
      let cursor: string | undefined;
      // 200件を超えても欠落しないよう、次のページがあれば続けて取得する
      do {
        const r = await apiCall("API-02", { query: { limit: 200, ...(cursor ? { cursor } : {}) } });
        rows.push(...r.data);
        cursor = r.nextCursor;
      } while (cursor);
      setState({ kind: "ready", rows });
    } catch (e) {
      setState({ kind: "error", status: e instanceof ApiError ? e.status : 0 });
    }
  }, []);
  useEffect(() => {
    void reload();
  }, [reload]);
  return { state, reload };
}
