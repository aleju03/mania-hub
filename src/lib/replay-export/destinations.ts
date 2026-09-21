// Where the muxed bytes land.
//
// Two destinations, one contract. Both are position-aware: an MP4 muxer
// revisits byte ranges it already wrote, so appending chunks in arrival order
// would corrupt the file.
//
// Commit is deliberately separate from the muxer closing its stream. On
// cancellation the muxer still closes, and closing a
// `FileSystemWritableFileStream` is what replaces the user's existing file
// with whatever was written so far. The destination therefore parks at
// "muxer done" and waits for the manager to call `commit()` or `abort()`.

import { BufferTarget, StreamTarget, type StreamTargetChunk, type Target } from "mediabunny";
import { ReplayExportError } from "./errors";

export type ReplayExportOutputResult = {
  kind: "file" | "blob";
  filename: string;
  byteLength: number;
  blob: Blob | null;
  mimeType: string;
};

export interface ReplayExportDestination {
  readonly kind: "file" | "buffer";
  readonly target: Target;
  /** Highest byte offset written so far, not the sum of every rewrite. */
  readonly bytesWritten: number;
  /** Called after a successful `output.finalize()`, and only then. */
  commit: () => Promise<ReplayExportOutputResult>;
  /** Discards the output. Safe to call at any point, including twice. */
  abort: () => Promise<void>;
}

export type FileDestinationOptions = {
  handle: FileSystemFileHandle;
  filename: string;
  mimeType: string;
  /** Hard stop on bytes written; trips before the device runs out of room. */
  maxBytes: number;
  /** Bytes accumulated before a write reaches the file. Defaults to 16 MiB. */
  chunkSize?: number;
};

class FileDestination implements ReplayExportDestination {
  readonly kind = "file" as const;
  readonly target: Target;
  private writable: FileSystemWritableFileStream | null = null;
  private highWaterOffset = 0;
  private settled = false;

  constructor(private readonly options: FileDestinationOptions) {
    const writable = new WritableStream<StreamTargetChunk>({
      write: async (chunk) => {
        const stream = this.writable;
        if (!stream) throw new ReplayExportError("storage_write_failed", "Destination file is not open.");
        const end = chunk.position + chunk.data.byteLength;
        if (end > this.options.maxBytes) {
          throw new ReplayExportError("resource_limit_exceeded", "Export exceeded its output byte limit.");
        }
        await stream.write({ type: "write", position: chunk.position, data: chunk.data });
        if (end > this.highWaterOffset) this.highWaterOffset = end;
      },
      // The muxer finishing its stream is not authorization to replace the
      // user's file. `commit()` does that, and only on the success path.
      close: () => {},
      abort: () => {},
    });
    this.target = new StreamTarget(writable, {
      chunked: true,
      ...(options.chunkSize ? { chunkSize: options.chunkSize } : {}),
    });
  }

  get bytesWritten(): number {
    return this.highWaterOffset;
  }

  async open(): Promise<void> {
    try {
      // keepExistingData lets the muxer seek backwards over ranges it wrote
      // earlier in this same session.
      this.writable = await this.options.handle.createWritable({ keepExistingData: true });
    } catch (error) {
      throw new ReplayExportError(
        "storage_write_failed",
        error instanceof Error ? error.message : String(error),
        { cause: error },
      );
    }
  }

  async commit(): Promise<ReplayExportOutputResult> {
    if (this.settled) throw new ReplayExportError("storage_write_failed", "Destination already settled.");
    this.settled = true;
    const stream = this.writable;
    this.writable = null;
    if (!stream) throw new ReplayExportError("storage_write_failed", "Destination file is not open.");
    try {
      // Truncate before closing: a rewritten file that ended up shorter than
      // the one it replaced would otherwise keep the old tail.
      await stream.truncate(this.highWaterOffset);
      await stream.close();
    } catch (error) {
      throw new ReplayExportError(
        "storage_write_failed",
        error instanceof Error ? error.message : String(error),
        { cause: error },
      );
    }
    return {
      kind: "file",
      filename: this.options.filename,
      byteLength: this.highWaterOffset,
      blob: null,
      mimeType: this.options.mimeType,
    };
  }

  async abort(): Promise<void> {
    if (this.settled) return;
    this.settled = true;
    const stream = this.writable;
    this.writable = null;
    // Aborting the writable discards the swap file, so the destination keeps
    // whatever it held before this export started.
    await stream?.abort().catch(() => {});
  }
}

export type BufferDestinationOptions = {
  filename: string;
  mimeType: string;
  maxBytes: number;
};

class BufferDestination implements ReplayExportDestination {
  readonly kind = "buffer" as const;
  readonly target: BufferTarget;
  private settled = false;
  private highWaterOffset = 0;

  constructor(private readonly options: BufferDestinationOptions) {
    this.target = new BufferTarget({
      // MP4 can defer its media and metadata writes until finalization,
      // after the render loop's last size check has already run.
      onFinalize: (buffer) => this.checkSize(buffer.byteLength),
    });
    // The render loop checks growth during encoding; finalize and commit
    // check the completed extent. Write-event listeners are observational:
    // Mediabunny catches their errors, so throwing here cannot enforce a cap.
    this.target.on("write", ({ end }) => {
      if (end > this.highWaterOffset) this.highWaterOffset = end;
    });
  }

  get bytesWritten(): number {
    return this.highWaterOffset;
  }

  private checkSize(byteLength: number): void {
    if (Math.max(byteLength, this.highWaterOffset) > this.options.maxBytes) {
      this.target.buffer = null;
      throw new ReplayExportError("resource_limit_exceeded", "Export exceeded its output byte limit.");
    }
  }

  async commit(): Promise<ReplayExportOutputResult> {
    if (this.settled) throw new ReplayExportError("storage_write_failed", "Destination already settled.");
    this.settled = true;
    const buffer = this.target.buffer;
    if (!buffer) throw new ReplayExportError("encoder_failed", "Muxing produced no output buffer.");
    this.checkSize(buffer.byteLength);
    const blob = new Blob([buffer], { type: this.options.mimeType });
    this.target.buffer = null;
    return {
      kind: "blob",
      filename: this.options.filename,
      byteLength: blob.size,
      blob,
      mimeType: this.options.mimeType,
    };
  }

  async abort(): Promise<void> {
    this.settled = true;
    this.target.buffer = null;
  }
}

export async function createFileDestination(
  options: FileDestinationOptions,
): Promise<ReplayExportDestination> {
  const destination = new FileDestination(options);
  await destination.open();
  return destination;
}

export function createBufferDestination(options: BufferDestinationOptions): ReplayExportDestination {
  return new BufferDestination(options);
}
