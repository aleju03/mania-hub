import { createFileRoute, Link, notFound } from "@tanstack/react-router";
import { useCallback, useEffect, useState } from "react";
import { canUseAdminFeatures } from "../../lib/auth-shared";
import { fetchDiscordAdminStatus, fetchDiscordGuilds, runLiveBackendAdminAction } from "../../lib/live-backend";

export const Route = createFileRoute("/admin/discord")({
  head: () => ({
    meta: [
      { title: "Discord - admin" },
      { name: "robots", content: "noindex, nofollow" },
    ],
  }),
  beforeLoad: ({ context }) => {
    if (!canUseAdminFeatures(context.auth)) {
      throw notFound();
    }
    return undefined as never;
  },
  component: DiscordAdminPage,
});

interface DiscordStatus {
  enabled: boolean;
  configured?: boolean;
  hasBotToken?: boolean;
  feedsEnabled?: boolean;
  applicationId?: string | null;
  devGuildId?: string | null;
  commandCount?: number;
  recentInteractions?: Array<{ command: string; userId: string | null; guildId: string | null; at: number }>;
  commandCounts?: Record<string, number>;
  errorCount?: number;
  alertsDelivered?: number;
  dmFailures?: number;
  trackedPlayers?: number;
}

interface DiscordSubscription {
  id: number;
  guildId: string | null;
  channelId: string;
  country: string;
  feedType: string;
  minPp: number;
  createdBy: string | null;
  createdAt: string;
}

interface DiscordTracker {
  id: number;
  subscriberId: string;
  kind: string;
  targetOsuUserId: number;
  targetUsername: string | null;
  minPp: number;
  createdAt: string;
}

interface DiscordAdminPayload {
  discord: DiscordStatus;
  subscriptions: DiscordSubscription[];
  trackers?: DiscordTracker[];
  linkCount?: number;
}

interface DiscordGuild {
  id: string;
  name: string;
  iconUrl: string | null;
  memberCount: number | null;
}

const FEED_LABELS: Record<string, string> = { top_play: "Top plays", snipe: "Snipes", new_map: "New farm maps" };

