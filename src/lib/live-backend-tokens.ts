/* The two server-to-server credentials for the live backend, and which one a
   call takes.

   `LIVE_ADMIN_TOKEN` opens the admin surface: `/api/admin/*`, the analytics
   queries, the destructive actions, and the HMAC key the ghost overlay signs
   viewer identities with.

   `LIVE_BRIDGE_TOKEN` opens the per-user routes: goals, wallets, skins
   ownership, roster opt-in, the osu! proxy, analytics capture. These say "this
   request came from my own server", and the osu!-verified viewer id travels in
   the payload beside them. That is a different claim from "this request may do
   admin things", and while one token made both, a leak of it was a leak of both
   - write-as-any-player included.

   Unset means not split yet: the bridge falls back to the admin token, which is
   exactly the old behaviour, and the backend's isBridge() does the same. Set it
   on the VPS in both `.env` files at once, with different values; setting it on
   only one side answers 401 to every signed-in feature on the site.

   Never send either to a browser. */

export function liveAdminToken(): string | undefined {
  return process.env.LIVE_ADMIN_TOKEN?.trim() || undefined;
}

export function liveBridgeToken(): string | undefined {
  return process.env.LIVE_BRIDGE_TOKEN?.trim() || liveAdminToken();
}

/** `authorization` for a bridge call, or nothing when no token is configured
    (local runs without a backend; the call then fails at the backend's gate,
    which is the same fail-closed shape as before). */
export function bridgeAuthHeaders(json = false): Record<string, string> {
  const headers: Record<string, string> = json ? { "content-type": "application/json" } : {};
  const token = liveBridgeToken();
  if (token) headers.authorization = `Bearer ${token}`;
  return headers;
}

/** The same, for `/api/admin/*`. Never falls back to the bridge token: an
    admin route must be opened by the admin credential or not at all. */
export function adminAuthHeaders(json = false): Record<string, string> {
  const headers: Record<string, string> = json ? { "content-type": "application/json" } : {};
  const token = liveAdminToken();
  if (token) headers.authorization = `Bearer ${token}`;
  return headers;
}
