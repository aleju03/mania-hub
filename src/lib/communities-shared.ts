import type { AuthState } from "./auth-shared";
import { canUseAdminFeatures } from "./auth-shared";
import { getCountryName } from "./country";
import { getRegionDef } from "./regions";

/*
 * Shared vocabulary and the access gates for the /communities directory.
 *
 * Isomorphic on purpose: the route, the nav and the server functions all need
 * the same answer to "can this person see communities" and "can they review
 * one". The backend re-validates everything it is sent
 * (live-backend/src/features/communities.ts); these lists are what the UI draws.
 */

/*
 * The directory ships hidden. Only the people listed here and the moderators
 * below reach /communities at all, until it is opened up deliberately.
 *
 * Deliberately not canUseDevFeatures, which is only honoured on localhost and
 * ninja.mania-tracker.com and would force an early tester onto the dev host.
 * This is checked against the signed-in osu! id, so it works on the real site,
 * and it grants exactly this feature rather than every dev-gated page.
 */
export const COMMUNITY_EARLY_ACCESS_USER_IDS: readonly number[] = [
  // The site owner. Already an admin, but admin-ness is only honoured on
  // localhost and ninja.mania-tracker.com, and "I can see it" should hold on
  // the real site too.
  7095193,
  // Early tester, merlin69420.
  15801489,
];

/*
 * Who may review submitted servers: a hand-kept list, the same shape as
 * SKIN_KEYMODE_MODERATOR_USER_IDS in skins.ts. These people are not site
 * admins and get nothing else - the review queue is reached from the directory
 * itself rather than from /admin, so moderating communities never implies
 * access to anything else.
 *
 * Edit this list to add or remove a moderator; it ships with a deploy rather
 * than living in an env var, so the change is reviewable in the diff.
 */
export const COMMUNITY_MODERATOR_USER_IDS: readonly number[] = [
  7095193,
  // merlin69420, also on the early-access list above. Being on this one is
  // enough to see the directory on its own, so the entry there is what keeps
  // the two answers separate: dropping them as a moderator would leave the
  // access they were given as a tester.
  15801489,
];

export function canUseCommunities(auth: AuthState | undefined | null): boolean {
  if (canUseAdminFeatures(auth)) return true;
  const viewerId = auth?.viewer?.id;
  if (typeof viewerId !== "number") return false;
  return COMMUNITY_EARLY_ACCESS_USER_IDS.includes(viewerId) || COMMUNITY_MODERATOR_USER_IDS.includes(viewerId);
}

/*
 * The same gate for callers that only have an osu! id, not a full AuthState:
 * the OAuth entry route runs outside the server-function context, so it cannot
 * build one. Deliberately without the canUseAdminFeatures branch, which means a
 * locally signed-in account that is not on either list can open the page but not
 * start a Discord connection. That asymmetry only exists in local dev, and it
 * errs toward not showing anyone an authorise-Mania-Hub screen they have no use
 * for.
 */
export function communityAccessAllowsUserId(userId: number | null | undefined): boolean {
  if (typeof userId !== "number") return false;
  return COMMUNITY_EARLY_ACCESS_USER_IDS.includes(userId) || COMMUNITY_MODERATOR_USER_IDS.includes(userId);
}

export function canModerateCommunities(auth: AuthState | undefined | null): boolean {
  // Local dev and a true admin pass so the queue is reachable while working on
  // it; everyone else has to be on the list by name.
  if (canUseAdminFeatures(auth)) return true;
  const viewerId = auth?.viewer?.id;
  return typeof viewerId === "number" && COMMUNITY_MODERATOR_USER_IDS.includes(viewerId);
}

/*
 * The languages a server can say it speaks. Mirrored in
 * live-backend/src/features/communities.ts, which is the list that decides.
 *
 * "any language" leads, the way "international" leads the country picker and
 * for the same reason: plenty of servers do not run in one language, and the
 * honest answer to that should be a thing you can pick and filter on rather
 * than a field left blank. Labelled with the noun rather than a bare "any"
 * because the same string is a chip on the card, sitting in the row with the
 * tags. The rest is alphabetical by label with "other" last,
 * because the picker searches and a predictable order beats a guess at which
 * scenes are biggest. Wide rather than short on purpose: a list that leaves out
 * someone's language reads as being told their server does not count, and one
 * dead entry costs nothing.
 */
