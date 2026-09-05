export class ReadCacheBusyError extends Error {}

interface Entry<T> { expiresAt: number; pending: boolean; promise: Promise<T> }

/** Bounded cache that retains in-flight entries until they settle. */
export class ReadCache<T> {
  private entries = new Map<string, Entry<T>>();
  constructor(private readonly ttlMs: number, private readonly maxEntries: number) {}

  get(key: string, produce: () => Promise<T>): Promise<T> {
    const now = Date.now();
    const cached = this.entries.get(key);
    if (cached && (cached.pending || now < cached.expiresAt)) return cached.promise;
    this.entries.delete(key);
    for (const [entryKey, entry] of this.entries) {
      if (!entry.pending && (now >= entry.expiresAt || this.entries.size >= this.maxEntries)) this.entries.delete(entryKey);
    }
    // Do not evict pending work and accidentally duplicate it on a later hit.
    if (this.entries.size >= this.maxEntries) return Promise.reject(new ReadCacheBusyError("Read cache is busy"));
    const entry: Entry<T> = { expiresAt: 0, pending: true, promise: Promise.resolve().then(produce) };
    this.entries.set(key, entry);
    entry.promise.then(() => {
      entry.pending = false;
      entry.expiresAt = Date.now() + this.ttlMs;
    }, () => {
      if (this.entries.get(key) === entry) this.entries.delete(key);
    });
    return entry.promise;
  }
}
