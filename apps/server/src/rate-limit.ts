export class TokenBucketLimiter {
  readonly #burst: number;
  readonly #refillPerMs: number;
  readonly #now: () => number;
  readonly #maxBuckets: number;
  readonly #ttlMs: number;
  readonly #buckets = new Map<string, { tokens: number; updatedAt: number; lastSeenAt: number }>();
  #nextCapacityPruneAt = Number.NEGATIVE_INFINITY;

  constructor(options: Readonly<{
    burst: number;
    refillPerSecond: number;
    maxBuckets?: number;
    ttlMs?: number;
    now?: () => number;
  }>) {
    this.#burst = options.burst;
    this.#refillPerMs = options.refillPerSecond / 1_000;
    this.#now = options.now ?? Date.now;
    this.#maxBuckets = options.maxBuckets ?? 10_000;
    this.#ttlMs = options.ttlMs ?? 120_000;
  }

  consume(key: string): boolean {
    const now = this.#now();
    let bucket = this.#buckets.get(key);
    if (!bucket) {
      if (this.#buckets.size >= this.#maxBuckets && now >= this.#nextCapacityPruneAt) this.pruneExpired();
      if (this.#buckets.size >= this.#maxBuckets) return false;
      bucket = { tokens: this.#burst, updatedAt: now, lastSeenAt: now };
    }
    bucket.tokens = Math.min(this.#burst, bucket.tokens + Math.max(0, now - bucket.updatedAt) * this.#refillPerMs);
    bucket.updatedAt = now;
    bucket.lastSeenAt = now;
    this.#buckets.delete(key);
    this.#buckets.set(key, bucket);
    if (bucket.tokens < 1) return false;
    bucket.tokens -= 1;
    return true;
  }

  pruneExpired(): number {
    const now = this.#now();
    const cutoff = now - this.#ttlMs;
    this.#nextCapacityPruneAt = now + Math.min(this.#ttlMs, 1_000);
    let removed = 0;
    for (const [key, bucket] of this.#buckets) {
      if (bucket.lastSeenAt < cutoff) { this.#buckets.delete(key); removed += 1; }
    }
    return removed;
  }

  delete(key: string): boolean { return this.#buckets.delete(key); }

  clear(): void { this.#buckets.clear(); }

  get size(): number { return this.#buckets.size; }
}