export const COMMUNITY_LANGUAGES = [
  "multi",
  "ar", "bg", "zh", "hr", "cs", "da", "nl", "en", "et", "fil", "fi", "fr",
  "de", "el", "he", "hi", "hu", "id", "it", "ja", "ko", "lv", "lt", "ms",
  "no", "fa", "pl", "pt", "ro", "ru", "sr", "sk", "es", "sv", "th", "tr",
  "uk", "vi", "other",
] as const;
export type CommunityLanguage = (typeof COMMUNITY_LANGUAGES)[number];

export const COMMUNITY_LANGUAGE_LABELS: Record<CommunityLanguage, string> = {
  multi: "any language",
  ar: "Arabic",
  bg: "Bulgarian",
  zh: "Chinese",
  hr: "Croatian",
  cs: "Czech",
  da: "Danish",
  nl: "Dutch",
  en: "English",
  et: "Estonian",
  fil: "Filipino",
  fi: "Finnish",
  fr: "French",
  de: "German",
  el: "Greek",
  he: "Hebrew",
  hi: "Hindi",
  hu: "Hungarian",
  id: "Indonesian",
  it: "Italian",
  ja: "Japanese",
  ko: "Korean",
  lv: "Latvian",
  lt: "Lithuanian",
  ms: "Malay",
  no: "Norwegian",
  fa: "Persian",
  pl: "Polish",
  pt: "Portuguese",
  ro: "Romanian",
  ru: "Russian",
  sr: "Serbian",
  sk: "Slovak",
  es: "Spanish",
  sv: "Swedish",
  th: "Thai",
  tr: "Turkish",
  uk: "Ukrainian",
  vi: "Vietnamese",
  other: "other",
};

export function communityLanguageLabel(code: string | null | undefined): string | null {
  if (!code) return null;
  return COMMUNITY_LANGUAGE_LABELS[code as CommunityLanguage] ?? code;
}

// A server that belongs to no single country says so rather than leaving the
// field blank, so "international" is something people can filter on.
export const COMMUNITY_INTERNATIONAL = "INTL";

export const COMMUNITY_PITCH_MAX_LENGTH = 1000;
export const COMMUNITY_MAX_PER_USER = 3;
export const COMMUNITIES_PAGE_SIZE = 24;
export const COMMUNITY_MAX_TAGS = 5;
export const COMMUNITY_TAG_MAX_LENGTH = 24;

/*
 * Tags are typed by whoever posts the server rather than picked from a list, so
 * they need cleaning before they become a filter everyone else sees. This is the
 * copy the input box uses, to show what will actually be stored as it is typed;
 * normalizeTags in live-backend/src/features/communities.ts is the one that
 * decides, and a client can send anything.
 */
export function normalizeCommunityTag(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9 +&#-]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, COMMUNITY_TAG_MAX_LENGTH)
    .trim();
}

export type CommunityStatus = "pending" | "approved" | "rejected" | "hidden";
export type CommunitySort = "members" | "newest" | "name";

export interface CommunitySummary {
  id: string;
  /*
   * Absent for a server you are not one of the places for. Not sensitive in
   * itself, but Discord answers /guilds/<id>/widget.json to anyone, and for a
   * server with its widget on that carries an invite - so for those servers the
   * id is the restriction, worked around.
   */
  guildId?: string;
  /** When the server was made. The backend reads it out of the guild id. */
  guildCreatedAt?: string | null;
  name: string;
  // Null when this server is not for where you are. The backend leaves it out
  // of the response entirely rather than trusting the page to hide it, so a
  // restricted invite is not in the markup or on a hover either.
  inviteUrl: string | null;
  /*
   * The server's own art whenever it has any, even on a card you cannot join.
   * A cdn.discordapp.com link when you can, and a /api/community-image path when
   * you cannot, since the CDN one carries the guild id above. Both are just an
   * <img src> to the page.
   */
  iconUrl: string | null;
  bannerUrl: string | null;
  memberCount: number;
  onlineCount: number;
  // Discord's own three, for the listing's page. Optional at the type level
  // because a row listed before they were stored carries them only after its
  // next refresh.
  guildDescription?: string | null;
  boostCount?: number;
  features?: string[];
  pitch: string;
  countryCode: string | null;
  language: string | null;
  tags: string[];
  // The places this server is for, empty meaning everyone. Public, because it
  // is what a locked card says in place of Join. Optional at the type level for
  // rows that were listed before the field existed.
  accessScopes?: string[];
  ownerUserId: number;
  ownerUsername: string;
  createdAt: string;
  // Whether you already flagged this one, so its page says so instead of
  // offering the button again. Only ever about the person reading.
  viewerReported?: boolean;
  // Owner and moderator reads only.
  accessHidden?: boolean;
  status?: CommunityStatus;
  rejectReason?: string | null;
  inviteOk?: boolean;
  inviteExpiresAt?: string | null;
  editedSinceReview?: boolean;
  discordUsername?: string;
  isGuildOwner?: boolean;
}

