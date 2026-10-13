import { expect, test } from "@playwright/test";
import { readFile } from "node:fs/promises";

const draftKey = "steam-top:designer-draft:v1";
test("complete hands-on tutorial uses isolated copies, fixed tests and one local match", async ({ page }) => {
  const errors: string[] = [];
  const officialWrites: string[] = [];
  const officialCommands: string[] = [];
  page.on("websocket", socket => socket.on("framesent", event => { const data = String(event.payload); if (/room\.create|room\.ready|launch\.tap/.test(data)) officialCommands.push(data); }));
  page.on("pageerror", error => errors.push(error.message));
  page.on("request", request => { if (request.method() === "POST" && /\/api\/designs|\/matches/.test(request.url())) officialWrites.push(request.url()); });
  await page.goto("designer");
  await page.getByRole("spinbutton", { name: "直徑（mm）", exact: true }).fill("44");
  const before = await page.evaluate(key => localStorage.getItem(key), draftKey);
  await page.getByRole("button", { name: "開始教學", exact: true }).click();
  const next = page.getByRole("button", { name: "下一步", exact: true });
  await expect(next).toBeDisabled();
  await page.getByRole("spinbutton", { name: "直徑（mm）", exact: true }).fill("42");
  await next.click();
  await page.getByRole("button", { name: "複製此版本", exact: true }).click();
  await expect(next).toBeDisabled();
  await page.getByRole("spinbutton", { name: "直徑（mm）", exact: true }).fill("43");
  await next.click();
  for (const version of ["A", "B"]) {
    await page.getByLabel("編輯版本", { exact: true }).selectOption(version);
    await page.getByLabel("我的預測", { exact: true }).fill(`我預測版本 ${version} 的旋轉會不同，因為尺寸改變。`);
    await page.getByRole("button", { name: "測試此版本", exact: true }).click();
    await expect(page.getByRole("button", { name: "測試此版本", exact: true })).toBeVisible();
    await expect(page.getByRole("region", { name: "實驗紀錄" }).locator("details")).toHaveCount(version === "A" ? 1 : 2);
  }
  await next.click();
  await expect(next).toBeDisabled();
  for (const item of await page.getByRole("region", { name: "實驗紀錄" }).locator("details").all()) {
    if (await item.getAttribute("open") === null) await item.locator("summary").click();
    await item.getByLabel("我的觀察", { exact: true }).fill("比較兩個模型結果後，我發現碰撞次數有差別。");
    await item.getByLabel("下次想測甚麼", { exact: true }).fill("下次只改中層直徑。");
  }
  await next.click();
  await page.getByRole("button", { name: "建立教學房間", exact: true }).click();
  await expect(page.getByRole("button", { name: "在判定線發射", exact: true })).toBeVisible();
  // Intentionally do not tap: Miss must still produce a complete 10-second local battle.
  const cinema = page.getByTestId("cinematic-battle");
  await expect(cinema).toBeVisible({ timeout: 30_000 });
  await expect(page.getByText("你的發射判定：Miss")).toBeVisible();
  await expect(page.getByRole("button", { name: "返回教學房間", exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "返回教學房間", exact: true })).toBeVisible({ timeout: 20_000 });
  await expect(cinema).toHaveAttribute("data-elapsed-ms", "10000");
  await page.getByRole("button", { name: "返回教學房間", exact: true }).click();
  await next.click();
  await page.getByRole("button", { name: "完成教學", exact: true }).click();
  await expect(page.getByRole("heading", { name: "實驗室", exact: true })).toBeVisible();
  expect(await page.evaluate(key => localStorage.getItem(key), draftKey)).toBe(before);
  expect(officialWrites).toEqual([]);
  expect(officialCommands).toEqual([]);
  expect(errors).toEqual([]);
});

