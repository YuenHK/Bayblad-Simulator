import { expect, test, type Page } from "@playwright/test";
const password = process.env.E2E_ADMIN_PASSWORD ?? "e2e-admin-only-password";
async function login(page: Page) {
  await page.goto("/admin");
  await expect(page.getByRole("heading", { name: "教師登入" })).toBeVisible();
  await page.getByLabel("密碼").fill(password);
  await page.getByRole("button", { name: "登入" }).press("Enter");
  await expect(page.getByRole("heading", { name: "教師控制台" })).toBeVisible();
}
test("教師登入、房間確認、篩選、統計及刪除流程不外洩密碼", async ({ page }) => {
  await login(page);
  expect(page.url()).not.toContain(password);
  expect(await page.evaluate(() => JSON.stringify(localStorage))).not.toContain(
    password,
  );
  await expect(page.getByText("1 間房間")).toBeVisible();
  await page.getByRole("button", { name: "強制關房" }).click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await page.getByRole("button", { name: "取消" }).click();
  await page.getByLabel("班別").fill("1A");
  await expect(page.getByText("iPad-01")).toBeVisible();
  await page.getByRole("checkbox", { name: "選取 陳同學" }).check();
  await page.getByRole("button", { name: "刪除紀錄" }).click();
  await page.getByRole("button", { name: "預覽刪除範圍" }).click();
  await expect(page.getByText(/1 個身份、2 個設計、3 場對戰/)).toBeVisible();
  await page.getByLabel("再次輸入管理員密碼").fill(password);
  await page.getByLabel("輸入 DELETE 確認").fill("DELETE");
  await page.getByRole("button", { name: "永久刪除" }).click();
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
    await page.keyboard.press("Tab");
    await expect(page.locator(":focus")).toBeVisible();
  });
});
