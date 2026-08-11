import { createFileRoute, notFound } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import { COUNTRY_OPTIONS } from "../../lib/country";
import { canUseDevFeatures } from "../../lib/auth-shared";
import { fetchLivePackRecentPulls, type LivePackPullFeedEntry } from "../../lib/live-backend";
import { MANIA_CARD_TIER_THRESHOLDS, MANIA_TIER_STYLES, type ManiaCardTier } from "../../lib/maniacard";
import { getScore } from "../../lib/osu";
import { buildReplaySeoTitle } from "../../lib/replay-seo";

type PresetKind =
  | "default"
  | "home"
  | "rankings"
  | "player"
  | "maps"
  | "maps-search"
  | "maps-collections"
  | "farm-helper"
  | "packs"
  | "skins"
  | "bbcode"
  | "discord"
  | "replay"
  | "pull";

/* Kinds that render one fixed card with no inputs. The preview just
   requests `?kind=X`; title/subtitle only affect the embed mocks. */
const STATIC_KINDS: ReadonlySet<PresetKind> = new Set([
  "maps-search",
  "maps-collections",
  "farm-helper",
  "packs",
  "skins",
  "bbcode",
  "discord",
]);

const STATIC_KIND_NOTES: Record<string, string> = {
  "maps-search":
    "Static map-search card: paper search bar with a typed query, result rows with real cover thumbnails from the maps snapshot (abstract title bars), star/keymode chips, and the search tab's filter stickers.",
  "maps-collections":
    "Static collections card: three stacks of cover cards labelled with real pattern archetypes and star buckets (the collections tab's grouping). Covers come from the maps snapshot pool.",
  "farm-helper":
    "Static farm helper card: reason stickers (missing / improve / old pb) in the app's accent colors, pp-gain tags, grade badges, and the global mania top 50 as the dim avatar backdrop.",
  packs:
    "Static card-packs card: five mini maniacards fanned by rarity tier using the real tier gradients and triangle texture, each with a mystery \"?\" player slot.",
  skins:
    "Static skins card: the skins page's falling-note rain frozen mid-fall, built from the real ManiaRain note sprites at mixed depths, with two long notes and colour-matched motion streaks. Page is dev-gated but the card ships ready.",
  bbcode:
    "Static bbcode-editor card: dark code pane with highlighted BBCode markup next to a paper preview pane showing the rendered result.",
  discord:
    "Static maniabot card: Discord-style chat panel (slash command in, embed reply out) with the bot avatar, a blurple title sticker, and real command chips. Page is dev-gated but the card ships ready.",
};

type Preset = {
  key: string;
  label: string;
  kind: PresetKind;
  title: string;
  subtitle: string;
  path: string;
  username?: string;
  scoreId?: number;
  /* The page renders its <title> without the "- Mania Tracker" suffix
     (pageSeo appendSiteName: false); keep the embed mocks in sync. */
  rawTitle?: boolean;
  /* When true, the preset mirrors a route that bakes `?country=XX` into
     its og:image URL. The preview then attaches the currently selected
     country so the endpoint renders the country scoreboard instead of
     the generic fallback. */
  countryAware?: boolean;
  noindex?: boolean;
};