function DiscordAdminPage() {
  const [data, setData] = useState<DiscordAdminPayload | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const result = (await fetchDiscordAdminStatus()) as DiscordAdminPayload;
      setData(result);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const registerCommands = useCallback(async () => {
    setBusy(true);
    setMessage(null);
    setError(null);
    try {
      const res = await runLiveBackendAdminAction({ data: { path: "/api/admin/discord/register-commands" } });
      const body = res.body ? (JSON.parse(res.body) as { ok?: boolean; global?: number; guild?: number | null; error?: string }) : null;
      if (body && body.ok === false) {
        setError(body.error ?? "Registration failed.");
      } else {
        const guildNote = body?.guild != null ? ` and ${body.guild} to the dev guild` : "";
        setMessage(`Registered ${body?.global ?? "all"} global commands${guildNote}. Global commands can take up to ~1h to appear.`);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }, []);

  const removeSubscription = useCallback(async (id: number) => {
    setBusy(true);
    setMessage(null);
    setError(null);
    try {
      await runLiveBackendAdminAction({ data: { path: `/api/admin/discord/remove-subscription?id=${id}` } });
      setMessage(`Removed subscription #${id}.`);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }, [load]);

  const status = data?.discord;
  const subscriptions = data?.subscriptions ?? [];
  const trackers = data?.trackers ?? [];

  const [guilds, setGuilds] = useState<DiscordGuild[] | null>(null);
  const [guildsLoading, setGuildsLoading] = useState(false);
  const [guildsError, setGuildsError] = useState<string | null>(null);

  const loadGuilds = useCallback(async () => {
    setGuildsLoading(true);
    setGuildsError(null);
    try {
      const res = (await fetchDiscordGuilds()) as { ok?: boolean; guilds?: DiscordGuild[]; error?: string };
      if (res.ok === false) {
        setGuildsError(res.error ?? "Could not load servers.");
      } else {
        setGuilds(res.guilds ?? []);
      }
    } catch (err) {
      setGuildsError(err instanceof Error ? err.message : String(err));
    } finally {
      setGuildsLoading(false);
    }
  }, []);

  // Load the live guild list once the bot is known to be enabled with a token.
  // Kept out of the main status poll so each Refresh doesn't hit the Discord API.
  const botReady = Boolean(status?.enabled && status?.hasBotToken);
  useEffect(() => {
    if (botReady) void loadGuilds();
  }, [botReady, loadGuilds]);

  return (
    <div className="min-h-[calc(100vh-60px)] flex-1 bg-osu-b5">
      <div className="border-b border-osu-b3/40 bg-osu-d5">
        <div className="mx-auto flex max-w-[1100px] flex-wrap items-center gap-3 px-4 py-3 sm:px-5">
          <h2 className="text-[13px] font-medium text-osu-c2 sm:text-[15px]">Discord</h2>
          <span className="rounded bg-osu-yellow/15 px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wider text-osu-yellow">admin</span>
          <div className="ml-auto flex items-center gap-2">
            <Link to="/discord" className="text-[11px] font-semibold text-osu-pink-light hover:text-white">Tool page</Link>
            <button
              type="button"
              onClick={() => void load()}
              disabled={loading || busy}
              className="rounded-lg border border-osu-b3/50 bg-osu-b4 px-2.5 py-1 text-[11px] font-semibold text-osu-l2 transition-colors hover:bg-osu-b3 disabled:opacity-50"
            >
              Refresh
            </button>
          </div>
        </div>
      </div>

      <div className="mx-auto max-w-[1100px] space-y-4 px-4 py-5 sm:px-5">
        <p className="text-[12px] leading-relaxed text-osu-l3">
          Backend control panel for the Discord bot: confirm it's wired up, push its slash commands to
          Discord, see which servers added it, and which channels are receiving live feeds. The public-facing page is at{" "}
          <Link to="/discord" className="text-osu-pink-light hover:text-white">Tool page</Link>.
        </p>
        {error ? (
          <div className="rounded-lg border border-rose-500/30 bg-rose-500/10 px-3 py-2 text-[12px] text-rose-200">{error}</div>
        ) : null}
        {message ? (
          <div className="rounded-lg border border-emerald-500/30 bg-emerald-500/10 px-3 py-2 text-[12px] text-emerald-200">{message}</div>
        ) : null}

        {loading && !data ? (
          <div className="text-[12px] text-osu-l3">Loading…</div>
        ) : !data ? (
          // Fetch failed: the red error banner above already explains it; don't
          // also claim the bot is disabled (we don't actually know).
          null
        ) : !status?.enabled ? (
          <section className="rounded-xl border border-osu-yellow/25 bg-osu-yellow/5 p-4 text-[12px] text-osu-l2">
            The Discord bot is not enabled on the live backend. Set <code className="text-osu-pink-light">ENABLE_DISCORD_BOT=true</code> with the
            application id, public key and bot token, then restart the backend.
          </section>
        ) : (
          <>
            <section className="rounded-xl border border-osu-b3/30 bg-osu-b4 p-4">
              <h3 className="text-[12px] font-semibold text-white">Status</h3>
              <p className="mb-2 text-[11px] text-osu-l3">How the bot is configured on the backend right now.</p>
              <div className="text-[12px]">
                <StatusRow label="Configured" hint="Application ID and public key are set, so Discord can reach the bot." value={<Pill ok={status.configured} />} />
                <StatusRow label="Bot token" hint="The secret that lets the backend register commands and post feed messages." value={<Pill ok={status.hasBotToken} okText="present" badText="missing" />} />
                <StatusRow label="Feeds" hint="Whether new top plays and snipes get auto-posted to subscribed channels." value={<Pill ok={status.feedsEnabled} okText="on" badText="off" />} />
                <StatusRow label="Commands" hint="Number of slash commands the bot defines." value={<span className="text-osu-l2">{status.commandCount ?? 0}</span>} />
                <StatusRow label="Application ID" hint="Your bot's public id (the one in the invite link)." value={<span className="font-mono text-[11px] text-osu-l2">{status.applicationId ?? "-"}</span>} />
                <StatusRow label="Dev guild" hint="If set, commands register to just that one server, instantly. Empty = global (all servers, up to ~1h to appear)." value={<span className="font-mono text-[11px] text-osu-l2">{status.devGuildId ?? "-"}</span>} />
                <StatusRow label="Linked accounts" hint="Players who ran /link to tie their osu! account to their Discord user." value={<span className="text-osu-l2">{data?.linkCount ?? 0}</span>} />
                <StatusRow label="Tracked players" hint="Distinct osu! players currently watched by a personal /watch alert." value={<span className="text-osu-l2">{status.trackedPlayers ?? 0}</span>} />
                <StatusRow label="Alerts delivered" hint="Personal DM and new-map alerts sent since the backend started." value={<span className="text-osu-l2">{status.alertsDelivered ?? 0}</span>} />
                <StatusRow label="DM failures" hint="DM sends that failed for reasons other than closed DMs (those self-heal)." value={<span className="text-osu-l2">{status.dmFailures ?? 0}</span>} />
                <StatusRow label="Handler errors" hint="Commands that threw while building a reply since startup." value={<span className="text-osu-l2">{status.errorCount ?? 0}</span>} />
              </div>

              <div className="mt-4 rounded-lg border border-osu-b3/30 bg-osu-b5/60 p-3">
                <button
                  type="button"
                  onClick={() => void registerCommands()}
                  disabled={busy || !status.hasBotToken}
                  className="rounded-lg bg-osu-pink/90 px-3.5 py-2 text-[12px] font-semibold text-white transition-colors hover:bg-osu-pink disabled:opacity-50"
                >
                  Register commands
                </button>
                <p className="mt-2 text-[11px] leading-relaxed text-osu-l3">
                  Pushes the {status.commandCount ?? 0} slash commands to Discord so they show up when users type{" "}
                  <code className="text-osu-pink-light">/</code>. Only needed after you add, rename or remove a command.{" "}
                  {!status.hasBotToken
                    ? "Set DISCORD_BOT_TOKEN on the backend first."
                    : status.devGuildId
                      ? "Registers to your dev guild, so changes appear instantly in that server."
                      : "Registering globally, so new or changed commands can take up to ~1h to appear. Set DISCORD_DEV_GUILD_ID for instant updates while testing."}
                </p>
              </div>
            </section>

            <section className="rounded-xl border border-osu-b3/30 bg-osu-b4 p-4">
              <div className="flex items-center justify-between gap-2">
                <h3 className="text-[12px] font-semibold text-white">
                  Servers {guilds ? <span className="text-osu-l3">({guilds.length})</span> : null}
                </h3>
                {status.hasBotToken ? (
                  <button
                    type="button"
                    onClick={() => void loadGuilds()}
                    disabled={guildsLoading}
                    className="rounded-lg border border-osu-b3/50 bg-osu-b4 px-2.5 py-1 text-[11px] font-semibold text-osu-l2 transition-colors hover:bg-osu-b3 disabled:opacity-50"
                  >
                    {guildsLoading ? "Loading…" : "Reload"}
                  </button>
                ) : null}
              </div>
              <p className="mb-3 mt-0.5 text-[11px] text-osu-l3">
                Every Discord server the bot is currently in, biggest first. Live from Discord, not the
                subscriptions below: a server counts here even if no channel ran <code className="text-osu-pink-light">/subscribe</code>.
              </p>
              {!status.hasBotToken ? (
                <p className="text-[12px] text-osu-l3">Set <code className="text-osu-pink-light">DISCORD_BOT_TOKEN</code> on the backend to list servers.</p>
              ) : guildsError ? (
                <p className="text-[12px] text-rose-300">{guildsError}</p>
              ) : guilds === null ? (
                <p className="text-[12px] text-osu-l3">Loading…</p>
              ) : guilds.length === 0 ? (
                <p className="text-[12px] text-osu-l3">The bot isn't in any servers yet.</p>
              ) : (
                <ul className="grid gap-1.5 sm:grid-cols-2">
                  {guilds.map((guild) => (
                    <li key={guild.id} className="flex items-center gap-2 rounded-lg border border-osu-b3/20 bg-osu-b5/40 px-2.5 py-1.5">
                      {guild.iconUrl ? (
                        <img src={guild.iconUrl} alt="" className="h-6 w-6 shrink-0 rounded-full object-cover" loading="lazy" />
                      ) : (
                        <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-osu-b3 text-[10px] font-bold text-osu-l2">
                          {guild.name.slice(0, 1).toUpperCase()}
                        </span>
                      )}
                      <span className="min-w-0 flex-1 truncate text-[12px] text-osu-l2" title={guild.name}>{guild.name}</span>
                      {guild.memberCount != null ? (
                        <span className="shrink-0 text-[10px] text-osu-l3">{guild.memberCount.toLocaleString()}</span>
                      ) : null}
                    </li>
                  ))}
                </ul>
              )}
            </section>

            <section className="rounded-xl border border-osu-b3/30 bg-osu-b4 p-4">
              <h3 className="text-[12px] font-semibold text-white">
                Live-feed subscriptions <span className="text-osu-l3">({subscriptions.length})</span>
              </h3>
              <p className="mb-3 text-[11px] text-osu-l3">
                Channels that ran <code className="text-osu-pink-light">/subscribe</code> in a server. Each row is one feed
                posting into one channel. Remove stops that feed (the server can re-add it anytime).
              </p>
              {subscriptions.length === 0 ? (
                <p className="text-[12px] text-osu-l3">No channels are subscribed yet.</p>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full text-left text-[12px]">
                    <thead className="text-[10px] uppercase tracking-wide text-osu-l3">
                      <tr>
                        <th className="py-1 pr-3 font-semibold">Feed</th>
                        <th className="py-1 pr-3 font-semibold">Country</th>
                        <th className="py-1 pr-3 font-semibold">Min pp</th>
                        <th className="py-1 pr-3 font-semibold">Channel</th>
                        <th className="py-1 pr-3 font-semibold">Guild</th>
                        <th className="py-1" />
                      </tr>
                    </thead>
                    <tbody className="text-osu-l2">
                      {subscriptions.map((sub) => (
                        <tr key={sub.id} className="border-t border-osu-b3/20">
                          <td className="py-1.5 pr-3">{FEED_LABELS[sub.feedType] ?? sub.feedType}</td>
                          <td className="py-1.5 pr-3">{sub.country}</td>
                          <td className="py-1.5 pr-3">{sub.minPp > 0 ? sub.minPp : "-"}</td>
                          <td className="py-1.5 pr-3 font-mono text-[11px] text-osu-l3">{sub.channelId}</td>
                          <td className="py-1.5 pr-3 font-mono text-[11px] text-osu-l3">{sub.guildId ?? "-"}</td>
                          <td className="py-1.5 text-right">
                            <button
                              type="button"
                              onClick={() => void removeSubscription(sub.id)}
                              disabled={busy}
                              className="rounded border border-rose-500/30 px-2 py-0.5 text-[11px] font-semibold text-rose-300 transition-colors hover:bg-rose-500/10 disabled:opacity-50"
                            >
                              Remove
                            </button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </section>

            <section className="rounded-xl border border-osu-b3/30 bg-osu-b4 p-4">
              <h3 className="text-[12px] font-semibold text-white">
                Personal alerts <span className="text-osu-l3">({trackers.length})</span>
              </h3>
              <p className="mb-3 text-[11px] text-osu-l3">
                DM alerts users set up for themselves with <code className="text-osu-pink-light">/watch</code>: a specific player's
                plays, or new farm maps. Delivered to the user's DMs, not a channel.
              </p>
              {trackers.length === 0 ? (
                <p className="text-[12px] text-osu-l3">No one has set up a personal alert yet.</p>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full text-left text-[12px]">
                    <thead className="text-[10px] uppercase tracking-wide text-osu-l3">
                      <tr>
                        <th className="py-1 pr-3 font-semibold">Kind</th>
                        <th className="py-1 pr-3 font-semibold">Target</th>
                        <th className="py-1 pr-3 font-semibold">Min pp</th>
                        <th className="py-1 pr-3 font-semibold">Subscriber</th>
                      </tr>
                    </thead>
                    <tbody className="text-osu-l2">
                      {trackers.map((t) => (
                        <tr key={t.id} className="border-t border-osu-b3/20">
                          <td className="py-1.5 pr-3">{t.kind === "maps" ? "New maps" : "Player"}</td>
                          <td className="py-1.5 pr-3">{t.kind === "maps" ? "-" : t.targetUsername ?? String(t.targetOsuUserId)}</td>
                          <td className="py-1.5 pr-3">{t.minPp > 0 ? t.minPp : "-"}</td>
                          <td className="py-1.5 pr-3 font-mono text-[11px] text-osu-l3">{t.subscriberId}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </section>

            {status.commandCounts && Object.keys(status.commandCounts).length > 0 ? (
              <section className="rounded-xl border border-osu-b3/30 bg-osu-b4 p-4">
                <h3 className="text-[12px] font-semibold text-white">Command usage</h3>
                <p className="mb-3 text-[11px] text-osu-l3">How many times each command ran since the backend started (in memory).</p>
                <div className="flex flex-wrap gap-1.5">
                  {Object.entries(status.commandCounts)
                    .sort((a, b) => b[1] - a[1])
                    .map(([name, count]) => (
                      <span key={name} className="rounded-md border border-osu-b3/30 bg-osu-b5/50 px-2 py-1 text-[11px] text-osu-l2">
                        <code className="text-osu-pink-light">/{name}</code> <span className="tabular-nums">{count}</span>
                      </span>
                    ))}
                </div>
              </section>
            ) : null}

            {status.recentInteractions && status.recentInteractions.length > 0 ? (
              <section className="rounded-xl border border-osu-b3/30 bg-osu-b4 p-4">
                <h3 className="text-[12px] font-semibold text-white">Recent commands</h3>
                <p className="mb-3 text-[11px] text-osu-l3">The latest slash commands people ran through the bot (newest first, kept in memory).</p>
                <ul className="space-y-1 text-[12px] text-osu-l2">
                  {[...status.recentInteractions].reverse().map((entry, index) => (
                    <li key={`${entry.at}-${index}`} className="flex items-center gap-2">
                      <code className="text-osu-pink-light">/{entry.command}</code>
                      <span className="text-[10px] text-osu-l3">{new Date(entry.at).toLocaleTimeString()}</span>
                      {entry.guildId ? <span className="font-mono text-[10px] text-osu-l3">guild {entry.guildId}</span> : null}
                    </li>
                  ))}
                </ul>
              </section>
            ) : null}
          </>
        )}
      </div>
    </div>
  );
}

function StatusRow({ label, hint, value }: { label: string; hint?: string; value: React.ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-4 border-b border-osu-b3/15 py-2 last:border-0">
      <div className="min-w-0">
        <div className="text-osu-l2">{label}</div>
        {hint ? <div className="mt-0.5 text-[10px] leading-snug text-osu-l3">{hint}</div> : null}
      </div>
      <div className="shrink-0 pt-0.5">{value}</div>
    </div>
  );
}

function Pill({ ok, okText = "yes", badText = "no" }: { ok?: boolean; okText?: string; badText?: string }) {
  return (
    <span className={`rounded px-1.5 py-0.5 text-[10px] font-semibold ${ok ? "bg-emerald-500/15 text-emerald-300" : "bg-osu-b3/60 text-osu-l3"}`}>
      {ok ? okText : badText}
    </span>
  );
}
