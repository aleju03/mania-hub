import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DeleteObjectsCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
  type GetObjectCommandOutput,
  type _Object,
} from "@aws-sdk/client-s3";

const REPLAY_CACHE_BUCKET = "mania-hub-replay-cache";
const AUDIO_PREFIX = "replay-cache/audio/";
const OLD_AUDIO_PREFIXES = [
  "replay-cache/audio-normalized-v1/",
  "replay-cache/audio-mp3-in-mp4-v1/",
  "replay-cache/audio-seekable-mp3-v1/",
] as const;

type Options = {
  dryRun: boolean;
  force: boolean;
  limit: number | null;
  concurrency: number;
  keepOldPrefixes: boolean;
};

type MigrationResult = "converted" | "deleted-source" | "skipped" | "failed" | "would-convert" | "would-delete-source";

type SourceObject = {
  key: string;
  sizeBytes: number;
};

function parseOptions(argv: string[]): Options {
  const options: Options = {
    dryRun: false,
    force: false,
    limit: null,
    concurrency: 1,
    keepOldPrefixes: false,
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--dry-run") {
      options.dryRun = true;
    } else if (arg === "--force") {
      options.force = true;
    } else if (arg === "--keep-old-prefixes") {
      options.keepOldPrefixes = true;
    } else if (arg === "--limit") {
      const value = Number(argv[i + 1]);
      if (!Number.isFinite(value) || value <= 0) throw new Error("--limit must be a positive number");
      options.limit = Math.floor(value);
      i += 1;
    } else if (arg === "--concurrency") {
      const value = Number(argv[i + 1]);
      if (!Number.isFinite(value) || value <= 0) throw new Error("--concurrency must be a positive number");
      options.concurrency = Math.max(1, Math.min(4, Math.floor(value)));
      i += 1;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  return options;
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required env var ${name}`);
  return value;
}

function getClient(): { client: S3Client; bucket: string } {
  const bucket = requireEnv("R2_BUCKET");
  if (bucket !== REPLAY_CACHE_BUCKET) {
    throw new Error(`Refusing to use unexpected R2 bucket "${bucket}"`);
  }

  return {
    bucket,
    client: new S3Client({
      region: "auto",
      endpoint: requireEnv("R2_ENDPOINT"),
      forcePathStyle: true,
      credentials: {
        accessKeyId: requireEnv("R2_ACCESS_KEY_ID"),
        secretAccessKey: requireEnv("R2_SECRET_ACCESS_KEY"),
      },
    }),
  };
}

function isMp3Key(key: string): boolean {
  return key.toLowerCase().endsWith(".mp3");
}

function mp4KeyFromMp3Key(sourceKey: string): string {
  return `${sourceKey.slice(0, sourceKey.lastIndexOf("."))}.mp4`;
}

async function readObjectBody(body: GetObjectCommandOutput["Body"]): Promise<Buffer> {
  if (!body) return Buffer.alloc(0);
  const maybeTransform = body as { transformToByteArray?: () => Promise<Uint8Array> };
  if (typeof maybeTransform.transformToByteArray === "function") {
    return Buffer.from(await maybeTransform.transformToByteArray());
  }

  const chunks: Buffer[] = [];
  for await (const chunk of body as AsyncIterable<Uint8Array | string>) {
    chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

async function listObjects(client: S3Client, bucket: string, prefix: string, limit: number | null = null): Promise<SourceObject[]> {
  const out: SourceObject[] = [];
  let continuationToken: string | undefined;

  do {
    const response = await client.send(new ListObjectsV2Command({
      Bucket: bucket,
      Prefix: prefix,
      ContinuationToken: continuationToken,
      MaxKeys: 1000,
    }));

    for (const object of response.Contents ?? []) {
      if (!object.Key || object.Key.endsWith("/")) continue;
      out.push({ key: object.Key, sizeBytes: object.Size ?? 0 });
      if (limit && out.length >= limit) return out;
    }

    continuationToken = response.NextContinuationToken;
  } while (continuationToken);

  return out;
}

async function objectExists(client: S3Client, bucket: string, key: string): Promise<boolean> {
  try {
    await client.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
    return true;
  } catch {
    return false;
  }
}

function runFfmpeg(args: string[], binary = process.env.FFMPEG_PATH || "ffmpeg"): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(binary, args, { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
      if (stderr.length > 5000) stderr = stderr.slice(-5000);
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`ffmpeg exited with ${code ?? "unknown"}: ${stderr.trim()}`));
      }
    });
  });
}

async function copyMp3IntoMp4(source: Buffer): Promise<Buffer> {
  const dir = await mkdtemp(join(tmpdir(), "mania-hub-audio-playback-"));
  const inputPath = join(dir, "source.mp3");
  const outputPath = join(dir, "audio.mp4");
  try {
    await writeFile(inputPath, source);
    await runFfmpeg([
      "-hide_banner",
      "-loglevel",
      "error",
      "-y",
      "-i",
      inputPath,
      "-map",
      "0:a:0",
      "-vn",
      "-sn",
      "-dn",
      "-c:a",
      "copy",
      "-movflags",
      "+faststart",
      outputPath,
    ]);
    return readFile(outputPath);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function migrateMp3Object(
  client: S3Client,
  bucket: string,
  object: SourceObject,
  options: Options,
): Promise<MigrationResult> {
  if (!isMp3Key(object.key)) return "skipped";

  const mp4Key = mp4KeyFromMp3Key(object.key);
  const exists = await objectExists(client, bucket, mp4Key);
  if (exists && !options.force) {
    if (options.dryRun) {
      console.log(`would delete source ${object.key} because ${mp4Key} already exists`);
      return "would-delete-source";
    }
    await client.send(new DeleteObjectsCommand({
      Bucket: bucket,
      Delete: { Objects: [{ Key: object.key }], Quiet: true },
    }));
    console.log(`deleted source ${object.key} because ${mp4Key} already exists`);
    return "deleted-source";
  }

  if (options.dryRun) {
    console.log(`would convert ${object.key} -> ${mp4Key}`);
    return "would-convert";
  }

  try {
    const response = await client.send(new GetObjectCommand({ Bucket: bucket, Key: object.key }));
    const source = await readObjectBody(response.Body);
    if (source.length === 0) throw new Error("source object was empty");
    const copied = await copyMp3IntoMp4(source);
    await client.send(new PutObjectCommand({
      Bucket: bucket,
      Key: mp4Key,
      Body: copied,
      ContentType: "audio/mp4",
      CacheControl: "public, max-age=86400, immutable",
      Metadata: {
        sourcekey: object.key,
      },
    }));
    await client.send(new DeleteObjectsCommand({
      Bucket: bucket,
      Delete: { Objects: [{ Key: object.key }], Quiet: true },
    }));
    console.log(`converted ${object.key} (${object.sizeBytes} bytes) -> ${mp4Key} (${copied.length} bytes)`);
    return "converted";
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`failed ${object.key}: ${message}`);
    return "failed";
  }
}

async function deletePrefix(client: S3Client, bucket: string, prefix: string, dryRun: boolean): Promise<number> {
  let deleted = 0;
  let continuationToken: string | undefined;

  do {
    const response = await client.send(new ListObjectsV2Command({
      Bucket: bucket,
      Prefix: prefix,
      ContinuationToken: continuationToken,
      MaxKeys: 1000,
    }));
    const objects: _Object[] = (response.Contents ?? []).filter((object) => object.Key && !object.Key.endsWith("/"));
    if (objects.length > 0) {
      if (dryRun) {
        for (const object of objects) console.log(`would delete ${object.Key}`);
      } else {
        await client.send(new DeleteObjectsCommand({
          Bucket: bucket,
          Delete: {
            Objects: objects.map((object) => ({ Key: object.Key })),
            Quiet: true,
          },
        }));
      }
      deleted += objects.length;
    }
    continuationToken = response.NextContinuationToken;
  } while (continuationToken);

  return deleted;
}

async function mapWithConcurrency<T, U>(
  items: T[],
  concurrency: number,
  mapper: (item: T) => Promise<U>,
): Promise<U[]> {
  const results = new Array<U>(items.length);
  let index = 0;

  async function worker() {
    while (index < items.length) {
      const current = index;
      index += 1;
      results[current] = await mapper(items[current]);
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, () => worker()));
  return results;
}

function countResults(results: MigrationResult[], value: MigrationResult): number {
  return results.reduce((count, result) => count + (result === value ? 1 : 0), 0);
}

async function main() {
  const options = parseOptions(process.argv.slice(2));
  const { client, bucket } = getClient();
  try {
    const objects = await listObjects(client, bucket, AUDIO_PREFIX, options.limit);
    const mp3Objects = objects.filter((object) => isMp3Key(object.key));
    console.log(`Found ${objects.length} audio object${objects.length === 1 ? "" : "s"} (${mp3Objects.length} mp3).`);
    if (options.dryRun) console.log("Dry run: no files will be converted, uploaded, or deleted.");

    const results = await mapWithConcurrency(
      mp3Objects,
      options.concurrency,
      (object) => migrateMp3Object(client, bucket, object, options),
    );

    console.log("");
    console.log(`Converted: ${countResults(results, "converted")}`);
    console.log(`Deleted source: ${countResults(results, "deleted-source")}`);
    console.log(`Would convert: ${countResults(results, "would-convert")}`);
    console.log(`Would delete source: ${countResults(results, "would-delete-source")}`);
    console.log(`Skipped: ${countResults(results, "skipped")}`);
    console.log(`Failed: ${countResults(results, "failed")}`);

    if (!options.keepOldPrefixes) {
      console.log("");
      for (const prefix of OLD_AUDIO_PREFIXES) {
        const deleted = await deletePrefix(client, bucket, prefix, options.dryRun);
        console.log(`${options.dryRun ? "Would delete" : "Deleted"} ${deleted} object${deleted === 1 ? "" : "s"} from ${prefix}`);
      }
    }

    if (results.includes("failed")) {
      process.exitCode = 1;
    }
  } finally {
    client.destroy();
  }
}

main()
  .then(() => {
    process.exit(process.exitCode ?? 0);
  })
  .catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
