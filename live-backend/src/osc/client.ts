import type { Config } from "../config.js";
import type { ScoreIngestor } from "../ingest/score-ingestor.js";
import type { OscScore } from "../shared/types.js";

export interface OscStatus {
  connected: boolean;
  lastBatchAt: string | null;
  lastConnectedAt?: string | null;
  lastRestartAt?: string | null;
  lastError: string | null;
  stale?: boolean;
  staleSinceAt?: string | null;
  nextReconnectAt?: string | null;
  restarts?: number;
}

interface OscState {
  connected: boolean;
  lastBatchAt: string | null;
  lastConnectedAt: string | null;
  lastRestartAt: string | null;
  lastError: string | null;
  restarts: number;
}

const STALE_RECONNECT_INITIAL_MS = 5 * 60_000;
const STALE_RECONNECT_MAX_MS = 30 * 60_000;

export class OscSocketClient {
  private socket: { disconnect: () => void } | null = null;
  private socketModule: { io: (url: string, options: Record<string, unknown>) => SocketLike } | null = null;
  private watchdog: ReturnType<typeof setTimeout> | null = null;
  private staleSinceMs: number | null = null;
  private nextStaleReconnectAtMs: number | null = null;
  private staleReconnectDelayMs = STALE_RECONNECT_INITIAL_MS;
  private state: OscState = {
    connected: false,
    lastBatchAt: null,
    lastConnectedAt: null,
    lastRestartAt: null,
    lastError: null,
    restarts: 0,
  };

  constructor(
    private readonly config: Pick<Config, "oscBaseUrl" | "oscSocketPath" | "oscSocketStaleMs" | "oscSocketWatchdogIntervalMs">,
    private readonly ingestor: ScoreIngestor,
    private readonly onStale?: () => void | Promise<void>,
    private readonly socketModuleOverride?: { io: (url: string, options: Record<string, unknown>) => SocketLike },
  ) {}

  status(): OscStatus {
    const now = Date.now();
    return {
      ...this.state,
      stale: this.isStale(now),
      staleSinceAt: this.staleSinceMs == null ? null : new Date(this.staleSinceMs).toISOString(),
      nextReconnectAt: this.nextStaleReconnectAtMs == null ? null : new Date(this.nextStaleReconnectAtMs).toISOString(),
    };
  }

  async start(): Promise<void> {
    this.socketModule = this.socketModuleOverride
      ?? (await dynamicImport("socket.io-client") as { io: (url: string, options: Record<string, unknown>) => SocketLike });
    this.connect("startup");
    this.startWatchdog();
  }

  private connect(reason: string): void {
    if (!this.socketModule) return;
    this.socket?.disconnect();
    if (reason !== "startup") {
      this.state = { ...this.state, lastRestartAt: new Date().toISOString(), restarts: this.state.restarts + 1 };
    }
    const socket = this.socketModule.io(this.config.oscBaseUrl, {
      path: this.config.oscSocketPath,
      transports: ["websocket"],
    });
    this.socket = socket;
    socket.on("connect", () => {
      this.state = {
        ...this.state,
        connected: true,
        lastConnectedAt: new Date().toISOString(),
        lastError: this.staleSinceMs == null ? null : this.state.lastError,
      };
      socket.emit("subscribe", "scores");
    });
    socket.on("disconnect", () => {
      if (this.socket !== socket) return;
      this.state = { ...this.state, connected: false };
    });
    socket.on("connect_error", (error: Error) => {
      if (this.socket !== socket) return;
      this.state = { ...this.state, connected: false, lastError: error.message };
    });
    socket.on("scores", async (scores: OscScore[]) => {
      if (this.socket !== socket) return;
      this.clearStaleState();
      this.state = { ...this.state, lastBatchAt: new Date().toISOString() };
      try {
        await this.ingestor.ingestBatch(Array.isArray(scores) ? scores : [], "osc_socket");
      } catch (error) {
        this.state = { ...this.state, lastError: error instanceof Error ? error.message : String(error) };
      }
    });
  }

  private startWatchdog(): void {
    if (this.watchdog) return;
    const tick = () => {
      const now = Date.now();
      if (this.isStale(now)) {
        this.handleStale(now);
      }
      this.watchdog = setTimeout(tick, this.config.oscSocketWatchdogIntervalMs).unref();
    };
    this.watchdog = setTimeout(tick, this.config.oscSocketWatchdogIntervalMs).unref();
  }

  private isStale(now: number): boolean {
    if (this.staleSinceMs != null) return true;
    return this.isActivityStale(now);
  }

  private isActivityStale(now: number): boolean {
    if (!this.state.connected) return false;
    const lastActivity = this.state.lastBatchAt ?? this.state.lastConnectedAt;
    if (!lastActivity) return false;
    const lastActivityMs = new Date(lastActivity).getTime();
    return Number.isFinite(lastActivityMs) && now - lastActivityMs > this.config.oscSocketStaleMs;
  }

  private handleStale(now: number): void {
    const lastActivityAt = this.state.lastBatchAt ?? this.state.lastConnectedAt ?? "never";
    if (this.staleSinceMs == null) {
      this.staleSinceMs = now;
      this.staleReconnectDelayMs = STALE_RECONNECT_INITIAL_MS;
      this.nextStaleReconnectAtMs = now + this.staleReconnectDelayMs;
      const message = `oSC socket stale; fallback polling active after ${this.config.oscSocketStaleMs}ms without scores`;
      console.warn("[osc]", message, {
        lastActivityAt,
        nextReconnectAt: new Date(this.nextStaleReconnectAtMs).toISOString(),
      });
      this.state = { ...this.state, lastError: message };
      if (this.onStale) void Promise.resolve(this.onStale()).catch((error) => console.warn("[osc] stale recovery failed", error));
      return;
    }

    if (this.nextStaleReconnectAtMs == null || now < this.nextStaleReconnectAtMs) return;
    const attemptedAfterMs = this.staleReconnectDelayMs;
    this.staleReconnectDelayMs = Math.min(this.staleReconnectDelayMs * 2, STALE_RECONNECT_MAX_MS);
    this.nextStaleReconnectAtMs = now + this.staleReconnectDelayMs;
    const message = `oSC socket still stale; reconnecting after ${attemptedAfterMs}ms without scores`;
    console.warn("[osc]", message, {
      lastActivityAt,
      nextReconnectAt: new Date(this.nextStaleReconnectAtMs).toISOString(),
    });
    this.state = { ...this.state, lastError: message };
    this.connect("stale");
  }

  private clearStaleState(): void {
    this.staleSinceMs = null;
    this.nextStaleReconnectAtMs = null;
    this.staleReconnectDelayMs = STALE_RECONNECT_INITIAL_MS;
  }

  stop(): void {
    if (this.watchdog) clearTimeout(this.watchdog);
    this.watchdog = null;
    this.socket?.disconnect();
    this.socket = null;
    this.clearStaleState();
    this.state = { ...this.state, connected: false };
  }
}

interface SocketLike {
  on(event: string, listener: (...args: never[]) => void | Promise<void>): void;
  emit(event: string, ...args: unknown[]): void;
  disconnect(): void;
}

const dynamicImport = new Function("specifier", "return import(specifier)") as (specifier: string) => Promise<unknown>;
