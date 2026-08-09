import { randomUUID } from "node:crypto";
import type { Db } from "../db.js";
import { exec } from "../db.js";

/* The temporary GOAT nomination poll behind /packs.
 *
 * Users look up any osu!mania player, nominate them for the honorary roster
 * (the frontend's src/lib/honorary-players.ts), and vote nominees up or down.
 * Net score is public and sorted on, so the ranking is the community's call
 * rather than a moderator's. When the window closes the site owner reads the
 * board and edits the roster by hand: nothing here promotes anyone by code.
 *
 * Banned and deleted accounts are first-class nominees, because a third of the
 * existing roster is exactly that and osu!'s /search cannot return a restricted
 * user at all. Those come in through the manual path, which demands a
 * web.archive.org link as proof the account existed and looked how the
 * nominator says it did.
 *
 * The trust model is the goals/pack-wallet bridge: every write takes an
 * osu!-verified viewer id forwarded by a frontend server fn, never a browser
 * claim. The per-IP abuse guard does NOT apply (it bypasses admin-token
 * requests), so the real ceilings are the unique indexes and the nomination cap
 * below.
 */

// A new nominee costs the poll a permanent row and a slot on a board people
// actually read, so one account gets a handful of chances to put a name up.
// Voting is where participation should live.
export const GOAT_POLL_NOMINATE_CAP = 3;
/* Voting is deliberately uncapped: the widget says "vote for as many players as
   you want" and that should be true. A cap never limited write volume anyway —
   clearing and re-voting is unbounded — so all it bought was a ceiling on how
   many rows one account could hold an opinion on, which does not stop a
   coordinated brigade and does stop an enthusiastic reader. The costs that do
   scale are the board's aggregate query (it grows with total vote rows) and the
   fact that these rows are never pruned; both are cheap at community scale. */
const USERNAME_MAX_LENGTH = 32;

/* ==========================================================================
   THE POLL SWITCH. Everything about running, retiring or rerunning a poll is
   these four values.

   Hardcoded rather than read from the environment on purpose: a poll's dates
   are a product decision, not a secret and not per-deployment, and putting them
   in code means starting or stopping one is a push from this repo instead of an
   SSH session editing .env on the VPS. It also keeps the record of when each
   poll ran in git history.

   - `enabled: false` retires the poll: every route 404s and the widget on
     /packs hides itself. Nothing is deleted, and the stored board stays
     queryable, so this is the switch to flip once the winner has been added to
     src/lib/honorary-players.ts by hand.
   - `adminOnly: true` keeps a finished-but-unreleased poll running for admins
     only: the board 404s for everyone else (the same 404 a retired poll gives,
     so a browser cannot tell a hidden poll from one that does not exist) and
     writes are refused unless the frontend vouches that the signed-in viewer is
     an admin. Flip to false to open it to the site.
   - `id` scopes every row. Bump it for a rerun so a second poll starts with an
     empty board while the previous one stays readable in the database.
   - `opensAt` / `closesAt` are UTC instants, written `YYYY-MM-DDTHH:MM:SSZ` and
     nothing else (see UTC_INSTANT below — a date in any other spelling switches
     the poll off rather than guessing). The window is the only source of truth
     for the deadline: every write re-checks it here and the browser counts down
     against the server's clock, because neither a viewer's timezone nor a
     viewer's wrong system clock should be able to move the deadline. opensAt
     exists so the progress pie fills at the right rate for a poll of any
     length, not just a 30-hour one.
   ========================================================================== */
export const GOAT_POLL: { enabled: boolean; adminOnly: boolean; id: string; opensAt: string; closesAt: string } = {
  enabled: true,
  // Released: public board, anyone signed in can nominate and vote.
  adminOnly: false,
  // The first real poll. 30 hours rather than 24 so the window covers every
  // timezone's waking hours at least once — a 24-hour poll opening at this
  // instant would land entirely inside one night for someone.
  id: "goat-1",
  opensAt: "2026-08-08T23:40:00Z",
  closesAt: "2026-08-10T05:40:00Z",
};

