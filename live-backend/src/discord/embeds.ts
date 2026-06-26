import type { CountryTopPlay, OscScore, OsuMod, SnipeEvent } from "../shared/types.js";
import { getDisplayedAccuracy, getDisplayedRank, getModAcronyms } from "../shared/score.js";
import { GLOBAL_COUNTRY_CODE, isGlobalCountry } from "../countries.js";
import type { DiscordComponent, DiscordEmbed, DiscordMessageBody } from "./rest.js";

// osu! pink, matching the site accent.
export const OSU_PINK = 0xff66ab;
const SNIPE_RED = 0xff4d6d;
const TOP_PLAY_GOLD = 0xffcc33;

const OSU_BASE = "https://osu.ppy.sh";

// The bot's display name, used to sign every embed footer. Single source of
// truth so renaming the bot is a one-line change.
export const BOT_NAME = "maniabot";

// ---------------------------------------------------------------------------
// Small formatting helpers (all defensive: an embed must never throw, since a
// thrown renderer would drop a live-feed post or an interaction follow-up).
// ---------------------------------------------------------------------------

export function countryLabel(code: string | null | undefined): string {
  const cc = (code ?? "").trim().toUpperCase();
  if (!cc || isGlobalCountry(cc)) return "Global";
  return cc;
}

function formatMods(mods: OsuMod[] | string[] | undefined): string {
  if (!mods || mods.length === 0) return "NM";
  const acronyms = typeof mods[0] === "string"
    ? (mods as string[]).filter((m) => m && m.toUpperCase() !== "CL")
    : getModAcronyms(mods as OsuMod[]);
  return acronyms.length ? `+${acronyms.join("")}` : "NM";
}

function formatPp(pp: number | null | undefined): string {
  return pp == null ? "-" : `${Math.round(pp)}pp`;
}

function formatAcc(value: number): string {
  // Accepts either a 0-1 fraction or an already-scaled percentage.
  const pct = value <= 1 ? value * 100 : value;
  return `${pct.toFixed(2)}%`;
}

function formatInt(value: number | null | undefined): string {
  return value == null ? "-" : Math.round(value).toLocaleString("en-US");
}

function formatRank(value: number | null | undefined): string {
  return value == null ? "-" : `#${formatInt(value)}`;
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, Math.max(0, max - 1))}…`;
}

function beatmapTitle(score: OscScore): string {
  const set = score.beatmapset;
  const map = score.beatmap;
  const name = set ? `${set.artist} - ${set.title}` : `Beatmap ${score.beatmap_id ?? score.id}`;
  const version = map?.version ? ` [${map.version}]` : "";
  return truncate(`${name}${version}`, 120);
}

function beatmapUrl(score: OscScore): string | undefined {
  if (score.beatmap?.url) return score.beatmap.url;
  if (score.beatmap_id) return `${OSU_BASE}/b/${score.beatmap_id}`;
  return undefined;
}

// Widest available beatmap cover, for a banner-style embed image.
function bestCover(score: OscScore): string | undefined {
  const covers = score.beatmapset?.covers;
  if (!covers) return undefined;
  return covers["cover@2x"] ?? covers.cover ?? covers["card@2x"] ?? covers.card ?? covers.list ?? undefined;
}

function keyCount(cs: number | undefined): string {
  return cs == null ? "" : `${Math.round(cs)}K`;
}

function osuProfileUrl(userId: number): string {
  return `${OSU_BASE}/users/${userId}/mania`;
}

function siteProfileUrl(siteOrigin: string, username: string): string {
  return `${siteOrigin}/player/${encodeURIComponent(username)}`;
}

function linkButtonRow(buttons: Array<{ label: string; url: string }>): DiscordComponent[] {
  const valid = buttons.filter((b) => b.url);
  if (valid.length === 0) return [];
  return [{
    type: 1,
    components: valid.slice(0, 5).map((b) => ({ type: 2, style: 5, label: truncate(b.label, 80), url: b.url })),
  }];
}

// One compact line for a single score, used in lists.
function scoreLine(score: OscScore): string {
  const title = beatmapTitle(score);
  const url = beatmapUrl(score);
  const head = url ? `[${title}](${url})` : title;
  const mods = formatMods(score.mods);
  const acc = formatAcc(getDisplayedAccuracy(score));
  const grade = getDisplayedRank(score);
  const pp = score.pp != null ? ` • **${formatPp(score.pp)}**` : "";
  return `\`${grade}\` ${head} ${mods} • ${acc}${pp}`;
}

