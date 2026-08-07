import type { PoolableEventSource } from "./shared-event-source";

/** Leader state as relayed to follower tabs. "connecting" is only ever local
 *  (a follower's initial guess, a fresh leader before its first open). */
type RelayState = "connecting" | "open" | "error";

type ChannelMessage =
  /** A relayed SSE event: type, data payload, and the stream cursor after it. */
  | { k: "ev"; t: string; d: string; id: string }
  /** Leader connection-state change (also the reply to a sync request). */
  | { k: "st"; s: RelayState; id: string }
  /** A new follower asking the leader to re-announce state and cursor. */
  | { k: "sync" };

export interface CrossTabChannel {
  postMessage(message: unknown): void;
  onmessage: ((event: MessageEvent) => void) | null;
  close(): void;
}

export interface CrossTabLocks {
  request(
    name: string,
    options: { mode: "exclusive"; signal: AbortSignal },
    callback: () => Promise<void>,
  ): Promise<unknown>;
}

export interface CrossTabDeps {
  locks: CrossTabLocks;
  createChannel: (name: string) => CrossTabChannel;
  createEventSource: (url: string) => EventSource;
}

export function supportsCrossTabEventSource(): boolean {
  return typeof BroadcastChannel !== "undefined"
    && typeof navigator !== "undefined"
    && typeof navigator.locks?.request === "function";
}

/** How long a visible follower tolerates relay silence before opening its own
 *  direct connection. The backend heartbeats every 15s, so three missed
 *  heartbeats means the leader is alive-but-suspended (a frozen background
 *  tab), not merely quiet. */
const STARVATION_MS = 45_000;
const STARVATION_CHECK_MS = 15_000;

/**
 * One real SSE connection per browser, not per tab. Every tab wanting a given
 * stream URL constructs one of these; they all race for a Web Lock on that URL
 * and exactly one wins. The winner (leader) opens the real EventSource and
 * relays every event over a BroadcastChannel; the rest (followers) dispatch
 * the relayed events to their local listeners as if they held the connection.
 *
 * The lock is the failure detector: when the leader tab closes, crashes, or is
 * discarded, the browser releases its lock and the next tab in line becomes
 * leader. Takeover is gap-free because every tab tracks the stream cursor
 * (`lastEventId`) from the relay, and a new leader resumes via the backend's
 * `?lastEventId=` replay (see live-backend/src/live/sse.ts).
 *
 * Event types must be relayed by name (EventSource has no catch-all listener),
 * so the constructor takes the full list of names the stream emits.
 */
export class CrossTabEventSource extends EventTarget implements PoolableEventSource {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSED = 2;

  private readonly locks: CrossTabLocks;
  private readonly createEventSource: (url: string) => EventSource;
  private readonly channel: CrossTabChannel;
  private readonly lockAbort = new AbortController();
  private releaseLock: (() => void) | null = null;
  private real: EventSource | null = null;
  private fallback: EventSource | null = null;
  private starvationTimer: ReturnType<typeof setInterval> | null = null;
  private lastRelayAt = Date.now();
  private readonly onVisibility = () => this.checkStarvation();
  private role: "follower" | "leader" = "follower";
  private state: RelayState = "connecting";
  private lastEventId = "";
  private closedFlag = false;

  constructor(
    private readonly url: string,
    private readonly eventNames: readonly string[],
    deps?: Partial<CrossTabDeps>,
  ) {
    super();
    this.locks = deps?.locks ?? navigator.locks;
    this.createEventSource = deps?.createEventSource ?? ((target) => new EventSource(target));
    const createChannel = deps?.createChannel ?? ((name: string) => new BroadcastChannel(name));
    const name = `mania-hub-sse:${url}`;
    this.channel = createChannel(name);
    this.channel.onmessage = (event) => this.onChannelMessage(event.data);
    void this.locks.request(name, { mode: "exclusive", signal: this.lockAbort.signal }, () => {
      this.becomeLeader();
      // Hold the lock until close(); releasing it is what hands leadership on.
      return new Promise<void>((resolve) => {
        this.releaseLock = resolve;
        if (this.closedFlag) resolve();
      });
    }).catch(() => undefined);
    if (this.role !== "leader") {
      this.post({ k: "sync" });
      this.startStarvationWatch();
    }
  }

  get readyState(): number {
    if (this.closedFlag) return CrossTabEventSource.CLOSED;
    if (this.role === "leader") return this.real?.readyState ?? CrossTabEventSource.CONNECTING;
    return this.state === "open" ? CrossTabEventSource.OPEN : CrossTabEventSource.CONNECTING;
  }

