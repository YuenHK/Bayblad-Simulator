import { expect, test, type Page } from "@playwright/test";
const password = process.env.E2E_ADMIN_PASSWORD ?? "e2e-admin-only-password";
async function login(page: Page) {
  await page.goto(".");
  await expect(page.getByRole("heading", { name: "教師登入" })).toBeVisible();
  await page.getByLabel("密碼").fill(password);
  await page.getByRole("button", { name: "登入" }).press("Enter");
  await expect(page.getByRole("heading", { name: "教師控制台" })).toBeVisible();
}
async function confirmAction(page: Page) {
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("button", { name: "繼續" }).click();
  await dialog.getByRole("button", { name: /^確定/u }).click();
  await expect(page.getByRole("dialog")).toBeHidden();
}
test("教師登入、房間確認、篩選、統計及刪除流程不外洩密碼", async ({ page }) => {
  await login(page);
  expect(page.url()).not.toContain(password);
  expect(await page.evaluate(() => JSON.stringify(localStorage))).not.toContain(
    password,
  );
  await expect(page.getByText("2 間房間")).toBeVisible();
  await expect(page.getByRole("heading", { name: "學生總分排行榜（只供教師查看）" })).toBeVisible();
  await expect(page.getByText("發射判定分佈")).toBeVisible();
  const downloadPromise = page.waitForEvent("download");
  await page.getByRole("button", { name: "匯出 Excel" }).click();
  const download = await downloadPromise, stream = await download.createReadStream();
  const first = await new Promise<Buffer>((resolve, reject) => stream.once("data", resolve).once("error", reject));
  expect(first.subarray(0, 2).toString()).toBe("PK");
  await page.getByRole("button", { name: "暫停平台" }).click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("button", { name: "暫停平台" })).toBeFocused();
  await page.getByRole("button", { name: "暫停平台" }).click();
  await confirmAction(page);
  await expect(page.getByRole("button", { name: "恢復平台" })).toBeVisible();
  await page.getByRole("button", { name: "恢復平台" }).click();
  await confirmAction(page);
  const leeRoom = page.locator("article").filter({ hasText: "1B 李同學" });
  await leeRoom.getByRole("button", { name: "移除 1B 李同學" }).click();
  await confirmAction(page);
  await expect(page.getByText("1B 李同學")).toBeHidden();
  const chanRoom = page.locator("article").filter({ hasText: "1A 陳同學" });
  await chanRoom.getByRole("button", { name: "強制關房" }).click();
  await confirmAction(page);
  await expect(page.getByText("0 間房間")).toBeVisible();
  const stats = await page.request.get("/__test/stats", { headers: { "x-test-secret": "steam-top-e2e-only" } });
  const controlState=await stats.json();
  expect(controlState.adminAudits).toEqual(expect.arrayContaining(["admin.platform.pause", "admin.room.remove", "admin.room.close"]));
  expect(controlState.adminCommands).toHaveLength(4);
  expect(controlState.adminCommands.every((operation:{status:string})=>operation.status==="completed")).toBe(true);
  await page.getByLabel("班別").fill("2B");
  await expect(page.getByText("此頁沒有紀錄。")).toBeVisible();
  await page.getByLabel("班別").fill("1A");
  await expect(page.getByText("iPad-01")).toBeVisible();
  await page.getByRole("checkbox", { name: "選取 陳同學" }).check();
  await page.getByRole("button", { name: "刪除紀錄" }).click();
  await page.getByRole("button", { name: "預覽刪除範圍" }).click();
  await expect(page.getByText(/1 個身份、2 個設計、3 場對戰/)).toBeVisible();
  await page.getByRole("dialog").getByRole("button", { name: "繼續" }).click();
  await page.getByRole("button", { name: "確定永久刪除" }).click();
  await expect(page.getByText("0 筆紀錄")).toBeVisible();
  await page.getByRole("button", { name: "登出" }).click();
  await expect(page.getByRole("heading", { name: "教師登入" })).toBeVisible();
  await page.getByLabel("密碼").fill(password);
  await page.getByRole("button", { name: "登入" }).click();
  await expect(page.getByRole("heading", { name: "教師控制台" })).toBeVisible();
});
test.describe("iPad 與減少動態效果", () => {
  test.use({ viewport: { width: 820, height: 1180 }, hasTouch: true });
  test("可用鍵盤瀏覽後台", async ({ page }) => {
    await page.emulateMedia({ reducedMotion: "reduce" });
    await login(page);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
    const undersized = await page.locator("button, input, select").evaluateAll(elements => elements.filter(element => { const rect = element.getBoundingClientRect(); return rect.width > 0 && rect.height > 0 && (rect.height < 44 || rect.width < 44); }).length);
    expect(undersized).toBe(0);
    const opener = page.getByRole("button", { name: "刪除紀錄" });
    await opener.click();
    await expect(page.getByLabel("刪除範圍")).toBeFocused();
    await page.keyboard.press("Tab");
    await expect(page.locator(":focus")).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(opener).toBeFocused();
    await page.keyboard.press("Tab");
    await expect(page.locator(":focus")).toBeVisible();
  });
});
