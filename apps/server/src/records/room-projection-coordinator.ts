import type { ClaimedRoomProjection, RoomProjectionInput, RoomProjectionStore } from "./room-projection-store";

export type RoomProjectionOperation = () => Promise<void>;

type Entry = { revision: number; attempt: number; operation: RoomProjectionOperation; timer: ReturnType<typeof setTimeout> | null; running: boolean };

/** Bounded, last-revision-wins projection queue. Battle state never waits on this read-model writer. */
export class RoomProjectionCoordinator {
  readonly #entries = new Map<string, Entry>();
  readonly #maxEntries: number;
  readonly #report: (error: unknown) => void;
  readonly #store: RoomProjectionStore | null;
  readonly #apply: ((job: ClaimedRoomProjection) => Promise<void>) | null;
  readonly #runningClaims = new Set<Promise<void>>();
  readonly #pendingEnqueues = new Set<Promise<"created" | "updated" | "stale">>();
  readonly #retainedEnqueues = new Map<string, { input: RoomProjectionInput; attempt: number; timer: ReturnType<typeof setTimeout> | null }>();
  #closed = false;
  constructor(options: Readonly<{ maxEntries?: number; report?: (error: unknown) => void; store?: RoomProjectionStore; apply?: (job: ClaimedRoomProjection) => Promise<void> }> = {}) {
    this.#maxEntries = options.maxEntries ?? 2_000; this.#report = options.report ?? (() => undefined);
    this.#store = options.store ?? null;
    this.#apply = options.apply ?? null;
    if ((this.#store === null) !== (this.#apply === null)) throw new TypeError("room projection store and apply must be provided together");
  }
  async pump(now = new Date(), limit = 25): Promise<void> {
    if (this.#closed || !this.#store || !this.#apply) return;
    const claims = await this.#store.claimDue(limit, now);
    const operations = claims.map((claim) => {
      const operation = this.#apply!(claim)
        .then(async () => { await this.#store!.complete(claim); })
        .catch(async (error) => { this.#report(error); await this.#store!.fail(claim, "ROOM_PROJECTION_FAILED", now); })
        .finally(() => this.#runningClaims.delete(operation));
      this.#runningClaims.add(operation);
      return operation;
    });
    await Promise.all(operations);
  }
  enqueue(key: string, revision: number, operation: RoomProjectionOperation): void {
    if (this.#closed) return;
    const current = this.#entries.get(key);
    if (current && current.revision > revision) return;
    if (!current && this.#entries.size >= this.#maxEntries) {
      throw new Error("ROOM_PROJECTION_CAPACITY");
    }
    const next: Entry = { revision, attempt: current?.revision === revision ? current.attempt : 0, operation, timer: null, running: current?.running ?? false };
    if (current?.timer) clearTimeout(current.timer);
    this.#entries.set(key, next);
    if (!next.running) void this.#run(key, next);
  }
  async enqueueProjection(input: RoomProjectionInput): Promise<"created" | "updated" | "stale"> {
    if (this.#closed || !this.#store) throw new Error("ROOM_PROJECTION_COORDINATOR_CLOSED");
    const operation = this.#store.enqueue(input).then((result) => { this.#clearRetained(input.roomId, input.revision); return result; }).catch((error) => { this.#retain(input); throw error; }).finally(() => this.#pendingEnqueues.delete(operation));
    this.#pendingEnqueues.add(operation);
    return operation;
  }
  #clearRetained(roomId: string, revision: number): void {
    const current = this.#retainedEnqueues.get(roomId);
    if (!current || current.input.revision > revision) return;
    if (current.timer) clearTimeout(current.timer);
    this.#retainedEnqueues.delete(roomId);
  }
  #retain(input: RoomProjectionInput): void {
    if (this.#closed) return;
    const current = this.#retainedEnqueues.get(input.roomId);
    if (current && current.input.revision > input.revision) return;
    if (current?.timer) clearTimeout(current.timer);
    const entry = { input: structuredClone(input), attempt: current?.attempt ?? 0, timer: null as ReturnType<typeof setTimeout> | null };
    this.#retainedEnqueues.set(input.roomId, entry);
    const delay = Math.min(300_000, 1_000 * 2 ** Math.min(8, entry.attempt));
    entry.timer = setTimeout(() => { entry.timer = null; entry.attempt += 1; void this.enqueueProjection(entry.input).catch(this.#report); }, delay);
    entry.timer.unref();
  }
  get usesDurableStore(): boolean { return this.#store !== null; }
  async #run(key: string, entry: Entry): Promise<void> {
    if (this.#closed || this.#entries.get(key) !== entry) return;
    entry.running = true;
    try { await entry.operation(); if (this.#entries.get(key) === entry) this.#entries.delete(key); }
    catch (error) {
      this.#report(error); entry.running = false; entry.attempt += 1;
      if (entry.attempt < 10 && !this.#closed && this.#entries.get(key) === entry) {
        const delay = Math.min(300_000, 1_000 * (2 ** (entry.attempt - 1)));
        entry.timer = setTimeout(() => { entry.timer = null; void this.#run(key, entry); }, delay); entry.timer.unref();
      }
    }
    const latest = this.#entries.get(key);
    if (latest && latest !== entry && latest.running) { latest.running = false; void this.#run(key, latest); }
  }
  async close(): Promise<void> {
    for (const entry of this.#entries.values()) if (entry.timer) clearTimeout(entry.timer);
    this.#entries.clear();
    for (const entry of this.#retainedEnqueues.values()) if (entry.timer) clearTimeout(entry.timer);
    await Promise.allSettled([...this.#pendingEnqueues, ...this.#runningClaims]);
    this.#closed = true;
    if (this.#store) await Promise.allSettled([...this.#retainedEnqueues.values()].map(({ input }) => this.#store!.enqueue(input)));
    this.#retainedEnqueues.clear();
  }
  get size(): number { return this.#entries.size; }
}
