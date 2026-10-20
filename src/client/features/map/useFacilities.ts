import { useCallback, useEffect, useRef, useState } from "react";
import { apiCall, type ApiInput } from "../../api";

/**
 * 施設の一覧取得（T021、docs/05 §5）。
 * 全cursorをたどるまで「部分取得」を表示し、応答の世代（reqNo）が古いものは破棄する。
 * 条件が変わったときは進行中の要求をabortして新しい世代だけを採用する（docs/05 §5「前世代応答を破棄」）。
 * **再取得（一覧を持っている間のreload/条件変更）は非破壊**（PH2-C15・T086）: 一覧を空にせず
 * 「loading」にも戻さず、新しい世代が全cursor完走したときだけ結果を差し替える。種別チップの
 * トグルで一覧が点滅しないための構造（件数を最新にする再取得の意図は保つ。docs/03 SCR-03）。
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
  // 現在の一覧の有無をeffectから読むための写し（effectの依存にitemsを置くと再取得が無限に走る）
  const itemsRef = useRef(items);
  itemsRef.current = items;

  const reload = useCallback(() => setTick((t) => t + 1), []);

  useEffect(() => {
    const generation = ++reqNo.current;

    const controller = new AbortController();
    // 再取得（既に一覧がある間のtick変更）では現在の表示を壊さない: 一覧を空にせず「loading」にも
    // 戻さず、新しい世代が完走したときだけ結果を差し替える（PH2-C15。種別チップのトグルは表示の
    // フィルタで、件数を最新にする再取得は裏で走る。prototypeでは一覧が点滅しない）。初回の読み込み
    // （一覧が無い）は従来どおり「loading」→ページごとの部分表示を通る（docs/05 §5）
    const initial = itemsRef.current.length === 0;
    if (initial) {
      setState("loading");
      setItems([]);
    }
    const current: FacilityItem[] = [];
    void (async () => {
      try {
        let cursor: string | undefined;
        for (;;) {
          const input: ApiInput<"API-10"> = { query: { ...query, limit: 200, cursor } };
          const res = await apiCall("API-10", input, { signal: controller.signal });
          if (generation !== reqNo.current) return; // 古い世代の応答は捨てる
          for (const row of res.data as unknown as FacilityItem[]) current.push(row);
          if (initial) {
            // 完走までは部分取得（docs/05 §5）。表示を止めないために途中から描画する
            setItems([...current]);
            setState("partial");
          }
          cursor = res.nextCursor;
          if (!cursor) break;
        }
        if (generation === reqNo.current) {
          setItems(current);
          setState("complete");
        }
      } catch (e) {
        if (e instanceof DOMException && e.name === "AbortError") return;
        // 再取得の失敗では最後の一覧を表示し続ける（NFR-09の縮退。空に戻さない）
        if (generation === reqNo.current) setState("error");
      }
    })();
    return () => controller.abort();
  }, [query.bbox, query.type, tick]);

  return { items, state, reload };
}

/** 種別の日本語ラベル・形・色。マーカーの字形（prototype の TYPES。9px/7px・格納箱は45°）。チップはTypeChip側の専用形を使う */
export const FACILITY_TYPES = {
  hydrant: { label: "消火栓", color: "#e8432a", icon: "fire_hydrant", radius: "50%", tf: "none" },
  cistern: { label: "防火水槽", color: "#2f7fe0", icon: "water_drop", radius: "9px", tf: "none" },
  box: { label: "格納箱", color: "#f08a24", icon: "inventory_2", radius: "7px", tf: "rotate(45deg) scale(.86)" },
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
