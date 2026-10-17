import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { assembleBackupManifest, BACKUP_TABLE_SQL, type BackupManifest, type ManifestDelivery, type ManifestObject, type ManifestTombstone } from "../src/server/backup/manifest";
import { WranglerError, d1Query } from "./wrangler-d1";

/**
 * ローカルD1/R2のバックアップ（T079、docs/07 §7、docs/14 D10、ops/backup-restore.md §2-3）。
 *
 * 使い方:
 *   npx tsx scripts/backup-manifest.ts --backup-dir backup/local-20261017-1 [--db fireos-local] [--state-dir .wrangler/state]
 *
 * 行うこと:
 *   1) <backup-dir>/d1-data.sql   — 全表の論理ダンプ（INSERT文。wrangler d1 exportはFTS5仮想表で
 *      失敗するため「cannot export databases with Virtual Tables (fts5)」、このCLIが代わりに作る）
 *   2) <backup-dir>/manifest.json — 復元点のmanifest（src/server/backup/manifest.ts のbuildBackupManifestと
 *      同じ内容。D1復元点/R2 key/hash/論理削除時刻/既送状態/未確定job/session失効基準）
 *   3) <backup-dir>/r2-state/     — ローカルR2の状態複製（.wrangler/state/v3/r2のcopy。実体は不変キー）
 *
 * 実Cloudflare（staging/production）へのバックアップは、このCLIのローカル前提（--local）がそのままでは
 * 使えない。ops/backup-restore.md §2の別手順（Time TravelとR2の別複製）に従い、演習結果は
 * docs/evidence/V07-restore.md に記録する。
 */

const argValue = (flag: string): string | undefined => {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : undefined;
};

const db = argValue("--db") ?? "fireos-local";
const backupDir = argValue("--backup-dir") ?? `backup/local-${new Date().toISOString().replace(/[-:T]/g, "").slice(0, 13)}`;
const stateDir = argValue("--state-dir") ?? ".wrangler/state";

// --- 1) 表の一覧と依存（FKの親を先に入れる順序。d1-data.sqlのINSERT順） ---
const tableRows = d1Query(db, { command: BACKUP_TABLE_SQL });
const tables = tableRows[0]!.results.map((r) => String(r.name));
if (tables.length === 0) throw new WranglerError(`${db} のローカル状態に表がありません（先に npm run demo や試験で作ってください）`, "");

// FK一覧＋行数＋manifestの元データを1つのSQLファイルにして1回のwrangler起動で取る
const manifestSelects = [
  "SELECT ready_key AS key, id AS attachmentId, unit_id AS unitId, sha256, byte_size AS byteSize, status FROM attachments WHERE ready_key IS NOT NULL ORDER BY ready_key",
  "SELECT id AS attachmentId, unit_id AS unitId, status, updated_at AS updatedAt FROM attachments WHERE status IN ('deleting', 'deleted') ORDER BY updated_at, id",
  "SELECT delivery_key AS deliveryKey, status, attempt_count AS attemptCount FROM notification_deliveries ORDER BY delivery_key",
  "SELECT count(*) AS n FROM jobs WHERE status IN ('queued', 'retry_wait', 'running')",
  "SELECT id, session_revoked_before AS v FROM users ORDER BY id",
];
const tmpDir = ".wrangler/tmp";
mkdirSync(tmpDir, { recursive: true });
const metadataSql = join(tmpDir, `backup-metadata-${Date.now()}.sql`);
writeFileSync(
  metadataSql,
  tables.map((t) => `PRAGMA foreign_key_list("${t}");\nSELECT count(*) AS n FROM "${t}";`).join("\n") +
    "\n" +
    manifestSelects.map((s) => `${s};`).join("\n") +
    "\n",
);
const metadata = d1Query(db, { file: metadataSql });
const fksByTable = new Map<string, string[]>();
const counts: number[] = [];
metadata.slice(0, tables.length * 2).forEach((rs, i) => {
  const t = tables[Math.floor(i / 2)]!;
  if (i % 2 === 0) {
    fksByTable.set(t, [...new Set(rs.results.map((r) => String(r.table)))].filter((p) => tables.includes(p) && p !== t));
  } else {
    counts.push((rs.results[0] as { n: number }).n);
  }
});
const [objectsRs, tombstonesRs, deliveriesRs, jobsRs, usersRs] = metadata.slice(tables.length * 2);

