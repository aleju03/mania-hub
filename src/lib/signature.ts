import { createServerFn } from "@tanstack/react-start";

import { bridgeAuthHeaders } from "./live-backend-tokens";
import { createFixedWindowLimiter } from "./upload-guards";
import { getServerLiveBackendUrl } from "./live-backend";
import type { SignatureType } from "./signature-shared";
import { normalizeSignatureStyleMap, type SignatureStyleMap } from "./signature-style";
import type { SignatureImageProbe } from "../routes/api/signature/-backgrounds";

// Server functions behind the /dynamic-renders page. The viewer always comes
// from the osu! login cookie, never from client input, so a player can only
// ever mint or revoke their own signature. The backend routes are bridge-token
// gated; that token only exists server-side. Mirrors the roster-self-track and
// goals bridges.
//
// Anyone logged in can set one up. The moderation calls at the bottom of this
// file are the part that stays admin-only, and their check is server-side for
// the same reason every check here is: hiding a button does not stop a POST.

export interface SignatureSettings {
  userId: number;
  token: string;
  enabled: boolean;
  enabledTypes: SignatureType[];
  skillsKeyCount: number | null;
  /** Always fully populated, even for a row stored before styles existed. */
  styles: SignatureStyleMap;
  /** The player's own IANA zone, or null when their browser has never said.
      Null renders dates in UTC, which is what every row did before this. */
  timeZone: string | null;
  /** Set from the admin page; the player cannot clear it. */
  blockedAt: number | null;
  createdAt: number;
  updatedAt: number;
  rotatedAt: number | null;
}

export interface SignatureSettingsResult {
  /** False when the viewer is signed out. */
  allowed: boolean;
  signature: SignatureSettings | null;
}

/** One row of the moderation list. Carries no token on purpose - the point is
    to judge a background by its source, not to hand out the capability that
    addresses someone's renders. */
export interface SignatureAdminRow {
  userId: number;
  username: string;
  enabled: boolean;
  blockedAt: number | null;
  enabledTypes: SignatureType[];
  customImageUrls: string[];
  /** How many times an admin has taken a background off this row. */
  clearedCount: number;
  createdAt: number;
  updatedAt: number;
}

export interface SignatureAdminPreviewPlayer {
  userId: number;
  username: string;
}

export type SignatureAdminPreviewPlayerResult = {
  player: SignatureAdminPreviewPlayer | null;
  error: "forbidden" | "not-found" | "unavailable" | null;
};

const UNAVAILABLE: SignatureSettingsResult = { allowed: false, signature: null };

async function requireViewer(): Promise<{ userId: number; base: string } | null> {
  const { readCurrentAuth } = await import("./auth-server");
  const auth = await readCurrentAuth();
  if (!auth.viewer) return null;
  const base = getServerLiveBackendUrl();
  if (!base) return null;
  return { userId: auth.viewer.id, base };
}

/* The backend stores the style map opaquely, so normalizing on the way out is
   what guarantees the page always has all four types with valid ids - including
   for a row written before styles existed, where the column is null. */
function readSignature(body: unknown): SignatureSettings | null {
  const signature = (body as { signature?: unknown } | null)?.signature as
    (Omit<SignatureSettings, "styles"> & { styles?: unknown }) | null | undefined;
  if (!signature) return null;
  return { ...signature, styles: normalizeSignatureStyleMap(signature.styles) };
}

