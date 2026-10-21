// 導入提案資料・確認チェックリスト・運用方針テンプレートの静的検査（T087。docs/09「完成後に消防団へ提案する順序」・
// docs/13 RG-08/10・docs/14 §2 D01〜D20・docs/16 T087）。
// - 検査の趣旨: 開発は完了しているが正式リリースではない。提案資料が「実測・証跡つきの完成品」と「まだ承認されて
//   いない運用の値（docs/14 D01〜D20の推奨案・検証設定）」を混ぜないこと、D01〜D20が一項目一回答で確認できることを
//   機械的に守る。連絡・送信・了承の捏造を防ぐ（ブリーフの規定どおり）。
// - 純関数（checkAdoptionProposal）は試験（tests/adoption-proposal.test.ts）から直接呼ぶ。CLI
//   （`npm run check:adoption-proposal`）は実ファイル（docs/ADOPTION_PROPOSAL.md・docs/ADOPTION_CHECKLIST.md・
//   config/production-policy.example.json）を読んで同じ純関数に渡す（scripts/check-environment.tsと同じ構成）。
// - 出典の規則: 提案資料の実測値らしき数値（ms/秒/分/時間/$等を伴う行）には「出典」と実在するリポジトリ内ファイル
//   （docs/ ops/ config/ 配下・拡張子付き）の併記が要る。実在しないパスは検出する（実環境の実測値は存在しない
//   ため「未実施」と書くしかない＝捏造の防止）。
export const DECISION_IDS = [
  "D01", "D02", "D03", "D04", "D05", "D06", "D07", "D08", "D09", "D10",
  "D11", "D12", "D13", "D14", "D15", "D16", "D17", "D18", "D19", "D20",
] as const;
export type DecisionId = (typeof DECISION_IDS)[number];

// T088で回答を記録するテンプレート（config/production-policy.example.json）の1項目。
// 項目の正本は docs/14 §2 の該当D。回答は空欄・approvedはfalseで配布する。
export type PolicyExampleEntry = {
  質問: string;
  現在の検証設定: string;
  代替案: string;
  意思決定者: string;
  回答: string;
  approved: boolean;
};
export type PolicyExampleMeta = { 版: string; 日付: string; 注記: string };
export type PolicyExampleDocument = { meta: PolicyExampleMeta } & Record<DecisionId, PolicyExampleEntry>;

// 提案資料が必ず示す要素（docs/16 T087のInterfaces）
export const REQUIRED_PROPOSAL_ELEMENTS = [
  "完成版URL", "全機能動線", "費用実測", "データ項目", "役割", "点検票",
  "保存", "AI送信", "通知", "代替連絡", "正副担当",
] as const;

// 実在しないものは未実施と書く（実環境デモURL・実測費用など。docs/13の規定と同じ姿勢）
export const REQUIRED_NOT_IMPLEMENTED = [
  "実環境のデモURLは未実施",
  "実測費用は未実施",
  "実環境での測定は未実施",
] as const;

// docs/14 D01〜D20の推奨案・検証設定に由来する未承認の値。出現する行では未承認である旨の語の併記が要る。
const UNAPPROVED_VALUE_TOKENS = ["$5", "RTO", "RPO", "保持7日", "500回/日", "2,000通/日"] as const;
const UNAPPROVED_LABELS = ["未承認", "検証設定", "承認待ち", "開発設定", "未決"] as const;

// 「決定済み」と読める語。D01〜D20を扱う行に添えてはならない（了承を得たことにしない）。
const DECIDED_MARKERS = [
  "承認済み", "了承済み", "決定済み", "確定済み", "了承を得た", "承認を得た", "了承した", "承認した", "決定した",
] as const;

