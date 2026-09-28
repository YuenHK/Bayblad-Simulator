import { expect, test } from "@playwright/test";
test("shared console disables password changes and destructive record endpoints", async ({ page }) => {
  await page.goto(".");
  await page.getByLabel("口令").fill("wrong");
  await page.getByRole("button",{name:"進入控制台"}).click();
  await expect(page.getByRole("alert")).toBeVisible();
  await page.getByLabel("口令").fill("admin");
  await page.getByRole("button",{name:"進入控制台"}).click();
  await expect(page.getByRole("tab",{name:"總覽"})).toBeVisible();
  await expect(page.getByRole("button",{name:"更改密碼"})).toHaveCount(0);
  await expect(page.getByRole("button",{name:"刪除紀錄"})).toHaveCount(0);
  const origin = new URL(page.url()).origin;
  for (const path of ["/api/admin/password","/api/admin/records/deletion-preview"]) {
    const response = await page.request.post(origin+path,{headers:{origin,"sec-fetch-site":"same-origin"},data:{}});
    expect(response.status()).toBe(404);
  }
  expect((await page.request.delete(origin+"/api/admin/records",{data:{}})).status()).toBe(404);
});
