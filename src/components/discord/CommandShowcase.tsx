import { Fragment, useEffect, useMemo, useState, type ReactNode } from "react";
import { GradeImg } from "../ui/GradeImg";
import { ModBadge } from "../ui/ModBadge";
import { CLIENT_CACHE_TTL, isCacheStale } from "../../lib/cache";
import { GLOBAL_SCOPE_CODE, getCountryName, isGlobalScope } from "../../lib/country";
import { useAuth } from "../../lib/auth-context";
import type { AuthViewer } from "../../lib/auth-shared";
import {
  fetchDiscordShowcase,
  fetchLiveRankingsSnapshot,
  type DiscordShowcase,
  type DiscordShowcasePlayer,
  type DiscordShowcaseScore,
  type DiscordShowcaseScoreHits,
  type DiscordShowcaseSnipe,
  type LiveGlobalRankingEntry,
} from "../../lib/live-backend";
import {
  discordShowcaseCacheKey,
  readDiscordShowcaseCache,
  writeDiscordShowcaseCache,
} from "../../lib/discord-showcase-cache";
import { getRankings } from "../../lib/osu";
import { useCountryWarming } from "../../lib/use-country-warming";
import type { LeanRankingEntry, RankingsResponse } from "../../lib/types";
import { useAppStore, useSelectedCountry } from "../../store";

// Authentic Discord palette so the previews read as real Discord messages.
const D = {
  msg: "#313338",
  embed: "#2b2d31",
  field: "#1e1f22",
  text: "#dbdee1",
  muted: "#949ba4",
  link: "#00a8fc",
  white: "#f2f3f5",
  btn: "#4e5058",
};
const BLURPLE = "#5865F2";
const PINK = "#ff66ab";
const GOLD = "#ffcc33";
const GREEN = "#3ba55d";
const SNIPE = "#ff4d6d";

// Local header art stands in for beatmap cover banners.
const COVER_A = "/images/headers/generic.jpg";

interface Command {
  id: string;
  label: string;
  invocation: string;
  group: string;
  blurb: string;
  accent: string;
  render: () => ReactNode;
}

interface ShowcasePlayer {
  id: number;
  username: string;
  countryCode: string;
  pp: number;
  globalRank: number | null;
  countryRank: number | null;
  accuracy: number | null;
  playCount: number | null;
}

interface ShowcaseSample {
  countryName: string;
  countryLabel: string;
  commandCountry: string;
  isGlobal: boolean;
  viewer: ShowcasePlayer | null;
  players: ShowcasePlayer[];
  leaderboard: ShowcasePlayer[];
}

// A single rendered score line, shared by the real-data and synthetic paths. The
// combo / score / stars / hits / cover fields back the detailed single-score card.
type ScoreRow = {
  grade: string;
  title: string;
  version: string;
  mods: string[];
  acc: string;
  pp: string;
  keys?: string;
  gain?: string;
  combo?: string;
  score?: string;
  stars?: string;
  hits?: DiscordShowcaseScoreHits;
  cover?: string;
};

// Resolves the dan emblem asset for a real estimate. The showcase is a web page,
// so it links the raw svg/webp directly (reform 1-10 svg, greek webp, LN 1-16
// svg), unlike the bot which rasterizes svg through the OG route for Discord.
const GREEK_DANS = new Set(["alpha", "beta", "gamma", "delta", "epsilon", "zeta", "eta"]);
function danEmblemSrc(label: string | null | undefined, familyKey: string | null | undefined): string {
  if (!label) return "/images/dans/reform/10.svg";
  if (familyKey === "ln" && /^(1[0-6]|[1-9])$/.test(label)) return `/images/dans/ln/${label}.svg`;
  if (/^([1-9]|10)$/.test(label)) return `/images/dans/reform/${label}.svg`;
  const lower = label.toLowerCase();
  if (GREEK_DANS.has(lower)) return `/images/dans/reform/${lower}.webp`;
  return "/images/dans/reform/10.svg";
}

const NUMBER_FORMAT = new Intl.NumberFormat("en-US");

function formatNumber(value: number | null | undefined): string {
  return Number.isFinite(value) ? NUMBER_FORMAT.format(Math.round(Number(value))) : "-";
}

function formatPp(value: number | null | undefined): string {
  return Number.isFinite(value) && Number(value) > 0 ? `${formatNumber(Number(value))}pp` : "-";
}

function formatRank(value: number | null | undefined): string {
  return Number.isFinite(value) && Number(value) > 0 ? `#${formatNumber(Number(value))}` : "-";
}

function formatAccuracy(value: number | null | undefined): string {
  if (!Number.isFinite(value) || Number(value) <= 0) return "-";
  // Player hit_accuracy arrives 0-100; tolerate a 0-1 fraction too, matching the
  // backend's accuracy formatter.
  const pct = Number(value) <= 1 ? Number(value) * 100 : Number(value);
  return `${pct.toFixed(2)}%`;
}

function commandName(player: ShowcasePlayer): string {
  if (player.id <= 0) return "player";
  return player.username.trim() || "player";
}

function userIdForAvatar(player: ShowcasePlayer): number | undefined {
  return player.id > 0 ? player.id : undefined;
}

