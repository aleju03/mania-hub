// Readable labels for R2 keys in the admin bucket browser. Most of what the
// buckets hold is content-addressed, so the key itself is a wall of hex: these
// helpers pull out whatever a key still says about its contents.

/**
 * Shortens a content-hash filename to its distinguishing ends. Anything that
 * isn't a long hex blob (real filenames, score ids, uuids) is left alone.
 */
export function readableName(name: string): string {
  const dot = name.lastIndexOf(".");
  const base = dot > 0 ? name.slice(0, dot) : name;
  const extension = dot > 0 ? name.slice(dot) : "";
  if (base.length < 24 || !/^[0-9a-f]+$/i.test(base)) return name;
  return `${base.slice(0, 8)}…${base.slice(-6)}${extension}`;
}

/**
 * Context a key carries in its own path. Maniacard thumbnails are written as
 * maniacards/<version>/<userId>/<hash>.webp (see pack-thumbnail-store.ts), and
 * cached beatmap assets carry their beatmapset id.
 */
export function keyContext(key: string): string | null {
  const maniacard = /^maniacards\/(v\d+)\/(\d+)\//.exec(key);
  if (maniacard) return `${maniacard[1]} · user ${maniacard[2]}`;

  const asset = /^replay-cache\/(audio|background)\/(\d+)\//.exec(key);
  if (asset) return `set ${asset[2]}`;

  return null;
}