const PRESETS: Preset[] = [
  {
    key: "default",
    label: "Default (no country)",
    kind: "default",
    title: "Mania Tracker",
    subtitle: "osu!mania rankings, live scores, maps, snipes, and replays",
    path: "/",
    /* This is the fallback the endpoint renders when no `kind` and no
       valid `country` are set — what users see when they share the
       bare site URL. Useful for sanity-checking the title/subtitle
       baked into the minimal layout. */
  },
  {
    key: "home",
    label: "Home",
    kind: "home",
    title: "Mania Tracker",
    subtitle: "osu!mania rankings, live scores, maps, snipes, and replays",
    path: "/",
    countryAware: true,
  },
  {
    key: "rankings",
    label: "Rankings",
    kind: "rankings",
    title: "Country mania rankings",
    subtitle: "osu!mania country rankings",
    path: "/rankings",
    countryAware: true,
  },
  {
    key: "maps",
    label: "Maps",
    kind: "maps",
    title: "Beatmaps played by your country",
    subtitle: "osu!mania maps played by top country players.",
    path: "/maps",
    countryAware: true,
  },
  {
    key: "maps-search",
    label: "Maps - search",
    kind: "maps-search",
    title: "Map search",
    subtitle: "Search every ranked osu!mania map by title, keymode, stars, and status.",
    path: "/maps?tab=search",
  },
  {
    key: "maps-collections",
    label: "Maps - collections",
    kind: "maps-collections",
    title: "Map collections",
    subtitle: "Browse curated osu!mania map collections grouped by pattern and star rating.",
    path: "/maps?tab=collections",
  },
  {
    key: "farm-helper",
    label: "Farm Helper",
    kind: "farm-helper",
    title: "Farm Helper",
    subtitle: "Find osu!mania farm maps worth playing, based on nearby players, missing clears, improvable scores, and old PBs.",
    path: "/farm-helper",
  },
  {
    key: "packs",
    label: "Card Packs",
    kind: "packs",
    title: "Card Packs",
    subtitle: "Tear open a booster pack of five maniacards: random osu!mania players minted as collectible cards with skill stats and rarity tiers.",
    path: "/packs",
  },
  {
    key: "skins",
    label: "Skins",
    kind: "skins",
    title: "osu!mania skins",
    subtitle: "Browse and download osu!mania skins with previews rendered from each skin's own notes, or publish a skin from an .osk file.",
    path: "/skins",
    noindex: true,
  },
  {
    key: "bbcode",
    label: "BBCode Editor",
    kind: "bbcode",
    title: "BBCode editor",
    subtitle: "Write and preview osu! profile BBCode for your me! page, with a live preview and one-click copy.",
    path: "/bbcode",
  },
  {
    key: "discord",
    label: "Discord (maniabot)",
    kind: "discord",
    title: "maniabot - Mania Hub for Discord",
    subtitle: "Every osu!mania lookup as a slash command, plus live feeds that post new top plays, snipes, and farm maps into any channel.",
    path: "/discord",
    rawTitle: true,
    noindex: true,
  },
  {
    key: "player",
    label: "Player",
    kind: "player",
    title: "peppy",
    subtitle: "peppy's osu!mania stats.",
    path: "/player/peppy",
    username: "peppy",
    noindex: true,
  },
  {
    key: "replay",
    label: "Replay",
    kind: "replay",
    title: "Score replay",
    subtitle: "",
    path: "/replay",
    scoreId: 7202465428,
    noindex: true,
  },
  {
    key: "pull",
    label: "Pull permalink",
    kind: "pull",
    /* Mirrors the head() of /pull/$ownerId/$cardId. */
    title: "Maniacard pull",
    subtitle: "A maniacard pulled from a booster pack. Open your own packs and build a collection.",
    path: "/pull/{ownerId}/{cardId}",
  },
];

// Mirror the endpoint's limits so the counter warns before truncation kicks in.
const MAX_TITLE = 38;
const MAX_SUBTITLE = 150;
const SITE_NAME = "Mania Tracker";

/* Every card is 1200x630 except the maniacard-shaped ones, which the endpoint
   renders portrait (720x1008 card + 72px "pulled by" footer). The mockups need
   the real ratio: a portrait card is not framed the same way in an embed. */
const DEFAULT_OG_SIZE = { width: 1200, height: 630 };
const OG_SIZES: Partial<Record<PresetKind, { width: number; height: number }>> = {
  pull: { width: 720, height: 1080 },
};

/* Rarities in ladder order for the pull preset's tier override. The threshold
   table skips both ends: common is the floor, GOAT is honorary rather than
   earned by card power. */
const TIER_ORDER: ManiaCardTier[] = [
  "common",
  ...MANIA_CARD_TIER_THRESHOLDS.map(({ tier }) => tier),
  "goat",
];

export const Route = createFileRoute("/admin/og-preview")({
  head: () => ({
    meta: [
      { title: "OG preview - dev" },
      { name: "robots", content: "noindex, nofollow" },
    ],
  }),
  beforeLoad: ({ context }) => {
    if (!canUseDevFeatures(context.auth)) {
      throw notFound();
    }
    return undefined as never;
  },
  component: OgPreviewPage,
});