/* The only accepted spelling of a poll date: an explicit UTC instant.
 *
 * Date.parse would also take "2026-08-08 01:43" or a Z-less ISO string, and
 * both of those mean "local time on whichever machine is parsing" — so the same
 * committed config would open the poll at one moment on the VPS and another on
 * a laptop, and the deadline a viewer counts down to would not be the deadline
 * their vote is checked against. One timezone, written down, no inference. */
const UTC_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2})?(?:\.\d{1,3})?Z$/;

function parseUtcInstant(raw: string): number | null {
  if (!UTC_INSTANT.test(raw)) return null;
  const ms = Date.parse(raw);
  if (!Number.isFinite(ms)) return null;
  // The shape can be right while the day is not. V8 does not reject an
  // impossible date in an otherwise well-formed string — it falls through to a
  // lenient parser that rolls "02-31" over into March — so check the date it
  // handed back is the date that was written.
  if (!new Date(ms).toISOString().startsWith(raw.slice(0, 10))) return null;
  return ms;
}

export interface GoatPollWindow {
  pollId: string;
  opensAt: number;
  closesAt: number;
  /* While true the poll exists but is not public: see GOAT_POLL above. */
  adminOnly: boolean;
}

export interface GoatPollNominee {
  id: string;
  osuUserId: number | null;
  username: string;
  countryCode: string | null;
  avatarUrl: string | null;
  banned: boolean;
  proofUrl: string | null;
  nominatedBy: number;
  createdAt: number;
  up: number;
  down: number;
  net: number;
}

export interface GoatPollNominateInput {
  userId: number;
  osuUserId: number | null;
  username: string;
  countryCode: string | null;
  avatarUrl: string | null;
  banned: boolean;
  proofUrl: string | null;
}

export type GoatPollNominateStatus =
  | "created"
  | "already_nominated"
  | "cap_reached"
  | "invalid_username"
  | "invalid_proof"
  | "poll_closed";

export type GoatPollVoteStatus = "recorded" | "cleared" | "unknown_nominee" | "poll_closed";

/**
 * The poll's window, or null when it is retired or its dates are unusable. Null
 * is how the whole feature switches off: the routes 404 and the widget on
 * /packs never renders.
 */
export function goatPollWindow(): GoatPollWindow | null {
  if (!GOAT_POLL.enabled) return null;
  const opensAt = parseUtcInstant(GOAT_POLL.opensAt);
  const closesAt = parseUtcInstant(GOAT_POLL.closesAt);
  // A typo in either date switches the poll off rather than opening one with a
  // nonsensical window: an unusable deadline would compare false against every
  // clock check and quietly leave voting open forever.
  if (opensAt == null || closesAt == null || opensAt >= closesAt) return null;
  return { pollId: GOAT_POLL.id, opensAt, closesAt, adminOnly: GOAT_POLL.adminOnly };
}

export function isGoatPollOpen(window: GoatPollWindow, now = Date.now()): boolean {
  return now < window.closesAt;
}

/**
 * Accepts only a Wayback snapshot of an osu! profile, and hands back the osu!
 * user id when the archived URL carried one.
 *
 * The id matters more than the link: a deleted account has no searchable
 * identity, so without it two people nominating the same player by slightly
 * different spellings would open two rows and split the vote. A numeric profile
 * URL pins them to one row; a username-form URL (/users/Cookiezi) leaves
 * osuUserId null and falls back to name_key deduping.
 */
