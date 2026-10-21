import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AppEnv } from "../src/server/env";
import { DEMO_ACCOUNTS, demoAccountStatements, generateDemoPassword } from "../src/server/auth/demo-accounts";
import { canonicalJson, sha256Hex } from "../src/server/mutations/hash";
import { stripJsonComments, type DeploymentConfig, type WranglerEnvConfig } from "./check-environment";
import type { SeedStatement } from "./seed-load";

/**
 * 公開デモの架空データseedと分離検査（T086、docs/13 RG-09、docs/07 §7「公開デモは架空人物/地点/写真のみ、
 * 本番/staging/demoを別Worker/D1/R2/Google key/AI設定へ分離する」）。
 *
 * - `seedDemo(env)`: 架空団員/施設/点検/異常/活動/出動/文書/写真だけを直接INSERTで作る（seed-load.tsと
 *   同じfixtures作法。mutation経路を通らないためoutbox〔domain_events〕はseed自身が作り、units.event_sequence
 *   も進める）。実デモ（`npm run demo`）では初回bootstrap直後にCLI（下記）が同じ計画をSQLへ適用する。
 *   **実データ（実名簿・実出動・非公開水利・現場写真）は一切入れない**（AGENTS.md）。
 * - `verifyDemoIsolation(config)`: demo環境の設定にproductionのD1/R2/Secret/tokenが現れないことと
 *   `npm run demo:reset` の射程を純関数で検査する。scripts/check-environment.ts（T078配置ゲート）が
 *   「4環境の資源共有・兼用」を静的に見るのに対し、こちらは「demoからproductionへ到達できるか・resetが
 *   他環境を壊さないか」のデモ運用の視点。実値（実wrangler.jsoncのパース結果）に対して使う。
 * - `collectDemoPrivacyRows` + `detectRealPersonalData`: seedした全行を走査し、fixtures作法（氏名は「架空」、
 *   メールは@example.test系、地名は架空）に沿わない実在風データを検出する。空の配列を返す恒真に
 *   しないため、走査は表ごとの行数（tests/demo-isolation.test.tsがDEMO_PROFILEと照合）で裏付けられる。
 * - CLI: `npx tsx scripts/seed-demo.ts --persist-to .wrangler/demo`（scripts/demo.ts の初回起動から呼ぶ）。
 *   workerd外ではenvが無いため、計画をSQLへ直列化して wrangler d1 execute / r2 object put で適用する。
 *   seed末尾で体験アカウント3本（src/server/auth/demo-accounts.ts。Task4）を独立に冪等で投入し、
 *   資格情報（生成したパスワード）を標準出力へ**一度だけ**JSONで表示する。`--demo-password <値>` で
 *   3本とも既知のパスワードにできる（demo:reset後に同じ資格情報へ戻すための運用。値はGitに書かない）。
 *   実環境（demo）への投入は `--remote --env demo --confirm demo`（Task5。`--wipe` で全表DROPからの
 *   週次リセット。.github/workflows/demo-reset.yml が cronで実行する。実環境への接続はしない。実行はTask 7）。
 */

// ============================================================================
// demo:reset の射程（scripts/demo.ts と共有する正本）
// ============================================================================

/** demoのローカルpersist先（`npm run demo` / `npm run demo:reset` が使う。Git管理外） */
export const DEMO_PERSIST_DIR = ".wrangler/demo";
/** 他環境のローカル状態。demo:reset が触れてはならない対象（e2eとlocal開発のpersist） */
export const OTHER_LOCAL_PERSIST_ROOTS = [".wrangler/state", ".wrangler/e2e"] as const;

/**
 * `npm run demo:reset`（scripts/demo.ts --reset）が削除するパスの一覧。**この配列がresetの射程の正本**
 * （demo.tsはこのリストどおりに削除する）。他環境のpersistやwrangler.jsonc等の設定ファイルを含んでは
 * ならない（productionの資源は実Cloudflare側にしか無く、ローカルのresetでは触れ得ないことも含む）。
 */
export function demoResetRemovals(): string[] {
  return [DEMO_PERSIST_DIR];
}

// ============================================================================
// 架空データの固定ID（seed-load.tsのblockIdと同じ発想。小文字UUID＝契約のId形）
// ============================================================================

const U = "00000000-0000-4000-8000-";
/** 宮之浦分団（実デモではbootstrap-adminが作ったunitを使うため、このIDは試験の空DBでだけ使われる） */
const DEMO_UNIT_ID = `${U}000000de0001`;
const DEMO_UNIT2_ID = `${U}000000de0002`;
const DEMO_OFFICER_USER = `${U}000000de0012`;
const DEMO_OPERATOR_USER = `${U}000000de0013`;
const DEMO_MEMBER_USER = `${U}000000de0014`;
/** 試験の空DB（createUnit）で作る管理者。実デモの管理者はbootstrap-adminが作る（ランダムID） */
const DEMO_ADMIN_USER = `${U}000000de0011`;
const DEMO_ADMIN_MEMBER = `${U}000000de0021`;
const DEMO_OFFICER_MEMBER = `${U}000000de0022`;
const DEMO_OPERATOR_MEMBER = `${U}000000de0023`;
const DEMO_MEMBER_MEMBER = `${U}000000de0024`;
/** 名簿の母数（user無しの団員。fixtures作法の「未登録団員」に相当） */
const ROSTER_COUNT = 10;
const rosterId = (i: number) => `${U}000000de003${i.toString(16)}`; // 1..10 → ...0031〜...003a（16進1桁）
const unit2Member1 = `${U}000000de0041`;
const unit2Member2 = `${U}000000de0042`;

const facilityId = (i: number) => `${U}000000de01${String(i).padStart(2, "0")}`; // 1..12 → 0101..0112
const DEMO_UNIT2_FACILITY = `${U}000000de0113`;
const TEMPLATE_ID = `${U}000000de0201`;
const TEMPLATE_VERSION_ID = `${U}000000de0202`;
const seriesId = (i: number) => `${U}000000de021${i}`;
const inspectionId = (i: number) => `${U}000000de022${i}`;
const ISSUE_1 = `${U}000000de0231`;
const ISSUE_2 = `${U}000000de0232`;
const VEHICLE_1 = `${U}000000de0241`;
const EQUIPMENT_1 = `${U}000000de0242`;
const EQUIPMENT_2 = `${U}000000de0243`;
const operationId = (i: number) => `${U}000000de025${i}`;
const activityId = (i: number) => `${U}000000de026${i}`;
const INCIDENT_1 = `${U}000000de0271`;
const resultId = (i: number) => `${U}000000de028${i}`;
const revisionId = (i: number) => `${U}000000de029${i}`;
const ANNOUNCEMENT_1 = `${U}000000de02a1`;
const ANNOUNCEMENT_REV_1 = `${U}000000de02a2`;
const NOTIFICATION_1 = `${U}000000de02b1`;
const REPORT_1 = `${U}000000de02b2`;
const REPORT_VERSION_1 = `${U}000000de02b3`;
const TASK_1 = `${U}000000de02c1`;
const TASK_2 = `${U}000000de02c2`;
const DOCUMENT_1 = `${U}000000de02d1`;
const DOCUMENT_VERSION_1 = `${U}000000de02d2`;
const PHOTO_ATTACHMENT = `${U}000000de02e1`;
const DOC_ATTACHMENT = `${U}000000de02e2`;
const PHOTO_LINK = `${U}000000de02e3`;
const DOC_LINK = `${U}000000de02e4`;
const chunkId = (i: number) => `${U}000000de02f${i}`;

/** migrationが固定IDで作る役割（drizzle/0001。tests/fixtures/core.tsと同じ値） */
const ROLE_IDS = {
  admin: `${U}000000000104`,
  officer: `${U}000000000103`,
  operator: `${U}000000000102`,
  member: `${U}000000000101`,
} as const;

/** 設計§8-2: 団体名は実名「宮之浦分団」。データはすべて架空（架空である旨はDEMOバッジと台本で併記） */
export const DEMO_UNIT_NAME = "宮之浦分団";
/** 架空の姉妹分団（cross-unit分離のfixtures。名前も架空） */
const DEMO_UNIT2_NAME = "宮之浦 第二分団（デモ用）";

/** 写真・文書原本のR2キー（demo専用prefix。実写真・実文書は入らない） */
export const DEMO_PHOTO_KEY = "demo/facility-photo-01.png";
export const DEMO_DOC_KEY = "demo/document-01/original.pdf";

const NOW = "2026-10-20T00:00:00.000Z";

/** tests/demo-isolation.test.ts が走査行数と照合する期待値（createUnit＝試験の空DB時の件数） */
export const DEMO_PROFILE = {
  units: 2,
  users: 4,
  members: 16,
  facilities: 13,
  inspection_templates: 1,
  facility_inspections: 6,
  issues: 2,
  vehicles: 1,
  equipment: 2,
  activities: 3,
  incidents: 1,
  announcements: 1,
  notifications: 1,
  reports: 1,
  tasks: 2,
  documents: 1,
} as const;

/** 試験が主要動線の到達確認に使うID（T086のR15チェックリストから参照される） */
export const DEMO_SEED_IDS = {
  unit: DEMO_UNIT_ID,
  unit2: DEMO_UNIT2_ID,
  adminUser: DEMO_ADMIN_USER,
  facility: facilityId(1),
  photoAttachment: PHOTO_ATTACHMENT,
  report: REPORT_1,
} as const;

// ============================================================================
// 決定的なダミー実体（写真PNG・文書PDF。実在の画像・文書を模さない小さな生成物）
// ============================================================================

const crcTable = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

