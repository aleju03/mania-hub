import { createServerFn } from "@tanstack/react-start";

import { bridgeAuthHeaders } from "./live-backend-tokens";

/* Who may see a player's own skill ratings and dans (live-backend
   features/skill-privacy.ts): everyone ("public"), only them ("private"), or
   nobody, with the rating pipeline off for them ("off"). The viewer comes from
   the login cookie, never from the browser. */

export type SkillVisibility = "public" | "private" | "off";

const SKILL_VISIBILITIES: readonly SkillVisibility[] = ["public", "private", "off"];

function backendBase(): string | null {
  return (process.env.LIVE_BACKEND_URL || process.env.VITE_LIVE_BACKEND_URL)?.trim().replace(/\/$/, "") || null;
}

async function viewerId(): Promise<number | null> {
  const { readCurrentAuth } = await import("./auth-server");
  return (await readCurrentAuth()).viewer?.id ?? null;
}

async function noStore(): Promise<void> {
  const { setResponseHeader } = await import("@tanstack/react-start/server");
  setResponseHeader("Cache-Control", "private, no-store");
}

export const getMySkillVisibility = createServerFn({ method: "GET" }).handler(
  async (): Promise<{ ok: true; visibility: SkillVisibility } | { ok: false }> => {
    await noStore();
    const id = await viewerId();
    const base = backendBase();
    if (!id || !base) return { ok: false };
    try {
      const response = await fetch(`${base}/api/session/skill-visibility?userId=${id}`, { headers: bridgeAuthHeaders() });
      const body = (await response.json().catch(() => null)) as { visibility?: SkillVisibility } | null;
      return response.ok && body?.visibility ? { ok: true, visibility: body.visibility } : { ok: false };
    } catch {
      return { ok: false };
    }
  },
);

export const setMySkillVisibility = createServerFn({ method: "POST" })
  .validator((data: { visibility?: unknown }) => ({
    visibility: SKILL_VISIBILITIES.includes(data?.visibility as SkillVisibility) ? data.visibility as SkillVisibility : "public",
  }))
  .handler(async ({ data }): Promise<{ ok: true; visibility: SkillVisibility } | { ok: false }> => {
    await noStore();
    const id = await viewerId();
    const base = backendBase();
    if (!id || !base) return { ok: false };
    try {
      const response = await fetch(`${base}/api/session/skill-visibility`, {
        method: "POST",
        headers: bridgeAuthHeaders(true),
        body: JSON.stringify({ userId: id, visibility: data.visibility }),
      });
      const body = (await response.json().catch(() => null)) as { visibility?: SkillVisibility } | null;
      return response.ok && body?.visibility ? { ok: true, visibility: body.visibility } : { ok: false };
    } catch {
      return { ok: false };
    }
  });