// ---------------------------------------------------------------------------
// Profile / scores
// ---------------------------------------------------------------------------

interface ProfileUserStats {
  global_rank?: number | null;
  country_rank?: number | null;
  pp?: number | null;
  hit_accuracy?: number | null;
  play_count?: number | null;
  level?: { current?: number | null } | null;
}

interface ProfileUser {
  id?: number;
  username?: string;
  avatar_url?: string;
  country_code?: string;
  statistics?: ProfileUserStats | null;
}

export function playerEmbed(
  snapshot: { user: Record<string, unknown>; bestScores?: OscScore[]; projection?: { projectedPp?: number | null; basePp?: number | null } },
  siteOrigin: string,
): DiscordMessageBody {
  const user = snapshot.user as unknown as ProfileUser;
  const stats = user.statistics ?? {};
  const username = user.username ?? "Unknown";
  const userId = Number(user.id ?? 0);
  const best = (snapshot.bestScores ?? []).slice(0, 5);
  const projected = snapshot.projection?.projectedPp;
  const basePp = stats.pp ?? snapshot.projection?.basePp ?? null;

  const fields = [
    { name: "Global", value: formatRank(stats.global_rank), inline: true },
    { name: `Country (${(user.country_code ?? "").toUpperCase() || "-"})`, value: formatRank(stats.country_rank), inline: true },
    { name: "pp", value: basePp == null ? "-" : `${formatInt(basePp)}pp`, inline: true },
    { name: "Accuracy", value: stats.hit_accuracy == null ? "-" : formatAcc(stats.hit_accuracy), inline: true },
    { name: "Play count", value: formatInt(stats.play_count), inline: true },
    { name: "Level", value: stats.level?.current == null ? "-" : String(Math.round(stats.level.current)), inline: true },
  ];

  const description = best.length
    ? `**Top plays**\n${best.map(scoreLine).join("\n")}`
    : undefined;

  const embed: DiscordEmbed = {
    author: {
      name: username,
      url: userId ? osuProfileUrl(userId) : undefined,
      icon_url: user.avatar_url || undefined,
    },
    color: OSU_PINK,
    thumbnail: user.avatar_url ? { url: user.avatar_url } : undefined,
    fields,
    description,
    footer: projected != null && basePp != null && Math.round(projected) !== Math.round(basePp)
      ? { text: `${BOT_NAME} • projected ${formatInt(projected)}pp with recent gains` }
      : { text: BOT_NAME },
  };

  return {
    embeds: [embed],
    components: linkButtonRow([
      { label: "Mania Hub", url: siteProfileUrl(siteOrigin, username) },
      { label: "osu! profile", url: userId ? osuProfileUrl(userId) : "" },
    ]),
  };
}

// The maniacard is a player's skill-tier card. The visual itself is a
// server-rendered image (the same skill engine as the in-app 3D card), so the
// embed stays a clean frame around that image plus links.
export function maniacardEmbed(
  snapshot: { user: Record<string, unknown> },
  siteOrigin: string,
): DiscordMessageBody {
  const user = snapshot.user as unknown as ProfileUser;
  const username = user.username ?? "Unknown";
  const userId = Number(user.id ?? 0);
  const cardUrl = `${siteOrigin}/api/og?kind=maniacard&username=${encodeURIComponent(username)}`;
  const pageUrl = `${siteOrigin}/player/${encodeURIComponent(username)}/maniacard`;

  const embed: DiscordEmbed = {
    author: {
      name: username,
      url: userId ? osuProfileUrl(userId) : undefined,
      icon_url: user.avatar_url || undefined,
    },
    color: OSU_PINK,
    image: { url: cardUrl },
    footer: { text: BOT_NAME },
  };

  return {
    embeds: [embed],
    components: linkButtonRow([
      { label: "View card", url: pageUrl },
      { label: "osu! profile", url: userId ? osuProfileUrl(userId) : "" },
    ]),
  };
}

