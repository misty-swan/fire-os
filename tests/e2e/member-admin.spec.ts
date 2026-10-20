import { expect, test, type Page } from "@playwright/test";
import { BASE, PASSWORD, acceptInvitationViaUi, adminApi, apiHeaders, inviteNewMember, isPhone, loginViaUi, newUserContext, uniqueEmail } from "./helpers";

// 管理者のセッション（auth.setup.ts：招待→二要素認証）で管理画面を操作し、新しい団員は実際の招待受領で作る。

/** 管理画面で団員を選ぶ */
async function selectMember(page: Page, name: string) {
  await page.goto("/app/admin");
  await page.getByRole("list", { name: "管理する団員" }).getByRole("button", { name: new RegExp(name) }).click();
  await expect(page.getByRole("heading", { name: new RegExp(`${name}.*の管理`) })).toBeVisible();
}

// 幅: desktop限定（幅で変わる断言なし（流れ・データの断言））
test("stop_requires_reason_and_preserves_member_history", async ({ page, browser, request }, info) => {
  const viewport = info.project.use.viewport!;
  const name = `架空 停止確認 ${crypto.randomUUID().slice(0, 4)}`;
  const email = uniqueEmail("e2e-stop");

  // 1) 名簿に団員を追加（SCR-15）
  await page.goto("/app/members");
  await page.getByRole("button", { name: "団員を追加" }).click();
  const dialog = page.getByRole("dialog", { name: "団員を追加" });
  await dialog.getByLabel("氏名").fill(name);
  await dialog.getByLabel("役職").fill("団員");
  await dialog.getByLabel("班").fill("2班");
  await dialog.getByLabel("資格・講習（「、」区切り）").fill("普通救命、準中型");
  await dialog.getByLabel("電話番号").fill("090-1234-5678");
  await dialog.getByRole("button", { name: "団員を登録" }).click();
  await expect(page.getByRole("list", { name: "団員一覧" }).getByText(name)).toBeVisible();

  // 2) 招待 → 取消 → 再招待（SCR-17）。生tokenは発行した直後だけ表示される
  await selectMember(page, name);
  await page.getByLabel("招待先のメールアドレス").fill(email);
  await page.getByRole("button", { name: "招待を発行する" }).click();
  const link = page.getByLabel("招待リンク");
  await expect(link).toContainText("/login#invite=");
  const firstToken = (await link.textContent())!.split("#invite=")[1]!;
  await expect(page.getByText(/招待中/).first()).toBeVisible();
  await page.getByRole("button", { name: "招待を取り消す" }).click();
  const cancel = page.getByRole("dialog", { name: "招待を取り消す" });
  await expect(cancel.getByRole("button", { name: "戻る" })).toBeFocused(); // 既定は「戻る」
  await cancel.getByLabel("取り消す理由").fill("宛先の誤り");
  await cancel.getByRole("button", { name: "取り消す" }).click();
  await expect(page.getByText("未招待").first()).toBeVisible();
  await page.getByLabel("招待先のメールアドレス").fill(email);
  await page.getByRole("button", { name: "招待を発行する" }).click();
  const token = (await page.getByLabel("招待リンク").textContent())!.split("#invite=")[1]!;
  expect(token).not.toBe(firstToken);

  // 取り消した招待では受領できない／新しい招待で受領できる（本人側は別のブラウザ）
  const invitee = await newUserContext(browser, viewport);
  const ip = await invitee.newPage();
  await ip.goto(`/login#invite=${firstToken}`);
  await ip.getByLabel("メールアドレス").fill(email);
  await ip.getByLabel("新しいパスワード（12文字以上）").fill(PASSWORD);
  await ip.getByLabel("パスワード（確認）").fill(PASSWORD);
  await ip.getByRole("button", { name: "アカウントを作成して受け取る" }).click();
  await expect(ip.getByText(/この招待は使えません/)).toBeVisible();
  await acceptInvitationViaUi(ip, email, token, { mfa: false });
  await expect(ip).toHaveURL(/\/app$/);

  // 3) 役割を変更（差分の確認つき）
  await selectMember(page, name);
  await page.getByRole("checkbox", { name: "担当者" }).check();
  await page.getByLabel("変更の理由").fill("班の担当に就くため");
  await page.getByRole("button", { name: "変更内容を確認する" }).click();
  const confirmRoles = page.getByRole("dialog", { name: "役割と担当の変更を確認" });
  await expect(confirmRoles.getByText("役割を追加：担当者")).toBeVisible();
  await confirmRoles.getByRole("button", { name: "この内容で変更する" }).click();
  await expect(page.getByRole("list", { name: "管理する団員" }).getByRole("button", { name: new RegExp(`${name}.*担当者`) })).toBeVisible();

  // 4) 本人から見える：自分の連絡先は伏せて表示、他人の連絡先は読めない
  await ip.goto("/app/members");
  await ip.getByRole("list", { name: "団員一覧" }).getByRole("button", { name: new RegExp(name) }).click();
  const selfDrawer = ip.getByRole("dialog", { name: new RegExp(`${name}のプロフィール`) });
  await expect(selfDrawer.getByText("***-****-5678")).toBeVisible(); // 本人には自分の連絡先が（伏せて）見える
  await selfDrawer.getByRole("button", { name: "表示" }).click();
  await expect(selfDrawer.getByText("090-1234-5678")).toBeVisible();
  await ip.keyboard.press("Escape");
  // 登録した管理者でも、担当(scope)を付けない限り他人の連絡先は読めない
  await page.goto("/app/members");
  await page.getByRole("list", { name: "団員一覧" }).getByRole("button", { name: new RegExp(name) }).click();
  await expect(page.getByRole("dialog", { name: /のプロフィール/ }).getByText("本人と、担当する者だけが表示できます")).toBeVisible();
  await expect(page.getByText("090-1234-5678")).toHaveCount(0);
  await page.keyboard.press("Escape");

  // 5) 一般の画面（管理者以外）で管理画面へ直接遷移しても操作できず、APIも403
  const memberCtx = await newUserContext(browser, viewport);
  const mp = await memberCtx.newPage();
  const other = await inviteNewMember(request, "架空 一般 比較用", uniqueEmail("e2e-plain"));
  const plainEmail = uniqueEmail("e2e-plain2");
  const plain = await inviteNewMember(request, "架空 一般 直接遷移", plainEmail);
  await acceptInvitationViaUi(mp, plainEmail, plain.token, { mfa: false });
  await mp.goto("/app/admin");
  await expect(mp.getByText("この画面は管理者だけが使えます")).toBeVisible();
  await expect(mp.getByRole("list", { name: "管理する団員" })).toHaveCount(0);
  // 名簿は読めるが、追加・管理の操作は出ない（出さないだけでなく、下のAPIも拒否する）
  await mp.goto("/app/members");
  await expect(mp.getByRole("button", { name: "団員を追加" })).toBeDisabled();
  await mp.getByRole("list", { name: "団員一覧" }).getByRole("button").first().click();
  await expect(mp.getByRole("dialog", { name: /のプロフィール/ }).getByRole("button", { name: "基本情報を編集する" })).toHaveCount(0);
  await mp.keyboard.press("Escape");
  const memberDirectUpdate = await memberCtx.request.patch(`${BASE}/api/v1/members/${other.memberId}`, {
    headers: apiHeaders({ "idempotency-key": crypto.randomUUID() }),
    data: JSON.stringify({ version: 1, rank: "分団長" }),
  });
  expect(memberDirectUpdate.status()).toBe(403);
  const memberInvite = await memberCtx.request.post(`${BASE}/api/v1/invitations`, {
    headers: apiHeaders({ "idempotency-key": crypto.randomUUID() }),
    data: JSON.stringify({ memberId: other.memberId, email: uniqueEmail("x"), expiresInHours: 24 }),
  });
  expect(memberInvite.status()).toBe(403);

  // 6) 利用停止：理由が必須。確認に対象・理由・影響が出る。過去の記録は保持される
  await selectMember(page, name);
  await expect(page.getByLabel("停止理由")).toBeVisible();
  await expect(page.getByText("過去の活動記録を保持")).toBeVisible();
  const stopButton = page.getByRole("button", { name: "停止の内容を確認する" });
  await expect(stopButton).toBeDisabled(); // 理由が空の間は押せない
  await page.getByLabel("停止後の状態").selectOption("retired");
  await page.getByLabel("停止理由").fill("転居による退団");
  await stopButton.click();
  const confirmStop = page.getByRole("dialog", { name: "利用停止の確認" });
  await expect(confirmStop.getByText("転居による退団")).toBeVisible();
  await expect(confirmStop.getByText("過去の活動記録・履歴は保持されます")).toBeVisible();
  await confirmStop.getByRole("button", { name: "停止する" }).click();
  await expect(page.getByRole("list", { name: "管理する団員" }).getByRole("button", { name: new RegExp(`${name}.*退団`) })).toBeVisible();

  // 停止した本人は、開いていた画面からも新しいログインからも業務に入れない。名簿には行が残る
  await ip.goto("/app/members");
  await expect(ip).toHaveURL(/\/login/);
  await loginViaUi(ip, email);
  await expect(ip.getByText(/このアカウントは利用できません/)).toBeVisible();
  await page.goto("/app/members");
  await page.getByPlaceholder("氏名・班・資格で絞り込み").fill(name);
  const row = page.getByRole("list", { name: "団員一覧" }).getByRole("button", { name: new RegExp(name) });
  await expect(row).toBeVisible();
  await expect(row.getByText("退団").locator("visible=true")).toBeVisible();

  // 7) 最後の管理者は停止できない
  await selectMember(page, "架空 管理者");
  await page.getByLabel("停止理由").fill("試験");
  await page.getByRole("button", { name: "停止の内容を確認する" }).click();
  await page.getByRole("dialog", { name: "利用停止の確認" }).getByRole("button", { name: "停止する" }).click();
  await expect(page.getByText("最後の管理者は停止・降格できません").first()).toBeVisible();
  const still = await adminApi<{ data: { roles: string[] } }>(request, "GET", "/api/v1/me");
  expect(still.status).toBe(200);
  for (const c of [invitee, memberCtx]) await c.close();
});

