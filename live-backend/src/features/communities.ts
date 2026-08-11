import crypto from "node:crypto";
import type { InValue } from "@libsql/client";
import type { Db } from "../db.js";
import { exec } from "../db.js";
import { nowIso } from "../shared/score.js";
import { REGION_BY_CODE, isRegionCode } from "../regions.js";
import type { ResolvedInvite } from "../discord/invites.js";

/*
 * The /communities directory: osu!mania Discord servers, posted by the people
 * who run them.
 *
 * Two things carry the trust here, and neither is in this module. The submitter
 * proved through Discord's own OAuth that they own or manage the guild (frontend
 * src/lib/discord-auth-server.ts), and the server's identity came from Discord's
 * invite endpoint rather than from the form (discord/invites.ts). What is left
 * for this module is the pitch, the tags, the caps, and the review states.
 *
 * Unlike skins, nothing here publishes on submit: a row is born 'pending' and
 * only an admin's approval makes it readable by anyone else.
 */

export const COMMUNITY_MAX_PER_USER = 3;
export const COMMUNITY_PITCH_MAX_LENGTH = 1000;
export const COMMUNITY_REJECT_REASON_MAX_LENGTH = 200;
export const COMMUNITY_MAX_TAGS = 5;
export const COMMUNITY_TAG_MAX_LENGTH = 24;
/*
 * How many places one listing may name. Regions collapse whole continents into
 * one entry, so a list this long only happens when someone is picking countries
 * one at a time, and past a certain point that is a region.
 */
export const COMMUNITY_MAX_ACCESS_SCOPES = 40;
const COMMUNITY_LIST_MAX_PAGE_SIZE = 50;
// Enough to fill a filter row without turning it into a wall; the tail is long
// and mostly one-offs.
const COMMUNITY_TAG_FACET_LIMIT = 24;

// Mirrored in src/lib/communities-shared.ts on the frontend, which is only a
// convenience: this is the list that counts, because a client can send anything.
export const COMMUNITY_LANGUAGES = [
  "multi",
  "ar", "bg", "zh", "hr", "cs", "da", "nl", "en", "et", "fil", "fi", "fr",
  "de", "el", "he", "hi", "hu", "id", "it", "ja", "ko", "lv", "lt", "ms",
  "no", "fa", "pl", "pt", "ro", "ru", "sr", "sk", "es", "sv", "th", "tr",
  "uk", "vi", "other",
] as const;

export type CommunityLanguage = (typeof COMMUNITY_LANGUAGES)[number];

// A server that is not tied to one country says so explicitly rather than
// leaving the field empty, so "international" is a filter people can pick.
export const COMMUNITY_INTERNATIONAL = "INTL";

export type CommunityStatus = "pending" | "approved" | "rejected" | "hidden";

export type CommunitySort = "members" | "newest" | "name";

const COMMUNITY_ORDER_SQL: Record<CommunitySort, string> = {
  members: "member_count desc, created_at desc",
  newest: "created_at desc",
  name: "name collate nocase asc",
};

// -------------------------------------------------------------- who it is for

/*
 * A listing may name the places it is for: country codes and region codes mixed
 * freely (["FR"], ["R-CAMERICA"], ["FR", "BE"]), with an empty list meaning
 * everyone. A viewer matches when their own country is named or sits inside a
 * named region.
 *
 * A viewer with no country matches nothing. That is the safe direction: the way
 * past the lock is knowing where someone is, never failing to know.
 */
export function communityAllowsCountry(scopes: readonly string[], country: string | null | undefined): boolean {
  if (scopes.length === 0) return true;
  const code = normalizeScopeCode(country);
  if (!/^[A-Z]{2}$/.test(code)) return false;
  return scopes.some((scope) =>
    isRegionCode(scope) ? REGION_BY_CODE.get(scope)?.countries.includes(code) === true : scope === code,
  );
}

/** Every scope code a country falls under: itself, its subregion, its continent. */
export function scopesForCountry(country: string | null | undefined): string[] {
  const code = normalizeScopeCode(country);
  if (!/^[A-Z]{2}$/.test(code)) return [];
  const scopes = [code];
  for (const region of REGION_BY_CODE.values()) {
    if (region.countries.includes(code)) scopes.push(region.code);
  }
  return scopes;
}

export function normalizeAccessScopes(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const scopes: string[] = [];
  for (const entry of value) {
    if (typeof entry !== "string") continue;
    const code = normalizeScopeCode(entry);
    if (!isRegionCode(code) && !/^[A-Z]{2}$/.test(code)) continue;
    if (scopes.includes(code)) continue;
    scopes.push(code);
    if (scopes.length >= COMMUNITY_MAX_ACCESS_SCOPES) break;
  }
  return scopes;
}

function normalizeScopeCode(value: unknown): string {
  return typeof value === "string" ? value.trim().toUpperCase() : "";
}

/*
 * When a Discord server was made, out of the top bits of its id. Sent as its own
 * field because the id it comes from is not sent to everyone, and it is the only
 * thing the listing page ever wanted the id for. Discord's epoch, 2015-01-01.
 */
export function guildCreatedAtIso(guildId: string): string | null {
  if (!/^\d{1,20}$/.test(guildId)) return null;
  let value: bigint;
  try {
    value = BigInt(guildId);
  } catch {
    return null;
  }
  const millis = Number((value >> 22n) + 1420070400000n);
  // Before Discord existed, or years ahead of now: a malformed id rather than a
  // date worth printing.
  if (!Number.isFinite(millis) || millis < 1420070400000 || millis > Date.now() + 86_400_000) return null;
  return new Date(millis).toISOString();
}

