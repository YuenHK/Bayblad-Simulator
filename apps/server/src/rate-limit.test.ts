import { describe, expect, it } from "vitest";
import { TokenBucketLimiter } from "./rate-limit";

describe("TokenBucketLimiter", () => {
  it("allows a school NAT burst of 600, blocks the next token, and refills", () => {
    let now = 0;
    const limiter = new TokenBucketLimiter({ burst: 600, refillPerSecond: 10, now: () => now });
    expect(Array.from({ length: 600 }, () => limiter.consume("school-nat")).every(Boolean)).toBe(true);
    expect(limiter.consume("school-nat")).toBe(false);
    expect(limiter.consume("other-school")).toBe(true);
    now = 100;
    expect(limiter.consume("school-nat")).toBe(true);
  });

  it("prunes inactive client keys", () => {
    let now = 0;
    const limiter = new TokenBucketLimiter({ burst: 1, refillPerSecond: 1, now: () => now });
    limiter.consume("old");
    now = 121_000;
    limiter.consume("current");
    limiter.pruneOlderThan(120_000);
    expect(limiter.size).toBe(1);
  });
});
