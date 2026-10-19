// 受入ゲート（T085）の共通部品。check-coverage.ts・collect-evidence.ts・tests/acceptance/all-requirements.spec.ts が共有する。
//
// 役割の分担（コントローラ裁定R2）:
//  - 静的検査（checkCoverage）: ID集合を正本（docs/08・docs/12・契約台帳・画面台帳）から機械抽出し、manifestの欠落/余剰、
//    参照先テストの実在・skip/only/todo/fixme宣言の有無、API参照先ファイルがそのrouteを叩くこと、画面参照先がその画面へ行くことを検査する。
//  - 結果照合（evaluateGate）: collect-evidence.ts が実行して保存した証跡index（docs/evidence/acceptance-index.json）を読み、
//    参照先テストが「今のコード」で実行され合格したかを判定する。コードがindex作成後に変わっていれば全件「未実行」。
// ID集合はハードコードしない（裁定R9。件数のずれを正本との突合で自己検出する）。
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { apiDef, apiIds } from "../src/shared/contracts/registry";
import { screens } from "../src/client/screens";

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const MANIFEST_PATH = "tests/acceptance/manifest.json";
export const INDEX_PATH = "docs/evidence/acceptance-index.json";
export const RESULTS_MD_PATH = "docs/evidence/acceptance-results.md";
const DOC08 = "docs/08_テスト・受入計画.md";
const DOC12 = "docs/12_要件トレーサビリティ.md";

/** e2eのプロジェクト（playwright.config.ts）。参照の `@project` 指定に使える名前 */
export const E2E_PROJECTS = ["phone-360", "desktop-1280", "tablet-768"] as const;

// ---------------------------------------------------------------- manifestの型

/**
 * テスト参照。文字列 `"<file>::<title>"`（e2eは末尾に `@phone-360` 等でプロジェクトを限定できる。複数は `@a,b`）。
 * - vitest/load: title は `describe > it`（JSON reporterの ancestorTitles＋title を " > " で連結した完全名）
 * - e2e: title は test名（describeがあれば `describe > test`）
 * 種別はファイルの場所で決まる（tests/e2e/ → e2e、tests/load/ → load、それ以外の tests/ → vitest）。
 */
export type TestRefString = string;

export interface CtMapping {
  /** このAT×CTを実際に試している実テスト */
  tests?: TestRefString[];
  /** docs/08 §2「read-onlyや純粋な表示要件に不要なmutation試験を実施したことにしない」に当たる組合せだけ。理由必須 */
  notApplicable?: string;
  /** 実外部・実端末・人の手順が残る部分（externalのid）。ローカルの試験を置き換えない＝testsかnotApplicableも必須 */
  external?: string[];
  note?: string;
}

export interface AcceptanceEntry {
  id: string;
  reqId: string;
  /** ATのシナリオ（docs/08 §3）を開発版（架空データ・ローカル）で通している実テスト */
  tests: TestRefString[];
  /** docs/08 §3 の「共通否定/故障試験」列の各CT */
  ct: Record<string, CtMapping>;
  /** 実外部・実端末・人の手順が残る部分（externalのid）。合格に数えない */
  external?: string[];
  note?: string;
}

export interface LegacyEntry {
  id: string;
  reqIds: string[];
  tests: TestRefString[];
  /** 実外部・実端末・人の残手順（externalのid）。合格に数えない */
  external?: string[];
  note?: string;
}

export interface JourneyEntry {
  id: string;
  name: string;
  test: TestRefString;
  covers: string[];
}

export interface ExternalEntry {
  id: string;
  /** 根拠の文書と節・番号（V文書の「未実施」・ops/device-test-matrix.md §2 等） */
  source: string;
  summary: string;
  owner: string;
}

export interface IssueEntry {
  id: string;
  source: string;
  summary: string;
  severity: "critical" | "high" | "medium" | "low";
  status: "open" | "resolved";
  /** 重大度の根拠（証跡の行） */
  basis: string;
  owner: string;
}

export interface SkipEntry {
  test: TestRefString;
  project: string;
  reason: string;
  /** 同じ試験の合格を証拠にしてよいプロジェクト */
  evidenceProject: string;
}

export interface AcceptanceManifest {
  version: string;
  note?: string;
  acceptance: AcceptanceEntry[];
  legacy: LegacyEntry[];
  apis: Record<string, TestRefString[]>;
  screens: Record<string, TestRefString[]>;
  journeys: JourneyEntry[];
  external: ExternalEntry[];
  issues: IssueEntry[];
  knownSkips: SkipEntry[];
}

