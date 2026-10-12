import { expect, test, type Browser, type BrowserContext, type Page } from "@playwright/test";
import { spawnSync } from "node:child_process";

const adminUrl = "https://bayblad-simulator-api.onrender.com/admin/";
const adminPassword = process.env.PUBLIC_ADMIN_ACCEPTANCE === "1" ? "admin" : "";

async function waitConnected(page: Page) {
  await expect(page.getByText("已連線", { exact: true })).toBeVisible({ timeout: 30_000 });
}

type RoundTiming = { roundId: string; startsAtMs: number; durationMs: number };
type PhaseObservation = { round: number; phase: string; elapsed: number; observedAt: number; roundStartAt: number; victory: boolean; victoryVisible: boolean; resultHeading: boolean; skill: string };
async function openIsolatedGuest(browser: Browser, timings: RoundTiming[] = []): Promise<{ context: BrowserContext; page: Page }> {
  const context = await browser.newContext({ viewport: { width: 1024, height: 768 }, hasTouch: true });
  const page = await context.newPage();
  await page.addInitScript(() => {
    const observations: PhaseObservation[] = [];
    Object.assign(window, { publicPhaseObservations: observations });
    let round = 0, previousPhase = "", roundStartAt = 0;
    new MutationObserver(() => {
      const arena = document.querySelector('[data-testid="battle-arena-3d"]');
      if (!arena) return;
      const phase = arena.getAttribute("data-phase") ?? "";
      const elapsed = Number(document.querySelector('[data-testid="cinematic-battle"]')?.getAttribute("data-elapsed-ms"));
      const observedAt = Date.now();
      if (phase === "battle" && previousPhase !== "battle") { round++; roundStartAt = observedAt - elapsed; }
      previousPhase = phase;
      if (!round) return;
      const victory = document.querySelector('[data-testid="arena-victory"]');
      const victoryBounds = victory?.getBoundingClientRect();
      const entry = { round, phase, elapsed, observedAt, roundStartAt,
        victory: Boolean(victory),
        victoryVisible: Boolean(victory && victoryBounds && victoryBounds.width > 0 && victoryBounds.height > 0 && !["hidden", "collapse"].includes(getComputedStyle(victory).visibility)),
        resultHeading: [...document.querySelectorAll("h1,h2,h3")].some(node => node.textContent === "對戰結果"),
        skill: arena.querySelector(".cinema-skill strong")?.textContent ?? "" };
      const previous = observations.at(-1);
      if (!previous || previous.round !== round || previous.phase !== phase || previous.victory !== entry.victory || previous.victoryVisible !== entry.victoryVisible || previous.resultHeading !== entry.resultHeading || previous.skill !== entry.skill) observations.push(entry);
    }).observe(document, { subtree: true, attributes: true, childList: true, characterData: true });
  });
  page.on("websocket", (socket) => socket.on("framereceived", ({ payload }) => {
    // Retain only timing metadata; never log full protocol messages or student records.
    const frame = String(payload);
    if (!frame.startsWith("42[")) return;
    try {
      const packet: unknown = JSON.parse(frame.slice(2));
      if (!Array.isArray(packet)) return;
      for (const event of packet) {
        if (event?.type === "battle.frame" && typeof event.roundId === "string" && typeof event.presentation?.startsAtMs === "number" && !timings.some(t => t.roundId === event.roundId)) timings.push({roundId:event.roundId, startsAtMs:event.presentation.startsAtMs, durationMs:event.presentation.durationMs});
      }
    } catch { /* Non-JSON transport packets carry no timing evidence. */ }
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

test("學生設計、限制、預覽及響應式操作", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => { if (message.type() === "error") errors.push(message.text()); });
  await page.goto(".");
  await waitConnected(page);
  await expect(page.locator(".student-game")).toBeVisible();
  await expect(page.getByRole("contentinfo", { name: "專案與更多作品" }).getByRole("link", { name: "教師後台" })).toHaveAttribute("href", adminUrl);
  await expect(page.getByRole("button", { name: "關閉音效" })).toBeVisible();
  await expect(page.getByRole("button", { name: "減少動態效果" })).toBeVisible();
  await page.getByRole("combobox", { name: "形狀" }).selectOption("star");
  await page.getByRole("spinbutton", { name: "角數" }).fill("7");
  await page.getByRole("spinbutton", { name: "直徑（mm）" }).fill("61");
  const narrowTools = await page.getByRole("tablist", { name: "設計室區域" }).isVisible();
  await page.getByRole("tab", { name: narrowTools ? "裝配" : "共用裝配", exact: true }).click();
  await page.getByRole("combobox", { name: "金屬碟直徑" }).selectOption("30");
  await expect(page.getByText("最大直徑為 60 mm")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "用此設計參戰" })).toBeEnabled();
  await page.getByRole("tab", { name: narrowTools ? "造型" : "層板造型", exact: true }).click();
  await page.getByRole("spinbutton", { name: "直徑（mm）" }).fill("58");
  await page.getByRole("button", { name: "將目前層下移" }).click();
  if (narrowTools) {
    await expect(page.getByRole("tablist", { name: "設計室區域" })).toBeVisible();
    await page.getByRole("tab", { name: "預覽", exact: true }).click();
  }
  await page.getByRole("tab", { name: "分解圖" }).click();
  await expect(page.getByRole("img", { name: "陀螺分解圖" })).toBeVisible();
  await page.getByRole("tab", { name: "3D 預覽" }).click();
  await expect(page.getByRole("group", { name: /3D 陀螺預覽控制/u })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
  expect(errors).toEqual([]);
});

test("老師登入、統計篩選、排行榜及 Excel 匯出", async ({ page }, testInfo) => {
  test.skip(!adminPassword, "Set PUBLIC_ADMIN_ACCEPTANCE=1 to explicitly run shared-console public acceptance");
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(adminUrl);
  await expect(page.getByRole("heading", { name: "教師控制台" })).toBeVisible();
  await expect(page.getByLabel("帳號")).toHaveCount(0);
  await page.getByLabel("口令").fill("incorrect-password");
  await page.getByRole("button", { name: "進入控制台" }).click();
  await expect(page.getByText(/口令不正確/)).toBeVisible();
  await page.getByLabel("口令").fill(adminPassword);
  await page.getByRole("button", { name: "進入控制台" }).click();
  await expect(page.getByRole("heading", { name: "教師控制台" })).toBeVisible({ timeout: 30_000 });
  await expect(page.getByRole("tab",{name:"總覽"})).toBeVisible();
  await expect(page.getByRole("button", {name:"暫停平台"})).toHaveCount(0);
  await expect(page.getByRole("button", {name:"恢復平台"})).toHaveCount(0);
  await expect(page.getByText("發射判定分佈")).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
  if (testInfo.project.name === "chromium-desktop") {
    const originalFrom = await page.getByLabel("開始日期").inputValue();
    const originalTo = await page.getByLabel("結束日期").inputValue();
    if (process.env.PUBLIC_EXPORT_EMPTY_RANGE === "1") {
      await page.getByLabel("開始日期").fill("2020-01-01");
      await page.getByLabel("結束日期").fill("2020-01-02");
    }
    const download = page.waitForEvent("download", { timeout: 20_000 });
    const exportResponse = page.waitForResponse((response) => response.url().includes("/api/admin/export.xlsx"), { timeout: 20_000 });
    await page.getByRole("button", { name: "匯出 Excel" }).click();
    const response = await exportResponse;
    expect(response.status()).toBe(200);
    const file = await download;
    expect(file.suggestedFilename()).toMatch(/\.xlsx$/u);
    const path = await file.path();
    expect(path).not.toBeNull();
    // Check the downloaded workbook archive, without logging student cell values.
    expect(spawnSync("unzip", ["-t", path!], { stdio: "ignore" }).status).toBe(0);
    const workbookXml = spawnSync("unzip", ["-p", path!, "xl/workbook.xml"], { encoding: "utf8" });
    expect(workbookXml.status).toBe(0);
    for (const name of ["對戰紀錄", "逐輪結果", "陀螺參數", "身份及裝置狀態", "使用量統計", "參數分析"]) {
      expect(workbookXml.stdout).toMatch(new RegExp(`<sheet\\b[^>]*\\bname="${name}"`));
    }
    if (process.env.PUBLIC_EXPORT_EMPTY_RANGE === "1") {
      await page.getByLabel("結束日期").fill(originalTo);
      await page.getByLabel("開始日期").fill(originalFrom);
    }
  }
  for (const section of ["對戰紀錄","學生排行榜","高分設計"]) {
    await page.getByRole("tab",{name:section}).click();
    await expect(page.getByRole("tabpanel",{name:section})).toBeVisible();
    const previews = page.locator(".admin-design-preview");
    await expect(previews.first()).toBeAttached();
    await previews.first().scrollIntoViewIfNeeded();
    await expect(page.getByRole("img",{name:"歷史陀螺靜態 3D"}).first()).toBeVisible();
  }
  await expect(page.getByRole("button",{name:"刪除紀錄"})).toHaveCount(0);
  await expect(page.getByRole("button",{name:"更改密碼"})).toHaveCount(0);
  expect(errors).toEqual([]);
  await page.getByRole("button", { name: "登出" }).click();
  await expect(page.getByRole("button", { name: "進入控制台" })).toBeVisible();
});

test("兩個獨立訪客完成同步單場 10 秒 3D 對戰、賽後計分及返回原房", async ({ browser, browserName }, testInfo) => {
  test.setTimeout(300_000);
  test.skip(browserName !== "chromium", "完整即時對戰只跑一次；其餘引擎測核心頁面與老師端");
  test.skip(testInfo.project.name !== "chromium-desktop", "兩真人時間軸在桌面 Chromium 驗收一次");
  const ownerTimings: RoundTiming[] = [], peerTimings: RoundTiming[] = [];
  const owner = await openIsolatedGuest(browser, ownerTimings);
  const peer = await openIsolatedGuest(browser, peerTimings);
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
    for (let attempt = 0; attempt < 1 && !(await resultHeading.isVisible()); attempt += 1) {
      const ownerLaunch = owner.page.getByRole("button", { name: "在判定線發射" });
      const peerLaunch = peer.page.getByRole("button", { name: "在判定線發射" });
      const ownerGrade = owner.page.getByText(/^你的判定：(Perfect|Great|Good|Miss)$/u);
      const peerGrade = peer.page.getByText(/^你的判定：(Perfect|Great|Good|Miss)$/u);
      await expect(ownerLaunch).toBeEnabled();
      await expect(peerLaunch).toBeEnabled();
      await Promise.all([ownerLaunch.focus(), peerLaunch.focus()]);
      await expect(owner.page.locator(".energy-track .zone-perfect")).toBeVisible();
      await expect(owner.page.locator(".launch-countdown")).toHaveText("發射！", { timeout: 8_000 });
      await expect(peer.page.locator(".launch-countdown")).toHaveText("發射！", { timeout: 8_000 });
      // Keyboard activation is immediate; click actionability can wait across the
      // short launch deadline when the arena auto-scroll moves the button.
      await Promise.all([owner.page.keyboard.press("Space"), peer.page.keyboard.press("Space")]);
      await expect(ownerGrade).toBeVisible();
      await expect(peerGrade).toBeVisible();
      const arenas = [owner.page,peer.page].map(page=>page.getByTestId("battle-arena-3d"));
      await Promise.all(arenas.map(async arena=>{await expect(arena.locator("canvas")).toBeVisible({timeout:30_000});await expect(arena).toHaveAttribute("data-phase","battle");}));
      if (process.env.PUBLIC_CAPTURE_ARENA === "1") await testInfo.attach(`round-${attempt+1}-battle.png`, { body: await arenas[0]!.locator("canvas").screenshot(), contentType: "image/png" });
      await expect.poll(()=>ownerTimings.length).toBe(attempt+1);
      await expect.poll(()=>peerTimings.length).toBe(attempt+1);
      const timing=ownerTimings[attempt]!;
      expect(timing.durationMs).toBe(10000);
      expect(peerTimings[attempt]).toEqual(timing);
      // Timestamp transitions inside each page. Software WebGL/trace transport
      // can delay a successful locator response by seconds, after the phase occurred.
      // Preserve the same 2500ms bounds; do not count driver round-trip latency.
      for (const phase of ["summon","strike","result"] as const) {
        const reached = await Promise.all([owner.page, peer.page].map(async page => {
          const read = () => page.evaluate(({ round, phase }) =>
            (window as unknown as { publicPhaseObservations: PhaseObservation[] }).publicPhaseObservations.find(entry => entry.round === round && entry.phase === phase && (phase !== "result" || entry.victoryVisible)), { round: attempt + 1, phase });
          await expect.poll(read, { timeout: phase === "summon" ? 52000 : 9000 }).toBeTruthy();
          return (await read())!;
        }));
        expect(Math.abs(reached[0]!.observedAt-reached[1]!.observedAt)).toBeLessThan(2500);
        const boundary=phase === "summon" ? 8000 : phase === "strike" ? 9000 : 10000;
        for (const entry of reached) {
          expect(entry.elapsed).toBeGreaterThanOrEqual(boundary);
          expect(entry.elapsed).toBeLessThan(boundary+2500);
          expect(entry.observedAt-entry.roundStartAt).toBeGreaterThanOrEqual(boundary-250);
          expect(entry.observedAt-entry.roundStartAt).toBeLessThan(boundary+2500);
        }
        if (process.env.PUBLIC_CAPTURE_ARENA === "1") await testInfo.attach(`round-${attempt+1}-${phase}.png`, { body: await arenas[0]!.locator("canvas").screenshot(), contentType: "image/png" });
        if (phase !== "result") {
          for (const entry of reached) { expect(entry.victory).toBe(false); expect(entry.resultHeading).toBe(false); expect(entry.skill).not.toBe(""); }
        } else {
          // No early completion: every played round must consume all 30 seconds.
          for (const entry of reached) { expect(entry.elapsed).toBe(10000); expect(entry.victory).toBe(true); expect(entry.victoryVisible).toBe(true); }
        }
      }
      await expect.poll(async()=>await resultHeading.isVisible() || !(await ownerGrade.isVisible()),{timeout:10000}).toBe(true);
    }
    await expect(resultHeading).toBeVisible({ timeout: 30_000 });
    await expect(owner.page.getByTestId("arena-victory")).toBeVisible();
    await expect(owner.page.getByTestId("arena-victory")).toContainText(/玩家[一二]勝出|平手/u);
    await expect(owner.page.getByText("總分：", { exact: false })).toHaveCount(2);
    await expect(owner.page.getByText("排行榜")).toHaveCount(0);
    await Promise.all([owner.page,peer.page].map(page=>page.getByRole("button",{name:"返回房間",exact:true}).click()));
    await Promise.all([owner.page,peer.page].map(async page=>{
      await expect(page.getByText(`房間碼 ${code}`,{exact:true})).toBeVisible();
      await expect(page.getByRole("heading",{name:"對戰結果"})).toHaveCount(0);
      await expect(page.getByRole("button",{name:"以已選設計準備",exact:true})).toBeEnabled();
    }));
    await owner.page.getByRole("button",{name:"以已選設計準備",exact:true}).click();
    await expect(owner.page.locator(".seat-card.is-ready")).toHaveCount(1);
    await expect(peer.page.locator(".seat-card.is-ready")).toHaveCount(1);
  } finally {
    await owner.context.close().catch(() => undefined);
    await peer.context.close().catch(() => undefined);
  }
});