/*
 * What is actually listed, so the filter rows can offer only the countries and
 * languages that have servers behind them. A directory of a dozen servers has
 * no business showing a 250-entry country dropdown, and a filter that can only
 * ever return nothing is not worth drawing.
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

/**
 * What an invite resolves to before anything is posted, so the form can show
 * the real server rather than the link that was typed.
 */
export interface CommunityInvitePreview {
  guildId: string;
  name: string;
  inviteUrl: string;
  iconUrl: string | null;
  bannerUrl: string | null;
  memberCount: number;
  onlineCount: number;
  // ISO instant, or null for a permanent invite. Warned about rather than
  // refused: the sweep already retires a listing whose link stops working.
  expiresAt: string | null;
}

export interface CommunitiesListResult {
  communities: CommunitySummary[];
  total: number;
  page: number;
  pageSize: number;
  facets: CommunityFacets;
}

/** One server the signed-in Discord account owns or can manage. */
export interface ManageableGuild {
  id: string;
  name: string;
  iconUrl: string | null;
  memberCount: number | null;
  owner: boolean;
}

// What the submit modal says when the backend refuses something. Every one of
// these is fixable by the person reading it, so they read as instructions.
export const COMMUNITY_ERROR_MESSAGES: Record<string, string> = {
  invalid_url: "That does not look like a Discord invite link.",
  unknown_invite: "Discord does not recognise that invite. Check it is still valid.",
  guild_mismatch: "That invite is for a different server than the one you picked.",
  lookup_failed: "Could not reach Discord to check that invite. Try again in a moment.",
  already_listed: "That server is already listed.",
  limit_reached: `You can list up to ${COMMUNITY_MAX_PER_USER} servers.`,
  empty_pitch: "Write a short description of the server.",
  forbidden: "That listing is not yours.",
  not_found: "That listing no longer exists.",
  no_discord: "Connect your Discord account first.",
  no_access: "This page is not open yet.",
  own_listing: "That is your own listing.",
  too_many_reports: "You have a few reports waiting to be read already. Give a moderator a chance to catch up.",
};

/* ------------------------------------------------------------- flagging one
 *
 * What someone browsing can say about a listing, sent to the moderators and to
 * nobody else. Mirrored in live-backend/src/features/communities.ts, which is
 * the copy that decides; anything else stored reads back as "other".
 *
 * Five, phrased as the complaint rather than as a rule that was broken: this is
 * a directory of Discord servers, not a court, and a moderator reading these
 * wants to know what to go and look at.
 */
export const COMMUNITY_REPORT_REASONS = ["misleading", "dead", "spam", "harmful", "other"] as const;
export type CommunityReportReason = (typeof COMMUNITY_REPORT_REASONS)[number];

export const COMMUNITY_REPORT_REASON_LABELS: Record<CommunityReportReason, string> = {
  misleading: "Not the server it says it is",
  dead: "Dead server, or the invite does not work",
  spam: "Spam or advertising",
  harmful: "Harmful, hateful or a scam",
  other: "Something else",
};

export function communityReportReasonLabel(reason: string): string {
  return COMMUNITY_REPORT_REASON_LABELS[reason as CommunityReportReason] ?? COMMUNITY_REPORT_REASON_LABELS.other;
}

export const COMMUNITY_REPORT_DETAILS_MAX_LENGTH = 500;

/** One person's report on one listing, as the review page reads it. */
export interface CommunityReport {
  id: string;
  communityId: string;
  reporterUserId: number;
  reporterUsername: string;
  reason: string;
  details: string;
  createdAt: string;
}