function OgPreviewPage() {
  const [presetKey, setPresetKey] = useState<string>(PRESETS[0].key);
  const [kind, setKind] = useState<PresetKind>(PRESETS[0].kind);
  const [title, setTitle] = useState(PRESETS[0].title);
  const [subtitle, setSubtitle] = useState(PRESETS[0].subtitle);
  const [username, setUsername] = useState("peppy");
  const [scoreId, setScoreId] = useState("7202465428");
  const [country, setCountry] = useState("CR");
  const [cacheBuster, setCacheBuster] = useState(() => Date.now());
  const [origin, setOrigin] = useState("");
  const [copied, setCopied] = useState(false);
  const [replayMockTitle, setReplayMockTitle] = useState("");
  const [pullOwnerId, setPullOwnerId] = useState("");
  const [pullCardId, setPullCardId] = useState("");
  const [recentPulls, setRecentPulls] = useState<LivePackPullFeedEntry[]>([]);
  const [pullsError, setPullsError] = useState("");
  /* Empty = render the card at the rarity it was actually minted at. */
  const [pullTier, setPullTier] = useState<ManiaCardTier | "">("");

  const currentPreset = useMemo(
    () => PRESETS.find((p) => p.key === presetKey) ?? PRESETS[0],
    [presetKey],
  );
  const countryAware = currentPreset.countryAware ?? false;

  useEffect(() => {
    setOrigin(window.location.origin);
  }, []);

  useEffect(() => {
    if (kind !== "replay") return;

    const numericScoreId = Number(scoreId);
    if (!Number.isSafeInteger(numericScoreId) || numericScoreId <= 0) {
      setReplayMockTitle("");
      return;
    }

    let cancelled = false;
    setReplayMockTitle(buildReplaySeoTitle(numericScoreId));
    getScore({ data: { scoreId: numericScoreId } })
      .then((score) => {
        if (cancelled) return;
        setReplayMockTitle(buildReplaySeoTitle(numericScoreId, {
          username: score.user?.username ?? "",
          title: score.beatmapset?.title ?? "",
          version: score.beatmap?.version ?? "",
        }));
      })
      .catch(() => {
        if (!cancelled) setReplayMockTitle(buildReplaySeoTitle(numericScoreId));
      });

    return () => {
      cancelled = true;
    };
  }, [kind, scoreId]);

  /* A pull permalink is two ids nobody remembers, so the preset seeds itself
     from the live pull feed and offers the rest as chips. Only real pulls
     render — the endpoint has no synthetic card to fall back on. */
  useEffect(() => {
    if (kind !== "pull" || recentPulls.length > 0) return;
    let cancelled = false;
    fetchLivePackRecentPulls(12, { includeAll: true })
      .then((pulls) => {
        if (cancelled) return;
        setRecentPulls(pulls);
        setPullsError(pulls.length === 0 ? "the live pull feed is empty" : "");
        const first = pulls[0];
        if (!first) return;
        setPullOwnerId((prev) => prev || String(first.ownerUserId));
        setPullCardId((prev) => prev || String(first.cardUserId));
      })
      .catch(() => {
        if (!cancelled) setPullsError("could not reach the live backend");
      });
    return () => {
      cancelled = true;
    };
  }, [kind, recentPulls.length]);

  const ogPath = useMemo(() => {
    if (kind === "player") {
      const params = new URLSearchParams({
        kind: "player",
        username,
        t: String(cacheBuster),
      });
      return `/api/og?${params.toString()}`;
    }
    if (kind === "replay") {
      const params = new URLSearchParams({
        kind: "replay",
        scoreId,
        t: String(cacheBuster),
      });
      return `/api/og?${params.toString()}`;
    }
    if (kind === "pull") {
      const params = new URLSearchParams({
        kind: "pull",
        owner: pullOwnerId,
        card: pullCardId,
        t: String(cacheBuster),
      });
      if (pullTier) params.set("tier", pullTier);
      return `/api/og?${params.toString()}`;
    }
    if (kind === "maps") {
      const params = new URLSearchParams({
        kind,
        country,
        t: String(cacheBuster),
      });
      return `/api/og?${params.toString()}`;
    }
    if (STATIC_KINDS.has(kind)) {
      const params = new URLSearchParams({
        kind,
        t: String(cacheBuster),
      });
      return `/api/og?${params.toString()}`;
    }
    if (kind === "home" || kind === "rankings") {
      const params = new URLSearchParams({
        kind,
        title,
        country,
        t: String(cacheBuster),
      });
      return `/api/og?${params.toString()}`;
    }
    // default: title/subtitle + optional country
    const params = new URLSearchParams({
      title,
      t: String(cacheBuster),
    });
    if (subtitle) params.set("subtitle", subtitle);
    if (countryAware) params.set("country", country);
    return `/api/og?${params.toString()}`;
  }, [kind, username, scoreId, pullOwnerId, pullCardId, pullTier, title, subtitle, countryAware, country, cacheBuster]);

  const absoluteImage = origin ? `${origin}${ogPath}` : ogPath;
  const numericMockScoreId = Number(scoreId);
  const fallbackReplayTitle = Number.isSafeInteger(numericMockScoreId) && numericMockScoreId > 0
    ? buildReplaySeoTitle(numericMockScoreId)
    : "Score replay";
  const mockTitle = kind === "player"
    ? `${username} - ${SITE_NAME}`
    : kind === "replay"
      ? replayMockTitle || fallbackReplayTitle
      : title === SITE_NAME || currentPreset.rawTitle
        ? title
        : `${title} - ${SITE_NAME}`;
  const mockSubtitle = kind === "player"
    ? `${username}'s osu!mania stats.`
    : kind === "replay"
      ? ""
      : subtitle;
  const domain = origin ? new URL(origin).host : "localhost:3000";
  const ogSize = OG_SIZES[kind] ?? DEFAULT_OG_SIZE;
  const ogAspect = ogSize.width / ogSize.height;
  const pullIdsValid = [pullOwnerId, pullCardId].every((raw) => {
    const value = Number(raw);
    return Number.isInteger(value) && value > 0;
  });

  const applyPreset = (p: Preset) => {
    setPresetKey(p.key);
    setKind(p.kind);
    setTitle(p.title);
    setSubtitle(p.subtitle);
    if (p.username) setUsername(p.username);
    if (p.scoreId != null) setScoreId(String(p.scoreId));
  };

  const refresh = () => setCacheBuster(Date.now());

  const copyUrl = async () => {
    try {
      await navigator.clipboard.writeText(absoluteImage);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // ignore
    }
  };

  return (
    <div className="flex-1 bg-osu-b5 min-h-[calc(100vh-60px)]">
      <Header onRefresh={refresh} />
      <div className="max-w-[1400px] mx-auto px-4 sm:px-5 py-5 space-y-5">
        <PresetChips presets={PRESETS} selectedKey={presetKey} onSelect={applyPreset} />

        {kind === "player" ? (
          <div className="grid gap-3 md:grid-cols-2">
            <TextField
              label="Username"
              hint="osu! username or user id — endpoint fetches live from osu! API"
              value={username}
              max={64}
              onChange={setUsername}
            />
            <div className="flex items-end text-[11px] text-osu-f1/80 leading-relaxed">
              Player layout ignores title/subtitle. Avatar, flag, rank, PP and acc are pulled from the osu! API using this username.
            </div>
          </div>
        ) : kind === "replay" ? (
          <div className="grid gap-3 md:grid-cols-2">
            <TextField
              label="Score ID"
              hint="osu! score id — endpoint fetches the score live"
              value={scoreId}
              max={32}
              onChange={setScoreId}
            />
            <div className="flex items-end text-[11px] text-osu-f1/80 leading-relaxed">
              Replay layout ignores title/subtitle/country. Cover, grade, pp, acc and mods come from the score itself.
            </div>
          </div>
        ) : kind === "pull" ? (
          <div className="space-y-3">
            <div className="grid gap-3 md:grid-cols-2">
              <TextField
                label="Owner user id"
                hint="the collector who pulled it — first path segment of /pull/{owner}/{card}"
                value={pullOwnerId}
                max={16}
                onChange={setPullOwnerId}
              />
              <TextField
                label="Card user id"
                hint="the player on the card — second path segment"
                value={pullCardId}
                max={16}
                onChange={setPullCardId}
              />
            </div>
            <RecentPullChips
              pulls={recentPulls}
              error={pullsError}
              ownerId={pullOwnerId}
              cardId={pullCardId}
              onSelect={(pull) => {
                setPullOwnerId(String(pull.ownerUserId));
                setPullCardId(String(pull.cardUserId));
              }}
            />
            <TierChips selected={pullTier} onSelect={setPullTier} />
            <div className="text-[11px] text-osu-f1/80 leading-relaxed">
              Portrait 720x1080: the minted card art at its stored tier plus a
              "pulled by" footer. Title/subtitle are fixed by the route and only
              feed the embed mocks. The endpoint renders the owner's minted
              skills snapshot, so a card the owner never pulled falls back to the
              default branded card instead. The rarity override is dev-only and
              uncached: what the site itself embeds is always the minted tier.
              {pullIdsValid ? null : (
                <span className="text-osu-red-light">
                  {" "}Both ids must be positive integers — the preview below is
                  the fallback card until they are.
                </span>
              )}
            </div>
          </div>
        ) : kind === "maps" ? (
          <div className="flex items-center gap-3">
            <label className="text-[10px] uppercase tracking-wider text-osu-f1 font-semibold">
              Country
            </label>
            <select
              value={country}
              onChange={(e) => setCountry(e.target.value)}
              className="bg-osu-b4/40 border border-osu-b3/30 rounded-md px-3 py-1.5 text-[12px] text-white focus:outline-none focus:border-osu-pink/50 cursor-pointer"
            >
              {COUNTRY_OPTIONS.map((c) => (
                <option key={c.code} value={c.code}>
                  {c.code} - {c.name}
                </option>
              ))}
            </select>
            <span className="text-[10px] text-osu-f1/70">
              mosaic of cover art from the country's favourites pool
            </span>
          </div>
        ) : STATIC_KINDS.has(kind) ? (
          <div className="text-[11px] text-osu-f1/80 leading-relaxed">
            {STATIC_KIND_NOTES[kind]} No inputs; title and subtitle here only
            affect the embed mocks below.
          </div>
        ) : (
          <div className="space-y-3">
            <div className="grid gap-3 md:grid-cols-2">
              <TextField
                label="Title"
                hint={`max ${MAX_TITLE} chars`}
                value={title}
                max={MAX_TITLE}
                onChange={setTitle}
              />
              <TextField
                label="Subtitle / description"
                hint={`max ${MAX_SUBTITLE} chars`}
                value={subtitle}
                max={MAX_SUBTITLE}
                multiline
                onChange={setSubtitle}
              />
            </div>
            {countryAware ? (
              <div className="flex items-center gap-3">
                <label className="text-[10px] uppercase tracking-wider text-osu-f1 font-semibold">
                  Country
                </label>
                <select
                  value={country}
                  onChange={(e) => setCountry(e.target.value)}
                  className="bg-osu-b4/40 border border-osu-b3/30 rounded-md px-3 py-1.5 text-[12px] text-white focus:outline-none focus:border-osu-pink/50 cursor-pointer"
                >
                  {COUNTRY_OPTIONS.map((c) => (
                    <option key={c.code} value={c.code}>
                      {c.code} - {c.name}
                    </option>
                  ))}
                </select>
                <span className="text-[10px] text-osu-f1/70">
                  endpoint fetches the top 5 of this country live
                </span>
              </div>
            ) : (
              <div className="text-[10px] text-osu-f1/70">
                This is the no-country embed — what users see when sharing the
                bare site URL. The image renders as a polaroid scrapbook with
                grade badges, featured country flags, and the global mania top
                50 as the dim avatar backdrop. Title/subtitle fields here only
                affect the title-only fallback if the polaroid render fails.
              </div>
            )}
          </div>
        )}

        <div className="flex items-center gap-3 text-[11px] flex-wrap">
          <a
            href={ogPath}
            target="_blank"
            rel="noreferrer"
            className="text-osu-pink hover:text-osu-pink-light underline underline-offset-2"
          >
            Open raw PNG
          </a>
          <button
            onClick={copyUrl}
            className="px-2 py-0.5 rounded bg-osu-b4/60 border border-osu-b3/30 text-osu-l2 hover:bg-osu-b3/60 hover:text-white transition-colors duration-[120ms] cursor-pointer text-[10px]"
          >
            {copied ? "Copied" : "Copy absolute URL"}
          </button>
          <code className="text-osu-f1 font-mono text-[10px] break-all">{ogPath}</code>
        </div>

        <SectionCard title={`Raw image - ${ogSize.width} x ${ogSize.height}`}>
          <div className="p-5 flex items-center justify-center bg-osu-b5/80">
            <img
              src={ogPath}
              width={ogSize.width}
              height={ogSize.height}
              alt="OG preview"
              className={`w-full rounded border border-osu-b3/30 shadow-lg ${
                ogAspect < 1 ? "max-w-[380px]" : "max-w-[900px]"
              }`}
            />
          </div>
        </SectionCard>

        <div className="grid gap-5 lg:grid-cols-2">
          <SectionCard title="Twitter / X (summary_large_image)">
            <div className="p-5 bg-[#0a0a0a] flex items-center justify-center">
              <TwitterMockup imageUrl={ogPath} title={mockTitle} domain={domain} />
            </div>
          </SectionCard>

          <SectionCard title="Discord">
            <div className="p-5 bg-[#313338] flex items-center justify-center">
              <DiscordMockup imageUrl={ogPath} title={mockTitle} subtitle={mockSubtitle} domain={domain} aspect={ogAspect} />
            </div>
          </SectionCard>

          <SectionCard title="iMessage / WhatsApp">
            <div className="p-5 bg-[#0b141a] flex items-center justify-center">
              <IMessageMockup imageUrl={ogPath} title={mockTitle} subtitle={mockSubtitle} domain={domain} aspect={ogAspect} />
            </div>
          </SectionCard>
        </div>

        {ogAspect < 1 ? (
          <div className="text-[10px] text-osu-f1/70 leading-relaxed max-w-2xl">
            Portrait card: X keeps its fixed 1.91:1 frame and centre-crops, so
            check that the card's top and bottom bands are expendable there.
            Discord and iMessage scale the whole card down instead.
          </div>
        ) : null}

        <div className="text-[10px] text-osu-f1/70 leading-relaxed max-w-2xl">
          The mockups are approximations - real platforms tweak their card chrome
          often and some crop the image differently on mobile vs desktop. Use them
          for composition/legibility checks, not pixel-perfect comparisons. When
          you ship, bump <code className="text-osu-c2">OG_IMAGE_VERSION</code> in
          {" "}
          <code className="text-osu-c2">src/lib/seo.ts</code> so cached scrapes refresh.
        </div>
      </div>
    </div>
  );
}

