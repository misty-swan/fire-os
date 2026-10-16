// 画面台帳。SCR-01〜28 のパスは docs/03 と一致させる（試験が自動照合）。
// ナビの構成は prototype が正：スマホ=FireOS Prototype.dc.html の navDef/modules、PC=FireOS Desktop.dc.html の navGroups。
// 各画面の実装は ownerTask（docs/16）で行い、PH0では登録点とプレースホルダーだけを持つ。

/** スマホ下部ナビの5タブ（prototype: ホーム/マップ/予定・活動/AI/メニュー） */
export type NavTab = "home" | "map" | "activities" | "ai" | "menu";

export interface ScreenDef {
  id: string;
  path: string;
  title: string;
  /** PC(prototype Desktop)のヘッダーに出す画面名。無ければ title */
  desktopTitle?: string;
  /** 画面の目的（docs/03 の要約） */
  summary: string;
  ownerTask: string;
  phase: "PH1" | "PH2" | "PH3" | "PH4" | "PH5" | "PH6";
  /** どの下部ナビに属するか（サブ画面は親のタブを強調。prototypeのnavKeyと同じ考え方） */
  tab: NavTab;
  /** 点検登録のような全画面フロー。下部ナビを出さない（prototypeのinspect画面） */
  hideNav?: boolean;
  /** 別の入口パス（PCの一覧/詳細併置など）。画面の実体は同じ */
  aliases?: string[];
}

const s = (d: ScreenDef) => d;

