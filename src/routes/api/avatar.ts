import { createFileRoute } from "@tanstack/react-router";

const AVATAR_TTL_MS = 10 * 60 * 1000;
const CACHE_MAX_ENTRIES = 256;
const AVATAR_FETCH_TIMEOUT_MS = 10_000;
const AVATAR_VERSION_PATTERN = /^[A-Za-z0-9._~-]{1,128}$/;

type AvatarEntry = {
  buffer: Buffer;
  contentType: string;
  expiresAt: number;
  lastAccessedAt: number;
};

const avatarCache = new Map<string, AvatarEntry>();

function getAvatarCacheKey(userId: number, version: string | null): string {
  return version ? `${userId}:${version}` : String(userId);
}

function normalizeAvatarVersion(value: string | null): string | null {
  if (!value) return null;
  return AVATAR_VERSION_PATTERN.test(value) ? value : null;
}

function pruneCache(now = Date.now()) {
  for (const [key, entry] of avatarCache.entries()) {
    if (entry.expiresAt <= now) avatarCache.delete(key);
  }
  if (avatarCache.size <= CACHE_MAX_ENTRIES) return;
  const excess = [...avatarCache.entries()]
    .sort(([, a], [, b]) => a.lastAccessedAt - b.lastAccessedAt)
    .slice(0, avatarCache.size - CACHE_MAX_ENTRIES);
  for (const [key] of excess) avatarCache.delete(key);
}

async function fetchAvatar(userId: number, version: string | null): Promise<AvatarEntry> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), AVATAR_FETCH_TIMEOUT_MS);
  const response = await fetch(`https://a.ppy.sh/${userId}${version ? `?${version}` : ""}`, {
    redirect: "follow",
    headers: { "User-Agent": "mania-hub-avatar" },
    signal: controller.signal,
  }).finally(() => {
    clearTimeout(timeout);
  });
  if (!response.ok) {
    throw new Error(`avatar fetch ${response.status}`);
  }
  const buffer = Buffer.from(await response.arrayBuffer());
  const contentType = response.headers.get("content-type") || "image/png";
  return {
    buffer,
    contentType,
    expiresAt: Date.now() + AVATAR_TTL_MS,
    lastAccessedAt: Date.now(),
  };
}

async function getAvatar(userId: number, version: string | null): Promise<AvatarEntry> {
  pruneCache();
  const cacheKey = getAvatarCacheKey(userId, version);
  const cached = avatarCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) {
    cached.lastAccessedAt = Date.now();
    return cached;
  }
  const fresh = await fetchAvatar(userId, version);
  avatarCache.set(cacheKey, fresh);
  return fresh;
}

export const Route = createFileRoute("/api/avatar")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const url = new URL(request.url);
        const raw = url.searchParams.get("u");
        const userId = Number(raw);
        if (!raw || !Number.isFinite(userId) || userId <= 0 || !Number.isInteger(userId)) {
          return new Response("invalid user id", { status: 400 });
        }
        const version = normalizeAvatarVersion(url.searchParams.get("v"));
        try {
          const entry = await getAvatar(userId, version);
          return new Response(entry.buffer as unknown as BodyInit, {
            status: 200,
            headers: {
              "Content-Type": entry.contentType,
              "Content-Length": String(entry.buffer.length),
              "Cache-Control": "public, max-age=60, s-maxage=600, stale-while-revalidate=3600",
              "Access-Control-Allow-Origin": "*",
            },
          });
        } catch (err) {
          const message = err instanceof Error ? err.message : "avatar proxy failed";
          return new Response(message, { status: 502 });
        }
      },
    },
  },
});