function Header({ onRefresh }: { onRefresh: () => void }) {
  return (
    <div className="bg-osu-d5 border-b border-osu-b3/40">
      <div className="max-w-[1400px] mx-auto px-4 sm:px-5 py-3 flex items-center gap-3">
        <h2 className="text-[13px] sm:text-[15px] font-medium text-osu-c2">OG image preview</h2>
        <span className="text-[9px] font-semibold uppercase tracking-wider px-1.5 py-0.5 rounded bg-osu-yellow/15 text-osu-yellow">
          dev
        </span>
        <div className="ml-auto flex items-center gap-3">
          <button
            onClick={onRefresh}
            className="px-2.5 py-1 rounded-md bg-osu-b4/60 border border-osu-b3/30 text-osu-l2 hover:bg-osu-b3/60 hover:text-white transition-colors duration-[120ms] cursor-pointer text-[11px]"
            title="Re-fetch /api/og ignoring browser cache (useful after editing og.ts)"
          >
            Reload image
          </button>
        </div>
      </div>
    </div>
  );
}

function PresetChips({
  presets,
  selectedKey,
  onSelect,
}: {
  presets: Preset[];
  selectedKey: string;
  onSelect: (p: Preset) => void;
}) {
  return (
    <div className="space-y-2">
      <div className="text-[9px] uppercase tracking-wider text-osu-f1 font-semibold">
        Preset pages
      </div>
      <div className="flex flex-wrap gap-2">
        {presets.map((p) => {
          const active = p.key === selectedKey;
          return (
            <button
              key={p.key}
              onClick={() => onSelect(p)}
              className={`px-3 py-1.5 rounded-md text-[11px] font-medium transition-colors duration-[120ms] cursor-pointer ${
                active
                  ? "bg-osu-pink/20 border border-osu-pink/40 text-white"
                  : "bg-osu-b4/40 border border-osu-b3/30 text-osu-l2 hover:bg-osu-b3/40 hover:text-white"
              }`}
            >
              {p.label}
              {p.noindex ? (
                <span className="ml-1.5 text-[9px] opacity-60">noindex</span>
              ) : null}
            </button>
          );
        })}
      </div>
    </div>
  );
}

