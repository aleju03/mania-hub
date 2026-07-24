import type { CountryTopPlay, LeanTrackerScore, OscScore, OsuMod, SnipeEvent } from "../shared/types.js";
import {
  getDisplayedAccuracy,
  getDisplayedRank,
  getDisplayedTotalScore,
  getModAcronyms,
  getScoreHitCounts,
  isFullCombo,
} from "../shared/score.js";
import { GLOBAL_COUNTRY_CODE, isGlobalCountry } from "../countries.js";
import type { DiscordComponent, DiscordEmbed, DiscordMessageBody } from "./rest.js";
import { helpNavRow, linkAccountRow } from "./components.js";
import { gradeEmoji, hasHitEmojis, hitEmoji, modsEmoji } from "./emojis.js";

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

// Normalises a score's mods (OsuMod objects or plain acronym strings) to a clean
// uppercase acronym list, dropping the no-op Classic mod, matching getModAcronyms.
function modAcronyms(mods: OsuMod[] | string[] | undefined): string[] {
  if (!mods || mods.length === 0) return [];
  return typeof mods[0] === "string"
    ? (mods as string[]).map((m) => m.toUpperCase()).filter((m) => m && m !== "CL")
    : getModAcronyms(mods as OsuMod[]);
}

// Mods as inline icons when registered, otherwise the `+HDDT` / `NM` text glyph.
function formatMods(mods: OsuMod[] | string[] | undefined): string {
  return modsEmoji(modAcronyms(mods));
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

// Square beatmap cover for the embed thumbnail (the small top-right image the
// big osu! bots use). The list crops are square; wide crops are a last resort
// since Discord letterboxes them inside the thumbnail slot.
function squareCover(covers: Record<string, string | undefined> | null | undefined): string | undefined {
  if (!covers) return undefined;
  return covers["list@2x"] ?? covers.list ?? covers["card@2x"] ?? covers.card ?? covers["cover@2x"] ?? covers.cover ?? undefined;
}

function scoreThumb(score: OscScore): string | undefined {
  return squareCover(score.beatmapset?.covers);
}

// Square cover reconstructed from a beatmapset id, for events that only carry a
// wide cover_url (snipes, new-map alerts). assets.ppy.sh serves every crop.
function setListCover(beatmapsetId: number | null | undefined): string | undefined {
  if (!beatmapsetId) return undefined;
  return `https://assets.ppy.sh/beatmaps/${beatmapsetId}/covers/list@2x.jpg`;
}

function keyCount(cs: number | undefined): string {
  return cs == null ? "" : `${Math.round(cs)}K`;
}

function osuProfileUrl(userId: number): string {
  return `${OSU_BASE}/users/${userId}/mania`;
}

// Canonical osu! avatar URL. Used as the author icon on player-keyed cards whose
// snapshot doesn't carry avatar_url; in Components V2 it becomes the top-right
// accessory when the card has no cover thumbnail.
function osuAvatarUrl(userId: number): string | undefined {
  return userId > 0 ? `https://a.ppy.sh/${userId}` : undefined;
}

// osu!'s own flag raster for a country code (redirects to assets.ppy.sh
// old-flags; Discord's media proxy follows it). Country-scoped list cards use
// the flag as their thumbnail so the card reads as the country's board rather
// than putting one arbitrary player's face on it. GLOBAL has no flag; callers
// fall back to a player avatar.
function countryFlagThumb(country: string | null | undefined): string | undefined {
  const code = (country ?? "").toUpperCase();
  if (!code || isGlobalCountry(code)) return undefined;
  return `https://osu.ppy.sh/images/flags/${code}.png`;
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
  const pp = score.pp != null ? ` • **${formatPp(score.pp)}**` : "";
  return `${gradeEmoji(getDisplayedRank(score))} ${head} ${mods} • ${acc}${pp}`;
}

// A full single-score card body (the owo-style block): grade + mod icons, star
// rating and key mode, then accuracy / combo / score, the judgement breakdown,
// and pp. Returned with the score's square cover so the caller can use it as the
// embed thumbnail (the small top-right image, never a bottom banner). Used
// wherever one score is the subject (/pb, the top-play feed).
function detailedScore(score: OscScore, opts: { gain?: number } = {}): { text: string; thumb: string | undefined } {
  const meta = [
    `${gradeEmoji(getDisplayedRank(score))} ${formatMods(score.mods)}`,
    [
      score.beatmap?.difficulty_rating != null ? `${score.beatmap.difficulty_rating.toFixed(2)}★` : "",
      keyCount(score.beatmap?.cs),
    ].filter(Boolean).join(" • "),
  ].filter(Boolean).join("   ");

  const combo = score.max_combo != null
    ? `${formatInt(score.max_combo)}x${isFullCombo(score) ? " FC" : ""}`
    : "";
  const total = getDisplayedTotalScore(score);
  const line2 = [`**${formatAcc(getDisplayedAccuracy(score))}**`, combo || null, total != null ? formatInt(total) : null]
    .filter(Boolean)
    .join(" • ");

  const h = getScoreHitCounts(score);
  // Judgement pills when registered (coloured 320/300/... emojis, far more
  // scannable than a wall of numbers); the mono chip is the unregistered fallback.
  const breakdown = hasHitEmojis()
    ? [
      `${hitEmoji("320")} ${formatInt(h.max)}`,
      `${hitEmoji("300")} ${formatInt(h.great)}`,
      `${hitEmoji("200")} ${formatInt(h.good)}`,
      `${hitEmoji("100")} ${formatInt(h.ok)}`,
      `${hitEmoji("50")} ${formatInt(h.meh)}`,
      `${hitEmoji("miss")} ${formatInt(h.miss)}`,
    ].join(" ")
    : "`"
    + `320 ${formatInt(h.max)} • 300 ${formatInt(h.great)} • 200 ${formatInt(h.good)} • 100 ${formatInt(h.ok)} • 50 ${formatInt(h.meh)} • miss ${formatInt(h.miss)}`
    + "`";

  const gain = opts.gain != null && opts.gain > 0 ? ` (+${Math.round(opts.gain)}pp)` : "";
  // No pp line at all for unranked/failed plays; a lone "-" is just noise.
  const ppLine = score.pp != null ? `**${formatPp(score.pp)}**${gain}` : null;

  return { text: [meta, line2, breakdown, ppLine].filter(Boolean).join("\n"), thumb: scoreThumb(score) };
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
  grade_counts?: { ss?: number; ssh?: number; s?: number; sh?: number; a?: number } | null;
}

// "SS 1,234  S 567  A 89" with grade pills, folding the silver (HD/FL) variants
// into their base grade. Returns null when the player has no graded plays.
function gradeCountLine(stats: ProfileUserStats): string | null {
  const gc = stats.grade_counts;
  if (!gc) return null;
  const ss = (gc.ss ?? 0) + (gc.ssh ?? 0);
  const s = (gc.s ?? 0) + (gc.sh ?? 0);
  const a = gc.a ?? 0;
  if (ss + s + a <= 0) return null;
  return `${gradeEmoji("X")} ${formatInt(ss)}  ${gradeEmoji("S")} ${formatInt(s)}  ${gradeEmoji("A")} ${formatInt(a)}`;
}

// The mod a player leans on most across the scores provided, or null when every
// play is nomod / no scores are available.
function mostUsedMod(scores: OscScore[]): string | null {
  const counts = new Map<string, number>();
  for (const score of scores) {
    for (const mod of modAcronyms(score.mods)) counts.set(mod, (counts.get(mod) ?? 0) + 1);
  }
  let top: string | null = null;
  let topCount = 0;
  for (const [mod, count] of counts) {
    if (count > topCount) {
      top = mod;
      topCount = count;
    }
  }
  return top;
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
  _siteOrigin: string,
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

  const topMod = mostUsedMod(snapshot.bestScores ?? []);
  const metaLine = [gradeCountLine(stats), topMod ? `Top mod ${modsEmoji([topMod])}` : null]
    .filter(Boolean)
    .join("  •  ");
  const description = [
    metaLine || null,
    best.length ? `**Top plays**\n${best.map(scoreLine).join("\n")}` : null,
  ].filter(Boolean).join("\n\n") || undefined;

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

  // No author avatar here: the card art already shows the player, so a second
  // face in the thumbnail slot is redundant.
  const embed: DiscordEmbed = {
    author: {
      name: username,
      url: userId ? osuProfileUrl(userId) : undefined,
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
  _siteOrigin: string,
): DiscordMessageBody {
  const list = scores.slice(0, 5);
  let description = "No recent mania plays found.";
  let thumb: string | undefined;
  let when: string | undefined;
  if (list.length) {
    const [latest, ...rest] = list;
    const detail = detailedScore(latest);
    thumb = detail.thumb;
    when = latest.ended_at || latest.created_at || undefined;
    const mapUrl = beatmapUrl(latest);
    const head = mapUrl ? `**[${beatmapTitle(latest)}](${mapUrl})**` : `**${beatmapTitle(latest)}**`;
    const blocks = [head, detail.text];
    if (rest.length) blocks.push(`**Earlier plays**\n${rest.map(scoreLine).join("\n")}`);
    description = blocks.join("\n");
  }
  const embed: DiscordEmbed = {
    author: { name: username, url: userId ? osuProfileUrl(userId) : undefined, icon_url: osuAvatarUrl(userId) },
    color: OSU_PINK,
    description,
    thumbnail: thumb ? { url: thumb } : undefined,
    footer: { text: BOT_NAME },
    timestamp: when,
  };
  return {
    embeds: [embed],
    components: [],
  };
}

export interface PbBeatmapRef {
  id: number;
  url?: string;
  title: string | null;
  version: string | null;
}

// A player's best score on a specific map, for /pb, /c and /compare. The map
// comes from the channel's "last shown map" memory, so the caller never retypes
// it.
export function pbEmbed(params: {
  username: string;
  userId: number;
  beatmap: PbBeatmapRef;
  score: OscScore | null;
  siteOrigin: string;
}): DiscordMessageBody {
  const { username, userId, beatmap, score, siteOrigin } = params;
  const mapUrl = beatmap.url || `${OSU_BASE}/b/${beatmap.id}`;
  const heading = truncate(
    `${beatmap.title ?? `Beatmap ${beatmap.id}`}${beatmap.version ? ` [${beatmap.version}]` : ""}`,
    200,
  );
  const embed: DiscordEmbed = {
    author: { name: username, url: userId ? osuProfileUrl(userId) : undefined, icon_url: osuAvatarUrl(userId) },
    title: heading,
    url: mapUrl,
    color: OSU_PINK,
    footer: { text: BOT_NAME },
  };
  if (score) {
    const detail = detailedScore(score);
    embed.description = detail.text;
    if (detail.thumb) embed.thumbnail = { url: detail.thumb };
    const when = score.ended_at || score.created_at;
    if (when) embed.timestamp = when;
  } else {
    embed.description = `**${username}** has no score on this map.`;
  }
  return {
    embeds: [embed],
    components: linkButtonRow([
      { label: "Beatmap", url: mapUrl },
      { label: username, url: siteProfileUrl(siteOrigin, username) },
    ]),
  };
}

// ---------------------------------------------------------------------------
// Top play (live feed + /top)
// ---------------------------------------------------------------------------

export function topPlayEmbed(event: CountryTopPlay, country: string | null, siteOrigin: string): DiscordMessageBody {
  const score = event.score;
  const mapUrl = beatmapUrl(score);
  const detail = detailedScore(score, { gain: event.ppGain });

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
      detail.text,
    ].join("\n"),
    thumbnail: detail.thumb ? { url: detail.thumb } : undefined,
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
      `${gradeEmoji(event.rank)} ${mods} • ${acc} • **${formatPp(event.pp)}**`,
      `Score **${formatInt(event.totalScore)}**${event.victimTotalScore != null ? ` vs ${formatInt(event.victimTotalScore)}` : ""}`,
      [keys, stars].filter(Boolean).join(" • "),
    ].filter(Boolean).join("\n"),
    thumbnail: (() => {
      const url = setListCover(event.beatmapset_id) ?? event.beatmapset.cover_url;
      return url ? { url } : undefined;
    })(),
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
    return `${gradeEmoji(getDisplayedRank(p.score))} **${p.user.username}** • ${head} ${formatMods(p.score.mods)} • **${formatPp(p.score.pp)}**${gain}`;
  });
  // Country boards get the flag in the one thumbnail slot; the global board has
  // no flag, so the freshest popoff's player gives the card a face instead
  // (per-row avatars are impossible in V2 text).
  const featured = list[0]?.user;
  const flag = countryFlagThumb(country);
  const embed: DiscordEmbed = {
    title: "Recent top plays",
    color: TOP_PLAY_GOLD,
    description: lines.length ? lines.join("\n") : "No recent top plays found.",
    thumbnail: flag ? { url: flag } : featured ? { url: featured.avatar_url || osuAvatarUrl(featured.id) || "" } : undefined,
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
  const sniper = list[0]?.sniper;
  const snipeFlag = countryFlagThumb(country);
  const embed: DiscordEmbed = {
    title: "Recent snipes",
    color: SNIPE_RED,
    description: lines.length ? lines.join("\n") : "No recent snipes found.",
    thumbnail: snipeFlag ? { url: snipeFlag } : sniper ? { url: sniper.avatar_url || osuAvatarUrl(sniper.id) || "" } : undefined,
    footer: { text: `${countryLabel(country)} • ${BOT_NAME}` },
  };
  return {
    embeds: [embed],
    components: linkButtonRow([{ label: "Snipes", url: `${siteOrigin}/snipes?country=${encodeURIComponent((country ?? "").toUpperCase())}` }]),
  };
}

