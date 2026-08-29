import type { Config } from "../config.js";
import type { Db } from "../db.js";
import { exec, parseJson, withWriteTurn } from "../db.js";
import { ScoreIngestor } from "../ingest/score-ingestor.js";
import type { JobQueue } from "../jobs/queue.js";
import type { LiveEventLog } from "../live/event-log.js";
import type { RateLimitResult } from "../http/abuse-guard.js";
import { logInfo } from "../logger.js";
import { OsuApiError, type OsuApiClient } from "../osu/client.js";
import { getDisplayedAccuracy, getScoreIdentity } from "../shared/score.js";
import type { OscScore, OsuMod } from "../shared/types.js";
import { isUserKnownInactive } from "../user-status.js";
import { SOLO_SCORE_ID_FLOOR } from "./activity-mods-backfill.js";
import { enqueuePlayerSkills } from "./player-skills.js";

/**
 * Manual score submission: anyone pastes an osu! score link on a player's
 * profile and, if the score verifies as that player's mania pass, it enters
 * the pipeline through the same ScoreIngestor call every live score takes.
 * Nothing here rates anything - dan/MSD credit is decided downstream by the
 * exact gates a tracked score faces, which is the point of the feature: old
 * ranked/loved plays get in without being re-played, but get no shortcut.
 */

export type ScoreSubmissionFailure =
  | "invalid_link"
  | "score_not_found"
  | "not_mania"
  | "not_owned"
  | "not_passed"
  | "player_untracked"
  | "player_not_found";

export interface SubmittedPlaySummary {
  scoreId: number;
  beatmapId: number | null;
  title: string | null;
  version: string | null;
  accuracy: number | null;
  rank: string | null;
  pp: number | null;
  endedAt: string | null;
  // Carried verbatim (acronym plus lazer settings) so the dialog can show the
  // rate a submitter actually played at, not just the mod letters.
  mods: OsuMod[];
  // The verified osu! page for this score, in the id space that actually
  // resolves to it. The overlap means a client must never build this itself
  // from a bare id: /scores/{legacyId} can open a stranger's play.
  scoreUrl: string | null;
}

export type ScoreSubmissionResult =
  | { ok: true; alreadyTracked: boolean; countries: string[]; play: SubmittedPlaySummary }
  // owner: who the score actually belongs to, on a "not_owned" answer, so the
  // dialog can say which player the pasted link resolved to.
  | { ok: false; reason: ScoreSubmissionFailure; owner?: string | null }
  | { ok: false; reason: "rate_limited"; rate: Extract<RateLimitResult, { allowed: false }> };

interface ParsedScoreLink {
  scoreId: number;
  // Which id spaces to ask, in order. A pasted URL names its space; a bare
  // number could live in either, so both are tried ordered by the floor
  // heuristic (see fetchVerifiedRowScore, which owns the same subtlety).
  spaces: Array<"solo" | "legacy">;
  explicitSpace: boolean;
}

const SCORE_LINK_PATTERN = /^\/scores\/(?:(osu|taiko|fruits|catch|mania)\/)?(\d{1,19})\/?$/;