export function recentScoresEmbed(
  username: string,
  userId: number,
  scores: OscScore[],
  siteOrigin: string,
): DiscordMessageBody {
  const list = scores.slice(0, 5);
  const embed: DiscordEmbed = {
    author: { name: username, url: userId ? osuProfileUrl(userId) : undefined },
    color: OSU_PINK,
    description: list.length
      ? `**Recent plays**\n${list.map(scoreLine).join("\n")}`
      : "No recent mania plays found.",
    footer: { text: BOT_NAME },
  };
  return {
    embeds: [embed],
    components: linkButtonRow([{ label: "Mania Hub", url: siteProfileUrl(siteOrigin, username) }]),
  };
}

// ---------------------------------------------------------------------------
// Top play (live feed + /top)
// ---------------------------------------------------------------------------

export function topPlayEmbed(event: CountryTopPlay, country: string | null, siteOrigin: string): DiscordMessageBody {
  const score = event.score;
  const gain = event.ppGain > 0 ? ` (+${Math.round(event.ppGain)}pp)` : "";
  const mods = formatMods(score.mods);
  const acc = formatAcc(getDisplayedAccuracy(score));
  const grade = getDisplayedRank(score);
  const stars = score.beatmap?.difficulty_rating != null ? `${score.beatmap.difficulty_rating.toFixed(2)}★` : "";
  const keys = keyCount(score.beatmap?.cs);
  const mapUrl = beatmapUrl(score);

  const embed: DiscordEmbed = {
    author: {
      name: event.user.username,
      url: osuProfileUrl(event.user.id),
      icon_url: event.user.avatar_url || undefined,
    },
    title: "New top play",
    color: TOP_PLAY_GOLD,
    description: [
      mapUrl ? `**[${beatmapTitle(score)}](${mapUrl})**` : `**${beatmapTitle(score)}**`,
      `\`${grade}\` ${mods} • ${acc} • **${formatPp(score.pp)}**${gain}`,
      [keys, stars].filter(Boolean).join(" • "),
    ].filter(Boolean).join("\n"),
    image: bestCover(score) ? { url: bestCover(score) as string } : undefined,
    footer: { text: `${countryLabel(country)} • ${BOT_NAME}` },
    timestamp: event.time || undefined,
  };

  return {
    embeds: [embed],
    components: linkButtonRow([
      { label: "Beatmap", url: mapUrl ?? "" },
      { label: event.user.username, url: siteProfileUrl(siteOrigin, event.user.username) },
    ]),
    allowed_mentions: { parse: [] },
  };
}

// ---------------------------------------------------------------------------
// Snipe (live feed + /snipes)
// ---------------------------------------------------------------------------

export function snipeEmbed(event: SnipeEvent, country: string | null, siteOrigin: string): DiscordMessageBody {
  const mods = formatMods(event.mods);
  const acc = formatAcc(event.accuracy);
  const fromRank = event.boardRank ? ` from #${event.boardRank}` : "";
  const title = `${event.beatmapset.artist} - ${event.beatmapset.title} [${event.beatmap.version}]`;
  const keys = keyCount(event.beatmap.cs);
  const stars = event.beatmap.difficulty_rating != null ? `${event.beatmap.difficulty_rating.toFixed(2)}★` : "";

  const embed: DiscordEmbed = {
    author: {
      name: `${event.sniper.username} sniped ${event.victim.username}${fromRank}`,
      icon_url: event.sniper.avatar_url || undefined,
    },
    title: truncate(title, 240),
    url: event.beatmap.url || undefined,
    color: SNIPE_RED,
    description: [
      `\`${event.rank}\` ${mods} • ${acc} • ${formatPp(event.pp)}`,
      `Score **${formatInt(event.totalScore)}**${event.victimTotalScore != null ? ` vs ${formatInt(event.victimTotalScore)}` : ""}`,
      [keys, stars].filter(Boolean).join(" • "),
    ].filter(Boolean).join("\n"),
    image: event.beatmapset.cover_url ? { url: event.beatmapset.cover_url } : undefined,
    footer: { text: `${countryLabel(country)} • ${BOT_NAME}` },
    timestamp: event.timestamp || undefined,
  };

  return {
    embeds: [embed],
    components: linkButtonRow([
      { label: "Beatmap", url: event.beatmap.url ?? "" },
      { label: "Snipes", url: `${siteOrigin}/snipes?country=${encodeURIComponent((country ?? "").toUpperCase())}` },
    ]),
    allowed_mentions: { parse: [] },
  };
}

