import { createFileRoute, notFound } from "@tanstack/react-router";
import { Fragment, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { Plural, Trans, useLingui } from "@lingui/react/macro";
import { msg } from "@lingui/core/macro";
import { ChevronDown, CircleHelp, Globe, Plus, X } from "lucide-react";
import { getI18n } from "../lib/i18n";
import { PageHeader } from "../components/layout/PageHeader";
import { DiscordTabs } from "../components/discord/DiscordTabs";
import { canUseDevFeatures } from "../lib/auth-shared";
import { fetchDiscordPublicInfo, fetchLiveUserSearch, type DiscordPublicInfo, type LiveUserSearchEntry } from "../lib/live-backend";
import {
  fetchBotAccount,
  fetchBotPreview,
  fetchBotServers,
  linkBotAccount,
  saveBotAlerts,
  saveBotPreferences,
  testBotAlerts,
  unlinkBotAccount,
  updateBotServer,
  type BotAccount,
  type BotAlerts,
  type BotAlertsPatch,
  type BotFeedPlayer,
  type BotServer,
  type BotServerChange,
  type BotServers,
} from "../lib/discord-bot";
import { DiscordLogo, DISCORD_BLURPLE } from "../components/ui/DiscordLogo";
import { FeedPlayersModal } from "../components/discord/FeedPlayersModal";
import { findRegionByCountries } from "../lib/regions";
import { COUNTRY_OPTIONS, displayCountryName, getCountryFlagUrl } from "../lib/country";
import type { AppLocale } from "../lib/locale";
import { useNoDans } from "../store";
import { Panel } from "../components/companella/primitives";
import { DiscordMessageBodyView, type DiscordMessageJson } from "../components/discord/message/DiscordMessageView";
import { DISCORD } from "../components/discord/message/discord-markdown";
import { StarRangePill } from "../components/maps/StarRangePill";
import { SelectMenu } from "../components/ui/SelectMenu";
import { danScaleImage, danScaleLabel, type DanScaleContext } from "../lib/dan-images";
import { pageSeo } from "../lib/seo";
import { KOFI_PAGE_URL } from "../lib/support-links";

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
  // The /profile preview loads with the page, so it is there on first paint.
  // A slow render is left to the client rather than holding the page.
  loader: async () => {
    const [info, profilePreview] = await Promise.all([
      fetchDiscordPublicInfo(),
      Promise.race([
        fetchBotPreview({ data: { view: "profile" } }).then((result) => result.message).catch(() => null),
        new Promise<null>((resolve) => setTimeout(() => resolve(null), PRELOAD_PREVIEW_TIMEOUT_MS)),
      ]),
    ]);
    return { info, profilePreview };
  },
  component: DiscordToolPage,
});

const PRELOAD_PREVIEW_TIMEOUT_MS = 1500;

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
  const { info, profilePreview } = Route.useLoaderData();
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
          />

          <DiscordTabs />

          <div className="mx-auto w-full max-w-[960px] flex-1 space-y-6 px-4 py-6 sm:px-5">
            <Hero info={info} />
            {info.configured ? <AccountPanel account={account} onChange={setAccount} /> : null}
            {info.configured ? <ServersPanel account={account} inviteUrl={info.inviteUrl} /> : null}
            {info.configured ? <PreviewPanel initialProfile={profilePreview} /> : null}
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
      {/* Phones get their own taller crop; the wide banner zoomed into a
          narrow box shows a blurry slice. */}
      <picture>
        <source media="(max-width: 639px)" srcSet="/images/discord/maniabot-hero-bg-mobile.webp" />
        <img
          src="/images/discord/maniabot-hero-bg.webp"
          alt=""
          className="pointer-events-none absolute inset-0 h-full w-full select-none rounded-t-2xl object-cover object-[50%_35%] opacity-90 max-sm:object-[50%_20%]"
          style={{
            maskImage: "linear-gradient(to bottom, #000 45%, transparent 100%)",
            WebkitMaskImage: "linear-gradient(to bottom, #000 45%, transparent 100%)",
          }}
        />
      </picture>
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
      {info.unreachable ? <UnreachableNote /> : !info.configured ? <SetupNote /> : null}
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

  if (!account) {
    return (
      <Panel title={<Trans>Your account</Trans>}>
        <div className="flex animate-pulse items-center gap-3">
          <span className="h-10 w-10 rounded-full bg-osu-b4" />
          <span className="h-3.5 w-72 max-w-[60%] rounded bg-osu-b4" />
        </div>
      </Panel>
    );
  }

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
        {!account.connection && !linked?.verified ? (
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

      {account.alerts ? <DmAlertsSection account={account} alerts={account.alerts} onChange={onChange} /> : null}
    </Panel>
  );
}

// Each language named in itself, as the site's language menu does.
const DM_LANGUAGES: Array<{ value: string; label: ReactNode }> = [
  { value: "en", label: "English" },
  { value: "es", label: "Español" },
  { value: "zh-CN", label: "中文（简体）" },
];

