import { expect, test } from "@playwright/test";

test("computer battle plays full 60 second 3D rounds and returns to same room for rematch", async ({ page }, testInfo) => {
  test.setTimeout(350_000);
  test.skip(process.env.CINEMATIC_BATTLES !== "1", "Run with CINEMATIC_BATTLES=1 for full-length playback");
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.goto(".");
  await expect(page.getByText("已連線", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "對戰大廳", exact: true }).click();
  await page.getByLabel("房間名稱").fill("60秒生肖驗收");
  await page.getByRole("button", { name: "建立房間", exact: true }).click();
  const code = await page.locator(".room-heading .eyebrow").textContent();
  await page.getByRole("button", { name: "加入電腦玩家", exact: true }).click();
  await expect(page.getByRole("heading", { name: "電腦玩家", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "上載當前設計並準備", exact: true }).click();
  for (let round = 0; round < 4; round++) {
    // Intentionally do not tap: deadline must launch at the minimum force.
    await expect(page.getByText("你的判定：Miss", { exact: true })).toBeVisible({ timeout: 15_000 });
    const arena = page.getByTestId("battle-arena-3d");
    await expect(arena).toHaveAttribute("data-phase", "battle");
    await expect(arena.locator("canvas")).toBeVisible();
    const began = Date.now();
    const initialElapsed = Number(await page.getByTestId("cinematic-battle").getAttribute("data-elapsed-ms"));
    await expect(arena).toBeInViewport({ ratio: .5 });
    if (round === 0) await page.screenshot({ path: testInfo.outputPath("battle.png") });
    await expect(arena).toHaveAttribute("data-phase", "summon", { timeout: 55_000 });
    expect(Date.now()-began+initialElapsed).toBeGreaterThan(47_000);
    await expect(page.locator(".cinema-skill strong")).toBeVisible();
    if (round === 0) await page.screenshot({ path: testInfo.outputPath("summon.png") });
    await expect(arena).toHaveAttribute("data-phase", "strike", { timeout: 10_000 });
    if (round === 0) await page.screenshot({ path: testInfo.outputPath("strike.png") });
    await expect(arena).toHaveAttribute("data-phase", "result", { timeout: 10_000 });
    expect(Date.now()-began+initialElapsed).toBeGreaterThan(59_000);
    const finished = page.getByRole("heading", { name: "對戰結果" });
    await expect.poll(async () => await finished.isVisible() || !(await arena.isVisible()), { timeout: 15_000 }).toBe(true);
    if (await finished.isVisible()) break;
  }
  await expect(page.getByRole("heading", { name: "對戰結果" })).toBeVisible();
  await page.getByRole("button", { name: "返回房間", exact: true }).click();
  await expect(page.locator(".room-heading .eyebrow")).toHaveText(code!);
  await expect(page.getByRole("heading", { name: "電腦玩家", exact: true })).toBeVisible();
  await page.getByRole("button", { name: /以已選設計準備|上載當前設計並準備/ }).click();
  await expect(page.getByRole("button", { name: "在判定線發射", exact: true })).toBeVisible();
  expect(errors).toEqual([]);
});
