/**
 * docs/05 §4 の「成功data」欄に書かれた状態コードと、台帳(registry)の success を照合する（契約検査用）。
 *  - 欄に「202」があれば台帳は202を含む（「202可」は200/202の両方）／欄に無ければ台帳は202を含まない
 *  - 欄に「204」があれば台帳は204を含む／無ければ含まない
 * docsか台帳のどちらかを変えて片方を直し忘れると検出される。
 */
export function successStatusProblems(id: string, successText: string, success: readonly number[]): string[] {
  const problems: string[] = [];
  const docs202 = /202/.test(successText);
  const docs204 = /204/.test(successText);
  if (docs202 !== success.includes(202)) problems.push(`${id}: 202の有無が違います（docs=「${successText.trim()}」/ 台帳=${success.join(",")}）`);
  if (docs204 !== success.includes(204)) problems.push(`${id}: 204の有無が違います（docs=「${successText.trim()}」/ 台帳=${success.join(",")}）`);
  if (/202可/.test(successText) && !success.includes(200)) problems.push(`${id}: 「202可」なのに台帳に200がありません`);
  return problems;
}
