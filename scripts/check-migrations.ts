// migrationの互換性・段階化の静的検査（T078）。scripts/migrate.ts の連番規律（欠番・重番を拒否）と矛盾させない。
// - 純関数（checkMigrationCompatibility / parseManifest / migrationSequenceProblems）は試験（tests/deploy-config.test.ts）から
//   直接呼ぶ。CLI（`npm run check:migrations`）は drizzle/ の実ファイルと git HEAD（適用済み履歴の基準）を比較する。
// - 方針は forward-fix。schema rollbackは「コードを戻すだけでは解決しない」（ops/deploy.md §4.2）ため、
//   破壊的変更は expand → backfill → contract に段階化することだけをファイルレベルで強制する:
//   削除等を含むmigrationには `-- deploy: contract` と `-- requires: <expandのNNNN>` を書く。
//   マーカーはファイルに残り続けるので、適用済みcontractも検査を通る。
export type MigrationEntry = { id: string; name: string; sql: string };

export type SchemaManifest = { entries: MigrationEntry[] };

export type CompatibilityResult = {
  ok: boolean;
  failures: string[];
  /** 破壊と思われる操作の検出詳細（markerの有無を含む） */
  destructive: string[];
};

const ID_PATTERN = /^(\d{4})_/;

/** ファイル名→SQL の対応からmanifestを作る（id昇順に並べる） */
export function parseManifest(files: Record<string, string>): SchemaManifest {
  const entries = Object.entries(files).map(([name, sql]) => {
    const match = ID_PATTERN.exec(name);
    return { id: match?.[1] ?? name, name, sql };
  });
  entries.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : a.name < b.name ? -1 : 1));
  return { entries };
}

/** 連番の検査。scripts/migrate.ts と同じ規律（ソート済みで 0001_ から1ずつ。欠番・重番を拒否）。 */
export function migrationSequenceProblems(names: readonly string[]): string[] {
  const problems: string[] = [];
  names.forEach((name, index) => {
    const expected = `${String(index + 1).padStart(4, "0")}_`;
    if (!name.startsWith(expected)) problems.push(`${name}（${expected} で始まる必要があります）`);
  });
  return problems;
}

// 破壊と思われるschema操作。DROP TRIGGER は差し替えの定石（0025が実例）なので対象外。
const DESTRUCTIVE_PATTERNS: ReadonlyArray<readonly [RegExp, string]> = [
  [/\bDROP\s+TABLE\b/i, "DROP TABLE"],
  [/\bDROP\s+COLUMN\b/i, "DROP COLUMN"],
  [/\bALTER\s+COLUMN\b/i, "ALTER COLUMN"],
  [/\bRENAME\s+(?:TABLE|COLUMN)\b/i, "RENAME"],
  [/\bDROP\s+INDEX\b/i, "DROP INDEX"],
];
const CONTRACT_MARKER = /^\s*--\s*deploy:\s*contract\b/m;
const REQUIRES_MARKER = /^\s*--\s*requires:\s*(\d{4})/m;

