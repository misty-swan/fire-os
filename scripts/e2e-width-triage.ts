// T085b 候補②「幅の絞り込み」の設定読み取り部。
// tests/e2e/*.spec.ts の各試験宣言の直上に付けた「幅:」マーカー（コメント）を読み、
// Playwrightのプロジェクトごとの grepInvert（実行から除く試験名の正規表現）を作る。
//
// マーカーの意味（docs/evidence/e2e-speed.md の仕分け表と1対1）:
//   // 幅: 両方           … phone-360 と desktop-1280 の両方で実行（幅で変わる断言がある）
//   // 幅: desktop限定     … desktop-1280 だけで実行（画面の配置に依存しない流れ・データ断言）
//   // 幅: phone限定       … phone-360 だけで実行（押下領域44px・狭幅の回帰など、幅固有の試験）
//
// 安全装置（すべて例外でPlaywrightの設定読み込みを落とす＝静かに「全試験が両幅に戻る」／「除外が消える」ことを許さない）:
//   - 宣言にマーカーが無い（新規試験・マーカー消し忘れ）
//   - マーカーが連続する／ファイル末尾で余る（試験の削除・改名で孤立したマーカー）
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

export type WidthScope = "both" | "desktop" | "phone";

const E2E_DIR = join(import.meta.dirname, "..", "tests", "e2e");
const MARKER = /^\s*\/\/\s*幅:\s*(両方|desktop限定|phone限定)/;
const DECL = /^\s*test\((["'])(.*?)\1/;

const scopeOf = (marker: string): WidthScope | null => {
  if (marker.includes("両方")) return "both";
  if (marker.includes("desktop限定")) return "desktop";
  if (marker.includes("phone限定")) return "phone";
  return null;
};

/** tests/e2e/*.spec.ts の全試験の幅仕分け（キーは試験タイトル。本業務e2eはdescribeを使わないため一意） */
export function widthTriage(): Map<string, WidthScope> {
  const out = new Map<string, WidthScope>();
  for (const file of readdirSync(E2E_DIR).filter((f) => f.endsWith(".spec.ts")).sort()) {
    const lines = readFileSync(join(E2E_DIR, file), "utf8").split("\n");
    let pendingMarker: WidthScope | null = null;
    let sawMarker = false;
    let markerLine = 0;
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]!;
      const m = MARKER.exec(line);
      if (m) {
        // マーカーが連続＝直前のマーカーがどの試験宣言にも対応しない（試験の削除・改名で孤立した）。静かに両幅へ戻さない
        if (sawMarker) {
          throw new Error(`${file}:${i + 1}: 幅マーカーが連続しています（${markerLine}行目のマーカーが対応する試験宣言を持たない＝試験の削除・改名で孤立した可能性）。マーカーと試験宣言を1対1にしてください`);
        }
        pendingMarker = scopeOf(m[0])!;
        sawMarker = true;
        markerLine = i + 1;
        continue;
      }
      const d = DECL.exec(line);
      if (!d) continue;
      if (!sawMarker || pendingMarker === null) {
        throw new Error(`${file}:${i + 1}: 試験「${d[2]}」に幅マーカー（// 幅: 両方 | desktop限定 | phone限定）がありません。docs/evidence/e2e-speed.md の仕分け表に合わせて追加してください`);
      }
      out.set(d[2]!, pendingMarker);
      sawMarker = false; // マーカーは直近1試験にだけ効く
    }
    // ファイル末尾で未消費のマーカー＝宣言に届かなかった（末尾の試験が削除された等）
    if (sawMarker) {
      throw new Error(`${file}:${markerLine}: ファイル末尾までにこの幅マーカーに対応する試験宣言がありません（末尾の試験が削除・移動された可能性）`);
    }
  }
  if (out.size === 0) throw new Error("tests/e2e/*.spec.ts から試験宣言を1つも読めません（パスの誤り）");
  return out;
}

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * 指定した幅に含まれない試験を除外する grepInvert 用の正規表現。
 * 例: phone-360 プロジェクトには `grepInvert: titlesGrepInvert(["both", "phone"])`
 * （= desktop限定の試験を phone で実行しない）。
 * Playwrightのgrepは「プロジェクト名＋試験タイトル（＋タグ）」を空白結合した文字列へmatchさせるため、
 * 前後に空白or端を許す境界つきの並びにする（^title$ だと前方のプロジェクト名に当たって除外が効かない）。
 */
export function titlesGrepInvert(runScopes: WidthScope[]): RegExp {
  const triage = widthTriage();
  const excluded = [...triage.entries()].filter(([, scope]) => !runScopes.includes(scope)).map(([title]) => title);
  if (excluded.length === 0) return /$^/; // 除外なし（何も消さない）
  return new RegExp(`(?:^|\\s)(?:${excluded.map(esc).join("|")})(?:\\s|$)`);
}

/** 仕分けの内訳（起動時の自己確認・証跡用）。playwright.config.ts がconfigコメントとして残す */
export function triageSummary(): string {
  const triage = widthTriage();
  const n = (s: WidthScope) => [...triage.values()].filter((v) => v === s).length;
  return `両方${n("both")}・desktop限定${n("desktop")}・phone限定${n("phone")}（計${triage.size}試験）`;
}