  close(): void {
    if (this.closedFlag) return;
    this.closedFlag = true;
    this.stopStarvationWatch();
    this.closeFallback();
    this.channel.onmessage = null;
    this.channel.close();
    this.real?.close();
    this.real = null;
    // abort() drops the request if it is still queued; releaseLock() frees the
    // lock if it was already granted. Together they cover both timings.
    this.lockAbort.abort();
    this.releaseLock?.();
  }

  private becomeLeader(): void {
    if (this.closedFlag) return;
    this.stopStarvationWatch();
    this.closeFallback();
    this.role = "leader";
    this.state = "connecting";
    this.real = this.createEventSource(this.resumeUrl());
    this.attachStream(this.real, true);
  }

  /** The stream URL, resuming from the tracked cursor when there is one so a
   *  takeover or fallback replays what was missed (see `?lastEventId=` in
   *  live-backend/src/live/sse.ts). */
  private resumeUrl(): string {
    const cursor = this.lastEventId;
    if (!cursor) return this.url;
    return `${this.url}${this.url.includes("?") ? "&" : "?"}lastEventId=${encodeURIComponent(cursor)}`;
  }

  private attachStream(source: EventSource, relay: boolean): void {
    source.onopen = () => {
      this.state = "open";
      this.dispatchEvent(new Event("open"));
      if (relay) this.post({ k: "st", s: "open", id: this.lastEventId });
    };
    source.onerror = () => {
      this.state = "error";
      this.dispatchEvent(new Event("error"));
      if (relay) this.post({ k: "st", s: "error", id: this.lastEventId });
    };
    for (const type of this.eventNames) {
      source.addEventListener(type, (event) => {
        const message = event as MessageEvent;
        if (typeof message.lastEventId === "string" && message.lastEventId) {
          this.lastEventId = message.lastEventId;
        }
        const data = typeof message.data === "string" ? message.data : "";
        this.deliver(type, data);
        if (relay) this.post({ k: "ev", t: type, d: data, id: this.lastEventId });
      });
    }
  }

  private startStarvationWatch(): void {
    if (typeof document === "undefined") return;
    this.starvationTimer = setInterval(() => this.checkStarvation(), STARVATION_CHECK_MS);
    document.addEventListener("visibilitychange", this.onVisibility);
  }

  private stopStarvationWatch(): void {
    if (this.starvationTimer != null) clearInterval(this.starvationTimer);
    this.starvationTimer = null;
    if (typeof document !== "undefined") document.removeEventListener("visibilitychange", this.onVisibility);
  }

  /** A leader that is alive but frozen (a suspended background tab) keeps the
   *  lock while relaying nothing. A visible follower that goes quiet for
   *  several heartbeats degrades to its own direct connection — the pre-relay
   *  behavior, one tab's worth — and drops it the moment the relay resumes. */
  private checkStarvation(): void {
    if (this.closedFlag || this.role === "leader" || this.fallback) return;
    if (typeof document !== "undefined" && document.visibilityState !== "visible") return;
    if (Date.now() - this.lastRelayAt < STARVATION_MS) return;
    this.fallback = this.createEventSource(this.resumeUrl());
    this.attachStream(this.fallback, false);
  }

  private closeFallback(): void {
    if (!this.fallback) return;
    this.fallback.close();
    this.fallback = null;
  }

  private onChannelMessage(message: unknown): void {
    if (this.closedFlag || typeof message !== "object" || message === null) return;
    const msg = message as ChannelMessage;
    if (msg.k === "sync") {
      if (this.role === "leader") this.post({ k: "st", s: this.state, id: this.lastEventId });
      return;
    }
    // A leader ignores relayed traffic: anything arriving here is a stale
    // broadcast from the previous leader during handoff.
    if (this.role === "leader") return;
    // Anything leader-originated proves the relay is alive; the starvation
    // fallback, if one is open, has served its purpose.
    this.lastRelayAt = Date.now();
    this.closeFallback();
    if (typeof msg.id === "string" && msg.id) this.lastEventId = msg.id;
    if (msg.k === "ev") {
      this.deliver(msg.t, msg.d);
      return;
    }
    const wasOpen = this.state === "open";
    this.state = msg.s;
    if (msg.s === "open" && !wasOpen) this.dispatchEvent(new Event("open"));
    else if (msg.s === "error") this.dispatchEvent(new Event("error"));
  }

  private deliver(type: string, data: string): void {
    this.dispatchEvent(new MessageEvent(type, { data, lastEventId: this.lastEventId }));
  }

  private post(message: ChannelMessage): void {
    if (this.closedFlag) return;
    try {
      this.channel.postMessage(message);
    } catch {
      // A channel torn down mid-dispatch must not break local delivery.
    }
  }
}