async function postSignatureAction(
  action: "enable" | "disable" | "rotate" | "time-zone",
  payload: Record<string, unknown> = {},
): Promise<SignatureSettingsResult> {
  const viewer = await requireViewer();
  if (!viewer) return UNAVAILABLE;
  try {
    const response = await fetch(`${viewer.base}/api/signature/${action}`, {
      method: "POST",
      headers: bridgeAuthHeaders(true),
      body: JSON.stringify({ ...payload, userId: viewer.userId }),
    });
    if (!response.ok) return { allowed: true, signature: null };
    const signature = readSignature(await response.json().catch(() => null));
    const memo = await import("./signature-resolve");
    const renders = await import("./signature-render-cache");
    if (action === "enable" || action === "time-zone") {
      /* The render route resolves tokens through a short-lived memo. Without
         this, the preview fetched immediately after a save would re-render the
         style that was stored a moment ago, and the page would look like the
         setting did nothing. A zone report is the same shape of write: it
         moves the insights version, so the memo has to let go of the token. */
      if (signature?.token) {
        memo.forgetSignatureToken(signature.token);
        /* And the finished pictures under that token. Dropping only the resolve
           would leave the previous render answering from this process for its
           own TTL, which is the same "the setting did nothing" the memo drop
           above exists to prevent. */
        renders.forgetSignatureRenders(signature.token);
      }
    } else {
      /* Rotating and disabling are the revoke. The old token is not in the
         response to forget by name, and leaving it memoized would keep a
         revoked signature answering for another memo window, so the whole map
         goes - it is small and this is rare. */
      memo.clearSignatureResolveMemo();
      renders.clearSignatureRenderCache();
    }
    return { allowed: true, signature };
  } catch {
    return { allowed: true, signature: null };
  }
}

export const fetchSignatureSettings = createServerFn({ method: "GET" }).handler(
  async (): Promise<SignatureSettingsResult> => {
    const viewer = await requireViewer();
    if (!viewer) return UNAVAILABLE;
    const { setResponseHeader } = await import("@tanstack/react-start/server");
    setResponseHeader("Cache-Control", "private, no-store");
    try {
      const response = await fetch(
        `${viewer.base}/api/signature/self?userId=${viewer.userId}`,
        { headers: bridgeAuthHeaders() },
      );
      if (!response.ok) return { allowed: true, signature: null };
      return { allowed: true, signature: readSignature(await response.json().catch(() => null)) };
    } catch {
      return { allowed: true, signature: null };
    }
  },
);

/* Which keymodes the player has enough rated plays for. The picker offers only
   these, so nobody selects 4K, gets silently fallen back to their 7K radar,
   and concludes the setting is broken. */
export const fetchSignatureKeyModes = createServerFn({ method: "GET" }).handler(
  async (): Promise<{ keyCounts: number[] }> => {
    const viewer = await requireViewer();
    if (!viewer) return { keyCounts: [] };
    try {
      const response = await fetch(`${viewer.base}/api/profiles/${viewer.userId}/skills`);
      if (!response.ok) return { keyCounts: [] };
      const { qualifyingSkillModes } = await import("./skill-axes");
      const skills = await response.json();
      return { keyCounts: qualifyingSkillModes(skills).map((mode) => mode.keyCount) };
    } catch {
      return { keyCounts: [] };
    }
  },
);

/* Typing a url is a handful of probes; the cap is here so an account cannot
   turn the page into a general-purpose "is this address up" service. Held per
   viewer rather than per url: the url is the thing being asked about, so
   keying on it would let one account sweep a list for free. */
const probeLimiter = createFixedWindowLimiter(60_000);
const PROBES_PER_MINUTE = 30;

/* Whether a pasted address will actually produce a picture. The render cannot
   answer this: it falls back to no background and carries on, which is right
   for a stranger loading an osu! profile and reads as "the feature is broken"
   to the player who just typed the url. Hosts behind a bot challenge are the
   common case - they answer 403 to anything that is not a browser, and nothing
   here pretends to be one. */