// 並び順は重要：固定パス（new/import）を :id より先に登録する（docs/03 §3）
export const screens: ScreenDef[] = [
  s({ id: "SCR-01", path: "/login", title: "ログイン", summary: "招待受領、ログイン/再認証/MFA/回復、ログアウト", ownerTask: "T010", phase: "PH1", tab: "home" }),
  s({ id: "SCR-02", path: "/app", title: "ホーム", desktopTitle: "ダッシュボード", summary: "次回予定/本人未回答、確認待ち異常、点検期限、通知/自分タスク", ownerTask: "T047", phase: "PH3", tab: "home" }),
  s({ id: "SCR-03", path: "/app/map", title: "マップ", desktopTitle: "消防水利・施設マップ", summary: "地図/一覧、種類/位置確認/点検結果/番号検索、現在地", ownerTask: "T021", phase: "PH2", tab: "map" }),
  s({ id: "SCR-05", path: "/app/facilities/new", aliases: ["/app/facilities/:id/edit"], title: "施設の登録", summary: "種別/番号または識別名/緯度経度/目印/出典/写真", ownerTask: "T022", phase: "PH2", tab: "map" }),
  s({ id: "SCR-20", path: "/app/facilities/import", title: "施設CSV取込", summary: "CSVプレビュー、列/重複/座標エラー、確定/出力", ownerTask: "T024", phase: "PH2", tab: "map" }),
  s({ id: "SCR-04", path: "/app/facilities/:id", title: "施設の詳細", summary: "台帳/写真/位置出典/確認対象版/点検/異常、編集/位置確認/外部経路", ownerTask: "T022", phase: "PH2", tab: "map" }),
  s({ id: "SCR-06", path: "/app/facilities/:id/inspections/new", title: "点検登録", summary: "承認様式版/項目結果/実施日時/実施者/コメント/写真/異常起票", ownerTask: "T033", phase: "PH2", tab: "map", hideNav: true }),
  s({ id: "SCR-07", path: "/app/issues", title: "点検管理", summary: "未確認/確認中/対応中/対応実施/終了、起点点検、担当/理由/履歴", ownerTask: "T034", phase: "PH2", tab: "map" }),
  s({ id: "SCR-08", path: "/app/activities", title: "予定・活動", desktopTitle: "予定・出欠", summary: "予定/実績の一覧、日付/種別/参加者/状態/実参加/未回答検索", ownerTask: "T039", phase: "PH3", tab: "activities" }),
  s({ id: "SCR-10", path: "/app/activities/new", aliases: ["/app/activities/:id/edit"], title: "予定の登録", summary: "日時/場所/担当/対象者/回答期限", ownerTask: "T039", phase: "PH3", tab: "activities" }),
  s({ id: "SCR-09", path: "/app/activities/:id", title: "予定・活動の詳細", summary: "本人出欠/対象者、予定編集/中止、実績入力/訂正、使用資産/報告書", ownerTask: "T039", phase: "PH3", tab: "activities" }),
  s({ id: "SCR-19", path: "/app/reports/:id/draft", aliases: ["/app/reports"], title: "活動記録", desktopTitle: "活動記録・承認", summary: "生成依頼/処理中、下書き/不足欄、編集/版/承認/出力。PCは別入口 /app/reports の一覧から詳細へ遷移（併置はしない。§1.1-16①）", ownerTask: "T059", phase: "PH4", tab: "activities" }),
  s({ id: "SCR-11", path: "/app/incidents", title: "出動履歴", desktopTitle: "出動管理", summary: "種別/日時/状態一覧・登録", ownerTask: "T044", phase: "PH3", tab: "menu" }),
  s({ id: "SCR-22", path: "/app/incidents/new", title: "出動記録の登録", summary: "種別/発生日時/概要/関連活動/使用資産", ownerTask: "T044", phase: "PH3", tab: "menu" }),
  s({ id: "SCR-12", path: "/app/incidents/:id", title: "出動記録の詳細", summary: "概要/参集/帰還/関連活動/車両/機材/履歴・同期状態（出動モード=赤テーマ）", ownerTask: "T044", phase: "PH3", tab: "menu" }),
  s({ id: "SCR-13", path: "/app/assets", title: "車両・資機材", summary: "車両/資機材一覧、登録", ownerTask: "T026", phase: "PH2", tab: "menu" }),
  s({ id: "SCR-23", path: "/app/assets/:type/:id/inspection", title: "資産の点検登録", summary: "資産点検様式/明細/写真/コメント/訂正", ownerTask: "T033", phase: "PH2", tab: "menu", hideNav: true }),
  s({ id: "SCR-14", path: "/app/assets/:type/:id", title: "車両・資機材の詳細", summary: "台帳編集、点検/異常/使用履歴、期限", ownerTask: "T026", phase: "PH2", tab: "menu" }),
  s({ id: "SCR-15", path: "/app/members", title: "団員名簿", desktopTitle: "団員", summary: "名簿/所属/役職・許可項目、登録/変更/停止", ownerTask: "T013", phase: "PH1", tab: "menu" }),
  // お知らせ（T046）。作成・編集・詳細はSCR-16と同じ画面の別入口（docs/03に一覧のパスのみが載るためaliasesで登録。
  // 固定パスnewを:idより先に照合する並びはdocs/03 §3と同じ）
  s({ id: "SCR-16", path: "/app/announcements", aliases: ["/app/announcements/new", "/app/announcements/:id/edit", "/app/announcements/:id"], title: "お知らせ", summary: "作成/公開先/公開日時/版/閲覧/本人既読", ownerTask: "T046", phase: "PH3", tab: "menu" }),
  // タスク・通知（T052）。作成・詳細はSCR-21と同じ画面の別入口（お知らせSCR-16と同じ方式。
  // 固定パスnewを:idより先に照合する並びはdocs/03 §3と同じ）
  s({ id: "SCR-21", path: "/app/tasks-notifications", aliases: ["/app/tasks-notifications/notifications/new", "/app/tasks-notifications/notifications/:id"], title: "設定・通知", desktopTitle: "タスク・通知", summary: "業務タスク、通知draft/本文/対象/承認/配送失敗/既読", ownerTask: "T052", phase: "PH4", tab: "menu" }),
  s({ id: "SCR-24", path: "/app/documents", title: "文書・規程", summary: "許諾原本の登録/版/承認/撤回/ACL/閲覧", ownerTask: "T069", phase: "PH5", tab: "menu" }),
  s({ id: "SCR-25", path: "/app/patrol-plans", title: "巡回計画", summary: "対象施設/日/順序/計画案/人の確定", ownerTask: "T071", phase: "PH5", tab: "menu" }),
  s({ id: "SCR-26", path: "/app/analytics", title: "活動分析", summary: "月次/年度/団員別、元活動/出動/operation参照", ownerTask: "T060", phase: "PH4", tab: "menu" }),
  // AIレビュー（T055）。候補の詳細はSCR-18と同じ画面の別入口（お知らせSCR-16と同じ方式。単一件の
  // GET契約が無いため詳細は一覧から探す。docs/03 §2のSCR-18は一覧と詳細を含む1画面）
  s({ id: "SCR-18", path: "/app/ai/reviews", aliases: ["/app/ai/reviews/:id"], title: "AIレビュー", summary: "原文/AI候補/質問版/モデル版、差分、承認/編集/却下/タスク", ownerTask: "T055", phase: "PH4", tab: "ai" }),
  s({ id: "SCR-28", path: "/app/assistant", title: "AIアシスタント", summary: "権限付き横断検索/RAG、引用原文、書込/通知提案の確認", ownerTask: "T070", phase: "PH5", tab: "ai" }),
  s({ id: "SCR-27", path: "/app/sync", title: "同期の状況", summary: "端末下書き/未同期/応答不明/拒否/競合、手動再送/削除", ownerTask: "T077", phase: "PH6", tab: "menu" }),
  s({ id: "SCR-17", path: "/app/admin", title: "管理", summary: "招待/取消、roles/scopes、監査、費用/評価、点検様式版/承認、運用設定", ownerTask: "T013", phase: "PH1", tab: "menu" }),
];

