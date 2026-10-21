// 導入提案資料・確認チェックリスト・運用方針テンプレートの静的検査（T087。docs/09 §2・docs/13 §5・RG-08/10・
// docs/14 §2 D01〜D20・docs/16 T087）。
// - 検査の趣旨: 開発は完了しているが正式リリースではない。提案資料が「実測・証跡つきの完成品」と「まだ承認されて
//   いない運用の値（docs/14 D01〜D20の推奨案・検証設定）」を混ぜないこと、D01〜D20が一項目一回答で確認できることを
//   機械的に守る。連絡・送信・了承の捏造を防ぐ（ブリーフの規定どおり）。
// - 「承認済み」主張の検出規則（fix round 1）: 語幹{承認,了承,決定,確定,合意}＋活用の形を、D-IDの有無にかかわらず
//   両文書の全ての「文」で検出する（包括文「すべて了承済み」・変形「承認済」「確定している」を拾う）。
//   例外は明示的な否定「…済みとは扱わない／…済みとして扱わ…」（docs/14 §2の正直な言い回し）だけであり、
//   「未承認」「検証設定」などの語が同じ文にあっても主張を相殺しない。語幹のみ（「承認」「決定」等の単独形）は
//   主張としない——この2文書では機能説明の正当な語（「承認後」「承認版」「点検様式の版承認」「人の確定」）と
//   固定語「意思決定者」に語幹が現れるため（この除外は意図的な検出範囲として文書化してある）。
// - fix round 2: 活用に丁寧形・受動形・過去（丁寧）を追加（しています/されています/されました/しました/
//   された/しております/していました/されます等）。「承認します」「了承します」等の現在丁寧（します形）も主張と
//   みなす。例外は「運用方針（production-policy.json）として確定します」（T088で回答を記録して運用方針ファイルを
//   確定する仕組みの説明=未来の確定操作で、団体の承認を述べる文ではない）の1字句だけ（詳細は定数のコメント）。
// - review wave 1: ①自然文体（を得ている/が済んだ/に至りました等）と断定語彙（本決まり等）を活用へ追加
//   ②否定導入（「未承認ではなく…」等）の後に承認語が続く文を検出し、否定随伴語は値ラベルとして無効化
//   ③英語の承認語（approved/accepted/confirmed）を検出（例外: approved:false のフィールド参照のみ）
//   ④例示JSONの型を厳格化（approvedはbooleanのfalse厳密一致・回答は空文字列のみ）⑤チェックリスト側の
//   未知のD行検出（JSON側と対称）⑥チェックリストと例示JSONの「質問」の一致検査。
// - 記録済み限界（文書化のみ。検出対象外）: 使役形（「確定させます」等）・文末の語幹単独（「…で決定。」）・
//   語幹と活用の隣接崩し（表セル分割・改行・読点「承認|済み」等）・半角カナ（ｱﾌﾟﾛｰﾙ済み）・ひらがな表記（了承ずみ）・
//   同一文内のホワイトリスト語と主張の併存（文分割で大部分は分離されるが完全ではない）。
// - docs/14 §2 の未決D見出し（D01〜D20。D21以降の「確定した詳細設計」は対象外）と DECISION_IDS の一致も検査する
//   （将来のD追加・改名でチェックリスト側の更新を強制する）。
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
// （review wave 1: 表記揺れ「5ドル」「５ドル」「USD 5」も対象）
const UNAPPROVED_VALUE_TOKENS = ["$5", "5ドル", "５ドル", "USD 5", "RTO", "RPO", "保持7日", "500回/日", "2,000通/日"] as const;
const UNAPPROVED_LABELS = ["未承認", "検証設定", "承認待ち", "開発設定", "未決"] as const;

