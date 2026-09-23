import { Readable } from "node:stream";
import { readCappedStream } from "./safe-image-fetch";
import { TEAM_IMAGE_PATH_PATTERN } from "./team-image";

type TeamImage = { buffer: Buffer; contentType: string };

// The CDN retains immutable images; the origin only needs a small working set.
export class TeamImageCache {
  private entries = new Map<string, TeamImage & { expiresAt: number }>();
  private pending = new Map<string, Promise<TeamImage>>();
  private bytes = 0;
  private active = 0;
  private waiting: Array<() => void> = [];

  constructor(private readonly limits = {
    bytes: 16 * 1024 * 1024,
    entries: 128,
    imageBytes: 8_000_000,
    concurrent: 4,
    ttlMs: 60 * 60_000,
    timeoutMs: 10_000,
  }) {}

  get(path: string): Promise<TeamImage> {
    if (!TEAM_IMAGE_PATH_PATTERN.test(path)) return Promise.reject(new Error("Invalid team image path"));
    this.trim();
    const hit = this.entries.get(path);
    if (hit) {
      this.entries.delete(path);
      this.entries.set(path, hit);
      return Promise.resolve(hit);
    }
    const pending = this.pending.get(path);
    if (pending) return pending;
    if (this.pending.size >= this.limits.concurrent * 4) return Promise.reject(new TeamImageBusyError());
    const request = this.fetchWithSlot(path).finally(() => this.pending.delete(path));
    this.pending.set(path, request);
    return request;
  }

  private async fetchWithSlot(path: string): Promise<TeamImage> {
    if (this.active >= this.limits.concurrent) await new Promise<void>((resolve) => this.waiting.push(resolve));
    else this.active++;
    try {
      return await this.fetch(path);
    } finally {
      // Transfer the slot directly so a new request cannot overtake a waiter.
      const next = this.waiting.shift();
      if (next) next();
      else this.active--;
    }
  }

  private async fetch(path: string): Promise<TeamImage> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.limits.timeoutMs);
    try {
      const response = await fetch(`https://assets.ppy.sh/${path}`, {
        headers: { "User-Agent": "mania-hub-team-image" },
        redirect: "error",
        signal: controller.signal,
      });
      if (!response.ok || !response.body) {
        await response.body?.cancel();
        throw new Error(`Team image fetch ${response.status}`);
      }
      const stream = Readable.fromWeb(response.body as Parameters<typeof Readable.fromWeb>[0], { signal: controller.signal });
      const buffer = await readCappedStream(stream, this.limits.imageBytes, response.headers.get("content-length"));
      if (!buffer) throw new Error("Team image too large");
      const entry = { buffer, contentType: response.headers.get("content-type") || "image/png", expiresAt: Date.now() + this.limits.ttlMs };
      if (buffer.length <= this.limits.bytes) {
        this.entries.set(path, entry);
        this.bytes += buffer.length;
        this.trim();
      }
      return entry;
    } finally {
      clearTimeout(timeout);
    }
  }

  private trim(): void {
    for (const [key, entry] of this.entries) {
      if (entry.expiresAt <= Date.now()) this.drop(key);
    }
    for (const key of this.entries.keys()) {
      if (this.bytes <= this.limits.bytes && this.entries.size <= this.limits.entries) break;
      this.drop(key);
    }
  }

  private drop(key: string): void {
    this.bytes -= this.entries.get(key)?.buffer.length ?? 0;
    this.entries.delete(key);
  }
}

export class TeamImageBusyError extends Error {
  constructor() { super("Team image proxy is busy"); }
}

export const teamImages = new TeamImageCache();
