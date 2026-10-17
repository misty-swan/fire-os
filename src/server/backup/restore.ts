import type { AppEnv } from "../env";
import { sha256OfBytes } from "../attachments/sizes";
import { BACKUP_TABLE_SQL, type BackupManifest } from "./manifest";

/**
 * 復元と整合照合（T079、docs/07 §7、docs/13 RG-05、docs/08 CT-08）。
 *
 * - readDump: 元D1の論理ダンプ（wrangler d1 export相当。実CloudflareのexportはFTS5仮想表で
 *   失敗するため、実環境でもこの論理ダンプかTime Travelを使う。ops/backup-restore.md §2）。
 * - applyRestore: 別環境のschema（migration適用済み）へ入れ直す。参照（FK）の親を先にINSERTし、
 *   子を先にDELETEする順序で壊さない。最後に全userのsessionを復元点で失効させる
 *   （docs/07 §7のrunbook「sessions失効」。API-38のusers.session_revoked_before機構を再利用。
 *   復元は「消えたはずのsession行を復活させる」操作なので、復元点より前のsessionは業務側で拒否する）。
 * - verifyRestore: 復元後の環境をmanifestと照合する（docs/07 §7の「欠落/孤児/重複/集計/ACL照合」と
 *   「旧job/effect/配送状態照合」の自動化部分。外部への再送はここでは起こさない。観測は試験が行う）。
 */

/** 表ごとの行（列名→値）。wrangler d1 export相当の論理ダンプ */
export type TableDump = Record<string, Record<string, unknown>[]>;

export interface RestoreApplySummary {
  restoredTables: number;
  restoredRows: number;
  sessionsRevokedAsOf: string;
}

export interface RestoreInput {
  /** 復元先のbinding（DB=復元先D1、FILES=保全したR2の別複製） */
  env: AppEnv;
  manifest: BackupManifest;
}

/** 復元後の照合結果（docs/08 CT-08「hash/FK/ACL/集計整合、既送再配信なし」に対応） */
export interface RestoreCheck {
  checkedAt: string;
  restorePointAt: string;
  ok: boolean;
  /** 参照切れ（PRAGMA foreign_key_check。D1バインディング経路では常に強制されるため、外部ツール由来の破れを検出する） */
  foreignKeyErrors: string[];
  /** ready実体がR2に無い（消失写真） */
  missingReadyObjects: string[];
  /** 実体はあるがhash/容量がmanifestと違う（書換え・破損） */
  hashMismatches: string[];
  /** R2にあるready実体のうち、どのattachments行も参照しないもの（削除漏れ・孤児。回収候補） */
  orphanReadyObjects: string[];
  /** 所属unitの整合を壊す参照（ACL境界） */
  aclViolations: string[];
  /** jobの参照切れ・検索索引のdrift（復元後の再開・索引再構築の対象） */
  jobIssues: string[];
  /** 配送状態がmanifestと違う（既送行の復元漏れ＝再送が起きる事故） */
  deliveryDiffs: string[];
  /** 表の行数がmanifest（復元点）と違う */
  countMismatches: string[];
  /** 復元点で失効していないuser（旧sessionが業務に入れてしまう） */
  unrevokedSessions: string[];
}

/** 照合に必要な問い合わせ結果（Workers bindingとCLIの両方が集める。比較の正本はassembleRestoreCheck） */
export interface RestoreCheckQueries {
  foreignKeyRows: { table: string; rowid: number; parent: string; fkid: number }[];
  /** manifestが持つ表だけの行数 */
  counts: { table: string; n: number }[];
  fts: { indexed: number; fts: number };
  /** jobの参照切れの検査（jobSourceCheckSqlの結果。参照先が無いjob） */
  missingJobRows: { kind: string; jobId: string; status: string; sourceId: string; table: string }[];
  /** ACL_CHECKSの結果（label＋行ID。同じunitの団員を参照していない行） */
  aclRows: { label: string; rowId: string }[];
  deliveries: { deliveryKey: string; status: string; attemptCount: number }[];
  unrevokedUsers: { id: string }[];
  /** R2実体の照合結果（keyごとの存在・hash・容量。sha256/byteSizeは実体が無いときnull） */
  objects: { key: string; found: boolean; sha256: string | null; byteSize: number | null }[];
  /** R2のready/前置きに実在するキー一覧（孤児照合用。CLIがR2一覧を持てない場合は空＝照合 skipped） */
  listedReadyKeys: string[];
  /** listedReadyKeysのうち、どのattachments行も参照しないもの（verifyRestoreが計算） */
  orphanReadyObjects: string[];
}

