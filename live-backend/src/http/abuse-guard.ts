import type { IncomingMessage } from "node:http";
import type { Config } from "../config.js";

export type AbuseBucket =
  | "publicApi"
  | "publicCostly"
  | "countryActivate"
  | "countryActivateGlobal"
  | "countryActivateNew"
  | "danEstimate"
  | "sseConnect"
  | "replayVideo";

export type RateLimitResult =
  | { allowed: true }
  | {
    allowed: false;
    bucket: AbuseBucket;
    limit: number;
    retryAfterMs: number;
  };

type WindowState = {
  count: number;
  resetAt: number;
};

type SseOpenResult =
  | { allowed: true; release: () => void; ip: string }
  | {
    allowed: false;
    bucket: "sseConnect";
    limit: number;
    retryAfterMs: number;
  };

export class AbuseGuard {
  private readonly windows = new Map<string, WindowState>();
  private readonly sseByIp = new Map<string, number>();
  private sseTotal = 0;
  private checksSincePrune = 0;

  check(req: IncomingMessage, config: Config, bucket: AbuseBucket, suffix = ""): RateLimitResult {
    return this.checkKey(`${bucket}:ip:${clientIp(req, config)}:${suffix}`, config, bucket);
  }

  checkGlobal(config: Config, bucket: AbuseBucket, suffix = ""): RateLimitResult {
    return this.checkKey(`${bucket}:global:${suffix}`, config, bucket);
  }

  openSse(req: IncomingMessage, config: Config): SseOpenResult {
    const attempt = this.check(req, config, "sseConnect");
    if (!attempt.allowed) return { ...attempt, bucket: "sseConnect" };

    const ip = clientIp(req, config);
    const perIpLimit = Math.max(1, config.sseMaxConnectionsPerIp ?? 6);
    const totalLimit = Math.max(1, config.sseMaxConnectionsTotal ?? 500);
    const currentIp = this.sseByIp.get(ip) ?? 0;
    if (currentIp >= perIpLimit) {
      return { allowed: false, bucket: "sseConnect", limit: perIpLimit, retryAfterMs: 15_000 };
    }
    if (this.sseTotal >= totalLimit) {
      return { allowed: false, bucket: "sseConnect", limit: totalLimit, retryAfterMs: 15_000 };
    }

    this.sseByIp.set(ip, currentIp + 1);
    this.sseTotal += 1;
    let released = false;
    return {
      allowed: true,
      ip,
      release: () => {
        if (released) return;
        released = true;
        const nextIp = Math.max(0, (this.sseByIp.get(ip) ?? 1) - 1);
        if (nextIp === 0) this.sseByIp.delete(ip);
        else this.sseByIp.set(ip, nextIp);
        this.sseTotal = Math.max(0, this.sseTotal - 1);
      },
    };
  }

  state() {
    return {
      windows: this.windows.size,
      sseTotal: this.sseTotal,
      sseIps: this.sseByIp.size,
    };
  }

  private checkKey(key: string, config: Config, bucket: AbuseBucket): RateLimitResult {
    const now = Date.now();
    const limit = limitForBucket(config, bucket);
    const windowMs = windowMsForBucket(bucket);
    this.prune(now);
    const existing = this.windows.get(key);
    if (!existing || existing.resetAt <= now) {
      this.windows.set(key, { count: 1, resetAt: now + windowMs });
      return { allowed: true };
    }
    if (existing.count >= limit) {
      return { allowed: false, bucket, limit, retryAfterMs: Math.max(1, existing.resetAt - now) };
    }
    existing.count += 1;
    return { allowed: true };
  }

  private prune(now: number): void {
    this.checksSincePrune += 1;
    if (this.checksSincePrune < 128 && this.windows.size < 10_000) return;
    this.checksSincePrune = 0;
    for (const [key, state] of this.windows) {
      if (state.resetAt <= now) this.windows.delete(key);
    }
  }
}

export function clientIp(req: IncomingMessage, config: Pick<Config, "trustProxyHeaders">): string {
  if (config.trustProxyHeaders) {
    const forwarded = headerValue(req.headers["cf-connecting-ip"])
      ?? headerValue(req.headers["x-real-ip"])
      ?? firstForwardedFor(req.headers["x-forwarded-for"]);
    if (forwarded) return forwarded;
  }
  const socketIp = (req.socket as { remoteAddress?: string } | undefined)?.remoteAddress;
  return normalizeIp(socketIp) ?? "unknown";
}

export function normalizeCountryParam(country: string | null | undefined): string | null {
  const normalized = country?.trim().toUpperCase() ?? "";
  if (normalized === "GLOBAL") return normalized;
  return /^[A-Z]{2}$/.test(normalized) ? normalized : null;
}

function limitForBucket(config: Config, bucket: AbuseBucket): number {
  switch (bucket) {
    case "publicApi":
      return Math.max(1, config.publicApiRatePerMinute ?? 120);
    case "publicCostly":
      return Math.max(1, config.publicCostlyRatePerMinute ?? 30);
    case "countryActivate":
      return Math.max(1, config.countryActivateRatePerMinute ?? 10);
    case "countryActivateGlobal":
      return Math.max(1, config.countryActivateGlobalRatePerMinute ?? 120);
    case "countryActivateNew":
      return Math.max(1, config.countryActivateNewPerHour ?? 12);
    case "danEstimate":
      return Math.max(1, config.danEstimateRatePerMinute ?? 20);
    case "sseConnect":
      return Math.max(1, config.sseConnectRatePerMinute ?? 30);
    case "replayVideo":
      return Math.max(1, config.replayVideoRatePerMinute ?? 2);
  }
}

function windowMsForBucket(bucket: AbuseBucket): number {
  return bucket === "countryActivateNew" ? 60 * 60_000 : 60_000;
}

function firstForwardedFor(value: string | string[] | undefined): string | null {
  const raw = headerValue(value);
  if (!raw) return null;
  return normalizeIp(raw.split(",")[0]);
}

function headerValue(value: string | string[] | undefined): string | null {
  const raw = Array.isArray(value) ? value[0] : value;
  return normalizeIp(raw);
}

function normalizeIp(value: string | undefined): string | null {
  const trimmed = value?.trim();
  if (!trimmed) return null;
  return trimmed.startsWith("::ffff:") ? trimmed.slice(7) : trimmed;
}