const crc32 = (bytes: Uint8Array): number => {
  let c = 0xffffffff;
  for (const b of bytes) c = crcTable[(c ^ b) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};

const adler32 = (bytes: Uint8Array): number => {
  let a = 1;
  let b = 0;
  for (const v of bytes) {
    a = (a + v) % 65521;
    b = (b + a) % 65521;
  }
  return ((b << 16) | a) >>> 0;
};

const pngChunk = (type: string, data: Uint8Array): Uint8Array => {
  const out = new Uint8Array(12 + data.length);
  new DataView(out.buffer).setUint32(0, data.length);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(data, 8);
  new DataView(out.buffer).setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
  return out;
};

/** デモ用の架空写真（8x8単色のPNG。決定的に生成し、実在の写真は使わない） */
export function demoPhotoPng(): Uint8Array {
  const W = 8;
  const H = 8;
  const raw = new Uint8Array(H * (1 + W * 3));
  for (let y = 0; y < H; y++) {
    const off = y * (1 + W * 3);
    raw[off] = 0; // filter: None
    for (let x = 0; x < W; x++) {
      const p = off + 1 + x * 3;
      raw[p] = 0x2e;
      raw[p + 1] = 0x60;
      raw[p + 2] = 0x8e; // 架空の青系1色
    }
  }
  // zlib（header 0x78 0x01 + stored deflate 1 block + adler32）。圧縮せず格納するだけの正当なzlib stream
  const idat = new Uint8Array(2 + 5 + raw.length + 4);
  idat[0] = 0x78;
  idat[1] = 0x01;
  idat[2] = 0x01; // BFINAL=1, BTYPE=00（stored）
  new DataView(idat.buffer).setUint16(3, raw.length, true);
  new DataView(idat.buffer).setUint16(5, raw.length ^ 0xffff, true);
  idat.set(raw, 7);
  new DataView(idat.buffer).setUint32(7 + raw.length, adler32(raw));
  const ihdr = new Uint8Array(13);
  new DataView(ihdr.buffer).setUint32(0, W);
  new DataView(ihdr.buffer).setUint32(4, H);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // color type: RGB
  const sig = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdrChunk = pngChunk("IHDR", ihdr);
  const idatChunk = pngChunk("IDAT", idat);
  const iendChunk = pngChunk("IEND", new Uint8Array(0));
  const png = new Uint8Array(sig.length + ihdrChunk.length + idatChunk.length + iendChunk.length);
  png.set(sig, 0);
  png.set(ihdrChunk, sig.length);
  png.set(idatChunk, sig.length + ihdrChunk.length);
  png.set(iendChunk, sig.length + ihdrChunk.length + idatChunk.length);
  return png;
}

/** デモ用の架空文書原本（1頁のASCIIテキストだけの最小PDF。決定的に生成する） */
export function demoDocumentPdf(): Uint8Array {
  const content = "BT /F1 14 Tf 56 770 Td (FireOS demo document - fictional) Tj ET\n";
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>",
    `<< /Length ${content.length} >>\nstream\n${content}endstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  let body = "%PDF-1.4\n";
  const offsets: number[] = [];
  for (let i = 0; i < objects.length; i++) {
    offsets.push(body.length);
    body += `${i + 1} 0 obj\n${objects[i]}\nendobj\n`;
  }
  const xrefAt = body.length;
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const off of offsets) body += `${String(off).padStart(10, "0")} 00000 n \n`;
  body += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefAt}\n%%EOF\n`;
  return new TextEncoder().encode(body);
}

const bytesSha256Hex = async (bytes: Uint8Array): Promise<string> =>
  [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes as BufferSource))].map((b) => b.toString(16).padStart(2, "0")).join("");

// ============================================================================
// seed計画（純関数。試験のseedDemoとCLIのSQL生成で共有する）
// ============================================================================

export interface DemoSeedTargets {
  /** デモデータを付ける宮之浦分団のunit ID（実デモではbootstrap-adminが作ったunit） */
  unitId: string;
  /** 管理者団員（通知の宛先・自分のタスクの担当。実デモではbootstrap団員） */
  adminMemberId: string;
  /** unit・管理者が無い空DBで、この計画がunit1と管理者も作るか（試験のcreate mode） */
  createUnit: boolean;
  /** unit内のoutbox採番の現在値（seedはこの次から採番する） */
  sequenceStart: number;
}

export interface R2SeedObject {
  key: string;
  contentType: string;
  bytes: Uint8Array;
}

export interface DemoSeedPlan {
  groups: SeedStatement[][];
  objects: R2SeedObject[];
  stats: Record<string, number>;
}

const insert = (table: string, cols: string[], binds: unknown[]): SeedStatement => ({
  sql: `INSERT INTO ${table} (${cols.join(", ")}) VALUES (${cols.map(() => "?").join(", ")})`,
  binds,
});

/**
 * 架空完成版のseed計画（純関数）。行の内容はすべて架空データ（fixtures作法: 氏名は「架空」、
 * 地名は「宮之浦の架空地名（デモ用の架空地点）」、実在の座標・住所・メール・電話は入れない）。
 */
