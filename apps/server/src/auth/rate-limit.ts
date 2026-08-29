export class AdminLoginLimiter {
  readonly #accounts = new Map<string, { count: number; lockedUntil: number }>();
  readonly #clients = new Map<string, { count: number; lockedUntil: number }>();
  constructor(readonly maxFailures = 5, readonly lockMs = 15 * 60_000) {}
  isLocked(account: string, client: string, now: number): boolean {
    return (this.#accounts.get(account)?.lockedUntil ?? 0) > now || (this.#clients.get(client)?.lockedUntil ?? 0) > now;
  }
  fail(account: string, client: string, now: number): void {
    const bump = (map: Map<string, { count: number; lockedUntil: number }>, key: string, threshold: number) => { const prior = map.get(key); const count = (prior?.lockedUntil ?? 0) <= now ? (prior?.count ?? 0) + 1 : prior!.count; map.set(key, { count, lockedUntil: count >= threshold ? now + this.lockMs : 0 }); };
    bump(this.#accounts, account, this.maxFailures);
    bump(this.#clients, client, this.maxFailures * 4);
  }
  success(account: string, client: string): void { this.#accounts.delete(account); this.#clients.delete(client); }
}
