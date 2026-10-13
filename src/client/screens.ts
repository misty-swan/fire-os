// 画面台帳（docs/03 の SCR-01〜28）。パスは docs/03 と一致させる。
// 各画面の実装は ownerTask（docs/16）で行い、PH0では登録点とプレースホルダーだけを持つ。

export type NavTab = "home" | "map" | "activities" | "incidents" | "admin";

export interface ScreenDef {
  id: string;
  path: string;
  title: string;
  /** 画面の目的（docs/03 の要約） */
  summary: string;
  ownerTask: string;
  phase: "PH1" | "PH2" | "PH3" | "PH4" | "PH5" | "PH6";
  /** どの下部ナビに属するか（サブ画面は親のタブを強調。prototypeと同じ考え方） */
  tab: NavTab;
  /** メニュー（一覧）に出す画面。:id を含む詳細や新規作成は一覧から辿る */
  menu?: { group: string; icon: string; label: string };
}

const s = (d: ScreenDef) => d;

// 並び順は重要：固定パス（new/import）を :id より先に登録する（docs/03 §3）
export const screens: ScreenDef[] = [
  s({ id: "SCR-01", path: "/login", title: "ログイン", summary: "招待受領、ログイン/再認証/MFA/回復、ログアウト", ownerTask: "T010", phase: "PH1", tab: "home" }),
  s({ id: "SCR-02", path: "/app", title: "ホーム", summary: "次回予定/本人未回答、確認待ち異常、点検期限、通知/自分タスク", ownerTask: "T047", phase: "PH3", tab: "home", menu: { group: "日常", icon: "home", label: "ホーム" } }),
  s({ id: "SCR-03", path: "/app/map", title: "地図", summary: "地図/一覧、種類/位置確認/点検結果/番号検索、現在地", ownerTask: "T021", phase: "PH2", tab: "map", menu: { group: "日常", icon: "map", label: "地図・水利" } }),
  s({ id: "SCR-05", path: "/app/facilities/new", title: "施設の登録", summary: "種別/番号または識別名/緯度経度/目印/出典/写真", ownerTask: "T022", phase: "PH2", tab: "map" }),
  s({ id: "SCR-20", path: "/app/facilities/import", title: "施設CSV取込", summary: "CSVプレビュー、列/重複/座標エラー、確定/出力", ownerTask: "T024", phase: "PH2", tab: "map", menu: { group: "点検・資産", icon: "upload_file", label: "施設CSV取込" } }),
  s({ id: "SCR-04", path: "/app/facilities/:id", title: "施設の詳細", summary: "台帳/写真/位置出典/確認対象版/点検/異常、編集/位置確認/外部経路", ownerTask: "T022", phase: "PH2", tab: "map" }),
  s({ id: "SCR-06", path: "/app/facilities/:id/inspections/new", title: "施設の点検入力", summary: "承認様式版/項目結果/実施日時/実施者/コメント/写真/異常起票", ownerTask: "T033", phase: "PH2", tab: "map" }),
  s({ id: "SCR-07", path: "/app/issues", title: "異常一覧", summary: "未確認/確認中/対応中/対応実施/終了、起点点検、担当/理由/履歴", ownerTask: "T034", phase: "PH2", tab: "map", menu: { group: "点検・資産", icon: "report", label: "異常一覧" } }),
  s({ id: "SCR-08", path: "/app/activities", title: "予定・活動", summary: "予定/実績の一覧、日付/種別/参加者/状態検索", ownerTask: "T039", phase: "PH3", tab: "activities", menu: { group: "日常", icon: "calendar_month", label: "予定・活動" } }),
  s({ id: "SCR-10", path: "/app/activities/new", title: "予定の登録", summary: "日時/場所/担当/対象者/回答期限", ownerTask: "T039", phase: "PH3", tab: "activities" }),
  s({ id: "SCR-09", path: "/app/activities/:id", title: "予定・活動の詳細", summary: "本人出欠/対象者、予定編集/中止、実績入力/訂正、使用資産/報告書", ownerTask: "T039", phase: "PH3", tab: "activities" }),
  s({ id: "SCR-19", path: "/app/reports/:id/draft", title: "報告書の下書き", summary: "生成依頼/処理中、下書き/不足欄、編集/版/承認/出力", ownerTask: "T059", phase: "PH4", tab: "activities" }),
  s({ id: "SCR-11", path: "/app/incidents", title: "出動記録", summary: "種別/日時/状態一覧・登録", ownerTask: "T044", phase: "PH3", tab: "incidents", menu: { group: "日常", icon: "e911_emergency", label: "出動" } }),
  s({ id: "SCR-22", path: "/app/incidents/new", title: "出動記録の登録", summary: "種別/発生日時/概要/関連活動/使用資産", ownerTask: "T044", phase: "PH3", tab: "incidents" }),
  s({ id: "SCR-12", path: "/app/incidents/:id", title: "出動記録の詳細", summary: "概要/参集/帰還/関連活動/車両/機材/履歴・同期状態", ownerTask: "T044", phase: "PH3", tab: "incidents" }),
  s({ id: "SCR-13", path: "/app/assets", title: "車両・資機材", summary: "車両/資機材一覧、登録", ownerTask: "T026", phase: "PH2", tab: "admin", menu: { group: "点検・資産", icon: "local_shipping", label: "車両・資機材" } }),
  s({ id: "SCR-23", path: "/app/assets/:type/:id/inspection", title: "資産の点検入力", summary: "資産点検様式/明細/写真/コメント/訂正", ownerTask: "T033", phase: "PH2", tab: "admin" }),
  s({ id: "SCR-14", path: "/app/assets/:type/:id", title: "車両・資機材の詳細", summary: "台帳編集、点検/異常/使用履歴、期限", ownerTask: "T026", phase: "PH2", tab: "admin" }),
  s({ id: "SCR-15", path: "/app/members", title: "団員名簿", summary: "名簿/所属/役職・許可項目、登録/変更/停止", ownerTask: "T013", phase: "PH1", tab: "admin", menu: { group: "組織", icon: "groups", label: "団員名簿" } }),
  s({ id: "SCR-16", path: "/app/announcements", title: "お知らせ", summary: "作成/公開先/公開日時/版/閲覧/本人既読", ownerTask: "T046", phase: "PH3", tab: "admin", menu: { group: "連絡", icon: "campaign", label: "お知らせ" } }),
  s({ id: "SCR-21", path: "/app/tasks-notifications", title: "タスク・通知", summary: "業務タスク、通知draft/本文/対象/承認/配送失敗/既読", ownerTask: "T052", phase: "PH4", tab: "admin", menu: { group: "連絡", icon: "task_alt", label: "タスク・通知" } }),
  s({ id: "SCR-24", path: "/app/documents", title: "文書・規程", summary: "許諾原本の登録/版/承認/撤回/ACL/閲覧", ownerTask: "T069", phase: "PH5", tab: "admin", menu: { group: "組織", icon: "description", label: "文書・規程" } }),
  s({ id: "SCR-25", path: "/app/patrol-plans", title: "巡回計画", summary: "対象施設/日/順序/計画案/人の確定", ownerTask: "T071", phase: "PH5", tab: "admin", menu: { group: "組織", icon: "route", label: "巡回計画" } }),
  s({ id: "SCR-26", path: "/app/analytics", title: "活動分析", summary: "月次/年度/団員別、元活動/出動/operation参照", ownerTask: "T060", phase: "PH4", tab: "admin", menu: { group: "組織", icon: "insights", label: "活動分析" } }),
  s({ id: "SCR-18", path: "/app/ai/reviews", title: "AIレビュー", summary: "原文/AI候補/質問版/モデル版、差分、承認/編集/却下/タスク", ownerTask: "T055", phase: "PH4", tab: "admin", menu: { group: "AI・同期", icon: "auto_awesome", label: "AIレビュー" } }),
  s({ id: "SCR-28", path: "/app/assistant", title: "アシスタント", summary: "権限付き横断検索/RAG、引用原文、書込/通知提案の確認", ownerTask: "T070", phase: "PH5", tab: "admin", menu: { group: "AI・同期", icon: "forum", label: "アシスタント" } }),
  s({ id: "SCR-27", path: "/app/sync", title: "同期", summary: "端末下書き/未同期/応答不明/拒否/競合、手動再送/削除", ownerTask: "T077", phase: "PH6", tab: "admin", menu: { group: "AI・同期", icon: "sync", label: "同期の状況" } }),
  s({ id: "SCR-17", path: "/app/admin", title: "管理", summary: "招待/取消、roles/scopes、監査、費用/評価、点検様式版/承認、運用設定", ownerTask: "T013", phase: "PH1", tab: "admin", menu: { group: "管理", icon: "settings", label: "管理" } }),
];

