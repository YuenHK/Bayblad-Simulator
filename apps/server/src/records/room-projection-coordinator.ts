export type RoomProjectionOperation = () => Promise<void>;

type Entry = { revision: number; attempt: number; operation: RoomProjectionOperation; timer: ReturnType<typeof setTimeout> | null; running: boolean };

/** Bounded, last-revision-wins projection queue. Battle state never waits on this read-model writer. */
export class RoomProjectionCoordinator {
  readonly #entries = new Map<string, Entry>();
  readonly #maxEntries: number;
  readonly #report: (error: unknown) => void;
  #closed = false;
  constructor(options: Readonly<{ maxEntries?: number; report?: (error: unknown) => void }> = {}) {
    this.#maxEntries = options.maxEntries ?? 2_000; this.#report = options.report ?? (() => undefined);
  }
  enqueue(key: string, revision: number, operation: RoomProjectionOperation): void {
    if (this.#closed) return;
    const current = this.#entries.get(key);
    if (current && current.revision > revision) return;
    if (!current && this.#entries.size >= this.#maxEntries) {
      const oldest = this.#entries.keys().next().value as string | undefined;
      if (oldest) { const evicted = this.#entries.get(oldest); if (evicted?.timer) clearTimeout(evicted.timer); this.#entries.delete(oldest); }
    }
    const next: Entry = { revision, attempt: current?.revision === revision ? current.attempt : 0, operation, timer: null, running: current?.running ?? false };
    if (current?.timer) clearTimeout(current.timer);
    this.#entries.set(key, next);
    if (!next.running) void this.#run(key, next);
  }
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
  close(): void { this.#closed = true; for (const entry of this.#entries.values()) if (entry.timer) clearTimeout(entry.timer); this.#entries.clear(); }
  get size(): number { return this.#entries.size; }
}