export const checkSignatureImageUrl = createServerFn({ method: "POST" })
  .validator((input: { url: string }) => input)
  .handler(async ({ data }): Promise<{ status: SignatureImageProbe }> => {
    const viewer = await requireViewer();
    if (!viewer) return { status: "blocked" };
    /* Over the cap reads as "that link did not load", which is what an
       unreachable host says too. Nothing here is worth a distinct message: a
       player cannot hit this by typing. */
    if (probeLimiter.isRateLimited(String(viewer.userId), PROBES_PER_MINUTE)) {
      return { status: "unreachable" };
    }
    const { probeSignatureImageUrl } = await import("../routes/api/signature/-backgrounds");
    return { status: await probeSignatureImageUrl(data.url) };
  });

export const enableSignature = createServerFn({ method: "POST" })
  .validator((input: {
    types: SignatureType[];
    skillsKeyCount?: number | null;
    /** Omit to leave the stored look untouched, which is what publishing a
        type does. Anything sent is re-normalized here, so the allowlist holds
        even if the client posted the call directly. */
    styles?: SignatureStyleMap;
    /** The browser's IANA zone. Only the client can know it, so it rides along
        with whatever the player was doing anyway; the backend validates it
        against Intl before storing. Omit to leave the stored zone alone. */
    timeZone?: string;
  }) => input)
  .handler(async ({ data }): Promise<SignatureSettingsResult> =>
    postSignatureAction("enable", {
      types: data.types,
      skillsKeyCount: data.skillsKeyCount ?? null,
      ...(data.styles ? { styles: normalizeSignatureStyleMap(data.styles) } : {}),
      ...(data.timeZone ? { timeZone: data.timeZone } : {}),
    }));

/* The zone on its own, for the page reporting what the browser says on load.
   A player who set their signature up before this existed has no reason to
   touch a style again, and without this their render would print UTC dates
   forever. Separate from enable() because it must not turn a signature back
   on: the backend no-ops when the stored value already matches, so an ordinary
   revisit is a read and does not move the version. */
export const reportSignatureTimeZone = createServerFn({ method: "POST" })
  .validator((input: { timeZone: string }) => input)
  .handler(async ({ data }): Promise<SignatureSettingsResult> =>
    postSignatureAction("time-zone", { timeZone: data.timeZone }));

export const disableSignature = createServerFn({ method: "POST" }).handler(
  async (): Promise<SignatureSettingsResult> => postSignatureAction("disable"));

export const rotateSignatureToken = createServerFn({ method: "POST" }).handler(
  async (): Promise<SignatureSettingsResult> => postSignatureAction("rotate"));

/* Moderation. These reach the backend with the ADMIN token rather than the
   bridge one, because nothing here acts on behalf of the player being touched.
   The admin check is server-side for the same reason the rest of this file's
   is: hiding a button does not stop a POST. */
async function adminSignatureRequest(
  path: string,
  init?: { method: "POST"; body: Record<string, unknown> },
): Promise<Response | null> {
  const { readCurrentAuth } = await import("./auth-server");
  const auth = await readCurrentAuth();
  if (!auth.viewer || !auth.canUseAdminFeatures) return null;
  const base = getServerLiveBackendUrl();
  if (!base) return null;
  const { adminAuthHeaders } = await import("./live-backend-tokens");
  try {
    return await fetch(`${base}${path}`, init
      ? { method: "POST", headers: adminAuthHeaders(true), body: JSON.stringify(init.body) }
      : { headers: adminAuthHeaders() });
  } catch {
    return null;
  }
}

/** What the backend hands back so a caller can erase the live copies. The token
    is in here; it stays inside this server function and never reaches a
    browser or the admin list. */
interface SignaturePurgeTarget {
  token: string;
  versions: Record<SignatureType, string>;
}

/* Removing a picture has to reach four places, because a render lives in four:
   this process's own copy of the bytes, the edge cache keyed by URL, the stored
   object in R2 keyed by data version, and the row itself. The row is the
   backend's job and already done by the time this runs; these are the rest.

   Only this instance's copy is dropped - the other frontend instances did not
   serve the moderation call and have no channel to hear about it, so their
   copies expire on the render cache's own short TTL instead.

   The two network calls are best-effort. The moderation action has already
   succeeded, and an admin being told "block failed" because Cloudflare timed
   out would be a lie that invites them to press it again. */
