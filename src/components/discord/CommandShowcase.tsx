import { useEffect, useMemo, useState, type ReactNode } from "react";
import { GradeImg } from "../ui/GradeImg";
import { ModBadge } from "../ui/ModBadge";
import { Avatar } from "../ui/Avatar";
import { CLIENT_CACHE_TTL, isCacheStale } from "../../lib/cache";
import { GLOBAL_SCOPE_CODE, getCountryName, isGlobalScope } from "../../lib/country";
import { fetchLiveRankingsSnapshot, type LiveGlobalRankingEntry } from "../../lib/live-backend";
import { getRankings } from "../../lib/osu";
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
  players: ShowcasePlayer[];
  leaderboard: ShowcasePlayer[];
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
  return Number.isFinite(value) && Number(value) > 0 ? `${Number(value).toFixed(2)}%` : "-";
}

function commandName(player: ShowcasePlayer): string {
  if (player.id <= 0) return "player";
  return player.username.trim() || "player";
}

function countryFieldName(player: ShowcasePlayer): string {
  return player.countryCode && !isGlobalScope(player.countryCode)
    ? `Country (${player.countryCode})`
    : "Country";
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
  return Array.from({ length: 6 }, (_, index) => {
    const rank = index + 1;
    return {
      id: 0,
      username: index === 0 ? "Loading player..." : `Player ${rank}`,
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

function buildShowcaseSample(
  country: string,
  rankings: RankingsResponse | null,
  liveRankings: LiveGlobalRankingEntry[] | null,
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
  const shuffled = seededShuffle(uniquePlayers(sourcePlayers), `${normalizedCountry}:${sourcePlayers.map((p) => p.id).join(":")}`);
  const players = shuffled.slice(0, 6);
  while (players.length < 6) players.push(fallback[players.length]);

  const leaderboard = sourcePlayers.length > 0
    ? sourcePlayers.slice(0, 4)
    : players.slice(0, 4);

  return {
    countryName,
    countryLabel,
    commandCountry,
    isGlobal,
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
      src="/logo512.png"
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

function Embed({ accent, children }: { accent: string; children: ReactNode }) {
  return (
    <div className="max-w-[460px] overflow-hidden rounded" style={{ backgroundColor: D.embed, borderLeft: `4px solid ${accent}` }}>
      <div className="space-y-2 p-3">{children}</div>
    </div>
  );
}

function EmbedAuthor({ name, userId }: { name: string; userId?: number }) {
  return (
    <div className="flex items-center gap-2">
      {userId ? <Avatar userId={userId} size={24} /> : null}
      <span className="text-[13px] font-semibold" style={{ color: D.white }}>{name}</span>
    </div>
  );
}

function EmbedTitle({ children, accent }: { children: ReactNode; accent?: string }) {
  return <div className="text-[14px] font-bold" style={{ color: accent ?? D.white }}>{children}</div>;
}

function Lead({ children }: { children: ReactNode }) {
  return <div className="pt-0.5 text-[12px] font-semibold" style={{ color: D.white }}>{children}</div>;
}

function Fields({ items }: { items: Array<{ name: string; value: ReactNode }> }) {
  return (
    <div className="grid grid-cols-3 gap-y-2 gap-x-3">
      {items.map((f) => (
        <div key={f.name}>
          <div className="text-[10px] font-semibold uppercase tracking-wide" style={{ color: D.muted }}>{f.name}</div>
          <div className="text-[12px]" style={{ color: D.text }}>{f.value}</div>
        </div>
      ))}
    </div>
  );
}

function Footer({ text }: { text: string }) {
  return <div className="pt-1 text-[10px]" style={{ color: D.muted }}>{text}</div>;
}

function Cover({ src }: { src: string }) {
  return <img src={src} alt="" className="mt-1 h-28 w-full rounded object-cover" loading="lazy" />;
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

// Muted middot separator, matching the bot's inline list style.
function Dot() {
  return <span style={{ color: D.muted }}>•</span>;
}

function Winner({ active, children }: { active: boolean; children: ReactNode }) {
  return active ? <b style={{ color: D.white }}>{children}</b> : <>{children}</>;
}

function TextReply({ accent, children }: { accent: string; children: ReactNode }) {
  return (
    <div className="rounded px-3 py-2 text-[13px]" style={{ backgroundColor: D.embed, borderLeft: `3px solid ${accent}`, color: D.text }}>
      {children}
    </div>
  );
}

// Discord's "ephemeral" footer, for replies only the invoker can see.
function EphemeralHint() {
  return <div className="pt-1 text-[10px]" style={{ color: D.muted }}>Only you can see this</div>;
}

// One play, rendered with the real osu grade icon + mod badges.
function ScoreLine({ grade, title, version, mods, acc, pp, keys, gain }: {
  grade: string; title: string; version: string; mods: string[]; acc: string; pp: string; keys?: string; gain?: string;
}) {
  return (
    <div className="flex items-center gap-2 py-0.5">
      <GradeImg grade={grade} size={22} />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5">
          <span className="truncate text-[12px] font-medium" style={{ color: D.link }}>{title}</span>
          <span className="shrink-0 text-[10px]" style={{ color: D.muted }}>[{version}]</span>
          {keys ? <span className="shrink-0 rounded px-1 text-[8px] font-bold" style={{ backgroundColor: D.field, color: GOLD }}>{keys}</span> : null}
        </div>
        <div className="mt-0.5 flex items-center gap-1">
          {mods.length ? mods.map((m) => <ModBadge key={m} mod={m} size={0.5} />) : <span className="text-[9px]" style={{ color: D.muted }}>nomod</span>}
        </div>
      </div>
      <div className="shrink-0 text-right text-[12px] tabular-nums">
        <span style={{ color: D.muted }}>{acc}</span>{" "}
        <span className="font-bold" style={{ color: D.white }}>{pp}</span>
        {gain ? <span style={{ color: GOLD }}> {gain}</span> : null}
      </div>
    </div>
  );
}

function RankRow({ rank, name, userId, pp }: { rank: number; name: string; userId?: number; pp: string }) {
  return (
    <div className="flex items-center gap-2 py-0.5 text-[12px]">
      <span className="w-7 shrink-0 rounded text-center text-[11px] font-bold tabular-nums" style={{ backgroundColor: D.field, color: D.muted }}>#{rank}</span>
      <Avatar userId={userId} size={20} />
      <span className="font-semibold" style={{ color: D.white }}>{name}</span>
      <span className="ml-auto font-bold tabular-nums" style={{ color: D.text }}>{pp}</span>
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
      <span className="w-6 shrink-0 rounded text-center text-[11px] font-bold tabular-nums" style={{ backgroundColor: D.field, color: D.muted }}>#{rank}</span>
      <span className="truncate" style={{ color: D.link }}>{title}</span>
      <span style={{ color: GOLD }}>{stars}★</span>
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

function buildCommands(sample: ShowcaseSample): Command[] {
  const [main, rival, third, fourth, fifth] = sample.players;
  const rankFor = (player: ShowcasePlayer, index: number): number =>
    sample.isGlobal
      ? player.globalRank ?? index + 1
      : player.countryRank ?? index + 1;
  const playPp = (player: ShowcasePlayer, fallback: number): string =>
    `${Math.max(300, Math.round((player.pp > 0 ? player.pp : fallback) * 0.065))}pp`;
  const goalTarget = Math.max(1000, Math.ceil((main.pp + 700) / 1000) * 1000);
  const goalPercent = main.pp > 0 ? Math.min(99, Math.max(1, Math.round((main.pp / goalTarget) * 100))) : 75;
  const mainRank = rankFor(main, 0);
  const rivalRank = rankFor(rival, 1);
  const mainAccuracy = main.accuracy ?? 99.4;
  const rivalAccuracy = rival.accuracy ?? 99.2;
  const rankingsTitle = sample.isGlobal ? "Global mania rankings" : `${sample.countryName} mania rankings`;
  const latestScoresTitle = sample.isGlobal ? "Latest tracked scores" : `Latest scores in ${sample.countryLabel}`;
  const mapsTitle = sample.isGlobal ? "Most farmed maps globally" : `Most farmed maps in ${sample.countryLabel}`;
  const scopeFooter = `${sample.countryLabel} • maniabot`;

  return [
    {
      id: "link", label: "/link", invocation: `/link ${commandName(main)}`, group: "You", accent: PINK,
      blurb: "Save your osu! account so every other command knows who you are.",
      render: () => (
        <TextReply accent={PINK}>
          Linked to <b style={{ color: D.white }}>{main.username}</b>. Commands now default to this account.
        </TextReply>
      ),
    },
    {
      id: "me", label: "/me", invocation: "/me", group: "You", accent: PINK,
      blurb: "Your personal dashboard: ranks, pp, activity totals and goal progress.",
      render: () => (
        <Embed accent={PINK}>
          <EmbedAuthor name={main.username} userId={userIdForAvatar(main)} />
          <Fields items={[
            { name: "Global", value: formatRank(main.globalRank) },
            { name: countryFieldName(main), value: formatRank(main.countryRank) },
            { name: "pp", value: <b style={{ color: D.white }}>{formatPp(main.pp)}</b> },
            { name: "Active days", value: "128" },
            { name: "Sessions", value: formatNumber(Math.max(1, Math.round((main.playCount ?? 24000) / 45))) },
            { name: "Top plays", value: "100" },
          ]} />
          <Lead>Highlights</Lead>
          <div className="space-y-0.5 text-[12px]" style={{ color: D.text }}>
            <div><span style={{ color: D.muted }}>Biggest day</span> <b style={{ color: D.white }}>210 plays</b></div>
            <div><span style={{ color: D.muted }}>Longest streak</span> <b style={{ color: D.white }}>14 days</b></div>
            <div><span style={{ color: D.muted }}>pp gained while tracked</span> <b style={{ color: GOLD }}>+540</b></div>
            <div><span style={{ color: D.muted }}>Goals</span> <b style={{ color: D.white }}>2 open, 5 done</b></div>
          </div>
          <Footer text="maniabot" />
          <Buttons items={["My Data", "osu! profile"]} />
        </Embed>
      ),
    },
    {
      id: "player", label: "/player", invocation: `/player ${commandName(main)}`, group: "Players", accent: PINK,
      blurb: "Full profile card with ranks, pp and top plays. The username is optional once you link.",
      render: () => (
        <Embed accent={PINK}>
          <EmbedAuthor name={main.username} userId={userIdForAvatar(main)} />
          <Fields items={[
            { name: "Global", value: formatRank(main.globalRank) },
            { name: countryFieldName(main), value: formatRank(main.countryRank) },
            { name: "pp", value: <b style={{ color: D.white }}>{formatPp(main.pp)}</b> },
            { name: "Accuracy", value: formatAccuracy(main.accuracy) },
            { name: "Play count", value: formatNumber(main.playCount) },
            { name: "Level", value: "103" },
          ]} />
          <Lead>Top plays</Lead>
          <ScoreLine grade="X" title="Blue Zenith" version="4K Black Another" keys="4K" mods={["HD", "DT"]} acc="100%" pp={playPp(main, 13000)} />
          <ScoreLine grade="S" title="FREEDOM DiVE" version="4K Another" keys="4K" mods={["DT"]} acc="99.2%" pp={playPp(rival, 11500)} />
          <ScoreLine grade="S" title="Everything Will Freeze" version="[7K] SHD" keys="7K" mods={[]} acc="98.7%" pp={playPp(third, 10000)} />
          <Footer text="maniabot" />
          <Buttons items={["Mania Hub", "osu! profile"]} />
        </Embed>
      ),
    },
    {
      id: "recent", label: "/recent", invocation: "/recent", group: "Players", accent: PINK,
      blurb: "Latest plays, pass or fail, paginated with Prev and Next.",
      render: () => (
        <Embed accent={PINK}>
          <EmbedAuthor name={main.username} userId={userIdForAvatar(main)} />
          <Lead>Recent plays</Lead>
          <ScoreLine grade="A" title="Yomi yori" version="4K Master" keys="4K" mods={["HD"]} acc="97.1%" pp="-" />
          <ScoreLine grade="S" title="Aleph-0" version="4K Ultra" keys="4K" mods={[]} acc="98.9%" pp={playPp(main, 9400)} />
          <ScoreLine grade="F" title="Cyber Induction" version="4K SHD" keys="4K" mods={["DT"]} acc="91.0%" pp="-" />
          <Footer text="Page 1 • maniabot" />
          <PageButtons />
        </Embed>
      ),
    },
    {
      id: "maniacard", label: "/maniacard", invocation: `/maniacard ${commandName(main)}`, group: "Players", accent: GOLD,
      blurb: "A shareable skill-tier card: control, speed and precision under a tier badge, with star rating.",
      render: () => (
        <Embed accent={GOLD}>
          <EmbedAuthor name={main.username} userId={userIdForAvatar(main)} />
          <ManiacardArt player={main} />
          <Footer text="maniabot" />
          <Buttons items={["View card", "osu! profile"]} />
        </Embed>
      ),
    },
    {
      id: "activity", label: "/activity", invocation: "/activity", group: "Players", accent: PINK,
      blurb: "Play habits and a playstyle breakdown: active days, sessions and skill mix.",
      render: () => (
        <Embed accent={PINK}>
          <EmbedAuthor name={main.username} userId={userIdForAvatar(main)} />
          <Fields items={[
            { name: "Active days", value: "128" },
            { name: "Total plays", value: formatNumber(main.playCount) },
            { name: "Sessions", value: formatNumber(Math.max(1, Math.round((main.playCount ?? 24000) / 45))) },
            { name: "Plays/session", value: "45" },
            { name: "Current streak", value: "9 days" },
            { name: "Year", value: "2026" },
          ]} />
          <Lead>Playstyle</Lead>
          <div className="flex flex-wrap items-center gap-1.5 text-[12px]" style={{ color: D.text }}>
            <span>Stream <b style={{ color: D.white }}>42%</b></span> <Dot />
            <span>Jack <b style={{ color: D.white }}>21%</b></span> <Dot />
            <span>LN <b style={{ color: D.white }}>18%</b></span> <Dot />
            <span>Chordjack <b style={{ color: D.white }}>11%</b></span>
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
        <Embed accent={PINK}>
          <EmbedAuthor name={main.username} userId={userIdForAvatar(main)} />
          <Lead>Open goals</Lead>
          <div className="space-y-1 text-[12px]" style={{ color: D.text }}>
            <div className="flex flex-wrap items-center gap-1.5">
              <span style={{ color: D.muted }}>-</span> <span>Reach <b style={{ color: D.white }}>{formatPp(goalTarget)}</b></span> <span style={{ color: D.muted }}>({formatPp(main.pp)}, {goalPercent}%)</span>
            </div>
            <div className="flex flex-wrap items-center gap-1.5">
              <span style={{ color: D.muted }}>-</span> <span><b style={{ color: D.white }}>99.00%</b> on <span style={{ color: D.link }}>Blue Zenith [4K Another]</span></span> <span style={{ color: D.muted }}>(best 98.20%, 80%)</span>
            </div>
          </div>
          <Footer text="2 open • 5 done • maniabot" />
          <Buttons items={["Goals"]} />
        </Embed>
      ),
    },
    {
      id: "compare", label: "/compare", invocation: `/compare ${commandName(rival)}`, group: "Players", accent: PINK,
      blurb: "Two players head to head, winner bolded per stat. Leave the first name out to compare against yourself.",
      render: () => (
        <Embed accent={PINK}>
          <EmbedTitle>{main.username} vs {rival.username}</EmbedTitle>
          <div className="space-y-1 text-[12px]" style={{ color: D.text }}>
            <div>pp: <Winner active={main.pp >= rival.pp}>{formatPp(main.pp)}</Winner> vs <Winner active={rival.pp > main.pp}>{formatPp(rival.pp)}</Winner></div>
            <div>Global rank: <Winner active={(main.globalRank ?? Infinity) <= (rival.globalRank ?? Infinity)}>{formatRank(main.globalRank)}</Winner> vs <Winner active={(rival.globalRank ?? Infinity) < (main.globalRank ?? Infinity)}>{formatRank(rival.globalRank)}</Winner></div>
            <div>Country rank: <Winner active={mainRank <= rivalRank}>{formatRank(mainRank)}</Winner> vs <Winner active={rivalRank < mainRank}>{formatRank(rivalRank)}</Winner></div>
            <div>Accuracy: <Winner active={mainAccuracy >= rivalAccuracy}>{formatAccuracy(mainAccuracy)}</Winner> vs <Winner active={rivalAccuracy > mainAccuracy}>{formatAccuracy(rivalAccuracy)}</Winner></div>
          </div>
          <Footer text="maniabot" />
          <Buttons items={[main.username, rival.username]} />
        </Embed>
      ),
    },
    {
      id: "farm", label: "/farm", invocation: `/farm ${commandName(main)} 4k`, group: "Players", accent: PINK,
      blurb: "PP-gain map recommendations tuned to a player.",
      render: () => (
        <Embed accent={PINK}>
          <EmbedAuthor name={main.username} userId={userIdForAvatar(main)} />
          <Lead>Farm picks</Lead>
          <div className="space-y-1 pt-0.5 text-[12px]" style={{ color: D.text }}>
            <div className="flex flex-wrap items-center gap-1.5"><span style={{ color: D.muted }}>1.</span> <span style={{ color: D.link }}>Output</span> <ModBadge mod="DT" size={0.45} /> <Dot /> <b style={{ color: D.white }}>+42pp</b></div>
            <div className="flex flex-wrap items-center gap-1.5"><span style={{ color: D.muted }}>2.</span> <span style={{ color: D.link }}>The Sun The Moon The Star</span> <Dot /> <b style={{ color: D.white }}>+37pp</b></div>
            <div className="flex flex-wrap items-center gap-1.5"><span style={{ color: D.muted }}>3.</span> <span style={{ color: D.link }}>Singularity</span> <ModBadge mod="HD" size={0.45} /> <Dot /> <b style={{ color: D.white }}>+31pp</b></div>
          </div>
          <Footer text="4K • maniabot" />
          <Buttons items={["Farm Helper"]} />
        </Embed>
      ),
    },
    {
      id: "rankings", label: "/rankings", invocation: `/rankings ${sample.commandCountry}`, group: "Browse", accent: PINK,
      blurb: "Country (or global) leaderboard, top players by pp.",
      render: () => (
        <Embed accent={PINK}>
          <EmbedTitle>{rankingsTitle}</EmbedTitle>
          <div className="pt-1">
            {sample.leaderboard.map((player, index) => (
              <RankRow
                key={`${player.username}-${index}`}
                rank={rankFor(player, index)}
                name={player.username}
                userId={userIdForAvatar(player)}
                pp={formatPp(player.pp)}
              />
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
        <Embed accent={GOLD}>
          <EmbedTitle>Recent top plays</EmbedTitle>
          <div className="space-y-1 pt-1 text-[12px]" style={{ color: D.text }}>
            <div className="flex flex-wrap items-center gap-1.5"><b style={{ color: D.white }}>{third.username}</b> <Dot /> <span style={{ color: D.link }}>Blue Zenith</span> <ModBadge mod="DT" size={0.45} /> <Dot /> <b style={{ color: D.white }}>{playPp(third, 12000)}</b> <span style={{ color: GOLD }}>(+35)</span></div>
            <div className="flex flex-wrap items-center gap-1.5"><b style={{ color: D.white }}>{fourth.username}</b> <Dot /> <span style={{ color: D.link }}>Aleph-0</span> <ModBadge mod="HD" size={0.45} /> <Dot /> <b style={{ color: D.white }}>{playPp(fourth, 10500)}</b></div>
            <div className="flex flex-wrap items-center gap-1.5"><b style={{ color: D.white }}>{fifth.username}</b> <Dot /> <span style={{ color: D.link }}>Cytus II</span> <Dot /> <b style={{ color: D.white }}>{playPp(fifth, 9800)}</b></div>
          </div>
          <Footer text={scopeFooter} />
          <Buttons items={["Top plays"]} />
        </Embed>
      ),
    },
    {
      id: "tracker", label: "/tracker", invocation: `/tracker ${sample.commandCountry}`, group: "Browse", accent: GOLD,
      blurb: "The live score feed for a country, newest first.",
      render: () => (
        <Embed accent={GOLD}>
          <EmbedTitle>{latestScoresTitle}</EmbedTitle>
          <div className="pt-1">
            <TrackerRow grade="X" player={main.username} title="Blue Zenith" mods={["DT"]} acc="99.4%" pp={playPp(main, 13000)} />
            <TrackerRow grade="S" player={rival.username} title="FREEDOM DiVE" mods={["HD"]} acc="98.9%" pp={playPp(rival, 10800)} />
            <TrackerRow grade="A" player={third.username} title="Cyber Induction" mods={[]} acc="96.2%" pp={playPp(third, 9000)} />
            <TrackerRow grade="S" player={fourth.username} title="Aleph-0" mods={["DT"]} acc="98.1%" pp={playPp(fourth, 8300)} />
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
            <MapRow rank={1} title="Blue Zenith [4K Another]" stars="6.20" avg="700pp" players="12" />
            <MapRow rank={2} title="FREEDOM DiVE [4K Another]" stars="5.90" avg="640pp" players="10" />
            <MapRow rank={3} title="Aleph-0 [4K Ultra]" stars="6.05" avg="612pp" players="9" />
          </div>
          <Footer text="Page 1 • maniabot" />
          <Buttons items={["All maps"]} />
          <PageButtons />
        </Embed>
      ),
    },
    {
      id: "dan", label: "/dan", invocation: "/dan 1234567", group: "Beatmaps", accent: PINK,
      blurb: "Estimate a chart's dan level, with its dan emblem.",
      render: () => (
        <Embed accent={PINK}>
          <div className="flex items-start justify-between gap-3">
            <div>
              <EmbedTitle>Dan estimate</EmbedTitle>
              <div className="mt-1 space-y-0.5 text-[12px]" style={{ color: D.text }}>
                <div className="text-[15px] font-bold" style={{ color: D.white }}>10th Dan</div>
                <div>Family: Jack</div>
                <div>Confidence: 82%</div>
              </div>
            </div>
            {/* Real dan emblem, shown as the embed thumbnail. */}
            <img src="/images/dans/reform/10.svg" alt="" className="h-14 w-14 shrink-0 object-contain" loading="lazy" />
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
        <Embed accent={PINK}>
          <EmbedTitle>xi - Blue Zenith [4K Black Another]</EmbedTitle>
          <Fields items={[
            { name: "Stars", value: <span style={{ color: GOLD }}>6.20★</span> },
            { name: "Keys", value: "4K" },
            { name: "Status", value: "Ranked" },
            { name: "BPM", value: "200" },
            { name: "Length", value: "4:18" },
            { name: "Dan", value: "10th" },
          ]} />
          <Cover src={COVER_A} />
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
          <EmbedTitle>Replay viewer</EmbedTitle>
          <div className="text-[12px]" style={{ color: D.text }}>
            <b style={{ color: D.white }}>{main.username}</b> on <span style={{ color: D.link }}>Blue Zenith [4K Black Another]</span>
          </div>
          <div className="flex items-center gap-2 text-[12px]">
            <GradeImg grade="X" size={20} />
            <ModBadge mod="DT" size={0.5} />
            <span style={{ color: D.muted }}>99.4%</span>
            <b style={{ color: D.white }}>{playPp(main, 13000)}</b>
          </div>
          <Footer text="maniabot" />
          <Buttons items={["Watch replay"]} />
        </Embed>
      ),
    },
    {
      id: "watch-user", label: "/watch user", invocation: `/watch user ${commandName(main)} min_pp:500`, group: "Alerts", accent: GREEN,
      blurb: "Get a DM whenever a player you follow lands a new top play.",
      render: () => (
        <>
          <TextReply accent={GREEN}>
            Watching <b style={{ color: D.white }}>{main.username}</b>. You will get a DM on each new top play and on any ranked play at or above <b style={{ color: D.white }}>500pp</b>.
          </TextReply>
          <EphemeralHint />
        </>
      ),
    },
    {
      id: "alert-maps", label: "Farm map alert", invocation: "auto-posted", group: "Alerts", accent: GREEN,
      blurb: "New farm maps, delivered by DM with /watch maps or to a channel with /subscribe.",
      render: () => (
        <Embed accent={GREEN}>
          <EmbedTitle>New farm map</EmbedTitle>
          <div className="text-[12px]" style={{ color: D.text }}>
            <span style={{ color: D.link }}>xi - Blue Zenith [4K Black Another]</span>
          </div>
          <div className="flex flex-wrap items-center gap-1.5 text-[12px]" style={{ color: D.muted }}>
            <span>4K</span> <Dot /> <span style={{ color: GOLD }}>6.20★</span> <Dot /> <span>ranked 2026-06-20</span>
          </div>
          <Cover src={COVER_A} />
          <Footer text="maniabot" />
          <Buttons items={["Beatmap", "Maps"]} />
        </Embed>
      ),
    },
    {
      id: "feed-top", label: "Top-play feed", invocation: "auto-posted", group: "Alerts", accent: GOLD,
      blurb: "When someone lands a new top play, it drops in your channel automatically.",
      render: () => (
        <Embed accent={GOLD}>
          <EmbedAuthor name={third.username} userId={userIdForAvatar(third)} />
          <EmbedTitle>New top play</EmbedTitle>
          <div className="text-[12px]" style={{ color: D.text }}>
            <span style={{ color: D.link }}>UNDEAD CORPORATION - Everything Will Freeze [4K Black Another]</span>
          </div>
          <div className="flex items-center gap-2 text-[12px]">
            <GradeImg grade="X" size={20} />
            <ModBadge mod="HD" size={0.5} /><ModBadge mod="DT" size={0.5} />
            <span style={{ color: D.muted }}>99.21%</span>
            <b style={{ color: D.white }}>{playPp(third, 12000)}</b>
            <span style={{ color: GOLD }}>(+35pp)</span>
          </div>
          <Cover src={COVER_A} />
          <Footer text={scopeFooter} />
          <Buttons items={["Beatmap", third.username]} />
        </Embed>
      ),
    },
    {
      id: "subscribe", label: "/subscribe", invocation: `/subscribe feed:Top plays country:${sample.commandCountry} min_pp:600`, group: "Alerts", accent: GREEN,
      blurb: "Turn a feed on for the current channel (needs Manage Server).",
      render: () => (
        <TextReply accent={GREEN}>
          This channel will now receive <b style={{ color: D.white }}>Top plays</b> for {sample.countryLabel} (600pp and up). Make sure the bot can send messages here.
        </TextReply>
      ),
    },
  ];
}

const GROUPS = ["You", "Players", "Browse", "Beatmaps", "Alerts"];
const DEFAULT_COMMAND_ID = "link";

export function CommandShowcase() {
  const selectedCountry = useSelectedCountry();
  const selectedIsGlobal = isGlobalScope(selectedCountry);
  const cachedRankings = useAppStore((state) => state.rankingsByCountry[selectedCountry] ?? null);
  const rankingsFetchedAt = useAppStore((state) => state.rankingsFetchedAtByCountry[selectedCountry] ?? null);
  const setRankings = useAppStore((state) => state.setRankings);
  const [liveRankings, setLiveRankings] = useState<LiveGlobalRankingEntry[] | null>(null);
  const [selectedId, setSelectedId] = useState(DEFAULT_COMMAND_ID);

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
    ),
    [cachedRankings, liveRankings, selectedCountry, selectedIsGlobal],
  );
  const commands = useMemo(() => buildCommands(sample), [sample]);
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

      <div className="grid gap-4 lg:grid-cols-[220px_1fr]">
        {/* Command picker: horizontal scroll on mobile, sidebar on desktop */}
        <div className="-mx-1 flex gap-1.5 overflow-x-auto px-1 pb-1 lg:mx-0 lg:flex-col lg:overflow-visible lg:px-0">
          {GROUPS.map((group) => (
            <div key={group} className="contents lg:block">
              <div className="hidden px-1 pt-2 text-[9px] font-semibold uppercase tracking-wider text-osu-f1 lg:block">{group}</div>
              {commands.filter((c) => c.group === group).map((cmd) => {
                const active = cmd.id === selectedId;
                return (
                  <button
                    key={cmd.id}
                    type="button"
                    onClick={() => setSelectedId(cmd.id)}
                    className={`flex shrink-0 items-center gap-2 whitespace-nowrap rounded-lg px-2.5 py-1.5 text-left text-[12px] font-semibold transition-colors ${
                      active ? "bg-osu-pink/15 text-white" : "text-osu-l2 hover:bg-osu-b3/50 hover:text-white"
                    }`}
                  >
                    <span className="h-2 w-2 shrink-0 rounded-full" style={{ backgroundColor: cmd.accent }} />
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