export interface CommunityRow {
  id: string;
  guildId: string;
  inviteCode: string;
  name: string;
  iconHash: string | null;
  bannerHash: string | null;
  memberCount: number;
  onlineCount: number;
  // Discord's own three, refreshed by the sweep along with the counts.
  guildDescription: string | null;
  boostCount: number;
  features: string[];
  pitch: string;
  countryCode: string | null;
  language: string | null;
  tags: string[];
  // Empty for a server anyone may join; otherwise the places it is for, and
  // whether a viewer outside them sees it locked or not at all.
  accessScopes: string[];
  accessHidden: boolean;
  ownerUserId: number;
  ownerUsername: string;
  discordUserId: string;
  discordUsername: string;
  isGuildOwner: boolean;
  status: CommunityStatus;
  rejectReason: string | null;
  editedSinceReview: boolean;
  reviewedAt: string | null;
  approvedAt: string | null;
  inviteOk: boolean;
  inviteFailCount: number;
  inviteCheckedAt: string | null;
  inviteExpiresAt: string | null;
  createdAt: string;
  updatedAt: string;
}

/** What leaves the backend. Built only by toCommunitySummary. */
export interface CommunitySummary {
  id: string;
  /*
   * Withheld from anyone this server is not for, along with the two image URLs
   * that spell it out anyway.
   *
   * A guild id is not a way in by itself, but Discord answers
   * /guilds/<id>/widget.json to nobody in particular, and for a server with its
   * widget switched on that response carries instant_invite. Our own submit form
   * uses exactly that to find a server's invite (discord/invites.ts). So handing
   * out the id of a restricted server hands out a way past the restriction, for
   * some servers, and the page needs the id for one thing only: the date in it.
   */
  guildId?: string;
  /** When the server was made, read out of the snowflake rather than stored. */
  guildCreatedAt: string | null;
  name: string;
  // Null when the viewer's country is not one this server is for. Withheld
  // here rather than hidden by the page, so a restricted invite is not in the
  // response at all: not in the markup, not on a hover, not in a network tab.
  inviteUrl: string | null;
  iconUrl: string | null;
  bannerUrl: string | null;
  memberCount: number;
  onlineCount: number;
  // What Discord says about the server, for its listing page. Public on any
  // invite link, so no redaction to think about.
  guildDescription: string | null;
  boostCount: number;
  features: string[];
  pitch: string;
  countryCode: string | null;
  language: string | null;
  tags: string[];
  // Public: it is what the locked card says instead of Join, so someone who
  // cannot get in at least learns who the server is for.
  accessScopes: string[];
  ownerUserId: number;
  ownerUsername: string;
  createdAt: string;
  // Set only for the person asking, and only when they have a report open on
  // this listing. Nobody learns anything about anyone else's.
  viewerReported?: boolean;
  // Owner and admin only. A stranger has no business knowing a listing is
  // pending, why it was turned down, or that its invite went stale.
  status?: CommunityStatus;
  // Owner and admin only: everyone who can see a hidden listing is someone it
  // was not hidden from, so saying so would only ever be noise.
  accessHidden?: boolean;
  rejectReason?: string | null;
  inviteOk?: boolean;
  inviteExpiresAt?: string | null;
  editedSinceReview?: boolean;
  discordUsername?: string;
  isGuildOwner?: boolean;
}

/*
 * The one place a row becomes wire JSON, so redaction cannot be forgotten by a
 * route added later - the same chokepoint discipline toSkinSummary enforces.
 * It is also where the Discord CDN URLs get built, so an image size is one edit.
 */
export function toCommunitySummary(
  row: CommunityRow,
  options: {
    asOwner?: boolean;
    asAdmin?: boolean;
    viewerCountry?: string | null;
    // Whether the person reading this already flagged it, so the page can say
    // so instead of offering the button again.
    viewerReported?: boolean;
    // Set for a listing somebody flagged, which its status cannot say: an
    // approved listing with an open report is back in front of a moderator, so
    // it is theirs to decide again. Only ever set on a moderator's read.
    underReview?: boolean;
  } = {},
): CommunitySummary {
  const privileged = options.asOwner === true || options.asAdmin === true;
  /*
   * Who gets an invite to a server that named its places. The owner, always.
   * A moderator only while the listing is actually in front of them for a
   * decision - pending, turned down, taken down, or rewritten since its last
   * review - because joining it is part of deciding. Once it is approved and
   * settled, a moderator browsing sees the same lock as everyone else, which is
   * also what its card on the directory has been showing them all along.
   */
  const inReview = row.status !== "approved" || row.editedSinceReview || options.underReview === true;
  const mayJoin =
    options.asOwner === true ||
    (options.asAdmin === true && inReview) ||
    communityAllowsCountry(row.accessScopes, options.viewerCountry);
  const summary: CommunitySummary = {
    id: row.id,
    guildCreatedAt: guildCreatedAtIso(row.guildId),
    name: row.name,
    inviteUrl: mayJoin ? `https://discord.gg/${row.inviteCode}` : null,
    // Both of these have the guild id in the path, so a locked listing loses
    // its art rather than spelling out through a picture what the field above
    // is withholding. Only servers that named their places are ever plain, and
    // only to the people they are not for.
    iconUrl:
      mayJoin && row.iconHash
        ? `https://cdn.discordapp.com/icons/${row.guildId}/${row.iconHash}.png?size=128`
        : null,
    bannerUrl:
      mayJoin && row.bannerHash
        ? `https://cdn.discordapp.com/banners/${row.guildId}/${row.bannerHash}.png?size=512`
        : null,
    memberCount: row.memberCount,
    onlineCount: row.onlineCount,
    guildDescription: row.guildDescription,
    boostCount: row.boostCount,
    features: row.features,
    pitch: row.pitch,
    countryCode: row.countryCode,
    language: row.language,
    tags: row.tags,
    accessScopes: row.accessScopes,
    ownerUserId: row.ownerUserId,
    ownerUsername: row.ownerUsername,
    createdAt: row.createdAt,
  };
  if (mayJoin) summary.guildId = row.guildId;
  if (options.viewerReported === true) summary.viewerReported = true;
  if (privileged) {
    summary.accessHidden = row.accessHidden;
    summary.status = row.status;
    summary.rejectReason = row.rejectReason;
    summary.inviteOk = row.inviteOk;
    summary.inviteExpiresAt = row.inviteExpiresAt;
    summary.editedSinceReview = row.editedSinceReview;
  }
  if (options.asAdmin === true) {
    summary.discordUsername = row.discordUsername;
    summary.isGuildOwner = row.isGuildOwner;
  }
  return summary;
}

