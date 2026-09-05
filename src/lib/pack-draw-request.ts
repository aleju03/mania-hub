/* Only an explicit write-pressure refusal is safe to repeat: it happens
   before payment. A lost response or a 5xx may follow a successful spend. */
export async function fetchPackDrawWithRetry(url: string, init: RequestInit): Promise<Response> {
  for (let attempt = 0; ; attempt += 1) {
    const response = await fetch(url, init);
    if (response.status !== 429 || attempt >= 3) return response;
    const body = await response.clone().json().catch(() => null) as
      | { bucket?: unknown; retryAfterMs?: unknown }
      | null;
    if (body?.bucket !== "write_pressure") return response;
    const header = response.headers.get("retry-after");
    const seconds = header == null ? NaN : Number(header);
    const headerMs = Number.isFinite(seconds)
      ? seconds * 1000
      : header == null ? 0 : Date.parse(header) - Date.now();
    const bodyMs = typeof body.retryAfterMs === "number" ? body.retryAfterMs : 0;
    const waitMs = Math.max(1_000, headerMs || 0, bodyMs);
    if (!Number.isFinite(waitMs) || waitMs > 5_000) return response;
    await new Promise((resolve) => setTimeout(resolve, waitMs));
  }
}