/** 所属unitの整合（ACL境界）の検査文。unitをまたぐ参照・欠けた参照は復元事故 */
export const ACL_CHECKS: { label: string; sql: string }[] = [
  {
    label: "notification_recipients",
    sql: "SELECT r.id AS rowId FROM notification_recipients r LEFT JOIN members m ON m.id = r.member_id AND m.unit_id = r.unit_id WHERE m.id IS NULL",
  },
  {
    label: "member_roles",
    sql: "SELECT mr.id AS rowId FROM member_roles mr LEFT JOIN members m ON m.id = mr.member_id AND m.unit_id = mr.unit_id WHERE m.id IS NULL",
  },
  {
    label: "scope_assignments",
    sql: "SELECT s.id AS rowId FROM scope_assignments s LEFT JOIN members m ON m.id = s.member_id AND m.unit_id = s.unit_id WHERE m.id IS NULL",
  },
  {
    label: "attachments",
    sql: "SELECT a.id AS rowId FROM attachments a LEFT JOIN members m ON m.id = a.owner_member_id AND m.unit_id = a.unit_id WHERE m.id IS NULL",
  },
];

/** jobの参照先（既知kindのsource_type/source_idの正本。多形参照のai.*は対象外） */
export const JOB_SOURCES: Record<string, { table: string; column: string }> = {
  "notification.deliver": { table: "notifications", column: "id" },
  "attachment.inspect": { table: "attachments", column: "id" },
  "attachment.cleanup": { table: "attachments", column: "id" },
  "auth.revoke_sessions": { table: "users", column: "id" },
  "document.index": { table: "document_versions", column: "id" },
  "document.deindex": { table: "document_versions", column: "id" },
  "document.reindex": { table: "document_versions", column: "id" },
  "document.extract": { table: "document_versions", column: "id" },
  "import.parse": { table: "import_batches", column: "id" },
  "import.commit": { table: "import_batches", column: "id" },
  "ai.report": { table: "activities", column: "id" },
};

/**
 * jobの参照切れの検査文（既知kindごとに参照先の表をLEFT JOINし、無いjobを返す。
 * 単文ごとに実行する（compound SELECTの項数上限に依らない。Workers bindingでは1batch、
 * CLIでは--fileの複数文）。多形参照のai.*は対象外。
 */
export const jobSourceCheckSql = (kind: string, source: { table: string; column: string }): string =>
  `SELECT '${kind}' AS kind, j.id AS jobId, j.status AS status, j.source_id AS sourceId, '${source.table}' AS "table" FROM jobs j LEFT JOIN "${source.table}" t ON t."${source.column}" = j.source_id WHERE j.kind = '${kind}' AND t.id IS NULL`;

/** 検索索引の整合（index_status='indexed' ⇔ FTS行が設計の不変量。0028_search_index.sql） */
export const FTS_DRIFT_SQL =
  "SELECT (SELECT count(*) FROM document_chunks WHERE index_status = 'indexed') AS indexed, (SELECT count(*) FROM document_chunks_fts) AS fts";

/** 元D1の全表を読む（試験とCLIが使う論理ダンプ。d1_migrations等の内部表はBACKUP_TABLE_SQLが除外する） */
export async function readDump(db: D1Database): Promise<TableDump> {
  const tables = ((await db.prepare(BACKUP_TABLE_SQL).all<{ name: string }>()).results).map((r) => r.name);
  const dump: TableDump = {};
  for (const t of tables) {
    dump[t] = (await db.prepare(`SELECT * FROM "${t}"`).all<Record<string, unknown>>()).results;
  }
  return dump;
}

/**
 * 復元先のschemaからINSERTの安全な順序（FKの親が先）を求める。
 * PRAGMA foreign_key_listで依存を取り、循環があれば名前順の後ろに付ける（D1バインディング経路では
 * FKは常に強制されるため、循環があるとINSERTが失敗して復元も止まる＝黙って壊した状態を作らない）。
 */
