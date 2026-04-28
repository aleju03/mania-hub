import { createFileRoute } from "@tanstack/react-router";

const AVATAR_TTL_MS = 6 * 60 * 60 * 1000;
const CACHE_MAX_ENTRIES = 256;
const AVATAR_FETCH_TIMEOUT_MS = 10_000;

type AvatarEntry = {
  buffer: Buffer;
  contentType: string;
  expiresAt: number;
  lastAccessedAt: number;
};

const avatarCache = new Map<number, AvatarEntry>();

function pruneCache(now = Date.now()) {
  for (const [id, entry] of avatarCache.entries()) {
    if (entry.expiresAt <= now) avatarCache.delete(id);
  }
  if (avatarCache.size <= CACHE_MAX_ENTRIES) return;
  const excess = [...avatarCache.entries()]
    .sort(([, a], [, b]) => a.lastAccessedAt - b.lastAccessedAt)
    .slice(0, avatarCache.size - CACHE_MAX_ENTRIES);
  for (const [id] of excess) avatarCache.delete(id);
}

async function fetchAvatar(userId: number): Promise<AvatarEntry> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), AVATAR_FETCH_TIMEOUT_MS);
  const response = await fetch(`https://a.ppy.sh/${userId}`, {
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

async function getAvatar(userId: number): Promise<AvatarEntry> {
  pruneCache();
  const cached = avatarCache.get(userId);
  if (cached && cached.expiresAt > Date.now()) {
    cached.lastAccessedAt = Date.now();
    return cached;
  }
  const fresh = await fetchAvatar(userId);
  avatarCache.set(userId, fresh);
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
        try {
          const entry = await getAvatar(userId);
          return new Response(entry.buffer as unknown as BodyInit, {
            status: 200,
            headers: {
              "Content-Type": entry.contentType,
              "Content-Length": String(entry.buffer.length),
              "Cache-Control": "public, max-age=3600, s-maxage=21600, stale-while-revalidate=86400",
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