// 否定導入の語（「未承認ではなく$5に本決まり」型=一度未承認と言った直後に承認を述べる文の検出に使う）。
// この語に一致した部分は行内の値ラベル（未承認・検証設定等）として数えない（否定随伴語の無効化）。
const NEGATION_SETUP_SOURCE = "(未承認|検証設定|開発設定|承認待ち|未決)(ではなく|ではなくて|ではない|ではありません|じゃなく|じゃありません)";
const NEGATION_SETUP_PATTERN = new RegExp(NEGATION_SETUP_SOURCE); // .test 用（状態を持たない）
const NEGATION_SETUP_GLOBAL = new RegExp(NEGATION_SETUP_SOURCE, "g"); // .replace 用

// 「承認・了承が済んでいる」と読める主張の形（上のヘッダーコメントの規則どおり。語幹＋活用＋断定語彙）。
// 活用は常体・丁寧形・受動形・過去（丁寧）・自然文体（review wave 1: を得ている/が済んだ/に至りました等）を列挙する。
// 列挙による限界（使役形・文末語幹単独・隣接崩し等）はヘッダーコメントの記録済み限界を参照。
const APPROVAL_CLAIM_CONJUGATIONS = [
  "済", "済み",
  "した", "しました",
  "している", "しています", "してます",
  "していた", "していました", "してました",
  "しており", "しております",
  "される", "されます", "された", "されている", "されています", "されました",
  "を得た", "を得ました", "を得ている", "を得ています",
  "が得られた", "が得られました", "が得られています",
  "が済んだ", "が済みました", "が済んでいます",
  "いただいた", "いただきました", "いただいている", "いただいています",
  "をいただいている", "をいただいています",
  "頂いた", "頂きました", "頂いている",
  "に至った", "に至りました", "に至っています", "に至る",
  "します",
] as const;
// 語幹を伴わない断定語彙（「本決まり」「決まりました」等）。
const APPROVAL_CLAIM_EXTRA_WORDS = ["本決まり", "決まりました", "決まっている", "決まっています"] as const;
const APPROVAL_CLAIM_PATTERN = new RegExp(
  `(承認|了承|決定|確定|合意)(${[...APPROVAL_CLAIM_CONJUGATIONS].sort((a, b) => b.length - a.length).join("|")})` +
    `|${[...APPROVAL_CLAIM_EXTRA_WORDS].sort((a, b) => b.length - a.length).join("|")}`,
);
// 英語の承認語（review wave 1）。 approved:false のフィールド参照（config/budget-development.json 等）だけは例外。
const ENGLISH_APPROVAL_PATTERN = /\b(approved|accepted|confirmed)\b/i;
const ENGLISH_APPROVAL_WHITELIST = /approved\s*[:：]\s*false/i;
// 否定導入の直後に承認語が続く文は、語幹の単独形・断定語彙を含めて主張とみなす（NEGATION_SETUP_PATTERN参照）。
const NEGATION_CLAIM_WORD_PATTERN = /(承認|了承|決定|確定|合意|本決まり)/;
// 例外とする正当な用法（文単位。いずれも明示的・狭い）:
// 1. docs/14 §2 流の明示的な否定「…済みとは扱わない」「…済みとして扱っていません」等
//    （扱うの否定形: 扱わない／扱わず／扱いません／扱っていません／扱っていない を含む）。
// 2. 「運用方針（production-policy.json）として確定します」——T088で回答を記録して運用方針ファイルを
//    確定する「仕組みの説明」（未来の確定操作）であり、団体の承認を述べる文ではない。他の語幹
//    （承認・了承等）ではこの字句を使えないため、この字句に限定して例外とする。
// 3. 「承認済み資料」——docs/01 AI-06 の機能語（RAGの検索対象＝アプリ内で承認された文書。要件の原文どおり）。
//    提案・了承の主張ではなく、別の文に分かれていれば主張検出は側で拾う。
// いずれの例外でも「未承認」「検証設定」などの語の存在だけで主張を相殺しない（「未承認ではなく承認されている」を拾うため）。
const APPROVAL_CLAIM_WHITELIST: readonly RegExp[] = [
  /(承認|了承|決定|確定|合意)済(み)?(とは|として)扱(わ|いませ|っていませ|っていな)/,
  /production-policy\.json[）)]?として確定します/,
  /承認済み資料/,
];

