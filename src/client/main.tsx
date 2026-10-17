import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./styles.css";
import { App } from "./App";
import { expireDueDrafts } from "./offline/lifecycle";
import { registerPwa } from "./pwa/register";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

// 端末下書きの期限切れ掃除（T075）。起動時に一度走らせる（期限切れの下書きは送信されず消える。
// docs/14 D14推奨案の検証設定7日）。失敗しても起動・同期を妨げない
void expireDueDrafts().catch(() => undefined);

// PWAの登録（T074）。起動を遅らせないように描画の後で置く。devでは何もしない
void registerPwa();
