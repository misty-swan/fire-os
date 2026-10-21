import { beforeAll, describe, expect, it } from "vitest";
import {
  DEMO_PHOTO_KEY,
  DEMO_PROFILE,
  DEMO_SEED_IDS,
  DEMO_UNIT_NAME,
  buildDemoSeedPlan,
  detectRealPersonalData,
  FICTIONAL_EMAIL_DOMAINS,
  type DemoSeedPlan,
  type PrivacyRow,
} from "../scripts/seed-demo";

/**
 * 宮之浦（屋久島）の架空デモデータ（営業デモTask3。docs/superpowers/plans/2026-10-21-public-demo-miyanoura.md）。
 * 設計§8-2: 団体名は実名「宮之浦分団」だが、データ（氏名・施設・座標・地名）は**すべて架空**。
 * 実在の消火栓位置を写し取らないため、①座標は表示範囲（DEMO_BBOX）内の架空の点 ②番号は架空の
 * MY-/MZ-プリフィクス ③所在地は「（デモ用の架空地点）」付きの架空地名 ④氏名・メールはfixtures作法
 * （氏名は「架空」、メールは@example.test系）に固定する。seed計画は純関数（buildDemoSeedPlan）なので
 * DB無しで直接検査できる（実DBへの適用は tests/demo-isolation.test.ts がworkerdで行う）。
 */

/** 施設座標の収まりを検査する表示範囲。FacilityMarkers.tsxのDEMO_BBOXと同じ値（client側の tests/map-facilities.test.tsx が一致を固定） */
const DEMO_BBOX = { west: 130.64, south: 30.35, east: 130.7, north: 30.42 } as const;

interface PlanRow {
  table: string;
  cols: string[];
  binds: unknown[];
}

/** seed計画のINSERT文を（表・列・値）に展開する。UPDATE等の文は無視（行データではない） */
function planRows(plan: DemoSeedPlan): PlanRow[] {
  const rows: PlanRow[] = [];
  for (const group of plan.groups) {
    for (const stmt of group) {
      const m = /^INSERT INTO (\w+) \(([^)]*)\) VALUES /.exec(stmt.sql);
      if (m) rows.push({ table: m[1]!, cols: m[2]!.split(",").map((c) => c.trim()), binds: stmt.binds });
    }
  }
  return rows;
}

const rowOf = (r: PlanRow): Record<string, unknown> => Object.fromEntries(r.cols.map((c, i) => [c, r.binds[i]]));

let plan: DemoSeedPlan;
let rows: PlanRow[];
beforeAll(async () => {
  // createUnit: true（試験の空DBと同じ形）で全行を作らせる。adminMemberIdは通知・タスクの宛先にだけ使う値
  plan = await buildDemoSeedPlan({ unitId: DEMO_SEED_IDS.unit, adminMemberId: "seed-miyanoura-test-admin", createUnit: true, sequenceStart: 0 });
  rows = planRows(plan);
});

