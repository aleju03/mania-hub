import { createFileRoute, notFound } from "@tanstack/react-router";
import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { Trans, useLingui } from "@lingui/react/macro";
import { msg } from "@lingui/core/macro";
import { getI18n } from "../lib/i18n";
import { PageHeader } from "../components/layout/PageHeader";
import { DiscordTabs } from "../components/discord/DiscordTabs";
import { canUseDevFeatures } from "../lib/auth-shared";
import { fetchDiscordPublicInfo, type DiscordPublicInfo } from "../lib/live-backend";
import {
  fetchBotAccount,
  fetchBotPreview,
  fetchBotServers,
  linkBotAccount,
  saveBotPreferences,
  unlinkBotAccount,
  updateBotServer,
  type BotAccount,
  type BotServer,
  type BotServerChange,
  type BotServers,
} from "../lib/discord-bot";
import { DiscordLogo, DISCORD_BLURPLE } from "../components/ui/DiscordLogo";
import { Panel } from "../components/companella/primitives";
import { DiscordMessageBodyView, type DiscordMessageJson } from "../components/discord/message/DiscordMessageView";
import { DISCORD } from "../components/discord/message/discord-markdown";
import { pageSeo } from "../lib/seo";

export const Route = createFileRoute("/discord")({
  head: ({ match }) => {
    const i18n = getI18n(match.context.locale);
    return pageSeo({
      title: i18n._(msg`maniabot - Mania Tracker for Discord`),
      appendSiteName: false,
      description: i18n._(msg`An osu!mania bot for Discord.`),
      path: "/discord",
      origin: match.context.origin,
      imageKind: "discord",
      imageTitle: "maniabot - Mania Tracker for Discord",
      noindex: true,
    });
  },
  beforeLoad: ({ context }) => {
    if (!canUseDevFeatures(context.auth)) {
      throw notFound();
    }
    return undefined as never;
  },
  loader: async () => fetchDiscordPublicInfo(),
  component: DiscordToolPage,
});

const BLURPLE = DISCORD_BLURPLE;

// The site theme's own colors, so the page follows whatever theme is picked
// and the banner fades into it.
const SLATE = {
  page: "var(--color-osu-b5)",
};

// Where the banner art comes from, shown as a credit link in its corner.
// Hidden when unset.
const HERO_ART_SOURCE: string | null = "https://www.pixiv.net/en/artworks/83835856";

function DiscordToolPage() {
  const info = Route.useLoaderData();
  const [account, setAccount] = useState<BotAccount | null>(null);

  useEffect(() => {
    void fetchBotAccount().then(setAccount).catch(() => setAccount(null));
  }, []);

  return (
    <div className="relative flex min-h-screen flex-col">
      <div className="relative z-10 flex flex-1 flex-col overflow-clip" style={{ backgroundColor: SLATE.page }}>
        <div className="relative z-10 flex flex-1 flex-col">
          <PageHeader
            iconSrc="/images/icons/chat.svg"
            title="maniabot"
            right={(
              <span className="rounded bg-osu-yellow/15 px-1.5 py-0.5 text-[11px] font-semibold uppercase tracking-wider text-osu-yellow">
                <Trans>dev preview</Trans>
              </span>
            )}
          />

          <DiscordTabs />

          <div className="mx-auto w-full max-w-[960px] flex-1 space-y-6 px-4 py-6 sm:px-5">
            <Hero info={info} />
            {info.configured ? <AccountPanel account={account} onChange={setAccount} /> : null}
            {info.configured ? <ServersPanel account={account} inviteUrl={info.inviteUrl} /> : null}
            {info.configured ? <PreviewPanel /> : null}
            {info.configured ? <CommandsPanel commands={info.commands} /> : null}
          </div>
        </div>
      </div>
    </div>
  );
}

