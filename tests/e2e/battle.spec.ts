import { expect, test, type Browser, type BrowserContext, type Page } from "@playwright/test";

const CONTROL_SECRET = "steam-top-e2e-only";
const REALTIME_URL = `http://127.0.0.1:${Number(process.env.E2E_REALTIME_PORT ?? 4174)}`;

async function openGuest(browser: Browser): Promise<{ context: BrowserContext; page: Page }> {
  const context = await browser.newContext({ viewport: { width: 1024, height: 768 }, hasTouch: true });
  const page = await context.newPage();
  page.on("requestfailed", (request) => console.info(`[requestfailed] ${request.method()} ${request.url()} ${request.failure()?.errorText}`));
  await page.goto(".");
  await expect(page.getByText("已連線", { exact: true })).toBeVisible();
  return { context, page };
}

async function chooseDesign(page: Page, diameter: string): Promise<void> {
  await page.getByLabel("直徑（mm）", { exact: true }).fill(diameter);
  await page.getByRole("button", { name: "用此設計參戰" }).click();
  await expect(page.getByRole("heading", { name: "對戰大廳" })).toBeVisible();
}

async function joinByCode(page: Page, code: string, role: "player" | "spectator"): Promise<void> {
  await page.getByLabel("房間碼").fill(code);
  await page.getByLabel("進入身份").selectOption(role);
  await page.getByRole("button", { name: "以房間碼進入" }).click();
  await expect(page.getByText(`房間碼 ${code}`, { exact: true })).toBeVisible();
}

async function launchRound(player1: Page, player2: Page, spectator?: Page): Promise<void> {
  const p1Button = player1.getByRole("button", { name: "在判定線發射" });
  const p2Button = player2.getByRole("button", { name: "在判定線發射" });
  await expect(p1Button).toBeEnabled();
  await expect(p2Button).toBeEnabled();
  for (const page of [player1, player2]) {
    await expect(page.locator(".scoreline")).toHaveCount(0);
    await expect(page.getByText("對戰分：", { exact: false })).toHaveCount(0);
    await expect(page.getByText("挑戰分：", { exact: false })).toHaveCount(0);
    await expect(page.getByText("總分：", { exact: false })).toHaveCount(0);
  }
  await expect(player1.locator(".launch-countdown")).toHaveText("發射！", { timeout: 5_000 });
  await expect(player2.locator(".launch-countdown")).toHaveText("發射！", { timeout: 5_000 });
  await Promise.all([p1Button.click(), p2Button.click()]);
  await expect(player1.getByText(/^你的判定：(Perfect|Great|Good|Miss)$/)).toBeVisible();
  await expect(player2.getByText(/^你的判定：(Perfect|Great|Good|Miss)$/)).toBeVisible();
  await expect(player1.locator(".spectator-grades")).toHaveCount(0);
  await expect(player2.locator(".spectator-grades")).toHaveCount(0);
  await expect(player1.getByText(/^玩家[一二]：(Perfect|Great|Good|Miss)$/)).toHaveCount(0);
  await expect(player2.getByText(/^玩家[一二]：(Perfect|Great|Good|Miss)$/)).toHaveCount(0);
  if (spectator) {
    await expect(spectator.getByText(/^玩家一：(Perfect|Great|Good|Miss)$/)).toBeVisible();
    await expect(spectator.getByText(/^玩家二：(Perfect|Great|Good|Miss)$/)).toBeVisible();
    await expect(spectator.getByTestId("battle-player1").locator("path")).toHaveCount(3);
    await expect(spectator.getByTestId("battle-player2").locator("path")).toHaveCount(3);
  }
}

