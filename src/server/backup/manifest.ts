import type { AppEnv, AppEnvName } from "../env";

/**
 * バックアップmanifest（T079、docs/07 §7、docs/14 D10、docs/08 CT-08）。
 * 「D1復元点/R2 key/hash/参照/論理削除時刻」を記録し、復元後の照合（verifyRestore）と
 * 外部効果の差分照合（既送通知・旧sessions）の基準にする。行データは載せない
 * （本体はD1の論理ダンプとR2の不変キー実体。manifestはその索引。docs/07 §7「manifestと重要原本の別複製」）。
 */

/** manifestが対象とする表（sqlite_masterから内部表を除く。FTS仮想表は含め、影響表は除く） */
export const BACKUP_TABLE_SQL =
  "SELECT name FROM sqlite_master WHERE type = 'table' " +
  "AND name NOT LIKE 'sqlite\\_%' ESCAPE '\\' " +
  "AND name NOT LIKE '\\_%' ESCAPE '\\' " +
  "AND name NOT LIKE 'd1\\_%' ESCAPE '\\' " +
  "AND name NOT LIKE '%\\_fts\\_%' ESCAPE '\\' " +
  "ORDER BY name";

/** R2の保全対象（ready_keyが付いた添付。実体はhash固定の不変キー。docs/07 §3.5） */
export interface ManifestObject {
  key: string;
  attachmentId: string;
  unitId: string;
  sha256: string | null;
  byteSize: number;
  status: string;
}

/** 論理削除（tombstone）の記録。削除猶予と照合の対象（docs/07 §3.7、docs/14 D10） */
export interface ManifestTombstone {
  attachmentId: string;
  unitId: string;
  status: string;
  updatedAt: string;
}

/** 配送状態の記録（既送/未送の判定基準。deliveryKeyは再試行で不変。docs/07 §5） */
export interface ManifestDelivery {
  deliveryKey: string;
  status: string;
  attemptCount: number;
}

export interface BackupManifest {
  schemaVersion: "v1";
  appEnv: AppEnvName;
  /** D1復元点（このmanifestの取得時刻。D1 exportと同じ時点であることをrunbookが保証する） */
  restorePointAt: string;
  generatedBy: string;
  /** 表ごとの行数（復元後の件数照合に使う。FTS仮想表を含む） */
  d1: { tables: Record<string, number> };
  r2: ManifestObject[];
  tombstones: ManifestTombstone[];
  deliveries: ManifestDelivery[];
  /** 未確定job（queued/retry_wait/running）。復元後の再開・照合対象（docs/07 §7のrunbook項目） */
  jobsUncertain: number;
  /** 復元前のusers.session_revoked_before。復元手順は全userを復元点で失効させる（ops/backup-restore.md §4） */
  sessionRevokedBefore: Record<string, string | null>;
  /** CLIが付与する論理ダンプの参照（実ファイル名とhash。WorkersのbuildBackupManifestは付けない） */
  export?: { file: string; sha256: string };
}

/** manifestの組み立て（Workers bindingとCLI（wrangler d1 execute）の共通の正本） */
export function assembleBackupManifest(input: {
  appEnv: AppEnvName;
  restorePointAt: string;
  generatedBy: string;
  tables: string[];
  counts: number[];
  objects: ManifestObject[];
  tombstones: ManifestTombstone[];
  deliveries: ManifestDelivery[];
  jobsUncertain: number;
  users: { id: string; v: string | null }[];
}): BackupManifest {
  const tableCounts: Record<string, number> = {};
  input.tables.forEach((t, i) => {
    tableCounts[t] = input.counts[i] ?? 0;
  });
  return {
    schemaVersion: "v1",
    appEnv: input.appEnv,
    restorePointAt: input.restorePointAt,
    generatedBy: input.generatedBy,
    d1: { tables: tableCounts },
    r2: input.objects,
    tombstones: input.tombstones,
    deliveries: input.deliveries,
    jobsUncertain: input.jobsUncertain,
    sessionRevokedBefore: Object.fromEntries(input.users.map((u) => [u.id, u.v])),
  };
}

/**
 * D1とR2の現在状態から復元点のmanifestを作る（Workers bindingから直接呼べる。
 * scripts/backup-manifest.ts はCLIラッパで、同じ内容をwrangler d1 execute経由で作る）。
 * R2の実体そのものは読まない（hashは検査jobがD1へ確定した値が正本。存在とhashの照合はverifyRestoreが行う）。
 */
export async function buildBackupManifest(env: AppEnv, opts: { now?: Date; generatedBy?: string } = {}): Promise<BackupManifest> {
  const db = env.DB;
  const now = (opts.now ?? new Date()).toISOString();

  const tables = ((await db.prepare(BACKUP_TABLE_SQL).all<{ name: string }>()).results).map((r) => r.name);
  const counts = await db.batch(tables.map((t) => db.prepare(`SELECT count(*) AS n FROM "${t}"`)));
  const [objects, tombstones, deliveries, jobsUncertain, users] = await db.batch([
    db.prepare(
      "SELECT ready_key AS key, id AS attachmentId, unit_id AS unitId, sha256, byte_size AS byteSize, status " +
        "FROM attachments WHERE ready_key IS NOT NULL ORDER BY ready_key",
    ),
    db.prepare(
      "SELECT id AS attachmentId, unit_id AS unitId, status, updated_at AS updatedAt " +
        "FROM attachments WHERE status IN ('deleting', 'deleted') ORDER BY updated_at, id",
    ),
    db.prepare("SELECT delivery_key AS deliveryKey, status, attempt_count AS attemptCount FROM notification_deliveries ORDER BY delivery_key"),
    db.prepare("SELECT count(*) AS n FROM jobs WHERE status IN ('queued', 'retry_wait', 'running')"),
    db.prepare("SELECT id, session_revoked_before AS v FROM users ORDER BY id"),
  ]);

  return assembleBackupManifest({
    appEnv: env.APP_ENV,
    restorePointAt: now,
    generatedBy: opts.generatedBy ?? "buildBackupManifest",
    tables,
    counts: counts.map((r) => (r.results[0] as { n: number }).n),
    objects: objects!.results as unknown as ManifestObject[],
    tombstones: tombstones!.results as unknown as ManifestTombstone[],
    deliveries: deliveries!.results as unknown as ManifestDelivery[],
    jobsUncertain: (jobsUncertain!.results[0] as { n: number }).n,
    users: users!.results as { id: string; v: string | null }[],
  });
}
