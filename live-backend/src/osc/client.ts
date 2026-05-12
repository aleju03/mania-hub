import type { Config } from "../config.js";
import type { ScoreIngestor } from "../ingest/score-ingestor.js";
import type { OscScore } from "../shared/types.js";

export interface OscStatus {
  connected: boolean;
  lastBatchAt: string | null;
  lastError: string | null;
}

export class OscSocketClient {
  private socket: { disconnect: () => void } | null = null;
  private state: OscStatus = { connected: false, lastBatchAt: null, lastError: null };

  constructor(private readonly config: Pick<Config, "oscBaseUrl" | "oscSocketPath">, private readonly ingestor: ScoreIngestor) {}

  status(): OscStatus {
    return { ...this.state };
  }

  async start(): Promise<void> {
    const socketModule = await dynamicImport("socket.io-client") as { io: (url: string, options: Record<string, unknown>) => SocketLike };
    const io = socketModule.io;
    const socket = io(this.config.oscBaseUrl, {
      path: this.config.oscSocketPath,
      transports: ["websocket"],
    });
    this.socket = socket;
    socket.on("connect", () => {
      this.state = { ...this.state, connected: true, lastError: null };
      socket.emit("subscribe", "scores");
    });
    socket.on("disconnect", () => {
      this.state = { ...this.state, connected: false };
    });
    socket.on("connect_error", (error: Error) => {
      this.state = { ...this.state, connected: false, lastError: error.message };
    });
    socket.on("scores", async (scores: OscScore[]) => {
      this.state = { ...this.state, lastBatchAt: new Date().toISOString() };
      try {
        await this.ingestor.ingestBatch(Array.isArray(scores) ? scores : [], "osc_socket");
      } catch (error) {
        this.state = { ...this.state, lastError: error instanceof Error ? error.message : String(error) };
      }
    });
  }

  stop(): void {
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