// Per-keymode weighted pp for one side of a /vs, null when the player is not
// in the farm-helper pool for that keymode.
export interface CompareKeyPpSides {
  a: number | null;
  b: number | null;
}

// /vs is a side-by-side read, not a scoreboard: no per-row winner bolding and
// no tally naming who "leads". pp (with global rank) is the headline, the best
// single play shows the ceiling, and the 4K/7K weighted-pp split is the
// mania-meaningful part - two players with the same profile pp can be playing
// entirely different games. Values keep title order: left is player 1.
export function compareEmbed(
  a: { user: Record<string, unknown>; bestScores?: OscScore[] },
  b: { user: Record<string, unknown>; bestScores?: OscScore[] },
  siteOrigin: string,
  keyPp?: { four: CompareKeyPpSides; seven: CompareKeyPpSides },
): DiscordMessageBody {
  const ua = a.user as unknown as ProfileUser;
  const ub = b.user as unknown as ProfileUser;
  const sa = ua.statistics ?? {};
  const sb = ub.statistics ?? {};
  const num = (v: number | null | undefined): number | null => (v == null ? null : Number(v));
  const totalPp = (n: number | null): string => (n == null ? "-" : `${formatInt(n)}pp`);
  const headline = (s: ProfileUserStats): string => {
    const rank = num(s.global_rank);
    return rank == null ? totalPp(num(s.pp)) : `${totalPp(num(s.pp))} (#${formatInt(rank)})`;
  };
  const bestPp = (scores?: OscScore[]): number | null => {
    let best: number | null = null;
    for (const score of scores ?? []) {
      if (score.pp != null && (best == null || score.pp > best)) best = score.pp;
    }
    return best;
  };
  const lines = [`pp: ${headline(sa)} • ${headline(sb)}`];
  const bestA = bestPp(a.bestScores);
  const bestB = bestPp(b.bestScores);
  if (bestA != null || bestB != null) lines.push(`Best play: ${formatPp(bestA)} • ${formatPp(bestB)}`);
  if (keyPp) {
    if (keyPp.four.a != null || keyPp.four.b != null) lines.push(`4K: ${totalPp(keyPp.four.a)} • ${totalPp(keyPp.four.b)}`);
    if (keyPp.seven.a != null || keyPp.seven.b != null) lines.push(`7K: ${totalPp(keyPp.seven.a)} • ${totalPp(keyPp.seven.b)}`);
  }
  const ppA = num(sa.pp);
  const ppB = num(sb.pp);
  const gap = ppA != null && ppB != null ? Math.abs(ppA - ppB) : null;
  const gapLine = gap == null ? null : Math.round(gap) === 0 ? "Dead even on pp." : `${formatInt(gap)}pp apart.`;
  const nameA = ua.username ?? "Player 1";
  const nameB = ub.username ?? "Player 2";
  const embed: DiscordEmbed = {
    title: `${nameA} • ${nameB}`,
    color: OSU_PINK,
    description: (gapLine ? [...lines, "", gapLine] : lines).join("\n"),
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

// Help is a small hub: a row of category buttons swaps the body in place (no new
// message), and a primary button opens the link modal so the one bit of setup
// that needs typing happens in a popup, not a slash command with an argument.
export const HELP_CATEGORIES: Array<{ id: string; label: string }> = [
  { id: "start", label: "Start" },
  { id: "players", label: "Players" },
  { id: "browse", label: "Browse" },
  { id: "beatmaps", label: "Beatmaps" },
  { id: "feeds", label: "Feeds" },
];

function helpCategoryBody(category: string): { title: string; lines: string[] } {
  switch (category) {
    case "players":
      return {
        title: "Players",
        lines: [
          "Profiles, scores and head-to-heads. Leave the username off to use your linked account.",
          "",
          "`/me` your dashboard",
          "`/player [user]` profile card  •  `/maniacard [user]` skill card",
          "`/recent [user]` latest plays  •  `/activity [user]` playstyle  •  `/goals [user]`",
          "`/farm [user] [keys]` pp-gain picks",
          "`/vs [player1] <player2>` two players side by side",
          "`/pb [user]` your best score on the last map shown here (also `/c`, `/compare`)",
        ],
      };
    case "browse":
      return {
        title: "Browse",
        lines: [
          "Country and global boards. Country defaults to the home country, rankings to Global.",
          "",
          "`/rankings [country] [sort]` leaderboard",
          "`/top [country] [range] [keys]` notable top plays",
          "`/tracker [country]` latest live scores",
          "`/maps [country] [tab] [keys]` most farmed / played",
          "`/snipes [country]` recent leaderboard snipes",
          "`/randomfarm [filters]` a random popular farm map",
          "`/randomfav [filters]` a random favourited map",
        ],
      };
    case "beatmaps":
      return {
        title: "Beatmaps",
        lines: [
          "Paste a beatmap link or id. For dan and map use a difficulty id (the number after",
          "`#mania/` in a beatmapset URL), or the full URL and the bot resolves it.",
          "",
          "`/dan <beatmap>` dan-level estimate",
          "`/map <beatmap>` details, dan and farm value",
          "`/replay <score>` watch a replay in the browser",
        ],
      };
    case "feeds":
      return {
        title: "Server feeds",
        lines: [
          "Auto-post live events into a channel. Managing feeds needs the Manage Server permission.",
          "",
          "`/subscribe <feed> [country] [min_pp]` start a feed (top plays / snipes / new maps)",
          "`/unsubscribe <feed> [country]` stop one",
          "`/subscriptions` list this server's feeds",
        ],
      };
    default:
      return {
        title: BOT_NAME,
        lines: [
          "osu!mania stats, rankings and live feeds as slash commands.",
          "",
          "**1.** Tap **Link your osu! account** below (or run `/link <user>`).",
          "**2.** Now commands like `/recent`, `/me` and `/farm` default to you, no username needed.",
          "**3.** Type `/` in any channel, or use the buttons above to browse what the bot can do.",
          "",
          "`/whoami` check your link  •  `/unlink` remove it",
        ],
      };
  }
}

export function helpEmbed(siteOrigin: string, category = "start"): DiscordMessageBody {
  const { title, lines } = helpCategoryBody(category);
  const embed: DiscordEmbed = {
    title,
    url: siteOrigin,
    color: OSU_PINK,
    description: lines.join("\n"),
    footer: { text: BOT_NAME },
  };
  return {
    embeds: [embed],
    components: [
      helpNavRow(category, HELP_CATEGORIES),
      {
        type: 1,
        components: [
          { type: 2, style: 1, label: "Link your osu! account", custom_id: "mh|x|link" },
          { type: 2, style: 5, label: "Privacy", url: `${siteOrigin}/privacy` },
        ],
      },
    ],
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
    return `\`#${e.rank}\` **${e.user.username}**${place} **${formatInt(e.pp)}pp**`;
  });
  const scope = global ? "Global" : countryLabel(country);
  const embed: DiscordEmbed = {
    title: `${scope} mania rankings`,
    color: OSU_PINK,
    description: lines.length ? lines.join("\n") : "No ranked players found.",
    // Country boards show the flag; the global board shows its current #1.
    thumbnail: (() => {
      const flag = countryFlagThumb(country);
      if (flag) return { url: flag };
      return list[0] ? { url: osuAvatarUrl(list[0].user.id) ?? "" } : undefined;
    })(),
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
  snapshot: { username: string; userId: number; pp: number; keyMode: string; gainBasis?: string; recs: FarmRec[] },
  siteOrigin: string,
): DiscordMessageBody {
  const list = snapshot.recs.slice(0, 8);
  const lines = list.map((r, i) => {
    const mods = modsEmoji(r.recommendedMods ?? []);
    const name = truncate(`${r.artist} - ${r.title} [${r.version}]`, 80);
    const head = r.mapUrl ? `[${name}](${r.mapUrl})` : name;
    return `\`${i + 1}.\` ${head} ${mods} • **+${Math.round(r.estimatedPpGain)}pp**`;
  });
  const embed: DiscordEmbed = {
    author: { name: snapshot.username, url: snapshot.userId ? osuProfileUrl(snapshot.userId) : undefined, icon_url: osuAvatarUrl(snapshot.userId) },
    color: OSU_PINK,
    description: lines.length
      ? `**Farm picks**\n${lines.join("\n")}`
      : "No farm recommendations available right now.",
    footer: {
      // A keymode-scoped run measures gain in that keymode's variant pp, not
      // overall profile pp; say so next to the scope tag.
      text: snapshot.gainBasis === "keymode" && snapshot.keyMode !== "any"
        ? `${snapshot.keyMode.toUpperCase()} • gains in ${snapshot.keyMode.toUpperCase()} pp • ${BOT_NAME}`
        : `${snapshot.keyMode.toUpperCase()} • ${BOT_NAME}`,
    },
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

export interface DanBeatmapRef {
  id: number;
  url?: string;
  title?: string | null;
  version?: string | null;
}

export function danEmbed(
  beatmap: DanBeatmapRef,
  estimate: { displayName?: string; label?: string; family?: string; confidence?: number } | null,
  pending: boolean,
  siteOrigin: string,
): DiscordMessageBody {
  // Use the canonical beatmap URL when we have it (resolved from the API) and
  // only fall back to /b/<id>; the old code hand-built /b/<id> from whatever
  // number was typed, which 404s for a beatmapset id.
  const mapUrl = beatmap.url || `${OSU_BASE}/b/${beatmap.id}`;
  const heading = beatmap.title
    ? truncate(`${beatmap.title}${beatmap.version ? ` [${beatmap.version}]` : ""}`, 200)
    : "Dan estimate";
  const embed: DiscordEmbed = {
    title: heading,
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
      ? "Estimating this chart now, try again in a few seconds."
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
  tiebreaker: "Tournament",
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
      { label: "My Stats", url: `${siteOrigin}/my-stats` },
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
    author: { name: username, url: userId ? osuProfileUrl(userId) : undefined, icon_url: osuAvatarUrl(userId) },
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
  targetCount?: number | null;
  targetGrade: string | null;
  status: string;
  progress?: { pct: number | null; detail: string | null } | null;
}

function goalHeadline(goal: GoalLike): string {
  const acc = (value: number | null): string => (value == null ? "?" : `${(value <= 1 ? value * 100 : value).toFixed(2)}%`);
  switch (goal.kind) {
    case "reach_pp": return `Reach ${formatInt(goal.targetValue)}pp`;
    case "play_pp": return `Land a ${formatInt(goal.targetValue)}pp play`;
    case "play_pp_count": return `Have ${formatInt(goal.targetCount ?? 0)} ${formatInt(goal.targetValue)}pp+ plays`;
    case "accuracy": return `${acc(goal.targetValue)} on ${goal.beatmapLabel ?? "a map"}`;
    case "pass": return `Pass ${goal.beatmapLabel ?? "a map"}`;
    case "fc": return `FC ${goal.beatmapLabel ?? "a map"}`;
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
    author: { name: username, url: userId ? osuProfileUrl(userId) : undefined, icon_url: osuAvatarUrl(userId) },
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
  const mods = formatMods(score.mods);
  const acc = formatAcc(getDisplayedAccuracy(score));
  const pp = score.pp != null ? ` • **${formatPp(score.pp)}**` : "";
  return `${gradeEmoji(getDisplayedRank(score))} **${truncate(score.user?.username ?? "?", 18)}** ${head} ${mods} • ${acc}${pp}`;
}

export function trackerListEmbed(
  scores: LeanTrackerScore[],
  country: string | null,
  siteOrigin: string,
): DiscordMessageBody {
  const lines = scores.map(trackerScoreLine);
  const latestUser = scores[0]?.user;
  const trackerFlag = countryFlagThumb(country);
  const embed: DiscordEmbed = {
    title: `Latest scores in ${scopeLabel(country)}`,
    color: OSU_PINK,
    description: lines.length ? joinClamped(lines) : "No recent scores found.",
    thumbnail: trackerFlag ? { url: trackerFlag } : latestUser ? { url: latestUser.avatar_url || osuAvatarUrl(latestUser.id) || "" } : undefined,
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
  const cover = squareCover(set.covers);
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
    thumbnail: cover ? { url: cover } : undefined,
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
// Random map pickers (/randomfarm, /randomfav)
// ---------------------------------------------------------------------------

// A range like "5.20-6.40" for a multi-difficulty set, or a single value when
// the set has one mania difficulty (the common case). Hyphen, never a dash.
function formatStarRange(min: number | null | undefined, max: number | null | undefined): string {
  const lo = min != null && Number.isFinite(min) ? min : null;
  const hi = max != null && Number.isFinite(max) ? max : null;
  if (lo == null && hi == null) return "-";
  if (lo != null && hi != null && Math.abs(lo - hi) > 0.01) return `${lo.toFixed(2)}-${hi.toFixed(2)}★`;
  return `${(hi ?? lo ?? 0).toFixed(2)}★`;
}

interface RandomFarmLike {
  beatmapId: number;
  version?: string;
  difficultyRating?: number | null;
  cs?: number | null;
  bpm?: number | null;
  status?: string;
  title: string;
  artist: string;
  creator?: string;
  covers?: Record<string, string | undefined>;
  playerCount: number;
  avgPp: number;
  maxPp: number;
  dominantMod?: "DT" | "HT" | null;
}

export function randomFarmEmbed(map: RandomFarmLike, country: string | null, siteOrigin: string): DiscordMessageBody {
  const mapUrl = `${OSU_BASE}/b/${map.beatmapId}`;
  const cover = squareCover(map.covers);
  const fields = [
    { name: "Stars", value: map.difficultyRating != null ? `${map.difficultyRating.toFixed(2)}★` : "-", inline: true },
    { name: "Keys", value: map.cs != null ? `${Math.round(map.cs)}K` : "-", inline: true },
    { name: "BPM", value: map.bpm != null ? formatInt(map.bpm) : "-", inline: true },
    { name: "Status", value: map.status ? titleCase(map.status) : "-", inline: true },
    { name: "Avg pp", value: formatPp(map.avgPp), inline: true },
    { name: "Max pp", value: formatPp(map.maxPp), inline: true },
  ];
  const farmers = `${formatInt(map.playerCount)} ${map.playerCount === 1 ? "player farms" : "players farm"} this in ${scopeLabel(country)}`
    + (map.dominantMod ? `, mostly +${map.dominantMod}` : "");
  const embed: DiscordEmbed = {
    author: map.creator ? { name: `mapped by ${map.creator}` } : undefined,
    title: truncate(`${map.artist} - ${map.title} [${map.version ?? ""}]`, 240),
    url: mapUrl,
    color: OSU_PINK,
    description: `Random farm pick. ${farmers}.`,
    fields,
    thumbnail: cover ? { url: cover } : undefined,
    footer: { text: `${scopeLabel(country)} • ${BOT_NAME}` },
  };
  return {
    embeds: [embed],
    components: linkButtonRow([
      { label: "Beatmap", url: mapUrl },
      { label: "Farm detail", url: `${siteOrigin}/farm-helper/map/${map.beatmapId}` },
    ]),
  };
}

interface RandomFavLike {
  id: number;
  title: string;
  artist: string;
  creator?: string;
  status?: string;
  covers?: Record<string, string | undefined>;
  maniaKeys?: number[];
  starMin?: number | null;
  starMax?: number | null;
  bpm?: number | null;
  patterns?: string[];
  globalFavouriteCount?: number;
}

export function randomFavEmbed(
  set: RandomFavLike,
  pickedBy: string,
  scopeFavCount: number,
  country: string | null,
  siteOrigin: string,
): DiscordMessageBody {
  const setUrl = `${OSU_BASE}/beatmapsets/${set.id}#mania`;
  const cover = squareCover(set.covers) ?? setListCover(set.id);
  const keys = [...new Set((set.maniaKeys ?? []).map((k) => `${Math.round(k)}K`))];
  const patterns = (set.patterns ?? []).slice(0, 4).map(patternLabel);
  const fields = [
    { name: "Stars", value: formatStarRange(set.starMin, set.starMax), inline: true },
    { name: "Keys", value: keys.length ? keys.join(" ") : "-", inline: true },
    { name: "Status", value: set.status ? titleCase(set.status) : "-", inline: true },
    { name: "BPM", value: set.bpm != null ? formatInt(set.bpm) : "-", inline: true },
    { name: "Global favs", value: formatInt(set.globalFavouriteCount), inline: true },
    { name: "Patterns", value: patterns.length ? patterns.join(", ") : "-", inline: true },
  ];
  const others = Math.max(0, scopeFavCount - 1);
  const favNote = others > 0
    ? `Favourited by ${pickedBy} and ${formatInt(others)} other${others === 1 ? "" : "s"} in ${scopeLabel(country)}.`
    : `Favourited by ${pickedBy} in ${scopeLabel(country)}.`;
  const embed: DiscordEmbed = {
    author: set.creator ? { name: `mapped by ${set.creator}` } : undefined,
    title: truncate(`${set.artist} - ${set.title}`, 240),
    url: setUrl,
    color: OSU_PINK,
    description: `Random favourite pick. ${favNote}`,
    fields,
    thumbnail: cover ? { url: cover } : undefined,
    footer: { text: `${scopeLabel(country)} • ${BOT_NAME}` },
  };
  return {
    embeds: [embed],
    components: linkButtonRow([
      { label: "Beatmap", url: setUrl },
      { label: "Random maps", url: `${countryLink(siteOrigin, "/maps", country)}&tab=random` },
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
// New farm map alert (channel feed)
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
    // <t:..:R> renders client-side as a live "3 days ago", beating a frozen date.
    map.rankedAtMs != null ? `ranked <t:${Math.floor(map.rankedAtMs / 1000)}:R>` : "",
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
    thumbnail: (() => {
      const url = setListCover(map.beatmapsetId) ?? map.coverUrl ?? undefined;
      return url ? { url } : undefined;
    })(),
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

// ---------------------------------------------------------------------------
// Identity (small confirmation embeds)
// ---------------------------------------------------------------------------

export function whoamiEmbed(link: { osuUsername: string; osuUserId: number; countryCode: string | null }, siteOrigin: string): DiscordMessageBody {
  const embed: DiscordEmbed = {
    author: { name: link.osuUsername, url: osuProfileUrl(link.osuUserId), icon_url: osuAvatarUrl(link.osuUserId) },
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

// ---------------------------------------------------------------------------
// Plain helpers for simple text responses
// ---------------------------------------------------------------------------

export function errorBody(message: string): DiscordMessageBody {
  return { content: message, embeds: [], components: [], allowed_mentions: { parse: [] } };
}

export function noticeBody(message: string): DiscordMessageBody {
  return { content: message, embeds: [], components: [], allowed_mentions: { parse: [] } };
}

// Like errorBody, but with a one-click "Link your osu! account" button. Used
// when a command needs a linked account and none is set, so the fix is a button
// + modal instead of asking the user to type /link.
export function linkPromptBody(message: string): DiscordMessageBody {
  return { content: message, embeds: [], components: [linkAccountRow()], allowed_mentions: { parse: [] } };
}
