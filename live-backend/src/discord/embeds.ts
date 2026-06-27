import type { CountryTopPlay, LeanTrackerScore, OscScore, OsuMod, SnipeEvent } from "../shared/types.js";
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
      "osu!mania stats, rankings, alerts and live feeds. Link your account once and most commands work with no username.",
      "",
      "**You**",
      "`/link <user>` save your osu! account  •  `/whoami`  •  `/unlink`",
      "`/me` your dashboard  •  `/recent [user]`  •  `/activity [user]`  •  `/goals [user]`",
      "",
      "**Players**",
      "`/player [user]` profile  •  `/maniacard [user]` skill card  •  `/compare [a] <b>`  •  `/farm [user] [keys]`",
      "",
      "**Browse**",
      "`/rankings [country] [sort]`  •  `/top [country] [range] [keys]`  •  `/tracker [country]`  •  `/maps [country] [tab] [keys]`",
      "",
      "**Beatmaps**",
      "`/dan <beatmap>`  •  `/map <beatmap>`  •  `/replay <score>`",
      "",
      "**DM alerts**",
      "`/watch user <user> [min_pp]` ping me on their plays  •  `/watch maps` new farm maps  •  `/watch list`  •  `/watch stop <target>`",
      "",
      "**Server feeds** (Manage Server)",
      "`/subscribe <feed> [country] [min_pp]`  •  `/unsubscribe <feed> [country]`  •  `/subscriptions`",
    ].join("\n"),
    footer: { text: BOT_NAME },
  };
  return {
    embeds: [embed],
    components: linkButtonRow([
      { label: "Open Mania Hub", url: siteOrigin },
      { label: "Privacy", url: `${siteOrigin}/privacy` },
      { label: "Terms", url: `${siteOrigin}/terms` },
    ]),
  };
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
// Shared helpers for the newer surfaces
// ---------------------------------------------------------------------------

// Joins list lines but stops before the combined embed would approach Discord's
// 6000-char message budget, appending an overflow note. Guards the dense list
// builders so a populated leaderboard can never 400 the response and leave a
// stuck "thinking" spinner.
function joinClamped(lines: string[], maxChars = 3800): string {
  const kept: string[] = [];
  let used = 0;
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (used + line.length + 1 > maxChars) {
      kept.push(`...and ${lines.length - kept.length} more`);
      break;
    }
    kept.push(line);
    used += line.length + 1;
  }
  return kept.join("\n");
}

