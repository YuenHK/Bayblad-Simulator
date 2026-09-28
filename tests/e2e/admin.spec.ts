import { expect, test, type Page } from "@playwright/test";
const password = "admin";
async function login(page: Page) {
  await page.goto(".");
  await expect(page.getByRole("heading", { name: "教師控制台" })).toBeVisible();
  await page.getByLabel("口令").fill(password);
  await page.getByRole("button", { name: "進入控制台" }).press("Enter");
  await expect(page.getByRole("tab", { name: "總覽" })).toBeVisible();
}
async function confirmAction(page: Page) {
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("button", { name: "繼續" }).click();
  await dialog.getByRole("button", { name: /^確定/u }).click();
  await expect(page.getByRole("dialog")).toBeHidden();
}
test("共用入口、四區預覽、房間確認、篩選及匯出", async ({ page }, testInfo) => {
  await login(page);
  expect(page.url()).not.toContain("passphrase=");
  expect(await page.evaluate(() => JSON.stringify(localStorage))).not.toContain(
    password,
  );
  await expect(page.getByText("2 間房間")).toBeVisible();
  await page.getByRole("tab",{name:"學生排行榜"}).click();
  await expect(page.getByRole("img",{name:"歷史陀螺靜態 3D"})).toBeVisible();
  await page.getByRole("tab",{name:"高分設計"}).click();
  const highDesigns = page.getByRole("region", { name: "歷史紀錄中的高分設計" });
  await expect(highDesigns.getByText("表現 1／物理 2")).toBeVisible();
  await expect(highDesigns.getByText("1 場／1 次")).toBeVisible();
  await expect(highDesigns.getByText(/不代表最佳解或因果/)).toBeVisible();
  await expect(highDesigns.getByRole("img", { name: "歷史陀螺靜態 3D" })).toBeVisible();
  await highDesigns.locator("summary").click();
  await expect(highDesigns.getByRole("img", { name: "自定造型輪廓" })).toHaveCount(3);
  await expect(highDesigns.getByRole("img", { name: "自定造型輪廓" }).first()).toBeVisible();
  await highDesigns.screenshot({ path: testInfo.outputPath("high-scoring-designs.png") });
  await page.getByRole("tab",{name:"總覽"}).click();
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
  await page.getByRole("tab",{name:"對戰紀錄"}).click();
  await expect(page.getByRole("img",{name:"歷史陀螺靜態 3D"})).toBeVisible();
  await page.getByText("篩選條件",{exact:true}).click();
  await page.getByLabel("班別").fill("2B");
  await expect(page.getByText("此頁沒有紀錄。")).toBeVisible();

  await page.getByLabel("班別").fill("1A");
  await expect(page.getByText("iPad-01")).toBeVisible();
  await expect(page.getByRole("button",{name:"刪除紀錄"})).toHaveCount(0);
  await page.getByRole("button", { name: "登出" }).click();
  await expect(page.getByRole("heading", { name: "教師控制台" })).toBeVisible();
  await page.getByLabel("口令").fill(password);
  await page.getByRole("button", { name: "進入控制台" }).click();
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
    const opener = page.getByRole("button", {name:"暫停平台"});
    await opener.click();
    await expect(page.getByRole("dialog")).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(opener).toBeFocused();
    // With no rooms, pause is the final focusable control in this section.
    await page.keyboard.press("Shift+Tab");
    await expect(page.getByRole("tab", {name:"高分設計"})).toBeFocused();
  });
});

for (const width of [1440, 390]) {
  test(`四個頁籤及靜態設計在 ${width}px 可讀`, async ({page}, testInfo) => {
    await page.setViewportSize({width,height:900});
    await login(page);
    for (const name of ["總覽","對戰紀錄","學生排行榜","高分設計"]) {
      await page.getByRole("tab",{name}).click();
      await expect(page.getByRole("tabpanel",{name})).toBeVisible();
      if(name!=="總覽") {
        await page.locator(".admin-design-preview").first().scrollIntoViewIfNeeded();
        await expect(page.getByRole("img",{name:"歷史陀螺靜態 3D"}).first()).toBeVisible();
      }
      expect(await page.evaluate(()=>document.documentElement.scrollWidth<=document.documentElement.clientWidth)).toBe(true);
      await page.screenshot({path:testInfo.outputPath(`${width}-${name}.png`),fullPage:true});
    }
  });
}