async function eraseSignatureCopies(userId: number, purge: SignaturePurgeTarget | null | undefined): Promise<void> {
  if (!purge?.token) return;

  const [
    { purgeCloudflareUrls },
    { deleteSignatureImages },
    { getPrimarySiteOrigin },
    { forgetSignatureRenders },
    shared,
    route,
  ] = await Promise.all([
    import("./cloudflare-purge"),
    import("./r2-cache"),
    import("./origin"),
    import("./signature-render-cache"),
    import("./signature-shared"),
    import("../routes/api/signature/$token/$variant"),
  ]);

  /* A fourth place, and the one the other three cannot reach: this process is
     holding the finished bytes and would keep handing them out past the purge.
     Free and synchronous, so it happens before the network work rather than
     alongside it. */
  forgetSignatureRenders(purge.token);

  const urls: string[] = [];
  const cacheKeys: string[] = [];
  const origin = getPrimarySiteOrigin();
  for (const type of shared.SIGNATURE_TYPES) {
    const version = purge.versions?.[type];
    for (const design of shared.signatureDesigns(type)) {
      urls.push(`${origin}${shared.signatureImagePath(purge.token, type, design.design)}`);
      /* And the numbered address the same layout answered on before slugs.
         An edge copy is keyed by url, so a render pasted under the old shape
         would survive a block that only named the new one. */
      urls.push(`${origin}/api/signature/${purge.token}/${shared.legacySignatureVariantSlug(type, design.design)}`);
      if (version) cacheKeys.push(route.signatureCacheKey(userId, type, design.design, version));
    }
  }

  await Promise.allSettled([purgeCloudflareUrls(urls), deleteSignatureImages(cacheKeys)]);
}

export const fetchSignatureAdminList = createServerFn({ method: "GET" })
  .validator((input: { customOnly?: boolean } | undefined) => input ?? {})
  .handler(async ({ data }): Promise<{ signatures: SignatureAdminRow[] }> => {
    const { setResponseHeader } = await import("@tanstack/react-start/server");
    setResponseHeader("Cache-Control", "private, no-store");
    const response = await adminSignatureRequest(
      `/api/admin/signatures/list${data.customOnly ? "?customOnly=1" : ""}`,
    );
    if (!response?.ok) return { signatures: [] };
    const body = await response.json().catch(() => null) as { signatures?: SignatureAdminRow[] } | null;
    return { signatures: body?.signatures ?? [] };
  });

/* Resolve the player once before the browser asks the image endpoint for each
   layout. /snapshot, rather than cached-snapshot, is deliberate: this admin
   tool promises any live osu! player, including one Mania Hub has never seen.
   A cold lookup mints the normal stored profile snapshot, after which every
   renderer reads it through its ordinary cached path. Nothing about the
   player's signature settings is created or changed. */
export const fetchSignatureAdminPreviewPlayer = createServerFn({ method: "POST" })
  .validator((input: { key: string }) => ({ key: String(input?.key ?? "").trim().slice(0, 120) }))
  .handler(async ({ data }): Promise<SignatureAdminPreviewPlayerResult> => {
    const { setResponseHeader } = await import("@tanstack/react-start/server");
    setResponseHeader("Cache-Control", "private, no-store");
    const { readCurrentAuth } = await import("./auth-server");
    const auth = await readCurrentAuth();
    if (!auth.viewer || !auth.canUseAdminFeatures) {
      return { player: null, error: "forbidden" };
    }
    if (!data.key) return { player: null, error: "not-found" };
    const base = getServerLiveBackendUrl();
    if (!base) return { player: null, error: "unavailable" };

    try {
      const lookup = /^\d+$/.test(data.key) ? "?lookup=id" : "";
      const response = await fetch(
        `${base}/api/profiles/${encodeURIComponent(data.key)}/snapshot${lookup}`,
      );
      if (response.status === 404) return { player: null, error: "not-found" };
      if (!response.ok) return { player: null, error: "unavailable" };
      const snapshot = await response.json().catch(() => null) as {
        user?: { id?: unknown; username?: unknown } | null;
      } | null;
      const userId = Number(snapshot?.user?.id);
      const username = typeof snapshot?.user?.username === "string"
        ? snapshot.user.username.trim().slice(0, 64)
        : "";
      if (!Number.isInteger(userId) || userId <= 0 || !username) {
        return { player: null, error: "not-found" };
      }
      return { player: { userId, username }, error: null };
    } catch {
      return { player: null, error: "unavailable" };
    }
  });

