export type MemoryCacheLookup<T> = { hit: true; value: T } | { hit: false };

interface CacheOptions {
  maxEntries: number;
  maxBytes: number;
  maxEntryBytes: number;
  maxAgeMs?: number;
}

interface CacheEntry {
  value: unknown;
  expiresAt: number;
  bytes: number;
}

// Estimate retained JSON data without allocating another serialized replay.
// Strings are charged as UTF-16 even when V8 can keep them as one-byte strings.
// Shared references within a value count once; separate entries are charged
// independently. This is a conservative admission budget, not a heap profiler.
export function estimateResponseBytes(value: unknown, limit: number): number {
  const seen = new Set<object>();
  let bytes = 0;
  let visited = 0;
  const visit = (item: unknown, depth: number): void => {
    if (bytes > limit) return;
    if (depth > 64 || ++visited > 100_000) {
      bytes = Infinity;
      return;
    }
    if (typeof item === "string") {
      bytes += 24 + item.length * 2;
    } else if (["function", "symbol", "bigint"].includes(typeof item)) {
      bytes = Infinity;
    } else if (item === null || typeof item !== "object") {
      bytes += 16;
    } else if (!seen.has(item)) {
      seen.add(item);
      bytes += 64;
      if (item instanceof ArrayBuffer) {
        bytes += item.byteLength;
      } else if (ArrayBuffer.isView(item)) {
        visit(item.buffer, depth + 1);
      } else if (item instanceof Date) {
        bytes += 8;
      } else if (Array.isArray(item)) {
        bytes += item.length * 8;
        for (const child of item) {
          visit(child, depth + 1);
          if (bytes > limit) break;
        }
      } else if (Object.getPrototypeOf(item) === Object.prototype || Object.getPrototypeOf(item) === null) {
        for (const key of Object.keys(item)) {
          bytes += 24 + key.length * 2;
          visit((item as Record<string, unknown>)[key], depth + 1);
          if (bytes > limit) break;
        }
      } else {
        // An opaque instance can retain data this estimate cannot inspect.
        bytes = Infinity;
      }
    }
  };
  try {
    visit(value, 0);
  } catch {
    return Infinity;
  }
  return bytes;
}

export class ResponseMemoryCache {
  private readonly entries = new Map<string, CacheEntry>();
  private bytes = 0;
  private hits = 0;
  private misses = 0;
  private evictions = 0;
  private rejected = 0;

  constructor(private readonly options: CacheOptions) {}

  get<T>(key: string, now = Date.now()): MemoryCacheLookup<T> {
    const entry = this.entries.get(key);
    if (!entry || entry.expiresAt <= now) {
      if (entry) this.delete(key);
      this.misses++;
      return { hit: false };
    }
    this.entries.delete(key);
    this.entries.set(key, entry);
    this.hits++;
    return { hit: true, value: entry.value as T };
  }

  set(key: string, value: unknown, ttlMs: number, now = Date.now()): void {
    this.delete(key);
    this.prune(now);
    const age = Math.min(ttlMs, this.options.maxAgeMs ?? Infinity);
    if (!(age > 0) || !Number.isFinite(age)) return;
    const bytes = 64 + key.length * 2 + estimateResponseBytes(value, this.options.maxEntryBytes);
    if (bytes > Math.min(this.options.maxEntryBytes, this.options.maxBytes)) {
      this.rejected++;
      return;
    }
    this.entries.set(key, { value, expiresAt: now + age, bytes });
    this.bytes += bytes;
    while (this.entries.size > this.options.maxEntries || this.bytes > this.options.maxBytes) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      this.delete(oldest);
      this.evictions++;
    }
  }

  delete(key: string): void {
    const entry = this.entries.get(key);
    if (!entry) return;
    this.bytes -= entry.bytes;
    this.entries.delete(key);
  }

  prune(now = Date.now()): void {
    for (const [key, entry] of this.entries) {
      if (entry.expiresAt <= now) this.delete(key);
    }
  }

  clear(): void {
    this.entries.clear();
    this.bytes = 0;
  }

  stats() {
    return {
      entries: this.entries.size,
      estimatedBytes: this.bytes,
      maxBytes: this.options.maxBytes,
      hits: this.hits,
      misses: this.misses,
      evictions: this.evictions,
      rejected: this.rejected,
    };
  }
}
