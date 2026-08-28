export class TokenBucketLimiter {
  readonly #burst: number;
  readonly #refillPerMs: number;
  readonly #now: () => number;
  readonly #buckets = new Map<string, { tokens: number; updatedAt: number; lastSeenAt: number }>();

  constructor(options: Readonly<{ burst: number; refillPerSecond: number; now?: () => number }>) {
    this.#burst = options.burst;
    this.#refillPerMs = options.refillPerSecond / 1_000;
    this.#now = options.now ?? Date.now;
  }

  consume(key: string): boolean {
    const now = this.#now();
    const bucket = this.#buckets.get(key) ?? { tokens: this.#burst, updatedAt: now, lastSeenAt: now };
    bucket.tokens = Math.min(this.#burst, bucket.tokens + Math.max(0, now - bucket.updatedAt) * this.#refillPerMs);
    bucket.updatedAt = now;
    bucket.lastSeenAt = now;
    this.#buckets.set(key, bucket);
    if (bucket.tokens < 1) return false;
    bucket.tokens -= 1;
    return true;
  }

  pruneOlderThan(ageMs: number): void {
    const cutoff = this.#now() - ageMs;
    for (const [key, bucket] of this.#buckets) if (bucket.lastSeenAt < cutoff) this.#buckets.delete(key);
  }

  get size(): number { return this.#buckets.size; }
}
