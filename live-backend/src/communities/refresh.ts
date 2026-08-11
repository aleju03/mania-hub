import type { Config } from "../config.js";
import type { Db } from "../db.js";
import {
  applyInviteFailure,
  applyInviteRefresh,
  claimCommunitiesForRefresh,
} from "../features/communities.js";
import { resolveDiscordInvite } from "../discord/invites.js";
import { mapWithConcurrency } from "../discord/util.js";
import { logInfo, logWarn, errorContext } from "../logger.js";

/*
 * Keeps the /communities directory honest.
 *
 * Member counts drift, servers get deleted, and invites get revoked, and nobody
 * comes back to tell us. Every few hours this re-resolves each approved
 * listing's invite: what Discord says now becomes what the card shows, and a
 * link that will not resolve counts against the listing until it drops out of
 * the directory.
 *
 * It spends no osu! API budget, so it runs alongside retention rather than with
 * the schedulers gated on enableScheduledRefreshes && enableOsuApiJobs.
 */

// Well under Discord's unauthenticated per-IP budget, and the resolver already
// retries once on 429. A directory of a few hundred finishes in seconds.
const REFRESH_CONCURRENCY = 4;

export interface RefreshSummary {
  checked: number;
  refreshed: number;
  failed: number;
  hidden: number;
}

export async function refreshCommunityInvites(
  db: Db,
  config: Pick<Config, "communityRefreshIntervalMs" | "communityInviteFailLimit" | "communityRefreshBatchSize">,
  options: { force?: boolean } = {},
): Promise<RefreshSummary> {
  // force is the admin page's "check now" button, which has no interval to wait
  // out; the scheduled pass only claims listings due for a check.
  const cutoff = options.force === true
    ? new Date(Date.now() + 1000).toISOString()
    : new Date(Date.now() - config.communityRefreshIntervalMs).toISOString();
  const due = await claimCommunitiesForRefresh(db, cutoff, config.communityRefreshBatchSize);
  const summary: RefreshSummary = { checked: due.length, refreshed: 0, failed: 0, hidden: 0 };
  if (due.length === 0) return summary;

  // mapWithConcurrency aborts the whole pool on a rejection, so one listing's
  // bad write must not take the rest of the pass down with it.
  await mapWithConcurrency(due, REFRESH_CONCURRENCY, async (row) => {
    try {
      const resolved = await resolveDiscordInvite(row.inviteCode, row.guildId);
      if (resolved.ok) {
        await applyInviteRefresh(db, row.id, resolved.invite, row.pitch, row.tags);
        summary.refreshed += 1;
        return;
      }
      // lookup_failed is our side of the call going wrong (a timeout, a 5xx),
      // not evidence about the invite, so it does not count against the listing.
      // Only Discord actually answering "this invite is not a thing" does.
      if (resolved.error === "lookup_failed") {
        logWarn("community_invite_check_inconclusive", { id: row.id, guildId: row.guildId });
        return;
      }
      const nowHidden = await applyInviteFailure(db, row.id, config.communityInviteFailLimit);
      summary.failed += 1;
      if (nowHidden) {
        summary.hidden += 1;
        logInfo("community_invite_dead", { id: row.id, guildId: row.guildId, reason: resolved.error });
      }
    } catch (error) {
      logWarn("community_invite_check_errored", { id: row.id, ...errorContext(error) });
    }
  });

  if (summary.refreshed > 0 || summary.failed > 0) {
    logInfo("community_invites_refreshed", { ...summary });
  }
  return summary;
}

export function startCommunityInviteScheduler(db: Db, config: Config): () => void {
  let stopped = false;
  const tick = async () => {
    if (stopped) return;
    await refreshCommunityInvites(db, config).catch((error) => {
      logWarn("community_invite_refresh_failed", errorContext(error));
    });
    if (!stopped) setTimeout(tick, config.communityRefreshIntervalMs).unref();
  };
  setTimeout(tick, config.communityRefreshIntervalMs).unref();
  return () => {
    stopped = true;
  };
}