export function checkMigrationCompatibility(previous: SchemaManifest, next: SchemaManifest): CompatibilityResult {
  const failures: string[] = [];
  const destructive: string[] = [];

  // 1) 適用済み履歴は書き換えない。履歴が適用済みDBと一致しなくなると、以後のmigration適用・旧workerの前提が崩れる。
  previous.entries.forEach((entry, index) => {
    const counterpart = next.entries[index];
    if (counterpart === undefined || counterpart.id !== entry.id || counterpart.name !== entry.name || counterpart.sql !== entry.sql) {
      failures.push(`適用済みmigration ${entry.name} が書き換え・削除・並べ替えされています。履歴は変更せず、新しいNNNNを追加してください`);
    }
  });

  // 2) 追加されたmigrationは既存の末尾から1ずつ連続して増える（欠番・逆順・重番の検出。migrate.tsの規律と整合）
  const lastPreviousId = previous.entries.at(-1)?.id;
  const previousBase = lastPreviousId === undefined ? 0 : Number.parseInt(lastPreviousId, 10);
  const newEntries = next.entries.slice(previous.entries.length);
  newEntries.forEach((entry, offset) => {
    const expectedNumber = previousBase + offset + 1;
    const actualNumber = Number.parseInt(entry.id, 10);
    if (!Number.isFinite(actualNumber) || actualNumber !== expectedNumber) {
      failures.push(`新しいmigrationの番号が連続していません: ${entry.name}（${String(expectedNumber).padStart(4, "0")} を次に追加する）`);
    }
  });

  // 3) 破壊的変更は段階化されている場合のみ許す。旧workerが読む表・列を新workerの配備前に削除しないための規律。
  for (const entry of next.entries) {
    const codeLines = entry.sql
      .split("\n")
      .filter((line) => !/^\s*--/.test(line))
      .join("\n");
    const hasContractMarker = CONTRACT_MARKER.test(entry.sql);
    for (const [pattern, label] of DESTRUCTIVE_PATTERNS) {
      if (!pattern.test(codeLines)) continue;
      const detail = `${entry.name}: ${label}`;
      destructive.push(detail + (hasContractMarker ? "（contract markerあり）" : "（marker無し）"));
      const requiredId = REQUIRES_MARKER.exec(entry.sql)?.[1];
      const requiredEntry = requiredId === undefined ? undefined : next.entries.find((candidate) => candidate.id === requiredId);
      if (!hasContractMarker || requiredEntry === undefined || requiredEntry.id >= entry.id) {
        failures.push(
          `${detail} は -- deploy: contract と -- requires: <expandのNNNN>（このファイルより前の番号）を付けて段階化してください。` +
            "expand（追加）→backfill（データ退避）→新worker配備→contract（削除）の順で適用すること（ops/deploy.md §4.2）",
        );
      }
    }
  }

  return { ok: failures.length === 0, failures, destructive };
}

// ==== 以下、CLI（npm run check:migrations）。試験からは呼ばれない（node:fs / git は動的import）。 ====

type NodeFs = typeof import("node:fs");
type NodeCp = typeof import("node:child_process");
async function lazyFs(): Promise<NodeFs> {
  const specifier = "node:" + "fs";
  return (await import(/* @vite-ignore */ specifier)) as NodeFs;
}
async function lazyChildProcess(): Promise<NodeCp> {
  const specifier = "node:" + "child_process";
  return (await import(/* @vite-ignore */ specifier)) as NodeCp;
}

/** gitのref（既定HEAD＝適用済み履歴の基準）からmanifestを組む。gitが使えない場合は空（全件を新規扱い）。 */
async function loadManifestAtRef(ref: string): Promise<SchemaManifest> {
  try {
    const cp = await lazyChildProcess();
    const options = { encoding: "utf8" as const, maxBuffer: 10 * 1024 * 1024 };
    const ls = cp.spawnSync("git", ["ls-tree", "--name-only", ref, "drizzle/"], options);
    if (ls.status !== 0 || typeof ls.stdout !== "string") throw new Error(ls.stderr ?? "git ls-tree failed");
    const names = ls.stdout
      .split("\n")
      .map((line) => line.split("/").at(-1) ?? "")
      .filter((name) => name.endsWith(".sql"))
      .sort();
    const files: Record<string, string> = {};
    for (const name of names) {
      const show = cp.spawnSync("git", ["show", `${ref}:drizzle/${name}`], options);
      if (show.status !== 0 || typeof show.stdout !== "string") throw new Error(show.stderr ?? `git show failed: ${name}`);
      files[name] = show.stdout;
    }
    return parseManifest(files);
  } catch {
    console.log(`git ${ref} から履歴を取得できないため、全件を新規扱いで検査します`);
    return { entries: [] };
  }
}

async function main(): Promise<number> {
  const fs = await lazyFs();
  const names = fs.readdirSync("drizzle").filter((file) => file.endsWith(".sql")).sort();
  const files: Record<string, string> = {};
  for (const name of names) files[name] = fs.readFileSync(`drizzle/${name}`, "utf8");
  const next = parseManifest(files);
  const previous = await loadManifestAtRef("HEAD");

  const compat = checkMigrationCompatibility(previous, next);
  const problems = [...migrationSequenceProblems(names), ...compat.failures];
  if (problems.length) {
    console.error("migration検査に失敗:\n- " + problems.join("\n- "));
    return 1;
  }
  console.log(`migration検査OK: ${next.entries.length}件 / 連番・適用済み履歴（HEAD基準）・破壊的変更の段階化`);
  return 0;
}

const runningAsCli = typeof process !== "undefined" && process.argv[1]?.endsWith("check-migrations.ts");
if (runningAsCli) {
  void main().then((code) => process.exit(code));
}