/* Moderating a picture means looking at the picture. The list carries the
   address, but judging a background by reading its url is guesswork, and
   opening each one in a tab points the moderator's browser straight at a host
   the player chose.

   So the thumbnail is fetched here, through the same pinned transport a render
   uses, and the caller names a PLAYER rather than a url - which is what keeps
   this from being a general-purpose image proxy with an admin cookie in front
   of it. The only addresses it will ever fetch are ones already stored on a
   row. */
export const fetchSignatureImagePreviews = createServerFn({ method: "POST" })
  .validator((input: { userId: number }) => input)
  .handler(async ({ data }): Promise<{ previews: Array<{ url: string; dataUrl: string | null }> }> => {
    const { setResponseHeader } = await import("@tanstack/react-start/server");
    setResponseHeader("Cache-Control", "private, no-store");
    const response = await adminSignatureRequest("/api/admin/signatures/list?customOnly=1");
    if (!response?.ok) return { previews: [] };
    const body = await response.json().catch(() => null) as { signatures?: SignatureAdminRow[] } | null;
    const row = body?.signatures?.find((entry) => entry.userId === data.userId);
    if (!row?.customImageUrls.length) return { previews: [] };

    const { thumbnailDataUrl } = await import("../routes/api/signature/-backgrounds");
    return {
      previews: await Promise.all(row.customImageUrls.map(async (url) => ({
        url,
        dataUrl: await thumbnailDataUrl(url).catch(() => null),
      }))),
    };
  });

/** The kill switch. A blocked signature stops resolving, so every image behind
    that token 404s, and the player cannot turn it back on themselves. */
export const setSignatureBlocked = createServerFn({ method: "POST" })
  .validator((input: { userId: number; blocked: boolean }) => input)
  .handler(async ({ data }): Promise<{ ok: boolean }> => {
    const response = await adminSignatureRequest("/api/admin/signatures/block", {
      method: "POST",
      body: { userId: data.userId, blocked: data.blocked },
    });
    if (!response?.ok) return { ok: false };
    const body = await response.json().catch(() => null) as { purge?: SignaturePurgeTarget | null } | null;
    // Awaited, not detached: an admin who blocks something and immediately
    // reloads the image should not still be racing the purge.
    await eraseSignatureCopies(data.userId, body?.purge);
    return { ok: true };
  });

/** The proportionate one: drop the picture, leave the signature working. */
export const clearSignatureImages = createServerFn({ method: "POST" })
  .validator((input: { userId: number }) => input)
  .handler(async ({ data }): Promise<{ ok: boolean }> => {
    const response = await adminSignatureRequest("/api/admin/signatures/clear-images", {
      method: "POST",
      body: { userId: data.userId },
    });
    if (!response?.ok) return { ok: false };
    const body = await response.json().catch(() => null) as { purge?: SignaturePurgeTarget | null } | null;
    /* The URL survives a clear - only the picture behind it changed - so the
       edge copy is the stale one that has to go. The stored renders under the
       pre-clear versions are already unaddressable, and go too. */
    await eraseSignatureCopies(data.userId, body?.purge);
    return { ok: true };
  });
