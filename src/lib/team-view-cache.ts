interface Entry<T> {
  promise: Promise<T>;
  value?: T;
  bytes: number;
  expiresAt: number;
  timer?: ReturnType<typeof setTimeout>;
}

/** Public team tab data only. One budget covers scores, skills and calendars. */
export class TeamViewCache {
  private entries = new Map<string, Entry<unknown>>();
  private bytes = 0;
  constructor(private readonly ttlMs = 120_000, private readonly maxEntries = 16, private readonly maxBytes = 8 * 1024 * 1024) {}

  peek<T>(key: string): T | undefined {
    const entry = this.entries.get(key);
    if (!entry || !entry.expiresAt) return undefined;
    if (entry.expiresAt <= Date.now()) { this.drop(key); return undefined; }
    return entry.value as T;
  }

  get<T>(key: string, produce: () => Promise<T>): Promise<T> {
    this.peek(key);
    const cached = this.entries.get(key);
    if (cached) return cached.promise as Promise<T>;
    for (const [oldKey, entry] of this.entries) {
      if (this.entries.size < this.maxEntries) break;
      if (entry.expiresAt) this.drop(oldKey);
    }
    if (this.entries.size >= this.maxEntries) return Promise.reject(new Error("Team reads are busy"));
    const entry: Entry<T> = { promise: Promise.resolve().then(produce), bytes: 0, expiresAt: 0 };
    this.entries.set(key, entry);
    entry.promise = entry.promise.then((value) => {
      entry.value = value;
      entry.bytes = (JSON.stringify(value)?.length ?? 0) * 6;
      entry.expiresAt = Date.now() + this.ttlMs;
      this.bytes += entry.bytes;
      for (const [oldKey, oldEntry] of this.entries) {
        if (this.bytes <= this.maxBytes) break;
        if (oldEntry.expiresAt) this.drop(oldKey);
      }
      if (this.entries.get(key) === entry) entry.timer = setTimeout(() => this.drop(key), this.ttlMs);
      return value;
    }, (error) => { this.drop(key); throw error; });
    return entry.promise;
  }

  private drop(key: string): void {
    const entry = this.entries.get(key);
    if (!entry) return;
    this.bytes -= entry.bytes;
    if (entry.timer) clearTimeout(entry.timer);
    this.entries.delete(key);
  }
}

const cache = new TeamViewCache();
export function peekTeamView<T>(key: string): T | undefined {
  return typeof window === "undefined" ? undefined : cache.peek<T>(key);
}
export function loadTeamView<T>(key: string, produce: () => Promise<T>): Promise<T> {
  return typeof window === "undefined" ? produce() : cache.get(key, produce);
}