export function rowToCommunity(row: Record<string, unknown>): CommunityRow {
  return {
    id: String(row.id),
    guildId: String(row.guild_id),
    inviteCode: String(row.invite_code),
    name: String(row.name),
    iconHash: row.icon_hash == null ? null : String(row.icon_hash),
    bannerHash: row.banner_hash == null ? null : String(row.banner_hash),
    memberCount: Number(row.member_count ?? 0),
    onlineCount: Number(row.online_count ?? 0),
    guildDescription: row.guild_description == null ? null : String(row.guild_description),
    boostCount: Number(row.boost_count ?? 0),
    features: parseStringArray(row.features_json),
    pitch: String(row.pitch ?? ""),
    countryCode: row.country_code == null ? null : String(row.country_code),
    language: row.language == null ? null : String(row.language),
    tags: parseStringArray(row.tags_json),
    accessScopes: parseStringArray(row.access_scopes_json),
    accessHidden: Number(row.access_hidden ?? 0) === 1,
    ownerUserId: Number(row.owner_user_id ?? 0),
    ownerUsername: String(row.owner_username ?? ""),
    discordUserId: String(row.discord_user_id ?? ""),
    discordUsername: String(row.discord_username ?? ""),
    isGuildOwner: Number(row.is_guild_owner ?? 0) === 1,
    status: normalizeStatus(row.status),
    rejectReason: row.reject_reason == null ? null : String(row.reject_reason),
    editedSinceReview: Number(row.edited_since_review ?? 0) === 1,
    reviewedAt: row.reviewed_at == null ? null : String(row.reviewed_at),
    approvedAt: row.approved_at == null ? null : String(row.approved_at),
    inviteOk: Number(row.invite_ok ?? 1) === 1,
    inviteFailCount: Number(row.invite_fail_count ?? 0),
    inviteCheckedAt: row.invite_checked_at == null ? null : String(row.invite_checked_at),
    inviteExpiresAt: row.invite_expires_at == null ? null : String(row.invite_expires_at),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

// ---------------------------------------------------------------- reads

export interface CommunitiesListQuery {
  q?: string;
  page?: number;
  pageSize?: number;
  sort?: CommunitySort;
  country?: string;
  language?: string;
  tag?: string;
  // Where the person browsing is, which decides whether they see the listings
  // that hide themselves outside their own places. Forwarded by the frontend
  // from the osu!-verified viewer, never asserted by a browser.
  viewerCountry?: string | null;
}

/*
 * What is actually listed, so the page can offer only the countries and
 * languages that have servers behind them instead of a 250-entry dropdown that
 * is mostly dead ends. Counted over everything the current search matches, but
 * ignoring the country and language filters themselves, so switching between
 * them always stays possible.
 */
export interface CommunityFacet {
  value: string;
  count: number;
}

export interface CommunityFacets {
  countries: CommunityFacet[];
  languages: CommunityFacet[];
  tags: CommunityFacet[];
}

export interface CommunitiesListResult {
  communities: CommunitySummary[];
  total: number;
  page: number;
  pageSize: number;
  facets: CommunityFacets;
}

export async function listCommunities(db: Db, query: CommunitiesListQuery): Promise<CommunitiesListResult> {
  const page = Math.max(0, Math.floor(query.page ?? 0));
  const pageSize = Math.min(COMMUNITY_LIST_MAX_PAGE_SIZE, Math.max(1, Math.floor(query.pageSize ?? 24)));
  // A listing whose invite stopped resolving leaves the directory rather than
  // sending people at a dead link; its owner still sees it, through listMine.
  const where = ["status = 'approved'", "invite_ok = 1"];
  const args: InValue[] = [];

  const q = query.q?.trim().toLowerCase() ?? "";
  if (q) {
    where.push("search_text like ? escape '\\'");
    args.push(`%${escapeLike(q.slice(0, 80))}%`);
  }
  /*
   * A listing whose owner chose to hide it outside its own places is not in
   * anyone else's directory at all. Above the facet cut on purpose: it has to
   * be missing from the totals and the country facet too, or the page would
   * offer a filter that leads to an empty grid.
   *
   * The locked-but-visible kind is not touched here. It stays on the page and
   * loses its invite in the serializer instead.
   */
  const viewerScopes = scopesForCountry(query.viewerCountry);
  const scopeMatch = ["access_hidden = 0", "json_array_length(access_scopes_json) = 0"];
  for (const scope of viewerScopes) {
    // Matched against the quoted form inside the JSON array, the same way tags
    // are: scope codes are letters and dashes only, so "FR" cannot half-match
    // "FRA" and "R-EASIA" cannot match "R-EASIAX". Written as LIKE rather than
    // a json_each subquery because the facet query aliases this table, and a
    // correlated table-valued function would have to know which name it went by.
    scopeMatch.push("access_scopes_json like ? escape '\\'");
    args.push(`%"${escapeLike(scope)}"%`);
  }
  where.push(`(${scopeMatch.join(" or ")})`);
  // Everything above is the set the facets are counted over; the two filters
  // below narrow the page but must not narrow the choices offered.
  const facetWhereSql = where.join(" and ");
  const facetArgs = [...args];

  const country = normalizeCountry(query.country);
  if (country) {
    where.push("country_code = ?");
    args.push(country);
  }
  const language = normalizeLanguage(query.language);
  if (language) {
    where.push("language = ?");
    args.push(language);
  }
  // Tags are normalized to a charset with no quotes in it, so matching the
  // quoted form inside the JSON array cannot half-match a longer tag.
  const [tag] = normalizeTags(query.tag);
  if (tag) {
    where.push("tags_json like ? escape '\\'");
    args.push(`%"${escapeLike(tag)}"%`);
  }

  const whereSql = where.join(" and ");
  const orderSql = COMMUNITY_ORDER_SQL[query.sort ?? "members"] ?? COMMUNITY_ORDER_SQL.members;
  const totalRow = (await exec(db, `select count(*) as total from discord_communities where ${whereSql}`, args)).rows[0];
  const rows = (await exec(
    db,
    `select * from discord_communities where ${whereSql} order by ${orderSql} limit ? offset ?`,
    [...args, pageSize, page * pageSize],
  )).rows;

  return {
    communities: rows.map((row) =>
      toCommunitySummary(rowToCommunity(row as Record<string, unknown>), { viewerCountry: query.viewerCountry }),
    ),
    total: Number(totalRow?.total ?? 0),
    page,
    pageSize,
    facets: await listFacets(db, facetWhereSql, facetArgs),
  };
}

async function listFacets(db: Db, whereSql: string, args: InValue[]): Promise<CommunityFacets> {
  const read = async (column: string): Promise<CommunityFacet[]> => {
    const rows = (await exec(
      db,
      `select ${column} as value, count(*) as count from discord_communities
        where ${whereSql} and ${column} is not null and ${column} != ''
        group by ${column} order by count desc, value asc`,
      args,
    )).rows;
    return rows.map((row) => ({ value: String(row.value), count: Number(row.count ?? 0) }));
  };
  // One row per tag per listing, so counting is a plain group by over the
  // unnested array rather than anything the application has to fold itself.
  const tagRows = (await exec(
    db,
    `select tag.value as value, count(*) as count
       from discord_communities as c, json_each(c.tags_json) as tag
      where ${whereSql}
      group by tag.value order by count desc, value asc limit ?`,
    [...args, COMMUNITY_TAG_FACET_LIMIT],
  )).rows;
  return {
    countries: await read("country_code"),
    languages: await read("language"),
    tags: tagRows.map((row) => ({ value: String(row.value), count: Number(row.count ?? 0) })),
  };
}

/** Everything one person submitted, in any state, with the private fields on. */
export async function listCommunitiesForOwner(db: Db, ownerUserId: number): Promise<CommunitySummary[]> {
  if (!Number.isInteger(ownerUserId) || ownerUserId <= 0) return [];
  const rows = (await exec(
    db,
    "select * from discord_communities where owner_user_id = ? order by created_at desc",
    [ownerUserId],
  )).rows;
  return rows.map((row) => toCommunitySummary(rowToCommunity(row as Record<string, unknown>), { asOwner: true }));
}

export interface CommunityReviewQueue {
  pending: CommunitySummary[];
  edited: CommunitySummary[];
  // Listings someone flagged, minus any already standing in one of the two
  // lists above: a listing is on this page once, with its reports under it.
  reported: CommunitySummary[];
  // Open reports by listing id, for every card in any of the three lists.
  reports: Record<string, CommunityReport[]>;
}

/**
 * Pending rows first, then approved rows edited since their last review, then
 * anything the directory flagged, each card carrying the reports against it.
 */
export async function listReviewQueue(db: Db): Promise<CommunityReviewQueue> {
  const rows = (await exec(
    db,
    `select * from discord_communities
      where status = 'pending' or (status = 'approved' and edited_since_review = 1)
      order by created_at asc`,
  )).rows.map((row) => rowToCommunity(row as Record<string, unknown>));

  const reports = await listOpenCommunityReports(db);
  const byCommunity: Record<string, CommunityReport[]> = {};
  for (const report of reports) {
    (byCommunity[report.communityId] ??= []).push(report);
  }
  const waiting = new Set(rows.map((row) => row.id));
  const flaggedIds = Object.keys(byCommunity).filter((id) => !waiting.has(id));
  const flagged = flaggedIds.length === 0
    ? []
    : (await exec(
      db,
      `select * from discord_communities where id in (${flaggedIds.map(() => "?").join(", ")})`,
      flaggedIds,
    )).rows.map((row) => rowToCommunity(row as Record<string, unknown>));

  return {
    pending: rows.filter((row) => row.status === "pending").map((row) => toCommunitySummary(row, { asAdmin: true })),
    edited: rows.filter((row) => row.status === "approved").map((row) => toCommunitySummary(row, { asAdmin: true })),
    // Most-reported first: three people flagging the same listing is the one to
    // read before a single passing complaint. Each carries its invite even when
    // the server named places the moderator is not in: "go and look" is most of
    // what answering a report is.
    reported: flagged
      .sort((a, b) => (byCommunity[b.id]?.length ?? 0) - (byCommunity[a.id]?.length ?? 0))
      .map((row) => toCommunitySummary(row, { asAdmin: true, underReview: true })),
    reports: byCommunity,
  };
}

export async function getCommunityById(db: Db, id: string): Promise<CommunityRow | null> {
  const row = (await exec(db, "select * from discord_communities where id = ?", [id])).rows[0];
  return row ? rowToCommunity(row as Record<string, unknown>) : null;
}

export async function getCommunityByGuild(db: Db, guildId: string): Promise<CommunityRow | null> {
  const row = (await exec(db, "select * from discord_communities where guild_id = ?", [guildId])).rows[0];
  return row ? rowToCommunity(row as Record<string, unknown>) : null;
}

// ---------------------------------------------------------------- writes

export interface CommunityDetailsInput {
  pitch?: unknown;
  countryCode?: unknown;
  language?: unknown;
  tags?: unknown;
  accessScopes?: unknown;
  accessHidden?: unknown;
}

export interface CreateCommunityInput extends CommunityDetailsInput {
  invite: ResolvedInvite;
  ownerUserId: number;
  ownerUsername: string;
  discordUserId: string;
  discordUsername: string;
  isGuildOwner: boolean;
}

export type CommunityWriteError =
  | "not_found"
  | "forbidden"
  | "already_listed"
  | "limit_reached"
  | "empty_pitch";

export type CommunityWriteResult =
  | { ok: true; community: CommunitySummary }
  | { ok: false; error: CommunityWriteError };

export async function createCommunity(db: Db, input: CreateCommunityInput): Promise<CommunityWriteResult> {
  const pitch = cleanPitch(typeof input.pitch === "string" ? input.pitch : "", COMMUNITY_PITCH_MAX_LENGTH);
  if (pitch === "") return { ok: false, error: "empty_pitch" };

  // Checked before the insert for a clean message, and again by the unique index
  // underneath, which is what actually settles two concurrent submissions.
  const existing = await getCommunityByGuild(db, input.invite.guildId);
  if (existing) return { ok: false, error: "already_listed" };

  const mine = (await exec(
    db,
    "select count(*) as total from discord_communities where owner_user_id = ? and status != 'rejected'",
    [input.ownerUserId],
  )).rows[0];
  if (Number(mine?.total ?? 0) >= COMMUNITY_MAX_PER_USER) return { ok: false, error: "limit_reached" };

  const country = normalizeCountry(input.countryCode);
  const language = normalizeLanguage(input.language);
  const tags = normalizeTags(input.tags);
  const accessScopes = normalizeAccessScopes(input.accessScopes);
  // Hiding is a choice about a restricted listing, so it cannot outlive the
  // restriction: a server for everyone that is invisible to everyone is not a
  // state worth being able to reach.
  const accessHidden = accessScopes.length > 0 && input.accessHidden === true;
  const now = nowIso();
  const id = crypto.randomUUID();

  try {
    await exec(
      db,
      `insert into discord_communities (
         id, guild_id, invite_code, name, icon_hash, banner_hash, member_count, online_count,
         guild_description, boost_count, features_json,
         pitch, country_code, language, tags_json, search_text, invite_expires_at,
         access_scopes_json, access_hidden,
         owner_user_id, owner_username, discord_user_id, discord_username, is_guild_owner,
         status, created_at, updated_at
       ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)`,
      [
        id,
        input.invite.guildId,
        input.invite.code,
        input.invite.name,
        input.invite.iconHash,
        input.invite.bannerHash,
        input.invite.memberCount,
        input.invite.onlineCount,
        input.invite.description,
        input.invite.boostCount,
        JSON.stringify(input.invite.features),
        pitch,
        country,
        language,
        JSON.stringify(tags),
        searchText(input.invite.name, pitch, tags),
        input.invite.expiresAt,
        JSON.stringify(accessScopes),
        accessHidden ? 1 : 0,
        input.ownerUserId,
        input.ownerUsername,
        input.discordUserId,
        input.discordUsername,
        input.isGuildOwner ? 1 : 0,
        now,
        now,
      ],
    );
  } catch (error) {
    // The unique index on guild_id is the real guard against two people who both
    // run the server submitting at the same moment.
    if (isUniqueViolation(error)) return { ok: false, error: "already_listed" };
    throw error;
  }

  const created = await getCommunityById(db, id);
  if (!created) return { ok: false, error: "not_found" };
  return { ok: true, community: toCommunitySummary(created, { asOwner: true }) };
}

export interface UpdateCommunityInput extends CommunityDetailsInput {
  // Present only when the owner pasted a new invite, already re-resolved and
  // checked against this listing's guild by the route.
  invite?: ResolvedInvite;
}

export async function updateCommunity(
  db: Db,
  id: string,
  ownerUserId: number | null,
  input: UpdateCommunityInput,
): Promise<CommunityWriteResult> {
  const row = await getCommunityById(db, id);
  if (!row) return { ok: false, error: "not_found" };
  if (ownerUserId != null && row.ownerUserId !== ownerUserId) return { ok: false, error: "forbidden" };

  const pitch = cleanPitch(typeof input.pitch === "string" ? input.pitch : row.pitch, COMMUNITY_PITCH_MAX_LENGTH);
  if (pitch === "") return { ok: false, error: "empty_pitch" };
  const country = input.countryCode === undefined ? row.countryCode : normalizeCountry(input.countryCode);
  const language = input.language === undefined ? row.language : normalizeLanguage(input.language);
  const tags = input.tags === undefined ? row.tags : normalizeTags(input.tags);
  const accessScopes = input.accessScopes === undefined ? row.accessScopes : normalizeAccessScopes(input.accessScopes);
  const wantsHidden = input.accessHidden === undefined ? row.accessHidden : input.accessHidden === true;
  // Opening a listing back up to everyone drops the hiding with it, so nobody
  // ends up with a public server that half the directory cannot see.
  const accessHidden = accessScopes.length > 0 && wantsHidden;
  const name = input.invite?.name ?? row.name;

  /*
   * What an edit does to the review state, by where the listing stands:
   *  - approved stays visible and raises the edited flag, so a listing that was
   *    approved with a clean pitch and then rewritten shows up on the admin page.
   *  - rejected goes back to pending, since editing is how someone answers the
   *    reason they were turned down.
   *  - hidden stays hidden. An admin took it down on purpose.
   *  - pending stays pending.
   * A fresh invite also clears the dead-invite flag, which is how an owner
   * brings their own listing back without anyone's help.
   */
  const status: CommunityStatus = row.status === "rejected" ? "pending" : row.status;
  const editedSinceReview = row.status === "approved" ? 1 : 0;
  const rejectReason = row.status === "rejected" ? null : row.rejectReason;

  await exec(
    db,
    `update discord_communities set
       pitch = ?, country_code = ?, language = ?, tags_json = ?, search_text = ?, name = ?,
       access_scopes_json = ?, access_hidden = ?,
       invite_code = coalesce(?, invite_code),
       icon_hash = coalesce(?, icon_hash),
       banner_hash = coalesce(?, banner_hash),
       member_count = coalesce(?, member_count),
       online_count = coalesce(?, online_count),
       guild_description = case when ? is null then guild_description else ? end,
       boost_count = coalesce(?, boost_count),
       features_json = coalesce(?, features_json),
       invite_ok = case when ? is null then invite_ok else 1 end,
       invite_fail_count = case when ? is null then invite_fail_count else 0 end,
       invite_expires_at = case when ? is null then invite_expires_at else ? end,
       status = ?, reject_reason = ?, edited_since_review = ?, updated_at = ?
     where id = ?`,
    [
      pitch,
      country,
      language,
      JSON.stringify(tags),
      searchText(name, pitch, tags),
      name,
      JSON.stringify(accessScopes),
      accessHidden ? 1 : 0,
      input.invite?.code ?? null,
      input.invite?.iconHash ?? null,
      input.invite?.bannerHash ?? null,
      input.invite?.memberCount ?? null,
      input.invite?.onlineCount ?? null,
      // Guarded on the invite rather than on the value: a server that cleared
      // its own description should have it cleared here too, and a null from a
      // no-invite edit must not do that.
      input.invite ? input.invite.code : null,
      input.invite?.description ?? null,
      input.invite?.boostCount ?? null,
      input.invite ? JSON.stringify(input.invite.features) : null,
      input.invite?.code ?? null,
      input.invite?.code ?? null,
      input.invite?.code ?? null,
      input.invite?.expiresAt ?? null,
      status,
      rejectReason,
      editedSinceReview,
      nowIso(),
      id,
    ],
  );

  const updated = await getCommunityById(db, id);
  if (!updated) return { ok: false, error: "not_found" };
  return { ok: true, community: toCommunitySummary(updated, { asOwner: true }) };
}

/**
 * Owner delete. `ownerUserId` of null is an admin, who skips the check.
 * A mismatched id is reported as not_found rather than forbidden, so a stranger
 * cannot use this to learn which listing ids exist.
 */
export async function deleteCommunity(db: Db, id: string, ownerUserId: number | null): Promise<boolean> {
  const row = await getCommunityById(db, id);
  if (!row) return false;
  if (ownerUserId != null && row.ownerUserId !== ownerUserId) return false;
  await exec(db, "delete from discord_communities where id = ?", [id]);
  // Reports are about a listing and mean nothing without it, so they go with
  // it. Nothing here cascades on its own; SQLite foreign keys are off.
  await exec(db, "delete from discord_community_reports where community_id = ?", [id]);
  return true;
}

export type CommunityReviewAction = "approve" | "reject" | "hide" | "unhide";

export async function reviewCommunity(
  db: Db,
  id: string,
  action: CommunityReviewAction,
  reason?: string,
): Promise<CommunityWriteResult> {
  const row = await getCommunityById(db, id);
  if (!row) return { ok: false, error: "not_found" };
  const now = nowIso();

  if (action === "reject") {
    await exec(
      db,
      `update discord_communities set status = 'rejected', reject_reason = ?, reviewed_at = ?,
         edited_since_review = 0, updated_at = ? where id = ?`,
      [cleanText(reason ?? "", COMMUNITY_REJECT_REASON_MAX_LENGTH) || null, now, now, id],
    );
  } else if (action === "hide") {
    await exec(
      db,
      "update discord_communities set status = 'hidden', reviewed_at = ?, edited_since_review = 0, updated_at = ? where id = ?",
      [now, now, id],
    );
  } else {
    // approve and unhide are the same transition; approved_at is stamped once so
    // it keeps meaning "when this first went live".
    await exec(
      db,
      `update discord_communities set status = 'approved', reject_reason = null, reviewed_at = ?,
         approved_at = coalesce(approved_at, ?), edited_since_review = 0, updated_at = ? where id = ?`,
      [now, now, now, id],
    );
  }

  const updated = await getCommunityById(db, id);
  if (!updated) return { ok: false, error: "not_found" };
  return { ok: true, community: toCommunitySummary(updated, { asAdmin: true }) };
}

// ---------------------------------------------------------------- reports

/*
 * Flagging a listing.
 *
 * The directory is people posting their own servers, so the thing that keeps it
 * honest after approval is everyone who reads it. A report is a message to a
 * moderator and to nobody else: the listing's owner never sees one, and no
 * count of them shows on a card, because a public flag counter is a weapon
 * rather than a signal.
 *
 * Nothing about a report changes what the directory shows. It puts the listing
 * back in front of a moderator, and the decision they make is what does.
 *
 * The ceilings here are structural, the way goat-poll reasons about it: an osu!
 * login behind every write, one row per person per listing (so reporting twice
 * is still one voice), and a cap on how many one account may have open at once.
 */

export const COMMUNITY_REPORT_REASONS = ["misleading", "dead", "spam", "harmful", "other"] as const;
export type CommunityReportReason = (typeof COMMUNITY_REPORT_REASONS)[number];

export const COMMUNITY_REPORT_DETAILS_MAX_LENGTH = 500;
/*
 * How many listings one account may have flagged and unread at once. Not about
 * rate: it is what stops a single account from flagging the whole directory
 * into the review page. Clearing comes free, because a moderator deciding
 * anything about a listing resolves its reports.
 */
export const COMMUNITY_MAX_OPEN_REPORTS_PER_USER = 10;
// A moderator reading 500 open reports has a different problem than paging.
const COMMUNITY_REPORT_QUEUE_LIMIT = 500;

export interface CommunityReport {
  id: string;
  communityId: string;
  reporterUserId: number;
  reporterUsername: string;
  reason: CommunityReportReason;
  details: string;
  createdAt: string;
}

export type CommunityReportError = "not_found" | "own_listing" | "too_many_reports";

export interface ReportCommunityInput {
  communityId: string;
  reporterUserId: number;
  reporterUsername: string;
  reason?: unknown;
  details?: unknown;
}

export async function reportCommunity(
  db: Db,
  input: ReportCommunityInput,
): Promise<{ ok: true } | { ok: false; error: CommunityReportError }> {
  const row = await getCommunityById(db, input.communityId);
  if (!row) return { ok: false, error: "not_found" };
  // Reporting your own listing is either a mistake or a way to summon a
  // moderator, and the owner already has an edit button and a delete one.
  if (row.ownerUserId === input.reporterUserId) return { ok: false, error: "own_listing" };

  const open = (await exec(
    db,
    "select count(*) as total from discord_community_reports where reporter_user_id = ? and status = 'open' and community_id != ?",
    [input.reporterUserId, row.id],
  )).rows[0];
  if (Number(open?.total ?? 0) >= COMMUNITY_MAX_OPEN_REPORTS_PER_USER) {
    return { ok: false, error: "too_many_reports" };
  }

  const now = nowIso();
  await exec(
    db,
    `insert into discord_community_reports (
       id, community_id, reporter_user_id, reporter_username, reason, details, status, created_at, updated_at
     ) values (?, ?, ?, ?, ?, ?, 'open', ?, ?)
     on conflict(community_id, reporter_user_id) do update set
       reporter_username = excluded.reporter_username,
       reason = excluded.reason,
       details = excluded.details,
       -- Sending a second one reopens the first rather than adding a row, so a
       -- listing that was looked at and left up can be flagged again later.
       status = 'open',
       resolved_at = null,
       resolved_by = null,
       updated_at = excluded.updated_at`,
    [
      crypto.randomUUID(),
      row.id,
      input.reporterUserId,
      cleanText(input.reporterUsername, 32),
      normalizeReportReason(input.reason),
      cleanText(typeof input.details === "string" ? input.details : "", COMMUNITY_REPORT_DETAILS_MAX_LENGTH),
      now,
      now,
    ],
  );
  return { ok: true };
}

/** Whether anyone has flagged this listing and nobody has answered it yet. */
export async function communityHasOpenReports(db: Db, communityId: string): Promise<boolean> {
  if (!communityId) return false;
  const row = (await exec(
    db,
    "select 1 as hit from discord_community_reports where community_id = ? and status = 'open' limit 1",
    [communityId],
  )).rows[0];
  return row != null;
}

/** Whether this person has a report standing against this listing right now. */
export async function hasOpenCommunityReport(db: Db, communityId: string, userId: number): Promise<boolean> {
  if (!communityId || !Number.isInteger(userId) || userId <= 0) return false;
  const row = (await exec(
    db,
    "select 1 as hit from discord_community_reports where community_id = ? and reporter_user_id = ? and status = 'open'",
    [communityId, userId],
  )).rows[0];
  return row != null;
}

export async function listOpenCommunityReports(db: Db): Promise<CommunityReport[]> {
  const rows = (await exec(
    db,
    `select * from discord_community_reports where status = 'open'
      order by created_at asc limit ?`,
    [COMMUNITY_REPORT_QUEUE_LIMIT],
  )).rows;
  return rows.map((row) => ({
    id: String(row.id),
    communityId: String(row.community_id),
    reporterUserId: Number(row.reporter_user_id ?? 0),
    reporterUsername: String(row.reporter_username ?? ""),
    reason: normalizeReportReason(row.reason),
    details: String(row.details ?? ""),
    createdAt: String(row.created_at),
  }));
}

/**
 * Marks a listing's open reports as read, which every review decision does: the
 * decision is the answer to them. Kept as a record rather than deleted, so
 * "this was flagged once and left up" is still knowable.
 */
export async function resolveCommunityReports(db: Db, communityId: string, moderatorUserId: number | null): Promise<number> {
  const now = nowIso();
  const result = await exec(
    db,
    `update discord_community_reports set status = 'resolved', resolved_at = ?, resolved_by = ?, updated_at = ?
      where community_id = ? and status = 'open'`,
    [now, moderatorUserId, now, communityId],
  );
  return Number(result.rowsAffected ?? 0);
}

function normalizeReportReason(value: unknown): CommunityReportReason {
  const reason = typeof value === "string" ? value.trim().toLowerCase() : "";
  return (COMMUNITY_REPORT_REASONS as readonly string[]).includes(reason)
    ? (reason as CommunityReportReason)
    : "other";
}

// ---------------------------------------------------------------- refresh

/** Approved listings whose invite has not been checked since `cutoffIso`. */
export async function claimCommunitiesForRefresh(db: Db, cutoffIso: string, limit: number): Promise<CommunityRow[]> {
  const rows = (await exec(
    db,
    `select * from discord_communities
      where status = 'approved' and (invite_checked_at is null or invite_checked_at < ?)
      order by invite_checked_at asc limit ?`,
    [cutoffIso, Math.max(1, Math.floor(limit))],
  )).rows;
  return rows.map((row) => rowToCommunity(row as Record<string, unknown>));
}

/** A check that resolved: refresh what Discord reports and clear the failures. */
export async function applyInviteRefresh(
  db: Db,
  id: string,
  invite: ResolvedInvite,
  pitch: string,
  tags: string[] = [],
): Promise<void> {
  await exec(
    db,
    `update discord_communities set
       name = ?, icon_hash = ?, banner_hash = ?, member_count = ?, online_count = ?,
       guild_description = ?, boost_count = ?, features_json = ?,
       search_text = ?, invite_ok = 1, invite_fail_count = 0, invite_expires_at = ?,
       invite_checked_at = ?, updated_at = ?
     where id = ?`,
    [
      invite.name,
      invite.iconHash,
      invite.bannerHash,
      invite.memberCount,
      invite.onlineCount,
      invite.description,
      invite.boostCount,
      JSON.stringify(invite.features),
      searchText(invite.name, pitch, tags),
      invite.expiresAt,
      nowIso(),
      nowIso(),
      id,
    ],
  );
}

/**
 * A check that did not resolve. Counts the failure, and once it has failed
 * `failLimit` times in a row drops the listing out of the directory. Nothing is
 * deleted: the owner still sees it, with a warning, and one good check restores
 * it on its own.
 */
export async function applyInviteFailure(db: Db, id: string, failLimit: number): Promise<boolean> {
  const now = nowIso();
  await exec(
    db,
    `update discord_communities set
       invite_fail_count = invite_fail_count + 1,
       invite_ok = case when invite_fail_count + 1 >= ? then 0 else invite_ok end,
       invite_checked_at = ?, updated_at = ?
     where id = ?`,
    [Math.max(1, Math.floor(failLimit)), now, now, id],
  );
  const row = await getCommunityById(db, id);
  return row?.inviteOk === false;
}

// ---------------------------------------------------------------- normalizing

function normalizeStatus(value: unknown): CommunityStatus {
  const status = String(value ?? "pending");
  return status === "approved" || status === "rejected" || status === "hidden" ? status : "pending";
}

export function normalizeCountry(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const upper = value.trim().toUpperCase();
  if (upper === COMMUNITY_INTERNATIONAL) return COMMUNITY_INTERNATIONAL;
  return /^[A-Z]{2}$/.test(upper) ? upper : null;
}

export function normalizeLanguage(value: unknown): CommunityLanguage | null {
  if (typeof value !== "string") return null;
  const lower = value.trim().toLowerCase();
  return (COMMUNITY_LANGUAGES as readonly string[]).includes(lower) ? (lower as CommunityLanguage) : null;
}

export function normalizeSort(value: unknown): CommunitySort {
  return value === "newest" || value === "name" ? value : "members";
}

/*
 * Owner-typed tags, cleaned into something safe to store, match and show.
 *
 * Free text rather than a vocabulary, so this is the only thing standing between
 * the form and the filter row: lowercase, a charset with no quotes or wildcards
 * in it (which is what lets the LIKE match on the JSON array be exact), deduped,
 * and capped. Accepts an array or a comma-separated string, because the form
 * sends one and a URL sends the other.
 *
 * Mirrored loosely in src/lib/communities-shared.ts for the input UI; this copy
 * is the one that decides what gets stored.
 */
export function normalizeTags(value: unknown): string[] {
  const raw = Array.isArray(value)
    ? value
    : typeof value === "string"
      ? value.split(",")
      : [];
  const out: string[] = [];
  for (const entry of raw) {
    if (typeof entry !== "string") continue;
    const tag = entry
      .toLowerCase()
      .replace(/[^a-z0-9 +&#-]/g, " ")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, COMMUNITY_TAG_MAX_LENGTH)
      .trim();
    if (tag === "" || out.includes(tag)) continue;
    out.push(tag);
    if (out.length >= COMMUNITY_MAX_TAGS) break;
  }
  return out;
}

function parseStringArray(value: unknown): string[] {
  if (typeof value !== "string" || value === "") return [];
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.filter((entry): entry is string => typeof entry === "string") : [];
  } catch {
    return [];
  }
}

/**
 * What an invite looks like before anything is stored: the same identity a card
 * would show, so the submit form can preview the real server instead of echoing
 * back what was typed. Built here so the CDN URLs have exactly one source.
 */
export function invitePreview(invite: ResolvedInvite) {
  return {
    guildId: invite.guildId,
    name: invite.name,
    inviteUrl: `https://discord.gg/${invite.code}`,
    iconUrl: invite.iconHash ? `https://cdn.discordapp.com/icons/${invite.guildId}/${invite.iconHash}.png?size=128` : null,
    bannerUrl: invite.bannerHash ? `https://cdn.discordapp.com/banners/${invite.guildId}/${invite.bannerHash}.png?size=512` : null,
    memberCount: invite.memberCount,
    onlineCount: invite.onlineCount,
    expiresAt: invite.expiresAt,
  };
}

function searchText(name: string, pitch: string, tags: string[] = []): string {
  return `${name} ${pitch} ${tags.join(" ")}`.toLowerCase().slice(0, 1400);
}

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (char) => `\\${char}`);
}

// Stored and rendered as plain text and never as HTML, so this is about control
// characters and length rather than markup.
function cleanText(value: string, maxLength: number): string {
  // eslint-disable-next-line no-control-regex
  return value.replace(/[\x00-\x1f\x7f]/g, " ").replace(/\s+/g, " ").trim().slice(0, maxLength).trim();
}

/*
 * The same, but paragraphs survive. A description long enough to need them
 * (they run to 1000 characters) reads as one wall of text otherwise, and the
 * card renders it with whitespace-pre-line. Runs of blank lines collapse to one,
 * so nobody can space their listing into taking over the grid.
 */
function cleanPitch(value: string, maxLength: number): string {
  return value
    .replace(/\r\n?/g, "\n")
    // eslint-disable-next-line no-control-regex
    .replace(/[\x00-\x09\x0b-\x1f\x7f]/g, " ")
    .replace(/[ \t]+/g, " ")
    .split("\n")
    .map((line) => line.trim())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim()
    .slice(0, maxLength)
    .trim();
}

function isUniqueViolation(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return message.toUpperCase().includes("UNIQUE constraint failed".toUpperCase());
}
