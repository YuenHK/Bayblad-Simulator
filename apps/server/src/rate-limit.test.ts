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
    limiter.pruneExpired();
    expect(limiter.size).toBe(1);
  });

  it("bounds thousands of unique active keys without evicting an active key to reset it", () => {
    let now = 0;
    const limiter = new TokenBucketLimiter({ burst: 2, refillPerSecond: 1, maxBuckets: 100, ttlMs: 1_000, now: () => now });
    expect(limiter.consume("protected")).toBe(true);
    expect(limiter.consume("protected")).toBe(true);
    for (let index = 0; index < 5_000; index += 1) limiter.consume(`key-${index}`);
    expect(limiter.size).toBe(100);
    expect(limiter.consume("protected")).toBe(false);
    expect(limiter.consume("new-at-capacity")).toBe(false);
    now = 1_001;
    expect(limiter.consume("new-after-ttl")).toBe(true);
    expect(limiter.size).toBe(1);
    expect(limiter.delete("new-after-ttl")).toBe(true);
    expect(limiter.size).toBe(0);
  });

  it("shares one burst across 500 simulated sockets using the same session key", () => {
    const limiter = new TokenBucketLimiter({ burst: 30, refillPerSecond: 10, maxBuckets: 100 });
    const results = Array.from({ length: 500 }, () => limiter.consume("one-session"));
    expect(results.filter(Boolean)).toHaveLength(30);
    expect(limiter.size).toBe(1);
  });
});