// 幅: 両方（検索欄320×42・ドロワー440px(PC)/360px(スマホ)の寸法断言）
test("members_screen_matches_the_prototype_structure", async ({ page }, info) => {
  await page.goto("/app/members");
  const phone = isPhone(page.viewportSize());
  await expect(page.getByRole("heading", { level: phone ? 2 : 1, name: phone ? "団員名簿" : "団員" })).toBeVisible();
  const search = page.getByPlaceholder("氏名・班・資格で絞り込み");
  await expect(search).toBeVisible();
  await expect(page.getByRole("button", { name: "団員を追加" })).toBeEnabled(); // 管理者
  await expect(page.getByRole("group", { name: "班で絞り込み" }).getByRole("button", { name: "すべて" })).toBeVisible();
  const list = page.getByRole("list", { name: "団員一覧" });
  await expect(list.getByRole("button").first()).toBeVisible();
  if (!phone) {
    // prototype: 検索欄320×42、一覧の見出し（団員/班/役職/資格・講習）、団員ドロワー440px
    const box = (await search.locator("xpath=ancestor::label").boundingBox())!;
    expect([Math.round(box.width), Math.round(box.height)]).toEqual([320, 42]);
    for (const h of ["団員", "班", "役職", "資格・講習"]) await expect(page.getByText(h, { exact: true }).first()).toBeVisible();
    await list.getByRole("button").first().click();
    const drawer = page.getByRole("dialog", { name: /のプロフィール/ });
    expect(Math.round((await drawer.boundingBox())!.width)).toBe(440);
    await expect(drawer.getByText("MEMBER PROFILE")).toBeVisible();
    await expect(drawer.getByText("他の団員の連絡先を読み込んだ記録は、監査ログに残ります")).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(drawer).toBeHidden();
  } else {
    await list.getByRole("button").first().click();
    const drawer = page.getByRole("dialog", { name: /のプロフィール/ });
    expect(Math.round((await drawer.boundingBox())!.width)).toBe(360); // スマホは全幅
    await page.getByRole("button", { name: "閉じる" }).click();
  }
  expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(0);
  if (process.env.SAVE_EVIDENCE === "1") await page.screenshot({ path: `docs/evidence/ph1/members-${info.project.name}.png` });
  // 管理画面も横にはみ出さない
  await page.goto("/app/admin");
  await page.getByRole("list", { name: "管理する団員" }).getByRole("button").first().click();
  expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(0);
  if (process.env.SAVE_EVIDENCE === "1") await page.screenshot({ path: `docs/evidence/ph1/admin-${info.project.name}.png`, fullPage: true });
});