// The profile reads a private player's ratings come back hidden from.
const OWN_SKILL_PATH = /^\/api\/profiles\/(\d+)\/(skills|skill-history|skill-plays|unrated-plays|recent-ratings|dan-evidence)(\?[^#]*)?$/;

export function isOwnSkillPath(path: string): boolean {
  return OWN_SKILL_PATH.test(path);
}

/* A private player reading their own ratings: the public read came back
   hidden, so this repeats it through the bridge with their verified id. Only
   ever for the signed-in player's own profile. */
export const fetchOwnSkillPath = createServerFn({ method: "GET" })
  .validator((data: { path?: unknown }) => ({ path: typeof data?.path === "string" ? data.path.slice(0, 2000) : "" }))
  .handler(async ({ data }): Promise<{ ok: true; body: string } | { ok: false; status: number }> => {
    await noStore();
    const match = OWN_SKILL_PATH.exec(data.path);
    const id = await viewerId();
    const base = backendBase();
    if (!match || !id || Number(match[1]) !== id || !base) return { ok: false, status: 403 };
    const joiner = match[3] ? "&" : "?";
    try {
      const response = await fetch(`${base}${data.path}${joiner}viewerUserId=${id}`, { headers: bridgeAuthHeaders() });
      if (!response.ok) return { ok: false, status: response.status };
      // As text: the payload rides through untouched, whatever its shape.
      return { ok: true, body: await response.text() };
    } catch {
      return { ok: false, status: 502 };
    }
  });

/* The keymode the signed-in player's Skills tab opens on (live-backend
   features/skill-main-keymode.ts); null is automatic. */
export const getMySkillMainKeymode = createServerFn({ method: "GET" }).handler(
  async (): Promise<{ ok: true; keyCount: number | null } | { ok: false }> => {
    await noStore();
    const id = await viewerId();
    const base = backendBase();
    if (!id || !base) return { ok: false };
    try {
      const response = await fetch(`${base}/api/session/skill-main-keymode?userId=${id}`, { headers: bridgeAuthHeaders() });
      const body = (await response.json().catch(() => null)) as { keyCount?: number | null } | null;
      return response.ok && body && "keyCount" in body ? { ok: true, keyCount: body.keyCount ?? null } : { ok: false };
    } catch {
      return { ok: false };
    }
  },
);

export const setMySkillMainKeymode = createServerFn({ method: "POST" })
  .validator((data: { keyCount?: unknown }) => {
    const keys = Number(data?.keyCount);
    return { keyCount: data?.keyCount != null && Number.isInteger(keys) && keys >= 1 && keys <= 18 ? keys : null };
  })
  .handler(async ({ data }): Promise<{ ok: true; keyCount: number | null } | { ok: false }> => {
    await noStore();
    const id = await viewerId();
    const base = backendBase();
    if (!id || !base) return { ok: false };
    try {
      const response = await fetch(`${base}/api/session/skill-main-keymode`, {
        method: "POST",
        headers: bridgeAuthHeaders(true),
        body: JSON.stringify({ userId: id, keyCount: data.keyCount }),
      });
      const body = (await response.json().catch(() => null)) as { keyCount?: number | null } | null;
      return response.ok && body && "keyCount" in body ? { ok: true, keyCount: body.keyCount ?? null } : { ok: false };
    } catch {
      return { ok: false };
    }
  });

/* Whether the signed-in player's verified clears (dan course passes and
   practice-pack clears) count toward their dans (live-backend
   features/dan-verified-clears.ts). Turning them off rates their dans from
   their plays alone, for everyone. */
export const getMyDanVerifiedClears = createServerFn({ method: "GET" }).handler(
  async (): Promise<{ ok: true; counted: boolean } | { ok: false }> => {
    await noStore();
    const id = await viewerId();
    const base = backendBase();
    if (!id || !base) return { ok: false };
    try {
      const response = await fetch(`${base}/api/session/dan-verified-clears?userId=${id}`, { headers: bridgeAuthHeaders() });
      const body = (await response.json().catch(() => null)) as { counted?: unknown } | null;
      return response.ok && typeof body?.counted === "boolean" ? { ok: true, counted: body.counted } : { ok: false };
    } catch {
      return { ok: false };
    }
  },
);

export const setMyDanVerifiedClears = createServerFn({ method: "POST" })
  .validator((data: { counted?: unknown }) => ({ counted: data?.counted !== false }))
  .handler(async ({ data }): Promise<{ ok: true; counted: boolean } | { ok: false }> => {
    await noStore();
    const id = await viewerId();
    const base = backendBase();
    if (!id || !base) return { ok: false };
    try {
      const response = await fetch(`${base}/api/session/dan-verified-clears`, {
        method: "POST",
        headers: bridgeAuthHeaders(true),
        body: JSON.stringify({ userId: id, counted: data.counted }),
      });
      const body = (await response.json().catch(() => null)) as { counted?: unknown } | null;
      return response.ok && typeof body?.counted === "boolean" ? { ok: true, counted: body.counted } : { ok: false };
    } catch {
      return { ok: false };
    }
  });