export function normalizeArchiveProof(raw: unknown): { url: string; osuUserId: number | null } | null {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  if (trimmed.length === 0 || trimmed.length > 500) return null;
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return null;
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return null;
  if (parsed.hostname !== "web.archive.org") return null;
  // /web/<timestamp>/<original url>. The timestamp segment is what makes it a
  // snapshot rather than a link to the live site through the archive's domain.
  const match = /^\/web\/\d+[a-z_]*\/(.+)$/i.exec(parsed.pathname + parsed.search);
  if (!match) return null;
  // The archived target must itself be an osu! profile page, not just anything
  // on osu.ppy.sh: a link to the front page proves nothing about the player.
  const profilePath = /(?:^|\/\/|\.)osu\.ppy\.sh\/(?:users|u)\/([^/?#]+)/i.exec(match[1]);
  if (!profilePath) return null;
  const numericId = /^\d+$/.test(profilePath[1]) ? Number(profilePath[1]) : null;
  return { url: trimmed, osuUserId: numericId };
}

/** Trims to a plausible osu! username; returns null when nothing usable is left. */
export function normalizeNomineeUsername(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim().replace(/\s+/g, " ");
  if (trimmed.length < 2 || trimmed.length > USERNAME_MAX_LENGTH) return null;
  return trimmed;
}

/* The identity a nominee gets when no osu! id pins them down.
 *
 * Case, spacing and punctuation all come off, not just case: a second row for
 * the same human is the one way an account can vote for that human twice, by
 * upvoting "Jakads" and "Jakads." separately while the board reads them as two
 * players. osu! itself treats a username's spaces and underscores as the same
 * character, so collapsing those is the game's own rule; the rest of the
 * stripping is because someone typing a half-remembered name does not reproduce
 * brackets and dashes.
 *
 * Two genuinely different players whose names differ only in punctuation would
 * collapse into one row, so this is the weaker handle: an osu! id outranks it
 * whenever either side has one (see findNominee). */
function nameKey(username: string): string {
  const stripped = username.normalize("NFKC").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");
  // A name made entirely of punctuation would otherwise key to "" and collide
  // with every other such name.
  return stripped || username.trim().toLowerCase();
}

function rowToNominee(row: Record<string, unknown>): GoatPollNominee {
  const up = Number(row.up ?? 0);
  const down = Number(row.down ?? 0);
  return {
    id: String(row.id),
    osuUserId: row.osu_user_id == null ? null : Number(row.osu_user_id),
    username: String(row.username),
    countryCode: row.country_code == null ? null : String(row.country_code),
    avatarUrl: row.avatar_url == null ? null : String(row.avatar_url),
    banned: Number(row.banned) === 1,
    proofUrl: row.proof_url == null ? null : String(row.proof_url),
    nominatedBy: Number(row.nominated_by),
    createdAt: Number(row.created_at),
    up,
    down,
    net: up - down,
  };
}

/**
 * The public board: every nominee with its tallies, best net first. Ties break
 * on raw upvotes and then on age, so a nominee who convinced more people
 * outranks a quiet one on the same net, and an early nomination outranks a
 * latecomer that only drew even.
 */
export async function listGoatPollBoard(db: Db, pollId: string): Promise<GoatPollNominee[]> {
  const rows = (await exec(
    db,
    `select n.*,
            coalesce(sum(case when v.value > 0 then 1 else 0 end), 0) as up,
            coalesce(sum(case when v.value < 0 then 1 else 0 end), 0) as down
     from goat_poll_nominees n
     left join goat_poll_votes v on v.poll_id = n.poll_id and v.nominee_id = n.id
     where n.poll_id = ?
     group by n.id
     order by (up - down) desc, up desc, n.created_at asc`,
    [pollId],
  )).rows;
  return rows.map((row) => rowToNominee(row as Record<string, unknown>));
}

/** One voter's ballot, as `{ [nomineeId]: 1 | -1 }`. */
export async function listGoatPollVotesForUser(
  db: Db,
  pollId: string,
  userId: number,
): Promise<Record<string, number>> {
  const rows = (await exec(
    db,
    "select nominee_id, value from goat_poll_votes where poll_id = ? and voter_user_id = ?",
    [pollId, userId],
  )).rows;
  const votes: Record<string, number> = {};
  for (const row of rows) votes[String(row.nominee_id)] = Number(row.value) > 0 ? 1 : -1;
  return votes;
}

async function countNominationsBy(db: Db, pollId: string, userId: number): Promise<number> {
  const row = (await exec(
    db,
    "select count(*) as n from goat_poll_nominees where poll_id = ? and nominated_by = ?",
    [pollId, userId],
  )).rows[0];
  return Number(row?.n ?? 0);
}

/**
 * The row this nomination already belongs to, or null when the player is not on
 * the board yet.
 *
 * An osu! id is the strongest handle there is, so it is matched first and two
 * rows carrying different ids are two different players however alike their
 * names read. A name match only merges into a row that has no id of its own —
 * which is the duplicate this exists for: the same player put up twice by name,
 * once as typed and once with a dash in it.
 */
async function findNominee(
  db: Db,
  pollId: string,
  osuUserId: number | null,
  key: string,
): Promise<string | null> {
  if (osuUserId != null) {
    const byId = (await exec(
      db,
      "select id from goat_poll_nominees where poll_id = ? and osu_user_id = ?",
      [pollId, osuUserId],
    )).rows[0];
    if (byId) return String(byId.id);
  }
  const row = (await exec(
    db,
    osuUserId == null
      ? "select id from goat_poll_nominees where poll_id = ? and name_key = ?"
      : "select id from goat_poll_nominees where poll_id = ? and name_key = ? and osu_user_id is null",
    [pollId, key],
  )).rows[0];
  return row ? String(row.id) : null;
}

/**
 * Puts a player on the board, with the nominator's upvote already on the row.
 * Nominating someone already there is a no-op that reports `already_nominated`
 * with the existing row's id, so the client can jump the user straight to it
 * instead of showing an error for a reasonable action — and deliberately does
 * not touch their vote, which may be a considered downvote.
 *
 * A banned nominee must carry a valid Wayback proof; an unbanned one is expected
 * to have come from the player search and so already has an id and avatar.
 */
export async function nominateGoatPollPlayer(
  db: Db,
  window: GoatPollWindow,
  input: GoatPollNominateInput,
  now = Date.now(),
): Promise<{ ok: boolean; status: GoatPollNominateStatus; nomineeId: string | null }> {
  if (!isGoatPollOpen(window, now)) return { ok: false, status: "poll_closed", nomineeId: null };
  const username = normalizeNomineeUsername(input.username);
  if (!username) return { ok: false, status: "invalid_username", nomineeId: null };

  let osuUserId = input.osuUserId != null && Number.isInteger(input.osuUserId) && input.osuUserId > 0
    ? input.osuUserId
    : null;
  let proofUrl: string | null = null;
  if (input.banned) {
    const proof = normalizeArchiveProof(input.proofUrl);
    if (!proof) return { ok: false, status: "invalid_proof", nomineeId: null };
    proofUrl = proof.url;
    // The archived profile URL is the better identity: it came from osu! itself,
    // where the typed username is whatever the nominator remembered.
    osuUserId = proof.osuUserId ?? osuUserId;
  }

  const key = nameKey(username);
  const existing = await findNominee(db, window.pollId, osuUserId, key);
  if (existing) return { ok: false, status: "already_nominated", nomineeId: existing };
  if (await countNominationsBy(db, window.pollId, input.userId) >= GOAT_POLL_NOMINATE_CAP) {
    return { ok: false, status: "cap_reached", nomineeId: null };
  }

  const id = randomUUID();
  const countryCode = typeof input.countryCode === "string" && /^[A-Za-z]{2}$/.test(input.countryCode.trim())
    ? input.countryCode.trim().toUpperCase()
    : null;
  const avatarUrl = typeof input.avatarUrl === "string" && /^https?:\/\//i.test(input.avatarUrl.trim())
    ? input.avatarUrl.trim().slice(0, 500)
    : null;
  try {
    await exec(
      db,
      `insert into goat_poll_nominees
         (id, poll_id, osu_user_id, name_key, username, country_code, avatar_url, banned, proof_url, nominated_by, created_at)
       values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [id, window.pollId, osuUserId, key, username, countryCode, avatarUrl, input.banned ? 1 : 0, proofUrl, input.userId, now],
    );
  } catch {
    // Lost a race against a concurrent nomination of the same player: the unique
    // index did its job, so report it the same way the pre-check would have.
    const raced = await findNominee(db, window.pollId, osuUserId, key);
    if (raced) return { ok: false, status: "already_nominated", nomineeId: raced };
    throw new Error("failed to insert goat poll nominee");
  }
  // Putting a name up is an endorsement, so it carries the nominator's own
  // upvote: a row that appears at 0 reads as though the click half-failed, and
  // nobody nominates a player they would not vote for. Best effort — the vote
  // cap can refuse it, and a nomination is still worth having without it.
  await castGoatPollVote(db, window, id, input.userId, 1, now);
  return { ok: true, status: "created", nomineeId: id };
}

/**
 * Takes one nominee off the board, with their votes.
 *
 * Moderation, not scoring: the poll is public and anyone signed in can put a
 * name up, so a joke or an abusive nomination needs an answer other than
 * leaving it there for the rest of the window. It removes a row, not a person —
 * the nominator keeps their remaining nominations and everyone keeps their
 * votes on everyone else. A removed player can be nominated again, which is the
 * right behaviour: this is a delete key, not a ban list.
 */
export async function removeGoatPollNominee(
  db: Db,
  pollId: string,
  nomineeId: string,
): Promise<{ removed: boolean; username: string | null; votesDeleted: number }> {
  const row = (await exec(
    db,
    "select username from goat_poll_nominees where poll_id = ? and id = ?",
    [pollId, nomineeId],
  )).rows[0];
  if (!row) return { removed: false, username: null, votesDeleted: 0 };

  const votes = (await exec(
    db,
    "select count(*) as n from goat_poll_votes where poll_id = ? and nominee_id = ?",
    [pollId, nomineeId],
  )).rows[0];
  await exec(db, "delete from goat_poll_votes where poll_id = ? and nominee_id = ?", [pollId, nomineeId]);
  await exec(db, "delete from goat_poll_nominees where poll_id = ? and id = ?", [pollId, nomineeId]);
  return { removed: true, username: String(row.username), votesDeleted: Number(votes?.n ?? 0) };
}

/**
 * Records one vote. `value` is 1, -1, or 0 to clear. Re-voting the same way is
 * idempotent, and flipping a vote rewrites the row rather than stacking, so the
 * (poll, nominee, voter) primary key is what enforces one voice per account.
 * There is no ceiling on how many nominees one account may back.
 */
export async function castGoatPollVote(
  db: Db,
  window: GoatPollWindow,
  nomineeId: string,
  userId: number,
  value: number,
  now = Date.now(),
): Promise<{ ok: boolean; status: GoatPollVoteStatus }> {
  if (!isGoatPollOpen(window, now)) return { ok: false, status: "poll_closed" };
  const nominee = (await exec(
    db,
    "select 1 from goat_poll_nominees where poll_id = ? and id = ?",
    [window.pollId, nomineeId],
  )).rows[0];
  if (!nominee) return { ok: false, status: "unknown_nominee" };

  if (value === 0) {
    await exec(
      db,
      "delete from goat_poll_votes where poll_id = ? and nominee_id = ? and voter_user_id = ?",
      [window.pollId, nomineeId, userId],
    );
    return { ok: true, status: "cleared" };
  }

  const normalized = value > 0 ? 1 : -1;
  await exec(
    db,
    `insert into goat_poll_votes (poll_id, nominee_id, voter_user_id, value, updated_at)
     values (?, ?, ?, ?, ?)
     on conflict(poll_id, nominee_id, voter_user_id) do update set value = excluded.value, updated_at = excluded.updated_at`,
    [window.pollId, nomineeId, userId, normalized, now],
  );
  return { ok: true, status: "recorded" };
}
