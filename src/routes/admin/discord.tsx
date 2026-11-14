import { createFileRoute, Link, notFound } from "@tanstack/react-router";
import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { PageHeader } from "../../components/layout/PageHeader";
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
  linkCount?: number;
}

interface DiscordGuild {
  id: string;
  name: string;
  iconUrl: string | null;
  memberCount: number | null;
}

const FEED_LABELS: Record<string, string> = { top_play: "Top plays", snipe: "Snipes", new_map: "New farm maps" };

// Past this many servers the list leaves the top row for a section of its own
// with a search field.
const SERVERS_INLINE_MAX = 6;
const SERVERS_COLLAPSED = 30;
const FEEDS_COLLAPSED = 8;
const LATEST_COLLAPSED = 8;

type Notice = { tone: "good" | "bad"; text: string; where: "top" | "feeds" | "maintenance" };
type ServerSort = "biggest" | "feeds";

function DiscordAdminPage() {
  const [data, setData] = useState<DiscordAdminPayload | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<Notice | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const result = (await fetchDiscordAdminStatus()) as DiscordAdminPayload;
      setData(result);
      setNotice((current) => (current?.where === "top" ? null : current));
    } catch (err) {
      setNotice({ tone: "bad", text: err instanceof Error ? err.message : String(err), where: "top" });
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const registerCommands = useCallback(async () => {
    setBusy(true);
    setNotice(null);
    try {
      const res = await runLiveBackendAdminAction({ data: { path: "/api/admin/discord/register-commands" } });
      const body = res.body ? (JSON.parse(res.body) as { ok?: boolean; global?: number; guild?: number | null; error?: string }) : null;
      if (body && body.ok === false) {
        setNotice({ tone: "bad", text: body.error ?? "Registration failed.", where: "maintenance" });
      } else {
        const guildNote = body?.guild != null ? ` and ${body.guild} to the dev guild` : "";
        setNotice({ tone: "good", text: `Registered ${body?.global ?? "all"} global commands${guildNote}. Global commands can take up to an hour to appear.`, where: "maintenance" });
      }
    } catch (err) {
      setNotice({ tone: "bad", text: err instanceof Error ? err.message : String(err), where: "maintenance" });
    } finally {
      setBusy(false);
    }
  }, []);

  const registerEmojis = useCallback(async (force = false) => {
    setBusy(true);
    setNotice(null);
    try {
      const path = force ? "/api/admin/discord/register-emojis?force=1" : "/api/admin/discord/register-emojis";
      const res = await runLiveBackendAdminAction({ data: { path } });
      const body = res.body
        ? (JSON.parse(res.body) as { ok?: boolean; total?: number; created?: number; reused?: number; failed?: number; error?: string })
        : null;
      if (body && body.ok === false) {
        setNotice({ tone: "bad", text: body.error ?? "Emoji registration failed.", where: "maintenance" });
      } else {
        const failedNote = body?.failed ? `, ${body.failed} failed` : "";
        setNotice({ tone: "good", text: `Registered emojis: ${body?.created ?? 0} new, ${body?.reused ?? 0} reused${failedNote} of ${body?.total ?? 0}.`, where: "maintenance" });
      }
    } catch (err) {
      setNotice({ tone: "bad", text: err instanceof Error ? err.message : String(err), where: "maintenance" });
    } finally {
      setBusy(false);
    }
  }, []);

  const removeSubscription = useCallback(async (id: number) => {
    setBusy(true);
    setNotice(null);
    try {
      await runLiveBackendAdminAction({ data: { path: `/api/admin/discord/remove-subscription?id=${id}` } });
      setNotice({ tone: "good", text: "Feed removed.", where: "feeds" });
      await load();
    } catch (err) {
      setNotice({ tone: "bad", text: err instanceof Error ? err.message : String(err), where: "feeds" });
    } finally {
      setBusy(false);
    }
  }, [load]);

  const status = data?.discord;
  const subscriptions = data?.subscriptions ?? [];

  const [guilds, setGuilds] = useState<DiscordGuild[] | null>(null);
  const [channels, setChannels] = useState<Record<string, string>>({});
  const [guildsLoading, setGuildsLoading] = useState(false);
  const [guildsError, setGuildsError] = useState<string | null>(null);

  const loadGuilds = useCallback(async () => {
    setGuildsLoading(true);
    setGuildsError(null);
    try {
      const res = (await fetchDiscordGuilds()) as { ok?: boolean; guilds?: DiscordGuild[]; channels?: Record<string, string>; error?: string };
      if (res.ok === false) {
        setGuildsError(res.error ?? "Could not load servers.");
      } else {
        setGuilds(res.guilds ?? []);
        setChannels(res.channels ?? {});
      }
    } catch (err) {
      setGuildsError(err instanceof Error ? err.message : String(err));
    } finally {
      setGuildsLoading(false);
    }
  }, []);

  // The server list comes live from Discord, so it loads once the bot is known
  // to have a token and again only on Refresh.
  const botReady = Boolean(status?.enabled && status?.hasBotToken);
  useEffect(() => {
    if (botReady) void loadGuilds();
  }, [botReady, loadGuilds]);

  const refresh = () => {
    void load();
    if (botReady) void loadGuilds();
  };

  const guildNames = useMemo(() => new Map((guilds ?? []).map((guild) => [guild.id, guild.name])), [guilds]);
  const feedsByGuild = useMemo(() => {
    const counts = new Map<string, number>();
    for (const sub of subscriptions) if (sub.guildId) counts.set(sub.guildId, (counts.get(sub.guildId) ?? 0) + 1);
    return counts;
  }, [subscriptions]);

  const usage = Object.entries(status?.commandCounts ?? {}).sort((a, b) => b[1] - a[1]);
  const commandsRun = usage.reduce((sum, [, count]) => sum + count, 0);
  const latest = [...(status?.recentInteractions ?? [])].reverse();
  const problems = status
    ? [
        status.configured ? null : "Discord can't reach the bot",
        status.hasBotToken ? null : "Bot token missing",
        status.feedsEnabled ? null : "Feeds are off",
      ].filter((entry): entry is string => entry !== null)
    : [];
  const serversInline = guilds !== null && guilds.length <= SERVERS_INLINE_MAX;

  const header = (
    <PageHeader
      iconSrc="/images/icons/chat.svg"
      title="Discord bot"
      right={
        <div className="flex items-center gap-3">
          <Link to="/admin/discord-playground" className="text-[12px] font-semibold text-osu-pink-light hover:text-white">Playground</Link>
          <Link to="/discord" className="text-[12px] font-semibold text-osu-pink-light hover:text-white">Bot page</Link>
          <SmallButton onClick={refresh} disabled={loading || busy || guildsLoading}>Refresh</SmallButton>
        </div>
      }
    />
  );

  if (!data || !status?.enabled) {
    return (
      <div className="min-h-[calc(100vh-60px)] flex-1 bg-osu-b5">
        {header}
        <div className="mx-auto max-w-[1200px] px-4 py-8 text-[14px] text-osu-f1 sm:px-5">
          {notice?.where === "top" ? (
            <NoticeLine notice={notice} />
          ) : loading && !data ? (
            "Loading…"
          ) : data ? (
            <>
              The bot is not enabled on the live backend. Set <code className="text-osu-pink-light">ENABLE_DISCORD_BOT=true</code> with the
              application id, public key and bot token, then restart the backend.
            </>
          ) : null}
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-[calc(100vh-60px)] flex-1 bg-osu-b5">
      {header}

      <div className="relative overflow-hidden">
        <img src="/images/discord/maniabot-hero-bg.webp" alt="" className="pointer-events-none absolute inset-0 h-full w-full select-none object-cover object-[50%_35%]" />
        <div
          className="absolute inset-0"
          style={{ background: "linear-gradient(90deg, color-mix(in srgb, var(--color-osu-b5) 96%, transparent) 30%, color-mix(in srgb, var(--color-osu-b5) 55%, transparent))" }}
        />
        <div className="relative mx-auto flex max-w-[1200px] flex-wrap items-center gap-x-5 gap-y-6 px-4 py-9 sm:px-5">
          <img src="/images/discord/bot-avatar.png" alt="" width={72} height={72} className="h-[72px] w-[72px] shrink-0 rounded-full" />
          <div className="min-w-0 flex-1">
            <div className="text-[28px] font-bold leading-tight text-white">maniabot</div>
            <div className="mt-1 flex items-center gap-2 text-[14px] text-white">
              <span className={`h-2 w-2 shrink-0 rounded-full ${problems.length ? "bg-rose-300" : "bg-emerald-300"}`} />
              {problems.length ? problems.join(", ") : "Everything is running"}
            </div>
          </div>
          <div className="flex flex-wrap gap-x-9 gap-y-4 sm:text-right">
            <Stat label="Servers" value={guilds ? guilds.length : "-"} />
            <Stat label="Linked" value={data.linkCount ?? 0} />
            <Stat label="Feeds" value={subscriptions.length} />
            <Stat label="Commands run" value={commandsRun} />
            <Stat label="Errors" value={status.errorCount ?? 0} bad={(status.errorCount ?? 0) > 0} />
          </div>
        </div>
      </div>

      <div className="mx-auto max-w-[1200px] px-4 pb-16 pt-7 sm:px-5">
        {notice?.where === "top" ? <div className="mb-6"><NoticeLine notice={notice} /></div> : null}

        <div className={`grid gap-x-10 gap-y-8 ${serversInline ? "lg:grid-cols-[1.1fr_1.2fr_0.9fr]" : "lg:grid-cols-2"}`}>
          <div>
            <Heading>Most used</Heading>
            {usage.length === 0 ? (
              <Quiet>No commands since the restart.</Quiet>
            ) : (
              usage.map(([name, count]) => (
                <div key={name} className="grid grid-cols-[110px_1fr_56px] items-center gap-2.5 py-[5px] text-[14px]">
                  <span className="truncate font-semibold text-osu-pink-light">/{name}</span>
                  <span className="block h-1.5 rounded-full bg-osu-pink/85" style={{ width: `${Math.max(2, (count / usage[0][1]) * 100)}%` }} />
                  <span className="text-right tabular-nums text-white">{count.toLocaleString("en-US")}</span>
                </div>
              ))
            )}
          </div>

          <div>
            <Heading>Latest</Heading>
            {latest.length === 0 ? (
              <Quiet>No commands since the restart.</Quiet>
            ) : (
              <Collapsible total={latest.length} collapsed={LATEST_COLLAPSED}>
                {(limit) => (
                  <Rows>
                    {latest.slice(0, limit).map((entry, index) => (
                      <div key={`${entry.at}-${index}`} className="flex items-center gap-3 py-2 text-[14px]">
                        <span className="w-[110px] shrink-0 truncate font-semibold text-osu-pink-light">/{entry.command}</span>
                        <span className="min-w-0 flex-1 truncate text-white">
                          {entry.guildId ? guildNames.get(entry.guildId) ?? <span className="font-mono text-[12px] text-osu-f1">{entry.guildId}</span> : "Direct message"}
                        </span>
                        <span className="shrink-0 tabular-nums text-osu-f1">{new Date(entry.at).toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", hour12: false })}</span>
                      </div>
                    ))}
                  </Rows>
                )}
              </Collapsible>
            )}
          </div>

          {serversInline ? (
            <div>
              <Heading count={guilds?.length}>Servers</Heading>
              {guilds && guilds.length ? <Rows>{guilds.map((guild) => <ServerRow key={guild.id} guild={guild} />)}</Rows> : <Quiet>The bot isn't in any server yet.</Quiet>}
            </div>
          ) : null}
        </div>

        {!serversInline ? (
          <ServersSection guilds={guilds} error={status.hasBotToken ? guildsError : "Set DISCORD_BOT_TOKEN on the backend to list servers."} feedsByGuild={feedsByGuild} />
        ) : null}

        <FeedsSection
          subscriptions={subscriptions}
          guildNames={guildNames}
          channels={channels}
          busy={busy}
          onRemove={(id) => void removeSubscription(id)}
          notice={notice?.where === "feeds" ? notice : null}
        />

        <section className="mt-7 border-t border-white/[0.07] pt-5">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-3">
            <h3 className="text-xs font-semibold uppercase tracking-wider text-osu-f1">Maintenance</h3>
            <span className="min-w-0 flex-1 text-[13px] text-osu-f1">
              {status.commandCount ?? 0} commands, {status.devGuildId ? "sent to the dev guild" : "sent to every server"}
            </span>
            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                onClick={() => void registerCommands()}
                disabled={busy || !status.hasBotToken}
                title="Needed after adding, renaming or removing a command."
                className="rounded-lg bg-osu-pink px-3.5 py-2 text-[13px] font-semibold text-osu-b6 hover:brightness-110 disabled:opacity-50"
              >
                Register commands
              </button>
              <button
                type="button"
                onClick={() => void registerEmojis()}
                disabled={busy || !status.hasBotToken}
                title="Uploads the grade and mod icons the replies use. Existing emojis are reused."
                className="rounded-lg bg-osu-b3 px-3.5 py-2 text-[13px] font-semibold text-white hover:brightness-110 disabled:opacity-50"
              >
                Register emojis
              </button>
              <button
                type="button"
                onClick={() => void registerEmojis(true)}
                disabled={busy || !status.hasBotToken}
                title="Deletes and re-uploads every emoji so changed art takes effect."
                className="rounded-lg bg-osu-b3 px-3.5 py-2 text-[13px] font-semibold text-white hover:brightness-110 disabled:opacity-50"
              >
                Replace art
              </button>
            </div>
          </div>
          {notice?.where === "maintenance" ? <div className="mt-3"><NoticeLine notice={notice} /></div> : null}
          <div className="mt-4 flex flex-wrap gap-x-8 gap-y-2 text-[12px] text-osu-f1">
            <span>Application <span className="ml-1.5 font-mono text-white">{status.applicationId ?? "-"}</span></span>
            {status.devGuildId ? <span>Dev guild <span className="ml-1.5 font-mono text-white">{status.devGuildId}</span></span> : null}
          </div>
        </section>
      </div>
    </div>
  );
}

function ServersSection({ guilds, error, feedsByGuild }: { guilds: DiscordGuild[] | null; error: string | null; feedsByGuild: Map<string, number> }) {
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<ServerSort>("biggest");
  const needle = query.trim().toLowerCase();
  const shown = (guilds ?? [])
    .filter((guild) => (sort === "feeds" ? feedsByGuild.has(guild.id) : true))
    .filter((guild) => !needle || guild.name.toLowerCase().includes(needle) || guild.id.includes(needle));

  return (
    <section className="mt-7 border-t border-white/[0.07] pt-5">
      <div className="mb-3 flex flex-wrap items-center gap-x-3 gap-y-2">
        <div className="min-w-0 flex-1"><Heading count={guilds?.length} flush>Servers</Heading></div>
        {guilds && guilds.length ? (
          <>
            <div className="inline-flex rounded-lg bg-osu-b4 p-0.5">
              {(["biggest", "feeds"] as const).map((value) => (
                <button
                  key={value}
                  type="button"
                  onClick={() => setSort(value)}
                  className={`rounded-md px-3 py-1 text-[13px] font-semibold transition-colors ${sort === value ? "bg-osu-pink/15 text-osu-pink-light" : "text-osu-f1 hover:text-white"}`}
                >
                  {value === "biggest" ? "Biggest" : "With feeds"}
                </button>
              ))}
            </div>
            <SearchField value={query} onChange={setQuery} placeholder="Find a server" />
          </>
        ) : null}
      </div>
      {error ? (
        <p className="text-[14px] text-rose-300">{error}</p>
      ) : guilds === null ? (
        <Quiet>Loading…</Quiet>
      ) : shown.length === 0 ? (
        <Quiet>{guilds.length ? "No server matches." : "The bot isn't in any server yet."}</Quiet>
      ) : (
        <Collapsible total={shown.length} collapsed={SERVERS_COLLAPSED}>
          {(limit) => (
            <div className="grid gap-x-10 sm:grid-cols-2 lg:grid-cols-3">
              {shown.slice(0, limit).map((guild) => (
                <div key={guild.id} className="border-b border-white/[0.07]">
                  <ServerRow guild={guild} />
                </div>
              ))}
            </div>
          )}
        </Collapsible>
      )}
    </section>
  );
}

function FeedsSection({ subscriptions, guildNames, channels, busy, onRemove, notice }: {
  subscriptions: DiscordSubscription[];
  guildNames: Map<string, string>;
  channels: Record<string, string>;
  busy: boolean;
  onRemove: (id: number) => void;
  notice: Notice | null;
}) {
  const [query, setQuery] = useState("");
  const needle = query.trim().toLowerCase();
  const rows = subscriptions.map((sub) => ({
    sub,
    server: sub.guildId ? guildNames.get(sub.guildId) ?? null : null,
    channel: channels[sub.channelId] ?? null,
  }));
  const shown = needle
    ? rows.filter((row) => [row.server, row.channel, row.sub.guildId, row.sub.channelId].some((text) => text?.toLowerCase().includes(needle)))
    : rows;

  return (
    <section className="mt-7 border-t border-white/[0.07] pt-5">
      <div className="mb-3 flex flex-wrap items-center gap-x-3 gap-y-2">
        <div className="min-w-0 flex-1"><Heading count={subscriptions.length} flush>Feeds</Heading></div>
        {subscriptions.length > FEEDS_COLLAPSED ? <SearchField value={query} onChange={setQuery} placeholder="Find a server or channel" /> : null}
      </div>
      {notice ? <div className="mb-3"><NoticeLine notice={notice} /></div> : null}
      {shown.length === 0 ? (
        <Quiet>{subscriptions.length ? "No feed matches." : "No channel has a feed yet."}</Quiet>
      ) : (
        <Collapsible total={shown.length} collapsed={FEEDS_COLLAPSED}>
          {(limit) => (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[640px] text-left text-[14px]">
                <thead className="text-[11px] uppercase tracking-wider text-osu-f1">
                  <tr>
                    <th className="pb-2 pr-3 font-semibold">Server</th>
                    <th className="pb-2 pr-3 font-semibold">Channel</th>
                    <th className="pb-2 pr-3 font-semibold">Feed</th>
                    <th className="pb-2 pr-3 font-semibold">Country</th>
                    <th className="pb-2 pr-3 font-semibold">Min pp</th>
                    <th className="pb-2" />
                  </tr>
                </thead>
                <tbody className="text-white">
                  {shown.slice(0, limit).map(({ sub, server, channel }) => (
                    <tr key={sub.id} className="border-t border-white/[0.07]">
                      <td className="py-2 pr-3">{server ?? <span className="font-mono text-[12px] text-osu-f1">{sub.guildId ?? "-"}</span>}</td>
                      <td className="py-2 pr-3 text-osu-f1">{channel ? `#${channel}` : <span className="font-mono text-[12px]">{sub.channelId}</span>}</td>
                      <td className="py-2 pr-3">{FEED_LABELS[sub.feedType] ?? sub.feedType}</td>
                      <td className="py-2 pr-3">{sub.country.toUpperCase() === "GLOBAL" ? "Global" : sub.country}</td>
                      <td className="py-2 pr-3 tabular-nums">{sub.minPp > 0 ? sub.minPp : <span className="text-osu-f1">Any</span>}</td>
                      <td className="py-2 text-right">
                        <button
                          type="button"
                          onClick={() => onRemove(sub.id)}
                          disabled={busy}
                          className="rounded-lg bg-osu-b4 px-2.5 py-1 text-[12px] font-semibold text-rose-300 hover:brightness-110 disabled:opacity-50"
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
        </Collapsible>
      )}
    </section>
  );
}

function ServerRow({ guild }: { guild: DiscordGuild }) {
  return (
    <div className="flex items-center gap-3 py-2 text-[14px]">
      {guild.iconUrl ? (
        <img src={guild.iconUrl} alt="" className="h-7 w-7 shrink-0 rounded-full object-cover" loading="lazy" />
      ) : (
        <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-osu-b3 text-[12px] font-bold text-osu-l2">
          {guild.name.slice(0, 1).toUpperCase()}
        </span>
      )}
      <span className="min-w-0 flex-1 truncate text-white" title={guild.name}>{guild.name}</span>
      {guild.memberCount != null ? <span className="shrink-0 tabular-nums text-osu-f1">{guild.memberCount.toLocaleString("en-US")}</span> : null}
    </div>
  );
}

// Shows the first rows of a long list with a button for the rest.
function Collapsible({ total, collapsed, children }: { total: number; collapsed: number; children: (limit: number) => ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      {children(open ? total : collapsed)}
      {total > collapsed ? (
        <div className="mt-3.5">
          <SmallButton onClick={() => setOpen((value) => !value)}>{open ? "Show fewer" : `Show all ${total.toLocaleString("en-US")}`}</SmallButton>
        </div>
      ) : null}
    </>
  );
}

function Rows({ children }: { children: ReactNode }) {
  return <div className="divide-y divide-white/[0.07]">{children}</div>;
}

function Heading({ children, count, flush }: { children: ReactNode; count?: number; flush?: boolean }) {
  return (
    <h3 className={`text-xs font-semibold uppercase tracking-wider text-osu-f1 ${flush ? "" : "mb-3"}`}>
      {children}
      {count != null ? <span className="ml-1.5 text-white">{count.toLocaleString("en-US")}</span> : null}
    </h3>
  );
}

function Stat({ label, value, bad }: { label: string; value: number | string; bad?: boolean }) {
  return (
    <div>
      <div className={`text-[30px] font-bold leading-none tabular-nums ${bad ? "text-rose-300" : "text-white"}`}>
        {typeof value === "number" ? value.toLocaleString("en-US") : value}
      </div>
      <div className="mt-1.5 text-[12px] text-osu-f1">{label}</div>
    </div>
  );
}

function Quiet({ children }: { children: ReactNode }) {
  return <p className="text-[14px] text-osu-f1">{children}</p>;
}

function NoticeLine({ notice }: { notice: Notice }) {
  return <p className={`text-[14px] ${notice.tone === "bad" ? "text-rose-300" : "text-emerald-300"}`}>{notice.text}</p>;
}

function SmallButton({ onClick, disabled, children }: { onClick: () => void; disabled?: boolean; children: ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className="rounded-lg bg-osu-b4 px-2.5 py-1 text-[12px] font-semibold text-osu-f1 transition-colors hover:text-white disabled:opacity-50"
    >
      {children}
    </button>
  );
}

function SearchField({ value, onChange, placeholder }: { value: string; onChange: (value: string) => void; placeholder: string }) {
  return (
    <input
      value={value}
      onChange={(event) => onChange(event.target.value.slice(0, 60))}
      placeholder={placeholder}
      className="w-56 rounded-lg bg-white/[0.07] px-3 py-1.5 text-[13px] text-white outline-none placeholder:text-osu-f1 focus:ring-1 focus:ring-osu-pink/60"
    />
  );
}
