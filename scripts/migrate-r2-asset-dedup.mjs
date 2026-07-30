// One-off migration to the content-addressed beatmap-asset layout: every payload
// object under replay-cache/audio/ and replay-cache/background/ moves to
// replay-cache/blob/{kind}/{sha256}{ext} (stored once per unique content), and the
// per-set key is overwritten with a zero-byte pointer carrying `blobkey` metadata.
//
// DEPLOY BOTH READERS FIRST (live backend on the VPS for audio, Vercel frontend for
// backgrounds) — old code would serve the zero-byte pointers as if they were payloads.
// Clients holding a pre-migration public URL for a converted per-set key get an empty
// body until their cached URL expires (<=24h); new lookups resolve the blob.
//
// Usage: node scripts/migrate-r2-asset-dedup.mjs [--apply] [--kind audio|background]
//   Dry-run by default: lists what would happen without writing anything.
//
// The extension mapping below MUST stay in sync with getBlobExtension in
// src/lib/r2-cache.ts and live-backend/src/audio/r2-assets.ts, or future cache
// writes will mint blobs at different keys than the migrated ones.

import { readFileSync } from "node:fs";
import crypto from "node:crypto";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import path from "node:path";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(path.join(repoRoot, "package.json"));
const {
  S3Client,
  ListObjectsV2Command,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
} = require("@aws-sdk/client-s3");

const APPLY = process.argv.includes("--apply");
const kindArgIndex = process.argv.indexOf("--kind");
const KINDS = kindArgIndex >= 0 ? [process.argv[kindArgIndex + 1]] : ["audio", "background"];
const MAX_OBJECT_BYTES = 64 * 1024 * 1024;
const CONCURRENCY = 4;

if (!KINDS.every((kind) => kind === "audio" || kind === "background")) {
  console.error("--kind must be audio or background");
  process.exit(1);
}

const env = { ...loadEnvFile(path.join(repoRoot, "live-backend/.env")), ...process.env };
for (const name of ["R2_ENDPOINT", "R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY", "R2_BUCKET"]) {
  if (!env[name]) {
    console.error(`Missing ${name} (looked in live-backend/.env and process env)`);
    process.exit(1);
  }
}
if (env.R2_BUCKET !== "mania-hub-replay-cache") {
  console.error(`Refusing to touch unexpected bucket "${env.R2_BUCKET}"`);
  process.exit(1);
}

const client = new S3Client({
  region: "auto",
  endpoint: env.R2_ENDPOINT,
  credentials: { accessKeyId: env.R2_ACCESS_KEY_ID, secretAccessKey: env.R2_SECRET_ACCESS_KEY },
});

function loadEnvFile(filePath) {
  const out = {};
  let raw;
  try {
    raw = readFileSync(filePath, "utf8");
  } catch {
    return out;
  }
  for (const line of raw.split("\n")) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (m) out[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
  return out;
}

function getBlobExtension(mimeType) {
  switch (mimeType) {
    case "image/jpeg": return ".jpg";
    case "image/png": return ".png";
    case "image/webp": return ".webp";
    case "image/gif": return ".gif";
    case "audio/mp4": return ".mp4";
    case "audio/mpeg":
    case "audio/mp3": return ".mp3";
    case "audio/ogg": return ".ogg";
    case "audio/wav": return ".wav";
    case "audio/flac": return ".flac";
    case "application/zip": return ".zip";
    default: return ".bin";
  }
}

async function listObjects(prefix) {
  const objects = [];
  let token;
  do {
    const res = await client.send(new ListObjectsV2Command({
      Bucket: env.R2_BUCKET, Prefix: prefix, ContinuationToken: token, MaxKeys: 1000,
    }));
    for (const o of res.Contents ?? []) objects.push({ key: o.Key, size: o.Size });
    token = res.IsTruncated ? res.NextContinuationToken : undefined;
  } while (token);
  return objects;
}

async function readBody(body) {
  const chunks = [];
  let total = 0;
  for await (const chunk of body) {
    const part = typeof chunk === "string" ? Buffer.from(chunk) : Buffer.from(chunk);
    total += part.length;
    if (total > MAX_OBJECT_BYTES) throw new Error(`object exceeds ${MAX_OBJECT_BYTES} bytes`);
    chunks.push(part);
  }
  return Buffer.concat(chunks, total);
}

const stats = { converted: 0, blobsCreated: 0, dedupedBytes: 0, skippedPointers: 0, skippedOther: 0, errors: 0 };
const knownBlobs = new Set();

async function migrateObject(kind, obj) {
  if (obj.size === 0) {
    stats.skippedPointers++;
    return;
  }
  if (obj.size > MAX_OBJECT_BYTES) {
    console.warn(`SKIP oversized ${obj.key} (${obj.size} bytes)`);
    stats.skippedOther++;
    return;
  }

  const object = await client.send(new GetObjectCommand({ Bucket: env.R2_BUCKET, Key: obj.key }));
  const buffer = await readBody(object.Body);
  const mimeType = object.ContentType ?? "application/octet-stream";
  const hash = crypto.createHash("sha256").update(buffer).digest("hex");
  const blobKey = `replay-cache/blob/${kind}/${hash}${getBlobExtension(mimeType)}`;

  let blobExists = knownBlobs.has(blobKey);
  if (!blobExists) {
    blobExists = await client.send(new HeadObjectCommand({ Bucket: env.R2_BUCKET, Key: blobKey }))
      .then(() => true, () => false);
  }

  if (blobExists) {
    stats.dedupedBytes += buffer.length;
  } else if (APPLY) {
    await client.send(new PutObjectCommand({
      Bucket: env.R2_BUCKET,
      Key: blobKey,
      Body: buffer,
      ContentType: mimeType,
      CacheControl: "public, max-age=31536000, immutable",
      ContentDisposition: object.ContentDisposition,
    }));
  }
  if (!blobExists) stats.blobsCreated++;
  knownBlobs.add(blobKey);

  if (APPLY) {
    await client.send(new PutObjectCommand({
      Bucket: env.R2_BUCKET,
      Key: obj.key,
      Body: Buffer.alloc(0),
      ContentType: mimeType,
      Metadata: { blobkey: blobKey },
    }));
  }
  stats.converted++;
  console.log(`${blobExists ? "DEDUP" : "MOVE "} ${obj.key} -> ${blobKey}${APPLY ? "" : " (dry-run)"}`);
}

for (const kind of KINDS) {
  const prefix = `replay-cache/${kind}/`;
  const objects = await listObjects(prefix);
  console.log(`\n${prefix}: ${objects.length} objects${APPLY ? "" : " (DRY RUN — pass --apply to write)"}`);

  let index = 0;
  await Promise.all(Array.from({ length: CONCURRENCY }, async () => {
    while (index < objects.length) {
      const obj = objects[index++];
      try {
        await migrateObject(kind, obj);
      } catch (error) {
        stats.errors++;
        console.error(`ERROR ${obj.key}: ${error?.message ?? error}`);
      }
    }
  }));
}

const gb = (b) => (b / 1024 ** 3).toFixed(2);
console.log(`\nDone. converted=${stats.converted} blobsCreated=${stats.blobsCreated}` +
  ` dedupedBytes=${gb(stats.dedupedBytes)}GB alreadyPointers=${stats.skippedPointers}` +
  ` skipped=${stats.skippedOther} errors=${stats.errors}`);
if (!APPLY) console.log("Dry run only — nothing was written. Re-run with --apply after both deploys.");
