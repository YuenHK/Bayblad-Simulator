import { expect, test, type Browser, type BrowserContext, type Page } from "@playwright/test";

const adminUrl = "https://bayblad-simulator-api.onrender.com/admin/";
const adminPassword = process.env.PUBLIC_ADMIN_PASSWORD ?? "fwft2026";

async function waitConnected(page: Page) {
  await expect(page.getByText("已連線", { exact: true })).toBeVisible({ timeout: 30_000 });
}

async function openIsolatedGuest(browser: Browser, protocolEvents: string[] = []): Promise<{ context: BrowserContext; page: Page }> {
  const context = await browser.newContext({ viewport: { width: 1024, height: 768 }, hasTouch: true });
  const page = await context.newPage();
  page.on("websocket", (socket) => socket.on("framereceived", ({ payload }) => {
    const frame = String(payload);
    if (["match.finished", "match.persistence", "match.persistence_failed", "room.snapshot", "room.delta", "battle.started", "BATTLE_FAILED"].some((type) => frame.includes(type))) protocolEvents.push(frame);
  }));
  await page.goto("https://yuenhk.github.io/Bayblad-Simulator/");
  await waitConnected(page);
  return { context, page };
}

async function joinRoom(page: Page, code: string) {
  await page.getByRole("button", { name: "對戰大廳" }).click();
  await page.getByLabel("房間碼").fill(code);
  await page.getByLabel("進入身份").selectOption("player");
  await page.getByRole("button", { name: "以房間碼進入" }).click();
  await expect(page.getByText(`房間碼 ${code}`, { exact: true })).toBeVisible();
}

test("學生設計、限制、預覽及響應式操作", async ({ page }, testInfo) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => { if (message.type() === "error") errors.push(message.text()); });
  await page.goto(".");
  await waitConnected(page);
  await expect(page.locator(".student-game")).toBeVisible();
  await expect(page.getByRole("button", { name: "關閉音效" })).toBeVisible();
  await expect(page.getByRole("button", { name: "減少動態效果" })).toBeVisible();
  await page.getByRole("combobox", { name: "形狀" }).selectOption("star");
  await page.getByRole("spinbutton", { name: "角數" }).fill("7");
  await page.getByRole("spinbutton", { name: "直徑（mm）" }).fill("80");
  await page.getByRole("combobox", { name: "金屬碟直徑" }).selectOption("30");
  if (testInfo.project.name === "chromium-phone") await page.getByRole("tab", { name: "預測結果" }).click();
  await expect(page.getByText("最大直徑為 60 mm")).toBeVisible();
  await expect(page.getByRole("button", { name: "規格未通過，請先修正" })).toBeDisabled();
  if (testInfo.project.name === "chromium-phone") await page.getByRole("tab", { name: "控制台" }).click();
  await page.getByRole("spinbutton", { name: "直徑（mm）" }).fill("58");
  await page.getByRole("button", { name: "將目前層下移" }).click();
  if (testInfo.project.name === "chromium-phone") {
    await expect(page.getByRole("tablist", { name: "設計室區域" })).toBeVisible();
    await page.getByRole("tab", { name: "模擬預覽" }).click();
  }
  await page.getByRole("tab", { name: "分解圖" }).click();
  await expect(page.getByRole("img", { name: "陀螺分解圖" })).toBeVisible();
  await page.getByRole("tab", { name: "3D 預覽" }).click();
  await expect(page.getByRole("group", { name: /3D 陀螺預覽控制/u })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
  expect(errors).toEqual([]);
});

test("老師登入、統計篩選、排行榜及 Excel 匯出", async ({ page }, testInfo) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(adminUrl);
  await expect(page.getByRole("heading", { name: "教師登入" })).toBeVisible();
  await page.getByLabel("帳號").fill("admin");
  await page.getByLabel("密碼").fill("incorrect-password");
  await page.getByRole("button", { name: "登入" }).click();
  await expect(page.getByText("帳號或密碼不正確")).toBeVisible();
  await page.getByLabel("密碼").fill(adminPassword);
  await page.getByRole("button", { name: "登入" }).click();
  await expect(page.getByRole("heading", { name: "教師控制台" })).toBeVisible({ timeout: 30_000 });
  await expect(page.getByRole("heading", { name: "學生總分排行榜（只供教師查看）" })).toBeVisible();
  await expect(page.getByText("發射判定分佈")).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
  if (testInfo.project.name === "chromium-desktop") {
    if (process.env.PUBLIC_EXPORT_EMPTY_RANGE === "1") {
      await page.getByLabel("開始日期").fill("2020-01-01");
      await page.getByLabel("結束日期").fill("2020-01-02");
    }
    const download = page.waitForEvent("download", { timeout: 20_000 });
    const exportResponse = page.waitForResponse((response) => response.url().includes("/api/admin/export.xlsx"), { timeout: 20_000 });
    await page.getByRole("button", { name: "匯出 Excel" }).click();
    const response = await exportResponse;
    console.info(`[admin-export] status=${response.status()} body=${await response.text()}`);
    expect(response.status()).toBe(200);
    const file = await download;
    expect(file.suggestedFilename()).toMatch(/\.xlsx$/u);
  }
  expect(errors).toEqual([]);
  await page.getByRole("button", { name: "登出" }).click();
  await expect(page.getByRole("heading", { name: "教師登入" })).toBeVisible();
});