// Supporter DMs: the bot messages the viewer's verified Discord link.
function DmAlertsSection({ account, alerts, onChange }: { account: BotAccount; alerts: BotAlerts; onChange: (account: BotAccount) => void }) {
  const [busy, setBusy] = useState(false);
  const [testResult, setTestResult] = useState<string | null>(null);
  const [saveFailed, setSaveFailed] = useState(false);
  const verified = account.links.some((link) => link.verified);
  const usable = alerts.supporter && verified;

  const save = async (patch: BotAlertsPatch) => {
    setBusy(true);
    setSaveFailed(false);
    try {
      onChange(await saveBotAlerts({ data: patch }));
    } catch {
      setSaveFailed(true);
    } finally {
      setBusy(false);
    }
  };
  const test = async () => {
    setBusy(true);
    setTestResult(null);
    try {
      const { result, account: next } = await testBotAlerts();
      setTestResult(result);
      onChange(next);
    } finally {
      setBusy(false);
    }
  };
  const blocked = testResult === "blocked" || (testResult == null && alerts.failedAt != null);

  return (
    <div className="mt-4 border-t border-white/[0.07] pt-4">
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <span className="text-[13px] font-semibold text-white"><Trans>DMs from the bot</Trans></span>
        <span className="rounded bg-osu-pink/15 px-1.5 py-0.5 text-[11px] font-semibold text-osu-pink-light"><Trans>Supporters</Trans></span>
        <div className="flex-1" />
        {!alerts.supporter ? (
          <a href={KOFI_PAGE_URL} target="_blank" rel="noreferrer" className="rounded-lg bg-osu-pink px-3 py-1.5 text-[12px] font-semibold text-white hover:brightness-110">
            <Trans>Become a supporter</Trans>
          </a>
        ) : verified ? (
          <button type="button" disabled={busy} onClick={() => void test()} className="rounded-lg bg-osu-b3 px-3 py-1.5 text-[12px] font-semibold text-white hover:brightness-110 disabled:opacity-50">
            <Trans>Send a test message</Trans>
          </button>
        ) : null}
      </div>
      <div className={`flex flex-wrap gap-x-6 gap-y-2 ${usable ? "" : "opacity-50"}`}>
        <Toggle checked={alerts.snipes} disabled={busy || !usable} onChange={(on) => void save({ snipes: on })} label={<Trans>When I get sniped</Trans>} />
        <Toggle checked={alerts.goals} disabled={busy || !usable} onChange={(on) => void save({ goals: on })} label={<Trans>Goals I complete</Trans>} />
        <Toggle checked={alerts.newMaps} disabled={busy || !usable} onChange={(on) => void save({ newMaps: on })} label={<Trans>New farm maps at my level</Trans>} />
        <Toggle checked={alerts.cardPulls} disabled={busy || !usable} onChange={(on) => void save({ cardPulls: on })} label={<Trans>When someone pulls my card</Trans>} />
        <Toggle checked={alerts.weeklyRecap} disabled={busy || !usable} onChange={(on) => void save({ weeklyRecap: on })} label={<Trans>Weekly recap</Trans>} />
      </div>
      <div className={`mt-3 flex flex-wrap items-center gap-2 text-[12px] text-osu-f1 ${usable ? "" : "opacity-50"}`}>
        <span className="mr-1"><Trans>Language</Trans></span>
        <Segmented
          value={alerts.locale}
          disabled={busy || !usable}
          options={DM_LANGUAGES}
          onChange={(value) => void save({ dmLocale: value })}
        />
      </div>
      <div className={`mt-3 text-[12px] text-osu-f1 ${usable ? "" : "opacity-50"}`}>
        <FeedPlayerPicker
          players={alerts.follows}
          disabled={busy || !usable}
          label={<Trans>Top plays from</Trans>}
          emptyLabel={<Trans>Nobody</Trans>}
          onChange={(next) => void save({ follows: next.map((player) => player.id) })}
        />
      </div>
      {alerts.supporter && !verified ? (
        <p className="mt-3 text-[12px] text-osu-f1"><Trans>Connect Discord here and link it to get messages.</Trans></p>
      ) : null}
      {saveFailed ? <p className="mt-3 text-[12px] text-rose-300"><Trans>That didn't save. Try again.</Trans></p> : null}
      {testResult === "sent" ? <p className="mt-3 text-[12px] text-emerald-300"><Trans>Sent. Check your DMs on Discord.</Trans></p> : null}
      {testResult && testResult !== "sent" && testResult !== "blocked" ? (
        <p className="mt-3 text-[12px] text-rose-300"><Trans>That didn't send. Try again.</Trans></p>
      ) : null}
      {blocked ? (
        <p className="mt-3 text-[12px] text-rose-300"><Trans>Discord didn't let the bot message you. It needs to share a server with you, with DMs from that server turned on.</Trans></p>
      ) : null}
    </div>
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

// A "?" with a bubble above it, shown on hover and toggled by a tap. The bubble
// is drawn over the page at the icon's spot, so opening it moves nothing and a
// scrolling table cannot clip it.
function HintButton({ label, children }: { label: string; children: ReactNode }) {
  const [pinned, setPinned] = useState(false);
  const [hovered, setHovered] = useState(false);
  const [spot, setSpot] = useState<{ x: number; y: number } | null>(null);
  const ref = useRef<HTMLButtonElement>(null);
  const open = pinned || hovered;
  useEffect(() => {
    if (!open) return;
    const place = () => {
      const rect = ref.current?.getBoundingClientRect();
      if (rect) setSpot({ x: Math.min(Math.max(rect.left + rect.width / 2, 128), window.innerWidth - 128), y: rect.top });
    };
    place();
    const close = (event: PointerEvent) => {
      if (!ref.current?.contains(event.target as Node)) setPinned(false);
    };
    document.addEventListener("pointerdown", close);
    window.addEventListener("scroll", place, true);
    window.addEventListener("resize", place);
    return () => {
      document.removeEventListener("pointerdown", close);
      window.removeEventListener("scroll", place, true);
      window.removeEventListener("resize", place);
    };
  }, [open]);
  return (
    <>
      <button
        ref={ref}
        type="button"
        aria-label={label}
        aria-expanded={open}
        onClick={() => setPinned((v) => !v)}
        onPointerEnter={(event) => { if (event.pointerType === "mouse") setHovered(true); }}
        onPointerLeave={() => setHovered(false)}
        className={`inline-flex shrink-0 align-middle transition-colors hover:text-white ${open ? "text-white" : "text-osu-f1/60"}`}
      >
        <CircleHelp size={13} />
      </button>
      {open && spot ? createPortal(
        <span
          role="tooltip"
          style={{ left: spot.x, top: spot.y }}
          className="pointer-events-none fixed z-[400] mt-[-8px] w-60 -translate-x-1/2 -translate-y-full rounded-md bg-osu-b6 px-2.5 py-1.5 text-left text-[12px] font-medium leading-snug text-osu-l1 shadow-[0_8px_20px_rgba(0,0,0,0.5)]"
        >
          {children}
        </span>,
        document.body,
      ) : null}
    </>
  );
}

const FILTER_KEYS = [4, 5, 6, 7, 8, 9, 10];
const KEYMODE_TOP_CHOICES = [0, 100, 50];

// The keymodes with dan courses, and the lowest level a Dan clears feed can
// ask for. A level is each ladder's own number: 11 is the first past 10th dan.
const DAN_FILTER_KEYS = [4, 6, 7];
// Each ladder with courses and its top level (danCourseLevelFor in the
// backend's dan-courses.ts); the badge art and level names come from its scale.
const DAN_LADDERS: Array<{ keyCount: number; context: DanScaleContext; top: number }> = [
  { keyCount: 4, context: "reform", top: 17 },
  { keyCount: 4, context: "ln", top: 17 },
  { keyCount: 6, context: "6k", top: 9 },
  { keyCount: 6, context: "6k-ln", top: 14 },
  { keyCount: 7, context: "7k", top: 14 },
  { keyCount: 7, context: "7k-ln", top: 14 },
];

function danLaddersAt(level: number, keys: number[]) {
  return DAN_LADDERS.filter((l) => (keys.length === 0 || keys.includes(l.keyCount)) && level <= l.top);
}

function ordinal(n: number): string {
  const suffix = n % 100 >= 11 && n % 100 <= 13 ? "th" : ["th", "st", "nd", "rd"][n % 10] ?? "th";
  return `${n}${suffix}`;
}

/** What a level is called on the chosen keymodes' ladders: "5th dan", or past 10th "11th, Alpha, Gamma". */
function danLevelName(level: number, keys: number[]): string {
  if (level <= 10) return `${ordinal(level)} dan`;
  const names: string[] = [];
  for (const l of danLaddersAt(level, keys)) {
    const name = danScaleLabel(level, l.context);
    const part = /^\d+$/.test(name) ? ordinal(level) : name;
    if (!names.includes(part)) names.push(part);
  }
  return names.length ? names.join(", ") : ordinal(level);
}

/** The level's badge on each chosen ladder, side by side. */
function DanLevelBadges({ level, keys }: { level: number; keys: number[] }) {
  const srcs = [...new Set(danLaddersAt(level, keys).map((l) => danScaleImage(level, l.context)).filter((src): src is string => src != null))];
  if (!srcs.length) return null;
  return (
    <span className="flex shrink-0 items-center gap-1">
      {srcs.map((src) => <img key={src} src={src} alt="" className="h-4 w-auto" />)}
    </span>
  );
}

function danLevelChoices(keys: number[], current: number): number[] {
  const top = Math.max(...DAN_LADDERS.filter((l) => keys.length === 0 || keys.includes(l.keyCount)).map((l) => l.top));
  return Array.from({ length: Math.max(top, current) + 1 }, (_, n) => n);
}
// Feeds with a row of filters under their channel: the feeds of players'
// plays, and New farm maps (keymodes and stars).
const FILTERED_FEEDS = ["top_play", "dan_clear", "goal", "new_map"];

type TopPlayFilterState = { minPp: number; keys: number[]; keymodeTop: number; players: BotFeedPlayer[]; playersMode: "only" | "except"; countries: string[]; minDan: number; nearClears: boolean; minStars: number; maxStars: number; mapsMode: "farm" | "all" };
type SavedFeedFilters = Omit<TopPlayFilterState, "players"> & { players: number[] };

function filtersOf(sub: BotServer["subscriptions"][number]): TopPlayFilterState {
  return {
    minPp: sub.minPp, keys: sub.keys ?? [], keymodeTop: sub.keymodeTop ?? 0, players: sub.players ?? [], playersMode: sub.playersMode ?? "only",
    countries: sub.countries ?? [], minDan: sub.minDan ?? 0, nearClears: sub.nearClears ?? true,
    minStars: sub.minStars ?? 0, maxStars: sub.maxStars ?? 0, mapsMode: sub.mapsMode ?? "farm",
  };
}

// Which plays a channel posts. Top plays: keymodes, a cut to the player's best
// N of that keymode, a pp floor and a player list. Dan clears: keymodes, a
// lowest level, near clears and a player list. New farm maps: farm maps or
// every ranked set, keymodes and a star range. Changes show at once and save in
// order behind the scenes, since each save waits on Discord for a few seconds.
function TopPlayFilters({ sub, channelName, onSave }: {
  sub: BotServer["subscriptions"][number];
  channelName?: string;
  onSave: (filters: SavedFeedFilters) => Promise<boolean>;
}) {
  const { t } = useLingui();
  const [picking, setPicking] = useState(false);
  const [filters, setFilters] = useState(() => filtersOf(sub));
  const pending = useRef(0);
  const queue = useRef<Promise<unknown>>(Promise.resolve());
  useEffect(() => {
    if (pending.current === 0) setFilters(filtersOf(sub));
  }, [sub]);
  const [minPpDraft, setMinPpDraft] = useState(sub.minPp ? String(sub.minPp) : "");
  useEffect(() => setMinPpDraft(sub.minPp ? String(sub.minPp) : ""), [sub.minPp]);
  const draftPp = Math.max(0, Math.floor(Number(minPpDraft) || 0));

  const save = (patch: Partial<TopPlayFilterState>) => {
    const next = { ...filters, ...patch };
    setFilters(next);
    pending.current++;
    queue.current = queue.current
      .then(() => onSave({ ...next, players: next.players.map((p) => p.id) }))
      .then((ok) => {
        pending.current--;
        if (!ok && pending.current === 0) setFilters(filtersOf(sub));
      });
  };
  const chip = (active: boolean, interactive = true) =>
    `rounded-md px-2 py-0.5 text-[12px] font-semibold ${active ? "bg-osu-pink text-white" : "bg-osu-b4 text-osu-l2"} ${interactive ? "hover:brightness-110" : "cursor-default"}`;
  const { keys, keymodeTop, players, playersMode, countries, minDan, nearClears, mapsMode } = filters;
  const danClears = sub.feedType === "dan_clear";
  // A Goals feed only has its players to choose.
  const goals = sub.feedType === "goal";
  const newMaps = sub.feedType === "new_map";
  const scope = countries.length === 0
    ? sub.country === "GLOBAL" ? t`every country` : sub.country
    : findRegionByCountries(countries)?.name ?? (countries.length <= 4 ? countries.join(", ") : t`${countries.length} countries`);

  const row = "flex flex-col gap-1.5 sm:flex-row sm:items-center sm:gap-3";
  const label = "shrink-0 text-[12px] text-osu-f1 sm:w-24";

  return (
    <div className="grid gap-3 rounded-lg bg-osu-b5 px-3.5 py-3 text-[12px] text-osu-f1">
      {newMaps ? (
        <div className={row}>
          <span className={label}><Trans>Which maps</Trans></span>
          <div className="flex flex-wrap items-center gap-1">
            {(["farm", "all"] as const).map((mode) => (
              <button key={mode} type="button" className={chip(mapsMode === mode, mapsMode !== mode)} onClick={() => { if (mapsMode !== mode) save({ mapsMode: mode }); }}>
                {mode === "farm" ? <Trans>Farm maps</Trans> : <Trans>All ranked maps</Trans>}
              </button>
            ))}
          </div>
        </div>
      ) : null}
      {goals ? null : (
      <>
      <div className={row}>
        <span className={label}><Trans>Keys</Trans></span>
        <div className="flex flex-wrap items-center gap-1">
          <button type="button" className={chip(keys.length === 0, keys.length > 0)} onClick={() => { if (keys.length) save({ keys: [] }); }}><Trans>All</Trans></button>
          {(danClears ? DAN_FILTER_KEYS : FILTER_KEYS).map((k) => (
            <button
              key={k}
              type="button"
              className={chip(keys.includes(k))}
              onClick={() => save({ keys: keys.includes(k) ? keys.filter((v) => v !== k) : [...keys, k].sort((a, b) => a - b) })}
            >
              {k}K
            </button>
          ))}
        </div>
      </div>
      {newMaps ? (
        <div className={row}>
          <span className={label}><Trans>Stars</Trans></span>
          <div className="flex items-center gap-1.5">
            <StarRangePill
              lo={0}
              hi={15}
              min={filters.minStars}
              max={filters.maxStars}
              step={0.1}
              ariaLabel={t`Star rating`}
              onChange={(minStars, maxStars) => { if (minStars !== filters.minStars || maxStars !== filters.maxStars) save({ minStars, maxStars }); }}
            />
            <HintButton label={t`Which stars count`}>
              <Trans>A chart posted for HT or DT counts at its stars with that mod.</Trans>
            </HintButton>
          </div>
        </div>
      ) : danClears ? (
        <>
          <div className={row}>
            <span className={label}><Trans>Lowest dan</Trans></span>
            <SelectMenu
              value={String(minDan)}
              ariaLabel={t`Lowest dan`}
              onChange={(value) => save({ minDan: Number(value) })}
              options={danLevelChoices(keys, minDan).map((n) => {
                const name = danLevelName(n, keys);
                return {
                  value: String(n),
                  label: n === 0 ? t`Any dan` : t`${name} and up`,
                  leading: n === 0 ? undefined : <DanLevelBadges level={n} keys={keys} />,
                };
              })}
            />
          </div>
          <div className={row}>
            <span className={label}><Trans>Near clears</Trans></span>
            <div className="flex items-center gap-1.5">
              <Toggle checked={nearClears} onChange={(on) => save({ nearClears: on })} />
              <HintButton label={t`What near clears are`}>
                <Trans>Runs up to one accuracy point under the pass bar. 4K LN courses have none.</Trans>
              </HintButton>
            </div>
          </div>
        </>
      ) : (
        <>
          <div className={row}>
            <span className={label}><Trans>Which plays</Trans></span>
            <div className="flex flex-wrap items-center gap-1">
              {KEYMODE_TOP_CHOICES.map((n) => (
                <button key={n} type="button" className={chip(keymodeTop === n, keymodeTop !== n)} onClick={() => { if (keymodeTop !== n) save({ keymodeTop: n }); }}>
                  {n === 0 ? <Trans>Any top play</Trans> : <Trans>Top {n} of the keymode</Trans>}
                </button>
              ))}
            </div>
          </div>
          <div className={row}>
            <span className={label}><Trans>Lowest pp</Trans></span>
            <div className="flex items-center gap-1.5">
              <input
                value={minPpDraft}
                inputMode="numeric"
                aria-label={t`Lowest pp`}
                onChange={(event) => setMinPpDraft(event.target.value.replace(/[^0-9]/g, "").slice(0, 4))}
                onKeyDown={(event) => { if (event.key === "Enter" && draftPp !== filters.minPp) save({ minPp: draftPp }); }}
                onBlur={() => { if (draftPp !== filters.minPp) save({ minPp: draftPp }); }}
                placeholder="0"
                className="w-16 rounded-md bg-osu-b4 px-2 py-1 text-[13px] text-white outline-none focus:ring-1 focus:ring-osu-pink/60"
              />
              <span>pp</span>
            </div>
          </div>
        </>
      )}
      </>
      )}
      {newMaps ? null : (
      <div className="flex flex-col gap-1.5 sm:flex-row sm:items-start sm:gap-3">
        <span className={`${label} sm:pt-1.5`}><Trans>Players</Trans></span>
        <div className="flex flex-wrap items-center gap-1.5">
          {players.length === 0
            ? <span className="text-[13px] text-osu-l2"><Trans>Everyone in {scope}</Trans></span>
            : playersMode === "except" ? <span className="text-[13px] text-osu-l2"><Trans>Everyone in {scope} except</Trans></span> : null}
          {players.slice(0, 8).map((player) => (
            <span key={player.id} className="inline-flex items-center gap-1.5 rounded-md bg-white/[0.07] py-1 pl-1.5 pr-2 text-[13px] font-semibold text-white">
              {player.avatarUrl ? <img src={player.avatarUrl} alt="" className="h-4 w-4 rounded-full" /> : null}
              {player.username}
            </span>
          ))}
          {players.length > 8 ? <span className="text-[12px] text-osu-l2">+{players.length - 8}</span> : null}
          <button type="button" onClick={() => setPicking(true)} className="rounded-md bg-osu-pink px-2.5 py-1 text-[13px] font-semibold text-white hover:brightness-110">
            <Trans>Choose players</Trans>
          </button>
        </div>
      </div>
      )}
      {picking ? (
        <FeedPlayersModal
          title={channelName ? t`Players for #${channelName}` : t`Players`}
          players={players}
          max={MAX_FEED_PLAYERS}
          mode={playersMode}
          countries={countries}
          feedCountry={sub.country === "GLOBAL" ? null : sub.country}
          onSave={(next) => save({ players: next.players, playersMode: next.mode, countries: next.countries })}
          onClose={() => setPicking(false)}
        />
      ) : null}
    </div>
  );
}

const MAX_FEED_PLAYERS = 200;

// The players a top-play feed is limited to, picked from players the site
// tracks. Empty means everyone in the feed's country.
function FeedPlayerPicker({ players, onChange, label, emptyLabel, disabled = false }: {
  players: BotFeedPlayer[];
  onChange: (players: BotFeedPlayer[]) => void;
  label?: ReactNode;
  emptyLabel?: ReactNode;
  disabled?: boolean;
}) {
  const { t } = useLingui();
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<LiveUserSearchEntry[]>([]);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    const trimmed = query.trim();
    if (trimmed.length < 2) {
      setResults([]);
      return;
    }
    let cancelled = false;
    const timer = setTimeout(() => {
      void fetchLiveUserSearch(trimmed, 8, { tracked: true })
        .then((users) => { if (!cancelled) setResults(users); })
        .catch(() => { if (!cancelled) setResults([]); });
    }, 200);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [query]);

  const chosen = new Set(players.map((p) => p.id));
  const options = results.filter((user) => !chosen.has(user.id));
  const add = (user: LiveUserSearchEntry) => {
    onChange([...players, { id: user.id, username: user.username, avatarUrl: user.avatarUrl || null }]);
    setQuery("");
    setResults([]);
  };

  return (
    <div className="flex w-full flex-wrap items-center gap-1.5">
      <span className="mr-1">{label ?? <Trans>Players</Trans>}</span>
      {players.length === 0 ? <span className="text-osu-l2">{emptyLabel ?? <Trans>Everyone</Trans>}</span> : null}
      {players.map((player) => (
        <span key={player.id} className="inline-flex items-center gap-1.5 rounded-md bg-white/[0.07] py-1 pl-1.5 pr-2 text-[13px] font-semibold text-white">
          {player.avatarUrl ? <img src={player.avatarUrl} alt="" className="h-4 w-4 rounded-full" /> : null}
          {player.username}
          <button
            type="button"
            aria-label={t`Remove ${player.username}`}
            disabled={disabled}
            onClick={() => onChange(players.filter((p) => p.id !== player.id))}
            className="text-osu-f1 hover:text-white disabled:opacity-40"
          >
            <X className="h-3 w-3" />
          </button>
        </span>
      ))}
      {players.length < MAX_FEED_PLAYERS && !disabled ? (
        <div className="relative">
          <Plus className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-osu-l2" />
          <input
            value={query}
            onChange={(event) => { setQuery(event.target.value.slice(0, 30)); setOpen(true); }}
            onFocus={() => setOpen(true)}
            onBlur={() => setTimeout(() => setOpen(false), 150)}
            onKeyDown={(event) => { if (event.key === "Enter" && options[0]) add(options[0]); }}
            placeholder={t`Add a player`}
            className="w-40 rounded-md bg-white/[0.07] py-1 pl-7 pr-2 text-[13px] text-white outline-none transition-colors placeholder:font-semibold placeholder:text-osu-l2 hover:bg-white/[0.1] focus:bg-white/[0.1] focus:ring-1 focus:ring-osu-pink/60"
          />
          {open && options.length ? (
            <div className="absolute left-0 top-full z-20 mt-1 w-56 overflow-hidden rounded-lg bg-osu-b3 py-1 shadow-lg">
              {options.map((user) => (
                <button
                  key={user.id}
                  type="button"
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={() => add(user)}
                  className="flex w-full items-center gap-2 px-2.5 py-1.5 text-left text-[13px] text-white hover:bg-osu-b4"
                >
                  {user.avatarUrl ? <img src={user.avatarUrl} alt="" className="h-5 w-5 rounded-full" /> : null}
                  <span className="min-w-0 flex-1 truncate">{user.username}</span>
                  {user.countryCode ? <span className="text-[11px] text-osu-f1">{user.countryCode}</span> : null}
                </button>
              ))}
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

// --- Servers -----------------------------------------------------------------

function ServersPanel({ account, inviteUrl }: { account: BotAccount | null; inviteUrl: string | null }) {
  // undefined while loading, null when the request failed.
  const [data, setData] = useState<BotServers | null | undefined>(undefined);
  const [showOthers, setShowOthers] = useState(false);
  // A verified link stands in for a Discord connection in this browser.
  const connected = Boolean(account?.connection || account?.links.some((link) => link.verified));

  // Fetched alongside the account rather than after it, then again only if
  // Discord gets connected or linked during the visit.
  const load = useCallback(() => {
    void fetchBotServers().then(setData).catch(() => setData(null));
  }, []);
  useEffect(load, [load]);
  const needsDiscord = data?.error === "no_discord";
  useEffect(() => {
    if (connected && needsDiscord) load();
  }, [connected, needsDiscord, load]);

  if (account && !account.signedIn) return null;

  const servers = data?.ok && data.available ? data.servers : [];
  const withBot = servers.filter((server) => server.botPresent);
  const withoutBot = servers.filter((server) => !server.botPresent);
  const renderRow = (server: BotServer) => (
    <ServerRow
      key={server.id}
      server={server}
      feedTypes={data!.feedTypes}
      autoDanAvailable={data!.autoDanAvailable}
      fallbackCountry={data!.defaultCountry}
      inviteUrl={inviteUrl}
      onServer={(next) => setData((current) => current ? { ...current, servers: current.servers.map((s) => s.id === next.id ? next : s) } : current)}
    />
  );

  return (
    <Panel title={<Trans>Your servers</Trans>}>
      {!account || data === undefined ? (
        <ServerSkeleton />
      ) : !connected || data?.error === "no_discord" ? (
        <div className="flex flex-wrap items-center gap-3">
          <p className="min-w-0 flex-1 text-[14px] text-osu-l2"><Trans>Connect Discord to set up feeds in servers where you have Manage Server.</Trans></p>
          <a href={connectHref()} className="inline-flex items-center gap-2 rounded-lg px-4 py-2 text-[13px] font-semibold text-white hover:brightness-110" style={{ backgroundColor: BLURPLE }}>
            <DiscordLogo className="h-4 w-4" />
            <Trans>Connect Discord</Trans>
          </a>
        </div>
      ) : !data || !data.ok || !data.available ? (
        <p className="text-[14px] text-osu-f1"><Trans>Server settings aren't available right now.</Trans></p>
      ) : data.servers.length === 0 ? (
        <p className="text-[14px] text-osu-f1"><Trans>You don't manage any Discord servers.</Trans></p>
      ) : (
        <div className="space-y-2">
          {withBot.map(renderRow)}
          {withoutBot.length ? (
            <>
              <button
                type="button"
                onClick={() => setShowOthers((value) => !value)}
                className="flex w-full items-center gap-2 rounded-xl px-3 py-2.5 text-left text-[13px] font-semibold text-osu-l2 hover:bg-osu-b4"
              >
                <ChevronDown className={`h-4 w-4 transition-transform ${showOthers ? "rotate-180" : ""}`} />
                <Trans>Add the bot to another server</Trans>
                <span className="text-osu-f1">{withoutBot.length}</span>
              </button>
              {showOthers ? withoutBot.map(renderRow) : null}
            </>
          ) : null}
        </div>
      )}
    </Panel>
  );
}

function ServerSkeleton() {
  return (
    <div className="animate-pulse space-y-2">
      {[0, 1].map((row) => (
        <div key={row} className="flex items-center gap-3 rounded-xl bg-osu-b4 p-3">
          <span className="h-9 w-9 rounded-full bg-osu-b3" />
          <div className="flex-1 space-y-2">
            <span className="block h-3.5 w-40 rounded bg-osu-b3" />
            <span className="block h-3 w-20 rounded bg-osu-b3" />
          </div>
        </div>
      ))}
    </div>
  );
}

const FEED_NAMES: Record<string, ReturnType<typeof msg>> = {
  top_play: msg`Top plays`,
  dan_clear: msg`Dan clears`,
  goal: msg`Goals`,
  new_map: msg`New farm maps`,
  changelog: msg`Website changelog`,
};

const FEED_HINTS: Record<string, ReturnType<typeof msg>> = {
  top_play: msg`Posts a player's new top play, a play that enters their best 200.`,
  dan_clear: msg`Posts a player's near clear, clear or overclear of a dan course or practice chart.`,
  goal: msg`Posts a goal when its player completes it.`,
  new_map: msg`Posts newly ranked maps that players are gaining pp on, and new 4K and 7K charts that give more pp than their difficulty.`,
  changelog: msg`Posts each new line of the website's changelog.`,
};

type ServerSub = BotServer["subscriptions"][number];

// What a change will leave the server looking like, drawn at once while the
// save is on its way. The saved server replaces it when the answer comes back.
function withChange(server: BotServer, change: BotServerChange, fallbackCountry: string): BotServer {
  let { subscriptions, settings } = server;
  if (change.defaultCountry !== undefined) settings = { ...settings, defaultCountry: change.defaultCountry };
  if (change.feed) {
    const { channelId, feedType, on, country } = change.feed;
    subscriptions = subscriptions.filter((sub) => sub.channelId !== channelId || sub.feedType !== feedType);
    if (on) subscriptions = [...subscriptions, { channelId, feedType, country: country ?? settings.defaultCountry ?? fallbackCountry, minPp: 0 }];
  }
  if (change.autoDan) {
    const { channelId, on } = change.autoDan;
    const rest = channelId === "*" ? [] : settings.autoDanChannels.filter((id) => id !== channelId);
    settings = { ...settings, autoDanChannels: on ? [...rest, channelId] : rest };
  }
  return { ...server, subscriptions, settings };
}

function SummaryParts({ parts }: { parts: ReactNode[] }) {
  return (
    <span className="inline-flex flex-wrap items-center gap-y-1 text-[12px] font-semibold text-white">
      {parts.map((part, index) => (
        <Fragment key={index}>
          {index ? <span className="mx-2 h-3 w-px bg-white/20" /> : null}
          <span>{part}</span>
        </Fragment>
      ))}
    </span>
  );
}

// A feed's filters in one line, read from what is saved.
function FeedSummary({ sub }: { sub: ServerSub }) {
  const { i18n } = useLingui();
  const keys = sub.keys ?? [];
  const parts: ReactNode[] = sub.feedType === "goal" ? [] : [keys.length ? keys.map((k) => `${k}K`).join(", ") : <Trans>All keys</Trans>];
  if (sub.feedType === "new_map") {
    parts.unshift(sub.mapsMode === "all" ? <Trans>All ranked maps</Trans> : <Trans>Farm maps</Trans>);
    const min = sub.minStars ?? 0;
    const max = sub.maxStars ?? 0;
    parts.push(min && max ? <Trans>{min}★ to {max}★</Trans> : min ? <Trans>{min}★ and up</Trans> : max ? <Trans>Up to {max}★</Trans> : <Trans>Any stars</Trans>);
    return <SummaryParts parts={parts} />;
  }
  if (sub.feedType === "goal") {
    // Only its players, below.
  } else if (sub.feedType === "dan_clear") {
    const name = danLevelName(sub.minDan ?? 0, keys);
    parts.push(sub.minDan ? <Trans>{name} and up</Trans> : <Trans>Any dan</Trans>);
    if (sub.nearClears ?? true) parts.push(<Trans>Near clears</Trans>);
  } else {
    const top = sub.keymodeTop ?? 0;
    parts.push(top ? <Trans>Top {top} of the keymode</Trans> : <Trans>Any top play</Trans>);
    const minPp = sub.minPp;
    if (minPp) parts.push(<Trans>{minPp}pp and up</Trans>);
  }
  parts.push(
    sub.players?.length && sub.playersMode !== "except"
      ? <Plural value={sub.players.length} one="# player" other="# players" />
      : sub.countries?.length
        ? findRegionByCountries(sub.countries)?.name ?? (sub.countries.length <= 3 ? sub.countries.join(", ") : <Plural value={sub.countries.length} one="# country" other="# countries" />)
        : sub.country === "GLOBAL" ? i18n._(msg`Global`) : sub.country,
  );
  return <SummaryParts parts={parts} />;
}

function ServerRow({ server, feedTypes, autoDanAvailable, fallbackCountry, inviteUrl, onServer }: {
  server: BotServer;
  feedTypes: string[];
  autoDanAvailable: boolean;
  fallbackCountry: string;
  inviteUrl: string | null;
  onServer: (server: BotServer) => void;
}) {
  const { i18n, t } = useLingui();
  const noDans = useNoDans();
  const [open, setOpen] = useState(false);
  const [error, setError] = useState(false);
  // The feed whose filters are open, as "channel:feed".
  const [editing, setEditing] = useState<string | null>(null);
  // Channels that stay listed after their last feed is turned off, and ones just added.
  const [kept, setKept] = useState<string[]>([]);
  const country = server.settings.defaultCountry ?? fallbackCountry;

  // Changes draw at once and save one after another, since each save waits on
  // Discord for a few seconds. `shown` is the server as drawn, `saved` the last
  // one the backend confirmed, which a failed save falls back to.
  const shown = useRef(server);
  shown.current = server;
  const saved = useRef(server);
  const pending = useRef(0);
  const queue = useRef<Promise<unknown>>(Promise.resolve());
  const send = useCallback((change: BotServerChange, draw = true): Promise<boolean> => {
    setError(false);
    if (draw) {
      shown.current = withChange(shown.current, change, fallbackCountry);
      onServer(shown.current);
    }
    pending.current++;
    const done = queue.current.then(async () => {
      const result = await updateBotServer({ data: { guildId: server.id, change } }).catch(() => null);
      pending.current--;
      const ok = Boolean(result?.ok && result.server);
      if (ok) saved.current = result!.server!;
      else setError(true);
      // Later changes are still drawn over this answer until the last one lands.
      if (pending.current === 0) onServer(saved.current);
      return ok;
    });
    queue.current = done;
    return done;
  }, [fallbackCountry, onServer, server.id]);

  const feeds = noDans ? feedTypes.filter((feed) => feed !== "dan_clear") : feedTypes;
  const autoDan = autoDanAvailable && !noDans;
  const autoDanAll = server.settings.autoDanChannels.includes("*");
  const channels = server.channels.filter((channel) =>
    kept.includes(channel.id)
    || server.settings.autoDanChannels.includes(channel.id)
    || server.subscriptions.some((sub) => sub.channelId === channel.id));
  const addable = server.channels.filter((channel) => !channels.includes(channel));
  const keep = (channelId: string) => setKept((current) => current.includes(channelId) ? current : [...current, channelId]);
  const feedCount = server.subscriptions.length;
  const countryOptions = useMemo(() => {
    const flag = (code: string) => <img src={getCountryFlagUrl(code)} alt="" className="h-3 w-[18px] rounded-[2px] object-cover" />;
    const options = [
      { value: "GLOBAL", label: displayCountryName("GLOBAL", i18n.locale as AppLocale), leading: <Globe className="h-3.5 w-[18px] text-osu-l2" /> },
      ...COUNTRY_OPTIONS.map(({ code }) => ({ value: code as string, label: displayCountryName(code, i18n.locale as AppLocale), leading: flag(code) })),
    ];
    return options.some((option) => option.value === country) ? options : [{ value: country, label: country, leading: flag(country) }, ...options];
  }, [country, i18n.locale]);

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

  // One feed of one channel: its switch and name, then what it posts.
  const feedRow = "flex flex-wrap items-center gap-x-3 gap-y-1";
  const feedName = "flex w-52 shrink-0 items-center";
  const feedNote = "order-last w-full pl-11 text-[12px] text-osu-f1 sm:order-none sm:w-auto sm:flex-1 sm:pl-0";

  return (
    <div className="rounded-xl bg-osu-b4 p-3">
      {header}
      {open && server.botPresent ? (
        <div className="mt-3 border-t border-white/[0.07]">
          {channels.length === 0 ? (
            <p className="pt-3 text-[13px] text-osu-l2"><Trans>Add a channel, then turn on what it posts.</Trans></p>
          ) : null}
          {channels.map((channel) => (
            <div key={channel.id} className="border-b border-white/[0.07] py-3.5">
              <div className="text-[15px] font-semibold text-white">
                <span className="text-osu-f1">#</span>{channel.name}
                {channel.category ? <span className="ml-2 text-[11px] font-normal text-osu-f1">{channel.category}</span> : null}
              </div>
              <div className="mt-3 space-y-2.5">
                {feeds.map((feed) => {
                  const sub = server.subscriptions.find((s) => s.channelId === channel.id && s.feedType === feed);
                  const key = `${channel.id}:${feed}`;
                  const hasFilters = Boolean(sub) && FILTERED_FEEDS.includes(feed);
                  return (
                    <div key={feed}>
                      <div className={feedRow}>
                        <div className={feedName}>
                          <Toggle
                            checked={Boolean(sub)}
                            onChange={(on) => {
                              keep(channel.id);
                              setEditing(on && FILTERED_FEEDS.includes(feed) ? key : editing === key ? null : editing);
                              void send({ feed: { channelId: channel.id, feedType: feed, on, country } });
                            }}
                            label={FEED_NAMES[feed] ? i18n._(FEED_NAMES[feed]) : feed}
                          />
                        </div>
                        <div className={feedNote}>
                          {sub && hasFilters ? <FeedSummary sub={sub} /> : FEED_HINTS[feed] ? i18n._(FEED_HINTS[feed]) : null}
                        </div>
                        {hasFilters ? (
                          <button type="button" onClick={() => setEditing(editing === key ? null : key)} className="ml-auto text-[12px] font-semibold text-osu-pink-light hover:text-white">
                            {editing === key ? <Trans>Done</Trans> : <Trans>Edit</Trans>}
                          </button>
                        ) : null}
                      </div>
                      {sub && hasFilters && editing === key ? (
                        <div className="mt-2 sm:ml-11">
                          <TopPlayFilters
                            sub={sub}
                            channelName={channel.name}
                            onSave={(filters) => send({ feedFilters: { channelId: channel.id, feedType: feed, ...filters } }, false)}
                          />
                        </div>
                      ) : null}
                    </div>
                  );
                })}
                {autoDan ? (
                  <div className={feedRow}>
                    <div className={feedName}>
                      <Toggle
                        checked={autoDanAll || server.settings.autoDanChannels.includes(channel.id)}
                        disabled={autoDanAll}
                        onChange={(on) => { keep(channel.id); void send({ autoDan: { channelId: channel.id, on } }); }}
                        label={<Trans>Dan on score posts</Trans>}
                      />
                    </div>
                    <div className={feedNote}>
                      {autoDanAll ? <Trans>On in every channel.</Trans> : <Trans>Replies to score posts and beatmap links in the channel with the chart's dan.</Trans>}
                    </div>
                    {autoDanAll || server.settings.autoDanChannels.includes(channel.id) ? (
                      <button type="button" onClick={() => void send({ autoDan: { channelId: "*", on: !autoDanAll } })} className="ml-auto text-[12px] font-semibold text-osu-pink-light hover:text-white">
                        {autoDanAll ? <Trans>Turn off everywhere</Trans> : <Trans>Turn on in every channel</Trans>}
                      </button>
                    ) : null}
                  </div>
                ) : null}
              </div>
            </div>
          ))}
          <div className="flex flex-wrap items-center gap-x-4 gap-y-2.5 pt-3">
            {addable.length ? (
              <SelectMenu
                value=""
                triggerLabel={t`Add a channel`}
                ariaLabel={t`Add a channel`}
                searchable
                onChange={(channelId) => keep(channelId)}
                options={addable.map((channel) => ({ value: channel.id, label: `#${channel.name}`, group: channel.category ?? undefined }))}
              />
            ) : null}
            {error ? <span className="text-[12px] text-rose-300"><Trans>That didn't save. Try again.</Trans></span> : null}
            <div className="flex items-center gap-2 sm:ml-auto">
              <span className="text-[12px] text-osu-f1"><Trans>Default country</Trans></span>
              <SelectMenu
                value={country}
                ariaLabel={t`Default country`}
                align="right"
                searchable
                onChange={(code) => { if (code !== country) void send({ defaultCountry: code }); }}
                options={countryOptions}
              />
              <HintButton label={t`What the default country does`}>
                {noDans
                  ? <Trans>/rankings shows this country here when none is given, and a Top plays feed you turn on posts its players until you choose others.</Trans>
                  : <Trans>/rankings shows this country here when none is given, and a Top plays or Dan clears feed you turn on posts its players until you choose others.</Trans>}
              </HintButton>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}

// --- Previews ----------------------------------------------------------------

// The shape of an embed while its preview renders.
function PreviewSkeleton() {
  return (
    <div className="mt-1 flex max-w-[520px] animate-pulse overflow-hidden rounded" style={{ backgroundColor: DISCORD.embed }}>
      <span className="w-1 shrink-0" style={{ backgroundColor: DISCORD.muted }} />
      <div className="flex-1 space-y-3 p-4">
        <span className="block h-4 w-32 rounded bg-white/10" />
        <span className="block h-4 w-64 max-w-full rounded bg-white/10" />
        <span className="block h-3 w-48 max-w-full rounded bg-white/[0.07]" />
        <span className="block h-3 w-56 max-w-full rounded bg-white/[0.07]" />
      </div>
    </div>
  );
}

// Commands that answer the same for anyone, then a post from each feed.
const PREVIEWS: Array<{ id: string; label: ReturnType<typeof msg> }> = [
  { id: "profile", label: msg`/profile` },
  { id: "skills", label: msg`/skills` },
  { id: "top", label: msg`/top` },
  { id: "recent", label: msg`/recent` },
  { id: "maniacard", label: msg`/maniacard` },
  { id: "map", label: msg`/map` },
  { id: "farm", label: msg`/farm` },
  { id: "challenge", label: msg`/challenge` },
  { id: "rankings", label: msg`/rankings` },
  { id: "help", label: msg`/help` },
];

const FEED_PREVIEWS: Array<{ id: string; label: ReturnType<typeof msg> }> = [
  { id: "feed-top-plays", label: FEED_NAMES.top_play },
  { id: "feed-dan-clears", label: FEED_NAMES.dan_clear },
  { id: "feed-goals", label: FEED_NAMES.goal },
  { id: "feed-new-maps", label: FEED_NAMES.new_map },
  { id: "feed-changelog", label: FEED_NAMES.changelog },
];

function PreviewPanel({ initialProfile }: { initialProfile: DiscordMessageJson | null }) {
  const { i18n } = useLingui();
  const [view, setView] = useState("profile");
  const [messages, setMessages] = useState<Record<string, DiscordMessageJson | null | undefined>>(() => (initialProfile ? { profile: initialProfile } : {}));

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
      {[PREVIEWS, FEED_PREVIEWS].map((group, index) => (
        <div key={index} className={`flex flex-wrap gap-1.5 ${index === 0 ? "mb-1.5" : "mb-3"}`}>
          {group.map((preview) => (
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
      ))}
      <div className="overflow-hidden rounded-xl p-4" style={{ backgroundColor: DISCORD.msg, fontFamily: DISCORD.font }}>
        <div className="flex gap-4">
          <img src="/images/discord/bot-avatar.png" alt="" className="h-10 w-10 shrink-0 rounded-full" />
          <div className="min-w-0 flex-1">
            <div className="flex items-baseline gap-1.5">
              <span className="text-[16px] font-medium" style={{ color: DISCORD.white }}>maniabot</span>
              <span className="rounded-[3px] px-1 text-[10px] font-semibold leading-[15px] text-white" style={{ backgroundColor: BLURPLE }}>APP</span>
            </div>
            <div className="mt-1 min-h-[120px]">
              {message === undefined ? <PreviewSkeleton /> : message ? (
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
      <p className="mt-2 text-[13px] text-osu-f1">
        <Trans>
          In servers you can also type <code className="font-semibold text-osu-pink-light">m!r</code>, <code className="font-semibold text-osu-pink-light">m!t</code>, <code className="font-semibold text-osu-pink-light">m!p</code>, <code className="font-semibold text-osu-pink-light">m!s</code>, <code className="font-semibold text-osu-pink-light">m!c</code>, <code className="font-semibold text-osu-pink-light">m!card</code> or <code className="font-semibold text-osu-pink-light">m!f</code> with a player's name after it, for recent, top, profile, skills, compare, maniacard and farm, <code className="font-semibold text-osu-pink-light">m!m</code> with a map, <code className="font-semibold text-osu-pink-light">m!ch</code> for a challenge and <code className="font-semibold text-osu-pink-light">m!rank</code> with a country.
        </Trans>
      </p>
      <p className="mt-2 text-[13px] text-osu-f1">
        <Trans>
          Feeds post on their own in a channel: <span className="font-semibold text-osu-l2">Top plays</span>, <span className="font-semibold text-osu-l2">Dan clears</span>, which posts a player's near clear, clear or overclear of a dan course or practice chart, <span className="font-semibold text-osu-l2">New farm maps</span> and <span className="font-semibold text-osu-l2">Website changelog</span>, which posts each new changelog line. Turn them on with <code className="font-semibold text-osu-pink-light">/setup</code> or under Your servers above.
        </Trans>
      </p>
    </Panel>
  );
}

function UnreachableNote() {
  return (
    <div className="relative border-t border-white/[0.07] p-5 sm:p-6">
      <p className="text-[14px] text-osu-l2"><Trans>Can't reach the bot right now. Refresh in a moment.</Trans></p>
    </div>
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