// 実測値らしき数値（この単位を伴う提案資料の行には出典と実在ファイルが要る）
const MEASURED_VALUE_PATTERN = /\$\s*\d|\d[\d,.]*\s*(?:ms|秒|分|時間|円|ドル|USD)/i;
// リポジトリ内ファイルの参照（docs/ ops/ config/ 配下・拡張子まで。非 greedy なので路径語の直前で切れる）
const REPO_PATH_PATTERN = /(?:docs|ops|config)\/[^\s`」』〕(（)）、。;；]*?\.(?:md|json|ts|tsx|yml|yaml|sql|html|png)/g;

type ChecklistRow = { id: string; cells: string[]; line: string };
type ParsedChecklist = { headerColumns: string[]; rows: ChecklistRow[] };

function splitCells(line: string): string[] {
  return line.split("|").slice(1, -1).map((c) => c.trim());
}

// 文単位に分割する（改行と。！？）。表の行（。を含まない行）は1文として扱う。
function sentencesOf(text: string): string[] {
  return text
    .split(/\n/)
    .flatMap((line) => line.split(/。|！|？/))
    .map((s) => s.trim())
    .filter((s) => s !== "");
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

/** 例示JSONの承認状態: approved は boolean の false 厳密一致・回答は空文字列のみ（回答の記録はT088）。 */
export function policyApprovalIssues(policy: unknown): string[] {
  if (typeof policy !== "object" || policy === null) return [];
  const record = policy as Record<string, unknown>;
  const failures: string[] = [];
  for (const id of DECISION_IDS) {
    const entry = record[id];
    if (typeof entry !== "object" || entry === null) continue;
    const entryRecord = entry as Record<string, unknown>;
    // approved は boolean 型の false のみを許す（1 や "false" は真偽でなく、実行環境で真と評価され得る）
    if ("approved" in entryRecord && entryRecord.approved !== false) {
      failures.push(
        `${id} の approved が boolean の false ではありません: ${JSON.stringify(entryRecord.approved)}（テンプレートは全項目 approved:false＝未承認のまま配布する）`,
      );
    }
    // 回答は空文字列のみを許す（数値・配列・空白以外の文字列は記入済みと同じ扱い）
    if ("回答" in entryRecord && (typeof entryRecord.回答 !== "string" || (entryRecord.回答 as string).trim() !== "")) {
      failures.push(`${id} の回答欄が空文字列ではありません: ${JSON.stringify(entryRecord.回答)}（回答はT088で記録するため空欄）`);
    }
  }
  return failures;
}

/** 文書の本文: 「承認済み」主張（全ての文が対象。包括文・変形語・否定形・自然文体・英語も拾う）と未承認値の無Label検出。 */
export function textApprovalIssues(proposal: string, checklist: string): string[] {
  const failures: string[] = [];
  for (const [docName, text] of [["提案資料", proposal], ["確認チェックリスト", checklist]] as const) {
    // (1) 承認済み主張: D-IDの有無にかかわらず全ての文を走査する（D-IDを含まない包括文も、
    //     「未承認」などの語で否定したつもりの文も同じ扱い。例外は明示的な否定のホワイトリストだけ）
    for (const sentence of sentencesOf(text)) {
      const claim = APPROVAL_CLAIM_PATTERN.exec(sentence);
      if (claim && !APPROVAL_CLAIM_WHITELIST.some((w) => w.test(sentence))) {
        const decisionId = DECISION_IDS.find((id) => sentence.includes(id));
        failures.push(
          `${docName}: ${decisionId ? `${decisionId} について` : "D-IDを含まない包括文で"}「${claim[0]}」は承認済みと読める主張です（実測の了承はまだ無い。「未承認」「承認待ち」と書くか、「…済みとは扱わない」形の明示的な否定にする。「未承認」などの語が同じ文にあっても相殺しない）: ${sentence.slice(0, 120)}`,
        );
      }
      // (1b) 否定導入の直後の承認語（「未承認ではなく$5に本決まり」型）。否定が先行しても語幹の単独形を含めて主張とする
      if (NEGATION_SETUP_PATTERN.test(sentence) && NEGATION_CLAIM_WORD_PATTERN.test(sentence)) {
        const decisionId = DECISION_IDS.find((id) => sentence.includes(id));
        failures.push(
          `${docName}: ${decisionId ? `${decisionId} について` : "包括的な文で"}「未承認ではなく…」の否定の後に承認を述べています（否定した語と同じ文で承認を述べない）: ${sentence.slice(0, 120)}`,
        );
      }
      // (1c) 英語の承認語（approved/accepted/confirmed）。 approved:false のフィールド参照だけは例外
      if (ENGLISH_APPROVAL_PATTERN.test(sentence) && !ENGLISH_APPROVAL_WHITELIST.test(sentence)) {
        const decisionId = DECISION_IDS.find((id) => sentence.includes(id));
        failures.push(
          `${docName}: ${decisionId ? `${decisionId} について` : "D-IDを含まない包括文で"}英語の承認語（${ENGLISH_APPROVAL_PATTERN.exec(sentence)![0]}）を使っています（日本語と同じく「未承認」と書く。例外は approved:false のフィールド参照のみ）: ${sentence.slice(0, 120)}`,
        );
      }
    }
    // (2) 未承認の値トークンには未承認である旨の語の併記が要る（行単位）。
    //     否定随伴語（「未承認ではなく…」等の一部）はラベルとして数えない（否定の一部であって未承認の明記ではない）
    for (const rawLine of text.split("\n")) {
      const line = rawLine.trim();
      if (line === "") continue;
      const token = UNAPPROVED_VALUE_TOKENS.find((t) => line.includes(t));
      if (!token) continue;
      const lineWithoutNegationSetup = line.replace(NEGATION_SETUP_GLOBAL, "");
      if (!UNAPPROVED_LABELS.some((l) => lineWithoutNegationSetup.includes(l))) {
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
  // 台帳に無いD行（例示JSON側の未知キー検出と対称。将来のD追加時は DECISION_IDS・チェックリスト・例示JSONを一緒に更新する）
  for (const row of rows) {
    if (/^D\d{2}$/.test(row.id) && !(DECISION_IDS as readonly string[]).includes(row.id)) {
      failures.push(`確認チェックリストに ${row.id} の行がありますが DECISION_IDS（D01〜D20）に含まれていません。docs/14 §2・チェックリスト・例示JSON・DECISION_IDS を一緒に更新してください`);
    }
  }
  return failures;
}

/**
 * チェックリストの「確認する質問」列と例示JSONの「質問」の一致（review wave 1。D01の質問を両ファイルで
 * 同期させるための機械検査。両方に同じ質問を書く運用の破れを検出する）。
 */
export function checklistPolicyConsistencyIssues(checklist: string, policy: unknown): string[] {
  if (typeof policy !== "object" || policy === null) return [];
  const record = policy as Record<string, unknown>;
  const { rows } = parseChecklistTable(checklist);
  const failures: string[] = [];
  for (const id of DECISION_IDS) {
    const row = rows.find((r) => r.id === id);
    const entry = record[id];
    if (!row || typeof entry !== "object" || entry === null) continue;
    const question = (entry as Record<string, unknown>).質問;
    if (typeof question !== "string") continue;
    const cell = row.cells[1] ?? "";
    if (cell !== question) {
      failures.push(`${id} の質問が確認チェックリストと例示JSONで一致しません（両ファイルを同じ文にする）: チェックリスト「${cell.slice(0, 60)}」/ JSON「${question.slice(0, 60)}」`);
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

/**
 * docs/14 §2 の未決D見出しと DECISION_IDS の一致（F2）。
 * §2「設計提案と完成後の確認事項」の `### Dnn` 見出しのうち、最初の「確定した詳細設計」（D21〜）より前を
 * 未決項目とみなし、DECISION_IDS と集合として一致させる。将来 docs/14 へ未決Dを追加したときは
 * チェックリスト・例示JSON・DECISION_IDS の更新を強制する（Dnn の改名・削除も同様）。
 */
export function ledgerDecisionIssues(decisionLedger: string): string[] {
  const sectionStart = decisionLedger.indexOf("## 2. 設計提案と完成後の確認事項");
  if (sectionStart < 0) {
    return ["docs/14 §2（設計提案と完成後の確認事項）の見出しが見つかりません（DECISION_IDSとの対応検査ができない）"];
  }
  const pending: string[] = [];
  for (const match of decisionLedger.slice(sectionStart).matchAll(/^### (D\d{2}) (.*)$/gm)) {
    if (match[2]!.includes("確定した詳細設計")) break; // D21以降（実装で確定した記録）は確認対象外
    pending.push(match[1]!);
  }
  const failures: string[] = [];
  for (const id of DECISION_IDS) {
    if (!pending.includes(id)) {
      failures.push(`docs/14 §2 に ${id} の未決項目の見出しが見つかりません（台帳とチェックリスト（DECISION_IDS）の対応を確認してください）`);
    }
  }
  for (const id of pending) {
    if (!(DECISION_IDS as readonly string[]).includes(id)) {
      failures.push(`docs/14 §2 に未決項目 ${id} がありますが DECISION_IDS（チェックリストの対象）に含まれていません。チェックリスト・例示JSON・DECISION_IDS へ追加してください`);
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
  /** docs/14_設計判断・未決事項.md の本文（§2の未決D見出しとDECISION_IDSの一致検査に使う。無い場合はその検査を省略） */
  decisionLedger?: string;
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
    ...checklistPolicyConsistencyIssues(input.checklist, input.policy),
    ...(input.decisionLedger !== undefined ? ledgerDecisionIssues(input.decisionLedger) : []),
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
  const ledgerPath = "docs/14_設計判断・未決事項.md";
  const proposal = fs.readFileSync(proposalPath, "utf8");
  const checklist = fs.readFileSync(checklistPath, "utf8");
  const decisionLedger = fs.readFileSync(ledgerPath, "utf8");
  const policyRaw = fs.readFileSync(policyPath, "utf8");
  // JSONとして壊れている場合は生テキストを渡す（構造検査が1件の失敗として報告する）
  const policy: unknown = (() => {
    try {
      return JSON.parse(policyRaw) as unknown;
    } catch {
      return policyRaw;
    }
  })();
  const result = checkAdoptionProposal({ proposal, checklist, policy, pathExists: (p) => fs.existsSync(p), decisionLedger });
  if (!result.ok) {
    console.error(`導入提案資料の検査に失敗（${result.failures.length}件）:\n- ${result.failures.join("\n- ")}`);
    return 1;
  }
  console.log(
    `導入提案資料検査OK: 必須要素${REQUIRED_PROPOSAL_ELEMENTS.length}項目・D01〜D20一項目一回答（docs/14 §2の未決D見出しと一致）・承認済み主張なし（未承認値の無Label化もなし）・出典は実在ファイルのみ（未実施${REQUIRED_NOT_IMPLEMENTED.length}項目の明記あり）`,
  );
  return 0;
}

const runningAsCli = typeof process !== "undefined" && process.argv[1]?.endsWith("check-adoption-proposal.ts");
if (runningAsCli) {
  void main().then((code) => process.exit(code));
}