export async function buildDemoSeedPlan(targets: DemoSeedTargets): Promise<DemoSeedPlan> {
  const groups: SeedStatement[][] = [];
  const group = (stmts: SeedStatement[]) => groups.push(stmts);
  const stats: Record<string, number> = {};
  const unit = targets.unitId;
  // 全行の作成者はseedが作る架空の幹部（実デモでも在る固定ID。管理者は環境ごとに異なるため)
  const creator = DEMO_OFFICER_USER;

  // --- users（officer/operator/member は固定ID。管理者はcreate modeだけ） ---
  const users = [DEMO_OFFICER_USER, DEMO_OPERATOR_USER, DEMO_MEMBER_USER];
  if (targets.createUnit) users.unshift(DEMO_ADMIN_USER);
  group(
    users.map((id) =>
      insert("users", ["id", "auth_id", "status", "created_at", "updated_at"], [id, `auth-demo-${id.slice(-12)}`, "active", NOW, NOW]),
    ),
  );
  stats.users = users.length;

  // --- units（第二分団は常に作る＝fixturesの2unit作法。宮之浦分団はcreate modeだけ） ---
  const unitRows: SeedStatement[] = [
    insert("units", ["id", "name", "status", "created_at", "updated_at", "created_by", "actor_kind"],
      [DEMO_UNIT2_ID, DEMO_UNIT2_NAME, "active", NOW, NOW, creator, "human"]),
  ];
  if (targets.createUnit) {
    unitRows.unshift(
      insert("units", ["id", "name", "status", "created_at", "updated_at", "created_by", "actor_kind"],
        [unit, DEMO_UNIT_NAME, "active", NOW, NOW, creator, "human"]),
    );
  }
  group(unitRows);
  stats.units = targets.createUnit ? 2 : 1;

  // --- members + roles（4役割＋名簿10名＋第二分団2名。管理者だけ環境差し替え） ---
  // 氏名はfixtures作法どおり「架空」を含む明白な架空名（実在の人物と結び付かない。detectRealPersonalDataが検査する）
  const people: { memberId: string; userId: string | null; displayName: string; rank: string; role: keyof typeof ROLE_IDS | null }[] = [
    ...(targets.createUnit
      ? [{ memberId: DEMO_ADMIN_MEMBER, userId: DEMO_ADMIN_USER, displayName: "架空 岳志", rank: "分団長", role: "admin" as const }]
      : []),
    { memberId: DEMO_OFFICER_MEMBER, userId: DEMO_OFFICER_USER, displayName: "架空 潮見", rank: "副分団長", role: "officer" },
    { memberId: DEMO_OPERATOR_MEMBER, userId: DEMO_OPERATOR_USER, displayName: "架空 海斗", rank: "班長", role: "operator" },
    { memberId: DEMO_MEMBER_MEMBER, userId: DEMO_MEMBER_USER, displayName: "架空 森人", rank: "団員", role: "member" },
  ];
  const ROSTER_NAMES = [
    "架空 涼太", "架空 美海", "架空 大輔", "架空 千夏", "架空 健一",
    "架空 春香", "架空 翔太", "架空 由佳", "架空 浩二", "架空 直樹",
  ] as const;
  for (let i = 1; i <= ROSTER_COUNT; i++) {
    people.push({ memberId: rosterId(i), userId: null, displayName: ROSTER_NAMES[i - 1]!, rank: i % 3 === 0 ? "班長" : "団員", role: null });
  }
  const memberStmts: SeedStatement[] = [];
  for (const p of people) {
    memberStmts.push(
      insert("members", ["id", "unit_id", "user_id", "display_name", "rank", "status", "created_at", "updated_at", "created_by", "actor_kind"],
        [p.memberId, unit, p.userId, p.displayName, p.rank, "active", NOW, NOW, creator, "human"]),
    );
    if (p.role) {
      memberStmts.push(
        insert("member_roles", ["id", "unit_id", "member_id", "role_id", "granted_by", "created_at", "updated_at", "created_by", "actor_kind"],
          [crypto.randomUUID(), unit, p.memberId, ROLE_IDS[p.role], creator, NOW, NOW, creator, "human"]),
      );
    }
  }
  // 第二分団（最小構成。user無し）
  for (const [mid, name, rank] of [
    [unit2Member1, "架空 礒野", "分団長"],
    [unit2Member2, "架空 汐菜", "団員"],
  ] as const) {
    memberStmts.push(
      insert("members", ["id", "unit_id", "user_id", "display_name", "rank", "status", "created_at", "updated_at", "created_by", "actor_kind"],
        [mid, DEMO_UNIT2_ID, null, name, rank, "active", NOW, NOW, creator, "human"]),
    );
  }
  group(memberStmts);
  stats.members = people.length + 2;

  const rosterAll = people.map((p) => p.memberId); // 通知対象の母数（宮之浦分団の全団員）

  // --- 施設13（宮之浦周辺の**架空の点**。実在の消火栓位置を写し取らず、川・港・集落を意識した架空配置。
  //     番号・地名・座標はすべて架空（表示範囲DEMO_BBOX内。tests/seed-miyanoura.test.tsが範囲と標識を固定）） ---
  const FACILITY_SEED = [
    { type: "hydrant", number: "MY-0001", name: "架空の本町消火栓01", lat: 30.3795, lng: 130.6521, note: "宮之浦本町1-2（デモ用の架空地点）" },
    { type: "cistern", number: "MY-0002", name: "架空の港町防火水槽02", lat: 30.3862, lng: 130.6648, note: "宮之浦港町2-1（デモ用の架空地点）" },
    { type: "box", number: "MY-0003", name: "架空の川端格納箱03", lat: 30.381, lng: 130.659, note: "宮之浦川端町3-3（デモ用の架空地点）" },
    { type: "hydrant", number: "MY-0004", name: "架空の浜町消火栓04", lat: 30.3915, lng: 130.6675, note: "宮之浦浜町1-8（デモ用の架空地点）" },
    { type: "cistern", number: "MY-0005", name: "架空の緑ヶ丘防火水槽05", lat: 30.374, lng: 130.6455, note: "宮之浦緑ヶ丘4-2（デモ用の架空地点）" },
    { type: "box", number: "MY-0006", name: "架空の公民館格納箱06", lat: 30.3838, lng: 130.656, note: "宮之浦本町2-10（デモ用の架空地点）" },
    { type: "hydrant", number: "MY-0007", name: "架空の本町消火栓07", lat: 30.3782, lng: 130.6555, note: "宮之浦本町3-5（デモ用の架空地点）" },
    { type: "cistern", number: "MY-0008", name: "架空の川尻防火水槽08", lat: 30.3878, lng: 130.662, note: "宮之浦川端町1-1（デモ用の架空地点）" },
    { type: "box", number: "MY-0009", name: "架空の小学校格納箱09", lat: 30.3805, lng: 130.6478, note: "宮之浦緑ヶ丘2-6（デモ用の架空地点）" },
    { type: "hydrant", number: "MY-0010", name: "架空の港通消火栓10", lat: 30.3855, lng: 130.667, note: "宮之浦港町1-4（デモ用の架空地点）" },
    { type: "cistern", number: "MY-0011", name: "架空の栄町防火水槽11", lat: 30.3758, lng: 130.663, note: "宮之浦栄町5-2（デモ用の架空地点）" },
    { type: "box", number: "MY-0012", name: "架空の浜格納箱12", lat: 30.393, lng: 130.66, note: "宮之浦浜町3-1（デモ用の架空地点）" },
  ] as const;
  const facilityIds: string[] = [];
  const facilityGroup: SeedStatement[] = [];
  for (const [i, f] of FACILITY_SEED.entries()) {
    const id = facilityId(i + 1);
    facilityIds.push(id);
    facilityGroup.push(
      insert("facilities",
        ["id", "unit_id", "type", "management_number", "identifying_name", "latitude", "longitude",
          "location_note", "location_source", "location_version", "verification_status", "last_verified_at", "metadata",
          "created_at", "updated_at", "created_by", "actor_kind"],
        [id, unit, f.type, f.number, f.name, f.lat, f.lng,
          f.note, "架空の台帳（デモseed）", 1, "verified", NOW, "{}",
          NOW, NOW, creator, "human"]),
    );
  }
  facilityGroup.push(
    insert("facilities",
      ["id", "unit_id", "type", "management_number", "identifying_name", "latitude", "longitude",
        "location_note", "location_source", "location_version", "verification_status", "last_verified_at", "metadata",
        "created_at", "updated_at", "created_by", "actor_kind"],
      [DEMO_UNIT2_FACILITY, DEMO_UNIT2_ID, "hydrant", "MZ-0001", "架空の二分団消火栓01",
        30.3905, 130.642, "宮之浦西浜1-1（デモ用の架空地点）", "架空の台帳（デモseed）", 1, "verified", NOW, "{}",
        NOW, NOW, creator, "human"]),
  );
  group(facilityGroup);
  stats.facilities = 13;

  // --- 点検様式（承認済み版。item_schemaは空の検証用） ---
  group([
    insert("inspection_templates", ["id", "unit_id", "name", "target_type", "status", "created_at", "updated_at", "created_by", "actor_kind"],
      [TEMPLATE_ID, unit, "架空の施設点検様式（デモ）", "facility", "active", NOW, NOW, creator, "human"]),
    insert("inspection_template_versions", ["id", "unit_id", "template_id", "revision_no", "item_schema", "status",
      "approved_by_member_id", "approved_at", "created_at", "updated_at", "created_by", "actor_kind"],
      [TEMPLATE_VERSION_ID, unit, TEMPLATE_ID, 1, "[]", "approved", DEMO_OFFICER_MEMBER, NOW, NOW, NOW, creator, "human"]),
  ]);
  stats.inspection_templates = 1;

  // --- 点検（最初の6施設に月次点検。2件は要確認） ---
  const inspectionGroup: SeedStatement[] = [];
  const inspectedAt = (i: number) => `2026-${String(((i * 2) % 9) + 3).padStart(2, "0")}-05T02:00:00.000Z`;
  for (let i = 1; i <= 6; i++) {
    const sid = seriesId(i);
    const iid = inspectionId(i);
    const needsReview = i >= 5;
    inspectionGroup.push(
      insert("inspection_series", ["id", "unit_id", "facility_id", "current_facility_inspection_id", "created_at", "updated_at", "created_by", "actor_kind"],
        [sid, unit, facilityIds[i - 1]!, iid, NOW, NOW, creator, "human"]),
      insert("facility_inspections",
        ["id", "unit_id", "series_id", "facility_id", "template_version_id", "inspector_member_id", "inspected_at",
          "result", "note", "location_version", "created_at", "updated_at", "created_by", "actor_kind"],
        [iid, unit, sid, facilityIds[i - 1]!, TEMPLATE_VERSION_ID, people[i % people.length]!.memberId,
          inspectedAt(i), needsReview ? "needs_review" : "ok",
          `点検を実施した（架空・デモ）。${needsReview ? "劣化が見えるため要確認。" : "問題はなかった。"}`,
          1, NOW, NOW, creator, "human"]),
    );
  }
  group(inspectionGroup);
  stats.facility_inspections = 6;

  // --- 異常2件（1件は点検起点、1件は手動起票） ---
  group([
    insert("issues",
      ["id", "unit_id", "facility_id", "source_facility_inspection_id", "title", "description", "reported_by", "assignee_member_id",
        "status", "confirmed_category", "version", "created_at", "updated_at", "created_by", "actor_kind"],
      [ISSUE_1, unit, facilityIds[4]!, inspectionId(5), "架空の防火水槽の劣化（デモ）",
        "宮之浦緑ヶ丘の点検で口径の劣化を確認した（架空の記録）。交換の検討が必要。", creator, DEMO_OFFICER_MEMBER,
        "under_review", "劣化", 1, NOW, NOW, creator, "human"]),
    insert("issue_events", ["id", "unit_id", "issue_id", "action", "before_json", "after_json", "note", "actor_user_id", "actor_kind", "created_at"],
      [crypto.randomUUID(), unit, ISSUE_1, "reported", "{}", JSON.stringify({ status: "under_review" }), "デモseedによる架空の起票", creator, "human", NOW]),
    insert("issues",
      ["id", "unit_id", "facility_id", "title", "description", "reported_by", "assignee_member_id",
        "status", "confirmed_category", "version", "created_at", "updated_at", "created_by", "actor_kind"],
      [ISSUE_2, unit, facilityIds[5]!, "架空の格納箱の蓋の破損（デモ）",
        "本町公民館の巡回中に格納箱の蓋の破損を確認した（架空の記録）。仮覆いを設置済み。", creator, DEMO_OPERATOR_MEMBER,
        "in_progress", "破損", 1, NOW, NOW, creator, "human"]),
    insert("issue_events", ["id", "unit_id", "issue_id", "action", "before_json", "after_json", "note", "actor_user_id", "actor_kind", "created_at"],
      [crypto.randomUUID(), unit, ISSUE_2, "status_changed", JSON.stringify({ status: "reported" }), JSON.stringify({ status: "in_progress" }), null, creator, "human", NOW]),
  ]);
  stats.issues = 2;

  // --- 車両・機材 ---
  group([
    insert("vehicles", ["id", "unit_id", "asset_code", "name", "status", "storage_facility_id", "version", "created_at", "updated_at", "created_by", "actor_kind"],
      [VEHICLE_1, unit, "DV-0001", "架空の資機材運搬車01", "active", facilityIds[8]!, 1, NOW, NOW, creator, "human"]),
    insert("equipment", ["id", "unit_id", "asset_code", "name", "quantity", "quantity_unit", "status", "storage_facility_id", "version", "created_at", "updated_at", "created_by", "actor_kind"],
      [EQUIPMENT_1, unit, "DE-0001", "架空の消火ホース（20m）", 20, "本", "active", facilityIds[8]!, 1, NOW, NOW, creator, "human"]),
    insert("equipment", ["id", "unit_id", "asset_code", "name", "quantity", "quantity_unit", "status", "storage_facility_id", "version", "created_at", "updated_at", "created_by", "actor_kind"],
      [EQUIPMENT_2, unit, "DE-0002", "架空の投光器", 4, "台", "active", facilityIds[9]!, 1, NOW, NOW, creator, "human"]),
  ]);
  stats.vehicles = 1;
  stats.equipment = 2;

  // --- 活動×3（1件は今後の予定、2件は完了＝実績と実参加つき） ---
  const activityPlans = [
    { i: 1, title: "架空の防災訓練（宮之浦・予定）", scheduled: true, planned: "2026-12-05T01:00:00.000Z", attendees: 6 },
    { i: 2, title: "架空の水防訓練（宮之浦川）", scheduled: false, planned: "2026-06-13T01:00:00.000Z", attendees: 12 },
    { i: 3, title: "架空の夜間機材点検訓練", scheduled: false, planned: "2026-08-08T01:00:00.000Z", attendees: 10 },
  ] as const;
  const attendanceIds: string[] = [];
  for (const a of activityPlans) {
    const opId = operationId(a.i);
    const actId = activityId(a.i);
    const stmts: SeedStatement[] = [
      insert("operations", ["id", "unit_id", "kind", "status", "countable", "created_at", "updated_at", "created_by", "actor_kind"],
        [opId, unit, "activity", a.scheduled ? "scheduled" : "completed", 1, NOW, NOW, creator, "human"]),
      insert("activities", ["id", "unit_id", "operation_id", "title", "kind", "planned_starts_at", "location_text",
        "owner_member_id", "status", "created_at", "updated_at", "created_by", "actor_kind"],
        [actId, unit, opId, a.title, "training", a.planned, "宮之浦本町公園の架空広場（デモ）", DEMO_OFFICER_MEMBER,
          a.scheduled ? "scheduled" : "completed", NOW, NOW, creator, "human"]),
    ];
    for (const memberId of rosterAll) {
      stmts.push(insert("activity_audience", ["id", "unit_id", "activity_id", "member_id", "actor_user_id", "actor_kind", "created_at"],
        [crypto.randomUUID(), unit, actId, memberId, creator, "human", NOW]));
    }
    // 出欠（ attendees 人が回答。種類は固定パターン）
    for (let k = 0; k < a.attendees; k++) {
      const memberId = rosterAll[k % rosterAll.length]!;
      const response = (["attending", "absent", "undecided"] as const)[k % 3]!;
      const attId = crypto.randomUUID();
      attendanceIds.push(attId);
      stmts.push(insert("activity_attendance",
        ["id", "unit_id", "activity_id", "member_id", "response", "responded_at", "created_at", "updated_at", "created_by", "actor_kind"],
        [attId, unit, actId, memberId, response, NOW, NOW, NOW, creator, "human"]));
    }
    if (!a.scheduled) {
      // 実績（root→revisionの循環参照は同一batchで解消。seed-loadと同じ方式）
      const rid = resultId(a.i);
      const rev = revisionId(a.i);
      const endsAt = a.planned.replace("T01:00:00.000Z", "T04:00:00.000Z");
      stmts.push(
        insert("activity_results", ["id", "unit_id", "activity_id", "current_revision_id", "created_at", "updated_at", "created_by", "actor_kind"],
          [rid, unit, actId, null, NOW, NOW, creator, "human"]),
        insert("activity_result_revisions", ["id", "unit_id", "result_id", "revision_no", "actual_starts_at", "actual_ends_at",
          "content", "actor_user_id", "actor_kind", "created_at"],
          [rev, unit, rid, 1, a.planned, endsAt, `架空の活動実績（デモ）。${a.title}を実施し、記録を整理した。`, creator, "human", NOW]),
        { sql: "UPDATE activity_results SET current_revision_id = ? WHERE id = ? AND unit_id = ?", binds: [rev, rid, unit] },
      );
      for (let k = 0; k < a.attendees; k += 3) {
        stmts.push(insert("activity_actual_participants",
          ["id", "unit_id", "result_revision_id", "member_id", "actual_status", "created_at", "created_by", "actor_kind"],
          [crypto.randomUUID(), unit, rev, rosterAll[k % rosterAll.length]!, "participated", NOW, creator, "human"]));
      }
    }
    group(stmts);
  }
  stats.activities = activityPlans.length;

  // --- 出動1件（訓練の記録。参集の時間列は順序CHECKを満たす） ---
  const incidentOp = operationId(4);
  group([
    insert("operations", ["id", "unit_id", "kind", "status", "countable", "created_at", "updated_at", "created_by", "actor_kind"],
      [incidentOp, unit, "incident", "closed", 1, NOW, NOW, creator, "human"]),
    insert("incidents", ["id", "unit_id", "operation_id", "kind", "occurred_at", "summary", "status", "version", "created_at", "updated_at", "created_by", "actor_kind"],
      [INCIDENT_1, unit, incidentOp, "training", "2026-07-18T01:00:00.000Z",
        "宮之浦港周辺での架空の出動訓練（デモ。夜間の水防訓練を記録したもの）", "closed", 1, NOW, NOW, creator, "human"]),
    insert("incident_events", ["id", "unit_id", "incident_id", "action", "before_json", "after_json", "reason", "actor_user_id", "actor_kind", "created_at"],
      [crypto.randomUUID(), unit, INCIDENT_1, "recorded", "{}", JSON.stringify({ status: "closed" }), null, creator, "human", NOW]),
    ...[0, 1, 2, 3, 4].map((k) =>
      insert("incident_participants",
        ["id", "unit_id", "incident_id", "member_id", "attendance_status", "mobilized_at", "arrived_at", "returned_at", "version", "created_at", "updated_at", "created_by", "actor_kind"],
        [crypto.randomUUID(), unit, INCIDENT_1, rosterAll[k]!, "returned",
          "2026-07-18T01:05:00.000Z", "2026-07-18T01:20:00.000Z", "2026-07-18T04:00:00.000Z", 1, NOW, NOW, creator, "human"]),
    ),
  ]);
  stats.incidents = 1;

  // --- お知らせ1件（公開済み。対象は宮之浦分団の全団員） ---
  const audienceSnapshot = JSON.stringify([...rosterAll].sort());
  group([
    insert("announcements", ["id", "unit_id", "title", "body", "revision_no", "status", "published_at", "version", "created_at", "updated_at", "created_by", "actor_kind"],
      [ANNOUNCEMENT_1, unit, "架空の訓練日程のお知らせ（デモ）",
        "12月の防災訓練の日程を案内する（架空のデモ文言）。集合は宮之浦本町公園。出席可否は活動の出欠から回答してください。",
        1, "published", "2026-10-01T00:00:00.000Z", 1, NOW, NOW, creator, "human"]),
    insert("announcement_revisions", ["id", "unit_id", "announcement_id", "revision_no", "title", "body", "audience_snapshot", "actor_user_id", "actor_kind", "created_at"],
      [ANNOUNCEMENT_REV_1, unit, ANNOUNCEMENT_1, 1, "架空の訓練日程のお知らせ（デモ）",
        "12月の防災訓練の日程を案内する（架空のデモ文言）。集合は宮之浦本町公園。出席可否は活動の出欠から回答してください。",
        audienceSnapshot, creator, "human", NOW]),
    ...rosterAll.map((memberId) =>
      insert("announcement_audience", ["id", "unit_id", "announcement_id", "member_id", "actor_user_id", "actor_kind", "created_at"],
        [crypto.randomUUID(), unit, ANNOUNCEMENT_1, memberId, creator, "human", NOW]),
    ),
  ]);
  stats.announcements = 1;

  // --- 通知1件（承認済み。宛先は管理者団員だけ＝デモの管理者の受信箱に1通） ---
  const audienceHash = await sha256Hex(canonicalJson([targets.adminMemberId]));
  group([
    insert("notifications",
      ["id", "unit_id", "source_type", "source_id", "body_revision", "audience_hash", "status", "approved_by", "approved_at", "version", "last_mutation_token", "created_at", "updated_at", "created_by", "actor_kind"],
      [NOTIFICATION_1, unit, "activity", activityId(1), JSON.stringify({ body: "架空の防災訓練（12月・本町公園）の出欠を回答してください（デモ通知）。" }),
        audienceHash, "approved", creator, "2026-10-02T00:00:00.000Z", 1, crypto.randomUUID(), NOW, NOW, creator, "human"]),
    insert("notification_recipients", ["id", "unit_id", "notification_id", "member_id", "channel", "address_ref", "actor_user_id", "actor_kind", "created_at"],
      [crypto.randomUUID(), unit, NOTIFICATION_1, targets.adminMemberId, "inapp", `member:${targets.adminMemberId}#inbox`, creator, "human", NOW]),
    insert("notification_events", ["id", "unit_id", "notification_id", "action", "details", "actor_user_id", "actor_kind", "created_at"],
      [crypto.randomUUID(), unit, NOTIFICATION_1, "approved", JSON.stringify({ audienceCount: 1, channels: "inapp" }), creator, "human", NOW]),
  ]);
  stats.notifications = 1;

  // --- 帳票1件（承認済み版。管理者（担当外）にも見えるようにcurrent_approved_version_idを向ける） ---
  group([
    insert("reports", ["id", "unit_id", "activity_id", "kind", "current_draft_version_id", "current_approved_version_id", "version", "last_mutation_token", "created_at", "updated_at", "created_by", "actor_kind"],
      [REPORT_1, unit, activityId(2), "manual", null, null, 1, crypto.randomUUID(), NOW, NOW, creator, "human"]),
    insert("report_versions",
      ["id", "unit_id", "report_id", "template_version", "revision_no", "text", "missing_fields", "source_versions", "model_id", "status", "approved_by", "approved_at", "version", "last_mutation_token", "created_at", "updated_at", "created_by", "actor_kind"],
      [REPORT_VERSION_1, unit, REPORT_1, "test-activity-v1", 1,
        "架空の活動報告（デモ）。宮之浦川の水防訓練を実施し、参加団員と記録を整理した。",
        "[]", JSON.stringify({ activityVersion: 1, resultVersion: 1, resultRevisionNo: 1 }),
        null, "approved", DEMO_OFFICER_MEMBER, "2026-06-20T00:00:00.000Z", 1, crypto.randomUUID(), NOW, NOW, creator, "human"]),
    { sql: "UPDATE reports SET current_approved_version_id = ? WHERE id = ? AND unit_id = ?", binds: [REPORT_VERSION_1, REPORT_1, unit] },
    insert("content_version_events", ["id", "unit_id", "report_version_id", "action", "reason", "actor_user_id", "actor_kind", "created_at"],
      [crypto.randomUUID(), unit, REPORT_VERSION_1, "approved", null, creator, "human", "2026-06-20T00:00:00.000Z"]),
  ]);
  stats.reports = 1;

  // --- 業務タスク2件（1件は管理者の担当で進行中＝/tasks/meに現れる） ---
  group([
    insert("tasks", ["id", "unit_id", "source_issue_id", "title", "assignee_member_id", "status", "due_date", "version", "created_at", "updated_at", "created_by", "actor_kind"],
      [TASK_1, unit, ISSUE_1, "架空の異常確認（デモ）", targets.adminMemberId, "in_progress", "2026-10-25", 1, NOW, NOW, creator, "human"]),
    insert("tasks", ["id", "unit_id", "title", "assignee_member_id", "status", "due_date", "version", "created_at", "updated_at", "created_by", "actor_kind"],
      [TASK_2, unit, "架空の資機材棚卸し（デモ）", DEMO_OFFICER_MEMBER, "done", "2026-09-30", 1, NOW, NOW, creator, "human"]),
  ]);
  stats.tasks = 2;

  // --- 文書1件（承認済み。索引済みchunkも作る＝検索・RAGのデモが動く） ---
  const photo = demoPhotoPng();
  const pdf = demoDocumentPdf();
  const docChunks = [
    "宮之浦川の堤防巡視要領（架空・デモ）。豪雨時は請負業者と連絡を取り、水位を確認して本部へ報告する。",
    "資機材の点検は月次で行う（架空・デモ）。異常は写真を添えて「異常」へ登録する。",
    "活動の記録は実績として残し、帳票は承認後に確定する（架空・デモの運用手順）。",
  ];
  group([
    insert("attachments",
      ["id", "unit_id", "owner_user_id", "owner_member_id", "intent_target_type", "intent_target_id",
        "ready_key", "content_type", "byte_size", "sha256", "status", "expires_at", "classification",
        "upload_token_hash", "created_at", "updated_at", "created_by", "actor_kind"],
      [DOC_ATTACHMENT, unit, creator, DEMO_OFFICER_MEMBER, "document", DOCUMENT_1,
        DEMO_DOC_KEY, "application/pdf", pdf.length, await bytesSha256Hex(pdf), "ready",
        "2099-01-01T00:00:00.000Z", "basic", "0".repeat(64), NOW, NOW, creator, "human"]),
    insert("documents", ["id", "unit_id", "title", "classification", "status", "created_at", "updated_at", "created_by", "actor_kind"],
      [DOCUMENT_1, unit, "架空の資機材取扱説明書（デモ）", "資機材", "approved", NOW, NOW, creator, "human"]),
    insert("document_versions",
      ["id", "unit_id", "document_id", "revision_no", "attachment_id", "status", "approved_by", "approved_at",
        "license_ref", "content_hash", "created_at", "updated_at", "created_by", "actor_kind"],
      [DOCUMENT_VERSION_1, unit, DOCUMENT_1, 1, DOC_ATTACHMENT, "approved", creator, NOW,
        "架空の許諾（デモseed）", "1".repeat(64), NOW, NOW, creator, "human"]),
    { sql: "UPDATE documents SET current_version_id = ?, current_draft_version_id = ? WHERE id = ? AND unit_id = ?",
      binds: [DOCUMENT_VERSION_1, DOCUMENT_VERSION_1, DOCUMENT_1, unit] },
    insert("attachment_links",
      ["id", "unit_id", "attachment_id", "entity_type", "entity_id", "linked_by", "version", "created_at", "updated_at", "created_by", "actor_kind"],
      [DOC_LINK, unit, DOC_ATTACHMENT, "document", DOCUMENT_1, creator, 1, NOW, NOW, creator, "human"]),
    ...docChunks.map((text, i) =>
      insert("document_chunks",
        ["id", "unit_id", "version_id", "chunk_no", "page_no", "text", "source_offsets", "index_status", "index_key", "created_at", "updated_at", "created_by", "actor_kind"],
        [chunkId(i + 1), unit, DOCUMENT_VERSION_1, i + 1, i + 1, text,
          JSON.stringify({ contentHash: "1".repeat(64), extractorVersion: "demo-seed", pageNo: i + 1, start: 0, end: text.length }),
          "indexed", `d1_fts:v1/${chunkId(i + 1)}`, NOW, NOW, creator, "human"]),
    ),
    ...docChunks.map((text, i) => ({
      sql: "INSERT INTO document_chunks_fts (chunk_id, unit_id, version_id, document_id, page_no, chunk_no, text) VALUES (?,?,?,?,?,?,?)",
      binds: [chunkId(i + 1), unit, DOCUMENT_VERSION_1, DOCUMENT_1, i + 1, i + 1, text] as unknown[],
    })),
  ]);
  stats.documents = 1;

  // --- 写真1件（施設にリンク。実体はR2へ置く決定的な架空PNG） ---
  group([
    insert("attachments",
      ["id", "unit_id", "owner_user_id", "owner_member_id", "intent_target_type", "intent_target_id",
        "ready_key", "content_type", "byte_size", "sha256", "status", "expires_at", "classification",
        "upload_token_hash", "created_at", "updated_at", "created_by", "actor_kind"],
      [PHOTO_ATTACHMENT, unit, creator, DEMO_OFFICER_MEMBER, "facility", facilityIds[0]!,
        DEMO_PHOTO_KEY, "image/png", photo.length, await bytesSha256Hex(photo), "ready",
        "2099-01-01T00:00:00.000Z", "basic", "0".repeat(64), NOW, NOW, creator, "human"]),
    insert("attachment_links",
      ["id", "unit_id", "attachment_id", "entity_type", "entity_id", "linked_by", "version", "created_at", "updated_at", "created_by", "actor_kind"],
      [PHOTO_LINK, unit, PHOTO_ATTACHMENT, "facility", facilityIds[0]!, creator, 1, NOW, NOW, creator, "human"]),
  ]);

  // --- outbox（domain_events。mutation経路を通らないためseedが作る。seed-loadと同じ方式） ---
  let seq = targets.sequenceStart;
  const event = (entityType: string, entityId: string, eventType: string, payload: Record<string, unknown>): SeedStatement =>
    insert("domain_events", ["id", "unit_id", "mutation_id", "entity_type", "entity_id", "entity_version", "event_type", "payload_minimal", "sequence", "created_at"],
      [crypto.randomUUID(), unit, crypto.randomUUID(), entityType, entityId, 1, eventType, JSON.stringify(payload), ++seq, NOW]);
  const eventGroup: SeedStatement[] = [
    ...facilityIds.map((id) => event("facility", id, "facility.created", { type: "facility" })),
    ...[1, 2, 3, 4, 5, 6].map((i) => event("facility_inspection", inspectionId(i), "facility_inspection.created", { result: i >= 5 ? "needs_review" : "ok" })),
    event("issue", ISSUE_1, "issue.created", {}),
    event("issue", ISSUE_2, "issue.created", {}),
    ...activityPlans.map((a) => event("activity", activityId(a.i), "activity.created", {})),
    event("incident", INCIDENT_1, "incident.created", {}),
    event("announcement", ANNOUNCEMENT_1, "announcement.created", {}),
    event("notification", NOTIFICATION_1, "notification.draft_created", {}),
    event("report", REPORT_1, "report.created", {}),
    event("task", TASK_1, "task.created", {}),
    event("task", TASK_2, "task.created", {}),
    event("document", DOCUMENT_1, "document.created", {}),
  ];
  eventGroup.push({ sql: "UPDATE units SET event_sequence = ? WHERE id = ?", binds: [seq, unit] });
  group(eventGroup);
  stats.domain_events = eventGroup.length - 1;

  return {
    groups,
    objects: [
      { key: DEMO_PHOTO_KEY, contentType: "image/png", bytes: photo },
      { key: DEMO_DOC_KEY, contentType: "application/pdf", bytes: pdf },
    ],
    stats,
  };
}

