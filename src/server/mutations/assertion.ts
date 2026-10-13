// 「条件が成り立たなければ一括処理全体を失敗させる」ための部品（docs/02 §4）。
// D1のbatchは文が失敗すれば全体がrollbackされるが、0行UPDATEは成功扱いになる。
// そこで検査結果を mutation_assertions(ok CHECK(ok=1)) へ書き、条件が偽(0)なら制約違反で全体を取り消す。

export const IDENT = /^[a-z_][a-z0-9_]*$/;

export function assertIdent(name: string, what: string): string {
  if (!IDENT.test(name)) throw new Error(`${what} が不正な識別子です: ${name}`);
  return name;
}

/**
 * assertion INSERT のSQLを作る。existsSql は「SELECT 1 FROM ... WHERE ...」形式の本体。
 * 必ず1行を評価し（ok=1または0）、CHECKにサブクエリを置かず、OR IGNORE/REPLACEを使わない。
 */
export function assertionSql(existsSql: string): string {
  return `INSERT INTO mutation_assertions (attempt_token, seq, ok) SELECT ?, ?, CASE WHEN EXISTS (${existsSql}) THEN 1 ELSE 0 END`;
}

/** 実行主体が「今も有効」かの検査本体。有効な利用者・団員・分団で、認可版が一致すること。 */
export const PRINCIPAL_EXISTS_SQL =
  "SELECT 1 FROM users u JOIN members m ON m.user_id = u.id JOIN units n ON n.id = m.unit_id " +
  "WHERE u.id = ? AND u.status = 'active' AND u.authz_version = ? AND m.id = ? AND m.unit_id = ? " +
  "AND m.status = 'active' AND n.status = 'active'";

/** 比較更新の結果検査本体。更新後は version=期待+1 かつ今回の試行の印が付いているはず。 */
export function rootUpdatedExistsSql(table: string): string {
  assertIdent(table, "table");
  return `SELECT 1 FROM ${table} WHERE id = ? AND unit_id = ? AND version = ? AND last_mutation_token = ?`;
}