export function topPlaysListEmbed(popoffs: CountryTopPlay[], country: string | null, siteOrigin: string): DiscordMessageBody {
  const list = popoffs.slice(0, 10);
  const lines = list.map((p) => {
    const map = beatmapTitle(p.score);
    const url = beatmapUrl(p.score);
    const head = url ? `[${truncate(map, 70)}](${url})` : truncate(map, 70);
    const gain = p.ppGain > 0 ? ` (+${Math.round(p.ppGain)})` : "";
    return `**${p.user.username}** • ${head} ${formatMods(p.score.mods)} • **${formatPp(p.score.pp)}**${gain}`;
  });
  const embed: DiscordEmbed = {
    title: "Recent top plays",
    color: TOP_PLAY_GOLD,
    description: lines.length ? lines.join("\n") : "No recent top plays found.",
    footer: { text: `${countryLabel(country)} • ${BOT_NAME}` },
  };
  return {
    embeds: [embed],
    components: linkButtonRow([{ label: "Top plays", url: `${siteOrigin}/top-plays?country=${encodeURIComponent((country ?? "").toUpperCase())}` }]),
  };
}

export function snipesListEmbed(events: SnipeEvent[], country: string | null, siteOrigin: string): DiscordMessageBody {
  const list = events.slice(0, 10);
  const lines = list.map((e) => {
    const map = `${e.beatmapset.title} [${e.beatmap.version}]`;
    const url = e.beatmap.url;
    const head = url ? `[${truncate(map, 60)}](${url})` : truncate(map, 60);
    return `**${e.sniper.username}** sniped ${e.victim.username} • ${head} • ${formatAcc(e.accuracy)}`;
  });
  const embed: DiscordEmbed = {
    title: "Recent snipes",
    color: SNIPE_RED,
    description: lines.length ? lines.join("\n") : "No recent snipes found.",
    footer: { text: `${countryLabel(country)} • ${BOT_NAME}` },
  };
  return {
    embeds: [embed],
    components: linkButtonRow([{ label: "Snipes", url: `${siteOrigin}/snipes?country=${encodeURIComponent((country ?? "").toUpperCase())}` }]),
  };
}

export function compareEmbed(
  a: { user: Record<string, unknown> },
  b: { user: Record<string, unknown> },
  siteOrigin: string,
): DiscordMessageBody {
  const ua = a.user as unknown as ProfileUser;
  const ub = b.user as unknown as ProfileUser;
  const stat = (u: ProfileUser, pick: (s: ProfileUserStats) => number | null | undefined): number | null => {
    const v = pick(u.statistics ?? {});
    return v == null ? null : Number(v);
  };
  const row = (label: string, pick: (s: ProfileUserStats) => number | null | undefined, fmt: (n: number | null) => string, lowerWins = false) => {
    const va = stat(ua, pick);
    const vb = stat(ub, pick);
    let mark = ["", ""];
    if (va != null && vb != null && va !== vb) {
      const aWins = lowerWins ? va < vb : va > vb;
      mark = aWins ? ["**", ""] : ["", "**"];
    }
    return `${label}: ${mark[0]}${fmt(va)}${mark[0]}  vs  ${mark[1]}${fmt(vb)}${mark[1]}`;
  };
  const embed: DiscordEmbed = {
    title: `${ua.username ?? "?"} vs ${ub.username ?? "?"}`,
    color: OSU_PINK,
    description: [
      row("pp", (s) => s.pp, (n) => (n == null ? "-" : `${formatInt(n)}pp`)),
      row("Global rank", (s) => s.global_rank, formatRank, true),
      row("Country rank", (s) => s.country_rank, formatRank, true),
      row("Accuracy", (s) => s.hit_accuracy, (n) => (n == null ? "-" : formatAcc(n))),
      row("Play count", (s) => s.play_count, formatInt),
    ].join("\n"),
    footer: { text: BOT_NAME },
  };
  return {
    embeds: [embed],
    components: linkButtonRow([
      { label: ua.username ?? "Player 1", url: ua.username ? siteProfileUrl(siteOrigin, ua.username) : "" },
      { label: ub.username ?? "Player 2", url: ub.username ? siteProfileUrl(siteOrigin, ub.username) : "" },
    ]),
  };
}

