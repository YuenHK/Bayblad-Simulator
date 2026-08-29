export class AdminLoginLimiter {
  readonly #accounts = new Map<string, { count: number; lockedUntil: number; touchedAt: number }>();
  readonly #clients = new Map<string, { count: number; lockedUntil: number; touchedAt: number }>();
  constructor(readonly maxFailures = 5, readonly lockMs = 15 * 60_000, readonly maxEntries = 10_000) {}
  #prune(now: number): void { for (const map of [this.#accounts, this.#clients]) { for (const [key, value] of map) if (value.touchedAt + this.lockMs <= now) map.delete(key); while (map.size >= this.maxEntries) map.delete(map.keys().next().value!); } }
  isLocked(account: string, client: string, now: number): boolean {
    return (this.#accounts.get(account)?.lockedUntil ?? 0) > now || (this.#clients.get(client)?.lockedUntil ?? 0) > now;
  }
  reserve(account: string, client: string, now: number): boolean { if (this.isLocked(account, client, now)) return false; this.fail(account, client, now); return true; }
  fail(account: string, client: string, now: number): void {
    this.#prune(now);
    const bump = (map: Map<string, { count: number; lockedUntil: number; touchedAt: number }>, key: string, threshold: number) => { const prior = map.get(key); const count = (prior?.lockedUntil ?? 0) <= now ? (prior?.count ?? 0) + 1 : prior!.count; map.set(key, { count, lockedUntil: count >= threshold ? now + this.lockMs : 0, touchedAt: now }); };
    bump(this.#accounts, account, this.maxFailures);
    bump(this.#clients, client, this.maxFailures * 4);
  }
  success(account: string, client: string): void { this.#accounts.delete(account); this.#clients.delete(client); }
}