// ============================================================================
// seedの解決と実行（workerd側の入口。実デモは下のCLIから同じ計画を使う）
// ============================================================================

/** seed対象の解決。実デモではbootstrap-adminが作った「宮之浦分団」とその管理者を使う。 */
export async function resolveDemoTargets(db: D1Database): Promise<DemoSeedTargets> {
  const unit = await db.prepare("SELECT id FROM units WHERE name = ?").bind(DEMO_UNIT_NAME).first<{ id: string }>();
  if (!unit) {
    // 空DB（試験）。unitと管理者もseed計画が作る
    return { unitId: DEMO_UNIT_ID, adminMemberId: DEMO_ADMIN_MEMBER, createUnit: true, sequenceStart: 0 };
  }
  const admin = await db
    .prepare(
      "SELECT m.id AS member_id FROM members m JOIN member_roles r ON r.unit_id = m.unit_id AND r.member_id = m.id " +
        "WHERE m.unit_id = ? AND r.role_id = ? LIMIT 1",
    )
    .bind(unit.id, ROLE_IDS.admin)
    .first<{ member_id: string }>();
  const fallback = admin ?? (await db.prepare("SELECT id AS member_id FROM members WHERE unit_id = ? LIMIT 1").bind(unit.id).first<{ member_id: string }>());
  const seq = await db.prepare("SELECT event_sequence AS n FROM units WHERE id = ?").bind(unit.id).first<{ n: number }>();
  if (!fallback) throw new Error("seed-demo: 宮之浦分団に団員がいません（bootstrap-adminを先に実行してください）");
  return { unitId: unit.id, adminMemberId: fallback.member_id, createUnit: false, sequenceStart: seq?.n ?? 0 };
}