export function helpEmbed(siteOrigin: string): DiscordMessageBody {
  const embed: DiscordEmbed = {
    title: BOT_NAME,
    url: siteOrigin,
    color: OSU_PINK,
    description: [
      "osu!mania stats, rankings and live feeds.",
      "",
      "**Lookups**",
      "`/player <user>` - profile card",
      "`/maniacard <user>` - shareable skill card",
      "`/recent <user>` - recent plays",
      "`/rankings [country]` - leaderboard",
      "`/top [country]` - recent top plays",
      "`/snipes [country]` - recent snipes",
      "`/farm <user> [keys]` - pp-gain farm picks",
      "`/dan <beatmap>` - dan estimate",
      "`/compare <a> <b>` - head-to-head",
      "",
      "**Live feeds** (needs Manage Server)",
      "`/subscribe <feed> [country] [min_pp]` - post a feed to this channel",
      "`/unsubscribe <feed> [country]` - stop a feed",
      "`/subscriptions` - list this server's feeds",
    ].join("\n"),
    footer: { text: BOT_NAME },
  };
  return { embeds: [embed], components: linkButtonRow([{ label: "Open Mania Hub", url: siteOrigin }]) };
}

// ---------------------------------------------------------------------------
// Rankings
// ---------------------------------------------------------------------------

interface RankingEntry {
  rank: number;
  user: { id: number; username: string; country_code: string };
  pp: number;
}

export function rankingsEmbed(
  entries: RankingEntry[],
  country: string | null,
  siteOrigin: string,
): DiscordMessageBody {
  const list = entries.slice(0, 15);
  const global = !country || isGlobalCountry(country);
  const lines = list.map((e) => {
    // Country only adds signal on the global board, where players differ; on a
    // country board it is redundant with the title.
    const cc = (e.user.country_code ?? "").toUpperCase();
    const place = global && cc ? ` ${cc} •` : " •";
    return `\`#${e.rank}\` **${e.user.username}**${place} ${formatInt(e.pp)}pp`;
  });
  const scope = global ? "Global" : countryLabel(country);
  const embed: DiscordEmbed = {
    title: `${scope} mania rankings`,
    color: OSU_PINK,
    description: lines.length ? lines.join("\n") : "No ranked players found.",
    footer: { text: BOT_NAME },
  };
  const linkCountry = country ? country.toUpperCase() : GLOBAL_COUNTRY_CODE;
  return {
    embeds: [embed],
    components: linkButtonRow([{ label: "Full rankings", url: `${siteOrigin}/rankings?country=${encodeURIComponent(linkCountry)}` }]),
  };
}

// ---------------------------------------------------------------------------
// Farm helper
// ---------------------------------------------------------------------------

interface FarmRec {
  title: string;
  artist: string;
  version: string;
  keys: number;
  stars: number;
  estimatedPpGain: number;
  recommendedMods: string[];
  mapUrl: string;
}

