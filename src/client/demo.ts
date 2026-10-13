/**
 * 本物のデータ(API-01 Me / 所属)が接続されるまでの仮表示。すべて架空。
 * T008/T013 で API から取得する値に置き換える。実在の団体名・個人名は使わない。
 */
export const demoOrg = { unit: "架空市消防団", branch: "第一分団" };
export const demoProfile = { initial: "架", name: "架空 団員", detail: `${demoOrg.unit.replace("消防団", "")} ${demoOrg.branch} 第2班 · 団員`, role: "一般団員" };
