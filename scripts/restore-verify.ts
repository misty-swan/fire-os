import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BackupManifest } from "../src/server/backup/manifest";
import {
  ACL_CHECKS,
  FTS_DRIFT_SQL,
  JOB_SOURCES,
  assembleRestoreCheck,
  jobSourceCheckSql,
  type RestoreCheckQueries,
} from "../src/server/backup/restore";
import { WranglerError, d1Query } from "./wrangler-d1";

/**
 * 復元の整合照合（T079、docs/07 §7、docs/08 CT-08、ops/backup-restore.md §4-5）。
 *
 * 使い方:
 *   npx tsx scripts/restore-verify.ts --manifest backup/local-.../manifest.json --scratch /tmp/fireos-restore-scratch \
 *     [--db fireos-local] [--r2-state backup/local-.../r2-state] [--bucket fireos-local-files]
 *
 * 行うこと:
 *   1) scratchディレクトリへ空のschemaを作る（wrangler d1 migrations apply --persist-to ＝「別環境への復元」相当。
 *      追記専用表（audit_logs等）は在り得ない行から復元できないため、schemaから新規に作る）
 *   2) manifest.exportの論理ダンプ（d1-data.sql）を適用する
 *   3) 復元後sessions失効（API-38のusers.session_revoked_before機構。docs/07 §7のrunbook「sessions失効」）
 *   4) manifestとの照合（FK/hash/所属/集計/job/索引/既送delivery/失効基準。Workers試験と同じassembleRestoreCheck）
 *   5) --r2-stateがあれば、複製したR2状態からready実体を取得してhashまで照合する
 *
 * 結果はRestoreCheckとしてJSONで出力し、問題が1つでもあれば終了コード1で終わる（合格を見逃さない）。
 * 実Cloudflareへの復元演習はこのCLIでは代替できない。docs/evidence/V07-restore.md の「未実施」を参照。
 */

const argValue = (flag: string): string | undefined => {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : undefined;
};

const manifestPath = argValue("--manifest");
const scratch = argValue("--scratch");
const db = argValue("--db") ?? "fireos-local";
const r2State = argValue("--r2-state");
const bucket = argValue("--bucket") ?? "fireos-local-files";
if (!manifestPath || !scratch) {
  console.error("使い方: npx tsx scripts/restore-verify.ts --manifest <backup-dir>/manifest.json --scratch <dir> [--db fireos-local] [--r2-state <dir>] [--bucket <name>]");
  process.exit(2);
}
const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as BackupManifest;
if (!manifest.export) {
  throw new WranglerError("manifestにexport（論理ダンプ）の参照がありません。scripts/backup-manifest.ts で作ったmanifest.jsonを使ってください", "");
}

/** npx wranglerを実行する（allowFailで「オブジェクトが無い」等を失敗扱いにしない） */
function wrangler(args: string[], opts: { allowFail?: boolean } = {}): string {
  const res = spawnSync("npx", ["wrangler", ...args], { encoding: "utf8", maxBuffer: 1024 * 1024 * 512 });
  if (res.error) throw res.error;
  if (res.status !== 0) {
    if (opts.allowFail) return "";
    throw new WranglerError(`wrangler ${args.join(" ")} が失敗しました (exit=${res.status})`, res.stderr);
  }
  return "ok";
}

// --- 1) 空のschema（別環境相当。docs/07 §7「stagingでD1復元」のローカル相当） ---
rmSync(scratch, { recursive: true, force: true });
mkdirSync(scratch, { recursive: true });
const schemaApplied = wrangler(["d1", "migrations", "apply", db, "--local", "--persist-to", scratch]);

// --- 2) 論理ダンプの適用 ---
const dataApplied = wrangler(["d1", "execute", db, "--local", "--persist-to", scratch, "--file", manifest.export.file]);

// --- 3) 復元後sessions失効（docs/07 §7。session_revoked_beforeはISO8601形式のCHECKを持つ） ---
const rp = manifest.restorePointAt;
const revokeSql =
  "UPDATE users SET session_revoked_before = '" + rp + "', updated_at = '" + rp + "' WHERE session_revoked_before IS NULL OR session_revoked_before < '" + rp + "'";
wrangler(["d1", "execute", db, "--local", "--persist-to", scratch, "--command", revokeSql]);

