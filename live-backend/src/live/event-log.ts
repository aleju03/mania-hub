import type { Db } from "../db.js";
import { exec, json, parseJson } from "../db.js";
import { listPackPullsByIds } from "../features/pack-pulls.js";
import { getTrackerScoreByIdentity } from "../features/tracker.js";
import { logWarn } from "../logger.js";
import { getScoreIdentity } from "../shared/score.js";
import { nowIso } from "../shared/score.js";
import type { LeanTrackerScore, LiveEvent } from "../shared/types.js";

export type EventSink = (event: LiveEvent) => void;

const TAIL_BATCH_LIMIT = 200;

/**
 * The SSE event journal. Rows live in the journal database (journal.ts):
 * `journal` is this process's read handle for tailing and replay, and
 * `journalWriter` is what append() writes on (the serving process's coalesced
 * write handle; the worker's plain one). `db` stays the main database, which
 * replay needs to rehydrate compacted tracker-score and pack-pull payloads.
 * Tests pass one connection for all three.
 */
export class LiveEventLog {
  private sinks = new Set<EventSink>();
  private tailing = false;
  private readonly journal: Db;
  private readonly journalWriter: Db;

  constructor(private readonly db: Db, journal?: Db, journalWriter?: Db) {
    this.journal = journal ?? db;
    this.journalWriter = journalWriter ?? this.journal;
  }

  subscribe(sink: EventSink): () => void {
    this.sinks.add(sink);
    return () => this.sinks.delete(sink);
  }

  private dispatch(event: LiveEvent): void {
    for (const sink of this.sinks) sink(event);
  }

  // Used by a serving process that does not run ingest itself: poll the log for
  // newly appended rows (written by the worker process) and fan them out to the
  // local SSE sinks. While tailing, append() stops dispatching directly so the
  // poller is the single delivery path (no double-send if this process appends).
  startTail(intervalMs: number): () => void {
    this.tailing = true;
    let stopped = false;
    let cursor = 0;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const schedule = (delay: number) => {
      if (stopped) return;
      timer = setTimeout(tick, delay);
      timer.unref();
    };
    const tick = async () => {
      if (stopped) return;
      try {
        const batch = await this.replay(null, cursor, TAIL_BATCH_LIMIT);
        for (const event of batch) {
          if (event.sequence > cursor) cursor = event.sequence;
          this.dispatch(event);
        }
        // A full batch likely means more is waiting; drain without idling.
        schedule(batch.length >= TAIL_BATCH_LIMIT ? 0 : intervalMs);
      } catch (error) {
        logWarn("event_log_tail_failed", { error: error instanceof Error ? error.message : String(error) });
        schedule(Math.max(intervalMs, 1_000));
      }
    };
    // Start from the current head so we only forward events created from now on;
    // SSE clients receive their own backlog via replay-on-connect. Retry head
    // detection on failure rather than tailing from sequence 0, which would
    // replay the entire live_event_log history into live sinks.
    const initCursor = async () => {
      if (stopped) return;
      try {
        cursor = await this.latestSequence();
        schedule(intervalMs);
      } catch (error) {
        logWarn("event_log_tail_head_failed", { error: error instanceof Error ? error.message : String(error) });
        if (stopped) return;
        timer = setTimeout(initCursor, 1_000);
        timer.unref();
      }
    };
    void initCursor();
    return () => {
      stopped = true;
      this.tailing = false;
      if (timer) clearTimeout(timer);
    };
  }

  async append(type: string, country: string | null, payload: unknown, eventId?: string): Promise<LiveEvent> {
    const createdAt = nowIso();
    const stableId = eventId ?? `${type}:${country ?? "global"}:${createdAt}:${Math.random().toString(36).slice(2)}`;
    const storedPayload = compactLiveEventPayload(type, country, payload);
    const result = await exec(
      this.journalWriter,
      `insert or ignore into live_event_log (event_id, type, country, payload_json, created_at)
       values (?, ?, ?, ?, ?)`,
      [stableId, type, country, json(storedPayload), createdAt],
    );
    if (Number(result.rowsAffected ?? 0) > 0) {
      // One write, no read-back: the insert reports the sequence it took.
      const event: LiveEvent = {
        sequence: Number(result.lastInsertRowid),
        event_id: stableId,
        type,
        country,
        payload,
        created_at: createdAt,
      };
      if (!this.tailing) this.dispatch(event);
      return event;
    }
    // A duplicate event id: hand back the row that already won.
    const row = (await exec(this.journal, "select * from live_event_log where event_id = ?", [stableId])).rows[0];
    return this.rowToLiveEvent(row);
  }