export async function restoreTableOrder(db: D1Database): Promise<string[]> {
  const tables = ((await db.prepare(BACKUP_TABLE_SQL).all<{ name: string }>()).results).map((r) => r.name);
  const known = new Set(tables);
  const parentsOf = new Map<string, string[]>();
  for (const t of tables) {
    let parents: string[] = [];
    try {
      const fks = (await db.prepare(`PRAGMA foreign_key_list("${t}")`).all<{ table: string }>()).results;
      parents = [...new Set(fks.map((f) => f.table))].filter((p) => known.has(p) && p !== t);
    } catch {
      parents = []; // PRAGMAが使えない環境では依存不明。名前順に並べ、失敗すれば復元が停止する
    }
    parentsOf.set(t, parents);
  }
  const order: string[] = [];
  const done = new Set<string>();
  const visiting = new Set<string>();
  const visit = (t: string): void => {
    if (done.has(t) || visiting.has(t)) return;
    visiting.add(t);
    for (const p of parentsOf.get(t) ?? []) visit(p);
    visiting.delete(t);
    done.add(t);
    order.push(t);
  };
  for (const t of tables) visit(t);
  return order;
}

/** 1行のINSERT文（列名は行から。SELECT *の行が全列を持つ） */
const insertStatement = (db: D1Database, table: string, row: Record<string, unknown>): D1PreparedStatement => {
  const cols = Object.keys(row);
  return db
    .prepare(`INSERT INTO "${table}" (${cols.map((c) => `"${c}"`).join(", ")}) VALUES (${cols.map(() => "?").join(", ")})`)
    .bind(...cols.map((c) => row[c]));
};

/** D1のbatchを分割して実行する（1batchの文数上限に依らない。1batch＝1transaction） */
const BATCH_CHUNK = 40;
async function batchAll(db: D1Database, statements: D1PreparedStatement[]): Promise<void> {
  for (let i = 0; i < statements.length; i += BATCH_CHUNK) {
    await db.batch(statements.slice(i, i + BATCH_CHUNK));
  }
}

/**
 * 追記専用・版履歴の表（drizzleのトリガーがDELETE/上書きINSERTを拒否する。docs/04 §1、PH0レビュー A-F3、
 * 0001/0003/0012/0020/0022/0024/0027）。復元はこの表を「書き戻す」のではなく、空のschemaへ新規に入れる。
 * 監査と履歴を復元で書き換えられないことは契約（docs/07 §1「監査は追記型」）と一致する。
 */
export const APPEND_ONLY_TABLES: readonly string[] = [
  "audit_logs",
  "domain_events",
  "document_versions",
  "report_versions",
  "content_version_events",
  "inspection_template_versions",
  "notification_events",
  "inspection_due_detections",
];

/**
 * 別環境のschemaへ論理ダンプを入れ直し、全userのsessionを復元点で失効させる。
 * 呼び出し側は**新規にmigrationを適用した空のschema**（別環境相当）を用意すること
 * （実環境では `wrangler d1 migrations apply` を空のpersist先へ。試験ではテストのresetRestoreTarget。
 * 追記専用表は在り得ない行から復元するため、行が残っている復元先へは拒否する）。
 */
export async function applyRestore(
  env: Pick<AppEnv, "DB">,
  dump: TableDump,
  opts: { restorePointAt: string },
): Promise<RestoreApplySummary> {
  const db = env.DB;
  const order = await restoreTableOrder(db);

  // 復元先が空であることの確認（追記専用表に残骸があると、監査/履歴を書き換えた復元になってしまう）
  for (const t of order) {
    const n = (await db.prepare(`SELECT count(*) AS n FROM "${t}"`).first<{ n: number }>())!.n;
    if (n > 0 && APPEND_ONLY_TABLES.includes(t)) {
      throw new Error(`applyRestore: 復元先の ${t} に既に行があります（追記専用表は書き戻せないため、復元先は新規にschemaを作った空の環境にしてください）`);
    }
  }

  const restoreTables = order.filter((t) => (dump[t]?.length ?? 0) > 0);

  // 子から親の順で空にする（参照で残る行を作らない。追記専用表は空であることを上で確認済み）
  await batchAll(
    db,
    order
      .filter((t) => !APPEND_ONLY_TABLES.includes(t))
      .slice()
      .reverse()
      .map((t) => db.prepare(`DELETE FROM "${t}"`)),
  );

  let restoredRows = 0;
  for (const t of restoreTables) {
    const rows = dump[t]!;
    try {
      await batchAll(db, rows.map((row) => insertStatement(db, t, row)));
    } catch (err) {
      throw new Error(`applyRestore: INSERT INTO ${t} が失敗: ${String(err)}`);
    }
    restoredRows += rows.length;
  }

  // 復元後sessions失効（docs/07 §7）。復元点より前のsessionは認証ライブラリに残っていても業務で拒否する
  await db
    .prepare(
      "UPDATE users SET session_revoked_before = ?1, updated_at = ?2 " +
        "WHERE session_revoked_before IS NULL OR session_revoked_before < ?1",
    )
    .bind(opts.restorePointAt, opts.restorePointAt)
    .run();

  return { restoredTables: restoreTables.length, restoredRows, sessionsRevokedAsOf: opts.restorePointAt };
}

