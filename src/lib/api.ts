// Server-only: OAuth token management + fetch wrapper for osu! API v2

let tokenCache: { access_token: string; expires_at: number } | null = null;

// Simple response cache (5 min TTL)
const responseCache = new Map<string, { data: unknown; expires: number }>();
const CACHE_TTL = 5 * 60 * 1000;

export function getCached<T>(key: string): T | null {
  const entry = responseCache.get(key);
  if (entry && Date.now() < entry.expires) return entry.data as T;
  if (entry) responseCache.delete(key);
  return null;
}

export function setCache(key: string, data: unknown): void {
  responseCache.set(key, { data, expires: Date.now() + CACHE_TTL });
}

async function getToken(): Promise<string> {
  if (tokenCache && Date.now() < tokenCache.expires_at - 60_000) {
    return tokenCache.access_token;
  }

  const res = await fetch("https://osu.ppy.sh/oauth/token", {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({
      client_id: Number(process.env.OSU_CLIENT_ID),
      client_secret: process.env.OSU_CLIENT_SECRET,
      grant_type: "client_credentials",
      scope: "public",
    }),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`OAuth token request failed (${res.status}): ${text}`);
  }

  const data = await res.json();
  tokenCache = {
    access_token: data.access_token,
    expires_at: Date.now() + data.expires_in * 1000,
  };
  return tokenCache.access_token;
}

export async function osuFetch<T = unknown>(
  path: string,
  params?: Record<string, string | number | undefined>,
): Promise<T> {
  const token = await getToken();

  const url = new URL(`https://osu.ppy.sh/api/v2${path}`);
  if (params) {
    for (const [k, v] of Object.entries(params)) {
      if (v !== undefined) url.searchParams.set(k, String(v));
    }
  }

  const res = await fetch(url.toString(), {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/json",
      "Content-Type": "application/json",
    },
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`osu! API error ${res.status} on ${path}: ${text}`);
  }

  return res.json() as Promise<T>;
}

export async function osuFetchBinary(path: string): Promise<ArrayBuffer> {
  const token = await getToken();
  const res = await fetch(`https://osu.ppy.sh/api/v2${path}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) {
    throw new Error(`osu! API binary error ${res.status} on ${path}`);
  }
  return res.arrayBuffer();
}

export async function fetchBeatmapFile(beatmapId: number): Promise<string> {
  const res = await fetch(`https://osu.ppy.sh/osu/${beatmapId}`);
  if (!res.ok) {
    throw new Error(`Failed to fetch .osu file for beatmap ${beatmapId}`);
  }
  return res.text();
}