// mm:ss for a length/duration given in seconds.
function formatClock(totalSeconds: number | null | undefined): string {
  if (totalSeconds == null || !Number.isFinite(totalSeconds) || totalSeconds <= 0) return "-";
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = Math.round(totalSeconds % 60);
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

const PATTERN_LABELS: Record<string, string> = {
  stream: "Stream", jumpstream: "Jumpstream", handstream: "Handstream", jacks: "Jacks",
  jack: "Jacks", chordjack: "Chordjack", chordjacks: "Chordjacks", stamina: "Stamina",
  tech: "Tech", technical: "Technical", speed: "Speed", ln: "LN", longnote: "LN",
  jumptrill: "Jumptrill", bracket: "Bracket", coordination: "Coordination", hybrid: "Hybrid",
};
function patternLabel(key: string): string {
  return PATTERN_LABELS[key.toLowerCase()] ?? titleCase(key);
}

function scopeLabel(country: string | null | undefined): string {
  return !country || isGlobalCountry(country) ? "Global" : countryLabel(country);
}

function countryLink(siteOrigin: string, path: string, country: string | null | undefined): string {
  const code = !country || isGlobalCountry(country) ? GLOBAL_COUNTRY_CODE : country.toUpperCase();
  return `${siteOrigin}${path}?country=${encodeURIComponent(code)}`;
}

// ---------------------------------------------------------------------------
// Personal dashboard (/me)
// ---------------------------------------------------------------------------

interface MeSummary {
  userId: number;
  username: string | null;
  avatarUrl: string | null;
  countryCode: string | null;
  pp: number | null;
  globalRank: number | null;
  countryRank: number | null;
  tracked: boolean;
  rankedMember: boolean;
  activeDays: number;
  sessions: number;
  topPlayCount: number;
  highlights: {
    biggestDay: { count: number; day: string } | null;
    longestStreak: number;
    ppGainedTracked: number;
  };
  goalsOpen: number;
  goalsCompleted: number;
}

export function meEmbed(summary: MeSummary, siteOrigin: string): DiscordMessageBody {
  const username = summary.username ?? "You";
  const cc = (summary.countryCode ?? "").toUpperCase();
  const fields = [
    { name: "Global", value: formatRank(summary.globalRank), inline: true },
    { name: `Country (${cc || "-"})`, value: formatRank(summary.countryRank), inline: true },
    { name: "pp", value: summary.pp == null ? "-" : `${formatInt(summary.pp)}pp`, inline: true },
    { name: "Active days", value: formatInt(summary.activeDays), inline: true },
    { name: "Sessions", value: formatInt(summary.sessions), inline: true },
    { name: "Top plays", value: formatInt(summary.topPlayCount), inline: true },
  ];

  const lines: string[] = [];
  if (summary.highlights.biggestDay && summary.highlights.biggestDay.count > 0) {
    lines.push(`Biggest day: **${formatInt(summary.highlights.biggestDay.count)}** plays on ${summary.highlights.biggestDay.day}`);
  }
  if (summary.highlights.longestStreak > 0) {
    lines.push(`Longest streak: **${summary.highlights.longestStreak}** day${summary.highlights.longestStreak === 1 ? "" : "s"}`);
  }
  if (summary.highlights.ppGainedTracked > 0) {
    lines.push(`pp gained while tracked: **+${formatInt(summary.highlights.ppGainedTracked)}**`);
  }
  lines.push(`Goals: **${summary.goalsOpen}** open, **${summary.goalsCompleted}** done`);
  if (!summary.rankedMember) {
    lines.push("Not on a tracked country's roster yet, so live stats stay limited until you appear in one.");
  }

  const embed: DiscordEmbed = {
    author: { name: username, url: summary.userId ? osuProfileUrl(summary.userId) : undefined, icon_url: summary.avatarUrl || undefined },
    color: OSU_PINK,
    thumbnail: summary.avatarUrl ? { url: summary.avatarUrl } : undefined,
    fields,
    description: `**Highlights**\n${lines.join("\n")}`,
    footer: { text: BOT_NAME },
  };
  return {
    embeds: [embed],
    components: linkButtonRow([
      { label: "My Data", url: `${siteOrigin}/my-data` },
      { label: "osu! profile", url: summary.userId ? osuProfileUrl(summary.userId) : "" },
    ]),
  };
}

// ---------------------------------------------------------------------------
// Activity / playstyle (/activity)
// ---------------------------------------------------------------------------

interface ActivitySnapshotLike {
  year: number;
  totalScores: number;
  activeDays: number;
  totalSessions: number;
  typicalSession: number;
  currentStreak: number;
  days: Array<{ skills: { patterns?: Record<string, number> } | null }>;
}

// Sums the per-day pattern weights into a single playstyle mix and returns the
// strongest patterns as whole-percent shares.
function aggregatePatterns(days: ActivitySnapshotLike["days"]): Array<{ label: string; pct: number }> {
  const totals = new Map<string, number>();
  for (const day of days) {
    const patterns = day.skills?.patterns;
    if (!patterns) continue;
    for (const [key, weight] of Object.entries(patterns)) {
      if (!Number.isFinite(weight) || weight <= 0) continue;
      totals.set(key, (totals.get(key) ?? 0) + weight);
    }
  }
  const sum = [...totals.values()].reduce((a, b) => a + b, 0);
  if (sum <= 0) return [];
  return [...totals.entries()]
    .map(([key, weight]) => ({ label: patternLabel(key), pct: Math.round((weight / sum) * 100) }))
    .filter((entry) => entry.pct > 0)
    .sort((a, b) => b.pct - a.pct)
    .slice(0, 5);
}

export function activityEmbed(
  username: string,
  userId: number,
  snapshot: ActivitySnapshotLike,
  siteOrigin: string,
): DiscordMessageBody {
  const patterns = aggregatePatterns(snapshot.days);
  const fields = [
    { name: "Active days", value: formatInt(snapshot.activeDays), inline: true },
    { name: "Total plays", value: formatInt(snapshot.totalScores), inline: true },
    { name: "Sessions", value: formatInt(snapshot.totalSessions), inline: true },
    { name: "Plays / session", value: formatInt(snapshot.typicalSession), inline: true },
    { name: "Current streak", value: `${formatInt(snapshot.currentStreak)}d`, inline: true },
    { name: "Year", value: String(snapshot.year), inline: true },
  ];
  const description = patterns.length
    ? `**Playstyle**\n${patterns.map((p) => `${p.label} ${p.pct}%`).join("  •  ")}`
    : "No playstyle breakdown yet. Keep playing tracked maps to build one.";
  const embed: DiscordEmbed = {
    author: { name: username, url: userId ? osuProfileUrl(userId) : undefined },
    color: OSU_PINK,
    fields,
    description,
    footer: { text: BOT_NAME },
  };
  return {
    embeds: [embed],
    components: linkButtonRow([{ label: "Activity", url: `${siteOrigin}/player/${encodeURIComponent(username)}/activity` }]),
  };
}

// ---------------------------------------------------------------------------
// Goals (/goals)
// ---------------------------------------------------------------------------

interface GoalLike {
  kind: string;
  beatmapLabel: string | null;
  targetValue: number | null;
  targetGrade: string | null;
  status: string;
  progress?: { pct: number | null; detail: string | null } | null;
}

function goalHeadline(goal: GoalLike): string {
  const acc = (value: number | null): string => (value == null ? "?" : `${(value <= 1 ? value * 100 : value).toFixed(2)}%`);
  switch (goal.kind) {
    case "reach_pp": return `Reach ${formatInt(goal.targetValue)}pp`;
    case "play_pp": return `Land a ${formatInt(goal.targetValue)}pp play`;
    case "accuracy": return `${acc(goal.targetValue)} on ${goal.beatmapLabel ?? "a map"}`;
    case "pass": return `Pass ${goal.beatmapLabel ?? "a map"}`;
    case "grade": return `Get ${goal.targetGrade ?? "?"} on ${goal.beatmapLabel ?? "a map"}`;
    default: return goal.beatmapLabel ?? "Goal";
  }
}

export function goalsEmbed(
  username: string,
  userId: number,
  goals: GoalLike[],
  siteOrigin: string,
): DiscordMessageBody {
  const open = goals.filter((g) => g.status === "open");
  const completed = goals.filter((g) => g.status === "completed").length;
  const lines = open.slice(0, 12).map((goal) => {
    const headline = truncate(goalHeadline(goal), 90);
    const pct = goal.progress?.pct;
    const detail = goal.progress?.detail;
    const trailer = [detail ? detail : null, pct != null ? `${Math.round(pct)}%` : null].filter(Boolean).join(", ");
    return `- ${headline}${trailer ? ` (${trailer})` : ""}`;
  });
  const description = lines.length
    ? `**Open goals**\n${joinClamped(lines)}`
    : completed > 0
      ? "No open goals right now."
      : "No goals set yet. Create them on the goals page.";
  const embed: DiscordEmbed = {
    author: { name: username, url: userId ? osuProfileUrl(userId) : undefined },
    color: OSU_PINK,
    description,
    footer: { text: `${open.length} open • ${completed} done • ${BOT_NAME}` },
  };
  return {
    embeds: [embed],
    components: linkButtonRow([{ label: "Goals", url: `${siteOrigin}/goals` }]),
  };
}

// ---------------------------------------------------------------------------
// Live tracker (/tracker)
// ---------------------------------------------------------------------------

function trackerScoreLine(score: LeanTrackerScore): string {
  const set = score.beatmapset;
  const name = set ? `${set.artist} - ${set.title}` : `Beatmap ${score.beatmap_id ?? score.id}`;
  const version = score.beatmap?.version ? ` [${score.beatmap.version}]` : "";
  const title = truncate(`${name}${version}`, 58);
  const url = score.beatmap?.url ?? (score.beatmap_id ? `${OSU_BASE}/b/${score.beatmap_id}` : undefined);
  const head = url ? `[${title}](${url})` : title;
  const grade = score.rank || "?";
  const mods = formatMods(score.mods);
  const acc = formatAcc(score.accuracy);
  const pp = score.pp != null ? ` • **${formatPp(score.pp)}**` : "";
  return `\`${grade}\` **${truncate(score.user?.username ?? "?", 18)}** ${head} ${mods} • ${acc}${pp}`;
}

export function trackerListEmbed(
  scores: LeanTrackerScore[],
  country: string | null,
  siteOrigin: string,
): DiscordMessageBody {
  const lines = scores.map(trackerScoreLine);
  const embed: DiscordEmbed = {
    title: `Latest scores in ${scopeLabel(country)}`,
    color: OSU_PINK,
    description: lines.length ? joinClamped(lines) : "No recent scores found.",
    footer: { text: BOT_NAME },
  };
  return {
    embeds: [embed],
    components: linkButtonRow([{ label: "Live tracker", url: countryLink(siteOrigin, "/tracker", country) }]),
  };
}

// ---------------------------------------------------------------------------
// Maps (/maps)
// ---------------------------------------------------------------------------

interface FarmedMapLike {
  beatmapId: number;
  version: string;
  difficultyRating: number;
  title: string;
  artist: string;
  playerCount: number;
  avgPp: number;
  maxPp: number;
}
interface PopularMapLike {
  beatmapId: number;
  version: string;
  title: string;
  artist: string;
  totalPlays: number;
  playerCount: number;
}

export function mapsListEmbed(
  params: { farmed: FarmedMapLike[]; popular: PopularMapLike[]; tab: "farmed" | "popular"; country: string | null; keys: string; siteOrigin: string },
): DiscordMessageBody {
  const { tab, country, keys, siteOrigin } = params;
  const keyNote = keys && keys !== "any" ? `${keys.toUpperCase()} • ` : "";
  let title: string;
  let lines: string[];
  if (tab === "popular") {
    title = `Most played maps in ${scopeLabel(country)}`;
    lines = params.popular.map((m, i) => {
      const name = truncate(`${m.artist} - ${m.title} [${m.version}]`, 58);
      return `\`#${i + 1}\` [${name}](${OSU_BASE}/b/${m.beatmapId}) • ${formatInt(m.totalPlays)} plays • ${m.playerCount} players`;
    });
  } else {
    title = `Most farmed maps in ${scopeLabel(country)}`;
    lines = params.farmed.map((m, i) => {
      const name = truncate(`${m.artist} - ${m.title} [${m.version}]`, 56);
      const stars = m.difficultyRating != null ? ` ${m.difficultyRating.toFixed(2)}★` : "";
      return `\`#${i + 1}\` [${name}](${OSU_BASE}/b/${m.beatmapId})${stars} • avg **${formatPp(m.avgPp)}** • ${m.playerCount} players`;
    });
  }
  const embed: DiscordEmbed = {
    title,
    color: OSU_PINK,
    description: lines.length ? joinClamped(lines) : "No maps found yet for this scope.",
    footer: { text: `${keyNote}${BOT_NAME}` },
  };
  const linkTab = tab === "popular" ? "popular" : "farmed";
  return {
    embeds: [embed],
    components: linkButtonRow([{ label: "All maps", url: `${countryLink(siteOrigin, "/maps", country)}&tab=${linkTab}` }]),
  };
}

// ---------------------------------------------------------------------------
// Beatmap card (/map)
// ---------------------------------------------------------------------------

interface BeatmapLike {
  id: number;
  version?: string;
  difficulty_rating?: number;
  cs?: number;
  bpm?: number;
  total_length?: number;
  status?: string;
  url?: string;
  beatmapset?: { title?: string; artist?: string; creator?: string; covers?: Record<string, string | undefined> };
}

export function beatmapEmbed(
  beatmap: BeatmapLike,
  estimate: { displayName?: string; label?: string; family?: string } | null,
  siteOrigin: string,
): DiscordMessageBody {
  const set = beatmap.beatmapset ?? {};
  const title = `${set.artist ?? "Unknown"} - ${set.title ?? "Unknown"}`;
  const mapUrl = beatmap.url || `${OSU_BASE}/b/${beatmap.id}`;
  const cover = set.covers?.["cover@2x"] ?? set.covers?.cover ?? set.covers?.["card@2x"] ?? set.covers?.card;
  const danText = estimate ? (estimate.displayName ?? estimate.label ?? "-") : "-";
  const fields = [
    { name: "Stars", value: beatmap.difficulty_rating != null ? `${beatmap.difficulty_rating.toFixed(2)}★` : "-", inline: true },
    { name: "Keys", value: beatmap.cs != null ? `${Math.round(beatmap.cs)}K` : "-", inline: true },
    { name: "Status", value: beatmap.status ? titleCase(beatmap.status) : "-", inline: true },
    { name: "BPM", value: beatmap.bpm != null ? formatInt(beatmap.bpm) : "-", inline: true },
    { name: "Length", value: formatClock(beatmap.total_length), inline: true },
    { name: "Dan", value: danText, inline: true },
  ];
  const embed: DiscordEmbed = {
    author: set.creator ? { name: `mapped by ${set.creator}` } : undefined,
    title: truncate(`${title} [${beatmap.version ?? ""}]`, 240),
    url: mapUrl,
    color: OSU_PINK,
    fields,
    image: cover ? { url: cover } : undefined,
    footer: { text: BOT_NAME },
  };
  return {
    embeds: [embed],
    components: linkButtonRow([
      { label: "Beatmap", url: mapUrl },
      { label: "Farm detail", url: `${siteOrigin}/farm-helper/map/${beatmap.id}` },
    ]),
  };
}

// ---------------------------------------------------------------------------
// Replay (/replay)
// ---------------------------------------------------------------------------

export function replayEmbed(scoreId: number, siteOrigin: string): DiscordMessageBody {
  const viewerUrl = `${siteOrigin}/replay?scoreId=${scoreId}`;
  const embed: DiscordEmbed = {
    title: "Replay viewer",
    url: viewerUrl,
    color: OSU_PINK,
    description: [
      `Watch score \`${scoreId}\` in the Mania Hub replay viewer.`,
      "Adjust skin, scroll speed and overlays, or export it to video.",
    ].join("\n"),
    footer: { text: BOT_NAME },
  };
  return { embeds: [embed], components: linkButtonRow([{ label: "Watch replay", url: viewerUrl }]) };
}

// ---------------------------------------------------------------------------
// New farm map alert (feed + DM)
// ---------------------------------------------------------------------------

export interface NewMapAlert {
  beatmapId: number;
  beatmapsetId: number;
  title: string;
  artist: string;
  version: string;
  difficultyRating: number | null;
  cs: number | null;
  coverUrl: string | null;
  rankedAtMs: number | null;
  farmedUserCount?: number;
  farmedPlayCount?: number;
  farmedTotalPpGain?: number;
  farmedMaxPp?: number | null;
  signalWindowHours?: number;
}

export function newMapAlertEmbed(map: NewMapAlert, siteOrigin: string): DiscordMessageBody {
  const mapUrl = `${OSU_BASE}/b/${map.beatmapId}`;
  const meta = [
    map.cs != null ? `${Math.round(map.cs)}K` : "",
    map.difficultyRating != null ? `${map.difficultyRating.toFixed(2)}★` : "",
    map.rankedAtMs != null ? `ranked ${new Date(map.rankedAtMs).toISOString().slice(0, 10)}` : "",
    map.farmedUserCount != null ? `${map.farmedUserCount} players gained pp` : "",
  ].filter(Boolean).join(" • ");
  const signal = map.farmedUserCount != null
    ? `Detected from ${map.farmedPlayCount ?? map.farmedUserCount} confirmed top plays`
      + (map.signalWindowHours ? ` in ${map.signalWindowHours}h` : "")
      + (map.farmedTotalPpGain != null ? `, +${formatPp(map.farmedTotalPpGain)} total gain` : "")
      + "."
    : "";
  const embed: DiscordEmbed = {
    title: "New farm map",
    color: TOP_PLAY_GOLD,
    description: [
      `**[${truncate(`${map.artist} - ${map.title} [${map.version}]`, 220)}](${mapUrl})**`,
      meta,
      signal,
    ].filter(Boolean).join("\n"),
    image: map.coverUrl ? { url: map.coverUrl } : undefined,
    footer: { text: BOT_NAME },
  };
  return {
    embeds: [embed],
    components: linkButtonRow([
      { label: "Beatmap", url: mapUrl },
      { label: "Maps", url: `${siteOrigin}/maps?tab=farmed` },
    ]),
    allowed_mentions: { parse: [] },
  };
}

// A tracked player's ranked score that cleared the watcher's pp threshold but
// was not necessarily a new top play (those reuse topPlayEmbed). Sent to DMs.
export function trackedScoreAlertEmbed(score: LeanTrackerScore, siteOrigin: string): DiscordMessageBody {
  const set = score.beatmapset;
  const name = set ? `${set.artist} - ${set.title}` : `Beatmap ${score.beatmap_id ?? score.id}`;
  const version = score.beatmap?.version ? ` [${score.beatmap.version}]` : "";
  const mapUrl = score.beatmap?.url ?? `${OSU_BASE}/b/${score.beatmap_id ?? score.id}`;
  const stars = score.beatmap?.difficulty_rating != null ? `${score.beatmap.difficulty_rating.toFixed(2)}★` : "";
  const keys = score.beatmap?.cs != null ? `${Math.round(score.beatmap.cs)}K` : "";
  const cover = set?.covers?.["cover@2x"] ?? set?.covers?.cover;
  const username = score.user?.username ?? "Player";
  const embed: DiscordEmbed = {
    author: { name: username, url: score.user?.id ? osuProfileUrl(score.user.id) : undefined, icon_url: score.user?.avatar_url || undefined },
    title: "Ranked play",
    color: OSU_PINK,
    description: [
      mapUrl ? `**[${truncate(`${name}${version}`, 200)}](${mapUrl})**` : `**${name}${version}**`,
      `\`${score.rank || "?"}\` ${formatMods(score.mods)} • ${formatAcc(score.accuracy)} • **${formatPp(score.pp)}**`,
      [keys, stars].filter(Boolean).join(" • "),
    ].filter(Boolean).join("\n"),
    image: cover ? { url: cover } : undefined,
    footer: { text: BOT_NAME },
    timestamp: score.ended_at || undefined,
  };
  return {
    embeds: [embed],
    components: linkButtonRow([
      { label: "Beatmap", url: mapUrl },
      { label: username, url: siteProfileUrl(siteOrigin, username) },
    ]),
    allowed_mentions: { parse: [] },
  };
}

// ---------------------------------------------------------------------------
// Identity + watch management (small confirmation embeds)
// ---------------------------------------------------------------------------

export function whoamiEmbed(link: { osuUsername: string; osuUserId: number; countryCode: string | null }, siteOrigin: string): DiscordMessageBody {
  const embed: DiscordEmbed = {
    author: { name: link.osuUsername, url: osuProfileUrl(link.osuUserId) },
    color: OSU_PINK,
    description: `You are linked to **${link.osuUsername}**${link.countryCode ? ` (${link.countryCode.toUpperCase()})` : ""}.\nCommands like \`/recent\` use this account when you do not pass a username.`,
    footer: { text: BOT_NAME },
  };
  return {
    embeds: [embed],
    flags: 1 << 6,
    components: linkButtonRow([{ label: "Profile", url: siteProfileUrl(siteOrigin, link.osuUsername) }]),
  };
}

export function watchListEmbed(
  watches: Array<{ kind: string; targetUsername: string | null; minPp: number }>,
): DiscordMessageBody {
  const lines = watches.map((w) => {
    if (w.kind === "maps") return "- New farm maps";
    const pp = w.minPp > 0 ? ` (also ranked plays at or above ${Math.round(w.minPp)}pp)` : "";
    return `- Player **${w.targetUsername ?? "?"}**${pp}`;
  });
  const embed: DiscordEmbed = {
    title: "Your alerts",
    color: OSU_PINK,
    description: lines.length ? lines.join("\n") : "You have no alerts set up. Use `/watch user` or `/watch maps`.",
    footer: { text: `${BOT_NAME} • alerts arrive in your DMs` },
  };
  return { embeds: [embed], flags: 1 << 6 };
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
