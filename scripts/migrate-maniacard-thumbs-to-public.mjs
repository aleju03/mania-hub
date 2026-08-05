// One-off backfill for the maniacard thumbnail move to the public image bucket
// (src/lib/pack-thumbnail-store.ts): copies every object under
// replay-cache/maniacards/ in mania-hub-replay-cache to the same key minus the
// replay-cache/ root in mania-hub-public, where cdn.mania-tracker.com serves it
// behind Cloudflare's edge cache.
//
// Purely additive: nothing reads the destination prefix until the frontend
// flip ships, and the source objects are left alone (the replay-cache bucket's
// existing 90d rule ages them out). Safe to re-run; the destination prefix is
// listed once up front and already-present keys are skipped.
//
// Usage: node scripts/migrate-maniacard-thumbs-to-public.mjs [--apply]
//   Dry-run by default: lists what would be copied without writing anything.

import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import path from "node:path";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(path.join(repoRoot, "package.json"));
const {
  S3Client,
  ListObjectsV2Command,
  GetObjectCommand,
  PutObjectCommand,
} = require("@aws-sdk/client-s3");

const APPLY = process.argv.includes("--apply");
const SOURCE_BUCKET = "mania-hub-replay-cache";
const DEST_BUCKET = "mania-hub-public";
const SOURCE_PREFIX = "replay-cache/maniacards/";
const DEST_PREFIX = "maniacards/";
const CONCURRENCY = 48;

const env = { ...loadEnvFile(path.join(repoRoot, ".env")), ...process.env };
for (const name of ["R2_ENDPOINT", "R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY"]) {
  if (!env[name]) {
    console.error(`Missing ${name} (looked in .env and process env)`);
    process.exit(1);
  }
}

const client = new S3Client({
  region: "auto",
  endpoint: env.R2_ENDPOINT,
  credentials: { accessKeyId: env.R2_ACCESS_KEY_ID, secretAccessKey: env.R2_SECRET_ACCESS_KEY },
  forcePathStyle: true,
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

async function listKeys(bucket, prefix) {
  const keys = [];
  let token;
  do {
    const response = await client.send(new ListObjectsV2Command({
      Bucket: bucket,
      Prefix: prefix,
      ContinuationToken: token,
    }));
    for (const entry of response.Contents ?? []) {
      if (entry.Key && entry.Key !== prefix) keys.push({ key: entry.Key, size: Number(entry.Size ?? 0) });
    }
    token = response.IsTruncated ? response.NextContinuationToken : undefined;
  } while (token);
  return keys;
}

async function copyOne(sourceKey, destKey) {
  const object = await client.send(new GetObjectCommand({ Bucket: SOURCE_BUCKET, Key: sourceKey }));
  const buffer = Buffer.from(await object.Body.transformToByteArray());
  await client.send(new PutObjectCommand({
    Bucket: DEST_BUCKET,
    Key: destKey,
    Body: buffer,
    ContentType: object.ContentType ?? "image/webp",
    CacheControl: "public, max-age=31536000, immutable",
  }));
  return buffer.length;
}

const objects = await listKeys(SOURCE_BUCKET, SOURCE_PREFIX);
console.log(`${objects.length} objects under ${SOURCE_BUCKET}/${SOURCE_PREFIX} (${(objects.reduce((s, o) => s + o.size, 0) / 1024 / 1024).toFixed(1)} MiB)`);
const alreadyPresent = new Set((await listKeys(DEST_BUCKET, DEST_PREFIX)).map((entry) => entry.key));
console.log(`${alreadyPresent.size} objects already under ${DEST_BUCKET}/${DEST_PREFIX}`);

let copied = 0;
let skipped = 0;
let failed = 0;
let cursor = 0;

async function worker() {
  for (;;) {
    const index = cursor;
    cursor += 1;
    const entry = objects[index];
    if (!entry) return;
    const destKey = DEST_PREFIX + entry.key.slice(SOURCE_PREFIX.length);
    try {
      if (alreadyPresent.has(destKey)) {
        skipped += 1;
        continue;
      }
      if (APPLY) {
        await copyOne(entry.key, destKey);
      } else {
        console.log(`would copy ${entry.key} -> ${DEST_BUCKET}/${destKey}`);
      }
      copied += 1;
      if (APPLY && copied % 500 === 0) console.log(`copied ${copied}...`);
    } catch (error) {
      failed += 1;
      console.error(`FAILED ${entry.key}: ${error?.message ?? error}`);
    }
  }
}

await Promise.all(Array.from({ length: Math.min(CONCURRENCY, objects.length) }, worker));

console.log(`${APPLY ? "copied" : "would copy"} ${copied}, skipped ${skipped} already present, ${failed} failed`);
if (!APPLY) console.log("Dry run only. Re-run with --apply to copy.");
if (failed > 0) process.exit(1);