// --- 4) 照合クエリ（1つのSQLファイルにまとめて1回のwrangler起動で実行する） ---
const tmpDir = mkdtempSync(join(tmpdir(), "fireos-restore-verify-"));
const verifySql = join(tmpDir, "verify.sql");
const statements = [
  "PRAGMA foreign_key_check;",
  ...Object.keys(manifest.d1.tables).map((t) => `SELECT count(*) AS n FROM "${t}";`),
  `${FTS_DRIFT_SQL};`,
  ...Object.entries(JOB_SOURCES).map(([kind, source]) => `${jobSourceCheckSql(kind, source)};`),
  ...ACL_CHECKS.map((c) => `${c.sql};`),
  "SELECT delivery_key AS deliveryKey, status, attempt_count AS attemptCount FROM notification_deliveries ORDER BY delivery_key;",
  "SELECT id FROM users WHERE session_revoked_before IS NULL OR session_revoked_before < '" + rp + "';",
];
writeFileSync(verifySql, statements.join("\n") + "\n");
const results = d1Query(db, { file: verifySql }, scratch);

let i = 0;
const foreignKeyRows = results[i++]!.results as unknown as RestoreCheckQueries["foreignKeyRows"];
const counts: RestoreCheckQueries["counts"] = Object.keys(manifest.d1.tables).map((table) => ({
  table,
  n: (results[i++]!.results[0] as { n: number }).n,
}));
const fts = results[i++]!.results[0] as unknown as RestoreCheckQueries["fts"];
const missingJobRows: RestoreCheckQueries["missingJobRows"] = [];
for (let k = 0; k < Object.keys(JOB_SOURCES).length; k++) {
  missingJobRows.push(...(results[i++]!.results as unknown as RestoreCheckQueries["missingJobRows"]));
}
const aclRows: RestoreCheckQueries["aclRows"] = [];
for (const c of ACL_CHECKS) {
  for (const row of results[i++]!.results as { rowId: string }[]) {
    aclRows.push({ label: c.label, rowId: row.rowId });
  }
}
const deliveries = results[i++]!.results as unknown as RestoreCheckQueries["deliveries"];
const unrevokedUsers = results[i++]!.results as unknown as RestoreCheckQueries["unrevokedUsers"];

// --- 5) R2実体の照合（複製したr2-stateから取得してhashまで比べる） ---
const objects: RestoreCheckQueries["objects"] = [];
for (const entry of manifest.r2) {
  if (!r2State || !existsSync(r2State)) {
    objects.push({ key: entry.key, found: false, sha256: null, byteSize: null });
    continue;
  }
  const out = join(tmpDir, "object.bin");
  const ok = wrangler(["r2", "object", "get", `${bucket}/${entry.key}`, "--local", "--persist-to", r2State, "--file", out], { allowFail: true });
  if (!ok) {
    objects.push({ key: entry.key, found: false, sha256: null, byteSize: null });
    continue;
  }
  const bytes = readFileSync(out);
  objects.push({
    key: entry.key,
    found: true,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    byteSize: bytes.byteLength,
  });
}
rmSync(tmpDir, { recursive: true, force: true });

// 孤児照合（R2のready/一覧との突き合わせ）はCLIでは行わない（wranglerにr2 object listが無いため）。
// Workers側のverifyRestore（tests/restore-consistency.test.ts）がR2 listで行う。実環境での孤児照合は
// R2のインベントリ/一覧取得を別途確立する（ops/backup-restore.md §3.3、docs/evidence/V07-restore.md「未実施」）。
const check = assembleRestoreCheck(manifest, {
  foreignKeyRows,
  counts,
  fts,
  missingJobRows,
  aclRows,
  deliveries,
  unrevokedUsers,
  objects,
  listedReadyKeys: [],
  orphanReadyObjects: [],
});
const notes: string[] = [];
if (!r2State || !existsSync(r2State)) notes.push("--r2-state 未指定のため、R2実体を「欠落」として報告している（実体の複製を指定して再実行すること）");
notes.push("孤児照合（R2のready/一覧との突き合わせ）はCLIでは未実施。workers試験（verifyRestore）がR2 listで行う");
console.log(JSON.stringify({ ...check, applied: { schema: schemaApplied, data: dataApplied }, notes }, null, 2));
process.exit(check.ok ? 0 : 1);
