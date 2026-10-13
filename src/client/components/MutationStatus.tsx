import { useCallback, useState } from "react";
import type { MutationState } from "../useMutation";
import { Banner, Notice, Toast } from "./ui";

/**
 * 保存操作の結果表示。「保存しました」を出すのは saved のときだけで、prototypeどおり明るいトースト（2.6秒）。
 * 受付(202)・競合(409)・通信断/応答不明を、保存済みと混同しない（docs/03 §1、docs/05 §1）。
 * エラーは Design System の状態ブロック、途中経過は1行の案内で示す。
 */
export function MutationStatus({ state, toastBottom }: { state: MutationState; toastBottom?: number }) {
  // 同じ保存結果(stateオブジェクト)のトーストは一度だけ出す。2.6秒後に閉じたら、stateがsavedのままでも出し直さない
  const [dismissed, setDismissed] = useState<MutationState | null>(null);
  const dismiss = useCallback(() => setDismissed(state), [state]);

  switch (state.kind) {
    case "idle":
      return null;
    case "saving":
      return (
        <Notice tone="info" icon="hourglass_top" role="status">
          保存しています…
        </Notice>
      );
    case "processing":
      return (
        <Notice tone="warning" icon="hourglass_top" role="status">
          <span className="font-bold">処理中です</span>　受け付けました。処理が終わるまで完了ではありません。結果は画面で確認できます。
        </Notice>
      );
    case "saved":
      return dismissed === state ? null : (
        <Toast onDone={dismiss} bottom={toastBottom}>
          保存しました
        </Toast>
      );
    case "conflict":
      return (
        <Banner tone="warning" eyebrow="CONFLICT" role="alert" title="他の操作で更新されています">
          最新の内容を再確認してから、もう一度操作してください。この操作は保存されていません。
        </Banner>
      );
    case "unauthenticated":
      return (
        <Banner tone="error" eyebrow="SESSION" role="alert" title="ログインが必要です">
          ログインし直してから、もう一度送ってください。同じ人が同じ内容で送れば二重には登録されません。
        </Banner>
      );
    case "forbidden":
      return (
        <Banner tone="error" eyebrow="FORBIDDEN" role="alert" title="この操作は許可されていません">
          対象が変更・削除されたか、権限がありません。
        </Banner>
      );
    case "invalid":
      return (
        <Banner tone="error" eyebrow="ERROR" role="alert" title="入力内容を確認してください">
          赤く表示された項目を直してから、もう一度保存してください。
        </Banner>
      );
    case "rejected":
      return (
        <Banner tone="warning" eyebrow="STATE" role="alert" title="この状態では実行できません">
          対象の状態が変わっているか、必要な準備（承認・添付の検査など）が済んでいません。最新の内容を確認してください。
        </Banner>
      );
    case "limited":
      return (
        <Banner tone="warning" eyebrow="WAIT" role="alert" title="操作が多すぎます">
          しばらく待ってからもう一度お試しください。
        </Banner>
      );
    case "unknown":
      return (
        <Banner tone="warning" eyebrow="UNKNOWN" role="alert" title="結果を確認できませんでした">
          保存されたか分かりません。同じ内容でもう一度送っても、二重には登録されません（別のアカウントで送った場合を除く）。
        </Banner>
      );
  }
}
