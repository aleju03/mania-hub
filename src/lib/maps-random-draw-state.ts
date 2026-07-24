// The state machine behind the maps Random tab: the prefetched pick queue, the
// recency windows, request supersession and the cold-country repoll.
//
// It lives outside the route because every dead state this tab can reach is a
// sequencing bug (a re-entry that never re-requests, a reroll spinner nothing
// settles, a response that lands after the filters it was drawn under are
// gone), and those are only testable with the timers and the network as seams.
// The route keeps the React state; this owns when to draw and what to do with
// what comes back.

// Top the prefetched buffer back up once it drops to this many, so a reroll
// keeps resolving from memory instead of a network round-trip.
const REFILL_AT = 3;
// When "avoid repeats" is on, the ids of the last few picks ride along with the
// draw request so the server excludes them from the next batch.
const RECENT_PLAYER_HISTORY = 2;
const RECENT_BEATMAP_HISTORY = 5;
// A cold country is still building its maps projection; come back for it.
const COLD_REPOLL_MS = 5_000;

/** The slice of a drawn pick this module needs (see `LiveMapsRandomPick`). */
export interface RandomDrawPickLike {
  player: { id: number };
  beatmapset: { id: number };
}

/** The slice of a draw response this module needs (see `LiveMapsRandomDrawSnapshot`). */
export interface RandomDrawSnapshotLike<TPick extends RandomDrawPickLike> {
  value: { picks: TPick[] } | null;
  generatedAt: string | null;
  isStale: boolean;
  refreshQueued: boolean;
}

export interface RandomDrawRequest {
  count: number;
  excludeUsers: number[];
  excludeSets: number[];
}

/**
 * Everything the machine wants the view to mirror. Only the transitions that
 * actually happened are emitted, so a re-render is a signal, not noise.
 */
export type RandomDrawEvent<
  TPick extends RandomDrawPickLike,
  TSnapshot extends RandomDrawSnapshotLike<TPick>,
> =
  // `true` while the tab has nothing to show and a draw is on its way; `false`
  // once it has something again. The browse tabs share the flag, so entering
  // the tab has to say so either way.
  | { type: "loading"; loading: boolean }
  // Staleness / build progress carried by a landed response.
  | { type: "meta"; snapshot: TSnapshot }
  // The country's maps projection isn't built yet.
  | { type: "building"; firstBuild: boolean }
  | { type: "value"; value: NonNullable<TSnapshot["value"]> }
  | { type: "pick"; pick: TPick }
  // The Reroll button's spinner.
  | { type: "pending"; pending: boolean }
  | { type: "failed"; hasValue: boolean };

/** The impure edges: the network, the clock, and the view. */
export interface RandomDrawHost<
  TPick extends RandomDrawPickLike,
  TSnapshot extends RandomDrawSnapshotLike<TPick>,
> {
  draw(request: RandomDrawRequest, signal: AbortSignal): Promise<TSnapshot>;
  /** "Avoid repeats" decides whether the recency windows are sent. */
  avoidRepeats(): boolean;
  /** The hidden-user list is capped on the wire, so re-check arrivals locally. */
  isPickVisible(pick: TPick): boolean;
  emit(event: RandomDrawEvent<TPick, TSnapshot>): void;
  /** Returns its own canceller, so this module never holds a timer handle. */
  schedule(run: () => void, ms: number): () => void;
}

export interface RandomDrawControllerConfig<
  TPick extends RandomDrawPickLike,
  TSnapshot extends RandomDrawSnapshotLike<TPick>,
> {
  /** Picks asked for per draw; the server caps it. */
  batchSize: number;
  /** How long a filter change waits before redrawing, so a chip sweep is one request. */
  filterDebounceMs: number;
  host: RandomDrawHost<TPick, TSnapshot>;
}

export class MapsRandomDrawController<
  TPick extends RandomDrawPickLike,
  TSnapshot extends RandomDrawSnapshotLike<TPick>,