/**
 * 架空データの完成版をseedする（ブリーフのInterface）。既にseed済み（架空の幹部が居る）なら何もしない（冪等）。
 * 写真・文書原本の実体はenv.FILES（demo自身のR2 binding）へ置く。
 */
export async function seedDemo(env: AppEnv): Promise<void> {
  const seeded = await env.DB.prepare("SELECT id FROM members WHERE id = ?").bind(DEMO_OFFICER_MEMBER).first();
  if (seeded) return;
  const targets = await resolveDemoTargets(env.DB);
  const plan = await buildDemoSeedPlan(targets);
  // 循環参照のあるgroupは1つのbatchにまとめる。groupを跨いでbatchを作る（seed-loadと同じ方式）
  const BATCH_STATEMENTS = 200;
  let batch: D1PreparedStatement[] = [];
  let statements = 0;
  const flush = async () => {
    if (batch.length > 0) await env.DB.batch(batch);
    batch = [];
    statements = 0;
  };
  for (const g of plan.groups) {
    if (statements > 0 && statements + g.length > BATCH_STATEMENTS) await flush();
    for (const s of g) batch.push(env.DB.prepare(s.sql).bind(...s.binds));
    statements += g.length;
  }
  await flush();
  for (const obj of plan.objects) {
    await env.FILES.put(obj.key, obj.bytes as unknown as ArrayBuffer, { httpMetadata: { contentType: obj.contentType } });
  }
}