/*
 * When a Discord server was created, read out of its own id.
 *
 * Every Discord id is a snowflake with the creation time in its top bits, so
 * this is a fact the listing already holds rather than another thing to store
 * or another call to make. The epoch is Discord's own, 2015-01-01 UTC.
 */
export function discordSnowflakeDate(id: string | null | undefined): Date | null {
  if (typeof id !== "string" || !/^\d{1,20}$/.test(id)) return null;
  let value: bigint;
  try {
    value = BigInt(id);
  } catch {
    return null;
  }
  const millis = Number((value >> 22n) + 1420070400000n);
  if (!Number.isFinite(millis)) return null;
  const when = new Date(millis);
  // A snowflake from before Discord existed, or from the far future, is a
  // malformed id rather than a date worth printing.
  if (when.getTime() < 1420070400000 || when.getTime() > Date.now() + 86_400_000) return null;
  return when;
}

/*
 * The Discord server flags worth a badge on a listing page. Everything else the
 * invite reports (a few dozen internal flags about shop pages and role
 * subscriptions) means nothing to someone looking for a place to play.
 */
export const COMMUNITY_FEATURE_LABELS: Record<string, string> = {
  PARTNERED: "Discord partner",
  VERIFIED: "Verified",
  COMMUNITY: "Community server",
  DISCOVERABLE: "In server discovery",
};

export function communityFeatureLabels(features: string[] | undefined): string[] {
  if (!features) return [];
  return features.map((feature) => COMMUNITY_FEATURE_LABELS[feature]).filter((label): label is string => Boolean(label));
}

/** "expires on 3 Mar", for the warning that an invite is not permanent. */
export function communityInviteExpiryLabel(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const when = new Date(iso);
  if (Number.isNaN(when.getTime())) return null;
  return when.toLocaleDateString(undefined, { day: "numeric", month: "short" });
}

/* ------------------------------------------------------------ who it is for
 *
 * A listing may name the places it is for: country codes and the R- region
 * codes from regions.ts, mixed freely, empty meaning everyone. The backend
 * decides who gets an invite (live-backend/src/features/communities.ts); these
 * are only for drawing what was chosen.
 *
 * Worth being plain about in the copy these produce: naming places filters, it
 * does not enforce. Anyone already inside the server can paste the invite
 * anywhere, and a real wall is Discord's own membership screening.
 */

export const COMMUNITY_MAX_ACCESS_SCOPES = 40;

export function isCommunityRegionScope(code: string): boolean {
  return getRegionDef(code) != null;
}

/** "France", "Central America". Falls back to the code for anything unknown. */
export function accessScopeLabel(code: string): string {
  const region = getRegionDef(code);
  if (region) return region.name;
  const name = getCountryName(code);
  return name || code;
}

/**
 * What the locked card says instead of Join. Two names fit on a pill; past that
 * it counts, because "France, Belgium, Switzerland and 4 more" is not a label.
 */
export function describeAccessScopes(scopes: string[] | undefined): string | null {
  if (!scopes || scopes.length === 0) return null;
  const [first, second] = scopes;
  if (scopes.length === 1) return `${accessScopeLabel(first)} only`;
  if (scopes.length === 2) return `${accessScopeLabel(first)} and ${accessScopeLabel(second)}`;
  return `${accessScopeLabel(first)} and ${scopes.length - 1} more`;
}

/**
 * Whether a country falls inside a listing's places, for drawing the owner's own
 * form. Never a gate: the invite is withheld by the backend, and this cannot see
 * anything it did not already send.
 */
export function countryMatchesAccessScopes(scopes: string[] | undefined, country: string | null | undefined): boolean {
  if (!scopes || scopes.length === 0) return true;
  const code = typeof country === "string" ? country.trim().toUpperCase() : "";
  if (!/^[A-Z]{2}$/.test(code)) return false;
  return scopes.some((scope) => {
    const region = getRegionDef(scope);
    return region ? region.countries.includes(code) : scope.toUpperCase() === code;
  });
}

export function communityErrorMessage(code: string | undefined): string {
  if (!code) return "Something went wrong. Try again.";
  return COMMUNITY_ERROR_MESSAGES[code] ?? "Something went wrong. Try again.";
}