  /** `country` scopes the replay: null = every country, an array = any of them
   * (region scopes). Country-less rows (site-wide events) always replay. */
  async replay(country: string | string[] | null, since: number, limit = 100): Promise<LiveEvent[]> {
    const codes = country == null ? null : Array.isArray(country) ? country : [country];
    const countryClause = codes && codes.length > 0
      ? `(country is null or country in (${codes.map(() => "?").join(",")}))`
      : "1 = 1";
    const result = await exec(
      this.journal,
      `select * from live_event_log
       where sequence > ? and ${countryClause}
       order by sequence asc
       limit ?`,
      [since, ...(codes ?? []), limit],
    );
    return Promise.all(result.rows.map((row) => this.rowToLiveEvent(row)));
  }

  async latestSequence(): Promise<number> {
    const row = (await exec(this.journal, "select coalesce(max(sequence), 0) as sequence from live_event_log")).rows[0];
    return Number(row?.sequence ?? 0);
  }

  private async rowToLiveEvent(row: Record<string, unknown>): Promise<LiveEvent> {
    const event = rowToLiveEventWithPayload(row, parseJson(row.payload_json, null));
    if (isStoredPackPullEvent(event.payload)) {
      const entry = (await listPackPullsByIds(this.db, [event.payload.id]))[0];
      return entry ? { ...event, payload: entry } : event;
    }
    if (!isStoredTrackerScoreEvent(event.payload) || !event.country) return event;
    const liveScore = await getTrackerScoreByIdentity(this.db, event.country, event.payload.scoreIdentity);
    return liveScore ? { ...event, payload: liveScore.score } : event;
  }
}

interface StoredTrackerScoreEvent {
  schemaVersion: 1;
  ref: "tracker_score";
  scoreIdentity: string;
}

interface StoredPackPullEvent {
  schemaVersion: 1;
  ref: "pack_pull";
  id: number;
}

function compactLiveEventPayload(type: string, country: string | null, payload: unknown): unknown {
  // Pack pulls: the durable pack_pull_events row (which outlives this log's
  // retention) holds the whole feed entry, so the log only needs the id.
  // Replay rehydrates through the same query that published the entry, live
  // identity overlay included.
  if (type === "pack_pull" && isPackPullFeedEntryPayload(payload)) {
    return { schemaVersion: 1, ref: "pack_pull", id: payload.id } satisfies StoredPackPullEvent;
  }
  if (type !== "tracker_score" || !country || !isLeanTrackerScorePayload(payload)) return payload;
  return {
    schemaVersion: 1,
    ref: "tracker_score",
    scoreIdentity: getScoreIdentity(payload),
  } satisfies StoredTrackerScoreEvent;
}

/* A published PackPullFeedEntry, recognized by the fields the ref needs; the
   already-compacted shape has `ref` and stays as it is. */
function isPackPullFeedEntryPayload(value: unknown): value is { id: number } {
  const candidate = value as { id?: unknown; ref?: unknown; ownerUserId?: unknown } | null;
  return !!candidate
    && typeof candidate.id === "number"
    && candidate.id > 0
    && typeof candidate.ownerUserId === "number"
    && candidate.ref === undefined;
}

function isStoredPackPullEvent(value: unknown): value is StoredPackPullEvent {
  const candidate = value as Partial<StoredPackPullEvent> | null;
  return !!candidate
    && candidate.schemaVersion === 1
    && candidate.ref === "pack_pull"
    && typeof candidate.id === "number";
}

function isLeanTrackerScorePayload(value: unknown): value is LeanTrackerScore {
  const candidate = value as Partial<LeanTrackerScore> | null;
  return !!candidate
    && typeof candidate.id === "number"
    && typeof candidate.user_id === "number"
    && typeof candidate.accuracy === "number"
    && Array.isArray(candidate.mods)
    && hasScoreTotal(candidate)
    && typeof candidate.rank === "string"
    && typeof candidate.beatmap === "object"
    && candidate.beatmap != null
    && typeof candidate.beatmapset === "object"
    && candidate.beatmapset != null
    && typeof candidate.user === "object"
    && candidate.user != null;
}

function hasScoreTotal(candidate: Partial<LeanTrackerScore>): boolean {
  return typeof candidate.score === "number"
    || typeof candidate.total_score === "number"
    || typeof candidate.classic_total_score === "number"
    || typeof candidate.legacy_total_score === "number";
}

function isStoredTrackerScoreEvent(value: unknown): value is StoredTrackerScoreEvent {
  const candidate = value as Partial<StoredTrackerScoreEvent> | null;
  return !!candidate
    && candidate.schemaVersion === 1
    && candidate.ref === "tracker_score"
    && typeof candidate.scoreIdentity === "string";
}

function rowToLiveEventWithPayload(row: Record<string, unknown>, payload: unknown): LiveEvent {
  return {
    sequence: Number(row.sequence),
    event_id: String(row.event_id),
    type: String(row.type),
    country: row.country == null ? null : String(row.country),
    payload,
    created_at: String(row.created_at),
  };
}

export function compactLiveEventLogPayloadForStorage(type: string, country: string | null, payload: unknown): unknown {
  return compactLiveEventPayload(type, country, payload);
}