/**
 * 復元後の環境をmanifestと照合する（docs/07 §7の「欠落/孤児/重複/集計/ACL照合」＋「旧job/effect/
 * 配送状態照合」の自動化部分）。R2の実体は読んでhashまで比べる（容量と内容の一致）。
 * 外部への再送はここでは起こさない。既送の再送が起きないことの観測は tests/restore-consistency.test.ts が
 * 配送jobを実行して確かめる（deliveryKeyの固定が機構）。CLI（scripts/restore-verify.ts）は
 * 同じ問い合わせをwrangler d1 executeで行い、同じassembleRestoreCheckで判定する。
 */
export async function verifyRestore(input: RestoreInput): Promise<RestoreCheck> {
  const { env, manifest } = input;
  const db = env.DB;

  const q: RestoreCheckQueries = {
    foreignKeyRows: (
      await db.prepare("PRAGMA foreign_key_check").all<{ table: string; rowid: number; parent: string; fkid: number }>()
    ).results,
    counts: Object.keys(manifest.d1.tables).map((table) => ({ table, n: 0 })),
    fts: { indexed: 0, fts: 0 },
    missingJobRows: [],
    aclRows: [],
    deliveries: (
      await db
        .prepare("SELECT delivery_key AS deliveryKey, status, attempt_count AS attemptCount FROM notification_deliveries")
        .all<{ deliveryKey: string; status: string; attemptCount: number }>()
    ).results,
    unrevokedUsers: (
      await db
        .prepare("SELECT id FROM users WHERE session_revoked_before IS NULL OR session_revoked_before < ?")
        .bind(manifest.restorePointAt)
        .all<{ id: string }>()
    ).results,
    objects: [],
    listedReadyKeys: [],
    orphanReadyObjects: [],
  };
  for (const c of ACL_CHECKS) {
    for (const row of (await db.prepare(c.sql).all<{ rowId: string }>()).results) {
      q.aclRows.push({ label: c.label, rowId: row.rowId });
    }
  }
  // jobの参照切れ（既知kindごとに1文。1batchで実行する）
  const jobResults = await db.batch(
    (Object.entries(JOB_SOURCES) as [string, { table: string; column: string }][]).map(([kind, source]) =>
      db.prepare(jobSourceCheckSql(kind, source)),
    ),
  );
  for (const r of jobResults) {
    q.missingJobRows.push(...(r.results as unknown as RestoreCheckQueries["missingJobRows"]));
  }
  // 行数とFTS（1batch。文の順序どおりに結果が返る）
  const countStatements = [
    ...q.counts.map((c) => db.prepare(`SELECT count(*) AS n FROM "${c.table}"`)),
    db.prepare(FTS_DRIFT_SQL),
  ];
  const countResults = await db.batch(countStatements);
  q.counts.forEach((c, i) => {
    c.n = (countResults[i]!.results[0] as { n: number }).n;
  });
  q.fts = countResults[q.counts.length]!.results[0] as unknown as { indexed: number; fts: number };

  // R2のready実体（存在とhash。docs/08 CT-08「消失写真」「hash照合」）
  for (const entry of manifest.r2) {
    const obj = await env.FILES.get(entry.key);
    if (!obj) {
      q.objects.push({ key: entry.key, found: false, sha256: null, byteSize: null });
      continue;
    }
    const bytes = new Uint8Array(await obj.arrayBuffer());
    q.objects.push({ key: entry.key, found: true, sha256: await sha256OfBytes(bytes), byteSize: bytes.byteLength });
  }

  // 孤児（docs/07 §3.7「削除遅延・孤児の照合」）。R2のready/前置きにあるのにどのattachments行も
  // 参照しない実体＝削除漏れ・遅延削除の取りこぼし。回収はしないで報告だけする（判断はrunbook §5）
  const referencedReady = new Set(
    ((await db.prepare("SELECT ready_key AS k FROM attachments WHERE ready_key IS NOT NULL").all<{ k: string }>()).results).map((r) => r.k),
  );
  let cursor: string | undefined;
  do {
    const page = await env.FILES.list({ prefix: "ready/", cursor });
    for (const obj of page.objects) {
      q.listedReadyKeys.push(obj.key);
      if (!referencedReady.has(obj.key)) q.orphanReadyObjects.push(obj.key);
    }
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);

  return assembleRestoreCheck(manifest, q);
}