test("兩個獨立訪客完成建立、準備、三輪發射及賽後計分", async ({ browser, browserName }) => {
  test.skip(browserName !== "chromium", "完整即時對戰只跑一次；其餘引擎測核心頁面與老師端");
  const ownerEvents: string[] = [], peerEvents: string[] = [];
  const owner = await openIsolatedGuest(browser, ownerEvents);
  const peer = await openIsolatedGuest(browser, peerEvents);
  try {
    const ownerName = await owner.page.locator('[aria-label^="身份來源："]').textContent();
    const peerName = await peer.page.locator('[aria-label^="身份來源："]').textContent();
    expect(ownerName).not.toBe(peerName);
    await owner.page.getByRole("button", { name: "對戰大廳" }).click();
    await owner.page.getByLabel("房間名稱").fill("跨瀏覽器驗收房");
    await owner.page.getByRole("button", { name: "建立房間" }).click();
    const code = (await owner.page.locator(".room-heading .eyebrow").textContent())!.replace("房間碼", "").trim();
    await joinRoom(peer.page, code);
    await Promise.all([
      owner.page.getByRole("button", { name: "上載當前設計並準備" }).click(),
      peer.page.getByRole("button", { name: "上載當前設計並準備" }).click(),
    ]);
    const resultHeading = owner.page.getByRole("heading", { name: "對戰結果" });
    for (let attempt = 0; attempt < 6 && !(await resultHeading.isVisible()); attempt += 1) {
      const ownerLaunch = owner.page.getByRole("button", { name: "在判定線發射" });
      const peerLaunch = peer.page.getByRole("button", { name: "在判定線發射" });
      const ownerGrade = owner.page.getByText(/^你的判定：(Perfect|Great|Good|Miss)$/u);
      const peerGrade = peer.page.getByText(/^你的判定：(Perfect|Great|Good|Miss)$/u);
      await expect(ownerLaunch).toBeEnabled();
      await expect(peerLaunch).toBeEnabled();
      await expect(owner.page.locator(".energy-track .zone-perfect")).toBeVisible();
      await expect(owner.page.locator(".launch-countdown")).toHaveText("發射！", { timeout: 8_000 });
      await expect(peer.page.locator(".launch-countdown")).toHaveText("發射！", { timeout: 8_000 });
      await Promise.all([ownerLaunch.click(), peerLaunch.click()]);
      await expect(ownerGrade).toBeVisible();
      await expect(peerGrade).toBeVisible();
      const arena = owner.page.locator(".battle-arena");
      const top = owner.page.getByTestId("battle-player1");
      await expect(arena).toBeVisible({ timeout: 30_000 });
      const firstTransform = await top.getAttribute("transform");
      await owner.page.waitForTimeout(500);
      await expect(top).not.toHaveAttribute("transform", firstTransform ?? "", { timeout: 5_000 });
      await expect(owner.page.locator(".top-afterimage").first()).toBeVisible();
      await Promise.race([
        resultHeading.waitFor({ state: "visible", timeout: 30_000 }),
        ownerGrade.waitFor({ state: "hidden", timeout: 30_000 }),
      ]);
    }
    await expect(resultHeading).toBeVisible({ timeout: 30_000 });
    await expect(owner.page.getByTestId("arena-victory")).toBeVisible();
    await expect(owner.page.getByTestId("arena-victory")).toContainText(/玩家[一二]勝出/u);
    await expect(owner.page.getByText("總分：", { exact: false })).toHaveCount(2);
    await expect(owner.page.getByText("排行榜")).toHaveCount(0);
  } finally {
    console.info(`[owner-protocol] ${ownerEvents.join("\n")}`);
    console.info(`[peer-protocol] ${peerEvents.join("\n")}`);
    await owner.context.close().catch(() => undefined);
    await peer.context.close().catch(() => undefined);
  }
});
