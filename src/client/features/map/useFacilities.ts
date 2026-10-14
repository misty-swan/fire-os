import { useCallback, useEffect, useRef, useState } from "react";
import { apiCall, type ApiInput } from "../../api";

/**
 * 施設の一覧取得（T021、docs/05 §5）。
 * 全cursorをたどるまで「部分取得」を表示し、応答の世代（reqNo）が古いものは破棄する。
 * 条件が変わったときは進行中の要求をabortして新しい世代だけを採用する（docs/05 §5「前世代応答を破棄」）。
 */

export interface FacilityItem {
  id: string;
  version: number;
  type: "hydrant" | "cistern" | "box";
  managementNumber: string | null;
  identifyingName: string | null;
  latitude: number;
  longitude: number;
  locationSource: string;
  locationNote: string;
  locationVersion: number;
  verificationStatus: "unverified" | "pending" | "verified" | "rejected";
  lastVerifiedAt: string | null;
  metadata: Record<string, unknown>;
}

export type FacilitiesState = "loading" | "partial" | "complete" | "error";

export interface FacilitiesQuery {
  bbox?: string;
  type?: "hydrant" | "cistern" | "box";
}

export function useFacilities(query: FacilitiesQuery): {
  items: FacilityItem[];
  state: FacilitiesState;
  reload: () => void;
} {
  const [items, setItems] = useState<FacilityItem[]>([]);
  const [state, setState] = useState<FacilitiesState>("loading");
  const [tick, setTick] = useState(0);
  const reqNo = useRef(0);

  const reload = useCallback(() => setTick((t) => t + 1), []);

  useEffect(() => {
    const generation = ++reqNo.current;

    const controller = new AbortController();
    const current: FacilityItem[] = [];
    setState("loading");
    setItems([]);
    void (async () => {
      try {
        let cursor: string | undefined;
        for (;;) {
          const input: ApiInput<"API-10"> = { query: { ...query, limit: 200, cursor } };
          const res = await apiCall("API-10", input, { signal: controller.signal });
          if (generation !== reqNo.current) return; // 古い世代の応答は捨てる
          for (const row of res.data as unknown as FacilityItem[]) current.push(row);
          // 完走までは部分取得（docs/05 §5）。表示を止めないために途中から描画する
          setItems([...current]);
          setState("partial");
          cursor = res.nextCursor;
          if (!cursor) break;
        }
        if (generation === reqNo.current) setState("complete");
      } catch (e) {
        if (e instanceof DOMException && e.name === "AbortError") return;
        if (generation === reqNo.current) setState("error");
      }
    })();
    return () => controller.abort();
  }, [query.bbox, query.type, tick]);

  return { items, state, reload };
}

/** 種別の日本語ラベル・形・色（prototype の TYPES と docs/03 のトークン） */
export const FACILITY_TYPES = {
  hydrant: { label: "消火栓", color: "#e8432a", icon: "fire_hydrant", radius: "50%", tf: "none" },
  cistern: { label: "防火水槽", color: "#2f7fe0", icon: "water_drop", radius: "4px", tf: "none" },
  box: { label: "格納箱", color: "#f08a24", icon: "inventory_2", radius: "3px", tf: "rotate(45deg) scale(.8)" },
} as const;

export type FacilityType = keyof typeof FACILITY_TYPES;

/** 施設の表示名（管理番号か識別名）。prototype の name に相当 */
export const facilityName = (f: FacilityItem): string =>
  f.type === "hydrant"
    ? `消火栓 ${f.managementNumber ?? f.identifyingName}`
    : f.type === "cistern"
      ? `防火水槽 ${f.managementNumber ?? f.identifyingName}`
      : `格納箱 ${f.managementNumber ?? f.identifyingName}`;

export const locationStatusLabel: Record<FacilityItem["verificationStatus"], { text: string; tone: "neutral" | "attention" | "ok" | "alert" }> = {
  unverified: { text: "未確認", tone: "neutral" },
  pending: { text: "確認中", tone: "attention" },
  verified: { text: "確認済", tone: "ok" },
  rejected: { text: "要修正", tone: "alert" },
};
