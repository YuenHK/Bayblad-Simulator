export type SafeStorage = Readonly<{ get(key: string): string | null; set(key: string, value: string): void; remove(key: string): void }>;

export function createSafeStorage(storage?: Pick<Storage, "getItem" | "setItem" | "removeItem"> | null): SafeStorage {
  const memory = new Map<string, string>();
  return {
    get(key) { try { const value = storage?.getItem(key) ?? null; if (value !== null) memory.set(key, value); return value ?? memory.get(key) ?? null; } catch { return memory.get(key) ?? null; } },
    set(key, value) { memory.set(key, value); try { storage?.setItem(key, value); } catch { /* memory fallback */ } },
    remove(key) { memory.delete(key); try { storage?.removeItem(key); } catch { /* memory fallback */ } },
  };
}
