import { useEffect } from "react";
import { Banner } from "./ui";

export interface FieldIssue {
  field: string;
  reason: string;
}

/**
 * 誤りが出たら、画面上で最初の誤り欄へフォーカスを移す（キーボード・スクリーンリーダー利用者のため）。
 * 欄の特定は aria-invalid="true"（TextField/TextArea が付与）で行い、DOM上の順に先頭を選ぶ。
 */
export function useFocusFirstInvalid(issues: FieldIssue[]): void {
  useEffect(() => {
    if (issues.length === 0) return;
    const first = document.querySelector<HTMLElement>('[aria-invalid="true"]');
    first?.focus();
    first?.scrollIntoView?.({ block: "center" });
  }, [issues]);
}

/** 誤りの一覧。各項目は該当欄へのリンク。色だけでなく文字とアイコンで示す。 */
export function FormErrors({ issues, labels = {} }: { issues: FieldIssue[]; labels?: Record<string, string> }) {
  useFocusFirstInvalid(issues);
  if (issues.length === 0) return null;
  return (
    <Banner tone="error" icon="error" role="alert" title={`入力内容に${issues.length}件の誤りがあります`}>
      <ul className="list-inside list-disc">
        {issues.map((i) => (
          <li key={`${i.field}:${i.reason}`}>
            <a className="underline" href={`#field-${i.field}`}>
              {labels[i.field] ?? i.field}
            </a>
            ：{i.reason}
          </li>
        ))}
      </ul>
    </Banner>
  );
}

/** 欄ごとのエラー文を引く。最初に見つかった理由を返す。 */
export function errorFor(issues: FieldIssue[], field: string): string | undefined {
  return issues.find((i) => i.field === field)?.reason;
}