function Hero({ info }: { info: DiscordPublicInfo }) {
  return (
    <section className="relative -mx-4 sm:mx-0">
      {/* The art fades into the page at the bottom only, through a mask on
          the image itself. No scrim layered on top: Chrome anti-aliases a
          rounded clip per layer, and a bright edge leaked past a scrim as a
          light line in the corner. */}
      <img
        src="/images/discord/maniabot-hero-bg.webp"
        alt=""
        className="pointer-events-none absolute inset-0 h-full w-full select-none rounded-t-2xl object-cover object-[50%_35%] opacity-90"
        style={{
          maskImage: "linear-gradient(to bottom, #000 45%, transparent 100%)",
          WebkitMaskImage: "linear-gradient(to bottom, #000 45%, transparent 100%)",
        }}
      />
      {HERO_ART_SOURCE ? (
        <a
          href={HERO_ART_SOURCE}
          target="_blank"
          rel="noreferrer"
          className="absolute right-4 top-3 z-10 inline-flex items-center gap-1 text-[11px] font-semibold uppercase tracking-wider text-white/60 hover:text-white"
        >
          <Trans>Art source</Trans>
          <svg viewBox="0 0 16 16" className="h-3 w-3" aria-hidden>
            <path d="M9 2.5h4.5V7M13.5 2.5 7.5 8.5M6 3.5H3.5v9h9V10" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </a>
      ) : null}
      <div className="relative flex min-h-[240px] flex-col justify-end gap-5 p-5 pt-20 sm:flex-row sm:items-end sm:p-7">
        <img src="/images/discord/bot-avatar.png" alt="" className="h-20 w-20 shrink-0 rounded-full ring-4" style={{ ["--tw-ring-color" as string]: SLATE.page }} />
        <div className="min-w-0 flex-1">
          <h1 className="text-[26px] font-bold text-white">maniabot</h1>
          <p className="mt-0.5 text-[15px] text-white/75">
            <Trans>An osu!mania bot for Discord.</Trans>
          </p>
        </div>
        {info.configured && info.inviteUrl ? (
          <a
            href={info.inviteUrl}
            target="_blank"
            rel="noreferrer"
            className="inline-flex shrink-0 items-center justify-center gap-2 rounded-xl px-6 py-3.5 text-[14px] font-bold text-white hover:brightness-110"
            style={{ backgroundColor: BLURPLE }}
          >
            <DiscordLogo className="h-5 w-5" />
            <Trans>Add to Discord</Trans>
          </a>
        ) : null}
      </div>
      {!info.configured ? <SetupNote /> : null}
    </section>
  );
}

// --- Account -----------------------------------------------------------------

function connectHref(): string {
  return `/api/auth/discord?next=${encodeURIComponent("/discord")}`;
}

function AccountPanel({ account, onChange }: { account: BotAccount | null; onChange: (account: BotAccount) => void }) {
  const [busy, setBusy] = useState(false);
  const run = useCallback(async (work: () => Promise<BotAccount>) => {
    setBusy(true);
    try {
      onChange(await work());
    } finally {
      setBusy(false);
    }
  }, [onChange]);

  if (!account) return <Panel title={<Trans>Your account</Trans>}><div className="h-10" /></Panel>;

  if (!account.signedIn) {
    return (
      <Panel title={<Trans>Your account</Trans>}>
        <p className="text-[14px] text-osu-l2">
          <Trans>Sign in with osu! to link your Discord account, so commands work without typing your name.</Trans>
        </p>
        <a href={`/api/auth/osu?next=${encodeURIComponent("/discord")}`} className="mt-3 inline-flex rounded-lg bg-osu-pink px-4 py-2 text-[13px] font-semibold text-white hover:brightness-110">
          <Trans>Sign in with osu!</Trans>
        </a>
      </Panel>
    );
  }

  const linked = account.links[0] ?? null;
  const connectionLinked = account.connection && account.links.some((link) => link.discordUserId === account.connection?.discordUserId);

  return (
    <Panel title={<Trans>Your account</Trans>}>
      <div className="flex flex-wrap items-center gap-3">
        {account.connection?.discordAvatarUrl ? <img src={account.connection.discordAvatarUrl} alt="" className="h-10 w-10 rounded-full" /> : null}
        <div className="min-w-0 flex-1 text-[14px] text-osu-l2">
          {linked ? (
            <span>
              <Trans>Your Discord account is linked to <span className="font-semibold text-white">{linked.osuUsername}</span>.</Trans>
              {!linked.verified ? <span className="ml-1 text-osu-f1"><Trans>It was linked by typing a username. Connect Discord here to confirm it is you.</Trans></span> : null}
            </span>
          ) : account.connection ? (
            <Trans>Connected as <span className="font-semibold text-white">{account.connection.discordUsername}</span>. Link it to use commands without typing your name.</Trans>
          ) : (
            <Trans>Connect your Discord account to link it.</Trans>
          )}
        </div>
        {account.connection && !connectionLinked ? (
          <button type="button" disabled={busy || !account.oauthConfigured} onClick={() => void run(() => linkBotAccount())} className="rounded-lg px-4 py-2 text-[13px] font-semibold text-white hover:brightness-110 disabled:opacity-50" style={{ backgroundColor: BLURPLE }}>
            <Trans>Link this account</Trans>
          </button>
        ) : null}
        {!account.connection ? (
          <a href={connectHref()} className="inline-flex items-center gap-2 rounded-lg px-4 py-2 text-[13px] font-semibold text-white hover:brightness-110" style={{ backgroundColor: BLURPLE }}>
            <DiscordLogo className="h-4 w-4" />
            <Trans>Connect Discord</Trans>
          </a>
        ) : null}
        {linked ? (
          <button type="button" disabled={busy} onClick={() => void run(() => unlinkBotAccount({ data: { discordUserId: linked.discordUserId } }))} className="text-[12px] font-semibold text-osu-f1 hover:text-rose-300 disabled:opacity-50">
            <Trans>Unlink</Trans>
          </button>
        ) : null}
      </div>

      {linked ? (
        <div className="mt-4 grid gap-4 border-t border-white/[0.07] pt-4 sm:grid-cols-2">
          <div>
            <div className="mb-1.5 text-[13px] font-semibold text-white"><Trans>Keymode</Trans></div>
            <Segmented
              value={account.settings?.defaultKeys ?? "any"}
              disabled={busy}
              options={[{ value: "any", label: <Trans>All keys</Trans> }, { value: "4k", label: "4K" }, { value: "7k", label: "7K" }]}
              onChange={(value) => void run(() => saveBotPreferences({ data: { defaultKeys: value === "4k" || value === "7k" ? value : null } }))}
            />
            <p className="mt-1.5 text-[12px] text-osu-f1"><Trans>Used by /skills and /farm when you don't pick one.</Trans></p>
          </div>
          <div>
            <Toggle
              checked={Boolean(account.settings?.privateReplies)}
              disabled={busy}
              onChange={(value) => void run(() => saveBotPreferences({ data: { privateReplies: value } }))}
              label={<Trans>Private replies</Trans>}
            />
            <p className="mt-1.5 text-[12px] text-osu-f1"><Trans>Only you see the bot's replies to your commands, unless you set hidden to false.</Trans></p>
          </div>
        </div>
      ) : null}
    </Panel>
  );
}