/** 下部ナビ（docs/03 §1：ホーム/地図/予定・活動/出動/管理）。見た目はprototype、項目はdocs/03が正。 */
export const bottomTabs: { tab: NavTab; path: string; label: string; icon: string }[] = [
  { tab: "home", path: "/app", label: "ホーム", icon: "home" },
  { tab: "map", path: "/app/map", label: "地図", icon: "map" },
  { tab: "activities", path: "/app/activities", label: "予定・活動", icon: "calendar_month" },
  { tab: "incidents", path: "/app/incidents", label: "出動", icon: "e911_emergency" },
  { tab: "admin", path: "/app/admin", label: "管理", icon: "settings" },
];

/** パス → 画面。:param を含む定義にも一致させる（固定パスを先に照合するので screens の並びのまま探す） */
export function matchScreen(pathname: string): ScreenDef | undefined {
  const clean = pathname.replace(/\/+$/, "") || "/";
  return screens.find((sc) => {
    const re = new RegExp("^" + sc.path.replace(/:[^/]+/g, "[^/]+") + "$");
    return re.test(clean);
  });
}

export const menuGroups = (): { group: string; items: (ScreenDef & { menu: NonNullable<ScreenDef["menu"]> })[] }[] => {
  const groups = new Map<string, (ScreenDef & { menu: NonNullable<ScreenDef["menu"]> })[]>();
  for (const sc of screens) {
    if (!sc.menu) continue;
    const list = groups.get(sc.menu.group) ?? [];
    list.push(sc as ScreenDef & { menu: NonNullable<ScreenDef["menu"]> });
    groups.set(sc.menu.group, list);
  }
  return [...groups].map(([group, items]) => ({ group, items }));
};
