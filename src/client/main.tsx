import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./styles.css";
import { App } from "./App";
import { registerPwa } from "./pwa/register";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

// PWAの登録（T074）。起動を遅らせないように描画の後で置く。devでは何もしない
void registerPwa();