// 実測値らしき数値（この単位を伴う提案資料の行には出典と実在ファイルが要る）
const MEASURED_VALUE_PATTERN = /\$\s*\d|\d[\d,.]*\s*(?:ms|秒|分|時間|円|ドル|USD)/i;
// リポジトリ内ファイルの参照（docs/ ops/ config/ 配下・拡張子まで。非 greedy なので路径語の直前で切れる）
const REPO_PATH_PATTERN = /(?:docs|ops|config)\/[^\s`」』〕(（)）、。;；]*?\.(?:md|json|ts|tsx|yml|yaml|sql|html|png)/g;

type ChecklistRow = { id: string; cells: string[]; line: string };
type ParsedChecklist = { headerColumns: string[]; rows: ChecklistRow[] };

function splitCells(line: string): string[] {
  return line.split("|").slice(1, -1).map((c) => c.trim());
}

// チェックリストの最初の表（| 区切りの連続する行）を読む。見出し行→区切り行→D行の構成を仮定する。
function parseChecklistTable(checklist: string): ParsedChecklist {
  const lines = checklist.split("\n").map((l) => l.trim());
  const first = lines.findIndex((l) => l.startsWith("|"));
  if (first < 0) return { headerColumns: [], rows: [] };
  const tableLines: string[] = [];
  for (let i = first; i < lines.length && lines[i]!.startsWith("|"); i++) tableLines.push(lines[i]!);
  const headerColumns = splitCells(tableLines[0]!);
  const rows = tableLines
    .slice(1)
    .filter((l) => !/^\|[\s:|-]+\|$/.test(l))
    .map((line) => ({ id: splitCells(line)[0] ?? "", cells: splitCells(line), line }))
    .filter((r) => /^D\d{2}$/.test(r.id));
  return { headerColumns, rows };
}

/** 例示JSONの構造: キーは meta＋D01〜D20 だけ。各Dは6欄。metaは版・日付・未承認の明記を持つ。 */
export function policyStructureIssues(policy: unknown): string[] {
  if (typeof policy !== "object" || policy === null) {
    return ["運用方針テンプレート（config/production-policy.example.json）がJSONオブジェクトとして読めません"];
  }
  const record = policy as Record<string, unknown>;
  const keys = Object.keys(record);
  const failures: string[] = [];
  for (const id of DECISION_IDS) {
    if (!keys.includes(id)) failures.push(`運用方針テンプレートに ${id} の項目がありません（metaとD01〜D20の全キーが必要）`);
  }
  for (const key of keys) {
    if (key !== "meta" && !(DECISION_IDS as readonly string[]).includes(key)) {
      failures.push(`運用方針テンプレートに未知のキーがあります: ${key}（metaとD01〜D20だけにする）`);
    }
  }
  const meta = record.meta;
  if (typeof meta !== "object" || meta === null) {
    failures.push("運用方針テンプレートに meta（版・日付・未承認の明記）がありません");
  } else {
    const metaRecord = meta as Record<string, unknown>;
    for (const field of ["版", "日付"] as const) {
      if (typeof metaRecord[field] !== "string" || (metaRecord[field] as string).trim() === "") {
        failures.push(`運用方針テンプレートのmetaに${field}がありません`);
      }
    }
    if (!JSON.stringify(meta).includes("未承認")) {
      failures.push("運用方針テンプレートのmetaに未承認である旨の明記がありません");
    }
  }
  for (const id of DECISION_IDS) {
    const entry = record[id];
    if (typeof entry !== "object" || entry === null) {
      if (keys.includes(id)) failures.push(`${id} の項目がオブジェクトではありません`);
      continue;
    }
    const entryRecord = entry as Record<string, unknown>;
    for (const field of ["質問", "現在の検証設定", "代替案", "意思決定者"] as const) {
      if (typeof entryRecord[field] !== "string" || (entryRecord[field] as string).trim() === "") {
        failures.push(`${id} の${field}が空です`);
      }
    }
    for (const field of ["回答", "approved"] as const) {
      if (!Object.keys(entryRecord).includes(field)) failures.push(`${id} に${field}欄がありません`);
    }
  }
  return failures;
}

/** 例示JSONの承認状態: approved は全て false・回答は空欄（回答の記録はT088）。 */
export function policyApprovalIssues(policy: unknown): string[] {
  if (typeof policy !== "object" || policy === null) return [];
  const record = policy as Record<string, unknown>;
  const failures: string[] = [];
  for (const id of DECISION_IDS) {
    const entry = record[id];
    if (typeof entry !== "object" || entry === null) continue;
    const entryRecord = entry as Record<string, unknown>;
    if (entryRecord.approved === true) {
      failures.push(`${id} の approved が true です（テンプレートは全項目 approved:false＝未承認のまま配布する）`);
    }
    if (typeof entryRecord.回答 === "string" && entryRecord.回答.trim() !== "") {
      failures.push(`${id} の回答欄にすでに記入があります（回答はT088で記録するため空欄）: ${String(entryRecord.回答).slice(0, 40)}`);
    }
  }
  return failures;
}

/** 文書の本文: D01〜D20に「決定済み」と読める語を添えない・未承認の値を無Labelで出さない。 */
export function textApprovalIssues(proposal: string, checklist: string): string[] {
  const failures: string[] = [];
  for (const [docName, text] of [["提案資料", proposal], ["確認チェックリスト", checklist]] as const) {
    for (const rawLine of text.split("\n")) {
      const line = rawLine.trim();
      if (line === "") continue;
      const decisionId = DECISION_IDS.find((id) => line.includes(id));
      if (decisionId) {
        const marker = DECIDED_MARKERS.find((m) => line.includes(m));
        if (marker) {
          failures.push(`${docName}: ${decisionId} に「${marker}」を添えています（D01〜D20は未承認。「未承認」「承認待ち」と書く）: ${line.slice(0, 120)}`);
        }
      }
      const token = UNAPPROVED_VALUE_TOKENS.find((t) => line.includes(t));
      if (token && !UNAPPROVED_LABELS.some((l) => line.includes(l))) {
        failures.push(`${docName}: 未承認の値「${token}」を、未承認である旨の語なしで書いています: ${line.slice(0, 120)}`);
      }
    }
  }
  return failures;
}

/** チェックリストの表: D01〜D20が一項目一回答（各1行・回答欄1列・列数の一致）。 */
export function checklistStructureIssues(checklist: string): string[] {
  const { headerColumns, rows } = parseChecklistTable(checklist);
  if (headerColumns.length === 0) {
    return ["確認チェックリストに表がありません（D01〜D20を一項目一回答で並べる）"];
  }
  const failures: string[] = [];
  const answerColumns = headerColumns.filter((c) => c.includes("回答"));
  if (answerColumns.length !== 1) failures.push(`回答欄が1列ではありません（一項目一回答）: ${answerColumns.length}列`);
  if (!headerColumns.some((c) => c.includes("質問"))) failures.push("確認する質問の列がありません");
  if (!headerColumns.some((c) => c.includes("検証設定"))) failures.push("現在の検証設定（未承認）の列がありません");
  for (const id of DECISION_IDS) {
    const hits = rows.filter((r) => r.id === id);
    if (hits.length === 0) failures.push(`確認チェックリストに ${id} の行がありません（D01〜D20を一項目一回答で）`);
    if (hits.length > 1) failures.push(`${id} の行が${hits.length}行あります（一項目一回答）`);
    for (const row of hits) {
      if (row.cells.length !== headerColumns.length) {
        failures.push(`${id} の行の列数（${row.cells.length}）が見出し（${headerColumns.length}）と一致しません`);
      }
    }
  }
  return failures;
}

/** チェックリストの回答欄は空欄（回答の記録はT088）。 */
function checklistAnswerIssues(checklist: string): string[] {
  const { headerColumns, rows } = parseChecklistTable(checklist);
  const answerIndex = headerColumns.findIndex((c) => c.includes("回答"));
  if (headerColumns.length === 0 || answerIndex < 0) return [];
  const failures: string[] = [];
  for (const row of rows) {
    const cell = row.cells[answerIndex];
    if (cell !== undefined && cell !== "") {
      failures.push(`確認チェックリストの ${row.id} の回答欄にすでに記入があります（回答はT088で記録する）: ${cell.slice(0, 40)}`);
    }
  }
  return failures;
}

/** 提案資料の完成品根拠: 必須要素・出典の実在・実測値への出典・未実施の明記。 */
export function productEvidenceIssues(
  proposal: string,
  checklist: string,
  pathExists: (path: string) => boolean,
): string[] {
  const failures: string[] = [];
  for (const element of REQUIRED_PROPOSAL_ELEMENTS) {
    if (!proposal.includes(element)) failures.push(`提案資料に必須要素「${element}」がありません（docs/16 T087のInterfaces）`);
  }
  for (const statement of REQUIRED_NOT_IMPLEMENTED) {
    if (!proposal.includes(statement)) failures.push(`提案資料に「${statement}」の明記がありません（実在しないものは未実施と書く）`);
  }
  for (const [docName, text] of [["提案資料", proposal], ["確認チェックリスト", checklist]] as const) {
    for (const p of new Set(text.match(REPO_PATH_PATTERN) ?? [])) {
      if (!pathExists(p)) failures.push(`${docName}の出典パスがリポジトリに実在しません: ${p}`);
    }
  }
  for (const rawLine of proposal.split("\n")) {
    const line = rawLine.trim();
    if (!MEASURED_VALUE_PATTERN.test(line)) continue;
    if (!line.includes("出典") || (line.match(REPO_PATH_PATTERN) ?? []).length === 0) {
      failures.push(`提案資料の実測値らしき数値に出典（実在するファイル）がありません: ${line.slice(0, 120)}`);
    }
  }
  return failures;
}

export type AdoptionCheckInput = {
  proposal: string;
  checklist: string;
  policy: unknown;
  pathExists: (path: string) => boolean;
};

export type AdoptionCheckResult = {
  unapprovedValuesPresentedAsApproved: string[];
  missingDecisionIds: string[];
  productEvidenceMissing: string[];
  /** 3検出器の全失敗の集約（ok:falseの根拠。CLIが表示する） */
  failures: string[];
  ok: boolean;
};

export function checkAdoptionProposal(input: AdoptionCheckInput): AdoptionCheckResult {
  const unapprovedValuesPresentedAsApproved = [
    ...policyApprovalIssues(input.policy),
    ...textApprovalIssues(input.proposal, input.checklist),
    ...checklistAnswerIssues(input.checklist),
  ];
  const missingDecisionIds = [
    ...checklistStructureIssues(input.checklist),
    ...policyStructureIssues(input.policy),
  ];
  const productEvidenceMissing = productEvidenceIssues(input.proposal, input.checklist, input.pathExists);
  const failures = [...unapprovedValuesPresentedAsApproved, ...missingDecisionIds, ...productEvidenceMissing];
  return { unapprovedValuesPresentedAsApproved, missingDecisionIds, productEvidenceMissing, failures, ok: failures.length === 0 };
}

// ==== 以下、CLI（npm run check:adoption-proposal）。試験からは呼ばれない（workerdにnode:fsは無いため動的import）。 ====

type NodeFs = typeof import("node:fs");
async function lazyFs(): Promise<NodeFs> {
  const specifier = "node:" + "fs";
  return (await import(/* @vite-ignore */ specifier)) as NodeFs;
}

async function main(): Promise<number> {
  const fs = await lazyFs();
  const proposalPath = "docs/ADOPTION_PROPOSAL.md";
  const checklistPath = "docs/ADOPTION_CHECKLIST.md";
  const policyPath = "config/production-policy.example.json";
  const proposal = fs.readFileSync(proposalPath, "utf8");
  const checklist = fs.readFileSync(checklistPath, "utf8");
  const policyRaw = fs.readFileSync(policyPath, "utf8");
  // JSONとして壊れている場合は生テキストを渡す（構造検査が1件の失敗として報告する）
  const policy: unknown = (() => {
    try {
      return JSON.parse(policyRaw) as unknown;
    } catch {
      return policyRaw;
    }
  })();
  const result = checkAdoptionProposal({ proposal, checklist, policy, pathExists: (p) => fs.existsSync(p) });
  if (!result.ok) {
    console.error(`導入提案資料の検査に失敗（${result.failures.length}件）:\n- ${result.failures.join("\n- ")}`);
    return 1;
  }
  console.log(
    `導入提案資料検査OK: 必須要素${REQUIRED_PROPOSAL_ELEMENTS.length}項目・D01〜D20一項目一回答・未承認値の無Label化なし・出典は実在ファイルのみ（未実施${REQUIRED_NOT_IMPLEMENTED.length}項目の明記あり）`,
  );
  return 0;
}

const runningAsCli = typeof process !== "undefined" && process.argv[1]?.endsWith("check-adoption-proposal.ts");
if (runningAsCli) {
  void main().then((code) => process.exit(code));
}