test("真實 Socket 三角色完成讓位、觀戰、三輪內對戰及賽後計分", async ({ browser }) => {
  const owner = await openGuest(browser);
  const playerA = await openGuest(browser);
  const playerB = await openGuest(browser);
  try {
    await chooseDesign(owner.page, "40");
    await owner.page.getByRole("button", { name: "建立房間" }).click();
    const codeText = await owner.page.locator(".room-heading .eyebrow").textContent();
    const code = codeText?.replace("房間碼", "").trim();
    expect(code).toMatch(/^[A-Z0-9]+$/);
    await owner.page.getByRole("button", { name: "轉到觀賽區" }).click();
    await expect(owner.page.getByRole("heading", { name: "等待玩家" }).first()).toBeVisible();

    await chooseDesign(playerA.page, "41");
    await joinByCode(playerA.page, code!, "player");
    await chooseDesign(playerB.page, "42");
    await joinByCode(playerB.page, code!, "player");
    await expect(owner.page.getByRole("heading", { name: "1 位觀眾" })).toBeVisible();
    const spectatorName = await owner.page.locator(".spectator-list li").textContent();
    expect(spectatorName).toContain("訪客-");

    await Promise.all([
      playerA.page.getByRole("button", { name: /設計準備/ }).click(),
      playerB.page.getByRole("button", { name: /設計準備/ }).click(),
    ]);
    await launchRound(playerA.page, playerB.page, owner.page);
    await launchRound(playerA.page, playerB.page, owner.page);
    await launchRound(playerA.page, playerB.page, owner.page);

    for (const page of [owner.page, playerA.page, playerB.page]) {
      await expect(page.getByRole("heading", { name: "對戰結果" })).toBeVisible();
      await expect(page.locator(".scoreline")).toHaveText("2:1");
      await expect(page.getByText("對戰分：", { exact: false })).toHaveCount(2);
      await expect(page.getByText("挑戰分：", { exact: false })).toHaveCount(2);
      await expect(page.getByText("總分：", { exact: false })).toHaveCount(2);
      await expect(page.getByText("排行榜")).toHaveCount(0);
    }
  } finally {
    await Promise.all([owner.context.close(), playerA.context.close(), playerB.context.close()]);
  }
});

