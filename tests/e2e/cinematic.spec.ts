import { expect, test } from "@playwright/test";
import { makeDefaultDesign } from "../../packages/domain/src/index";

test("two guests play custom versus basic full-length rounds and can rematch", async ({ page, browser }, testInfo) => {
  test.setTimeout(350_000);
  test.skip(process.env.CINEMATIC_BATTLES !== "1", "Requires full-length playback");
  const baseURL = testInfo.project.use.baseURL;
  if (!baseURL) throw new Error("Missing student test URL");
  const context = await browser.newContext({ baseURL, viewport: { width: 1024, height: 768 } });
  const peer = await context.newPage();
  const errors: string[] = [];
  const design = makeDefaultDesign();
  const vertices = [{ x: -18, y: -16 }, { x: 22, y: -16 }, { x: 22, y: 8 }, { x: 12, y: 8 }, { x: 12, y: 20 }, { x: -18, y: 20 }];
  design.layers[0] = { ...design.layers[0], shape: "custom", diameterMm: 2 * Math.max(...vertices.map(p => Math.hypot(p.x, p.y))), outline: { version: 1, vertices, mirror: "none" } };
  await page.addInitScript(design => localStorage.setItem("steam-top:designer-draft:v1", JSON.stringify({ version: 1, design })), design);
  try {
    for (const player of [page, peer]) {
      player.on("pageerror", error => errors.push(error.message));
      await player.addInitScript(() => {
        const observations: { phase: string; elapsed: number }[] = [];
        Object.assign(window, { fullRoundObservations: observations });
        new MutationObserver(() => {
          const arena = document.querySelector('[data-testid="battle-arena-3d"]');
          if (!arena) return;
          const phase = arena.getAttribute("data-phase") ?? "";
          if (observations.at(-1)?.phase !== phase) observations.push({ phase, elapsed: Number(arena.parentElement?.getAttribute("data-elapsed-ms")) });
        }).observe(document, { subtree: true, attributes: true, childList: true });
      });
      await player.goto(".");
      await expect(player.getByText("已連線", { exact: true })).toBeVisible();
      await player.getByRole("button", { name: "用此設計參戰" }).click();
    }
    await page.getByRole("button", { name: "建立房間", exact: true }).click();
    const codeText = await page.locator(".room-heading .eyebrow").textContent();
    const code = codeText!.replace("房間碼", "").trim();
    await peer.getByLabel("房間碼").fill(code);
    await peer.getByLabel("進入身份").selectOption("player");
    await peer.getByRole("button", { name: "以房間碼進入" }).click();
    await expect(peer.locator(".room-heading .eyebrow")).toHaveText(codeText!);
    const started = Date.now();
    await Promise.all([page, peer].map(player => player.getByRole("button", { name: /設計準備/ }).click()));
    // Neither guest taps: both must launch at minimum force without hanging.
    for (const player of [page, peer]) {
      await expect(player.getByText("你的判定：Miss", { exact: true })).toBeVisible({ timeout: 15_000 });
      await expect(player.getByTestId("battle-arena-3d").locator("canvas")).toBeVisible();
    }
    await Promise.all([page, peer].map(player => expect(player.getByRole("heading", { name: "對戰結果" })).toBeVisible({ timeout: 240_000 })));
    expect(Date.now() - started).toBeGreaterThanOrEqual(60_000);
    for (const player of [page, peer]) {
      const observations = await player.evaluate(() => (window as unknown as { fullRoundObservations: { phase: string; elapsed: number }[] }).fullRoundObservations);
      const results = observations.filter(entry => entry.phase === "result");
      expect(results.length).toBeGreaterThanOrEqual(2);
      expect(results.every(entry => entry.elapsed === 30000)).toBe(true);
      expect(observations.filter(entry => entry.phase === "summon").length).toBe(results.length);
      expect(observations.filter(entry => entry.phase === "strike").length).toBe(results.length);
      await player.getByRole("button", { name: "返回房間", exact: true }).click();
      await expect(player.locator(".room-heading .eyebrow")).toHaveText(codeText!);
    }
    await Promise.all([page, peer].map(player => player.getByRole("button", { name: /設計準備/ }).click()));
    for (const player of [page, peer]) await expect(player.getByRole("button", { name: "在判定線發射", exact: true })).toBeVisible();
    expect(errors).toEqual([]);
  } finally { await context.close(); }
});

