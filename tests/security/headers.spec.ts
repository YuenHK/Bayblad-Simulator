import { expect, test } from "@playwright/test";

test("redirects HTTP to HTTPS", async ({ request }) => {
  const httpOrigin = process.env.SECURITY_HTTP_ORIGIN;
  test.skip(!httpOrigin, "requires a running production Compose stack");
  const response = await request.get(httpOrigin!, { maxRedirects: 0 });
  expect([301, 308]).toContain(response.status());
  expect(response.headers().location).toMatch(/^https:\/\//);
});

test("serves strict security headers without exposing the server", async ({ request }) => {
  const origin = process.env.SECURITY_HTTPS_ORIGIN;
  test.skip(!origin, "requires a running production Compose stack");
  const response = await request.get(origin!);
  expect(response.ok()).toBe(true);
  const headers = response.headers();
  expect(headers["strict-transport-security"]).toContain("max-age=31536000");
  expect(headers["content-security-policy"]).toContain("default-src 'self'");
  expect(headers["content-security-policy"]).toContain("connect-src 'self' https: wss:");
  expect(headers["content-security-policy"]).toContain("frame-ancestors 'none'");
  expect(headers["content-security-policy"]).not.toContain("unsafe-eval");
  expect(headers["x-content-type-options"]).toBe("nosniff");
  expect(headers["referrer-policy"]).toBe("no-referrer");
  expect(headers.server).toBeUndefined();
});

test("keeps API and Socket.IO available through HTTPS", async ({ request }) => {
  const origin = process.env.SECURITY_HTTPS_ORIGIN;
  test.skip(!origin, "requires a running production Compose stack");
  const identity = await request.get(`${origin}/api/identity`);
  expect(identity.status()).toBe(200);
  const socket = await request.get(`${origin}/socket.io/?EIO=4&transport=polling`);
  expect(socket.status()).toBe(200);
  expect(await socket.text()).toContain("sid");
});

test("rejects an oversized API request at the public edge", async ({ request }) => {
  const origin = process.env.SECURITY_HTTPS_ORIGIN;
  test.skip(!origin, "requires a running production Compose stack");
  const response = await request.post(`${origin}/api/designs`, {
    data: "x".repeat(3 * 1_000_000 + 1),
    headers: { "content-type": "application/octet-stream" },
  });
  expect(response.status()).toBe(413);
  expect(response.headers().server).toBeUndefined();
});
