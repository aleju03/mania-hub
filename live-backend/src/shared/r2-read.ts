import type { GetObjectCommandInput, GetObjectCommandOutput, S3Client } from "@aws-sdk/client-s3";
import type { Readable } from "node:stream";
import { logWarn } from "../logger.js";
import { loadS3Module } from "./lazy-s3.js";

// Also bound HEAD/PUT/COPY requests on the clients using this policy. The
// explicit read deadlines below span retries, socket queues and response
// bodies; the SDK's request timeout ends when response headers arrive.
export const R2_REQUEST_HANDLER_OPTIONS = {
  connectionTimeout: 10_000,
  requestTimeout: 60_000,
  throwOnRequestTimeout: true,
};

export interface R2ReadOptions {
  signal?: AbortSignal;
  requestTimeoutMs?: number;
  transferTimeoutMs?: number;
}

export async function getR2Object(
  client: S3Client,
  input: GetObjectCommandInput,
  options: R2ReadOptions = {},
): Promise<GetObjectCommandOutput> {
  const s3 = await loadS3Module();
  const controller = new AbortController();
  let body: Readable | undefined;
  let timer: ReturnType<typeof setTimeout>;
  const cleanup = () => {
    clearTimeout(timer);
    options.signal?.removeEventListener("abort", cancel);
  };
  const cancel = () => {
    controller.abort();
    // Aborting the HTTP request alone does not necessarily settle a checksum
    // wrapper's iterator. Close both layers so image-cache promises settle too.
    body?.destroy(Object.assign(new Error("R2 read aborted"), { name: "AbortError" }));
    cleanup();
  };
  const deadline = (phase: "request" | "transfer", ms: number) => setTimeout(() => {
    logWarn("r2_read_timeout", { phase, timeoutMs: ms });
    cancel();
  }, ms).unref();
  timer = deadline("request", options.requestTimeoutMs ?? 15_000);
  options.signal?.addEventListener("abort", cancel, { once: true });
  if (options.signal?.aborted) cancel();
  try {
    const object = await client.send(new s3.GetObjectCommand(input), { abortSignal: controller.signal });
    clearTimeout(timer);
    if (!object.Body) {
      cleanup();
      return object;
    }
    body = object.Body as Readable;
    // The installed SDK returns a ChecksumStream whose destroy() does not
    // destroy its HTTP source. Abort via the supported request signal instead
    // of reaching into SDK internals or disabling checksum validation.
    body.once("end", cleanup);
    body.once("close", () => {
      cleanup();
      if (!body!.readableEnded) controller.abort();
    });
    // A deadline can fire before the caller attaches its pipeline/iterator.
    // Keep that error handled without hiding it from those consumers.
    body.on("error", () => {});
    timer = deadline("transfer", options.transferTimeoutMs ?? 120_000);
    if (controller.signal.aborted) cancel();
    else if (body.destroyed || body.readableEnded) {
      cleanup();
      if (!body.readableEnded) controller.abort();
    }
    return object;
  } catch (error) {
    cleanup();
    controller.abort();
    throw error;
  }
}