for (const shape of ["basic", "custom"] as const) test(`${shape} computer battle plays full 30 second 3D rounds and returns to same room for rematch`, async ({ page }, testInfo) => {
  test.setTimeout(350_000);
  test.skip(process.env.CINEMATIC_BATTLES !== "1", "Run with CINEMATIC_BATTLES=1 for full-length playback");
  const errors: string[] = [];
  if (shape === "custom") {
    const design = makeDefaultDesign();
    const vertices = [{ x: -18, y: -16 }, { x: 22, y: -16 }, { x: 22, y: 8 }, { x: 12, y: 8 }, { x: 12, y: 20 }, { x: -18, y: 20 }];
    design.layers[0] = { ...design.layers[0], shape: "custom", diameterMm: 2 * Math.max(...vertices.map(p => Math.hypot(p.x, p.y))), outline: { version: 1, vertices, mirror: "none" } };
    await page.addInitScript(design => localStorage.setItem("steam-top:designer-draft:v1", JSON.stringify({ version: 1, design })), design);
  }
  // Record transitions inside the page: software WebGL can delay test-driver
  // round trips beyond the short three-second finisher window.
  await page.addInitScript(() => {
    const observations: { phase: string; shattered: string; elapsed: number }[] = [];
    Object.assign(window, { cinematicObservations: observations });
    new MutationObserver(() => {
      const arena = document.querySelector('[data-testid="battle-arena-3d"]');
      if (!arena) return;
      const entry = { phase: arena.getAttribute("data-phase") ?? "", shattered: arena.getAttribute("data-shattered") ?? "none", elapsed: Number(arena.parentElement?.getAttribute("data-elapsed-ms")) };
      const previous = observations.at(-1);
      if (!previous || previous.phase !== entry.phase || previous.shattered !== entry.shattered) observations.push(entry);
    }).observe(document, { subtree: true, attributes: true, childList: true });
  });
  page.on("pageerror", error => errors.push(error.message));
  await page.goto(".");
  await expect(page.getByText("已連線", { exact: true })).toBeVisible({ timeout: 90_000 });
  if (shape === "custom") await expect(page.locator(".layer-list")).toContainText("自定造型");
  await page.getByRole("button", { name: "對戰大廳", exact: true }).click();
  await page.getByLabel("房間名稱").fill("30秒生肖驗收");
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
    expect(Date.now()-began+initialElapsed).toBeGreaterThan(23_000);
    await expect(page.locator(".cinema-skill strong")).toBeVisible();
    if (round === 0) await page.screenshot({ path: testInfo.outputPath("summon.png") });
    await expect.poll(() => page.evaluate(() => (window as unknown as { cinematicObservations: {phase:string}[] }).cinematicObservations.filter((entry,index,entries) => entry.phase === "strike" && entries[index-1]?.phase !== "strike").length), { timeout: 10_000 }).toBe(round + 1);
    if (round === 0) await page.screenshot({ path: testInfo.outputPath("strike.png") });
    await expect.poll(()=>arena.getAttribute("data-shattered"),{timeout:7000}).toMatch(/^player[12]$/);
    if (round === 0) await page.screenshot({ path: testInfo.outputPath("shatter.png") });
    await expect(arena).toHaveAttribute("data-phase", "result", { timeout: 10_000 });
    expect(Date.now()-began+initialElapsed).toBeGreaterThan(29_000);
    if (round === 0) await page.screenshot({ path: testInfo.outputPath("result.png") });
    const finished = page.getByRole("heading", { name: "對戰結果" });
    await expect.poll(async () => await finished.isVisible() || !(await arena.isVisible()), { timeout: 15_000 }).toBe(true);
    if (await finished.isVisible()) break;
  }
  await expect(page.getByRole("heading", { name: "對戰結果" })).toBeVisible();
  const observed = await page.evaluate(() => (window as unknown as { cinematicObservations: {phase:string;elapsed:number}[] }).cinematicObservations);
  for (const entry of observed) {
    if (entry.phase === "summon") expect(entry.elapsed).toBeGreaterThanOrEqual(24000);
    if (entry.phase === "strike") expect(entry.elapsed).toBeGreaterThanOrEqual(27000);
    if (entry.phase === "result") expect(entry.elapsed).toBe(30000);
  }
  await page.getByRole("button", { name: "返回房間", exact: true }).click();
  await expect(page.locator(".room-heading .eyebrow")).toHaveText(code!);
  await expect(page.getByRole("heading", { name: "電腦玩家", exact: true })).toBeVisible();
  await page.getByRole("button", { name: /以已選設計準備|上載當前設計並準備/ }).click();
  await expect(page.getByRole("button", { name: "在判定線發射", exact: true })).toBeVisible();
  expect(errors).toEqual([]);
});
