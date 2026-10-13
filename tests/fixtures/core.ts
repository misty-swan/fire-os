// 架空の団体・団員データ。実在の団体名・個人名・住所は使わない（公開リポジトリのため）。
export const FICTIONAL = {
  unitA: { name: "架空市 第一分団" },
  unitB: { name: "架空市 第二分団" },
  people: {
    admin: { displayName: "架空 管理者", rank: "分団長" },
    officer: { displayName: "架空 幹部", rank: "副分団長" },
    operator: { displayName: "架空 担当者", rank: "班長" },
    member: { displayName: "架空 団員", rank: "団員" },
    suspended: { displayName: "架空 停止者", rank: "団員" },
    unlinked: { displayName: "架空 未登録", rank: "団員" },
  },
} as const;

export const ROLE_IDS = {
  member: "00000000-0000-4000-8000-000000000101",
  operator: "00000000-0000-4000-8000-000000000102",
  officer: "00000000-0000-4000-8000-000000000103",
  admin: "00000000-0000-4000-8000-000000000104",
} as const;

export const FIXTURE_START = "2026-10-13T00:00:00.000Z";
