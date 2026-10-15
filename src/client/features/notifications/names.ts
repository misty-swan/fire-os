import { useEffect, useState } from "react";
import { api } from "../../api";

/**
 * 名簿の氏名対応（API-02。通知の対象者・作成者の表示に使う。T052）。
 * AnnouncementsPageのuseMemberNamesと同じ作り（読み込み中はIDを出さず「読み込み中…」を出す）。
 */
export type MemberNameMap = Map<string, string>;

export function useMemberNames(): MemberNameMap | null {
  const [names, setNames] = useState<MemberNameMap | null>(null);
  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const rows = (await api("API-02", { query: { limit: 200 } })) as unknown as { id: string; displayName: string }[];
        if (alive) setNames(new Map(rows.map((r) => [r.id, r.displayName])));
      } catch {
        if (alive) setNames(new Map());
      }
    })();
    return () => {
      alive = false;
    };
  }, []);
  return names;
}