export function loadManifest(path = MANIFEST_PATH): AcceptanceManifest {
  return JSON.parse(readFileSync(join(ROOT, path), "utf8")) as AcceptanceManifest;
}

// ---------------------------------------------------------------- 参照の解釈

export type TestKind = "vitest" | "e2e" | "load";
export interface ParsedRef {
  raw: string;
  kind: TestKind;
  file: string;
  title: string;
  projects: string[];
}

export function parseRef(raw: string): ParsedRef {
  const sep = raw.indexOf("::");
  if (sep < 0) throw new Error(`テスト参照の形式が不正です（"<file>::<title>"）: ${raw}`);
  const file = raw.slice(0, sep);
  let title = raw.slice(sep + 2);
  let projects: string[] = [];
  const at = title.lastIndexOf("@");
  if (at >= 0) {
    const cand = title.slice(at + 1).split(",");
    if (cand.every((p) => (E2E_PROJECTS as readonly string[]).includes(p))) {
      projects = cand;
      title = title.slice(0, at);
    }
  }
  const kind: TestKind = file.startsWith("tests/e2e/") ? "e2e" : file.startsWith("tests/load/") ? "load" : "vitest";
  return { raw, kind, file, title, projects };
}

// ---------------------------------------------------------------- 正本からのID抽出

export interface DocIds {
  designVersion: string;
  requirements: string[];
  acceptance: { id: string; reqId: string; cts: string[]; scenario: string }[];
  commonTests: string[];
  legacy: { id: string; reqIds: string[] }[];
  apis: { id: string; method: string; path: string }[];
  screens: { id: string; path: string; aliases: string[] }[];
}

const read = (p: string) => readFileSync(join(ROOT, p), "utf8");

export function extractDocIds(): DocIds {
  const d08 = read(DOC08).split("\n");
  const d12 = read(DOC12).split("\n");
  const commonTests = d08.map((l) => l.match(/^\| (CT-\d{2}) \|/)?.[1]).filter((v): v is string => !!v);
  const acceptance = d08
    .map((l) => l.match(/^\| (AT-[A-Z0-9]+-\d{2}) \| ([A-Z0-9]+-\d{2}) \| ([^|]+) \|.*\| (CT-[\d,]+) \|$/))
    .filter((m): m is RegExpMatchArray => !!m)
    .map((m) => ({
      id: m[1]!,
      reqId: m[2]!,
      scenario: m[3]!.trim(),
      cts: m[4]!.replace(/^CT-/, "").split(",").map((n) => `CT-${n.trim()}`),
    }));
  const legacy = d08
    .map((l) => l.match(/^\| (TC-\d{2}) \| ([^|]+) \|/))
    .filter((m): m is RegExpMatchArray => !!m)
    .map((m) => {
      // 「ACT-01/02」「MAP-05/06」は同じ接頭辞の複数要件、「RG-09」はリリースゲート
      const raw = m[2]!.trim();
      const [head, ...rest] = raw.split("/");
      const prefix = head!.replace(/\d+$/, "");
      return { id: m[1]!, reqIds: [head!, ...rest.map((n) => `${prefix}${n}`)] };
    });
  // docs/12 §2 の要件行（リリース対象列のある表）
  const requirements = d12
    .map((l) => l.match(/^\| ([A-Z]+[0-9]*-\d{2}) \| (初回必須|採用確認待ち[^|]*) \|/)?.[1])
    .filter((v): v is string => !!v);
  const designVersion = [DOC08, DOC12]
    .map((p) => `${p.replace(/^docs\//, "").replace(/_.*$/, "")}:${read(p).match(/^版：(v[\d.]+ \/ [\d-]+)/m)?.[1] ?? "不明"}`)
    .join(" ");
  return {
    designVersion,
    requirements,
    acceptance,
    commonTests,
    legacy,
    apis: apiIds.map((id) => ({ id, method: apiDef(id).method, path: apiDef(id).path })),
    screens: screens.map((s) => ({ id: s.id, path: s.path, aliases: s.aliases ?? [] })),
  };
}

// ---------------------------------------------------------------- テストファイルの静的解析

