import { sha256Hex } from "../mutations/hash";

/**
 * 構造化ログに載せるerrorの形（T081、docs/07 §1「ログにtoken/パスワード/正確な非公開位置/AI全文を
 * 無条件保存しない」、docs/10 §3「SECURITY: 業務DTO/監査本文/AIに一切出さない」）。
 *
 * 予期しない例外のメッセージは、ライブラリの内部で要求本文・SQLのbind値・認証情報を含むことがある
 * （debug実測: BetterAuthErrorがschemaの表名を、D1が制約違反の値を本文に載せる）。
 * そのため内部例外は**本文をログに出さず**、nameと本文のdigest（同一障害の突き合わせ用の短いhash）だけを
 * 載せる。requestIdで要求と突き合わせ、詳細が必要なときは同じ入力を再現して確認する。
 */
export interface RedactedError {
  name: string;
  /** 例外本文のSHA-256の先頭16桁。本文そのものではない（可逆でない。同一障害の照合にだけ使う） */
  digest: string;
}

export const redactError = async (err: unknown): Promise<RedactedError> => {
  const name = err instanceof Error ? err.name : "UnknownError";
  const message = err instanceof Error ? err.message : String(err);
  return { name, digest: (await sha256Hex(message)).slice(0, 16) };
};