function RecentPullChips({
  pulls,
  error,
  ownerId,
  cardId,
  onSelect,
}: {
  pulls: LivePackPullFeedEntry[];
  error: string;
  ownerId: string;
  cardId: string;
  onSelect: (pull: LivePackPullFeedEntry) => void;
}) {
  if (error) {
    return <div className="text-[10px] text-osu-f1/70">Recent pulls unavailable: {error}.</div>;
  }
  if (pulls.length === 0) {
    return <div className="text-[10px] text-osu-f1/70">Loading recent pulls...</div>;
  }
  return (
    <div className="space-y-2">
      <div className="text-[9px] uppercase tracking-wider text-osu-f1 font-semibold">
        Recent pulls
      </div>
      <div className="flex flex-wrap gap-2">
        {pulls.map((pull) => {
          const active = String(pull.ownerUserId) === ownerId && String(pull.cardUserId) === cardId;
          return (
            <button
              key={pull.id}
              onClick={() => onSelect(pull)}
              className={`px-2.5 py-1 rounded-md text-[11px] transition-colors duration-[120ms] cursor-pointer ${
                active
                  ? "bg-osu-pink/20 border border-osu-pink/40 text-white"
                  : "bg-osu-b4/40 border border-osu-b3/30 text-osu-l2 hover:bg-osu-b3/40 hover:text-white"
              }`}
            >
              <span className="font-medium">{pull.cardUsername}</span>
              <span className="opacity-60"> by {pull.ownerUsername}</span>
              {pull.tier ? <span className="ml-1.5 text-[9px] opacity-60">{pull.tier}</span> : null}
            </button>
          );
        })}
      </div>
    </div>
  );
}

