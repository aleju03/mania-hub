import { createServer, type Server, type ServerResponse } from "node:http";
import { Readable } from "node:stream";
import { S3Client } from "@aws-sdk/client-s3";
import { afterEach, describe, expect, it } from "vitest";
import { getR2Object } from "../src/shared/r2-read.js";
import { getSkinObject, type SkinStorageConfig } from "../src/skins/r2.js";
import { readCachedBeatmapAudioAsset } from "../src/audio/r2-assets.js";
import { readCachedSkinImage } from "../src/skins/image-cache.js";
import type { Config } from "../src/config.js";

const servers: Server[] = [];
const clients: S3Client[] = [];
const input = { Bucket: "mania-hub-replay-cache", Key: "ok" };

afterEach(async () => {
  for (const client of clients.splice(0)) client.destroy();
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

function ok(res: ServerResponse) {
  res.writeHead(200, { "content-length": 5, "x-amz-checksum-crc32": "NhCmhg==" });
  res.end("hello");
}

function stalled(res: ServerResponse, bytes = 10 * 1024 * 1024) {
  res.writeHead(200, { "content-length": bytes, "x-amz-checksum-crc32": "AAAAAA==" });
  res.write(Buffer.alloc(256 * 1024));
}

async function fixture(handler = (path: string, res: ServerResponse) => {
  if (path.endsWith("/headers")) return;
  if (path.endsWith("/stall")) stalled(res);
  else ok(res);
}) {
  const server = createServer((req, res) => handler(new URL(req.url!, "http://local").pathname, res));
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Expected TCP listener");
  const endpoint = `http://127.0.0.1:${address.port}`;
  const client = new S3Client({
    endpoint,
    region: "auto",
    forcePathStyle: true,
    credentials: { accessKeyId: "test", secretAccessKey: "test" },
    maxAttempts: 1,
    requestHandler: { httpAgent: { maxSockets: 1 } },
  });
  clients.push(client);
  const config: SkinStorageConfig = {
    r2Endpoint: endpoint, r2AccessKeyId: "test", r2SecretAccessKey: "test",
    r2Bucket: input.Bucket, livePublicOrigin: endpoint, nodeEnv: "test",
  };
  return { client, config };
}

async function readNext(client: S3Client) {
  const next = await getR2Object(client, input, { requestTimeoutMs: 1000 });
  expect(await next.Body!.transformToString()).toBe("hello");
}

describe("R2 read lifecycle with the real SDK checksum stream", () => {
  it("releases the only connection when a consumer destroys a checksum wrapper", async () => {
    const { client } = await fixture();
    const object = await getR2Object(client, { ...input, Key: "stall" });
    expect(object.Body!.constructor.name).toBe("ChecksumStream");
    (object.Body as Readable).destroy();
    await readNext(client);
  });

  it("keeps successful checksummed reads reusable", async () => {
    const { client } = await fixture();
    await readNext(client);
    await readNext(client);
  });

  it("bounds requests waiting for headers and releases their connection", async () => {
    const { client } = await fixture();
    await expect(getR2Object(client, { ...input, Key: "headers" }, { requestTimeoutMs: 100 }))
      .rejects.toMatchObject({ name: "AbortError" });
    await readNext(client);
  });

  it("still rejects corrupt checksum bodies and releases the connection", async () => {
    const { client } = await fixture((path, res) => {
      if (path.endsWith("/corrupt")) {
        res.writeHead(200, { "content-length": 5, "x-amz-checksum-crc32": "AAAAAA==" });
        res.end("hello");
      } else ok(res);
    });
    const object = await getR2Object(client, { ...input, Key: "corrupt" });
    await expect(object.Body!.transformToByteArray()).rejects.toThrow("Checksum mismatch");
    await readNext(client);
  });

  it("removes a timed-out request from the socket queue", async () => {
    const { client } = await fixture();
    const first = await getR2Object(client, { ...input, Key: "stall" });
    await expect(getR2Object(client, input, { requestTimeoutMs: 100 }))
      .rejects.toMatchObject({ name: "AbortError" });
    (first.Body as Readable).destroy();
    await readNext(client);
  });

  it("bounds a stalled body and settles a shared image-cache fill", async () => {
    const { client } = await fixture();
    const load = async () => {
      const object = await getR2Object(client, { ...input, Key: "stall" }, { transferTimeoutMs: 100 });
      return { body: object.Body as Readable, contentType: "image/webp", contentLength: object.ContentLength!, contentDisposition: null };
    };
    expect(await readCachedSkinImage("deadline-test", load)).toBeNull();
    // The failed single-flight promise must be removed so a later fill retries.
    expect(await readCachedSkinImage("deadline-test", async () => ({
      body: Readable.from([Buffer.from("retry")]), contentType: "image/webp", contentLength: 5, contentDisposition: null,
    }))).toMatchObject({ buffer: Buffer.from("retry") });
    await readNext(client);
  });

  it("propagates caller cancellation before headers and during a body read", async () => {
    const { client } = await fixture();
    const before = new AbortController();
    const pending = getR2Object(client, { ...input, Key: "headers" }, { signal: before.signal });
    before.abort();
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    const during = new AbortController();
    const object = await getR2Object(client, { ...input, Key: "stall" }, { signal: during.signal });
    const reading = object.Body!.transformToByteArray();
    during.abort();
    await expect(reading).rejects.toMatchObject({ name: "AbortError" });
    await readNext(client);
  });

  it("wires skin body destruction to the underlying HTTP response", async () => {
    let closed = false;
    const { config } = await fixture((_path, res) => {
      res.once("close", () => { closed = true; });
      stalled(res);
    });
    const object = await getSkinObject(config, "skins/test/test.osk");
    expect(object).not.toBeNull();
    object!.body.destroy();
    await expect.poll(() => closed).toBe(true);
  });

  it("closes oversized audio responses before rejecting their content length", async () => {
    let closed = false;
    const { config } = await fixture((_path, res) => {
      res.once("close", () => { closed = true; });
      stalled(res, 65 * 1024 * 1024);
    });
    expect(await readCachedBeatmapAudioAsset(config as Config, "123", "audio.mp3")).toBeNull();
    await expect.poll(() => closed).toBe(true);
  });

  it("enforces the audio cap while streaming when content length is absent", async () => {
    let closed = false;
    const { config } = await fixture((_path, res) => {
      res.once("close", () => { closed = true; });
      res.writeHead(200, { "x-amz-checksum-crc32": "AAAAAA==" });
      let sent = 0;
      const chunk = Buffer.alloc(1024 * 1024);
      const write = () => {
        while (!res.destroyed && sent < 66) {
          sent++;
          if (!res.write(chunk)) { res.once("drain", write); return; }
        }
      };
      write();
    });
    expect(await readCachedBeatmapAudioAsset(config as Config, "123", "chunked.mp3")).toBeNull();
    await expect.poll(() => closed).toBe(true);
  });
});