// 幅: desktop限定（幅で変わる断言なし（流れ・データの断言））
test("keyboard_only_can_filter_open_and_close_the_member_drawer", async ({ page }) => {
  await page.goto("/app/members");
  await page.getByPlaceholder("氏名・班・資格で絞り込み").fill("管理者");
  const row = page.getByRole("list", { name: "団員一覧" }).getByRole("button", { name: /架空 管理者/ });
  await row.focus();
  await page.keyboard.press("Enter");
  const drawer = page.getByRole("dialog", { name: /のプロフィール/ });
  await expect(drawer).toBeVisible();
  await expect(drawer.getByRole("button", { name: "閉じる" })).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(drawer).toBeHidden();
  await expect(row).toBeFocused(); // 開いた操作へフォーカスが戻る
});

// 幅: desktop限定（幅で変わる断言なし（流れ・データの断言））
test("unsaved_input_is_confirmed_before_closing_and_conflicts_and_revocations_are_shown", async ({ page, browser, request }, info) => {
  const viewport = info.project.use.viewport!;
  // 1) 入力途中でEscを押しても、確認なしには閉じない（確認は最前面で、既定は「戻る」）
  await page.goto("/app/members");
  await page.getByRole("button", { name: "団員を追加" }).click();
  const add = page.getByRole("dialog", { name: "団員を追加" });
  await add.getByLabel("氏名").fill("架空 入力途中");
  await page.keyboard.press("Escape");
  const confirm = page.getByRole("dialog", { name: "入力を破棄しますか" });
  await expect(confirm).toBeVisible();
  await expect(confirm.getByRole("button", { name: "戻る" })).toBeFocused();
  await confirm.getByRole("button", { name: "戻る" }).click();
  await expect(add).toBeVisible();
  await expect(add.getByLabel("氏名")).toHaveValue("架空 入力途中");
  await page.keyboard.press("Escape");
  // 確認は最前面：実際にクリックできる位置にある（他の要素に覆われていない）。確認の上のEscは確認だけを閉じ、背面の入力は残る
  const box = (await page.getByRole("dialog", { name: "入力を破棄しますか" }).getByRole("button", { name: "戻る" }).boundingBox())!;
  const topmost = await page.evaluate(([x, y]) => document.elementFromPoint(x!, y!)?.closest("[role=dialog]")?.getAttribute("aria-label"), [box.x + box.width / 2, box.y + box.height / 2]);
  expect(topmost).toBe("入力を破棄しますか");
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog", { name: "入力を破棄しますか" })).toBeHidden();
  await expect(add.getByLabel("氏名")).toHaveValue("架空 入力途中");
  await page.keyboard.press("Escape");
  await page.getByRole("dialog", { name: "入力を破棄しますか" }).getByRole("button", { name: "破棄して閉じる" }).click();
  await expect(add).toBeHidden();
  // 破棄したあと、操作の位置（「団員を追加」）へフォーカスが戻る
  await expect(page.getByRole("button", { name: "団員を追加" })).toBeFocused();

  // 2) 本人（アカウントあり）を用意する
  const name = `架空 競合確認 ${crypto.randomUUID().slice(0, 4)}`;
  const email = uniqueEmail("e2e-conflict");
  const made = await inviteNewMember(request, name, email);
  const ctx = await newUserContext(browser, viewport);
  const ip = await ctx.newPage();
  await acceptInvitationViaUi(ip, email, made.token, { mfa: false });

  // 3) 画面を開いたあとに、他の操作で更新されると、競合として表示され保存されない
  await selectMember(page, name);
  const cur = await adminApi<{ data: { id: string; version: number }[] }>(request, "GET", `/api/v1/members?q=${encodeURIComponent(name)}`);
  const bumped = await adminApi(request, "PATCH", `/api/v1/members/${made.memberId}`, { version: cur.data.data[0]!.version, rank: "班長" }); // 画面を開いた後の別操作
  expect(bumped.status).toBe(200);
  await page.getByRole("checkbox", { name: "担当者" }).check();
  await page.getByLabel("変更の理由").fill("競合の確認");
  await page.getByRole("button", { name: "変更内容を確認する" }).click();
  await page.getByRole("dialog", { name: "役割と担当の変更を確認" }).getByRole("button", { name: "この内容で変更する" }).click();
  await expect(page.getByText("他の操作で更新されています").first()).toBeVisible();
  await page.getByRole("dialog", { name: "役割と担当の変更を確認" }).getByRole("button", { name: "戻る" }).click();

  // 4) 担当（連絡先を読める団員）を選んで保存 → 取消もできる。反映は管理画面の一覧に出る
  await selectMember(page, name);
  await page.getByRole("checkbox", { name: "担当者" }).check();
  await page.getByRole("group", { name: "連絡先を読める団員（担当）" }).getByRole("checkbox", { name: "架空 管理者" }).check();
  await page.getByLabel("変更の理由").fill("連絡網の担当");
  await page.getByRole("button", { name: "変更内容を確認する" }).click();
  const dlg = page.getByRole("dialog", { name: "役割と担当の変更を確認" });
  await expect(dlg.getByText("担当を追加：架空 管理者 の連絡先")).toBeVisible();
  await dlg.getByRole("button", { name: "この内容で変更する" }).click();
  await expect(page.getByRole("list", { name: "管理する団員" }).getByRole("button", { name: new RegExp(`${name}.*担当者`) })).toBeVisible();

  // 5) 全セッション失効：本人のログイン中の画面は、次の操作から使えなくなる
  await selectMember(page, name);
  await page.getByRole("button", { name: "全セッションを失効させる" }).click();
  const rv = page.getByRole("dialog", { name: "全セッションの失効" });
  await rv.getByLabel("理由").fill("端末紛失の申告");
  await rv.getByRole("button", { name: "失効させる" }).click();
  await expect(page.getByText("全端末のログインを解除しました")).toBeVisible();
  await ip.goto("/app/members");
  await expect(ip).toHaveURL(/\/login/);
  await ctx.close();
});

/**
 * AI評価パネルの押下領域（PH4レビューC 中1）。
 * 「分類holdout（300件）を評価する」「報告書holdout（50件）を評価する」「実行履歴を再読み込み」は、
 * モバイル（360px）で44px以上の押下領域を持つ（docs/03 §1.1-5。MembersPage.tsx:221の
 * `h-[42px] max-lg:min-h-11` と同じ流儀。PCはコンパクト寸法42pxが正のためモバイルだけで検査する）。
 */
// 幅: phone限定（押下領域44pxの規則はモバイルのみ。PCはコンパクト寸法が正＝T085b設定側の仕分け）
test("ai_evaluation_buttons_meet_touch_target_on_mobile", async ({ page }) => {
  await page.goto("/app/admin");
  for (const name of ["分類holdout（300件）を評価する", "報告書holdout（50件）を評価する", "実行履歴を再読み込み"]) {
    const button = page.getByRole("button", { name });
    await expect(button).toBeVisible();
    const height = await button.evaluate((el) => el.getBoundingClientRect().height);
    expect(height, `「${name}」のモバイル押下領域は44px以上（docs/03 §1.1-5）`).toBeGreaterThanOrEqual(44);
  }
});