/** SCR番号を持たないシェルの画面（ナビの一部）。docs/03「シェル」節。 */
export const shellScreens: ScreenDef[] = [
  s({ id: "SHELL-MENU", path: "/app/menu", title: "メニュー", summary: "プロフィール、機能への入口、ログアウト", ownerTask: "T005", phase: "PH1", tab: "menu" }),
  s({ id: "SHELL-HELP", path: "/app/help", title: "使い方ガイド", summary: "操作の説明（内容は完成版で整備）", ownerTask: "T086", phase: "PH6", tab: "menu" }),
];

/** スマホ下部ナビ。prototype の navDef をそのまま採用（AIタブの強調色だけ紫） */
export const bottomTabs: { tab: NavTab; path: string; label: string; icon: string }[] = [
  { tab: "home", path: "/app", label: "ホーム", icon: "home" },
  { tab: "map", path: "/app/map", label: "マップ", icon: "map" },
  { tab: "activities", path: "/app/activities", label: "予定・活動", icon: "calendar_month" },
  { tab: "ai", path: "/app/assistant", label: "AI", icon: "auto_awesome" },
  { tab: "menu", path: "/app/menu", label: "メニュー", icon: "menu" },
];

/**
 * スマホのメニュー画面のタイル。先頭8つは prototype の modules（団員名簿/車両・資機材/お知らせ/文書・規程/出動履歴/活動分析/設定・通知/使い方ガイド）。
 * 続く5つは prototype に入口が無いが docs/03 に画面がある機能（到達できない画面を作らないための追加）。
 * `danger` は prototype で出動履歴だけ赤いアイコンだったことに対応。
 */
export const menuTiles: { icon: string; label: string; path: string; danger?: boolean; extra?: boolean }[] = [
  { icon: "groups", label: "団員名簿", path: "/app/members" },
  { icon: "local_shipping", label: "車両・資機材", path: "/app/assets" },
  { icon: "campaign", label: "お知らせ", path: "/app/announcements" },
  { icon: "folder", label: "文書・規程", path: "/app/documents" },
  { icon: "e911_emergency", label: "出動履歴", path: "/app/incidents", danger: true },
  { icon: "insights", label: "活動分析", path: "/app/analytics" },
  { icon: "settings", label: "設定・通知", path: "/app/tasks-notifications" },
  { icon: "help", label: "使い方ガイド", path: "/app/help" },
  { icon: "fact_check", label: "点検管理", path: "/app/issues", extra: true },
  { icon: "upload_file", label: "施設CSV取込", path: "/app/facilities/import", extra: true },
  { icon: "route", label: "巡回計画", path: "/app/patrol-plans", extra: true },
  { icon: "rule", label: "AIレビュー", path: "/app/ai/reviews", extra: true },
  { icon: "sync", label: "同期の状況", path: "/app/sync", extra: true },
  { icon: "admin_panel_settings", label: "管理", path: "/app/admin", extra: true },
];

