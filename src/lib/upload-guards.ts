// Shared request guards for the upload endpoints (catbox images, .osr
// replays): a per-instance fixed-window rate limiter and a body reader that
// enforces a byte cap both on the declared Content-Length (before reading
// anything) and while streaming (when the header is missing or dishonest).
// Per-instance limits stop one account from hammering an endpoint; the
// multi-instance total is bounded by the edge/WAF rules tracked in
// findings/README.md.

interface RateWindow {
  windowStart: number;
  count: number;
}

export interface FixedWindowLimiter {
  isRateLimited(key: string, limit: number, now?: number): boolean;
}

export function createFixedWindowLimiter(windowMs: number): FixedWindowLimiter {
  const windows = new Map<string, RateWindow>();
  return {
    isRateLimited(key: string, limit: number, now = Date.now()): boolean {
      const window = windows.get(key);
      if (!window || now - window.windowStart >= windowMs) {
        if (windows.size > 1000) {
          for (const [staleKey, stale] of windows) {
            if (now - stale.windowStart >= windowMs) windows.delete(staleKey);
          }
        }
        windows.set(key, { windowStart: now, count: 1 });
        return false;
      }
      window.count += 1;
      return window.count > limit;
    },
  };
}

/** Reads a web Request body into a Buffer, aborting past `cap` (null = over cap). */
export async function readCappedBody(body: Request, cap: number): Promise<Buffer | null> {
  const declared = Number(body.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > cap) return null;
  const reader = body.body?.getReader();
  if (!reader) {
    const buffer = Buffer.from(await body.arrayBuffer());
    return buffer.length > cap ? null : buffer;
  }
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) {
      total += value.length;
      if (total > cap) {
        await reader.cancel().catch(() => {});
        return null;
      }
      chunks.push(value);
    }
  }
  return Buffer.concat(chunks);
}
