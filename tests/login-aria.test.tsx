import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LoginPage } from "../src/client/features/auth/LoginPage";

/**
 * ログインの誤りと入力欄の関連付け（PH1-C・T086。docs/evidence/ph1-review.md C「ログインのエラーと
 * aria関連付け」）。フォーム全体の誤り（認証失敗・未入力）はrole="alert"で読み上げに載るが、
 * 入力欄にもaria-invalid/aria-describedbyで関連付けられていないと、欄にフォーカスしたときに
 * 誤りの文が分からない（docs/03 §1「文字拡大、フォーカス移動、キーボード、スクリーンリーダー」）。
 * 未入力送信で出る誤りが両入力欄（メールアドレス・パスワード）に関連付くことを固定する。
 */

const renderLogin = () =>
  render(
    <MemoryRouter initialEntries={["/login"]}>
      <LoginPage />
    </MemoryRouter>,
  );

beforeEach(() => {
  window.location.hash = "";
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("ログインの誤りとaria関連付け (PH1-C)", () => {
  it("form_error_is_announced_and_associated_with_both_inputs", async () => {
    renderLogin();
    const email = document.getElementById("field-email") as HTMLInputElement;
    const password = document.getElementById("field-password") as HTMLInputElement;
    expect(email).toBeTruthy();
    expect(password).toBeTruthy();
    // 誤りが無い間は無効状態を主張しない
    expect(email.getAttribute("aria-invalid")).toBeNull();
    expect(password.getAttribute("aria-invalid")).toBeNull();

    // 未入力のまま送る（fetchは走らない。クライアント側の検証でフォーム全体の誤りが出る）
    fireEvent.click(screen.getByRole("button", { name: "ログイン" }));
    const error = await screen.findByText("メールアドレスとパスワードを入力してください");
    expect(error.tagName).toBe("P"); // 誤りの文のp（role="alert"）を拾っている
    expect(error.getAttribute("role")).toBe("alert"); // 読み上げに載る（既存挙動）
    const errorId = error.id;
    expect(errorId).not.toBe(""); // 誤りの文にidがある（関連付けの受け口）
    // 両入力欄が誤りに関連付く（赤: 旧実装はaria-invalid/aria-describedbyとも無い）
    await waitFor(() => {
      expect(email.getAttribute("aria-invalid")).toBe("true");
      expect(email.getAttribute("aria-describedby")).toBe(errorId);
      expect(password.getAttribute("aria-invalid")).toBe("true");
      expect(password.getAttribute("aria-describedby")).toBe(errorId);
    });
  });

  it("password_typing_clears_the_error_and_the_association", async () => {
    renderLogin();
    const password = document.getElementById("field-password") as HTMLInputElement;
    fireEvent.click(screen.getByRole("button", { name: "ログイン" }));
    await screen.findByText("メールアドレスとパスワードを入力してください");

    // パスワード欄の入力で誤りが消える（既存挙動）とき、無効状態も一緒に外れる
    fireEvent.change(password, { target: { value: "something-typed" } });
    await waitFor(() => {
      expect(screen.queryByText("メールアドレスとパスワードを入力してください")).toBeNull();
      expect(password.getAttribute("aria-invalid")).toBeNull();
      expect(password.getAttribute("aria-describedby")).toBeNull();
    });
  });
});
