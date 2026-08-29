import { expect, test } from "@playwright/test";
import { io } from "socket.io-client";

const httpOrigin = process.env.SECURITY_HTTP_ORIGIN;
const httpsOrigin = process.env.SECURITY_HTTPS_ORIGIN;
const allowSkip = process.env.SECURITY_ALLOW_SKIP === "1";

test.skip((!httpOrigin || !httpsOrigin) && allowSkip, "explicit local skip: production Compose/TLS stack is not running");

test.beforeAll(() => {
  if ((!httpOrigin || !httpsOrigin) && !allowSkip) {
    throw new Error("SECURITY_HTTP_ORIGIN and SECURITY_HTTPS_ORIGIN are required; use SECURITY_ALLOW_SKIP=1 only for an explicit local skip");
  }
});

function expectedCsp(origin: string): string {
  const host = new URL(origin).host;
  return `default-src 'self'; base-uri 'self'; object-src 'none'; frame-ancestors 'none'; form-action 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; connect-src 'self' wss://${host}; worker-src 'self' blob:; manifest-src 'self'; media-src 'self'`;
}

test("redirects HTTP to HTTPS", async ({ request }) => {
  test.skip(!httpOrigin, "requires a running production Compose stack");
  const response = await request.get(httpOrigin!, { maxRedirects: 0 });
  expect([301, 308]).toContain(response.status());
  expect(response.headers().location).toMatch(/^https:\/\//);
});

test("serves strict security headers without exposing the server", async ({ request }) => {
  test.skip(!httpsOrigin, "requires a running production Compose stack");
  const response = await request.get(httpsOrigin!);
  expect(response.ok()).toBe(true);
  const headers = response.headers();
  expect(headers["strict-transport-security"]).toContain("max-age=31536000");
  expect(headers["content-security-policy"]).toBe(expectedCsp(httpsOrigin!));
  expect(headers["content-security-policy"]).not.toContain("unsafe-eval");
  expect(headers["x-content-type-options"]).toBe("nosniff");
  expect(headers["referrer-policy"]).toBe("no-referrer");
  expect(headers.server).toBeUndefined();
});

test("keeps API and Socket.IO available through HTTPS", async ({ request }) => {
  test.skip(!httpsOrigin, "requires a running production Compose stack");
  const identity = await request.get(`${httpsOrigin}/api/identity`);
  expect(identity.status()).toBe(200);
  const cookie = identity.headers()["set-cookie"]?.split(";", 1)[0];
  expect(cookie).toBeTruthy();
  const pollingOpen = await request.get(`${httpsOrigin}/socket.io/?EIO=4&transport=polling`);
  expect(pollingOpen.status()).toBe(200);
  const openingPacket = await pollingOpen.text();
  const sid = JSON.parse(openingPacket.slice(1)) as { sid: string };
  const pollingPost = await request.post(`${httpsOrigin}/socket.io/?EIO=4&transport=polling&sid=${encodeURIComponent(sid.sid)}`, {
    data: "40",
    headers: { "content-type": "text/plain;charset=UTF-8" },
  });
  expect(pollingPost.status()).toBe(200);
  const transport = await new Promise<string>((resolve, reject) => {
    const socket = io(httpsOrigin!, {
      transports: ["websocket"],
      forceNew: true,
      reconnection: false,
      timeout: 10_000,
      extraHeaders: { cookie: cookie!, origin: httpsOrigin! },
    });
    const timer = setTimeout(() => { socket.close(); reject(new Error("WEBSOCKET_CONNECT_TIMEOUT")); }, 12_000);
    socket.once("connect", () => { clearTimeout(timer); const name = socket.io.engine.transport.name; socket.close(); resolve(name); });
    socket.once("connect_error", (error) => { clearTimeout(timer); socket.close(); reject(error); });
  });
  expect(transport).toBe("websocket");
});

test("rejects an oversized API request at the public edge", async ({ request }) => {
  test.skip(!httpsOrigin, "requires a running production Compose stack");
  const response = await request.post(`${httpsOrigin}/socket.io/?EIO=4&transport=polling&sid=oversized`, {
    data: "x".repeat(128 * 1_024 + 1),
    headers: { "content-type": "application/octet-stream" },
  });
  expect(response.status()).toBe(413);
  expect(response.headers().server).toBeUndefined();
});

test("loads the app and real 3D view without CSP violations", async ({ page }) => {
  test.skip(!httpsOrigin, "requires a running production Compose stack");
  const violations: string[] = [];
  page.on("console", (message) => { if (/content security policy|refused to/iu.test(message.text())) violations.push(message.text()); });
  page.on("pageerror", (error) => { if (/content security policy|refused to/iu.test(error.message)) violations.push(error.message); });
  await page.goto(httpsOrigin!);
  await page.getByRole("tab", { name: "3D 預覽" }).click();
  await expect(page.locator(".preview-stage canvas")).toBeVisible();
  expect(violations).toEqual([]);
});