test("發射與對戰斷線可恢復 checkpoint，119 秒可取結果而超過 120 秒不可", async ({ browser, request }) => {
  const owner = await openGuest(browser);
  const peer = await openGuest(browser);
  try {
    await chooseDesign(owner.page, "40");
    await owner.page.getByRole("button", { name: "建立房間" }).click();
    const code = (await owner.page.locator(".room-heading .eyebrow").textContent())!.replace("房間碼", "").trim();
    await chooseDesign(peer.page, "50");
    await joinByCode(peer.page, code, "player");
    await Promise.all([
      owner.page.getByRole("button", { name: /設計準備/ }).click(),
      peer.page.getByRole("button", { name: /設計準備/ }).click(),
    ]);
    await expect(owner.page.getByRole("button", { name: "在判定線發射" })).toBeEnabled();
    await owner.context.setOffline(true);
    await expect(owner.page.getByText("重新連線中……")).toBeVisible();
    await owner.context.setOffline(false);
    await expect(owner.page.getByText("已恢復上次的房間位置。")).toBeVisible();
    await expect(owner.page.locator(".launch-countdown")).toHaveText("發射！", { timeout: 5_000 });
    await expect(peer.page.locator(".launch-countdown")).toHaveText("發射！", { timeout: 5_000 });
    await Promise.all([
      owner.page.getByRole("button", { name: "在判定線發射" }).click(),
      peer.page.getByRole("button", { name: "在判定線發射" }).click(),
    ]);
    await expect(peer.page.getByRole("heading", { name: "對戰場" })).toBeVisible();
    for (const page of [owner.page, peer.page]) {
      await expect(page.locator(".scoreline")).toHaveCount(0);
      await expect(page.getByText("對戰分：", { exact: false })).toHaveCount(0);
      await expect(page.getByText("挑戰分：", { exact: false })).toHaveCount(0);
      await expect(page.getByText("總分：", { exact: false })).toHaveCount(0);
    }
    await peer.context.setOffline(true);
    await peer.context.setOffline(false);
    await expect(peer.page.getByText("已恢復上次的房間位置。")).toBeVisible();
    await launchRound(owner.page, peer.page);
    await expect(owner.page.getByRole("heading", { name: "對戰結果" })).toBeVisible();
    for (const page of [owner.page, peer.page]) {
      await expect(page.locator(".scoreline")).toHaveText("2:0");
      await expect(page.getByText("對戰分：", { exact: false })).toHaveCount(2);
      await expect(page.getByText("挑戰分：", { exact: false })).toHaveCount(2);
      await expect(page.getByText("總分：", { exact: false })).toHaveCount(2);
      await expect(page.locator(".score-grid dl").nth(0)).toContainText("對戰分：2");
      await expect(page.locator(".score-grid dl").nth(0)).toContainText("挑戰分：0.3");
      await expect(page.locator(".score-grid dl").nth(0)).toContainText("總分：2.3");
      await expect(page.locator(".score-grid dl").nth(1)).toContainText("對戰分：0");
      await expect(page.locator(".score-grid dl").nth(1)).toContainText("挑戰分：0.0");
      await expect(page.locator(".score-grid dl").nth(1)).toContainText("總分：0.0");
      await expect(page.getByText("排行榜")).toHaveCount(0);
    }

    await owner.context.setOffline(true);
    const advance119 = await request.post(`${REALTIME_URL}/__test/advance`, { headers: { "x-test-secret": CONTROL_SECRET }, data: { ms: 119_000 } });
    expect(advance119.ok()).toBe(true);
    await owner.context.setOffline(false);
    await expect(owner.page.getByRole("heading", { name: "對戰結果" })).toBeVisible();

    await owner.context.setOffline(true);
    const advance121 = await request.post(`${REALTIME_URL}/__test/advance`, { headers: { "x-test-secret": CONTROL_SECRET }, data: { ms: 121_000 } });
    expect(advance121.ok()).toBe(true);
    await owner.context.setOffline(false);
    await expect(owner.page.getByText("舊連線已過期，已為你建立新訪客連線。")).toBeVisible();
    await expect(owner.page.getByRole("heading", { name: "對戰結果" })).toHaveCount(0);
  } finally {
    await Promise.all([owner.context.close(), peer.context.close()]);
  }
});

test("房主斷線兩分鐘後轉移，空房再過兩分鐘自動刪除", async ({ browser, request }) => {
  const owner = await openGuest(browser);
  const peer = await openGuest(browser);
  try {
    await owner.page.getByRole("button", { name: "對戰大廳" }).click();
    await peer.page.getByRole("button", { name: "對戰大廳" }).click();
    await owner.page.getByLabel("房間名稱").fill("兩分鐘生命週期房");
    await owner.page.getByRole("button", { name: "建立房間" }).click();
    const code = (await owner.page.locator(".room-heading .eyebrow").textContent())!.replace("房間碼", "").trim();
    await joinByCode(peer.page, code, "spectator");

    await owner.context.setOffline(true);
    await expect(owner.page.getByText("重新連線中……")).toBeVisible();
    const transfer = await request.post(`${REALTIME_URL}/__test/advance`, { headers: { "x-test-secret": CONTROL_SECRET }, data: { ms: 120_001 } });
    expect(transfer.ok()).toBe(true);
    await expect(peer.page.getByRole("button", { name: "關閉房間" })).toBeVisible();

    await peer.page.getByRole("button", { name: "離開房間" }).click();
    await expect(peer.page.getByRole("heading", { name: "對戰大廳" })).toBeVisible();
    const deletion = await request.post(`${REALTIME_URL}/__test/advance`, { headers: { "x-test-secret": CONTROL_SECRET }, data: { ms: 120_001 } });
    expect(deletion.ok()).toBe(true);
    await expect(peer.page.getByRole("heading", { name: "兩分鐘生命週期房" })).toHaveCount(0);
  } finally {
    await Promise.all([owner.context.close(), peer.context.close()]);
  }
});
