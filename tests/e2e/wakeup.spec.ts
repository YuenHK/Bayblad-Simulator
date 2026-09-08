import { expect, test } from "@playwright/test";

test("cold server shows a wake-up notice then connects automatically", async ({ page }) => {
  let calls = 0;
  await page.route("**/api/identity", async (route) => {
    calls += 1;
    if (calls <= 2) await route.fulfill({ status: 503, body: "Service waking up" });
    else await route.continue();
  });
  await page.goto(".");
  await expect(page.getByText("等候伺服器回應……", { exact: true })).toBeVisible();
  await expect(page.getByText(/伺服器可能正在喚醒/)).toBeVisible();
  await expect(page.getByRole("heading", { name: "陀螺設計器" })).toBeVisible();
  await expect(page.getByRole("alert")).toHaveCount(0);
  await expect(page.getByText("已連線", { exact: true })).toBeVisible({ timeout: 20_000 });
  await expect(page.getByText(/伺服器可能正在喚醒/)).toHaveCount(0);
  expect(calls).toBe(3);
});
