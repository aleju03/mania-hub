import { getAppRateLimitClientIp } from "./app-client-ip";

/* A stable per-reporter bucket that is not an address, shared by every open
   write a signed-out visitor can make (translation reports, bug reports).

   The signed-in case names the account (the backend already stores that id
   anyway); otherwise the visitor's address is HMACed with a server secret and
   truncated, so the table can count one reporter's rows without holding
   anything that identifies them. Deployments that do not trust proxy headers
   hand out "unknown" for every visitor, which collapses to the backend's
   shared anonymous bucket - a much larger ceiling exists there for exactly
   that reason. */
export async function reporterKeyFor(request: Request, userId: number | null): Promise<string> {
  if (userId) return `user:${userId}`;
  const ip = getAppRateLimitClientIp(request);
  if (ip === "unknown") return "anon";
  const { createHmac } = await import("node:crypto");
  // The literal is unreachable in practice: with neither token set the bridge
  // headers are empty and the backend refuses the write anyway.
  const secret = process.env.LIVE_BRIDGE_TOKEN?.trim() || process.env.LIVE_ADMIN_TOKEN?.trim() || "reporter-key";
  return `ip:${createHmac("sha256", secret).update(ip).digest("hex").slice(0, 32)}`;
}