// ============================================================================
// 実在風個人情報の走査（seedした全行を対象に。tests/demo-isolation.test.ts が使う）
// ============================================================================

export interface PrivacyRow {
  table: string;
  id: string;
  values: Record<string, unknown>;
}

export interface PrivacyScan {
  rows: PrivacyRow[];
  /** 表ごとの走査行数（走査漏れ検出に使う。DEMO_PROFILEと照合される） */
  tableCounts: Record<string, number>;
  totalValues: number;
}

/** seedが書くunit付きの表（全て走査する。列の意味はdrizzle/*.sqlが正本） */
const PRIVACY_SCAN_UNIT_TABLES = [
  "members", "member_roles", "facilities", "inspection_templates", "inspection_template_versions",
  "inspection_series", "facility_inspections", "issues", "issue_events", "vehicles", "equipment",
  "operations", "activities", "activity_audience", "activity_attendance", "activity_results",
  "activity_result_revisions", "activity_actual_participants", "incidents", "incident_events",
  "incident_participants", "announcements", "announcement_revisions", "announcement_audience",
  "notifications", "notification_recipients", "notification_events", "reports", "report_versions",
  "content_version_events", "tasks", "documents", "document_versions", "document_chunks",
  "attachments", "attachment_links", "domain_events",
] as const;

/** seedした全行（2unitぶん＋seedが作るuser）を走査して返す。privacy検査の入力 */
export async function collectDemoPrivacyRows(env: Pick<AppEnv, "DB">): Promise<PrivacyScan> {
  const rows: PrivacyRow[] = [];
  const tableCounts: Record<string, number> = {};
  const push = (table: string, results: Record<string, unknown>[]) => {
    tableCounts[table] = results.length;
    for (const r of results) {
      const { id, ...values } = r;
      rows.push({ table, id: String(id), values });
    }
  };
  for (const table of PRIVACY_SCAN_UNIT_TABLES) {
    const res = await env.DB.prepare(`SELECT * FROM ${table} WHERE unit_id IN (?, ?)`).bind(DEMO_UNIT_ID, DEMO_UNIT2_ID).all();
    push(table, res.results as Record<string, unknown>[]);
  }
  // units（unit_id列が無い）と users（unitに属さない）は主键で絞る
  const units = await env.DB.prepare("SELECT * FROM units WHERE id IN (?, ?)").bind(DEMO_UNIT_ID, DEMO_UNIT2_ID).all();
  push("units", units.results as Record<string, unknown>[]);
  const users = await env.DB.prepare("SELECT * FROM users WHERE id IN (?, ?, ?, ?)")
    .bind(DEMO_ADMIN_USER, DEMO_OFFICER_USER, DEMO_OPERATOR_USER, DEMO_MEMBER_USER).all();
  push("users", users.results as Record<string, unknown>[]);
  const totalValues = rows.reduce((sum, r) => sum + Object.keys(r.values).length, 0);
  return { rows, tableCounts, totalValues };
}

/** fixtures作法で許されるメールdomain（実在の配送先になり得ない予約域） */
export const FICTIONAL_EMAIL_DOMAINS = new Set(["example.test", "example.invalid", "example.com"]);

