import { beforeAll, describe, expect, it } from "vitest";
import { DEMO_ACCOUNTS } from "../src/server/auth/demo-accounts";
import {
  DEMO_PHOTO_KEY,
  DEMO_PROFILE,
  DEMO_SEED_IDS,
  DEMO_UNIT_NAME,
  buildDemoAccountAugmentation,
  buildDemoSeedPlan,
  detectRealPersonalData,
  demoAdminPickSqlLiteral,
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

describe("デモ欠陥修正（T090・GitHub issues #1〜#7）", () => {
  it("approved_templates_point_at_versions_with_real_items", () => {
    // D1+D3: 様式は承認済み版を指し、版のitem_schemaは空でない（点検登録の様式選択と項目入力が始まる）
    const templates = rows.filter((r) => r.table === "inspection_templates").map(rowOf);
    const versions = rows.filter((r) => r.table === "inspection_template_versions").map(rowOf);
    expect(templates).toHaveLength(3);
    // 資産（車両・資機材）用の様式もあり、対象種別は3種ちょうど
    expect(new Set(templates.map((t) => t.target_type))).toEqual(new Set(["facility", "vehicle", "equipment"]));
    const versionByTemplate = new Map(versions.map((v) => [`${v.template_id}`, v]));
    for (const t of templates) {
      const v = versionByTemplate.get(String(t.id));
      expect(v, `${t.name} の版行`).toBeDefined();
      expect(v!.status).toBe("approved");
      const items = JSON.parse(String(v!.item_schema)) as { code: string; label: string; valueType: string; required: boolean }[];
      expect(items.length, `${t.name} の検査項目`).toBeGreaterThanOrEqual(2);
      for (const item of items) {
        expect(item.code.length).toBeGreaterThan(0);
        expect(item.label.length).toBeGreaterThan(0); // 項目labelは点検画面でそのまま見える実項目（空でないこと）
        expect(["boolean", "number", "text", "select"]).toContain(item.valueType);
      }
    }
    // rootはcurrent_version_idを承認版へ向ける（承認APIだけが書く列をseedも同じ形で設定する）
    const pointerUpdates = plan.groups.flat().filter((s) => s.sql.startsWith("UPDATE inspection_templates SET current_version_id"));
    expect(pointerUpdates).toHaveLength(3);
    for (const u of pointerUpdates) {
      const templateId = String(u.binds[1]);
      const v = versionByTemplate.get(templateId);
      expect(v, `様式 ${templateId} の版行`).toBeDefined();
      expect(String(u.binds[0])).toBe(String(v!.id));
    }
  });

  it("manual_issue_is_reported_until_confirmed", () => {
    // D5②: 手動起票の異常はreported（未確認）のまま残る（ホームの「確認待ち」=issues.status='reported'だけを数えるため）
    const manual = rows.filter((r) => r.table === "issues").map(rowOf).find((i) => String(i.title).includes("格納箱"));
    expect(manual, "手動起票の異常行").toBeDefined();
    expect(manual!.status).toBe("reported");
    expect(manual!.assignee_member_id).toBeNull(); // 未確認のうちは担当を持たない（docs/11の初期状態）
    expect(manual!.confirmed_category).toBeNull();
    const events = rows.filter((r) => r.table === "issue_events").map(rowOf).filter((e) => e.issue_id === manual!.id);
    expect(events).toHaveLength(1);
    expect(events[0]!.action).toBe("reported");
    expect(JSON.parse(String(events[0]!.after_json))).toEqual({ status: "reported" });
  });

  it("vehicle_inspection_schedule_is_overdue", () => {
    // D5③: 期限が過ぎた資産点検のscheduleがある（ホームの「点検期限」=next_due_date < 今日(JST)の件数のため。
    // seedのNOW固定2026-10-20より前の業務日を置く=いつ再seedしても超過している）
    const schedules = rows.filter((r) => r.table === "inspection_schedules").map(rowOf);
    expect(schedules).toHaveLength(1);
    const s = schedules[0]!;
    expect(s.vehicle_id).toBeTruthy(); // 対象は車両1（資産の点検期限の導線）
    expect(String(s.next_due_date) < "2026-10-20").toBe(true);
    expect(s.timezone).toBe("Asia/Tokyo");
    expect(Number(s.interval_days)).toBeGreaterThanOrEqual(1);
  });

  it("ai_review_candidate_is_pending_on_a_needs_review_inspection", () => {
    // D4: AIレビュー一覧に候補（pending）が乗る。源は「要確認」の点検（台本⑤の異常→AI提案）
    const evaluations = rows.filter((r) => r.table === "ai_evaluations").map(rowOf);
    expect(evaluations).toHaveLength(1);
    const e = evaluations[0]!;
    expect(e.status).toBe("pending");
    expect(e.source_type).toBe("facility_inspection");
    const needsReview = rows.filter((r) => r.table === "facility_inspections").map(rowOf).find((i) => i.result === "needs_review");
    expect(needsReview, "要確認の点検行").toBeDefined();
    expect(e.source_id).toBe(needsReview!.id);
    const output = JSON.parse(String(e.output_json)) as { answers?: { category?: { choice?: string } } };
    expect(typeof output.answers?.category?.choice).toBe("string");
    // 評価はjob経由で作られるためjob行もあり、成功済み（一覧は実行中の候補を出さない）
    const jobs = rows.filter((r) => r.table === "jobs").map(rowOf);
    const job = jobs.find((j) => j.id === e.job_id);
    expect(job).toBeDefined();
    expect(job!.status).toBe("succeeded");
    expect(job!.kind).toBe("ai.classify");
  });

  it("experience_accounts_and_owner_join_the_demo_after_account_creation", async () => {
    // D2+D4+D5: 体验3本とownerはdemoAccountStatementsの**後**に対象へ加わる（membersへのFKがあるため
    // planには書けない。増幅SQL=buildDemoAccountAugmentationをCLIが体験アカウント適用後に当てる）
    const aug = await buildDemoAccountAugmentation({ unitId: DEMO_SEED_IDS.unit });

    // --- 対象の拡充: 予定3本の出欠対象とお知らせ1件の対象を「その時の全団員（active）」へ広げる ---
    const activityIds = rows.filter((r) => r.table === "activities").map((r) => String(rowOf(r).id));
    expect(activityIds).toHaveLength(3);
    const audienceInserts = aug.audience.filter((s) => s.sql.startsWith("INSERT INTO activity_audience"));
    expect(audienceInserts).toHaveLength(3);
    for (const s of audienceInserts) {
      expect(s.sql).toContain("FROM members");
      expect(s.sql).toContain("NOT EXISTS");
      // 行IDは「予定×団員」で一意（_pk重複で適用が落ちない。実適用で発見した欠陥の回帰）
      expect(s.sql).toContain("'demo-aud-' || ? || '-' || m.id");
      expect(s.binds).toContain(DEMO_SEED_IDS.unit);
    }
    const coveredActivities = audienceInserts.map((s) => s.binds.find((b) => activityIds.includes(String(b))));
    expect(new Set(coveredActivities)).toEqual(new Set(activityIds));
    const announcementInserts = aug.audience.filter((s) => s.sql.startsWith("INSERT INTO announcement_audience"));
    expect(announcementInserts).toHaveLength(1);
    expect(announcementInserts[0]!.sql).toContain("NOT EXISTS");

    // --- 通知: 体験3本宛（1通だけ既読・ほかは未読）。ホームの「通知」=未読の自分宛 ---
    const notifInsert = aug.notification.find((s) => s.sql.startsWith("INSERT INTO notifications"));
    expect(notifInsert, "体験宛の通知行").toBeDefined();
    expect(notifInsert!.sql).toContain("NOT EXISTS");
    expect(notifInsert!.binds).toContain("approved");
    const recipients = aug.notification.filter((s) => s.sql.startsWith("INSERT INTO notification_recipients"));
    expect(recipients).toHaveLength(3);
    for (const account of DEMO_ACCOUNTS) {
      expect(recipients.some((s) => s.binds.includes(account.ids.member)), `${account.email} 宛`).toBe(true);
    }
    const readFlags = recipients.map((s) => {
      const cols = /\(([^)]*)\)/.exec(s.sql)![1]!.split(",").map((c) => c.trim());
      // SELECT部のトークンと列を対応付け、プレースホルダー（?）だけをbind位置として数える
      // （'inapp'や'human'はリテラルのためbind列は一つずれる）
      const selectSql = s.sql.slice(s.sql.indexOf("SELECT") + "SELECT".length, s.sql.indexOf("WHERE NOT EXISTS"));
      const tokens = selectSql.split(",").map((t) => t.trim());
      let bindIdx = 0;
      let readAtBind: unknown;
      tokens.forEach((tok, i) => {
        if (tok === "?") {
          if (cols[i] === "read_at") readAtBind = s.binds[bindIdx];
          bindIdx++;
        }
      });
      return readAtBind;
    });
    expect(readFlags.filter((r) => r != null)).toHaveLength(1); // 既読1通・未読2通

    // --- タスク: 体験団員の担当で進行中（ホームの「タスク」=自分の活動中タスク） ---
    const taskInsert = aug.task.find((s) => s.sql.startsWith("INSERT INTO tasks"));
    expect(taskInsert).toBeDefined();
    expect(taskInsert!.sql).toContain("NOT EXISTS");
    expect(taskInsert!.binds).toContain(DEMO_ACCOUNTS[2]!.ids.member); // demo-member の担当
    expect(taskInsert!.binds).toContain("in_progress");

    // --- 様式の補正（実環境の既存データへ当てる guarded 文。ローカルのplan済みデータには空振り） ---
    const templateInserts = aug.templates.filter((s) => s.sql.startsWith("INSERT INTO inspection_templates"));
    expect(templateInserts).toHaveLength(3); // 全様式（facilityは実環境に既存。vehicle/equipmentは新規）
    const versionInserts = aug.templates.filter((s) => s.sql.startsWith("INSERT INTO inspection_template_versions"));
    expect(versionInserts).toHaveLength(3);
    for (const s of versionInserts) expect(s.sql).toContain("json_array_length"); // 実項目を持つ版が無いときだけ足す
    const pointerUpdates = aug.templates.filter((s) => s.sql.startsWith("UPDATE inspection_templates SET current_version_id"));
    expect(pointerUpdates).toHaveLength(3);
    for (const s of pointerUpdates) {
      expect(s.sql).toContain("json_array_length"); // 実項目を持つ最新の承認版へ向ける
    }
  });

  it("admin_resolution_sql_orders_deterministically", () => {
    // D7: 管理者の解決はLIMIT 1の前に作成順（bootstrap由来=最初に作られた管理者）で並べ、環境で揺れないない
    const sql = demoAdminPickSqlLiteral("unit-x");
    expect(sql).toContain("ORDER BY m.created_at ASC, m.id ASC");
    expect(sql).toContain("LIMIT 1");
    expect(sql).toContain("unit-x");
  });
});