function hashString(value: string): number {
  let hash = 2166136261;
  for (let i = 0; i < value.length; i += 1) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function seededShuffle<T>(items: T[], seedText: string): T[] {
  const shuffled = [...items];
  let seed = hashString(seedText) || 1;
  for (let i = shuffled.length - 1; i > 0; i -= 1) {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    const j = seed % (i + 1);
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }
  return shuffled;
}

function fallbackPlayers(country: string): ShowcasePlayer[] {
  const scope = isGlobalScope(country) ? GLOBAL_SCOPE_CODE : country.toUpperCase();
  const countryCode = isGlobalScope(scope) ? "" : scope;
  return Array.from({ length: 10 }, (_, index) => {
    const rank = index + 1;
    return {
      id: 0,
      username: `Player ${rank}`,
      countryCode,
      pp: 13000 - index * 850,
      globalRank: 40 + index * 57,
      countryRank: isGlobalScope(scope) ? null : rank,
      accuracy: 99.4 - index * 0.18,
      playCount: 90000 - index * 7400,
    };
  });
}

function countryEntryToPlayer(entry: LeanRankingEntry, index: number, country: string): ShowcasePlayer {
  return {
    id: entry.user.id,
    username: entry.user.username,
    countryCode: entry.user.country_code || country,
    pp: entry.pp,
    globalRank: entry.global_rank,
    countryRank: index + 1,
    accuracy: entry.hit_accuracy,
    playCount: entry.play_count,
  };
}

function globalEntryToPlayer(entry: LiveGlobalRankingEntry): ShowcasePlayer {
  return {
    id: entry.user.id,
    username: entry.user.username,
    countryCode: entry.user.country_code,
    pp: entry.pp,
    globalRank: entry.global_rank ?? entry.rank,
    countryRank: entry.country_rank,
    accuracy: entry.hit_accuracy,
    playCount: entry.play_count,
  };
}

function uniquePlayers(players: ShowcasePlayer[]): ShowcasePlayer[] {
  const seen = new Set<string>();
  const unique: ShowcasePlayer[] = [];
  for (const player of players) {
    const key = player.id > 0 ? `id:${player.id}` : `name:${player.username.toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(player);
  }
  return unique;
}

function viewerToPlayer(viewer: AuthViewer | null, sourcePlayers: ShowcasePlayer[]): ShowcasePlayer | null {
  if (!viewer) return null;

  const matched = sourcePlayers.find((player) => player.id === viewer.id);
  const countryCode = viewer.countryCode?.trim().toUpperCase() || matched?.countryCode || "";
  if (matched) {
    return {
      ...matched,
      username: viewer.username || matched.username,
      countryCode,
    };
  }

  return {
    id: viewer.id,
    username: viewer.username,
    countryCode,
    pp: 0,
    globalRank: null,
    countryRank: null,
    accuracy: null,
    playCount: null,
  };
}

function buildShowcaseSample(
  country: string,
  rankings: RankingsResponse | null,
  liveRankings: LiveGlobalRankingEntry[] | null,
  viewer: AuthViewer | null,
  seedText: string,
): ShowcaseSample {
  const normalizedCountry = country.toUpperCase();
  const isGlobal = isGlobalScope(normalizedCountry);
  const countryName = getCountryName(normalizedCountry);
  const countryLabel = isGlobal ? "Global" : normalizedCountry;
  const commandCountry = isGlobal ? GLOBAL_SCOPE_CODE : normalizedCountry;
  const livePlayers = (liveRankings ?? []).map(globalEntryToPlayer);
  const sourcePlayers = livePlayers.length > 0
    ? livePlayers
    : (rankings?.ranking ?? [])
      .filter((entry) => entry.user.is_active !== false)
      .map((entry, index) => countryEntryToPlayer(entry, index, normalizedCountry));
  const fallback = fallbackPlayers(normalizedCountry);
  const viewerPlayer = viewerToPlayer(viewer, sourcePlayers);
  const poolPlayers = viewerPlayer
    ? sourcePlayers.filter((player) => player.id !== viewerPlayer.id)
    : sourcePlayers;
  const shuffled = seededShuffle(
    uniquePlayers(poolPlayers),
    `${normalizedCountry}:${seedText}:${sourcePlayers.map((p) => p.id).join(":")}`,
  );
  const players = shuffled.slice(0, 8);
  while (players.length < 8) players.push(fallback[players.length]);

  const leaderboard = sourcePlayers.length > 0
    ? sourcePlayers.slice(0, 4)
    : players.slice(0, 4);

  return {
    countryName,
    countryLabel,
    commandCountry,
    isGlobal,
    viewer: viewerPlayer,
    players,
    leaderboard,
  };
}

// ---------------------------------------------------------------------------
// Discord chrome
// ---------------------------------------------------------------------------

function BotAvatar({ size = 40 }: { size?: number }) {
  return (
    <img
      src="/images/discord/bot-avatar.png"
      alt="maniabot"
      className="shrink-0 rounded-full object-cover"
      style={{ width: size, height: size }}
      loading="lazy"
    />
  );
}

function FauxMessage({ invocation, children }: { invocation: string; children: ReactNode }) {
  return (
    <div className="rounded-lg p-3 sm:p-4" style={{ backgroundColor: D.msg }}>
      <div className="flex items-center gap-2">
        <BotAvatar size={40} />
        <span className="text-[15px] font-semibold" style={{ color: D.white }}>maniabot</span>
        <span className="rounded px-1 py-px text-[9px] font-bold uppercase text-white" style={{ backgroundColor: BLURPLE }}>App</span>
        <span className="truncate text-[12px]" style={{ color: D.muted }}>used <code style={{ color: D.link }}>{invocation}</code></span>
      </div>
      <div className="mt-1.5 pl-1 sm:pl-12">{children}</div>
    </div>
  );
}

// A Components V2 container: accent bar, and an optional thumbnail accessory
// that sits top-right beside the content (Discord has no top-left slot). The
// accessory narrows the whole column slightly, close enough to the real layout.
function Embed({ accent, thumb, children }: { accent: string; thumb?: ReactNode; children: ReactNode }) {
  return (
    <div className="max-w-[460px] overflow-hidden rounded" style={{ backgroundColor: D.embed, borderLeft: `4px solid ${accent}` }}>
      <div className="flex items-start gap-3 p-3">
        <div className="min-w-0 flex-1 space-y-2">{children}</div>
        {thumb ? <div className="shrink-0 pt-0.5">{thumb}</div> : null}
      </div>
    </div>
  );
}

// The V2 thumbnail accessory: a small rounded square, cover art or avatar.
function Thumb({ src }: { src: string }) {
  return <img src={src} alt="" className="h-16 w-16 rounded-lg object-cover" loading="lazy" />;
}

function AvatarThumb({ userId }: { userId?: number }) {
  if (!userId) return <div className="h-16 w-16 rounded-lg bg-osu-b6" />;
  return <img src={`/api/avatar?u=${userId}`} alt="" className="h-16 w-16 rounded-lg object-cover" loading="lazy" />;
}

// The author line converts to a "### [name](url)" heading in V2, so it renders
// as bold link-coloured text, no inline avatar (the avatar moves to the
// thumbnail slot when the card has no cover art).
function EmbedAuthor({ name }: { name: string }) {
  return <div className="text-[14px] font-bold" style={{ color: D.link }}>{name}</div>;
}

// Titles render white unless the embed carries a URL, in which case the whole
// heading is a masked link and Discord paints it link-blue.
function EmbedTitle({ children, linked }: { children: ReactNode; linked?: boolean }) {
  return <div className="text-[14px] font-bold" style={{ color: linked ? D.link : D.white }}>{children}</div>;
}

function Lead({ children }: { children: ReactNode }) {
  return <div className="pt-0.5 text-[12px] font-semibold" style={{ color: D.white }}>{children}</div>;
}

// Inline fields render as owo-style markdown stat lines in V2: two
// `**Label:** value` pairs per line. Bold labels, plain values, no colours.
function Fields({ items }: { items: Array<{ name: string; value: string }> }) {
  const lines: Array<Array<{ name: string; value: string }>> = [];
  for (let i = 0; i < items.length; i += 2) lines.push(items.slice(i, i + 2));
  return (
    <div className="space-y-0.5 text-[12px]" style={{ color: D.text }}>
      {lines.map((pair, i) => (
        <div key={i}>
          {pair.map((f, j) => (
            <Fragment key={f.name}>
              {j > 0 ? <span> • </span> : null}
              <b style={{ color: D.white }}>{f.name}:</b> {f.value}
            </Fragment>
          ))}
        </div>
      ))}
    </div>
  );
}

function Footer({ text }: { text: string }) {
  return <div className="pt-1 text-[10px]" style={{ color: D.muted }}>{text}</div>;
}

function Buttons({ items }: { items: string[] }) {
  return (
    <div className="flex flex-wrap gap-2 pt-1">
      {items.map((label) => (
        <span key={label} className="inline-flex items-center gap-1 rounded px-2.5 py-1 text-[11px] font-semibold" style={{ backgroundColor: D.btn, color: D.white }}>
          {label}
          <span style={{ color: D.muted }}>↗</span>
        </span>
      ))}
    </div>
  );
}

// Greyed secondary buttons for paginated replies. Prev is disabled on page one.
function PageButtons({ canPrev = false }: { canPrev?: boolean }) {
  const items: Array<{ label: string; enabled: boolean }> = [
    { label: "Prev", enabled: canPrev },
    { label: "Next", enabled: true },
    { label: "Refresh", enabled: true },
  ];
  return (
    <div className="flex flex-wrap gap-2 pt-1">
      {items.map(({ label, enabled }) => (
        <span
          key={label}
          className="inline-flex items-center rounded px-2.5 py-1 text-[11px] font-semibold"
          style={{ backgroundColor: D.btn, color: enabled ? D.white : D.muted, opacity: enabled ? 1 : 0.5 }}
        >
          {label}
        </span>
      ))}
    </div>
  );
}

// The grey secondary "Reroll" button the random pickers attach above their link
// buttons, so the preview reads as "click for another pick".
function RerollPill() {
  return (
    <div className="pt-1">
      <span className="inline-flex items-center rounded px-2.5 py-1 text-[11px] font-semibold" style={{ backgroundColor: D.btn, color: D.white }}>
        Reroll
      </span>
    </div>
  );
}

// Muted middot separator, matching the bot's inline list style.
function Dot() {
  return <span style={{ color: D.muted }}>•</span>;
}

// Confirmations and errors are plain text messages, not embeds: no container,
// no accent bar, exactly as Components V2 renders a bare content reply.
function TextReply({ children }: { children: ReactNode }) {
  return <div className="max-w-[460px] text-[13px]" style={{ color: D.text }}>{children}</div>;
}

// One play, rendered with the real osu grade + mod emojis the bot registers.
// Everything else is markdown Discord can do: link-blue title, bold pp.
function ScoreLine({ grade, title, version, mods, acc, pp, gain }: {
  grade: string; title: string; version: string; mods: string[]; acc: string; pp: string; keys?: string; gain?: string;
}) {
  return (
    <div className="flex items-center gap-2 py-0.5">
      <GradeImg grade={grade} size={22} />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5">
          <span className="truncate text-[12px] font-medium" style={{ color: D.link }}>{title}</span>
          <span className="shrink-0 text-[10px]" style={{ color: D.muted }}>[{version}]</span>
        </div>
        <div className="mt-0.5 flex items-center gap-1">
          {mods.length ? mods.map((m) => <ModBadge key={m} mod={m} size={0.5} />) : <span className="text-[9px]" style={{ color: D.muted }}>nomod</span>}
        </div>
      </div>
      <div className="shrink-0 text-right text-[12px] tabular-nums">
        <span style={{ color: D.muted }}>{acc}</span>{" "}
        <span className="font-bold" style={{ color: D.white }}>{pp}</span>
        {gain ? <span style={{ color: D.text }}> ({gain})</span> : null}
      </div>
    </div>
  );
}

// The judgement breakdown, rendered with the bot's registered judgement pill
// emojis (coloured 320/300/... plates) followed by plain counts.
function HitBreakdown({ hits }: { hits: DiscordShowcaseScoreHits }) {
  const cells: Array<[string, number]> = [
    ["320", hits.max], ["300", hits.n300], ["200", hits.n200],
    ["100", hits.n100], ["50", hits.n50], ["miss", hits.miss],
  ];
  return (
    <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[12px]" style={{ color: D.text }}>
      {cells.map(([key, value]) => (
        <span key={key} className="flex items-center gap-1">
          <img src={`/images/discord/emojis/hit_${key}.png`} alt={key} className="h-[13px] w-auto" loading="lazy" />
          <span className="tabular-nums">{formatNumber(value)}</span>
        </span>
      ))}
    </div>
  );
}

// The owo-style detailed card body for a single score: grade + mods, stars and
// keys, then accuracy / combo / score, the judgement breakdown, and pp.
function DetailedScore({ grade, mods, stars, keys, acc, combo, score, hits, pp, gain }: {
  grade: string; mods: string[]; stars?: string; keys?: string; acc: string; combo?: string; score?: string; hits?: DiscordShowcaseScoreHits; pp: string; gain?: string;
}) {
  return (
    <div className="space-y-1.5 pt-0.5">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <GradeImg grade={grade} size={22} />
        {mods.length ? mods.map((m) => <ModBadge key={m} mod={m} size={0.5} />) : <span className="text-[9px]" style={{ color: D.muted }}>nomod</span>}
        {stars ? <span className="text-[12px]" style={{ color: D.text }}>{stars}★</span> : null}
        {keys ? <span className="text-[12px]" style={{ color: D.muted }}>• {keys}</span> : null}
      </div>
      <div className="flex flex-wrap items-baseline gap-x-2.5 text-[12px]">
        <span className="text-[15px] font-bold tabular-nums" style={{ color: D.white }}>{acc}</span>
        {combo ? <span className="tabular-nums" style={{ color: D.text }}>{combo}</span> : null}
        {score ? <span className="tabular-nums" style={{ color: D.muted }}>{score}</span> : null}
      </div>
      {hits ? <HitBreakdown hits={hits} /> : null}
      {pp !== "-" || gain ? (
        <div className="text-[13px]">
          <span className="font-bold" style={{ color: D.white }}>{pp}</span>
          {gain ? <span style={{ color: D.text }}> ({gain})</span> : null}
        </div>
      ) : null}
    </div>
  );
}

// One leaderboard line, exactly as the bot writes it: a `#N` code chip, bold
// name, bold pp. No avatars or medal colours; Discord text can't do either.
function RankRow({ rank, name, pp }: { rank: number; name: string; pp: string }) {
  return (
    <div className="flex items-center gap-2 py-0.5 text-[12px]">
      <span className="w-8 shrink-0 rounded text-center font-mono text-[11px] tabular-nums" style={{ backgroundColor: D.field, color: D.text }}>
        #{rank}
      </span>
      <span className="font-bold" style={{ color: D.white }}>{name}</span>
      <span className="ml-auto font-bold tabular-nums" style={{ color: D.white }}>{pp}</span>
    </div>
  );
}

// Compact live-feed row: grade, player, map, mods, acc and pp on one line.
function TrackerRow({ grade, player, title, mods, acc, pp }: {
  grade: string; player: string; title: string; mods: string[]; acc: string; pp: string;
}) {
  return (
    <div className="flex items-center gap-1.5 py-0.5 text-[12px]">
      <GradeImg grade={grade} size={18} />
      <b className="shrink-0" style={{ color: D.white }}>{player}</b>
      <span className="truncate" style={{ color: D.link }}>{title}</span>
      {mods.map((m) => <ModBadge key={m} mod={m} size={0.45} />)}
      <span className="ml-auto shrink-0 tabular-nums" style={{ color: D.muted }}>{acc}</span>
      <b className="shrink-0 tabular-nums" style={{ color: D.white }}>{pp}</b>
    </div>
  );
}

// Numbered farmed-map row for /maps: rank, title, stars, average pp and player count.
function MapRow({ rank, title, stars, avg, players }: {
  rank: number; title: string; stars: string; avg: string; players: string;
}) {
  return (
    <div className="flex flex-wrap items-center gap-1.5 py-0.5 text-[12px]" style={{ color: D.text }}>
      <span className="w-6 shrink-0 rounded text-center font-mono text-[11px] tabular-nums" style={{ backgroundColor: D.field, color: D.text }}>#{rank}</span>
      <span className="truncate" style={{ color: D.link }}>{title}</span>
      <span>{stars}★</span>
      <Dot />
      <span style={{ color: D.muted }}>avg <b style={{ color: D.white }}>{avg}</b></span>
      <Dot />
      <span style={{ color: D.muted }}>{players} players</span>
    </div>
  );
}

// osu! mania mode glyph, the same logo the in-app card stamps top-left. The
// path is authored y-up (canvas flips it), so flip it for svg's y-down space.
const MANIA_GLYPH_D =
  "M500 48q-21 0-35 15t-15 35v504q0 21 15 36t35 14 36-14 14-36v-504q0-21-14-35t-36-15z m-110 192v220q0 21-14 36t-36 14-35-14-15-36v-220q0-21 15-35t35-15 36 15 14 35z m320 0v220q0 21-14 36t-36 14-35-14-15-36v-220q0-21 15-35t35-15 36 15 14 35z m-210 500q-106 0-197-53-88-52-140-140-53-91-53-197t53-197q52-88 140-140 91-53 197-53t197 53q88 52 140 140 53 91 53 197t-53 197q-52 88-140 140-91 53-197 53z m0 80q97 0 182-36t150-102q64-62 101-148t37-184-36-182-102-150q-62-64-148-101t-184-37-182 36-150 102q-64 62-101 149t-37 183 37 182 101 150q62 64 149 101t183 37v0z";

// Floating osu-style triangles: a jittered grid so positions never line up,
// varied sizes, up or down but never tilted, overlapping into soft facets.
const TRIANGLES = triBuilder();
function triBuilder() {
  const rand = (n: number) => {
    const v = Math.sin(n) * 43758.5453123;
    return v - Math.floor(v);
  };
  const poly = (pts: Array<[number, number]>, fill: string) =>
    `<path d="${pts.map(([x, y], i) => `${i === 0 ? "M" : "L"}${x.toFixed(1)} ${y.toFixed(1)}`).join(" ")} Z" fill="${fill}"/>`;
  // Coords are authored on a 1000x1400 grid then scaled to the card.
  return (w: number, h: number): string => {
    const sx = w / 1000;
    const sy = h / 1400;
    let paths = "";
    for (let row = 0; row < 6; row += 1) {
      for (let col = 0; col < 5; col += 1) {
        const i = row * 11 + col;
        if (rand(i * 19.17 + 4.2) < 0.4) continue;
        const cx = (col * 200 + 100 + (rand(i * 43.91 + 8.5) - 0.5) * 130) * sx;
        const cy = (row * 233 + 117 + (rand(i * 29.37 + 12.4) - 0.5) * 130) * sy;
        const side = (230 + rand(i * 13.81 + 2.7) * 300) * sx;
        const hgt = side * 0.866;
        const up = rand(i * 7.3 + 3.1) > 0.5;
        const pts: Array<[number, number]> = up
          ? [[cx, cy - (hgt * 2) / 3], [cx + side / 2, cy + hgt / 3], [cx - side / 2, cy + hgt / 3]]
          : [[cx, cy + (hgt * 2) / 3], [cx + side / 2, cy - hgt / 3], [cx - side / 2, cy - hgt / 3]];
        // Fewer, larger, low-contrast facets (subtle like the reference). Dark
        // ones stay extra faint since dark-on-light reads strongly; ~50/50
        // light/dark so the pale top and dark bottom each show some.
        const dark = rand(i * 3.11 + 6.9) > 0.5;
        const a = dark ? 0.035 + rand(i * 5.21 + 1.3) * 0.04 : 0.05 + rand(i * 5.21 + 1.3) * 0.06;
        paths += poly(pts, dark ? `rgba(0,0,0,${a.toFixed(3)})` : `rgba(255,255,255,${a.toFixed(3)})`);
      }
    }
    return `<svg xmlns='http://www.w3.org/2000/svg' width='${w}' height='${h}' viewBox='0 0 ${w} ${h}'>${paths}</svg>`;
  };
}
const TRI_BG = `url("data:image/svg+xml,${encodeURIComponent(TRIANGLES(300, 420))}")`;

function ManiaGlyph({ size }: { size: number }) {
  return (
    <svg width={size} height={size} viewBox="-40 -40 1080 1080" style={{ display: "block" }} aria-hidden>
      {/* The glyph baseline sits at 0.86 of its height (matches the in-app card). */}
      <g transform="matrix(1,0,0,-1,0,860)">
        <path d={MANIA_GLYPH_D} fill="#ffffff" />
      </g>
    </svg>
  );
}

// Faithful miniature of the in-app maniacard front: a tier-gradient body (the
// tier colour IS the card's identity, not decoration), the mania glyph badge,
// username plate, italic tier label, big avatar, the three skill values as
// plain stats and the star-rating row. No invented bars or gradients.
function ManiacardArt({ player }: { player: ShowcasePlayer }) {
  const shadow = "0 1px 3px rgba(0,0,0,0.55)";
  // The real Legendary tier fill (#fff7ad -> #fbbf24 -> #92400e on the diagonal).
  const tierBg = "linear-gradient(142deg, #fff7ad 0%, #fbbf24 42%, #92400e 100%)";
  const stats: Array<[string, string]> = [["Control", "1180"], ["Speed", "1240"], ["Precision", "1310"]];
  // starAvg 6.20 -> ceil = 7 stars, 6 full + 1 empty (see buildStarSegments).
  const stars = [true, true, true, true, true, true, false];
  return (
    <div className="relative mx-auto overflow-hidden" style={{ width: 300, height: 420, borderRadius: 18, background: tierBg }}>
      {/* osu triangle texture over the tier gradient */}
      <div className="pointer-events-none absolute inset-0" style={{ backgroundImage: TRI_BG, backgroundSize: "100% 100%", backgroundRepeat: "no-repeat" }} />
      {/* mode badge */}
      <div className="absolute flex items-center justify-center" style={{ left: 12, top: 12, width: 40, height: 40, borderRadius: 9, background: "rgba(0,0,0,0.20)", border: "1px solid rgba(255,255,255,0.35)" }}>
        <ManiaGlyph size={26} />
      </div>
      {/* username plate */}
      <div className="absolute flex items-center justify-center" style={{ left: 73, top: 22, width: 180, height: 32, borderRadius: 8, background: "rgba(0,0,0,0.34)" }}>
        <span className="truncate px-2 text-[15px] font-black text-white" style={{ textShadow: shadow }}>{player.username}</span>
      </div>
      {/* tier label */}
      <div className="absolute" style={{ right: 18, top: 56, fontStyle: "italic" }}>
        <span className="text-[17px] font-black uppercase tracking-wide text-white" style={{ textShadow: "0 0 14px rgba(251,191,36,0.75), 0 2px 4px rgba(0,0,0,0.6)" }}>Legendary</span>
      </div>
      {/* avatar */}
      <div className="absolute overflow-hidden" style={{ left: 55, top: 84, width: 189, height: 189, borderRadius: 12, border: "3px solid rgba(255,255,255,0.18)" }}>
        {player.id > 0 ? (
          <img src={`/api/avatar?u=${player.id}`} alt="" className="h-full w-full object-cover" loading="lazy" />
        ) : (
          <div className="h-full w-full bg-osu-b6" />
        )}
      </div>
      {/* stats */}
      <div className="absolute flex flex-col justify-center gap-1.5 px-4" style={{ left: 61, top: 282, width: 178, height: 74, borderRadius: 12, background: "rgba(0,0,0,0.30)" }}>
        {stats.map(([label, value]) => (
          <div key={label} className="flex items-baseline justify-between">
            <span className="text-[12px] font-bold text-white/85" style={{ textShadow: shadow }}>{label}</span>
            <span className="text-[15px] font-black tabular-nums text-white" style={{ textShadow: shadow }}>{value}</span>
          </div>
        ))}
      </div>
      {/* stars */}
      <div className="absolute flex w-full flex-col items-center" style={{ left: 0, top: 368 }}>
        <div className="flex gap-0.5 text-[15px] leading-none" style={{ textShadow: shadow }}>
          {stars.map((full, i) => (
            <span key={i} style={{ color: full ? "#fcd34d" : "rgba(252,211,77,0.28)" }}>★</span>
          ))}
        </div>
        <span className="mt-1 text-[12px] font-bold text-white/80" style={{ textShadow: shadow }}>6.20★</span>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Command previews
// ---------------------------------------------------------------------------

function buildCommands(sample: ShowcaseSample, fx: DiscordShowcase | null): Command[] {
  const fallback = fallbackPlayers(sample.commandCountry)[0];
  const pick = (index: number): ShowcasePlayer => sample.players[index] ?? sample.viewer ?? fallback;
  const self = sample.viewer ?? pick(0);
  const profile = pick(0);
  const recent = pick(1);
  const card = pick(2);
  const activity = pick(3);
  const goals = pick(4);
  const pb = pick(5);
  const farm = pick(6);
  const rival = sample.viewer ? pick(0) : pick(1);
  const feed = pick(2);
  const third = pick(2);
  const fourth = pick(3);
  const fifth = pick(4);
  const rankFor = (player: ShowcasePlayer, index: number): number | null =>
    sample.isGlobal
      ? player.globalRank ?? (player.id > 0 ? null : index + 1)
      : player.countryRank ?? (player.id > 0 ? null : index + 1);
  const playPp = (player: ShowcasePlayer, fallback: number): string =>
    `${Math.max(300, Math.round((player.pp > 0 ? player.pp : fallback) * 0.065))}pp`;
  const rankWins = (a: number | null, b: number | null): boolean => a != null && (b == null || a <= b);
  const numberWins = (a: number | null | undefined, b: number | null | undefined): boolean =>
    a != null && (b == null || a >= b);
  const goalTarget = Math.max(1000, Math.ceil((goals.pp + 700) / 1000) * 1000);
  const goalPercent = goals.pp > 0 ? Math.min(99, Math.max(1, Math.round((goals.pp / goalTarget) * 100))) : 75;
  const selfRank = rankFor(self, 0);
  const rivalRank = rankFor(rival, 1);
  const selfAccuracy = self.accuracy ?? 99.4;
  const rivalAccuracy = rival.accuracy ?? 99.2;
  const rankingsTitle = sample.isGlobal ? "Global mania rankings" : `${sample.countryName} mania rankings`;
  const latestScoresTitle = sample.isGlobal ? "Latest tracked scores" : `Latest scores in ${sample.countryLabel}`;
  const mapsTitle = sample.isGlobal ? "Most farmed maps globally" : `Most farmed maps in ${sample.countryLabel}`;
  const scopeFooter = `${sample.countryLabel} • maniabot`;

  // ----- Real captured data (live backend) with synthetic fallbacks ---------
  // Each player-centric command renders a DIFFERENT pool player (matching the
  // backend's per-index detail capture), so the previews don't all show the same
  // person. Each command prefers its fx.* section and falls back to the
  // hardcoded mock + sampled player when the fixture is missing.
  const pLink = fx?.players?.[0] ?? null;     // /link, /me, /vs left
  const pProfile = fx?.players?.[1] ?? null;  // /player, /pb, /replay, /vs right
  const pRecent = fx?.players?.[2] ?? null;   // /recent
  const pCard = fx?.players?.[3] ?? null;     // /maniacard
  const pActivity = fx?.players?.[4] ?? null; // /activity
  const pGoals = fx?.players?.[5] ?? null;    // /goals
  const pFarm = fx?.players?.[6] ?? null;     // /farm
  const authorName = (p: DiscordShowcasePlayer | null, sampled: ShowcasePlayer): string => p?.username ?? sampled.username;
  const authorAvatar = (p: DiscordShowcasePlayer | null, sampled: ShowcasePlayer): number | undefined => p?.id ?? userIdForAvatar(sampled);
  const countryField = (code: string): string => (code && !isGlobalScope(code) ? `Country (${code})` : "Country");
  const fxScore = (s: DiscordShowcaseScore): ScoreRow => ({
    grade: s.grade, title: s.title, version: s.version, mods: s.mods, acc: s.acc, pp: s.pp, keys: s.keys || undefined, gain: s.gain,
    combo: s.combo, score: s.score, stars: s.stars, hits: s.hits, cover: s.cover,
  });

  const playerName = pProfile?.username ?? commandName(profile);
  const playerSs = formatNumber(pProfile?.ssCount ?? 312);
  const playerS = formatNumber(pProfile?.sCount ?? 540);
  const playerA = formatNumber(pProfile?.aCount ?? 88);
  const playerTopMod = pProfile?.topMod ?? "DT";
  const cardArtPlayer: ShowcasePlayer = pCard ? { ...card, id: pCard.id, username: pCard.username } : card;

  const playerTop: ScoreRow[] = fx?.topPlays?.length
    ? fx.topPlays.slice(0, 3).map(fxScore)
    : [
      { grade: "X", title: "xi - Blue Zenith", version: "4K Black Another", keys: "4K", mods: ["HD", "DT"], acc: "100%", pp: playPp(profile, 13000) },
      { grade: "S", title: "xi - FREEDOM DiVE", version: "4K Another", keys: "4K", mods: ["DT"], acc: "99.2%", pp: playPp(rival, 11500) },
      { grade: "S", title: "UNDEAD CORPORATION - Everything Will Freeze", version: "[7K] SHD", keys: "7K", mods: [], acc: "98.7%", pp: playPp(third, 10000) },
    ];
  const recentRows: ScoreRow[] = fx?.recent?.length
    ? fx.recent.slice(0, 3).map(fxScore)
    : [
      {
        grade: "A", title: "Yomi yori", version: "4K Master", keys: "4K", mods: ["HD"], acc: "97.14%", pp: "-",
        combo: "1,204x", score: "986,540", stars: "5.80", hits: { max: 1180, n300: 96, n200: 14, n100: 6, n50: 1, miss: 3 },
      },
      { grade: "S", title: "Aleph-0", version: "4K Ultra", keys: "4K", mods: [], acc: "98.90%", pp: playPp(recent, 9400) },
      { grade: "F", title: "Cyber Induction", version: "4K SHD", keys: "4K", mods: ["DT"], acc: "91.04%", pp: "-" },
    ];

  const me = fx?.me ?? null;
  const meSessions = me ? formatNumber(me.sessions) : formatNumber(Math.max(1, Math.round((self.playCount ?? 24000) / 45)));

  const act = fx?.activity ?? null;
  const activityPatterns = act?.patterns?.length
    ? act.patterns
    : [{ label: "Stream", pct: 42 }, { label: "Jack", pct: 21 }, { label: "LN", pct: 18 }, { label: "Chordjack", pct: 11 }];

  // /goals and /farm are a fixed example (top players rarely have site goals or
  // 4K farm recs); only the player identity above varies.
  const goalsOpen = [
    { headline: `Reach ${formatPp(goalTarget)}`, trailer: `${formatPp(goals.pp)}, ${goalPercent}%` },
    { headline: "99.00% on Blue Zenith [4K Another]", trailer: "best 98.20%, 80%" },
  ];
  const goalsFooter = "2 open • 5 done • maniabot";

  const farmRecs = [
    { index: 1, title: "Output", mods: ["DT"], gain: "+42pp" },
    { index: 2, title: "The Sun The Moon The Star", mods: [], gain: "+37pp" },
    { index: 3, title: "Singularity", mods: ["HD"], gain: "+31pp" },
  ];
  const farmKeyMode = "4k";

  const vsTitle = fx?.vs?.title ?? `${self.username} vs ${rival.username}`;
  const vsRows = fx?.vs?.rows?.length
    ? fx.vs.rows
    : [
      { label: "pp", a: formatPp(self.pp), b: formatPp(rival.pp), aWins: numberWins(self.pp, rival.pp), bWins: numberWins(rival.pp, self.pp) },
      { label: "Global rank", a: formatRank(self.globalRank), b: formatRank(rival.globalRank), aWins: rankWins(self.globalRank, rival.globalRank), bWins: rankWins(rival.globalRank, self.globalRank) },
      { label: "Country rank", a: formatRank(selfRank), b: formatRank(rivalRank), aWins: rankWins(selfRank, rivalRank), bWins: rankWins(rivalRank, selfRank) },
      { label: "Accuracy", a: formatAccuracy(selfAccuracy), b: formatAccuracy(rivalAccuracy), aWins: numberWins(selfAccuracy, rivalAccuracy), bWins: numberWins(rivalAccuracy, selfAccuracy) },
    ];
  const vsLeftName = fx?.vs ? (pLink?.username ?? self.username) : self.username;
  const vsRightName = pProfile?.username ?? rival.username;

  const pbView = {
    title: fx?.pb?.mapTitle ?? "xi - Blue Zenith [4K Black Another]",
    grade: fx?.pb?.grade ?? "X",
    mods: fx?.pb?.mods ?? ["DT"],
    acc: fx?.pb?.acc ?? "99.41%",
    combo: fx?.pb?.combo ?? "1,532x FC",
    score: fx?.pb?.score ?? "4,231,560",
    stars: fx?.pb?.stars ?? "6.20",
    keys: fx?.pb?.keys || "4K",
    pp: fx?.pb?.pp ?? playPp(pb, 13000),
    hits: fx?.pb?.hits ?? { max: 1480, n300: 48, n200: 3, n100: 1, n50: 0, miss: 0 },
    cover: fx?.pb?.cover,
  };

  const rankRows = fx?.rankings?.length
    ? fx.rankings.slice(0, 4).map((r) => ({ rank: r.rank, name: r.username, userId: r.userId > 0 ? r.userId : undefined, pp: r.pp }))
    : sample.leaderboard.slice(0, 4).map((p, index) => ({ rank: rankFor(p, index) ?? index + 1, name: p.username, userId: userIdForAvatar(p), pp: formatPp(p.pp) }));

  const topRows = fx?.topList?.length
    ? fx.topList.slice(0, 3)
    : [
      { username: third.username, userId: third.id, grade: "X", title: "Blue Zenith", mods: ["DT"], pp: playPp(third, 12000), gain: "+35" as string | undefined },
      { username: fourth.username, userId: fourth.id, grade: "S", title: "Aleph-0", mods: ["HD"], pp: playPp(fourth, 10500), gain: undefined as string | undefined },
      { username: fifth.username, userId: fifth.id, grade: "S", title: "Cytus II", mods: [], pp: playPp(fifth, 9800), gain: undefined as string | undefined },
    ];

  const trackerRows = fx?.tracker?.length
    ? fx.tracker.slice(0, 4).map((t) => ({ grade: t.grade, player: t.username, userId: t.userId, title: t.title, mods: t.mods, acc: t.acc, pp: t.pp }))
    : [
      { grade: "X", player: profile.username, userId: profile.id, title: "Blue Zenith", mods: ["DT"], acc: "99.4%", pp: playPp(profile, 13000) },
      { grade: "S", player: rival.username, userId: rival.id, title: "FREEDOM DiVE", mods: ["HD"], acc: "98.9%", pp: playPp(rival, 10800) },
      { grade: "A", player: third.username, userId: third.id, title: "Cyber Induction", mods: [], acc: "96.2%", pp: playPp(third, 9000) },
      { grade: "S", player: fourth.username, userId: fourth.id, title: "Aleph-0", mods: ["DT"], acc: "98.1%", pp: playPp(fourth, 8300) },
    ];

  const mapRows = fx?.mapsFarmed?.length
    ? fx.mapsFarmed.slice(0, 3)
    : [
      { rank: 1, title: "Blue Zenith [4K Another]", stars: "6.20", avg: "700pp", players: "12" },
      { rank: 2, title: "FREEDOM DiVE [4K Another]", stars: "5.90", avg: "640pp", players: "10" },
      { rank: 3, title: "Aleph-0 [4K Ultra]", stars: "6.05", avg: "612pp", players: "9" },
    ];

  const rf = fx?.randomFarm ?? null;
  const rfMod = rf ? rf.dominantMod : "DT";
  const dan = fx?.dan ?? null;
  const danEmblem = danEmblemSrc(dan?.label, dan?.familyKey);
  const rv = fx?.randomFav ?? null;
  const rvOthers = rv ? rv.others : 23;
  const rvPickedBy = rv?.pickedBy ?? profile.username;
  const mapInfo = fx?.map ?? null;
  const feedTop = fx?.feedTopPlay ?? null;
  const feedSnipe: DiscordShowcaseSnipe | null = fx?.feedSnipe ?? null;
  const feedNew = fx?.feedNewMap ?? null;
  const coverOf = (cover: string | null | undefined): string => cover || COVER_A;
  const linkUsername = pLink?.username ?? (self.id > 0 ? self.username : null);

  return [
    {
      id: "link", label: "/link", invocation: linkUsername ? `/link ${linkUsername}` : "/link", group: "You", accent: PINK,
      blurb: "Save your osu! account so every other command knows who you are.",
      render: () => (
        <TextReply>
          {linkUsername ? <>Linked to <b style={{ color: D.white }}>{linkUsername}</b>.</> : "Linked."} Commands now default to this account.
        </TextReply>
      ),
    },
    {
      id: "me", label: "/me", invocation: "/me", group: "You", accent: PINK,
      blurb: "Your personal dashboard: ranks, pp, activity totals and goal progress.",
      render: () => (
        <Embed accent={PINK} thumb={<AvatarThumb userId={authorAvatar(pLink, self)} />}>
          <EmbedAuthor name={authorName(pLink, self)} />
          <Fields items={[
            { name: "Global", value: formatRank(me?.globalRank ?? self.globalRank) },
            { name: countryField((me?.countryCode ?? pLink?.countryCode ?? self.countryCode) || ""), value: formatRank(me?.countryRank ?? self.countryRank) },
            { name: "pp", value: formatPp(me?.pp ?? self.pp) },
            { name: "Active days", value: me ? formatNumber(me.activeDays) : "128" },
            { name: "Sessions", value: meSessions },
            { name: "Top plays", value: me ? formatNumber(me.topPlayCount) : "100" },
          ]} />
          <Lead>Highlights</Lead>
          <div className="space-y-0.5 text-[12px]" style={{ color: D.text }}>
            <div><span style={{ color: D.muted }}>Biggest day</span> <b style={{ color: D.white }}>{me?.biggestDay ?? "210 plays"}</b></div>
            <div><span style={{ color: D.muted }}>Longest streak</span> <b style={{ color: D.white }}>{me?.longestStreak ?? "14 days"}</b></div>
            <div><span style={{ color: D.muted }}>pp gained while tracked</span> <b style={{ color: D.white }}>{me?.ppGained ?? "+540"}</b></div>
            <div><span style={{ color: D.muted }}>Goals</span> <b style={{ color: D.white }}>{me?.goalsLine ?? "2 open, 5 done"}</b></div>
          </div>
          <Footer text="maniabot" />
          <Buttons items={["My Stats", "osu! profile"]} />
        </Embed>
      ),
    },
    {
      id: "player", label: "/player", invocation: `/player ${playerName}`, group: "Players", accent: PINK,
      blurb: "Full profile card with ranks, pp and top plays. The username is optional once you link.",
      render: () => (
        <Embed accent={PINK} thumb={<AvatarThumb userId={authorAvatar(pProfile, profile)} />}>
          <EmbedAuthor name={authorName(pProfile, profile)} />
          <Fields items={[
            { name: "Global", value: formatRank(pProfile?.globalRank ?? profile.globalRank) },
            { name: countryField((pProfile?.countryCode ?? profile.countryCode) || ""), value: formatRank(pProfile?.countryRank ?? profile.countryRank) },
            { name: "pp", value: formatPp(pProfile?.pp ?? profile.pp) },
            { name: "Accuracy", value: formatAccuracy(pProfile?.accuracy ?? profile.accuracy) },
            { name: "Play count", value: formatNumber(pProfile?.playCount ?? profile.playCount) },
            { name: "Level", value: pProfile?.level != null ? String(pProfile.level) : "103" },
          ]} />
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 pt-0.5 text-[12px]">
            <span className="flex items-center gap-1"><GradeImg grade="X" size={16} /> <b style={{ color: D.white }}>{playerSs}</b></span>
            <span className="flex items-center gap-1"><GradeImg grade="S" size={16} /> <b style={{ color: D.white }}>{playerS}</b></span>
            <span className="flex items-center gap-1"><GradeImg grade="A" size={16} /> <b style={{ color: D.white }}>{playerA}</b></span>
            <Dot />
            <span style={{ color: D.muted }}>Top mod</span>
            {playerTopMod ? <ModBadge mod={playerTopMod} size={0.5} /> : <span style={{ color: D.muted }}>NM</span>}
          </div>
          <Lead>Top plays</Lead>
          {playerTop.map((s, i) => <ScoreLine key={i} {...s} />)}
          <Footer text="maniabot" />
          <Buttons items={["osu! profile"]} />
        </Embed>
      ),
    },
    {
      id: "recent", label: "/recent", invocation: "/recent", group: "Players", accent: PINK,
      blurb: "Latest play in full (grade, mods, judgements, pp), with the earlier ones below. Paginated with Prev and Next.",
      render: () => {
        const [latest, ...earlier] = recentRows;
        return (
          <Embed accent={PINK} thumb={latest ? <Thumb src={coverOf(latest.cover)} /> : undefined}>
            <EmbedAuthor name={authorName(pRecent, recent)} />
            {latest ? (
              <>
                <div className="text-[12px] font-semibold">
                  <span style={{ color: D.link }}>{latest.title}</span>{" "}
                  <span style={{ color: D.muted }}>[{latest.version}]</span>
                </div>
                <DetailedScore {...latest} />
                {earlier.length ? (
                  <>
                    <Lead>Earlier plays</Lead>
                    {earlier.map((s, i) => <ScoreLine key={i} {...s} />)}
                  </>
                ) : null}
              </>
            ) : (
              <div className="text-[12px]" style={{ color: D.muted }}>No recent mania plays found.</div>
            )}
            <Footer text="maniabot" />
            <PageButtons />
          </Embed>
        );
      },
    },
    {
      id: "maniacard", label: "/maniacard", invocation: `/maniacard ${pCard?.username ?? commandName(card)}`, group: "Players", accent: PINK,
      blurb: "A shareable skill-tier card: control, speed and precision under a tier badge, with star rating.",
      render: () => (
        <Embed accent={PINK}>
          <EmbedAuthor name={authorName(pCard, card)} />
          <ManiacardArt player={cardArtPlayer} />
          <Footer text="maniabot" />
          <Buttons items={["View card", "osu! profile"]} />
        </Embed>
      ),
    },
    {
      id: "activity", label: "/activity", invocation: "/activity", group: "Players", accent: PINK,
      blurb: "Play habits and a playstyle breakdown: active days, sessions and skill mix.",
      render: () => (
        <Embed accent={PINK} thumb={<AvatarThumb userId={authorAvatar(pActivity, activity)} />}>
          <EmbedAuthor name={authorName(pActivity, activity)} />
          <Fields items={[
            { name: "Active days", value: act ? formatNumber(act.activeDays) : "128" },
            { name: "Total plays", value: act ? formatNumber(act.totalPlays) : formatNumber(activity.playCount) },
            { name: "Sessions", value: act ? formatNumber(act.sessions) : formatNumber(Math.max(1, Math.round((activity.playCount ?? 24000) / 45))) },
            { name: "Plays/session", value: act ? formatNumber(act.playsPerSession) : "45" },
            { name: "Current streak", value: act ? `${act.currentStreak} days` : "9 days" },
            { name: "Year", value: act ? String(act.year) : "2026" },
          ]} />
          <Lead>Playstyle</Lead>
          <div className="flex flex-wrap items-center gap-1.5 text-[12px]" style={{ color: D.text }}>
            {activityPatterns.flatMap((p, i) => {
              const node = <span key={p.label}>{p.label} <b style={{ color: D.white }}>{p.pct}%</b></span>;
              return i === 0 ? [node] : [<Dot key={`${p.label}-dot`} />, node];
            })}
          </div>
          <Footer text="maniabot" />
          <Buttons items={["Activity"]} />
        </Embed>
      ),
    },
    {
      id: "goals", label: "/goals", invocation: "/goals", group: "Players", accent: PINK,
      blurb: "Track pp and accuracy goals and how close each one is.",
      render: () => (
        <Embed accent={PINK} thumb={<AvatarThumb userId={authorAvatar(pGoals, goals)} />}>
          <EmbedAuthor name={authorName(pGoals, goals)} />
          <Lead>Open goals</Lead>
          <div className="space-y-1 text-[12px]" style={{ color: D.text }}>
            {goalsOpen.map((g, i) => (
              <div key={i} className="flex flex-wrap items-center gap-1.5">
                <span style={{ color: D.muted }}>-</span> <span style={{ color: D.white }}>{g.headline}</span>
                {g.trailer ? <span style={{ color: D.muted }}>({g.trailer})</span> : null}
              </div>
            ))}
          </div>
          <Footer text={goalsFooter} />
          <Buttons items={["Goals"]} />
        </Embed>
      ),
    },
    {
      id: "vs", label: "/vs", invocation: `/vs ${vsRightName}`, group: "Players", accent: PINK,
      blurb: "Two players stat by stat, the leader in bold with a final tally. Leave the first name out to compare against yourself.",
      render: () => {
        // One markdown line per stat, the leading value bold, then a tally line
        // naming the overall leader - exactly the bot's compare layout.
        const aScore = vsRows.filter((r) => r.aWins).length;
        const bScore = vsRows.filter((r) => r.bWins).length;
        const leader = aScore === bScore ? null : aScore > bScore ? vsLeftName : vsRightName;
        return (
          <Embed accent={PINK}>
            <EmbedTitle>{vsTitle}</EmbedTitle>
            <div className="space-y-0.5 text-[12px]" style={{ color: D.text }}>
              {vsRows.map((r) => (
                <div key={r.label}>
                  {r.label}: {r.aWins ? <b style={{ color: D.white }}>{r.a}</b> : r.a} vs {r.bWins ? <b style={{ color: D.white }}>{r.b}</b> : r.b}
                </div>
              ))}
              <div className="pt-1.5">
                {leader
                  ? <><b style={{ color: D.white }}>{leader}</b> leads {Math.max(aScore, bScore)}-{Math.min(aScore, bScore)}.</>
                  : "Dead even."}
              </div>
            </div>
            <Footer text="maniabot" />
            <Buttons items={[vsLeftName, vsRightName]} />
          </Embed>
        );
      },
    },
    {
      id: "pb", label: "/pb", invocation: "/pb", group: "Players", accent: PINK,
      blurb: "Your best score on the last map someone showed in the channel (from /recent, /map, ...). Also /c and /compare. Pass a name to look up someone else.",
      render: () => (
        <Embed accent={PINK} thumb={<Thumb src={coverOf(pbView.cover)} />}>
          <EmbedAuthor name={authorName(pProfile, pb)} />
          <EmbedTitle linked>{pbView.title}</EmbedTitle>
          <DetailedScore
            grade={pbView.grade}
            mods={pbView.mods}
            stars={pbView.stars}
            keys={pbView.keys}
            acc={pbView.acc}
            combo={pbView.combo}
            score={pbView.score}
            hits={pbView.hits}
            pp={pbView.pp}
          />
          <Footer text="maniabot" />
          <Buttons items={["Beatmap", pProfile?.username ?? pb.username]} />
        </Embed>
      ),
    },
    {
      id: "farm", label: "/farm", invocation: `/farm ${pFarm?.username ?? commandName(farm)} ${farmKeyMode}`, group: "Players", accent: PINK,
      blurb: "PP-gain map recommendations tuned to a player.",
      render: () => (
        <Embed accent={PINK} thumb={<AvatarThumb userId={authorAvatar(pFarm, farm)} />}>
          <EmbedAuthor name={authorName(pFarm, farm)} />
          <Lead>Farm picks</Lead>
          <div className="space-y-1 pt-0.5 text-[12px]" style={{ color: D.text }}>
            {farmRecs.map((r) => (
              <div key={r.index} className="flex flex-wrap items-center gap-1.5">
                <span style={{ color: D.muted }}>{r.index}.</span> <span style={{ color: D.link }}>{r.title}</span>{" "}
                {r.mods.map((m) => <ModBadge key={m} mod={m} size={0.45} />)} <Dot /> <b style={{ color: D.white }}>{r.gain}</b>
              </div>
            ))}
          </div>
          <Footer text={`${farmKeyMode.toUpperCase()} • maniabot`} />
          <Buttons items={["Farm Helper"]} />
        </Embed>
      ),
    },
    {
      id: "rankings", label: "/rankings", invocation: `/rankings ${sample.commandCountry}`, group: "Browse", accent: PINK,
      blurb: "Country (or global) leaderboard, top players by pp.",
      render: () => (
        <Embed accent={PINK} thumb={rankRows[0]?.userId ? <AvatarThumb userId={rankRows[0].userId} /> : undefined}>
          <EmbedTitle>{rankingsTitle}</EmbedTitle>
          <div className="pt-1">
            {rankRows.map((r, index) => (
              <RankRow key={`${r.name}-${index}`} rank={r.rank} name={r.name} pp={r.pp} />
            ))}
          </div>
          <Footer text="Page 1 • maniabot" />
          <Buttons items={["Full rankings"]} />
          <PageButtons />
        </Embed>
      ),
    },
    {
      id: "top", label: "/top", invocation: `/top ${sample.commandCountry}`, group: "Browse", accent: GOLD,
      blurb: "Recent notable top plays across a country.",
      render: () => (
        <Embed accent={GOLD} thumb={topRows[0]?.userId ? <AvatarThumb userId={topRows[0].userId} /> : undefined}>
          <EmbedTitle>Recent top plays</EmbedTitle>
          <div className="space-y-1 pt-1 text-[12px]" style={{ color: D.text }}>
            {topRows.map((r, i) => (
              <div key={i} className="flex flex-wrap items-center gap-1.5">
                {r.grade ? <GradeImg grade={r.grade} size={18} /> : null}
                <b style={{ color: D.white }}>{r.username}</b> <Dot /> <span style={{ color: D.link }}>{r.title}</span>{" "}
                {r.mods.map((m) => <ModBadge key={m} mod={m} size={0.45} />)} <Dot /> <b style={{ color: D.white }}>{r.pp}</b>
                {r.gain ? <span>({r.gain})</span> : null}
              </div>
            ))}
          </div>
          <Footer text={scopeFooter} />
          <Buttons items={["Top plays"]} />
        </Embed>
      ),
    },
    {
      id: "tracker", label: "/tracker", invocation: `/tracker ${sample.commandCountry}`, group: "Browse", accent: PINK,
      blurb: "The live score feed for a country, newest first.",
      render: () => (
        <Embed accent={PINK} thumb={trackerRows[0]?.userId ? <AvatarThumb userId={trackerRows[0].userId} /> : undefined}>
          <EmbedTitle>{latestScoresTitle}</EmbedTitle>
          <div className="pt-1">
            {trackerRows.map((t, i) => <TrackerRow key={i} grade={t.grade} player={t.player} title={t.title} mods={t.mods} acc={t.acc} pp={t.pp} />)}
          </div>
          <Footer text="Page 1 • maniabot" />
          <PageButtons />
        </Embed>
      ),
    },
    {
      id: "maps", label: "/maps", invocation: `/maps ${sample.commandCountry}`, group: "Browse", accent: PINK,
      blurb: "The most farmed maps in a country, ranked by activity.",
      render: () => (
        <Embed accent={PINK}>
          <EmbedTitle>{mapsTitle}</EmbedTitle>
          <div className="pt-1">
            {mapRows.map((m) => <MapRow key={m.rank} rank={m.rank} title={m.title} stars={m.stars} avg={m.avg} players={m.players} />)}
          </div>
          <Footer text="Page 1 • maniabot" />
          <Buttons items={["All maps"]} />
          <PageButtons />
        </Embed>
      ),
    },
    {
      id: "randomfarm", label: "/randomfarm", invocation: `/randomfarm ${sample.commandCountry} keys:4k`, group: "Browse", accent: PINK,
      blurb: "Roll a random popular farm map. Defaults to the global farm board; filter by keys, status, star range or minimum pp. Reroll for another.",
      render: () => (
        <Embed accent={PINK} thumb={<Thumb src={coverOf(rf?.cover)} />}>
          <EmbedTitle linked>{rf?.title ?? "xi - Blue Zenith [4K Black Another]"}</EmbedTitle>
          <div className="text-[12px]" style={{ color: D.text }}>
            Random farm pick. <b style={{ color: D.white }}>{rf ? rf.players : 12}</b> players farm this in {sample.countryLabel}
            {rfMod ? <>, mostly +{rfMod}</> : null}.
          </div>
          <Fields items={[
            { name: "Stars", value: `${rf ? rf.stars : "6.20"}★` },
            { name: "Keys", value: rf?.keys || "4K" },
            { name: "BPM", value: rf?.bpm ?? "200" },
            { name: "Status", value: rf?.status ?? "Ranked" },
            { name: "Avg pp", value: rf?.avgPp ?? "700pp" },
            { name: "Max pp", value: rf?.maxPp ?? "850pp" },
          ]} />
          <Footer text={scopeFooter} />
          <RerollPill />
          <Buttons items={["Beatmap", "Farm detail"]} />
        </Embed>
      ),
    },
    {
      id: "randomfav", label: "/randomfav", invocation: `/randomfav ${sample.commandCountry} pattern:Jack`, group: "Browse", accent: PINK,
      blurb: "Roll a random favourited map, the same pool as the Maps random tab. Filter by keys, status, pattern or star range, then reroll for another.",
      render: () => (
        <Embed accent={PINK} thumb={<Thumb src={coverOf(rv?.cover)} />}>
          <EmbedTitle linked>{rv?.title ?? "xi - Blue Zenith"}</EmbedTitle>
          <div className="text-[12px]" style={{ color: D.text }}>
            Random favourite pick. Favourited by <b style={{ color: D.white }}>{rvPickedBy}</b>
            {rvOthers > 0 ? <> and <b style={{ color: D.white }}>{formatNumber(rvOthers)}</b> {rvOthers === 1 ? "other" : "others"}</> : null} in {sample.countryLabel}.
          </div>
          <Fields items={[
            { name: "Stars", value: `${rv ? rv.stars : "6.20"}★` },
            { name: "Keys", value: rv?.keys || "4K 7K" },
            { name: "Status", value: rv?.status ?? "Loved" },
            { name: "BPM", value: rv?.bpm ?? "200" },
            { name: "Global favs", value: rv?.globalFavs ?? "4,200" },
            { name: "Patterns", value: rv?.patterns ?? "Jack, Chordjack" },
          ]} />
          <Footer text={scopeFooter} />
          <RerollPill />
          <Buttons items={["Beatmap", "Random maps"]} />
        </Embed>
      ),
    },
    {
      id: "dan", label: "/dan", invocation: "/dan 1234567", group: "Beatmaps", accent: PINK,
      blurb: "Estimate a chart's dan level, with its dan emblem.",
      render: () => (
        <Embed accent={PINK} thumb={<img src={danEmblem} alt="" className="h-16 w-16 object-contain" loading="lazy" />}>
          <EmbedTitle linked>{mapInfo?.title ?? "xi - Blue Zenith [4K Black Another]"}</EmbedTitle>
          <div className="space-y-0.5 text-[12px]" style={{ color: D.text }}>
            <div className="text-[15px] font-bold" style={{ color: D.white }}>{dan?.displayName ?? "10th Dan"}</div>
            <div>Family: {dan?.family ?? "Jack"}</div>
            <div>Confidence: {dan?.confidence ?? "82%"}</div>
          </div>
          <Footer text="maniabot" />
          <Buttons items={["Beatmap"]} />
        </Embed>
      ),
    },
    {
      id: "map", label: "/map", invocation: "/map 1234567", group: "Beatmaps", accent: PINK,
      blurb: "Beatmap card: stars, keys, status, BPM, length and dan.",
      render: () => (
        <Embed accent={PINK} thumb={<Thumb src={coverOf(mapInfo?.cover)} />}>
          <EmbedTitle linked>{mapInfo?.title ?? "xi - Blue Zenith [4K Black Another]"}</EmbedTitle>
          <Fields items={[
            { name: "Stars", value: `${mapInfo ? mapInfo.stars : "6.20"}★` },
            { name: "Keys", value: mapInfo?.keys || "4K" },
            { name: "Status", value: mapInfo?.status ?? "Ranked" },
            { name: "BPM", value: mapInfo?.bpm ?? "200" },
            { name: "Length", value: mapInfo?.length ?? "4:18" },
            { name: "Dan", value: mapInfo?.dan ?? "10th" },
          ]} />
          <Footer text="maniabot" />
          <Buttons items={["Beatmap", "Farm detail"]} />
        </Embed>
      ),
    },
    {
      id: "replay", label: "/replay", invocation: "/replay 1234567", group: "Beatmaps", accent: PINK,
      blurb: "Open the in-browser replay viewer for a score.",
      render: () => (
        <Embed accent={PINK}>
          <EmbedTitle linked>Replay viewer</EmbedTitle>
          <div className="text-[12px]" style={{ color: D.text }}>
            Watch score <code className="rounded px-1 font-mono text-[11px]" style={{ backgroundColor: D.field }}>1234567</code> in the Mania Hub replay viewer.
            <br />
            Adjust skin, scroll speed and overlays, or export it to video.
          </div>
          <Footer text="maniabot" />
          <Buttons items={["Watch replay"]} />
        </Embed>
      ),
    },
    {
      id: "alert-maps", label: "Farm map alert", invocation: "auto-posted", group: "Feeds", accent: GOLD,
      blurb: "New farm maps, auto-posted to any channel that ran /subscribe feed:new maps.",
      render: () => (
        <Embed accent={GOLD} thumb={<Thumb src={coverOf(feedNew?.cover)} />}>
          <EmbedTitle>New farm map</EmbedTitle>
          <div className="text-[12px] font-semibold">
            <span style={{ color: D.link }}>{feedNew?.title ?? "xi - Blue Zenith [4K Black Another]"}</span>
          </div>
          <div className="flex flex-wrap items-center gap-1.5 text-[12px]" style={{ color: D.muted }}>
            <span>{feedNew?.keys || "4K"}</span> <Dot /> <span>{feedNew ? feedNew.stars : "6.20"}★</span> <Dot /> <span>ranked 3 days ago</span>
          </div>
          <Footer text="maniabot" />
          <Buttons items={["Beatmap", "Maps"]} />
        </Embed>
      ),
    },
    {
      id: "feed-top", label: "Top-play feed", invocation: "auto-posted", group: "Feeds", accent: GOLD,
      blurb: "When someone lands a new top play, it drops in your channel automatically, in full detail.",
      render: () => (
        <Embed accent={GOLD} thumb={<Thumb src={coverOf(feedTop?.cover)} />}>
          <EmbedAuthor name={feedTop?.username ?? feed.username} />
          <EmbedTitle>New top play</EmbedTitle>
          <div className="text-[12px] font-semibold">
            <span style={{ color: D.link }}>{feedTop?.title ?? "UNDEAD CORPORATION - Everything Will Freeze [4K Black Another]"}</span>
          </div>
          <DetailedScore
            grade={feedTop?.grade ?? "X"}
            mods={feedTop?.mods ?? ["HD", "DT"]}
            stars={feedTop?.stars ?? "6.85"}
            keys={feedTop?.keys || "4K"}
            acc={feedTop?.acc ?? "99.21%"}
            combo={feedTop?.combo ?? "2,104x"}
            score={feedTop?.score ?? "5,920,140"}
            hits={feedTop?.hits ?? { max: 2040, n300: 52, n200: 8, n100: 3, n50: 0, miss: 1 }}
            pp={feedTop?.pp ?? playPp(feed, 12000)}
            gain={feedTop?.gain ?? "+35pp"}
          />
          <Footer text={scopeFooter} />
          <Buttons items={["Beatmap", feedTop?.username ?? feed.username]} />
        </Embed>
      ),
    },
    {
      id: "feed-snipe", label: "Snipe feed", invocation: "auto-posted", group: "Feeds", accent: SNIPE,
      blurb: "When someone overtakes a country leaderboard score, the snipe lands in your channel.",
      render: () => {
        // Only the synthetic (no-fixture) path shows the example rank; a real
        // snipe with a null board rank correctly omits the "from #N" suffix.
        const fromRank = feedSnipe ? feedSnipe.fromRank : 2;
        const author = `${feedSnipe?.sniper ?? third.username} sniped ${feedSnipe?.victim ?? fourth.username}${fromRank ? ` from #${fromRank}` : ""}`;
        return (
          <Embed accent={SNIPE} thumb={<Thumb src={coverOf(feedSnipe?.cover)} />}>
            <EmbedAuthor name={author} />
            <EmbedTitle linked>{feedSnipe?.title ?? "xi - FREEDOM DiVE [4K Another]"}</EmbedTitle>
            <div className="flex flex-wrap items-center gap-2 text-[12px]">
              <GradeImg grade={feedSnipe?.grade ?? "X"} size={20} />
              {(feedSnipe?.mods ?? ["DT"]).map((m) => <ModBadge key={m} mod={m} size={0.5} />)}
              <span style={{ color: D.muted }}>{feedSnipe?.acc ?? "99.32%"}</span>
              <b style={{ color: D.white }}>{feedSnipe?.pp ?? "612pp"}</b>
            </div>
            <div className="flex flex-wrap items-center gap-1.5 text-[12px]" style={{ color: D.text }}>
              <span style={{ color: D.muted }}>Score</span> <b style={{ color: D.white }}>{feedSnipe?.score ?? "4,512,300"}</b>
              <span style={{ color: D.muted }}>vs {feedSnipe?.victimScore ?? "4,498,110"}</span>
            </div>
            <div className="flex flex-wrap items-center gap-1.5 text-[12px]" style={{ color: D.muted }}>
              <span>{feedSnipe?.keys || "4K"}</span> <Dot /> <span>{feedSnipe?.stars ?? "5.90"}★</span>
            </div>
            <Footer text={scopeFooter} />
            <Buttons items={["Beatmap", "Snipes"]} />
          </Embed>
        );
      },
    },
    {
      id: "subscribe", label: "/subscribe", invocation: `/subscribe feed:Top plays country:${sample.commandCountry} min_pp:600`, group: "Feeds", accent: GREEN,
      blurb: "Turn a feed on for the current channel (needs Manage Server).",
      render: () => (
        <TextReply>
          This channel will now receive <b style={{ color: D.white }}>Top plays</b> for {sample.countryLabel} (600pp and up). Make sure the bot can send messages here.
        </TextReply>
      ),
    },
  ];
}

const GROUPS = ["You", "Players", "Browse", "Beatmaps", "Feeds"];
const DEFAULT_COMMAND_ID = "link";

export function CommandShowcase() {
  const auth = useAuth();
  const selectedCountry = useSelectedCountry();
  const selectedIsGlobal = isGlobalScope(selectedCountry);
  const cachedRankings = useAppStore((state) => state.rankingsByCountry[selectedCountry] ?? null);
  const rankingsFetchedAt = useAppStore((state) => state.rankingsFetchedAtByCountry[selectedCountry] ?? null);
  const setRankings = useAppStore((state) => state.setRankings);
  const [liveRankings, setLiveRankings] = useState<LiveGlobalRankingEntry[] | null>(null);
  const [selectedId, setSelectedId] = useState(DEFAULT_COMMAND_ID);
  const [sampleSeed, setSampleSeed] = useState("");
  const [fixture, setFixture] = useState<DiscordShowcase | null>(null);

  useEffect(() => {
    setSampleSeed(`${selectedCountry}:${Date.now()}:${Math.random()}`);
  }, [selectedCountry]);

  // Real captured data for the previews. Cached in localStorage so it isn't
  // refetched every visit: a fresh entry is used as-is, a stale one is shown
  // while a background refresh runs, and a miss falls back to the synthetic mock
  // until the fetch resolves.
  useEffect(() => {
    let cancelled = false;
    const cacheKey = discordShowcaseCacheKey(selectedCountry);
    const cached = readDiscordShowcaseCache(cacheKey);
    setFixture(cached?.data ?? null);
    // In dev, always refetch with fresh=1 so showcase edits show up on a reload:
    // it skips the localStorage short-circuit AND busts the backend's hour-long
    // in-memory cache. Prod keeps the fresh cached entry as-is (no extra fetch).
    if (!import.meta.env.DEV && cached && !isCacheStale(cached.fetchedAt, CLIENT_CACHE_TTL.discordShowcase)) {
      return () => { cancelled = true; };
    }
    fetchDiscordShowcase(selectedCountry, import.meta.env.DEV ? { fresh: true } : undefined)
      .then((data) => {
        if (cancelled) return;
        setFixture(data);
        writeDiscordShowcaseCache(cacheKey, data);
      })
      .catch(() => {
        // Backend offline / not configured: the synthetic mock keeps the page usable.
      });
    return () => { cancelled = true; };
  }, [selectedCountry]);

  useEffect(() => {
    let cancelled = false;

    setLiveRankings(null);
    fetchLiveRankingsSnapshot(selectedCountry, 50)
      .then((snapshot) => {
        if (!cancelled) setLiveRankings(snapshot.ranking);
      })
      .catch(() => {
        if (!cancelled) setLiveRankings([]);
      });

    if (selectedIsGlobal || (cachedRankings && !isCacheStale(rankingsFetchedAt, CLIENT_CACHE_TTL.rankings))) {
      return () => {
        cancelled = true;
      };
    }

    getRankings({ data: { type: "performance", page: 1, country: selectedCountry } })
      .then((rankings) => {
        if (!cancelled) setRankings(selectedCountry, rankings);
      })
      .catch(() => {
        // Existing cached/fallback players keep the preview usable if rankings are unavailable.
      });

    return () => {
      cancelled = true;
    };
  }, [cachedRankings, rankingsFetchedAt, selectedCountry, selectedIsGlobal, setRankings]);

  const sample = useMemo(
    () => buildShowcaseSample(
      selectedCountry,
      selectedIsGlobal ? null : cachedRankings,
      liveRankings,
      auth.viewer,
      sampleSeed,
    ),
    [auth.viewer, cachedRankings, liveRankings, sampleSeed, selectedCountry, selectedIsGlobal],
  );
  // Only treat the fixture as live data when it actually matches the selected
  // country (guards the brief window after switching country, or a stray refresh).
  const activeFixture = fixture && fixture.country === selectedCountry.toUpperCase() ? fixture : null;
  // Snipe boards only exist for snipes-tier countries, so advertising the snipe
  // feed anywhere else (including Global) would oversell the bot. Hidden until
  // the tier is known to be snipes.
  const { featureTier } = useCountryWarming(selectedCountry);
  const commands = useMemo(() => {
    const all = buildCommands(sample, activeFixture);
    return featureTier === "snipes" ? all : all.filter((cmd) => cmd.id !== "feed-snipe");
  }, [sample, activeFixture, featureTier]);
  const selected = commands.find((c) => c.id === selectedId) ?? commands[0];

  return (
    <section className="rounded-2xl border border-osu-b3/30 bg-osu-b4 p-4 sm:p-5">
      <div className="mb-1 flex flex-wrap items-baseline gap-x-2">
        <h2 className="text-[14px] font-bold text-white">See every command</h2>
        <span className="text-[11px] text-osu-l3">tap one to preview its reply</span>
      </div>
      <p className="mb-3 text-[12px] text-osu-l3">
        Tell the bot who you are once with <code className="font-semibold text-white">/link</code>. After that, lookups like <code className="font-semibold text-white">/recent</code> default to your account, no username needed.
      </p>

      <div className="space-y-4">
        {/* Command picker: one wrapping chip row per group, so the whole list
            stays a compact band instead of a tall sidebar. */}
        <div className="space-y-1">
          {GROUPS.map((group) => (
            <div key={group} className="flex flex-wrap items-center gap-x-1.5 gap-y-1">
              <span className="w-16 shrink-0 text-right text-[9px] font-semibold uppercase tracking-wider text-osu-f1">{group}</span>
              {commands.filter((c) => c.group === group).map((cmd) => {
                const active = cmd.id === selectedId;
                return (
                  <button
                    key={cmd.id}
                    type="button"
                    onClick={() => setSelectedId(cmd.id)}
                    className={`flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-lg px-2.5 py-1 text-[12px] font-semibold transition-colors ${
                      active ? "bg-osu-pink/15 text-white" : "text-osu-l2 hover:bg-osu-b3/50 hover:text-white"
                    }`}
                  >
                    <span className="h-1.5 w-1.5 shrink-0 rounded-full" style={{ backgroundColor: cmd.accent }} />
                    {cmd.label}
                  </button>
                );
              })}
            </div>
          ))}
        </div>

        {/* Preview */}
        <div className="min-w-0">
          <FauxMessage invocation={selected.invocation}>{selected.render()}</FauxMessage>
          <p className="mt-2 text-[12px] text-osu-l3">{selected.blurb}</p>
        </div>
      </div>
    </section>
  );
}
