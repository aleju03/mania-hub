import { createFileRoute, Link, notFound } from "@tanstack/react-router";
import { useCallback, useEffect, useState } from "react";
import { canUseAdminFeatures } from "../../lib/auth-shared";
import { fetchDiscordAdminStatus, runLiveBackendAdminAction } from "../../lib/live-backend";

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

interface DiscordAdminPayload {
  discord: DiscordStatus;
  subscriptions: DiscordSubscription[];
}

const FEED_LABELS: Record<string, string> = { top_play: "Top plays", snipe: "Snipes" };

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
          Discord, and see which channels are receiving live feeds. The public-facing page is at{" "}
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