function TierChips({
  selected,
  onSelect,
}: {
  selected: ManiaCardTier | "";
  onSelect: (tier: ManiaCardTier | "") => void;
}) {
  const options: Array<{ value: ManiaCardTier | ""; label: string }> = [
    { value: "", label: "Minted tier" },
    ...TIER_ORDER.map((tier) => ({ value: tier, label: MANIA_TIER_STYLES[tier].label })),
  ];
  return (
    <div className="space-y-2">
      <div className="text-[9px] uppercase tracking-wider text-osu-f1 font-semibold">
        Rarity
      </div>
      <div className="flex flex-wrap gap-2">
        {options.map((option) => {
          const active = option.value === selected;
          return (
            <button
              key={option.value || "minted"}
              onClick={() => onSelect(option.value)}
              className={`px-2.5 py-1 rounded-md text-[11px] font-medium transition-colors duration-[120ms] cursor-pointer ${
                active
                  ? "bg-osu-pink/20 border border-osu-pink/40 text-white"
                  : "bg-osu-b4/40 border border-osu-b3/30 text-osu-l2 hover:bg-osu-b3/40 hover:text-white"
              }`}
            >
              {option.label}
            </button>
          );
        })}
      </div>
    </div>
  );
}

function TextField({
  label,
  hint,
  value,
  max,
  multiline,
  onChange,
}: {
  label: string;
  hint: string;
  value: string;
  max: number;
  multiline?: boolean;
  onChange: (next: string) => void;
}) {
  const over = value.length > max;
  return (
    <label className="block">
      <div className="flex items-center justify-between mb-1">
        <span className="text-[10px] uppercase tracking-wider text-osu-f1 font-semibold">
          {label}
        </span>
        <span
          className={`text-[10px] font-mono ${over ? "text-osu-red-light" : "text-osu-f1"}`}
        >
          {value.length} / {max}
        </span>
      </div>
      {multiline ? (
        <textarea
          value={value}
          onChange={(e) => onChange(e.target.value)}
          rows={2}
          className="w-full bg-osu-b4/40 border border-osu-b3/30 rounded-md px-3 py-2 text-[13px] text-white resize-none focus:outline-none focus:border-osu-pink/50"
        />
      ) : (
        <input
          value={value}
          onChange={(e) => onChange(e.target.value)}
          className="w-full bg-osu-b4/40 border border-osu-b3/30 rounded-md px-3 py-2 text-[13px] text-white focus:outline-none focus:border-osu-pink/50"
        />
      )}
      <div className="text-[10px] text-osu-f1/70 mt-1">{hint}</div>
    </label>
  );
}