// 依存の topo 順（親が先。src/server/backup/restore.ts の restoreTableOrder と同じ規律）
const order: string[] = [];
const done = new Set<string>();
const visit = (t: string, stack: Set<string>): void => {
  if (done.has(t) || stack.has(t)) return;
  stack.add(t);
  for (const p of fksByTable.get(t) ?? []) visit(p, stack);
  stack.delete(t);
  done.add(t);
  order.push(t);
};
for (const t of tables) visit(t, new Set());

// --- 2) 全行の読み取りと論理ダンプの作成 ---
const dumpSqlPath = join(backupDir, "d1-data.sql");
mkdirSync(backupDir, { recursive: true });
const rowsSql = join(tmpDir, `backup-rows-${Date.now()}.sql`);
writeFileSync(rowsSql, order.map((t) => `SELECT * FROM "${t}";`).join("\n") + "\n");
const rowSets = d1Query(db, { file: rowsSql });

const sqlLiteral = (v: unknown): string => {
  if (v === null) return "NULL";
  if (typeof v === "number") return String(v);
  if (typeof v === "string") return `'${v.replaceAll("'", "''")}'`;
  throw new Error(`d1-data.sql: BLOBなど対応していない型の列があります（${typeof v}。論理ダンプの対象外です）`);
};
const lines: string[] = [
  "-- FireOS D1 論理ダンプ（scripts/backup-manifest.ts が生成。docs/07 §7、ops/backup-restore.md §4）",
  `-- database: ${db} / generatedAt: ${new Date().toISOString()}`,
  "-- 復元: 空のpersist先に `npx wrangler d1 migrations apply <db> --local --persist-to <scratch>` でschemaを作ってから、",
  "--       このファイルを `npx wrangler d1 execute <db> --local --persist-to <scratch> --file このファイル` で適用する。",
  "-- 1文=1行のINSERT。FKの親が先の順序で並んでいる（勝手に並べ替えないこと）。",
  "-- migrationが投入する既定行（roles等）があるため、各表のINSERTの前にDELETEを置く（空のschemaでは何も消さない）。",
  "",
];
let dumpedRows = 0;
rowSets.forEach((rs, i) => {
  const t = order[i]!;
  if (rs.results.length > 0) lines.push(`DELETE FROM "${t}";`);
  for (const row of rs.results) {
    const cols = Object.keys(row);
    lines.push(
      `INSERT INTO "${t}" (${cols.map((c) => `"${c}"`).join(", ")}) VALUES (${cols.map((c) => sqlLiteral(row[c])).join(", ")});`,
    );
    dumpedRows++;
  }
});
writeFileSync(dumpSqlPath, lines.join("\n") + "\n");
const dumpSha256 = createHash("sha256").update(readFileSync(dumpSqlPath, "utf8")).digest("hex");

// --- 3) manifestの作成（WorkersのbuildBackupManifestと同じ内容） ---
const manifest: BackupManifest = assembleBackupManifest({
  appEnv: "local",
  restorePointAt: new Date().toISOString(),
  generatedBy: "scripts/backup-manifest",
  tables,
  counts,
  objects: objectsRs!.results as unknown as ManifestObject[],
  tombstones: tombstonesRs!.results as unknown as ManifestTombstone[],
  deliveries: deliveriesRs!.results as unknown as ManifestDelivery[],
  jobsUncertain: (jobsRs!.results[0] as { n: number }).n,
  users: usersRs!.results as { id: string; v: string | null }[],
});
manifest.export = { file: dumpSqlPath, sha256: dumpSha256 };
writeFileSync(join(backupDir, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");

// --- 4) ローカルR2の状態複製（ready実体は不変キー。削除猶予の間に複製する。docs/14 D10） ---
const r2StateSrc = join(stateDir, "v3/r2");
const r2StateDest = join(backupDir, "r2-state");
let r2Copied = false;
if (existsSync(r2StateSrc)) {
  cpSync(r2StateSrc, r2StateDest, { recursive: true });
  r2Copied = true;
}

console.log(JSON.stringify({
  backupDir,
  d1Data: { file: dumpSqlPath, rows: dumpedRows, sha256: dumpSha256 },
  manifest: { file: join(backupDir, "manifest.json"), restorePointAt: manifest.restorePointAt, tables: tables.length },
  r2State: { copied: r2Copied, dir: r2Copied ? r2StateDest : null, note: r2Copied ? undefined : `${r2StateSrc} が無いため複製を省略（R2実体の複製なしで復元はできない）` },
  next: `npx tsx scripts/restore-verify.ts --manifest ${join(backupDir, "manifest.json")} --scratch /tmp/fireos-restore-scratch`,
}, null, 2));