> {
  private readonly host: RandomDrawHost<TPick, TSnapshot>;
  private readonly batchSize: number;
  private readonly filterDebounceMs: number;

  private queue: TPick[] = [];
  private recentPlayerIds: number[] = [];
  private recentSetIds: number[] = [];
  // Only the newest draw's response is applied; earlier ones are dropped so a
  // filter change can't be overwritten by a request it superseded.
  private requestId = 0;
  private activeRequest: AbortController | null = null;
  private cancelDebounce: (() => void) | null = null;
  private cancelRepoll: (() => void) | null = null;
  private lastKey: string | null = null;
  private hasValue = false;
  private hasPick = false;
  private pending = false;

  constructor(config: RandomDrawControllerConfig<TPick, TSnapshot>) {
    this.host = config.host;
    this.batchSize = config.batchSize;
    this.filterDebounceMs = config.filterDebounceMs;
  }

  /** Queued picks a reroll can serve without a round-trip. */
  get queuedCount(): number {
    return this.queue.length;
  }

  /** True while a reroll is waiting on a batch. */
  get isRerollPending(): boolean {
    return this.pending;
  }

  /**
   * The tab became visible, or its filters changed. `key` is the serialized
   * draw request minus the reroll-only bits, so an unchanged key means the
   * warm queue and the header counts still describe what the user sees.
   */
  enterTab(key: string): void {
    const firstEntry = this.lastKey === null;
    const filtersChanged = this.lastKey !== key;
    this.lastKey = key;
    // Queued picks were drawn under the previous filters.
    if (filtersChanged) this.queue = [];
    // Doubles as clearing a loading flag a browse fetch left set (the tabs
    // share it) and as "a retry is underway, drop the stale error".
    this.host.emit({ type: "loading", loading: !this.hasValue });

    if (firstEntry) {
      void this.request({ commit: true });
      return;
    }
    if (filtersChanged) {
      // Chip toggles only refresh the counts and re-warm the queue; the visible
      // pick stays put unless there was never one to begin with.
      this.cancelDebounce = this.host.schedule(() => {
        this.cancelDebounce = null;
        void this.request({ commit: !this.hasPick });
      }, this.filterDebounceMs);
      return;
    }
    if (!this.hasValue || this.pending) {
      // Re-entry onto a draw that never landed, or onto a reroll a superseded
      // request left spinning. Both are dead ends unless this re-requests.
      void this.request({ commit: true });
    }
    // Otherwise there is nothing to redo: don't spend a request on it.
  }

  /**
   * The tab is going away, or this draw is being superseded by a filter change.
   * Bumping the request id first makes any late settle a no-op, so nothing
   * writes state behind a tab the user already left.
   */
  stop(): void {
    this.cancelDebounce?.();
    this.cancelDebounce = null;
    this.cancelRepoll?.();
    this.cancelRepoll = null;
    this.requestId += 1;
    this.activeRequest?.abort();
    this.activeRequest = null;
  }

  /**
   * A different country is a different pool: everything drawn so far is void.
   * Emits nothing - the caller resets its own view state alongside this.
   */
  reset(): void {
    this.stop();
    this.queue = [];
    this.recentPlayerIds = [];
    this.recentSetIds = [];
    this.lastKey = null;
    this.hasValue = false;
    this.hasPick = false;
    this.pending = false;
  }

  /** The Reroll button: serve from the buffer, and top it back up. */
  reroll(): Promise<void> {
    const next = this.queue.shift();
    if (next) this.commit(next);
    else this.setPending(true);
    if (this.queue.length <= REFILL_AT) return this.request({ commit: !next });
    return Promise.resolve();
  }

  /** A rebuild landed: everything queued predates it. */
  redraw(): Promise<void> {
    this.queue = [];
    return this.request({ commit: true });
  }

  private request(options: { commit: boolean }): Promise<void> {
    const requestId = this.requestId + 1;
    this.requestId = requestId;
    this.activeRequest?.abort();
    this.cancelRepoll?.();
    this.cancelRepoll = null;

    const controller = new AbortController();
    this.activeRequest = controller;

    const avoidRepeats = this.host.avoidRepeats();
    const request: RandomDrawRequest = {
      count: this.batchSize,
      excludeUsers: avoidRepeats ? [...this.recentPlayerIds] : [],
      // Queued sets are excluded too, so a refill doesn't hand back a pick the
      // user is about to see anyway.
      excludeSets: [
        ...(avoidRepeats ? this.recentSetIds : []),
        ...this.queue.map((pick) => pick.beatmapset.id),
      ],
    };

    return this.host.draw(request, controller.signal).then(
      (snapshot) => this.settle(requestId, options, snapshot),
      () => this.fail(requestId),
    );
  }

  private settle(requestId: number, options: { commit: boolean }, snapshot: TSnapshot): void {
    if (this.requestId !== requestId) return;
    this.activeRequest = null;
    this.host.emit({ type: "meta", snapshot });

    const value = snapshot.value;
    if (!value) {
      // Cold country: the maps build is still running, so keep the
      // "Building maps... (N%)" indicator up and come back for it.
      this.host.emit({ type: "building", firstBuild: snapshot.generatedAt == null });
      if (snapshot.isStale || snapshot.refreshQueued) {
        this.cancelRepoll = this.host.schedule(() => {
          this.cancelRepoll = null;
          void this.request(options);
        }, COLD_REPOLL_MS);
      } else {
        this.setPending(false);
      }
      return;
    }

    this.hasValue = true;
    this.host.emit({ type: "value", value: value as NonNullable<TSnapshot["value"]> });
    this.queue.push(...value.picks.filter((pick) => this.host.isPickVisible(pick)));

    // A batch satisfies an outstanding reroll whatever it was drawn for.
    // Otherwise a reroll superseded by a non-committing draw (a filter toggle
    // while it is in flight) leaves the button spinning with nothing coming.
    if (!options.commit && !this.pending) return;
    const next = this.queue.shift();
    if (next) this.commit(next);
    else this.setPending(false);
  }

  private fail(requestId: number): void {
    // Superseded or aborted: whoever superseded it owns the flags now.
    if (this.requestId !== requestId) return;
    this.activeRequest = null;
    this.host.emit({ type: "failed", hasValue: this.hasValue });
    this.setPending(false);
  }

  private commit(pick: TPick): void {
    this.hasPick = true;
    this.host.emit({ type: "pick", pick });
    this.setPending(false);
    if (!this.host.avoidRepeats()) return;

    const nextPlayers = [...this.recentPlayerIds, pick.player.id];
    if (nextPlayers.length > RECENT_PLAYER_HISTORY) nextPlayers.shift();
    this.recentPlayerIds = nextPlayers;

    const nextSets = [...this.recentSetIds, pick.beatmapset.id];
    if (nextSets.length > RECENT_BEATMAP_HISTORY) nextSets.shift();
    this.recentSetIds = nextSets;
  }

  private setPending(pending: boolean): void {
    if (this.pending === pending) return;
    this.pending = pending;
    this.host.emit({ type: "pending", pending });
  }
}