/** 問い合わせ結果とmanifestから照合結果を組み立てる（Workers試験とCLIの共通の判定。ここだけが正本） */
export function assembleRestoreCheck(manifest: BackupManifest, q: RestoreCheckQueries): RestoreCheck {
  const check: RestoreCheck = {
    checkedAt: new Date().toISOString(),
    restorePointAt: manifest.restorePointAt,
    ok: false,
    foreignKeyErrors: [],
    missingReadyObjects: [],
    hashMismatches: [],
    orphanReadyObjects: q.orphanReadyObjects,
    aclViolations: [],
    jobIssues: [],
    deliveryDiffs: [],
    countMismatches: [],
    unrevokedSessions: [],
  };

  for (const r of q.foreignKeyRows) {
    check.foreignKeyErrors.push(`${r.table} の行(rowid=${r.rowid}) が ${r.parent} を参照していますが見つかりません (fkid=${r.fkid})`);
  }

  const countByTable = new Map(q.counts.map((c) => [c.table, c.n]));
  for (const [table, expected] of Object.entries(manifest.d1.tables)) {
    const actual = countByTable.get(table);
    if (actual !== undefined && actual !== expected) {
      check.countMismatches.push(`table ${table}: manifest=${expected} actual=${actual}`);
    }
  }

  for (const obj of q.objects) {
    if (!obj.found) {
      check.missingReadyObjects.push(obj.key);
      continue;
    }
    const entry = manifest.r2.find((r) => r.key === obj.key)!;
    if (entry.sha256 !== null && obj.sha256 !== entry.sha256) {
      check.hashMismatches.push(`${obj.key}: manifest sha256=${entry.sha256} actual=${obj.sha256}`);
    } else if (obj.byteSize !== entry.byteSize) {
      check.hashMismatches.push(`${obj.key}: manifest byteSize=${entry.byteSize} actual=${obj.byteSize}`);
    }
  }

  for (const row of q.aclRows) {
    check.aclViolations.push(`${row.label} の ${row.rowId} が同じunitの団員を参照していません`);
  }
  for (const j of q.missingJobRows) {
    check.jobIssues.push(`job ${j.jobId} (${j.kind}, status=${j.status}) の参照先 ${j.table}#${j.sourceId} がありません`);
  }
  if (q.fts.indexed !== q.fts.fts) {
    check.jobIssues.push(`fts_index_drift: document_chunks(indexed)=${q.fts.indexed} document_chunks_fts=${q.fts.fts}（document.reindexで再構築）`);
  }

  const byKey = new Map(q.deliveries.map((d) => [d.deliveryKey, d]));
  for (const m of manifest.deliveries) {
    const r = byKey.get(m.deliveryKey);
    if (!r) {
      check.deliveryDiffs.push(`delivery ${m.deliveryKey}: 復元されていません（manifest=${m.status}。復元後に再送が起きる）`);
    } else if (r.status !== m.status) {
      check.deliveryDiffs.push(`delivery ${m.deliveryKey}: statusが違います manifest=${m.status} restored=${r.status}`);
    } else if (r.attemptCount < m.attemptCount) {
      check.deliveryDiffs.push(`delivery ${m.deliveryKey}: attempt_countが後退しています manifest=${m.attemptCount} restored=${r.attemptCount}`);
    }
  }

  check.unrevokedSessions = q.unrevokedUsers.map((u) => u.id);

  check.ok =
    check.foreignKeyErrors.length === 0 &&
    check.missingReadyObjects.length === 0 &&
    check.hashMismatches.length === 0 &&
    check.orphanReadyObjects.length === 0 &&
    check.aclViolations.length === 0 &&
    check.jobIssues.length === 0 &&
    check.deliveryDiffs.length === 0 &&
    check.countMismatches.length === 0 &&
    check.unrevokedSessions.length === 0;
  return check;
}