describe("宮之浦の架空デモseed（営業デモTask3）", () => {
  it("unit_name_is_the_real_miyanoura_brigade_with_a_fictional_sibling_unit", () => {
    // 設計§8-2: 団体名は実名「宮之浦分団」（架空である旨はDEMOバッジと台本で併記）
    expect(DEMO_UNIT_NAME).toBe("宮之浦分団");
    // 架空の姉妹分団（cross-unit分離のfixtures。名前も架空のまま）
    const unitNames = rows.filter((r) => r.table === "units").map((r) => rowOf(r).name);
    expect(unitNames).toHaveLength(2);
    expect(unitNames).toContain(DEMO_UNIT_NAME);
    for (const name of unitNames) expect(String(name)).toContain("宮之浦");
    expect(new Set(unitNames).size).toBe(2);
  });

  it("all_seed_facilities_fit_inside_the_demo_bbox_as_fictional_points", () => {
    const facilities = rows.filter((r) => r.table === "facilities").map(rowOf);
    expect(facilities).toHaveLength(DEMO_PROFILE.facilities);
    for (const f of facilities) {
      const lat = f.latitude as number;
      const lng = f.longitude as number;
      expect(lat, `${f.management_number} の緯度`).toBeGreaterThanOrEqual(DEMO_BBOX.south);
      expect(lat, `${f.management_number} の緯度`).toBeLessThanOrEqual(DEMO_BBOX.north);
      expect(lng, `${f.management_number} の経度`).toBeGreaterThanOrEqual(DEMO_BBOX.west);
      expect(lng, `${f.management_number} の経度`).toBeLessThanOrEqual(DEMO_BBOX.east);
    }
  });

  it("facilities_carry_fictional_numbers_names_and_locations", () => {
    const mine = rows.filter((r) => r.table === "facilities" && r.binds[r.cols.indexOf("unit_id")] === DEMO_SEED_IDS.unit).map(rowOf);
    const others = rows.filter((r) => r.table === "facilities" && r.binds[r.cols.indexOf("unit_id")] === DEMO_SEED_IDS.unit2).map(rowOf);
    // 宮之浦分団の12件は架空プリフィクスMY-・連番・所在地に架空地点の標識
    const numbers = mine.map((f) => f.management_number as string);
    expect(numbers).toEqual(Array.from({ length: mine.length }, (_, i) => `MY-${String(i + 1).padStart(4, "0")}`));
    // 第二分団の施設も架空プリフィクス。番号は全体で一意
    for (const f of others) expect(f.management_number as string).toMatch(/^MZ-\d{4}$/);
    const all = rows.filter((r) => r.table === "facilities").map(rowOf);
    expect(new Set(all.map((f) => f.management_number)).size).toBe(all.length);
    for (const f of all) {
      expect(String(f.identifying_name)).toContain("架空");
      // 実在の地点に読めない標識（fixtures作法の「架空」＋デモ用の架空地点）
      expect(String(f.location_note)).toContain("（デモ用の架空地点）");
      expect(String(f.location_note)).toContain("宮之浦");
    }
  });

  it("members_and_free_texts_stay_fictional_names_with_example_test_style_contacts", () => {
    const members = rows.filter((r) => r.table === "members").map(rowOf);
    expect(members).toHaveLength(DEMO_PROFILE.members);
    // 氏名はfixtures作法どおり「架空」を含む（実在の人物に読めない目印）。重複もしない
    const names = members.map((m) => m.display_name as string);
    for (const name of names) expect(name).toContain("架空");
    expect(new Set(names).size).toBe(names.length);
    for (const name of names) expect(name).not.toMatch(/\d{2,4}-\d{2,4}-\d{3,4}/); // 電話風の文字列を入れない
    // seed計画の全行をprivacy検出器に通す（実在domainのメール・「架空」無しの氏名/所在地は空のときだけ合格）
    const scan: PrivacyRow[] = rows.map((r) => {
      const values = rowOf(r);
      const { id, ...rest } = values;
      return { table: r.table, id: String(id), values: rest };
    });
    expect(scan.length).toBeGreaterThan(0);
    expect(detectRealPersonalData(scan)).toEqual([]);
    // seedが書くメール域は予約domainだけ（FICTIONAL_EMAIL_DOMAINS準拠）
    for (const domain of FICTIONAL_EMAIL_DOMAINS) expect(domain.startsWith("example.")).toBe(true);
  });

  it("plan_scale_and_assets_match_the_demo_profile", () => {
    for (const [table, count] of Object.entries(DEMO_PROFILE)) {
      expect(plan.stats[table], `${table} の件数`).toBe(count);
    }
    // 写真・文書の実体はdemo専用prefixのまま（実在の画像・文書を模さない決定的生成物）
    expect(plan.objects.map((o) => o.key)).toEqual([DEMO_PHOTO_KEY, "demo/document-01/original.pdf"]);
  });
});