export function parseScoreLink(input: string): ParsedScoreLink | "wrong_mode" | null {
  const raw = input.trim();
  if (!raw) return null;
  if (/^\d{1,19}$/.test(raw)) return bareIdLink(Number(raw));
  let url: URL;
  try {
    url = new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`);
  } catch {
    return null;
  }
  const host = url.hostname.toLowerCase();
  if (host !== "osu.ppy.sh" && host !== "www.osu.ppy.sh") return null;
  const match = SCORE_LINK_PATTERN.exec(url.pathname);
  if (!match) return null;
  const mode = match[1];
  if (mode && mode !== "mania") return "wrong_mode";
  const scoreId = Number(match[2]);
  if (!Number.isSafeInteger(scoreId) || scoreId <= 0) return null;
  // /scores/{id} is the solo space, /scores/mania/{id} the legacy one.
  return mode === "mania"
    ? { scoreId, spaces: ["legacy"], explicitSpace: true }
    : { scoreId, spaces: ["solo"], explicitSpace: true };
}

function bareIdLink(scoreId: number): ParsedScoreLink | null {
  if (!Number.isSafeInteger(scoreId) || scoreId <= 0) return null;
  return {
    scoreId,
    spaces: scoreId >= SOLO_SCORE_ID_FLOOR ? ["solo", "legacy"] : ["legacy", "solo"],
    explicitSpace: false,
  };
}

export async function submitMissingScore(
  db: Db,
  queue: JobQueue,
  events: LiveEventLog,
  config: Config,
  osu: OsuApiClient,
  targetUserId: number,
  link: string,
  // Charged immediately before the first osu! fetch, so a submission the
  // stored rows can answer (or that fails local validation) never spends the
  // shared osu!-budget buckets. A disallow aborts with its RateLimitResult.
  options: { beforeOsuFetch?: () => RateLimitResult } = {},
): Promise<ScoreSubmissionResult> {
  if (await isUserKnownInactive(db, targetUserId)) return { ok: false, reason: "player_not_found" };
  const parsed = parseScoreLink(link);
  if (parsed === "wrong_mode") return { ok: false, reason: "not_mania" };
  if (!parsed) return { ok: false, reason: "invalid_link" };

  // A recently tracked pass answers from its own row before any osu! call,
  // scoped to the target player (user_id-prefixed index, and score_events
  // only spans the retention window). An explicit URL matches only its own
  // space's id column - the overlap means the same integer in the other
  // column is a different score - while a bare id matches either. Tracked
  // fails fall through on purpose: the honest answer for those is
  // "not_passed", which the fetch below establishes. Misses fall through to
  // the fetch, whose identity check stays the real dedupe.
  const stored = await findTrackedScoreById(db, targetUserId, parsed);
  if (stored) return { ok: true, alreadyTracked: true, countries: stored.countries, play: stored.play };

  const gate = options.beforeOsuFetch?.();
  if (gate && !gate.allowed) return { ok: false, reason: "rate_limited", rate: gate };

  // The two id spaces overlap and neither 404s on the wrong one, so whatever
  // comes back is verified against the target before anything is believed.
  let match: OscScore | null = null;
  let sawWrongOwner = false;
  let wrongOwnerName: string | null = null;
  let sawWrongMode = false;
  let sawFail = false;
  for (const space of parsed.spaces) {
    let fetched: Record<string, unknown>;
    try {
      fetched = await osu.getScoreById(parsed.scoreId, space, "score-submission");
    } catch (error) {
      if (error instanceof OsuApiError && error.status === 404) continue;
      throw error;
    }
    if (Number(fetched.ruleset_id) !== 3) {
      sawWrongMode = true;
      continue;
    }
    if (Number(fetched.user_id) !== targetUserId) {
      sawWrongOwner = true;
      const owner = (fetched as { user?: { username?: unknown } }).user?.username;
      if (typeof owner === "string" && owner) wrongOwnerName = owner;
      continue;
    }
    if (fetched.passed === false) {
      sawFail = true;
      continue;
    }
    match = fetched as unknown as OscScore;
    break;
  }
  if (!match) {
    // A verified mania score under someone else's name outranks the vaguer
    // reasons; a wrong-mode hit only means something when the pasted link
    // named its space - on a bare id it is usually the OTHER space's
    // unrelated score, and "score_not_found" is the honest answer.
    if (sawWrongOwner) return { ok: false, reason: "not_owned", owner: wrongOwnerName };
    if (sawFail) return { ok: false, reason: "not_passed" };
    if (sawWrongMode && parsed.explicitSpace) return { ok: false, reason: "not_mania" };
    return { ok: false, reason: "score_not_found" };
  }

  const score: OscScore = { ...match, ruleset_id: 3 };
  const identity = getScoreIdentity(score);
  const existing = await trackedCountriesForIdentity(db, identity);
  if (existing.length > 0) {
    return { ok: true, alreadyTracked: true, countries: existing, play: toPlaySummary(score) };
  }

  const ingestor = new ScoreIngestor(db, queue, events, config);
  // The board-shaped projections stay on: an old score can legitimately hold
  // a snipe board spot, and boards are all-time. But nothing may present a
  // years-old play as happening now: no recent-reconcile (not a session), no
  // tracker SSE card or country-liveness touch, no goal completions (a goal
  // set after the play was never met by it), no
  // snipe feed event (the board corrects silently), and no top-play
  // confirmation - besides fabricating a "new top play" feed entry, that
  // loop would treat a score absent from today's best-200 as not-yet-
  // published and retry full best-200 fetches for half an hour.
  // One write turn for the whole ingest: its dozen-plus statements go down
  // contiguously on the gated serve-write connection instead of interleaving
  // with every pack draw's, which is what multiplied lock acquisitions during
  // the 2026-08-29 saturation freeze. Reads are on other connections and
  // unaffected; on an ungated db (tests) this is a plain call.
  const result = await withWriteTurn(db, () => ingestor.ingestBatch([score], "manual_submit", {
    enqueueRecentReconcile: false,
    processGoalFeatures: false,
    processTopPlayFeatures: false,
    suppressSnipeEvents: true,
    suppressTrackerEvents: true,
  }));
  if (result.inserted === 0) {
    // The only gate left between the verified score and a row is the tracked-
    // country resolution (roster membership or an active user country).
    return { ok: false, reason: "player_untracked" };
  }
  // Ingest already queued the 30-minute session-debounced recompute; the
  // submitter is watching, so yank the same job forward the way a profile
  // view does.
  await enqueuePlayerSkills(queue, targetUserId);
  const countries = await trackedCountriesForIdentity(db, identity);
  logInfo("manual_score_submitted", {
    user_id: targetUserId,
    score_id: parsed.scoreId,
    beatmap_id: score.beatmap_id ?? score.beatmap?.id ?? null,
    countries,
  });
  return { ok: true, alreadyTracked: false, countries, play: toPlaySummary(score) };
}

async function trackedCountriesForIdentity(db: Db, identity: string): Promise<string[]> {
  const rows = (await exec(db, "select country from score_events where score_identity = ?", [identity])).rows;
  return rows.map((row) => String(row.country));
}

async function findTrackedScoreById(
  db: Db,
  targetUserId: number,
  parsed: ParsedScoreLink,
): Promise<{ countries: string[]; play: SubmittedPlaySummary } | null> {
  const { scoreId } = parsed;
  const idMatchSql = parsed.explicitSpace
    ? (parsed.spaces[0] === "legacy" ? "legacy_score_id = ?" : "score_id = ?")
    : "(score_id = ? or legacy_score_id = ?)";
  const idArgs = parsed.explicitSpace ? [scoreId] : [scoreId, scoreId];
  const rows = (await exec(
    db,
    `select country, score_json from score_events
     where user_id = ? and passed = 1 and ${idMatchSql}`,
    [targetUserId, ...idArgs],
  )).rows;
  if (rows.length === 0) return null;
  const storedScore = parseJson<OscScore | null>(String(rows[0].score_json ?? ""), null);
  const play = storedScore ? toPlaySummary(storedScore) : null;
  // score_json is stored stripped of beatmap/beatmapset; the row's summary
  // gets its labels from the metadata tables the same ingest populated.
  if (play?.beatmapId != null) {
    const meta = (await exec(
      db,
      `select b.version, bs.title from beatmaps b
       left join beatmapsets bs on bs.beatmapset_id = b.beatmapset_id
       where b.beatmap_id = ?`,
      [play.beatmapId],
    )).rows[0];
    if (meta) {
      play.title = meta.title == null ? null : String(meta.title);
      play.version = meta.version == null ? null : String(meta.version);
    }
  }
  return {
    countries: [...new Set(rows.map((row) => String(row.country)))],
    play: play ?? {
      scoreId,
      beatmapId: null,
      title: null,
      version: null,
      accuracy: null,
      rank: null,
      pp: null,
      endedAt: null,
      mods: [],
      scoreUrl: null,
    },
  };
}

function toPlaySummary(score: OscScore): SubmittedPlaySummary {
  const beatmapId = score.beatmap_id ?? score.beatmap?.id ?? null;
  const accuracy = getDisplayedAccuracy(score);
  const soloId = Number(score.id);
  const legacyId = Number(score.legacy_score_id ?? 0);
  return {
    scoreId: score.id,
    beatmapId: beatmapId == null ? null : Number(beatmapId),
    title: score.beatmapset?.title ?? null,
    version: score.beatmap?.version ?? null,
    accuracy: Number.isFinite(accuracy) && accuracy > 0 ? accuracy : null,
    rank: score.rank ?? null,
    pp: score.pp ?? null,
    endedAt: score.ended_at ?? score.created_at ?? null,
    mods: (score.mods ?? []).filter((mod) => mod && typeof mod.acronym === "string" && mod.acronym),
    scoreUrl: Number.isSafeInteger(soloId) && soloId > 0
      ? `https://osu.ppy.sh/scores/${soloId}`
      : Number.isSafeInteger(legacyId) && legacyId > 0
        ? `https://osu.ppy.sh/scores/mania/${legacyId}`
        : null,
  };
}
