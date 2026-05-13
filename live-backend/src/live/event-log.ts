import type { Db } from "../db.js";
import { exec, json, parseJson } from "../db.js";
import { nowIso } from "../shared/score.js";
import type { LiveEvent } from "../shared/types.js";

export type EventSink = (event: LiveEvent) => void;

export class LiveEventLog {
  private sinks = new Set<EventSink>();

  constructor(private readonly db: Db) {}

  subscribe(sink: EventSink): () => void {
    this.sinks.add(sink);
    return () => this.sinks.delete(sink);
  }

  async append(type: string, country: string | null, payload: unknown, eventId?: string): Promise<LiveEvent> {
    const createdAt = nowIso();
    const stableId = eventId ?? `${type}:${country ?? "global"}:${createdAt}:${Math.random().toString(36).slice(2)}`;
    const result = await exec(
      this.db,
      `insert or ignore into live_event_log (event_id, type, country, payload_json, created_at)
       values (?, ?, ?, ?, ?)`,
      [stableId, type, country, json(payload), createdAt],
    );
    const row = (await exec(this.db, "select * from live_event_log where event_id = ?", [stableId])).rows[0];
    const event = rowToLiveEvent(row);
    if (Number(result.rowsAffected ?? 0) > 0) {
      for (const sink of this.sinks) sink(event);
    }
    return event;
  }

  async replay(country: string | null, since: number, limit = 100): Promise<LiveEvent[]> {
    const result = await exec(
      this.db,
      `select * from live_event_log
       where sequence > ? and (country is null or ? is null or country = ?)
       order by sequence asc
       limit ?`,
      [since, country, country, limit],
    );
    return result.rows.map(rowToLiveEvent);
  }

  async latestSequence(): Promise<number> {
    const row = (await exec(this.db, "select coalesce(max(sequence), 0) as sequence from live_event_log")).rows[0];
    return Number(row?.sequence ?? 0);
  }
}

function rowToLiveEvent(row: Record<string, unknown>): LiveEvent {
  return {
    sequence: Number(row.sequence),
    event_id: String(row.event_id),
    type: String(row.type),
    country: row.country == null ? null : String(row.country),
    payload: parseJson(row.payload_json, null),
    created_at: String(row.created_at),
  };
}