export function farmEmbed(
  snapshot: { username: string; userId: number; pp: number; keyMode: string; recs: FarmRec[] },
  siteOrigin: string,
): DiscordMessageBody {
  const list = snapshot.recs.slice(0, 8);
  const lines = list.map((r, i) => {
    const mods = r.recommendedMods?.length ? `+${r.recommendedMods.join("")}` : "NM";
    const name = truncate(`${r.artist} - ${r.title} [${r.version}]`, 80);
    const head = r.mapUrl ? `[${name}](${r.mapUrl})` : name;
    return `\`${i + 1}.\` ${head} ${mods} • **+${Math.round(r.estimatedPpGain)}pp**`;
  });
  const embed: DiscordEmbed = {
    author: { name: snapshot.username, url: snapshot.userId ? osuProfileUrl(snapshot.userId) : undefined },
    color: OSU_PINK,
    description: lines.length
      ? `**Farm picks**\n${lines.join("\n")}`
      : "No farm recommendations available right now.",
    footer: { text: `${snapshot.keyMode.toUpperCase()} • ${BOT_NAME}` },
  };
  return {
    embeds: [embed],
    components: linkButtonRow([{ label: "Farm Helper", url: `${siteOrigin}/farm-helper?user=${encodeURIComponent(snapshot.username)}` }]),
  };
}

// ---------------------------------------------------------------------------
// Dan estimate
// ---------------------------------------------------------------------------

// Reform dan emblems: 1-10 ship as svg, the greek tiers as webp. LN dans own a
// separate 1-16 svg set. Mirrors the in-app DanBadge asset resolution.
const DAN_EMBLEM_EXT: Record<string, "webp" | "svg"> = {
  "1": "svg", "2": "svg", "3": "svg", "4": "svg", "5": "svg",
  "6": "svg", "7": "svg", "8": "svg", "9": "svg", "10": "svg",
  alpha: "webp", beta: "webp", gamma: "webp", delta: "webp",
  epsilon: "webp", zeta: "webp", eta: "webp",
};

// Discord renders webp directly, so those emblems are linked straight from
// /images. SVG emblems are rasterized through the og dan-emblem route since
// Discord will not display SVG in an embed.
function danEmblemUrl(siteOrigin: string, label: string | undefined, family: string | undefined): string | null {
  if (!label) return null;
  if (family === "ln" && /^(1[0-6]|[1-9])$/.test(label)) {
    return `${siteOrigin}/api/og?kind=dan-emblem&family=ln&label=${encodeURIComponent(label)}`;
  }
  const ext = DAN_EMBLEM_EXT[label];
  if (!ext) return null;
  if (ext === "webp") return `${siteOrigin}/images/dans/reform/${encodeURIComponent(label)}.webp`;
  return `${siteOrigin}/api/og?kind=dan-emblem&family=${encodeURIComponent(family ?? "")}&label=${encodeURIComponent(label)}`;
}

function titleCase(value: string): string {
  return value ? value.charAt(0).toUpperCase() + value.slice(1) : value;
}

export function danEmbed(
  beatmapId: number,
  estimate: { displayName?: string; label?: string; family?: string; confidence?: number } | null,
  pending: boolean,
  siteOrigin: string,
): DiscordMessageBody {
  const mapUrl = `${OSU_BASE}/b/${beatmapId}`;
  const embed: DiscordEmbed = {
    title: "Dan estimate",
    url: mapUrl,
    color: OSU_PINK,
    footer: { text: BOT_NAME },
  };
  if (estimate) {
    embed.description = [
      `**${estimate.displayName ?? estimate.label ?? "Unknown"}**`,
      estimate.family ? `Family: ${titleCase(estimate.family)}` : "",
      estimate.confidence != null ? `Confidence: ${Math.round(estimate.confidence * 100)}%` : "",
    ].filter(Boolean).join("\n");
    const emblem = danEmblemUrl(siteOrigin, estimate.label, estimate.family);
    if (emblem) embed.thumbnail = { url: emblem };
  } else {
    embed.description = pending
      ? "Estimating this chart now, try again in a few seconds. If it stays like this the beatmap id may be invalid."
      : "No dan estimate available for this beatmap (ranked mania 4K only).";
  }
  return { embeds: [embed], components: linkButtonRow([{ label: "Beatmap", url: mapUrl }]) };
}

// ---------------------------------------------------------------------------
// Plain helpers for simple text responses
// ---------------------------------------------------------------------------

export function errorBody(message: string): DiscordMessageBody {
  return { content: message, embeds: [], components: [], allowed_mentions: { parse: [] } };
}

export function noticeBody(message: string): DiscordMessageBody {
  return { content: message, embeds: [], components: [], allowed_mentions: { parse: [] } };
}