const fileCache = new Map<string, string | null>();
export function readTestFile(file: string): string | null {
  if (!fileCache.has(file)) {
    const p = join(ROOT, file);
    fileCache.set(file, existsSync(p) ? readFileSync(p, "utf8") : null);
  }
  return fileCache.get(file)!;
}

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** タイトルの各段（describe と it/test）がテスト宣言の文字列として存在するか。skip/only/todo/fixme 宣言なら理由を返す */
export function staticRefProblems(ref: ParsedRef): string[] {
  const src = readTestFile(ref.file);
  if (src === null) return [`${ref.raw}: ファイルが無い`];
  const problems: string[] = [];
  const parts = ref.title.split(" > ");
  const last = parts[parts.length - 1]!;
  const decl = (fn: string, title: string) =>
    new RegExp(`\\b${fn}(?:\\.(\\w+))?\\(\\s*\\n?\\s*(["'\`])${esc(title)}\\2`, "g");
  const testDecls = [...src.matchAll(decl("(?:it|test)", last))];
  if (testDecls.length === 0) problems.push(`${ref.raw}: テスト宣言が見つからない`);
  for (const m of testDecls) {
    if (m[1] && ["skip", "only", "todo", "fixme", "fails"].includes(m[1])) problems.push(`${ref.raw}: ${m[1]} 宣言`);
  }
  for (const d of parts.slice(0, -1)) {
    const ds = [...src.matchAll(decl("(?:describe|test\\.describe)", d))];
    if (ds.length === 0) problems.push(`${ref.raw}: describe「${d}」が見つからない`);
    for (const m of ds) if (m[1] && ["skip", "only", "todo", "fixme"].includes(m[1])) problems.push(`${ref.raw}: describe ${m[1]} 宣言`);
  }
  // 本文に条件付きskipを持つe2e試験は、合格したプロジェクトを明示しないと「skipを証拠にする」ことになる
  if (ref.kind === "e2e" && testDecls.length > 0 && ref.projects.length === 0) {
    const start = testDecls[0]!.index!;
    const next = src.slice(start + 1).search(/\n(?:test|it)(?:\.\w+)?\(/);
    const body = src.slice(start, next < 0 ? undefined : start + 1 + next);
    if (/\btest\.skip\(/.test(body)) problems.push(`${ref.raw}: 本文に条件付きskipがあるためプロジェクト指定（@phone-360等）が必要`);
  }
  return problems;
}

/** 参照ファイル本文の正規化（正規表現リテラル中の `\/` を `/` に戻す） */
const normalized = (src: string) => src.replace(/\\\//g, "/");

/**
 * パスのパラメータ部分にマッチする表現（テンプレート式・正規表現の文字クラス・実値）。
 * 実値は「UUID」か、:type の列挙値（facility/vehicle/equipment）だけを認める。任意の英数字を認めると
 * `/facilities/:id` が固定段の `/facilities/imports` にも当たり、叩いていないrouteを叩いたことにしてしまう（T085レビューB-m2）
 */
const PARAM_ANY = String.raw`\$\{[^}]*\}|\[[^\]]*\][+*]|\.\+|\.\*|\(\[\^/\]\+\)|(?:\(\?![^)]*\))?\[\^/\]\+`;
const UUID_LITERAL = String.raw`[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}`;
const paramPattern = (name: string) => `(?:${PARAM_ANY}|${UUID_LITERAL}${name === "type" ? "|facility|vehicle|equipment" : ""})`;

export function routePattern(apiPath: string): RegExp {
  const full = apiPath.startsWith("/api/") ? apiPath : `/api/v1${apiPath}`;
  const body = full
    .split("/")
    .map((seg) => (seg.startsWith(":") ? paramPattern(seg.slice(1)) : seg === "*" ? "[A-Za-z0-9_\\-/]+" : esc(seg)))
    .join("/");
  // 直後が別の段（/x）や英数字に続かないこと（/facilities が /facilities/imports に当たらないように）
  return new RegExp(`${body}(?![A-Za-z0-9_\\-]|/[A-Za-z0-9_$])`);
}

/** APIの参照ファイルがそのroute（method＋path）を実際に叩くか（R2「API参照先ファイルがそのrouteを実際に叩くこと」） */
export function fileHitsRoute(file: string, method: string, apiPath: string): boolean {
  const src = readTestFile(file);
  if (src === null) return false;
  const lines = normalized(src).split("\n");
  const re = routePattern(apiPath);
  const methodRe = method === "ALL" ? /./ : new RegExp(`["'\`]${method}["'\`]|\\b${method.toLowerCase()}\\(|method:\\s*["'\`]${method}`);
  const otherMethod = /["'`](POST|PUT|PATCH|DELETE)["'`]|method:\s*["'`](POST|PUT|PATCH|DELETE)/;
  for (let i = 0; i < lines.length; i++) {
    if (!re.test(lines[i]!)) continue;
    const win = lines.slice(Math.max(0, i - 3), i + 4).join("\n");
    if (methodRe.test(win)) return true;
    // GETは既定method（fetch(url)・page.request.get等）でも叩ける。窓に他のmethodが無ければGETとみなす
    if (method === "GET" && !otherMethod.test(lines[i]!)) return true;
  }
  return false;
}

/** e2e参照ファイルが画面のパス（または別入口）へ実際に行くか */
export function fileVisitsScreen(file: string, paths: string[]): boolean {
  const src = readTestFile(file);
  if (src === null) return false;
  const text = normalized(src);
  return paths.some((p) => {
    const body = p
      .split("/")
      .map((seg) => (seg.startsWith(":") ? paramPattern(seg.slice(1)) : esc(seg)))
      .join("/");
    return new RegExp(`${body}(?![A-Za-z0-9_\\-]|/[A-Za-z0-9_$])`).test(text);
  });
}

// ---------------------------------------------------------------- 静的検査

export interface CoverageResult {
  counts: { requirements: number; acceptance: number; ctPairs: number; ctNotApplicable: number; commonTests: number; legacy: number; apis: number; screens: number; journeys: number; external: number };
  missingRequirementIds: string[];
  missingApiIds: string[];
  missingScreenIds: string[];
  invalidRefs: string[];
  structureProblems: string[];
  notApplicable: { pair: string; reason: string }[];
  /** manifestが参照する全テスト（重複なし） */
  allRefs: string[];
  /** テスト参照 → それが証拠になる要件・ケースID */
  refOwners: Map<string, Set<string>>;
}

export const REQUIRED_JOURNEYS = ["J1", "J2", "J3", "J4"] as const;

export function checkCoverage(manifest: AcceptanceManifest, ids: DocIds = extractDocIds()): CoverageResult {
  const missingRequirementIds: string[] = [];
  const missingApiIds: string[] = [];
  const missingScreenIds: string[] = [];
  const invalidRefs = new Set<string>();
  const structureProblems: string[] = [];
  const notApplicable: { pair: string; reason: string }[] = [];
  const refOwners = new Map<string, Set<string>>();
  const own = (ref: string, owner: string) => {
    if (!refOwners.has(ref)) refOwners.set(ref, new Set());
    refOwners.get(ref)!.add(owner);
  };
  const validRef = (raw: string, owner: string, requireKind?: TestKind[]): boolean => {
    let ref: ParsedRef;
    try {
      ref = parseRef(raw);
    } catch (e) {
      invalidRefs.add(String((e as Error).message));
      return false;
    }
    own(raw, owner);
    const probs = staticRefProblems(ref);
    if (requireKind && !requireKind.includes(ref.kind)) probs.push(`${raw}: ${owner} には ${requireKind.join("/")} の試験が必要`);
    probs.forEach((p) => invalidRefs.add(p));
    return probs.length === 0;
  };
  const externalIds = new Set((manifest.external ?? []).map((e) => e.id));

  // 抽出の空振りの検出（表の書式が変わってパーサが0件を返すと、何も検査せずに緑になるため。T085レビューB-m1）
  for (const [label, n] of [["docs/12の要件", ids.requirements.length], ["docs/08のAT", ids.acceptance.length], ["docs/08のCT", ids.commonTests.length], ["docs/08の継続TC", ids.legacy.length], ["契約台帳のAPI", ids.apis.length], ["画面台帳のSCR", ids.screens.length]] as const) {
    if (n === 0) structureProblems.push(`${label}を1件も抽出できない（正本の表の書式を確認）`);
  }
  // 継続TCは TC-01 から欠番なく連番（docs/08 §4「既存シナリオは削除しない」）
  ids.legacy.forEach((tc, i) => {
    if (tc.id !== `TC-${String(i + 1).padStart(2, "0")}`) structureProblems.push(`docs/08 §4のTCが連番でない: ${tc.id}（期待 TC-${String(i + 1).padStart(2, "0")}）`);
  });
  const legacyReqOk = ids.legacy.flatMap((tc) => tc.reqIds).filter((r) => !r.startsWith("RG-") && !ids.requirements.includes(r));
  if (legacyReqOk.length) structureProblems.push(`TCの対応要件がdocs/12に無い: ${legacyReqOk.join(",")}`);

  // 正本どうしの突合（件数ずれの自己検出）
  const reqSet = new Set(ids.requirements);
  const atReqs = new Set(ids.acceptance.map((a) => a.reqId));
  for (const r of ids.requirements) if (!atReqs.has(r)) structureProblems.push(`docs/12の要件 ${r} に対応するATがdocs/08に無い`);
  for (const r of atReqs) if (!reqSet.has(r)) structureProblems.push(`docs/08のATの要件 ${r} がdocs/12に無い`);
  const ctSet = new Set(ids.commonTests);
  for (const a of ids.acceptance) for (const c of a.cts) if (!ctSet.has(c)) structureProblems.push(`${a.id} のCT列 ${c} がdocs/08 §2に無い`);
  const usedCts = new Set(ids.acceptance.flatMap((a) => a.cts));
  for (const c of ids.commonTests) if (!usedCts.has(c)) structureProblems.push(`${c} を適用するATが無い`);

  // AT（要件）
  const byAt = new Map((manifest.acceptance ?? []).map((e) => [e.id, e]));
  for (const extra of byAt.keys()) if (!ids.acceptance.some((a) => a.id === extra)) structureProblems.push(`manifestに正本に無いAT: ${extra}`);
  for (const at of ids.acceptance) {
    const entry = byAt.get(at.id);
    const missing: string[] = [];
    if (!entry) {
      missingRequirementIds.push(`${at.reqId}（${at.id}: manifestに無い）`);
      continue;
    }
    if (entry.reqId !== at.reqId) structureProblems.push(`${at.id}: reqIdが正本(${at.reqId})と違う(${entry.reqId})`);
    const okTests = (entry.tests ?? []).filter((t) => validRef(t, at.id));
    if (okTests.length === 0) missing.push("ATの実テスト無し");
    for (const x of entry.external ?? []) if (!externalIds.has(x)) structureProblems.push(`${at.id}: 未定義のexternal ${x}`);
    const given = Object.keys(entry.ct ?? {});
    for (const g of given) if (!at.cts.includes(g)) structureProblems.push(`${at.id}: docs/08の適用表に無いCT ${g}`);
    for (const c of at.cts) {
      const m = entry.ct?.[c];
      const pair = `${at.id}×${c}`;
      if (!m) {
        missing.push(`${c}未対応`);
        continue;
      }
      for (const x of m.external ?? []) if (!externalIds.has(x)) structureProblems.push(`${pair}: 未定義のexternal ${x}`);
      if (m.notApplicable !== undefined) {
        if (m.notApplicable.trim().length < 15) missing.push(`${c}のnotApplicable理由が不十分`);
        else notApplicable.push({ pair, reason: m.notApplicable });
        if (m.tests?.length) structureProblems.push(`${pair}: notApplicableとtestsを同時に持つ`);
        continue;
      }
      const ok = (m.tests ?? []).filter((t) => validRef(t, pair));
      if (ok.length === 0) missing.push(`${c}の実テスト無し`);
    }
    if (missing.length) missingRequirementIds.push(`${at.reqId}（${at.id}: ${missing.join("・")}）`);
  }

  // 継続TC
  const byTc = new Map((manifest.legacy ?? []).map((e) => [e.id, e]));
  for (const extra of byTc.keys()) if (!ids.legacy.some((l) => l.id === extra)) structureProblems.push(`manifestに正本に無いTC: ${extra}`);
  for (const tc of ids.legacy) {
    const entry = byTc.get(tc.id);
    if (!entry) {
      missingRequirementIds.push(`${tc.id}（manifestに無い）`);
      continue;
    }
    if (entry.reqIds.join(",") !== tc.reqIds.join(",")) structureProblems.push(`${tc.id}: 対応要件が正本(${tc.reqIds})と違う(${entry.reqIds})`);
    const ok = (entry.tests ?? []).filter((t) => validRef(t, tc.id));
    if (ok.length === 0) missingRequirementIds.push(`${tc.id}（実テスト無し）`);
    for (const x of entry.external ?? []) if (!externalIds.has(x)) structureProblems.push(`${tc.id}: 未定義のexternal ${x}`);
  }

  // 横断journey（T085本文の4動線）
  const journeyIds = new Set((manifest.journeys ?? []).map((j) => j.id));
  for (const j of REQUIRED_JOURNEYS) if (!journeyIds.has(j)) missingRequirementIds.push(`${j}（横断journeyがmanifestに無い）`);
  for (const j of manifest.journeys ?? []) if (!validRef(j.test, j.id, ["e2e"])) missingRequirementIds.push(`${j.id}（journeyの実テストが無効）`);

  // API（route所有の実テスト。参照ファイルがrouteを実際に叩くこと）
  const apiMap = manifest.apis ?? {};
  for (const extra of Object.keys(apiMap)) if (!ids.apis.some((a) => a.id === extra)) structureProblems.push(`manifestに台帳に無いAPI: ${extra}`);
  for (const api of ids.apis) {
    const refs = apiMap[api.id] ?? [];
    const ok = refs.filter((r) => {
      if (!validRef(r, api.id)) return false;
      const ref = parseRef(r);
      if (!fileHitsRoute(ref.file, api.method, api.path)) {
        invalidRefs.add(`${r}: ${api.id}（${api.method} ${api.path}）を叩く記述がファイルに無い`);
        return false;
      }
      return true;
    });
    if (ok.length === 0) missingApiIds.push(`${api.id} ${api.method} ${api.path}`);
  }

  // 画面（実ブラウザ試験が画面へ行くこと）
  const scrMap = manifest.screens ?? {};
  for (const extra of Object.keys(scrMap)) if (!ids.screens.some((s) => s.id === extra)) structureProblems.push(`manifestに台帳に無い画面: ${extra}`);
  for (const scr of ids.screens) {
    const refs = scrMap[scr.id] ?? [];
    const ok = refs.filter((r) => {
      if (!validRef(r, scr.id, ["e2e"])) return false;
      const ref = parseRef(r);
      if (!fileVisitsScreen(ref.file, [scr.path, ...scr.aliases])) {
        invalidRefs.add(`${r}: ${scr.id}（${scr.path}）へ行く記述がファイルに無い`);
        return false;
      }
      return true;
    });
    if (ok.length === 0) missingScreenIds.push(`${scr.id} ${scr.path}`);
  }

  const referencedExternal = new Set([
    ...(manifest.acceptance ?? []).flatMap((a) => [...(a.external ?? []), ...Object.values(a.ct ?? {}).flatMap((m) => m.external ?? [])]),
    ...(manifest.legacy ?? []).flatMap((l) => l.external ?? []),
  ]);
  for (const e of manifest.external ?? []) {
    if (!e.source || !e.owner) structureProblems.push(`external ${e.id}: 根拠文書と担当が必要`);
    if (!referencedExternal.has(e.id)) structureProblems.push(`external ${e.id}: どのAT/CT/TCからも参照されていない`);
  }
  for (const i of manifest.issues ?? []) {
    if (!i.basis) structureProblems.push(`issue ${i.id}: 重大度の根拠が必要`);
  }

  return {
    counts: {
      requirements: ids.requirements.length,
      acceptance: ids.acceptance.length,
      ctPairs: ids.acceptance.reduce((n, a) => n + a.cts.length, 0),
      ctNotApplicable: notApplicable.length,
      commonTests: ids.commonTests.length,
      legacy: ids.legacy.length,
      apis: ids.apis.length,
      screens: ids.screens.length,
      journeys: (manifest.journeys ?? []).length,
      external: (manifest.external ?? []).length,
    },
    missingRequirementIds,
    missingApiIds,
    missingScreenIds,
    invalidRefs: [...invalidRefs],
    structureProblems,
    notApplicable,
    allRefs: [...refOwners.keys()],
    refOwners,
  };
}

// ---------------------------------------------------------------- 証跡index

export type TestResult = "passed" | "failed" | "skipped" | "timedOut" | "interrupted" | "notRun";

export interface EvidenceEntry {
  testId: string;
  kind: TestKind;
  file: string;
  title: string;
  project: string;
  reqIds: string[];
  result: TestResult;
  durationMs: number;
  startedAt: string;
  browser: string;
  network: string;
  fixture: string;
  model: string;
  question: string;
  evidence: string;
}

export interface SuiteRun {
  suite: "vitest" | "load" | "e2e" | "live";
  command: string;
  status: "passed" | "failed" | "notRun";
  reason?: string;
  startedAt: string;
  finishedAt: string;
  totals: { passed: number; failed: number; skipped: number; other: number };
  report: string;
}

export interface EvidenceIndex {
  schema: 1;
  generatedAt: string;
  commit: string;
  /** collect時点の作業木の内容ハッシュ（codePaths）。HEAD差分＋未コミット差分の両方を検出する */
  codeHash: string;
  dirtyCodeFiles: string[];
  designVersion: string;
  environment: { node: string; platform: string; playwright: string; vitest: string; wrangler: string };
  suites: SuiteRun[];
  /** 採用されなかった（全体を再実行した）過去の実行。フレーキーの記録として残す */
  discardedRuns: SuiteRun[];
  entries: EvidenceEntry[];
}

/** 「試験結果を変え得るコード」の範囲（R2: src/ tests/ drizzle/ scripts/ 設定ファイル。workflow〔deploy-config.test.tsが読む〕・docs/03〔client-shellの画面台帳試験が読む〕・openapiも含む） */
export const CODE_PATHS = ["src", "tests", "drizzle", "scripts", "public", "config", ".github", "openapi", "docs/03_画面設計・遷移.md", "package.json", "package-lock.json", "playwright.config.ts", "vitest.config.ts", "vitest.load.config.ts", "vitest.live.config.ts", "vite.config.ts", "vite.pwa.config.ts", "wrangler.jsonc", "tsconfig.json", ".nvmrc"];
/**
 * ハッシュから除く受入ゲート自身（manifestと照合の部品）。これらは参照先テストの結果を変えない。
 * 変えたときは照合（gate）側が最新のmanifestで再評価するので、証跡の再収集は要らない。
 */
export const GATE_ONLY_PATHS = ["tests/acceptance/", "scripts/check-coverage.ts", "scripts/collect-evidence.ts", "scripts/acceptance-lib.ts"];

export function git(args: string[]): string {
  return execFileSync("git", args, { cwd: ROOT, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 }).trim();
}

/**
 * `git status --porcelain -z` の出力からパスを取り出す（"XY path\0"。名前変更は "R  new\0old\0"）。
 * 行頭の状態欄（先頭が空白のことがある）を壊さないよう、出力をtrimしない（T085レビュー: trimで先頭1文字が欠けていた）
 */
export function parsePorcelainZ(out: string): string[] {
  const parts = out.split("\0");
  const paths: string[] = [];
  for (let i = 0; i < parts.length; i++) {
    const entry = parts[i]!;
    if (entry.length < 4) continue;
    paths.push(entry.slice(3));
    if (entry[0] === "R" || entry[0] === "C") i++; // 名前変更・複写は元のパスが続く
  }
  return paths;
}

export function dirtyCodeFilesNow(): string[] {
  const out = execFileSync("git", ["status", "--porcelain", "-z", "--", ...CODE_PATHS], { cwd: ROOT, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  return parsePorcelainZ(out);
}

export function codeFiles(): string[] {
  // -z: 非ASCIIのパス（docs/03_…）を引用符・8進エスケープなしで受け取る（既定の出力だと存在しないパスに化けて黙って落ちる）
  const out = execFileSync("git", ["ls-files", "-z", "-co", "--exclude-standard", "--", ...CODE_PATHS], { cwd: ROOT, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  return out
    .split("\0")
    .filter((f) => f && !GATE_ONLY_PATHS.some((g) => f === g || f.startsWith(g)))
    .filter((f) => existsSync(join(ROOT, f)))
    .sort();
}

export function computeCodeHash(): string {
  const h = createHash("sha256");
  for (const f of codeFiles()) {
    h.update(f);
    h.update("\0");
    h.update(readFileSync(join(ROOT, f)));
    h.update("\0");
  }
  return h.digest("hex");
}

export function loadIndex(path = INDEX_PATH): EvidenceIndex | null {
  const p = join(ROOT, path);
  return existsSync(p) ? (JSON.parse(readFileSync(p, "utf8")) as EvidenceIndex) : null;
}

export const entryKey = (kind: string, file: string, title: string) => `${kind}|${file}|${title}`;

/** 1つの参照の判定。合格以外は理由文字列を返す（skipを証拠にしない・未実行を合格にしない） */
export function refStatus(raw: string, byKey: Map<string, EvidenceEntry[]>): string | null {
  const ref = parseRef(raw);
  const entries = byKey.get(entryKey(ref.kind, ref.file, ref.title)) ?? [];
  if (entries.length === 0) return `${raw}: 証跡に実行記録が無い（未実行）`;
  if (ref.projects.length > 0) {
    const bad = ref.projects.filter((p) => !entries.some((e) => e.project === p && e.result === "passed"));
    return bad.length ? `${raw}: ${bad.join(",")} で合格していない（${entries.map((e) => `${e.project}=${e.result}`).join(" ")}）` : null;
  }
  // project指定の無いe2eは phone-360 と desktop-1280 の両方で合格の記録が必須（片方だけの記録では足りない。裁定R14）。
  // tablet-768 は記録があれば合格必須（下のnotPassed）
  if (ref.kind === "e2e") {
    const missing = ["phone-360", "desktop-1280"].filter((p) => !entries.some((e) => e.project === p && e.result === "passed"));
    if (missing.length) return `${raw}: ${missing.join(",")} の合格記録が無い（${entries.map((e) => `${e.project}=${e.result}`).join(" ")}）`;
  }
  const notPassed = entries.filter((e) => e.result !== "passed");
  if (notPassed.length) return `${raw}: ${notPassed.map((e) => `${e.project || e.kind}=${e.result}`).join(" ")}`;
  return null;
}

export interface GateResult {
  missingRequirementIds: string[];
  missingApiIds: string[];
  missingScreenIds: string[];
  skippedOrUnexecutedCases: string[];
  criticalOrHighUnresolvedIssues: string[];
  /** ケース（AT/TC/journey）ごとの不合格理由 */
  perCase: Map<string, string[]>;
  coverage: CoverageResult;
  indexState: string;
}

export function evaluateGate(manifest: AcceptanceManifest, index: EvidenceIndex | null, currentHash: string = computeCodeHash()): GateResult {
  const coverage = checkCoverage(manifest);
  const skippedOrUnexecutedCases: string[] = [...coverage.invalidRefs, ...coverage.structureProblems.map((s) => `構成: ${s}`)];
  const perCase = new Map<string, string[]>();
  let indexState = "ok";
  const byKey = new Map<string, EvidenceEntry[]>();
  if (!index) {
    indexState = `証跡indexが無い（${INDEX_PATH}。npm run collect:evidence で作る）`;
  } else if (index.codeHash !== currentHash) {
    indexState = `証跡indexが古い（collect時のcodeHash ${index.codeHash.slice(0, 12)} ≠ 現在 ${currentHash.slice(0, 12)}。コードが変わったので全件未実行扱い）`;
  } else {
    // 数える実行は各スイートの最新1回で、合格（status=passed・failed=0）であること。失敗した実行は
    // discardedRunsに証跡として残すが、合格の根拠に数えない（T085レビューB-I1）
    const badSuites = (["vitest", "load", "e2e"] as const).filter((s) => {
      const run = index.suites.filter((r) => r.suite === s).at(-1);
      return !run || run.status !== "passed" || run.totals.failed > 0;
    });
    if (badSuites.length) indexState = `証跡indexのスイートが合格していない（未実行または失敗）: ${badSuites.join(",")}`;
    for (const e of index.entries) {
      const k = entryKey(e.kind, e.file, e.title);
      if (!byKey.has(k)) byKey.set(k, []);
      byKey.get(k)!.push(e);
    }
  }
  if (indexState !== "ok") skippedOrUnexecutedCases.push(indexState);

  const check = (caseId: string, refs: string[]) => {
    const problems: string[] = [];
    if (indexState !== "ok") problems.push(indexState);
    else for (const r of refs) {
      const s = refStatus(r, byKey);
      if (s) problems.push(s);
    }
    perCase.set(caseId, problems);
    return problems;
  };
  for (const at of manifest.acceptance ?? []) {
    const refs = [...(at.tests ?? []), ...Object.values(at.ct ?? {}).flatMap((c) => c.tests ?? [])];
    for (const p of check(at.id, refs)) if (indexState === "ok") skippedOrUnexecutedCases.push(`${at.id}: ${p}`);
  }
  for (const tc of manifest.legacy ?? []) for (const p of check(tc.id, tc.tests ?? [])) if (indexState === "ok") skippedOrUnexecutedCases.push(`${tc.id}: ${p}`);
  for (const j of manifest.journeys ?? []) for (const p of check(j.id, [j.test])) if (indexState === "ok") skippedOrUnexecutedCases.push(`${j.id}: ${p}`);
  if (indexState === "ok") {
    const seen = new Set<string>();
    for (const [id, refs] of [...Object.entries(manifest.apis ?? {}), ...Object.entries(manifest.screens ?? {})]) {
      for (const r of refs) {
        if (seen.has(r)) continue;
        seen.add(r);
        const s = refStatus(r, byKey);
        if (s) skippedOrUnexecutedCases.push(`${id}: ${s}`);
      }
    }
  }
  const criticalOrHighUnresolvedIssues = (manifest.issues ?? [])
    .filter((i) => (i.severity === "critical" || i.severity === "high") && i.status !== "resolved")
    .map((i) => `${i.id} [${i.severity}] ${i.summary}（${i.source}）`);
  return {
    missingRequirementIds: coverage.missingRequirementIds,
    missingApiIds: coverage.missingApiIds,
    missingScreenIds: coverage.missingScreenIds,
    skippedOrUnexecutedCases: [...new Set(skippedOrUnexecutedCases)],
    criticalOrHighUnresolvedIssues,
    perCase,
    coverage,
    indexState,
  };
}