function SectionCard({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <div className="rounded-lg border border-osu-b3/30 bg-osu-b4/30 overflow-hidden">
      <div className="px-4 pt-3 pb-2 border-b border-osu-b3/20">
        <div className="text-[11px] font-semibold text-osu-c2 uppercase tracking-wider">
          {title}
        </div>
      </div>
      {children}
    </div>
  );
}

function TwitterMockup({
  imageUrl,
  title,
  domain,
}: {
  imageUrl: string;
  title: string;
  domain: string;
}) {
  return (
    <div className="w-full max-w-[506px] bg-[#000000] rounded-2xl overflow-hidden border border-[#2f3336] text-white">
      <div className="aspect-[1.91/1] bg-black overflow-hidden">
        <img src={imageUrl} alt="" className="w-full h-full object-cover" />
      </div>
      <div className="px-4 py-2.5 border-t border-[#2f3336]">
        <div className="text-[13px] text-[#71767b] leading-tight">
          From {domain}
        </div>
        <div className="text-[15px] font-normal leading-snug mt-0.5 line-clamp-1 text-[#e7e9ea]">
          {title}
        </div>
      </div>
    </div>
  );
}

function DiscordMockup({
  imageUrl,
  title,
  subtitle,
  domain,
  aspect,
}: {
  imageUrl: string;
  title: string;
  subtitle: string;
  domain: string;
  aspect: number;
}) {
  /* Discord fits a large embed image inside roughly 400x300, keeping its ratio
     — a landscape card fills the width, a portrait one is bounded by height. */
  const width = Math.min(400, 300 * aspect);
  return (
    <div className="w-full max-w-[432px] bg-[#2b2d31] rounded overflow-hidden flex text-[14px]">
      <div className="w-1 bg-[#ff66aa] flex-shrink-0" />
      <div className="flex-1 p-3 pr-4 min-w-0">
        <div className="text-[12px] text-[#dbdee1] leading-tight">{domain}</div>
        <div className="text-[#00a8fc] font-semibold text-[16px] leading-snug mt-1 hover:underline cursor-pointer line-clamp-2">
          {title}
        </div>
        <div className="text-[#dbdee1] mt-2 leading-snug line-clamp-4 whitespace-pre-wrap break-words text-[14px]">
          {subtitle}
        </div>
        <div className="mt-3 rounded overflow-hidden" style={{ width: `${width}px` }}>
          <div className="bg-black" style={{ aspectRatio: String(aspect) }}>
            <img src={imageUrl} alt="" className="w-full h-full object-cover" />
          </div>
        </div>
      </div>
    </div>
  );
}

function IMessageMockup({
  imageUrl,
  title,
  subtitle,
  domain,
  aspect,
}: {
  imageUrl: string;
  title: string;
  subtitle: string;
  domain: string;
  aspect: number;
}) {
  return (
    <div className="w-full max-w-[280px] bg-[#1c1c1e] rounded-[18px] overflow-hidden border border-[#3a3a3c] text-white">
      <div className="bg-black" style={{ aspectRatio: String(aspect) }}>
        <img src={imageUrl} alt="" className="w-full h-full object-cover" />
      </div>
      <div className="px-3 py-2.5 border-t border-[#3a3a3c]">
        <div className="text-[14px] font-semibold leading-tight line-clamp-2">
          {title}
        </div>
        <div className="text-[12px] text-[#8e8e93] leading-snug mt-0.5 line-clamp-2">
          {subtitle}
        </div>
        <div className="text-[11px] text-[#8e8e93] mt-1">{domain}</div>
      </div>
    </div>
  );
}