function Segmented<T extends string>({ value, options, onChange, disabled }: { value: T; options: Array<{ value: T; label: ReactNode }>; onChange: (value: T) => void; disabled?: boolean }) {
  return (
    <div className="inline-flex rounded-lg bg-osu-b4 p-0.5">
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          disabled={disabled}
          onClick={() => option.value !== value && onChange(option.value)}
          className={`rounded-md px-3 py-1 text-[13px] font-semibold transition-colors disabled:opacity-60 ${option.value === value ? "bg-osu-pink/15 text-osu-pink-light" : "text-osu-f1 hover:text-white"}`}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

function Toggle({ checked, onChange, label, disabled }: { checked: boolean; onChange: (value: boolean) => void; label?: ReactNode; disabled?: boolean }) {
  return (
    <label className={`inline-flex cursor-pointer select-none items-center gap-2 ${disabled ? "cursor-default opacity-60" : ""}`}>
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        disabled={disabled}
        onClick={() => onChange(!checked)}
        className={`relative h-5 w-9 shrink-0 rounded-full transition-colors ${checked ? "bg-osu-pink" : "bg-osu-b3"}`}
      >
        <span className={`absolute top-0.5 h-4 w-4 rounded-full bg-white transition-[left] ${checked ? "left-[18px]" : "left-0.5"}`} />
      </button>
      {label ? <span className="text-[13px] font-semibold text-white">{label}</span> : null}
    </label>
  );
}

// --- Servers -----------------------------------------------------------------

function ServersPanel({ account, inviteUrl }: { account: BotAccount | null; inviteUrl: string | null }) {
  const [data, setData] = useState<BotServers | null>(null);
  const connected = Boolean(account?.connection);

  useEffect(() => {
    if (!connected) return;
    void fetchBotServers().then(setData).catch(() => setData(null));
  }, [connected]);

  if (!account?.signedIn) return null;

  return (
    <Panel title={<Trans>Your servers</Trans>}>
      {!connected || data?.error === "no_discord" ? (
        <div className="flex flex-wrap items-center gap-3">
          <p className="min-w-0 flex-1 text-[14px] text-osu-l2"><Trans>Connect Discord to set up feeds in servers where you have Manage Server.</Trans></p>
          <a href={connectHref()} className="inline-flex items-center gap-2 rounded-lg px-4 py-2 text-[13px] font-semibold text-white hover:brightness-110" style={{ backgroundColor: BLURPLE }}>
            <DiscordLogo className="h-4 w-4" />
            <Trans>Connect Discord</Trans>
          </a>
        </div>
      ) : !data ? (
        <div className="h-10" />
      ) : !data.ok || !data.available ? (
        <p className="text-[14px] text-osu-f1"><Trans>Server settings aren't available right now.</Trans></p>
      ) : data.servers.length === 0 ? (
        <p className="text-[14px] text-osu-f1"><Trans>You don't manage any Discord servers.</Trans></p>
      ) : (
        <div className="space-y-2">
          {data.servers.map((server) => (
            <ServerRow
              key={server.id}
              server={server}
              feedTypes={data.feedTypes}
              autoDanAvailable={data.autoDanAvailable}
              fallbackCountry={data.defaultCountry}
              inviteUrl={inviteUrl}
              onServer={(next) => setData((current) => current ? { ...current, servers: current.servers.map((s) => s.id === next.id ? next : s) } : current)}
            />
          ))}
        </div>
      )}
    </Panel>
  );
}

const FEED_NAMES: Record<string, ReturnType<typeof msg>> = {
  top_play: msg`Top plays`,
  new_map: msg`New farm maps`,
  changelog: msg`Site updates`,
};

function ServerRow({ server, feedTypes, autoDanAvailable, fallbackCountry, inviteUrl, onServer }: {
  server: BotServer;
  feedTypes: string[];
  autoDanAvailable: boolean;
  fallbackCountry: string;
  inviteUrl: string | null;
  onServer: (server: BotServer) => void;
}) {
  const { i18n } = useLingui();
  const [open, setOpen] = useState(false);
  const [showAll, setShowAll] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const country = server.settings.defaultCountry ?? fallbackCountry;
  const [countryDraft, setCountryDraft] = useState(country);

  const apply = useCallback(async (change: BotServerChange) => {
    setBusy(true);
    setError(null);
    try {
      const result = await updateBotServer({ data: { guildId: server.id, change } });
      if (result.ok && result.server) onServer(result.server);
      else setError(result.error ?? "failed");
    } finally {
      setBusy(false);
    }
  }, [onServer, server.id]);

  const activeChannels = useMemo(() => new Set([
    ...server.subscriptions.map((sub) => sub.channelId),
    ...server.settings.autoDanChannels,
  ]), [server]);
  const channels = showAll ? server.channels : server.channels.filter((channel) => activeChannels.has(channel.id));
  const feedCount = server.subscriptions.length;

  const header = (
    <div className="flex items-center gap-3">
      {server.iconUrl ? <img src={server.iconUrl} alt="" className="h-9 w-9 rounded-full" /> : <span className="flex h-9 w-9 items-center justify-center rounded-full bg-osu-b3 text-[13px] font-bold text-white">{server.name.slice(0, 1)}</span>}
      <div className="min-w-0 flex-1">
        <div className="truncate text-[14px] font-semibold text-white">{server.name}</div>
        <div className="text-[12px] text-osu-f1">
          {server.botPresent
            ? feedCount ? <Trans>{feedCount} feeds</Trans> : <Trans>No feeds yet</Trans>
            : <Trans>The bot isn't in this server</Trans>}
        </div>
      </div>
      {server.botPresent ? (
        <button type="button" onClick={() => setOpen((value) => !value)} className="rounded-lg bg-osu-b3 px-3 py-1.5 text-[12px] font-semibold text-white hover:brightness-110">
          {open ? <Trans>Close</Trans> : <Trans>Set up</Trans>}
        </button>
      ) : inviteUrl ? (
        <a href={`${inviteUrl}&guild_id=${server.id}&disable_guild_select=true`} target="_blank" rel="noreferrer" className="rounded-lg px-3 py-1.5 text-[12px] font-semibold text-white hover:brightness-110" style={{ backgroundColor: BLURPLE }}>
          <Trans>Add the bot</Trans>
        </a>
      ) : null}
    </div>
  );

  return (
    <div className="rounded-xl bg-osu-b4 p-3">
      {header}
      {open && server.botPresent ? (
        <div className="mt-3 space-y-3 border-t border-white/[0.07] pt-3">
          <div className="flex flex-wrap items-center gap-2 text-[13px] text-osu-l2">
            <span className="font-semibold text-white"><Trans>Country for top plays</Trans></span>
            <input
              value={countryDraft}
              onChange={(event) => setCountryDraft(event.target.value.toUpperCase().slice(0, 6))}
              className="w-20 rounded-md bg-osu-b5 px-2 py-1 text-[13px] text-white outline-none focus:ring-1 focus:ring-osu-pink/60"
              placeholder="CR"
            />
            <button
              type="button"
              disabled={busy || countryDraft === country || !countryDraft}
              onClick={() => void apply({ defaultCountry: countryDraft })}
              className="rounded-md bg-osu-b3 px-2.5 py-1 text-[12px] font-semibold text-white hover:brightness-110 disabled:opacity-40"
            >
              <Trans>Save</Trans>
            </button>
            <span className="text-[12px] text-osu-f1"><Trans>A 2-letter code, or GLOBAL for every country.</Trans></span>
          </div>

          <div className="overflow-x-auto">
            <table className="w-full text-[13px]">
              <thead>
                <tr className="text-left text-[12px] text-osu-f1">
                  <th className="py-1.5 pr-3 font-semibold"><Trans>Channel</Trans></th>
                  {feedTypes.map((feed) => <th key={feed} className="px-2 py-1.5 text-center font-semibold">{FEED_NAMES[feed] ? i18n._(FEED_NAMES[feed]) : feed}</th>)}
                  {autoDanAvailable ? <th className="px-2 py-1.5 text-center font-semibold"><Trans>Dan on score posts</Trans></th> : null}
                </tr>
              </thead>
              <tbody>
                {channels.map((channel) => (
                  <tr key={channel.id} className="border-t border-white/[0.05]">
                    <td className="py-1.5 pr-3 text-white">
                      <span className="text-osu-f1">#</span>{channel.name}
                      {channel.category ? <span className="ml-2 text-[11px] text-osu-f1">{channel.category}</span> : null}
                    </td>
                    {feedTypes.map((feed) => {
                      const sub = server.subscriptions.find((s) => s.channelId === channel.id && s.feedType === feed);
                      return (
                        <td key={feed} className="px-2 py-1.5 text-center">
                          <div className="inline-flex items-center gap-1.5">
                            <Toggle checked={Boolean(sub)} disabled={busy} onChange={(on) => void apply({ feed: { channelId: channel.id, feedType: feed, on, country } })} />
                            {sub && feed === "top_play" ? <span className="text-[11px] text-osu-f1">{sub.country === "GLOBAL" ? i18n._(msg`Global`) : sub.country}</span> : null}
                          </div>
                        </td>
                      );
                    })}
                    {autoDanAvailable ? (
                      <td className="px-2 py-1.5 text-center">
                        <Toggle
                          checked={server.settings.autoDanChannels.includes("*") || server.settings.autoDanChannels.includes(channel.id)}
                          disabled={busy || server.settings.autoDanChannels.includes("*")}
                          onChange={(on) => void apply({ autoDan: { channelId: channel.id, on } })}
                        />
                      </td>
                    ) : null}
                  </tr>
                ))}
              </tbody>
            </table>
            {channels.length === 0 ? <p className="py-2 text-[13px] text-osu-f1"><Trans>No channel has a feed yet.</Trans></p> : null}
          </div>
          <div className="flex flex-wrap items-center gap-3">
            {server.channels.length > channels.length || showAll ? (
              <button type="button" onClick={() => setShowAll((value) => !value)} className="text-[12px] font-semibold text-osu-pink-light hover:text-white">
                {showAll ? <Trans>Only channels with something on</Trans> : <Trans>All {server.channels.length} channels</Trans>}
              </button>
            ) : null}
            {autoDanAvailable ? (
              <Toggle
                checked={server.settings.autoDanChannels.includes("*")}
                disabled={busy}
                onChange={(on) => void apply({ autoDan: { channelId: "*", on } })}
                label={<Trans>Dan on score posts in every channel</Trans>}
              />
            ) : null}
            {error ? <span className="text-[12px] text-rose-300"><Trans>That didn't save. Try again.</Trans></span> : null}
          </div>
        </div>
      ) : null}
    </div>
  );
}

// --- Previews ----------------------------------------------------------------

const PREVIEWS: Array<{ id: string; label: ReturnType<typeof msg> }> = [
  { id: "profile", label: msg`/profile` },
  { id: "skills", label: msg`/skills` },
  { id: "map", label: msg`/map` },
  { id: "challenge", label: msg`/challenge` },
  { id: "help", label: msg`/help` },
];

function PreviewPanel() {
  const { i18n } = useLingui();
  const [view, setView] = useState("profile");
  const [messages, setMessages] = useState<Record<string, DiscordMessageJson | null | undefined>>({});

  useEffect(() => {
    if (messages[view] !== undefined) return;
    let cancelled = false;
    void fetchBotPreview({ data: { view } }).then((result) => {
      if (!cancelled) setMessages((current) => ({ ...current, [view]: result.message }));
    }).catch(() => {
      if (!cancelled) setMessages((current) => ({ ...current, [view]: null }));
    });
    return () => {
      cancelled = true;
    };
  }, [messages, view]);

  const message = messages[view];
  return (
    <Panel title={<Trans>Previews</Trans>}>
      <div className="mb-3 flex flex-wrap gap-1.5">
        {PREVIEWS.map((preview) => (
          <button
            key={preview.id}
            type="button"
            onClick={() => setView(preview.id)}
            className={`rounded-lg px-3 py-1.5 text-[13px] font-semibold transition-colors ${preview.id === view ? "bg-osu-pink/15 text-osu-pink-light" : "bg-osu-b4 text-osu-f1 hover:text-white"}`}
          >
            {i18n._(preview.label)}
          </button>
        ))}
      </div>
      <div className="overflow-hidden rounded-xl p-4" style={{ backgroundColor: DISCORD.msg, fontFamily: DISCORD.font }}>
        <div className="flex gap-4">
          <img src="/images/discord/bot-avatar.png" alt="" className="h-10 w-10 shrink-0 rounded-full" />
          <div className="min-w-0 flex-1">
            <div className="flex items-baseline gap-1.5">
              <span className="text-[16px] font-medium" style={{ color: DISCORD.white }}>maniabot</span>
              <span className="rounded-[3px] px-1 text-[10px] font-semibold leading-[15px] text-white" style={{ backgroundColor: BLURPLE }}>APP</span>
            </div>
            <div className="mt-1 min-h-[120px]">
              {message === undefined ? null : message ? (
                <DiscordMessageBodyView body={message} />
              ) : (
                <p className="text-[14px]" style={{ color: DISCORD.muted }}><Trans>This preview isn't available right now.</Trans></p>
              )}
            </div>
          </div>
        </div>
      </div>
    </Panel>
  );
}

// --- Commands ----------------------------------------------------------------

function CommandsPanel({ commands }: { commands: DiscordPublicInfo["commands"] }) {
  const slash = commands.filter((command) => command.description);
  const menus = commands.filter((command) => !command.description);
  return (
    <Panel title={<Trans>Commands</Trans>}>
      <div className="grid gap-x-6 gap-y-1.5 sm:grid-cols-2">
        {slash.map((command) => (
          <div key={command.name} className="flex gap-2 text-[13px]">
            <code className="shrink-0 font-semibold text-osu-pink-light">/{command.name}</code>
            <span className="text-osu-l2">{command.description}</span>
          </div>
        ))}
      </div>
      {menus.length ? (
        <p className="mt-3 text-[13px] text-osu-f1">
          <Trans>Right-click a message or a user, then Apps:</Trans>{" "}
          {menus.map((command, index) => (
            <span key={command.name}>
              {index ? ", " : ""}
              <span className="font-semibold text-osu-l2">{command.name}</span>
            </span>
          ))}
        </p>
      ) : null}
    </Panel>
  );
}

function SetupNote() {
  // Operator-facing (backend env vars + admin dashboard steps), so it stays
  // English like the rest of the admin surfaces.
  return (
    <div className="relative border-t border-white/[0.07] p-5 sm:p-6">
      <div className="flex items-center gap-2">
        <span className="h-2 w-2 rounded-full bg-osu-yellow" />
        <span className="text-[13px] font-semibold text-white">Not connected yet</span>
      </div>
      <p className="mt-1 text-[13px] text-osu-l2">
        Set these on the live backend, then register the commands from the admin dashboard:
      </p>
      <ul className="mt-2 space-y-1 text-[12px] text-osu-l2">
        <li><code className="text-osu-pink-light">ENABLE_DISCORD_BOT=true</code></li>
        <li><code className="text-osu-pink-light">DISCORD_APPLICATION_ID</code>, <code className="text-osu-pink-light">DISCORD_PUBLIC_KEY</code>, <code className="text-osu-pink-light">DISCORD_BOT_TOKEN</code></li>
      </ul>
    </div>
  );
}