const EMAIL_RE = /[^\s@"'<>]+@[^\s@"'<>]+\.[a-z]{2,}/i;

/**
 * 走査した行から実在風の個人データを検出する（純関数）。
 * 検出規則: ①実在domainのメール ②「架空」を含まない団員氏名 ③「架空」を含まない所在地の文字列。
 * 空を返すのは「規則に全て適合した」ときだけ（規則自体の能力は合成行で常時検査される）。
 */
export function detectRealPersonalData(rows: readonly PrivacyRow[]): string[] {
  const found: string[] = [];
  for (const row of rows) {
    for (const [column, value] of Object.entries(row.values)) {
      if (typeof value !== "string" || value.length === 0) continue;
      const email = value.match(EMAIL_RE);
      if (email) {
        const domain = email[0].split("@")[1]!.toLowerCase();
        if (!FICTIONAL_EMAIL_DOMAINS.has(domain)) {
          found.push(`${row.table}.${column} 実在domainのメール: ${email[0]} (${row.id})`);
        }
      }
      if (row.table === "members" && column === "display_name" && !value.includes("架空")) {
        found.push(`${row.table}.${column} 架空の目印が無い氏名: ${value} (${row.id})`);
      }
      if ((column === "location_note" || column === "location_text") && !value.includes("架空")) {
        found.push(`${row.table}.${column} 架空の目印が無い所在地: ${value} (${row.id})`);
      }
    }
  }
  return found;
}

// ============================================================================
// 分離検査（純関数。demo設定とresetの射程）
// ============================================================================

export interface IsolationResult {
  envName: string;
  /** demo設定の中にproduction資源の値・production専用Secret名が現れた箇所。空=分離している */
  productionResourceReferences: string[];
  /** productionのbinding/tokenへ到達できた（true=分離失敗） */
  productionBindingsAccessible: boolean;
  /** demo:resetが削除するパス（demoResetRemovalsと同じ正本） */
  resetRemovals: string[];
  /** resetが他環境のローカル状態・設定ファイルに触れる（true=分離失敗） */
  resetTouchesOtherEnvironments: boolean;
  /** 全ての分離検査がokか */
  ok: boolean;
}

/** 環境が所有する資源の値（production側の所有物の一覧。demo設定に現れてはならない） */
function ownedResourceValues(env: WranglerEnvConfig): { kind: string; value: string }[] {
  const values: { kind: string; value: string }[] = [];
  if (env.name) values.push({ kind: "Worker名", value: env.name });
  for (const d of env.d1_databases ?? []) {
    values.push({ kind: "D1 database_id", value: d.database_id });
    values.push({ kind: "D1 database_name", value: d.database_name });
  }
  for (const r of env.r2_buckets ?? []) values.push({ kind: "R2 bucket_name", value: r.bucket_name });
  for (const q of env.queues?.producers ?? []) values.push({ kind: "queue名", value: q.queue });
  if (env.vars?.AUTH_BASE_URL) values.push({ kind: "AUTH_BASE_URL", value: env.vars.AUTH_BASE_URL });
  return values;
}

/**
 * demo環境の分離検査（ブリーフのInterface）。
 * 実行時にseedDemoが書き込む先・4環境の分離・resetの射程というデモ運用の視点で確認する
 * （配置ゲートのcheckEnvironmentが「4環境の設定の形」を見るのに対し、ここは「demoからproductionへ
 * 到達できる物が設定・resetに存在するか」を見る）。
 */
export function verifyDemoIsolation(config: DeploymentConfig): IsolationResult {
  if (config.envName !== "demo") {
    throw new Error(`verifyDemoIsolationはdemo環境の検査です: ${config.envName}`);
  }
  const production = config.others["production"];
  const references: string[] = [];
  if (production) {
    // demo設定の全体（vars・binding・資源名を含む実値）にproductionの資源の値が現れたら差替え/混入
    const demoText = JSON.stringify(config.env);
    for (const { kind, value } of ownedResourceValues(production)) {
      if (value && demoText.includes(value)) references.push(`demo設定にproductionの${kind}（${value}）が現れる`);
    }
    // production専用Secret名（token差替えの目印）。値そのものは設定に存在しないため名前で検出する
    for (const secret of config.secrets) {
      if (!/prod/i.test(secret)) continue;
      if (demoText.includes(secret)) references.push(`demo設定にproduction Secret名（${secret}）が現れる`);
    }
  } else {
    references.push("others.productionが無い（比較対象の本番設定が与えられていない）");
  }
  const resetRemovals = demoResetRemovals();
  // resetの射程はdemoのpersistだけ。他環境のpersistルートはおろか、どんなパスであれdemoの外は触れない
  const resetTouchesOtherEnvironments =
    resetRemovals.length !== 1 ||
    resetRemovals.some((p) => p !== DEMO_PERSIST_DIR) ||
    OTHER_LOCAL_PERSIST_ROOTS.some((o) => resetRemovals.includes(o));
  return {
    envName: config.envName,
    productionResourceReferences: references,
    productionBindingsAccessible: references.length > 0,
    resetRemovals,
    resetTouchesOtherEnvironments,
    ok: references.length === 0 && !resetTouchesOtherEnvironments,
  };
}

// ============================================================================
// CLI（`npx tsx scripts/seed-demo.ts --persist-to .wrangler/demo`）。
// scripts/demo.ts の初回起動（bootstrap-adminの直後）から呼ばれる。workerd外ではenvが無いため
// 計画をSQLへ直列化して wrangler d1 execute / r2 object put で適用する（seed-load.tsのCLIと同じ方式）。
// 実環境（demo）への投入は `npm run demo:seed:remote -- --confirm demo`、週次リセット（全表DROPからの
// やり直し）は `npm run demo:reset:remote -- --confirm demo`（Task5。--remote は --env demo --confirm demo
// が無いと動かない＝bootstrap-admin.tsと同じ規律。実環境への接続はしない。実行確認はTask 7）。
// ============================================================================

// ============================================================================
// wranglerコマンド列の生成（純関数。実行はしない。local/remoteの差はここだけが知る）
// ============================================================================

/** seedの適用先。local=手元のpersist（`npm run demo`経路）。remote-demo=実Cloudflareのdemo環境（引数解析で--env demo --confirm demo確定済み） */
export type DemoSeedMode =
  | { kind: "local"; persist: string }
  | { kind: "remote-demo"; wipe: boolean };

/**
 * seed適用のwranglerコマンド列（argv。「wrangler」本体より後ろ。`sh("npx", ["wrangler", ...args])`で実行する）。
 * localは従来どおり `--local --persist-to`、remoteは `--env demo --remote`（wrangler 4.150の
 * d1 execute / d1 migrations apply / r2 object put が同じ形で --env と --local/--remote を受け付ける。
 * r2 object put は --local を付けない限り --remote で実環境へ置く）。実行はしないため試験が配列を固定できる。
 */
export interface SeedCommands {
  /** D1の読み取り（--json --command）。seed対象の解決と冪等判定に使う */
  d1Read(sql: string): string[];
  /** 生成したSQLファイルの適用（--file） */
  d1File(file: string): string[];
  /** migrationの適用（remoteのみ。localは scripts/demo.ts が wrangler d1 migrations apply を行うためnull） */
  d1Migrate(): string[] | null;
  /** R2へのオブジェクトput（写真・文書の架空実体。--forceで同じキーを上書きする） */
  r2Put(key: string, contentType: string, file: string): string[];
}

export function buildSeedCommands(mode: DemoSeedMode, opts: { bucket: string }): SeedCommands {
  const target = mode.kind === "local" ? ["--local", "--persist-to", mode.persist] : ["--env", "demo", "--remote"];
  return {
    d1Read: (sql) => ["d1", "execute", "DB", ...target, "--json", "--command", sql],
    d1File: (file) => ["d1", "execute", "DB", ...target, "--file", file],
    d1Migrate: () => (mode.kind === "remote-demo" ? ["d1", "migrations", "apply", "DB", "--env", "demo", "--remote"] : null),
    r2Put: (key, contentType, file) =>
      ["r2", "object", "put", `${opts.bucket}/${key}`, ...target, "--file", file, "--content-type", contentType, "--force"],
  };
}

/** DROP対象から除外する内部表の名前（sqlite自身の表〔sqlite_%〕と_で始まるCloudflare管理の表〔_cf_KV等〕） */
export function isInternalTableName(name: string): boolean {
  return name.startsWith("sqlite_") || name.startsWith("_");
}

/**
 * リモートdemo D1のwipe用SQL（全表DROP。sqlite_masterの実表一覧を受ける純関数）。
 * d1_migrations もDROPする（直後の `wrangler d1 migrations apply` が全件を適用しschemaを作り直す）。
 * PRAGMA foreign_keys=OFF は親表DROP時の参照制約違反を避けるため（wrangler d1 execute --remote --file で適用する）。
 */
export function buildRemoteWipeSql(tables: readonly string[]): string {
  const lines = [
    "-- scripts/seed-demo.ts が生成（demo D1のwipe。全表DROP。schemaは直後のmigrationで作り直す）",
    "PRAGMA foreign_keys=OFF;",
    "BEGIN TRANSACTION;",
  ];
  for (const t of tables) {
    if (isInternalTableName(t)) continue;
    lines.push(`DROP TABLE IF EXISTS "${t.replaceAll('"', '""')}";`);
  }
  lines.push("COMMIT;", "PRAGMA foreign_keys=ON;");
  return lines.join("\n") + "\n";
}

/** seed実体を置くR2 bucket名（wrangler.jsoncのパース結果から。localは最上位設定、remoteはenv.demoの設定） */
export function pickSeedBucket(
  config: WranglerEnvConfig & { env?: Record<string, WranglerEnvConfig> },
  mode: DemoSeedMode,
): string | undefined {
  return mode.kind === "local" ? config.r2_buckets?.[0]?.bucket_name : config.env?.demo?.r2_buckets?.[0]?.bucket_name;
}

const sqlLiteral = (v: unknown): string => {
  if (v === null || v === undefined) return "NULL";
  if (typeof v === "number") return String(v);
  return `'${String(v).replaceAll("'", "''")}'`;
};

const inlineBinds = (sql: string, binds: unknown[]): string => {
  let out = "";
  let rest = sql;
  for (const b of binds) {
    const marker = rest.indexOf("?");
    if (marker < 0) throw new Error("seed-demo: placeholderの数とbindsの数が一致しません");
    out += rest.slice(0, marker) + sqlLiteral(b);
    rest = rest.slice(marker + 1);
  }
  if (rest.includes("?")) throw new Error("seed-demo: placeholderの数とbindsの数が一致しません");
  return out + rest;
};

/** CLI引数の解析結果。usageErrorのときは使い方の誤り（標準エラー出力へ出して終了コード2で止める） */
export type DemoSeedArgs =
  | { persist: string; fixedDemoPassword?: string }
  | { remoteDemo: true; wipe: boolean; fixedDemoPassword?: string }
  | { usageError: string };

/**
 * CLI引数の解析（純関数。tests/demo-accounts.test.ts・tests/demo-reset.test.tsが使い方の誤りを固定する）。
 * - local（従来経路）: `--persist-to` が必須。`--demo-password` を値なしで渡したときは黙ってランダム生成へ
 *   落とさず使い方の誤りとして拒否する（demo:reset後に同じ資格情報へ戻す運用が、静かに別パスワードで
 *   通ってしまう事故を防ぐ）。
 * - remote（Task5）: `--remote` は `--env demo --confirm demo` が無いと動かない（bootstrap-admin.ts:26-28と
 *   同じ確認規律）。**demo環境以外への書込みは拒絶する**（staging/productionは--confirmが一致しても拒否）。
 *   `--wipe` を付けると全表DROPからのやり直し（週次リセット。無しは既存unitへの追加seed）。
 *   `--persist-to` はローカル専用（remoteではローカルのpersistを使わない）。
 */
export function parseDemoSeedArgs(args: readonly string[]): DemoSeedArgs {
  const flagValue = (flag: string): string | undefined => {
    const i = args.indexOf(flag);
    return i < 0 ? undefined : args[i + 1];
  };
  // --demo-password の検査（local/remote共通。メッセージはlocal時代から変えない）
  const fixedPassword = (): { fixedDemoPassword?: string } | { usageError: string } => {
    if (!args.includes("--demo-password")) return {};
    const value = flagValue("--demo-password");
    if (value === undefined) {
      return {
        usageError:
          "--demo-password の後に値がありません。--demo-password <値> の形で12文字以上のパスワードを指定してください（better-authの下限）",
      };
    }
    if (value.length < 12) {
      return { usageError: "--demo-password には12文字以上のパスワードを指定してください（better-authの下限）" };
    }
    return { fixedDemoPassword: value };
  };

  if (args.includes("--remote")) {
    const env = flagValue("--env");
    const confirm = flagValue("--confirm");
    if (env === undefined || confirm === undefined) {
      return {
        usageError:
          "--remote は実環境のdemo D1/R2へ書きます。--env demo --confirm demo を両方指定してください（demo環境以外への書込みは拒否します）\n" +
          "週次リセット（全表DROPからのやり直し）: npm run demo:reset:remote -- --confirm demo",
      };
    }
    if (env !== "demo") {
      return { usageError: `--env demo 以外は --remote の対象外です（demo環境以外への書込みは拒否します）: ${env}` };
    }
    if (confirm !== "demo") {
      return { usageError: "--remote は実環境のdemoへ書きます。--confirm には同じ環境名 demo を指定してください" };
    }
    if (args.includes("--persist-to")) {
      return { usageError: "--persist-to はローカル専用です（--remote ではローカルのpersistを使わないため指定できません）" };
    }
    const password = fixedPassword();
    if ("usageError" in password) return password;
    return { remoteDemo: true, wipe: args.includes("--wipe"), ...password };
  }
  if (args.includes("--env") || args.includes("--confirm") || args.includes("--wipe")) {
    return {
      usageError:
        "--env / --confirm / --wipe は --remote と一緒にだけ使えます。ローカルへのseedは --persist-to .wrangler/demo の形で指定してください",
    };
  }

  const persist = flagValue("--persist-to");
  if (!persist) {
    return {
      usageError:
        "使い方: npx tsx scripts/seed-demo.ts --persist-to .wrangler/demo [--demo-password <12文字以上のパスワード>]\n" +
        "実デモの初回起動（scripts/demo.ts）から自動で呼ばれる（架空データ＋体験アカウントのみ。実データは入れない）\n" +
        "実環境（demo）への投入・週次リセットは --remote --env demo --confirm demo（--wipeで全表DROPからやり直す）",
    };
  }
  const password = fixedPassword();
  if ("usageError" in password) return password;
  return { persist, ...password };
}

async function main(): Promise<void> {
  const parsed = parseDemoSeedArgs(process.argv.slice(2));
  if ("usageError" in parsed) {
    console.error(parsed.usageError);
    process.exitCode = 2;
    return;
  }
  const mode: DemoSeedMode =
    "remoteDemo" in parsed ? { kind: "remote-demo", wipe: parsed.wipe } : { kind: "local", persist: parsed.persist };
  const fixedDemoPassword = parsed.fixedDemoPassword;

  // seed実体を置くR2 bucket（localは最上位設定、remoteはdemo環境の設定。bucket名はwrangler.jsoncの正本から読む）
  const wranglerConfig = JSON.parse(
    stripJsonComments(readFileSync("wrangler.jsonc", "utf8")),
  ) as WranglerEnvConfig & { env?: Record<string, WranglerEnvConfig> };
  const bucket = pickSeedBucket(wranglerConfig, mode);
  if (!bucket) {
    throw new Error(mode.kind === "local" ? "wrangler.jsoncにlocalのR2 bucketがありません" : "wrangler.jsoncのdemo環境にR2 bucketがありません");
  }
  const cmds = buildSeedCommands(mode, { bucket });
  const sh = (cmd: string, cmdArgs: string[]) => spawnSync(cmd, cmdArgs, { encoding: "utf8" });
  const d1Json = (sql: string) => {
    const r = sh("npx", ["wrangler", ...cmds.d1Read(sql)]);
    if (r.status !== 0) throw new Error(`D1読み込みに失敗: ${r.stderr || r.stdout}`);
    return (JSON.parse(r.stdout) as { results: Record<string, unknown>[] }[])[0]?.results ?? [];
  };

  const dir = mkdtempSync(join(tmpdir(), "fireos-seed-demo-"));
  try {
    const applySql = async (name: string, stmts: readonly { sql: string; binds: unknown[] }[]): Promise<void> => {
      const sqlFile = join(dir, name);
      const lines = [`-- scripts/seed-demo.ts が生成（${name}。実データは含まない）`, "BEGIN TRANSACTION;"];
      for (const s of stmts) lines.push(inlineBinds(s.sql, s.binds) + ";");
      lines.push("COMMIT;");
      writeFileSync(sqlFile, lines.join("\n") + "\n");
      const applied = sh("npx", ["wrangler", ...cmds.d1File(sqlFile)]);
      if (applied.status !== 0) throw new Error(`seed SQLの適用に失敗（${name}）: ${applied.stderr || applied.stdout}`);
    };

    // --- remote（demo環境）: --wipeのときは全表DROP → migration適用（schemaを作り直してからseedする） ---
    if (mode.kind === "remote-demo") {
      if (mode.wipe) {
        const tables = d1Json("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").map((r) => String(r.name));
        const wipeFile = join(dir, "wipe-demo.sql");
        writeFileSync(wipeFile, buildRemoteWipeSql(tables));
        const wiped = sh("npx", ["wrangler", ...cmds.d1File(wipeFile)]);
        if (wiped.status !== 0) throw new Error(`demo D1のwipeに失敗: ${wiped.stderr || wiped.stdout}`);
        console.log(`demo D1の全表をDROPしました（${tables.filter((t) => !isInternalTableName(t)).length}表）。schemaを作り直して架空データを入れ直します`);
      }
      const mig = sh("npx", ["wrangler", ...cmds.d1Migrate()!]);
      if (mig.status !== 0) throw new Error(`demo D1へのmigration適用に失敗: ${mig.stderr || mig.stdout}`);
    }

    const unitRow = d1Json(`SELECT id FROM units WHERE name = '${DEMO_UNIT_NAME}' LIMIT 1`)[0] as { id: string } | undefined;
    if (!unitRow && mode.kind === "local") {
      console.error("宮之浦分団が見つかりません。npm run demo の初回起動（bootstrap-admin）より前です");
      process.exitCode = 1;
      return;
    }
    // 冪等: seed済みなら架空データの適用だけスキップする（wipe直後のremoteは必ず未seed。体験アカウントは下で独立に判定する）
    const officerSeeded = unitRow ? d1Json(`SELECT 1 AS x FROM members WHERE id = '${DEMO_OFFICER_MEMBER}'`).length > 0 : false;
    // 体験アカウントの紐付け先unit（既存の宮之浦分団。無い＝wipe直後の空DBならseed計画がDEMO_UNIT_IDで作る物）
    const unitId = unitRow ? unitRow.id : DEMO_UNIT_ID;

    if (officerSeeded) {
      console.log("デモデータは投入済みです（スキップ）");
    } else {
      // seed対象の解決。remoteでwipe直後の空DBならunit・管理者もseed計画が作る（試験の空DBと同じcreateUnit経路）
      let targets: DemoSeedTargets;
      if (!unitRow) {
        targets = { unitId: DEMO_UNIT_ID, adminMemberId: DEMO_ADMIN_MEMBER, createUnit: true, sequenceStart: 0 };
      } else {
        const adminRow =
          (d1Json(
            `SELECT m.id AS member_id FROM members m JOIN member_roles r ON r.unit_id = m.unit_id AND r.member_id = m.id ` +
              `WHERE m.unit_id = '${unitRow.id}' AND r.role_id = '${ROLE_IDS.admin}' LIMIT 1`,
          )[0] as { member_id: string } | undefined) ??
          (d1Json(`SELECT id AS member_id FROM members WHERE unit_id = '${unitRow.id}' LIMIT 1`)[0] as { member_id: string } | undefined);
        if (!adminRow) throw new Error("seed-demo: 宮之浦分団に団員がいません（bootstrap-adminを先に実行してください）");
        const seqRow = d1Json(`SELECT event_sequence AS n FROM units WHERE id = '${unitRow.id}'`)[0] as { n: number } | undefined;
        targets = { unitId: unitRow.id, adminMemberId: adminRow.member_id, createUnit: false, sequenceStart: seqRow?.n ?? 0 };
      }

      const plan = await buildDemoSeedPlan(targets);
      await applySql("seed-demo.sql", plan.groups.flat());

      // 写真・文書原本の実体をR2へ（local=手元のpersist、remote=demo環境のbucket。bucket名はwrangler.jsoncから）
      for (const obj of plan.objects) {
        const file = join(dir, obj.key.replaceAll("/", "-"));
        writeFileSync(file, obj.bytes);
        const put = sh("npx", ["wrangler", ...cmds.r2Put(obj.key, obj.contentType, file)]);
        if (put.status !== 0) throw new Error(`R2への配置に失敗（${obj.key}）: ${put.stderr || put.stdout}`);
      }
      console.log(`デモデータを投入しました（架空のみ）: ${JSON.stringify(plan.stats)}`);
    }

    // --- 体験アカウント3本（Task4。架空データと独立に冪等。資格情報は標準出力へ一度だけ出す） ---
    const emailList = DEMO_ACCOUNTS.map((a) => `'${a.email}'`).join(", ");
    const existing = d1Json(`SELECT email FROM auth_users WHERE email IN (${emailList})`) as { email: string }[];
    if (existing.length === DEMO_ACCOUNTS.length) {
      console.log("体験アカウントは投入済みです（スキップ。資格情報は `.env.demo-login` に控えた物を使ってください）");
    } else if (existing.length > 0) {
      throw new Error(`体験アカウントが一部だけ存在します（${existing.length}/${DEMO_ACCOUNTS.length}）。投入を中止しました`);
    } else {
      const credentials = DEMO_ACCOUNTS.map((a) => ({
        email: a.email, memberName: a.memberName, role: a.role,
        password: fixedDemoPassword ?? generateDemoPassword(),
      }));
      await applySql("demo-accounts.sql", await demoAccountStatements({ unitId, now: new Date(), credentials }));
      console.log("体験アカウントを作りました（3役割・MFAなし）。下のログイン情報は**一度だけ**表示されます。");
      console.log("Git管理外の `.env.demo-login` 等に控えてください（demo:reset後に同じ資格情報へ戻すには --demo-password を使う）:");
      // 最後の行が資格情報のJSON（scripts/demo.ts がこの行だけを拾って表示する。パスワードをログへ複製しないため）
      console.log(JSON.stringify({ "demo-accounts": credentials.map((c) => ({ email: c.email, password: c.password, role: c.role, displayName: c.memberName })) }));
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const runningAsCli = typeof process !== "undefined" && process.argv[1]?.includes("seed-demo");
if (runningAsCli) {
  void main().catch((err) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
  });
}