test("invalid visible input blocks experiments instead of testing a stale valid value", async ({ page }) => {
  await page.goto("designer");
  await page.getByRole("button", { name: "實驗室", exact: true }).click();
  await page.getByLabel("我的預測", { exact: true }).fill("我預測較大的板會有不同結果。");
  const input = page.getByRole("spinbutton", { name: "直徑（mm）", exact: true });
  await input.fill("");
  await expect(input).toHaveAttribute("aria-invalid", "true");
  await expect(page.getByRole("button", { name: "測試此版本", exact: true })).toBeDisabled();
  await expect(page.getByRole("button", { name: "帶回設計室", exact: true })).toBeDisabled();
  await input.fill("42");
  await expect(page.getByRole("button", { name: "測試此版本", exact: true })).toBeEnabled();
});

test("unknown notebook data is preserved and does not silently overwrite student records", async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem("steam-top:learning:notebook:v1", '{"version":99,"original":"keep"}'));
  await page.goto("designer");
  await page.getByRole("button", { name: "實驗室", exact: true }).click();
  await expect(page.getByText(/舊紀錄未能讀取/)).toBeVisible();
  await page.getByRole("button", { name: "複製此版本", exact: true }).click();
  expect(await page.evaluate(() => localStorage.getItem("steam-top:learning:notebook:v1"))).toBe('{"version":99,"original":"keep"}');
});

test("cancelled worker cannot add a late record, retry works and CSV preserves observations safely", async ({ page }) => {
  await page.goto("designer");
  await page.getByRole("button", { name: "實驗室", exact: true }).click();
  await page.getByLabel("我的預測", { exact: true }).fill("=學生自己提出的預測");
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const workerAsset = /simulation\.worker.*\.js/;
  await page.route(workerAsset, async route => { await gate; await route.continue().catch(() => undefined); });
  await page.getByRole("button", { name: "測試此版本", exact: true }).click();
  await page.getByRole("button", { name: "取消測試", exact: true }).click();
  release(); await page.unroute(workerAsset);
  await expect(page.getByRole("region", { name: "實驗紀錄" }).locator("details")).toHaveCount(0);
  await page.getByRole("button", { name: "測試此版本", exact: true }).click();
  await expect(page.getByRole("region", { name: "實驗紀錄" }).locator("details")).toHaveCount(1);
  await page.getByLabel("我的觀察", { exact: true }).fill("+我觀察到多次碰撞");
  await page.getByLabel("下次想測甚麼", { exact: true }).fill("@只改一個參數");
  const downloaded = page.waitForEvent("download");
  await page.getByRole("button", { name: "匯出實驗 CSV", exact: true }).click();
  const download = await downloaded;
  const csv = await readFile((await download.path())!, "utf8");
  expect(csv).toContain("'=學生"); expect(csv).toContain("'+我觀察"); expect(csv).toContain("'@只改");
});

for (const viewport of [{ width: 390, height: 844 }, { width: 1024, height: 768 }, { width: 1440, height: 900 }]) {
  test(`skip/restart and independent experiment persistence at ${viewport.width}px`, async ({ page }) => {
    await page.setViewportSize(viewport);
    await page.goto("designer");
    await page.getByRole("button", { name: "稍後再試", exact: true }).click();
    await page.getByRole("button", { name: "實驗室", exact: true }).click();
    await page.getByRole("button", { name: "複製此版本", exact: true }).click();
    await page.getByRole("spinbutton", { name: "直徑（mm）", exact: true }).fill("42");
    await page.getByRole("button", { name: "重開操作教學", exact: true }).click();
    await page.getByRole("spinbutton", { name: "直徑（mm）", exact: true }).fill("45");
    await page.getByRole("button", { name: "跳過教學", exact: true }).click();
    await page.getByLabel("編輯版本", { exact: true }).selectOption("B");
    await expect(page.getByRole("spinbutton", { name: "直徑（mm）", exact: true })).toHaveValue("42");
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await page.reload();
    await page.getByRole("button", { name: "實驗室", exact: true }).click();
    await page.getByLabel("編輯版本", { exact: true }).selectOption("B");
    await expect(page.getByRole("spinbutton", { name: "直徑（mm）", exact: true })).toHaveValue("42");
  });
}