/**
 * PC左サイドバー。prototype Desktop の navGroups（OVERVIEW/OPERATIONS/ORGANIZATION）と同じ見出し・項目・アイコン。
 * ADMIN は prototype に入口が無い docs/03 の画面のための追加グループ。
 * crumb はヘッダーのパンくず（prototype の titles[v][0]）。
 */
export interface DesktopNavItem {
  label: string;
  icon: string;
  path: string;
  crumb: string;
}
export const desktopNavGroups: { heading: string; items: DesktopNavItem[] }[] = [
  { heading: "OVERVIEW", items: [{ label: "ダッシュボード", icon: "space_dashboard", path: "/app", crumb: "概要" }] },
  {
    heading: "OPERATIONS",
    items: [
      { label: "マップ・水利", icon: "map", path: "/app/map", crumb: "運用" },
      { label: "予定・出欠", icon: "calendar_month", path: "/app/activities", crumb: "運用" },
      { label: "活動記録", icon: "description", path: "/app/reports", crumb: "運用" },
      { label: "点検管理", icon: "fact_check", path: "/app/issues", crumb: "運用" },
      { label: "お知らせ", icon: "campaign", path: "/app/announcements", crumb: "運用" },
    ],
  },
  {
    heading: "ORGANIZATION",
    items: [
      { label: "団員", icon: "groups", path: "/app/members", crumb: "組織" },
      { label: "車両・資機材", icon: "local_shipping", path: "/app/assets", crumb: "組織" },
      { label: "文書・規程", icon: "folder", path: "/app/documents", crumb: "組織" },
      { label: "活動分析", icon: "insights", path: "/app/analytics", crumb: "分析" },
    ],
  },
  {
    heading: "ADMIN",
    items: [
      { label: "タスク・通知", icon: "task_alt", path: "/app/tasks-notifications", crumb: "運用" },
      { label: "施設CSV取込", icon: "upload_file", path: "/app/facilities/import", crumb: "運用" },
      { label: "巡回計画", icon: "route", path: "/app/patrol-plans", crumb: "運用" },
      { label: "AIレビュー", icon: "rule", path: "/app/ai/reviews", crumb: "運用" },
      { label: "同期の状況", icon: "sync", path: "/app/sync", crumb: "運用" },
      { label: "管理", icon: "admin_panel_settings", path: "/app/admin", crumb: "管理" },
    ],
  },
];
/** サイドバー最下部の赤枠ボタン（prototype「出動管理」。クリックで出動管理画面へ） */
export const dispatchNav = { label: "出動管理", icon: "e911_emergency", path: "/app/incidents", crumb: "災害" };

const allScreens = () => [...screens, ...shellScreens];

const toRegExp = (path: string) => new RegExp("^" + path.replace(/:[^/]+/g, "[^/]+") + "$");

/** パス → 画面。:param を含む定義・別入口(aliases)にも一致させる（固定パスを先に照合するので並びのまま探す） */
export function matchScreen(pathname: string): ScreenDef | undefined {
  const clean = pathname.replace(/\/+$/, "") || "/";
  return allScreens().find((sc) => [sc.path, ...(sc.aliases ?? [])].some((p) => toRegExp(p).test(clean)));
}

/** パス → PCサイドバーの項目（現在地の強調とパンくず用）。出動系の詳細は「出動管理」を強調 */
export function matchDesktopNav(pathname: string): DesktopNavItem | undefined {
  const clean = pathname.replace(/\/+$/, "") || "/";
  const all = [...desktopNavGroups.flatMap((g) => g.items), dispatchNav];
  const direct = all.find((n) => n.path === clean);
  if (direct) return direct;
  // /app/incidents/xxx のような配下は、一番長く前方一致する項目
  return all.filter((n) => n.path !== "/app" && clean.startsWith(n.path + "/")).sort((a, b) => b.path.length - a.path.length)[0];
}
