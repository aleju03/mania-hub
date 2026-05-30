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

export class OscSocketClient {
  private socket: { disconnect: () => void } | null = null;
  private socketModule: { io: (url: string, options: Record<string, unknown>) => SocketLike } | null = null;
  private watchdog: ReturnType<typeof setTimeout> | null = null;
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
  ) {}

  status(): OscStatus {
    return { ...this.state, stale: this.isStale(Date.now()) };
  }

  async start(): Promise<void> {
    this.socketModule = await dynamicImport("socket.io-client") as { io: (url: string, options: Record<string, unknown>) => SocketLike };
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
      this.state = { ...this.state, connected: true, lastConnectedAt: new Date().toISOString(), lastError: null };
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
        const lastActivityAt = this.state.lastBatchAt ?? this.state.lastConnectedAt ?? "never";
        const message = `oSC socket stale; reconnecting after ${this.config.oscSocketStaleMs}ms without scores`;
        console.warn("[osc]", message, { lastActivityAt });
        this.state = { ...this.state, lastError: message };
        if (this.onStale) void Promise.resolve(this.onStale()).catch((error) => console.warn("[osc] stale recovery failed", error));
        this.connect("stale");
      }
      this.watchdog = setTimeout(tick, this.config.oscSocketWatchdogIntervalMs).unref();
    };
    this.watchdog = setTimeout(tick, this.config.oscSocketWatchdogIntervalMs).unref();
  }

  private isStale(now: number): boolean {
    if (!this.state.connected) return false;
    const lastActivity = this.state.lastBatchAt ?? this.state.lastConnectedAt;
    if (!lastActivity) return false;
    const lastActivityMs = new Date(lastActivity).getTime();
    return Number.isFinite(lastActivityMs) && now - lastActivityMs > this.config.oscSocketStaleMs;
  }

  stop(): void {
    if (this.watchdog) clearTimeout(this.watchdog);
    this.watchdog = null;
    this.socket?.disconnect();
    this.socket = null;
    this.state = { ...this.state, connected: false };
  }
}

interface SocketLike {
  on(event: string, listener: (...args: never[]) => void | Promise<void>): void;
  emit(event: string, ...args: unknown[]): void;
  disconnect(): void;
}

const dynamicImport = new Function("specifier", "return import(specifier)") as (specifier: string) => Promise<unknown>;
