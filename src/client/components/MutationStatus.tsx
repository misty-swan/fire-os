import type { MutationState } from "../useMutation";
import { Banner } from "./ui";

/**
 * 保存操作の結果表示。「保存しました」を出すのは saved のときだけ。
 * 受付(202)・競合(409)・通信断/応答不明を、保存済みと混同しない（docs/03 §1、docs/05 §1）。
 */
export function MutationStatus({ state }: { state: MutationState }) {
  switch (state.kind) {
    case "idle":
      return null;
    case "saving":
      return <Banner tone="info" icon="hourglass_top" role="status" title="保存しています…" />;
    case "processing":
      return (
        <Banner tone="info" icon="hourglass_top" role="status" title="処理中です">
          受け付けました。処理が終わるまで完了ではありません。結果は画面で確認できます。
        </Banner>
      );
    case "saved":
      return <Banner tone="success" icon="check_circle" role="status" title="保存しました" />;
    case "conflict":
      return (
        <Banner tone="warning" icon="warning" role="alert" title="他の操作で更新されています">
          最新の内容を再確認してから、もう一度操作してください。この操作は保存されていません。
        </Banner>
      );
    case "unauthenticated":
      return (
        <Banner tone="error" icon="lock" role="alert" title="ログインが必要です">
          ログインし直してください。入力した内容は保存されていません。
        </Banner>
      );
    case "forbidden":
      return (
        <Banner tone="error" icon="block" role="alert" title="この操作は許可されていません">
          対象が変更・削除されたか、権限がありません。
        </Banner>
      );
    case "invalid":
      return (
        <Banner tone="error" icon="error" role="alert" title="入力内容を確認してください">
          赤く表示された項目を直してから、もう一度保存してください。
        </Banner>
      );
    case "limited":
      return (
        <Banner tone="warning" icon="schedule" role="alert" title="操作が多すぎます">
          しばらく待ってからもう一度お試しください。
        </Banner>
      );
    case "unknown":
      return (
        <Banner tone="warning" icon="cloud_off" role="alert" title="結果を確認できませんでした">
          保存されたか分かりません。同じ内容でもう一度送っても、二重には登録されません。
        </Banner>
      );
  }
}
