import { createFileRoute, notFound, useNavigate } from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { canUseAdminFeatures } from "../../lib/auth-shared";
import { requireAdminAccess } from "../../lib/auth";
import {
  deleteR2AdminObject,
  deleteR2AdminPrefix,
  describeR2AdminObjects,
  getR2AdminFolderStats,
  getR2AdminListing,
  getR2AdminObjectUrl,
  getR2AdminPrefixSummary,
  getR2AdminSkinOskDownload,
  listR2AdminBuckets,
  type R2AdminBucketId,
  type R2AdminBucketInfo,
  type R2AdminFolder,
  type R2AdminListing,
  type R2AdminObject,
  type R2AdminObjectDescription,
  type R2AdminObjectUrl,
  type R2AdminPrefixSummary,
  type R2AdminRoot,
  type R2AdminSkinDownload,
} from "../../lib/r2-cache";
import { keyContext, readableName } from "../../lib/r2-admin-labels";
import {
  describeUploadedReplayByKey,
  type UploadedReplayDescription,
} from "../../lib/uploaded-replay-describe";
import { GradeImg } from "../../components/ui/GradeImg";

// An empty prefix means "the first root of this bucket"; the server resolves it
// and the answer comes back on the listing, so the roots themselves live in one
// place (the bucket registry in r2-cache.ts) instead of being mirrored here.
type R2Search = {
  bucket?: R2AdminBucketId;
  prefix?: string;
};

type PendingDelete = {
  bucket: R2AdminBucketId;
} & (
  | { kind: "object"; key: string; name: string }
  | { kind: "prefix"; prefix: string; name: string }
);

type SortKey = "name" | "size" | "modified";
type SortDirection = "asc" | "desc";
type SortState = { key: SortKey; direction: SortDirection };

const BUCKET_IDS = ["replay-cache", "public"] as const satisfies readonly R2AdminBucketId[];
const DEFAULT_BUCKET: R2AdminBucketId = "replay-cache";
const PAGE_SIZE = 25;

const fetchR2Buckets = createServerFn({ method: "GET" })
  .handler(async (): Promise<R2AdminBucketInfo[]> => {
    await requireAdminAccess("R2 bucket management");
    return listR2AdminBuckets();
  });

const listR2Objects = createServerFn({ method: "GET" })
  .validator((data: {
    bucket?: string;
    prefix?: string;
    continuationToken?: string | null;
    query?: string;
  }) => ({
    bucket: typeof data?.bucket === "string" ? data.bucket : DEFAULT_BUCKET,
    prefix: typeof data?.prefix === "string" ? data.prefix : "",
    continuationToken: typeof data?.continuationToken === "string" ? data.continuationToken : null,
    query: typeof data?.query === "string" ? data.query : "",
  }))
  .handler(async ({ data }): Promise<R2AdminListing> => {
    await requireAdminAccess("R2 bucket management");
    return getR2AdminListing(data);
  });

const fetchR2FolderStats = createServerFn({ method: "GET" })
  .validator((data: { bucket?: string; prefixes?: string[] }) => ({
    bucket: typeof data?.bucket === "string" ? data.bucket : DEFAULT_BUCKET,
    prefixes: Array.isArray(data?.prefixes)
      ? data.prefixes.filter((entry): entry is string => typeof entry === "string")
      : [],
  }))
  .handler(async ({ data }): Promise<R2AdminPrefixSummary[]> => {
    await requireAdminAccess("R2 folder stats");
    return getR2AdminFolderStats(data);
  });

const describeR2Objects = createServerFn({ method: "GET" })
  .validator((data: { bucket?: string; keys?: string[] }) => ({
    bucket: typeof data?.bucket === "string" ? data.bucket : DEFAULT_BUCKET,
    keys: Array.isArray(data?.keys)
      ? data.keys.filter((entry): entry is string => typeof entry === "string")
      : [],
  }))
  .handler(async ({ data }): Promise<R2AdminObjectDescription[]> => {
    await requireAdminAccess("R2 object listing");
    return describeR2AdminObjects(data);
  });

const summarizeR2Prefix = createServerFn({ method: "GET" })
  .validator((data: { bucket?: string; prefix?: string }) => ({
    bucket: typeof data?.bucket === "string" ? data.bucket : DEFAULT_BUCKET,
    prefix: typeof data?.prefix === "string" ? data.prefix : "",
  }))
  .handler(async ({ data }): Promise<R2AdminPrefixSummary> => {
    await requireAdminAccess("R2 folder preview");
    return getR2AdminPrefixSummary(data.bucket, data.prefix);
  });

const resolveR2ObjectUrl = createServerFn({ method: "GET" })
  .validator((data: { bucket?: string; key?: string; mimeType?: string }) => ({
    bucket: typeof data?.bucket === "string" ? data.bucket : DEFAULT_BUCKET,
    key: typeof data?.key === "string" ? data.key : "",
    mimeType: typeof data?.mimeType === "string" && data.mimeType ? data.mimeType : undefined,
  }))
  .handler(async ({ data }): Promise<R2AdminObjectUrl> => {
    await requireAdminAccess("R2 object preview");
    return getR2AdminObjectUrl(data.bucket, data.key, data.mimeType);
  });

const signSkinOskDownload = createServerFn({ method: "GET" })
  .validator((data: { prefix?: string }) => ({
    prefix: typeof data?.prefix === "string" ? data.prefix : "",
  }))
  .handler(async ({ data }): Promise<R2AdminSkinDownload | null> => {
    await requireAdminAccess("R2 skin download");
    return getR2AdminSkinOskDownload(data.prefix);
  });

const describeUploadedReplay = createServerFn({ method: "GET" })
  .validator((data: { key?: string }) => ({
    key: typeof data?.key === "string" ? data.key : "",
  }))
  .handler(async ({ data }): Promise<UploadedReplayDescription | null> => {
    await requireAdminAccess("R2 replay inspection");
    return describeUploadedReplayByKey(data.key);
  });

const deleteR2Object = createServerFn({ method: "POST" })
  .validator((data: { bucket?: string; key?: string }) => ({
    bucket: typeof data?.bucket === "string" ? data.bucket : DEFAULT_BUCKET,
    key: typeof data?.key === "string" ? data.key : "",
  }))
  .handler(async ({ data }) => {
    await requireAdminAccess("R2 object deletion");
    return deleteR2AdminObject(data.bucket, data.key);
  });

const deleteR2Prefix = createServerFn({ method: "POST" })
  .validator((data: { bucket?: string; prefix?: string }) => ({
    bucket: typeof data?.bucket === "string" ? data.bucket : DEFAULT_BUCKET,
    prefix: typeof data?.prefix === "string" ? data.prefix : "",
  }))
  .handler(async ({ data }) => {
    await requireAdminAccess("R2 folder deletion");
    return deleteR2AdminPrefix(data.bucket, data.prefix);
  });

export const Route = createFileRoute("/admin/r2")({
  validateSearch: (search: Record<string, unknown>): R2Search => {
    const bucket = BUCKET_IDS.find((id) => id === search.bucket);
    const prefix = typeof search.prefix === "string" ? search.prefix.trim() : "";
    return {
      ...(bucket && bucket !== DEFAULT_BUCKET ? { bucket } : {}),
      ...(prefix ? { prefix } : {}),
    };
  },
  head: () => ({
    meta: [
      { title: "R2 - admin" },
      { name: "robots", content: "noindex, nofollow" },
    ],
  }),
  beforeLoad: ({ context }) => {
    if (!canUseAdminFeatures(context.auth)) {
      throw notFound();
    }
    return undefined as never;
  },
  component: R2AdminPage,
});

// ── Session caches ──
// Everything the browser fetches is keyed by bucket + folder + search and kept
// for the tab's lifetime, so stepping back out of a folder (or back into the
// page) paints from memory instead of re-running the listing and the per-folder
// scans behind it. Entries older than the stale window still paint first and
// refresh in the background.
const LISTING_STALE_MS = 5 * 60 * 1000;
const LISTING_CACHE_LIMIT = 40;
const FOLDER_STATS_CACHE_LIMIT = 600;

type ListingSnapshot = { listing: R2AdminListing; fetchedAt: number };
type ViewState = { queryInput: string; query: string; page: number };

const EMPTY_VIEW: ViewState = { queryInput: "", query: "", page: 1 };

// Matches the server's per-request cap so nothing asked for is silently dropped.
const FOLDER_STATS_BATCH = 32;
const DESCRIBE_BATCH = 32;
const DESCRIBE_CACHE_LIMIT = 400;
// Signed URLs are good for six hours; drop them well before that so a long
// session never renders a dead thumbnail.
const DESCRIBE_STALE_MS = 4 * 60 * 60 * 1000;

const listingCache = new Map<string, ListingSnapshot>();
const folderStatsCache = new Map<string, R2AdminPrefixSummary>();
// Every folder whose stats have been asked for, so a batch is requested once
// and a folder that failed to scan doesn't retry on every render.
const folderStatsSeen = new Set<string>();
const describeCache = new Map<string, { data: R2AdminObjectDescription; fetchedAt: number }>();
const describeSeen = new Set<string>();
const describeInflight = new Set<string>();
const viewStateCache = new Map<string, ViewState>();
let lastSort: SortState = { key: "name", direction: "asc" };
let lastThumbnails = true;

// Insertion-ordered eviction: the oldest key goes first, and re-setting a key
// moves it back to the end.
function remember<T>(cache: Map<string, T>, key: string, value: T, limit: number): void {
  cache.delete(key);
  cache.set(key, value);
  while (cache.size > limit) {
    const oldest = cache.keys().next();
    if (oldest.done) break;
    cache.delete(oldest.value);
  }
}

function dropBucketEntries(cache: Map<string, unknown> | Set<string>, bucket: R2AdminBucketId): void {
  for (const key of [...cache.keys()]) {
    if (key.startsWith(`${bucket}|`)) cache.delete(key);
  }
}

function searchFor(bucket: R2AdminBucketId, prefix?: string): R2Search {
  return {
    ...(bucket !== DEFAULT_BUCKET ? { bucket } : {}),
    ...(prefix ? { prefix } : {}),
  };
}

function viewCacheKey(bucket: R2AdminBucketId, prefix: string): string {
  return `${bucket}|${prefix}`;
}

function listingCacheKey(bucket: R2AdminBucketId, prefix: string, query: string): string {
  return `${bucket}|${prefix}|${query}`;
}

let bucketsCache: R2AdminBucketInfo[] | null = null;
let bucketsInflight: Promise<R2AdminBucketInfo[]> | null = null;

function loadBuckets(): Promise<R2AdminBucketInfo[]> {
  if (bucketsCache) return Promise.resolve(bucketsCache);
  if (!bucketsInflight) {
    bucketsInflight = fetchR2Buckets()
      .then((data) => {
        bucketsCache = data;
        return data;
      })
      .finally(() => {
        bucketsInflight = null;
      });
  }
  return bucketsInflight;
}

function useR2Buckets(): R2AdminBucketInfo[] | null {
  const [buckets, setBuckets] = useState<R2AdminBucketInfo[] | null>(bucketsCache);

  useEffect(() => {
    if (bucketsCache) {
      setBuckets(bucketsCache);
      return;
    }
    let active = true;
    void loadBuckets().then((data) => {
      if (active) setBuckets(data);
    }).catch(() => {
      // The listing call reports the same failure with a message worth showing.
    });
    return () => {
      active = false;
    };
  }, []);

  return buckets;
}

function formatBytes(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let size = value;
  let unit = 0;
  while (size >= 1024 && unit < units.length - 1) {
    size /= 1024;
    unit += 1;
  }
  const digits = unit === 0 || size >= 10 ? 0 : 1;
  return `${size.toFixed(digits)} ${units[unit]}`;
}

function formatCount(value: number): string {
  return new Intl.NumberFormat().format(value);
}

function formatDate(value: string | null): string {
  if (!value) return "unknown";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "unknown";
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(date);
}

function compareText(a: string, b: string): number {
  return a.localeCompare(b, undefined, { sensitivity: "base", numeric: true });
}

function compareObjects(a: R2AdminObject, b: R2AdminObject, sortKey: SortKey): number {
  if (sortKey === "size") return a.sizeBytes - b.sizeBytes;
  if (sortKey === "modified") {
    const aTime = a.lastModified ? new Date(a.lastModified).getTime() : 0;
    const bTime = b.lastModified ? new Date(b.lastModified).getTime() : 0;
    return aTime - bTime;
  }
  return compareText(a.name, b.name);
}

function folderStatsFor(bucket: R2AdminBucketId, prefix: string): R2AdminPrefixSummary | null {
  return folderStatsCache.get(viewCacheKey(bucket, prefix)) ?? null;
}

function describedObject(bucket: R2AdminBucketId, key: string): R2AdminObjectDescription | null {
  const entry = describeCache.get(viewCacheKey(bucket, key));
  if (!entry || Date.now() - entry.fetchedAt > DESCRIBE_STALE_MS) return null;
  return entry.data;
}


function compareFolders(
  a: R2AdminFolder,
  b: R2AdminFolder,
  sortKey: SortKey,
  bucket: R2AdminBucketId,
): number {
  if (sortKey === "size") {
    return (folderStatsFor(bucket, a.prefix)?.sizeBytes ?? 0)
      - (folderStatsFor(bucket, b.prefix)?.sizeBytes ?? 0);
  }
  return compareText(a.name, b.name);
}

function mergeListing(previous: R2AdminListing, next: R2AdminListing): R2AdminListing {
  const folders = new Map<string, R2AdminFolder>();
  const objects = new Map<string, R2AdminObject>();
  for (const folder of previous.folders) folders.set(folder.prefix, folder);
  for (const folder of next.folders) folders.set(folder.prefix, folder);
  for (const object of previous.objects) objects.set(object.key, object);
  for (const object of next.objects) objects.set(object.key, object);

  const mergedObjects = [...objects.values()];
  return {
    ...next,
    folders: [...folders.values()],
    objects: mergedObjects,
    totalObjectsShown: mergedObjects.length,
    totalBytesShown: mergedObjects.reduce((sum, object) => sum + object.sizeBytes, 0),
    scannedObjects: previous.scannedObjects + next.scannedObjects,
    searchTruncated: previous.searchTruncated || next.searchTruncated,
  };
}

type PreviewKind = "audio" | "image" | "video" | "other";

function detectPreviewKind(name: string): { kind: PreviewKind; mimeType?: string } {
  const ext = name.toLowerCase().split(".").pop() ?? "";
  switch (ext) {
    case "mp3": return { kind: "audio", mimeType: "audio/mpeg" };
    case "ogg": return { kind: "audio", mimeType: "audio/ogg" };
    case "wav": return { kind: "audio", mimeType: "audio/wav" };
    case "m4a": return { kind: "audio", mimeType: "audio/mp4" };
    case "flac": return { kind: "audio", mimeType: "audio/flac" };
    case "png": return { kind: "image", mimeType: "image/png" };
    case "jpg":
    case "jpeg": return { kind: "image", mimeType: "image/jpeg" };
    case "webp": return { kind: "image", mimeType: "image/webp" };
    case "gif": return { kind: "image", mimeType: "image/gif" };
    case "avif": return { kind: "image", mimeType: "image/avif" };
    case "mp4": return { kind: "video", mimeType: "video/mp4" };
    case "webm": return { kind: "video", mimeType: "video/webm" };
    case "mov": return { kind: "video", mimeType: "video/quicktime" };
    default: return { kind: "other" };
  }
}

// Sub-path crumbs below the active root; the roots themselves render as the
// switcher in front of them.
function pathCrumbs(prefix: string, roots: R2AdminRoot[]): Array<{ label: string; prefix: string }> {
  const root = roots.find((entry) => prefix.startsWith(entry.prefix));
  if (!root) return [];

  const parts = prefix.slice(root.prefix.length).replace(/\/+$/, "").split("/").filter(Boolean);
  const crumbs: Array<{ label: string; prefix: string }> = [];
  let current = root.prefix;
  for (const part of parts) {
    current += `${part}/`;
    crumbs.push({ label: part, prefix: current });
  }
  return crumbs;
}

// Uploaded replays live under this prefix as content-addressed <id>.osr blobs
// (see getUploadedReplayStorageKey). We enrich those rows with the player + map
// parsed from the file, and link them straight into the replay viewer.
const UPLOADED_REPLAY_PREFIX = "replay-cache/uploaded-replays/";

function isUploadedReplayObject(key: string): boolean {
  return key.startsWith(UPLOADED_REPLAY_PREFIX) && /\.osr$/i.test(key);
}

function uploadedReplayIdFromKey(key: string): string | null {
  const base = key.slice(UPLOADED_REPLAY_PREFIX.length);
  if (!base || base.includes("/") || !/\.osr$/i.test(base)) return null;
  return base.slice(0, -4) || null;
}

type ReplayDescriptionState =
  | { status: "loading" }
  | { status: "ready"; data: UploadedReplayDescription | null };

// Descriptions are stable per key, so cache them for the session and dedupe
// in-flight lookups. This keeps paging back and forth from re-parsing replays
// and re-hitting the osu! beatmap lookup.
const replayDescriptionCache = new Map<string, UploadedReplayDescription | null>();
const replayDescriptionInflight = new Map<string, Promise<UploadedReplayDescription | null>>();

function loadUploadedReplayDescription(key: string): Promise<UploadedReplayDescription | null> {
  const existing = replayDescriptionInflight.get(key);
  if (existing) return existing;
  const promise = describeUploadedReplay({ data: { key } })
    .then((data) => data)
    .catch(() => null)
    .then((data) => {
      replayDescriptionCache.set(key, data);
      return data;
    })
    .finally(() => {
      replayDescriptionInflight.delete(key);
    });
  replayDescriptionInflight.set(key, promise);
  return promise;
}

function useUploadedReplayDescription(key: string): ReplayDescriptionState {
  const [state, setState] = useState<ReplayDescriptionState>(() =>
    replayDescriptionCache.has(key)
      ? { status: "ready", data: replayDescriptionCache.get(key) ?? null }
      : { status: "loading" },
  );

  useEffect(() => {
    if (replayDescriptionCache.has(key)) {
      setState({ status: "ready", data: replayDescriptionCache.get(key) ?? null });
      return;
    }
    let active = true;
    setState({ status: "loading" });
    void loadUploadedReplayDescription(key).then((data) => {
      if (active) setState({ status: "ready", data });
    });
    return () => {
      active = false;
    };
  }, [key]);

  return state;
}

function R2AdminPage() {
  const search = Route.useSearch();
  const navigate = useNavigate();
  const buckets = useR2Buckets();

  const bucketId = search.bucket ?? DEFAULT_BUCKET;
  const prefixParam = search.prefix ?? "";
  const viewKey = viewCacheKey(bucketId, prefixParam);

  // Search text and page number belong to the folder you were looking at, so
  // they are restored the same way the listing itself is.
  const [viewKeyState, setViewKeyState] = useState(viewKey);
  const [view, setView] = useState<ViewState>(() => viewStateCache.get(viewKey) ?? EMPTY_VIEW);
  if (viewKeyState !== viewKey) {
    setViewKeyState(viewKey);
    setView(viewStateCache.get(viewKey) ?? EMPTY_VIEW);
  }

  const cacheKey = listingCacheKey(bucketId, prefixParam, view.query);
  const [snapshotKey, setSnapshotKey] = useState(cacheKey);
  const [snapshot, setSnapshot] = useState<ListingSnapshot | null>(
    () => listingCache.get(cacheKey) ?? null,
  );
  if (snapshotKey !== cacheKey) {
    setSnapshotKey(cacheKey);
    setSnapshot(listingCache.get(cacheKey) ?? null);
  }

  const activeKeyRef = useRef(cacheKey);
  activeKeyRef.current = cacheKey;

  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [statsTick, setStatsTick] = useState(0);
  const [pendingDelete, setPendingDelete] = useState<PendingDelete | null>(null);
  const [prefixSummary, setPrefixSummary] = useState<R2AdminPrefixSummary | null>(null);
  const [prefixSummaryLoading, setPrefixSummaryLoading] = useState(false);
  const [prefixSummaryError, setPrefixSummaryError] = useState<string | null>(null);
  const [deleteBusy, setDeleteBusy] = useState(false);
  const [preview, setPreview] = useState<R2AdminObject | null>(null);
  const [sort, setSort] = useState<SortState>(lastSort);
  const [thumbnails, setThumbnails] = useState(lastThumbnails);
  const [describeTick, setDescribeTick] = useState(0);
  const requestIdRef = useRef(0);

  const listing = snapshot?.listing ?? null;
  const activeBucket = buckets?.find((entry) => entry.id === bucketId) ?? null;
  const roots = activeBucket?.roots ?? [];
  const activePrefix = prefixParam || listing?.prefix || roots[0]?.prefix || "";
  const crumbs = useMemo(() => pathCrumbs(activePrefix, roots), [activePrefix, roots]);
  const deleteReady = pendingDelete?.kind !== "prefix" || (
    !!prefixSummary &&
    !prefixSummaryLoading &&
    !prefixSummaryError
  );

  useEffect(() => {
    viewStateCache.set(viewKey, view);
  }, [viewKey, view]);

  useEffect(() => {
    lastSort = sort;
  }, [sort]);

  useEffect(() => {
    lastThumbnails = thumbnails;
  }, [thumbnails]);

  useEffect(() => {
    const timeout = window.setTimeout(() => {
      setView((current) => {
        const next = current.queryInput.trim();
        if (next === current.query) return current;
        return { ...current, query: next, page: 1 };
      });
    }, 250);
    return () => window.clearTimeout(timeout);
  }, [view.queryInput]);

  const load = useCallback(async (
    token: string | null,
    mode: "replace" | "append" | "revalidate",
  ) => {
    const key = listingCacheKey(bucketId, prefixParam, view.query);
    const requestId = ++requestIdRef.current;
    if (mode === "append") setLoadingMore(true);
    else if (mode === "revalidate") setRefreshing(true);
    else setLoading(true);
    setError(null);

    try {
      const next = await listR2Objects({
        data: { bucket: bucketId, prefix: prefixParam, continuationToken: token, query: view.query },
      });
      const previous = mode === "append" ? listingCache.get(key)?.listing : null;
      const entry: ListingSnapshot = {
        listing: previous ? mergeListing(previous, next) : next,
        fetchedAt: Date.now(),
      };
      remember(listingCache, key, entry, LISTING_CACHE_LIMIT);
      if (requestId === requestIdRef.current && activeKeyRef.current === key) {
        setSnapshot(entry);
      }
    } catch (err) {
      if (requestId !== requestIdRef.current || activeKeyRef.current !== key) return;
      setError(err instanceof Error ? err.message : "Could not load R2 objects.");
    } finally {
      if (requestId === requestIdRef.current) {
        setLoading(false);
        setRefreshing(false);
        setLoadingMore(false);
      }
    }
  }, [bucketId, prefixParam, view.query]);

  useEffect(() => {
    const entry = listingCache.get(cacheKey);
    if (entry && Date.now() - entry.fetchedAt < LISTING_STALE_MS) return;
    void load(null, entry ? "revalidate" : "replace");
  }, [cacheKey, load]);

  // Folder counts arrive after the rows do, in batches the server caps, so a
  // folder with hundreds of children never blocks the first paint.
  const folders = listing?.folders;
  useEffect(() => {
    if (!folders?.length) return;
    const batch = folders
      .map((folder) => folder.prefix)
      .filter((prefix) => !folderStatsSeen.has(viewCacheKey(bucketId, prefix)))
      .slice(0, FOLDER_STATS_BATCH);
    if (batch.length === 0) return;

    // Marking the batch before the request keeps the next tick from asking for
    // the same folders again, so each round drains what is left.
    let active = true;
    for (const prefix of batch) folderStatsSeen.add(viewCacheKey(bucketId, prefix));
    void fetchR2FolderStats({ data: { bucket: bucketId, prefixes: batch } })
      .then((rows) => {
        for (const row of rows) {
          remember(folderStatsCache, viewCacheKey(bucketId, row.prefix), row, FOLDER_STATS_CACHE_LIMIT);
        }
        if (active) setStatsTick((tick) => tick + 1);
      })
      .catch(() => {
        // A failed scan leaves those rows without numbers until a refresh; the
        // listing itself already reported whatever went wrong.
      });

    return () => {
      active = false;
    };
  }, [bucketId, folders, statsTick]);

  useEffect(() => {
    if (pendingDelete?.kind !== "prefix") {
      setPrefixSummary(null);
      setPrefixSummaryLoading(false);
      setPrefixSummaryError(null);
      return;
    }

    let cancelled = false;
    setPrefixSummary(null);
    setPrefixSummaryError(null);
    setPrefixSummaryLoading(true);
    summarizeR2Prefix({ data: { bucket: pendingDelete.bucket, prefix: pendingDelete.prefix } })
      .then((summary) => {
        if (!cancelled) setPrefixSummary(summary);
      })
      .catch((err) => {
        if (!cancelled) {
          setPrefixSummaryError(err instanceof Error ? err.message : "Could not preview this folder.");
        }
      })
      .finally(() => {
        if (!cancelled) setPrefixSummaryLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [pendingDelete]);

  const goToPrefix = useCallback((nextPrefix: string) => {
    navigate({ to: "/admin/r2", search: searchFor(bucketId, nextPrefix) });
  }, [bucketId, navigate]);

  const goToBucket = useCallback((nextBucket: R2AdminBucketId) => {
    navigate({ to: "/admin/r2", search: searchFor(nextBucket) });
  }, [navigate]);

  // Refresh re-reads this folder and its counts, and leaves every other folder's
  // cached listing alone so stepping back out of here is still instant.
  const refresh = useCallback(() => {
    for (const folder of listing?.folders ?? []) {
      const key = viewCacheKey(bucketId, folder.prefix);
      folderStatsCache.delete(key);
      folderStatsSeen.delete(key);
    }
    void load(null, snapshot ? "revalidate" : "replace");
  }, [bucketId, listing?.folders, load, snapshot]);

  const toggleSort = useCallback((nextKey: SortKey) => {
    setView((current) => ({ ...current, page: 1 }));
    setSort((current) => {
      if (current.key !== nextKey) {
        return { key: nextKey, direction: nextKey === "name" ? "asc" : "desc" };
      }
      return { key: current.key, direction: current.direction === "asc" ? "desc" : "asc" };
    });
  }, []);

  const setPage = useCallback((next: number) => {
    setView((current) => ({ ...current, page: next }));
  }, []);

  const setQueryInput = useCallback((next: string) => {
    setView((current) => ({ ...current, queryInput: next }));
  }, []);

  const confirmDelete = useCallback(async () => {
    if (!pendingDelete || !deleteReady) return;
    setDeleteBusy(true);
    setError(null);
    try {
      if (pendingDelete.kind === "object") {
        await deleteR2Object({ data: { bucket: pendingDelete.bucket, key: pendingDelete.key } });
      } else {
        await deleteR2Prefix({ data: { bucket: pendingDelete.bucket, prefix: pendingDelete.prefix } });
      }
      setPendingDelete(null);
      setPrefixSummary(null);
      // Sizes and counts everywhere in this bucket just moved.
      dropBucketEntries(listingCache, pendingDelete.bucket);
      dropBucketEntries(folderStatsCache, pendingDelete.bucket);
      dropBucketEntries(folderStatsSeen, pendingDelete.bucket);
      await load(null, "revalidate");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Delete failed.");
    } finally {
      setDeleteBusy(false);
    }
  }, [deleteReady, load, pendingDelete]);

  const sortedFolders = useMemo(() => {
    const direction = sort.direction === "asc" ? 1 : -1;
    return [...(listing?.folders ?? [])]
      .sort((a, b) => compareFolders(a, b, sort.key, bucketId) * direction);
    // statsTick: folder sizes land after the rows, and size sort has to follow.
  }, [listing?.folders, sort, bucketId, statsTick]);
  const sortedObjects = useMemo(() => {
    const direction = sort.direction === "asc" ? 1 : -1;
    return [...(listing?.objects ?? [])].sort((a, b) => compareObjects(a, b, sort.key) * direction);
  }, [listing?.objects, sort]);

  const totalItems = sortedFolders.length + sortedObjects.length;
  const hasMoreOnServer = !!listing?.nextContinuationToken;
  const pageCount = Math.max(1, Math.ceil(totalItems / PAGE_SIZE));
  const safePage = Math.min(view.page, pageCount);
  const pageStart = (safePage - 1) * PAGE_SIZE;
  const pageEnd = pageStart + PAGE_SIZE;

  const pageFolders = useMemo(
    () => sortedFolders.slice(pageStart, pageEnd),
    [sortedFolders, pageStart, pageEnd],
  );
  const pageObjects = useMemo(() => {
    const objectsRemaining = PAGE_SIZE - pageFolders.length;
    if (objectsRemaining <= 0) return [];
    const objectStart = Math.max(0, pageStart - sortedFolders.length);
    return sortedObjects.slice(objectStart, objectStart + objectsRemaining);
  }, [sortedFolders.length, sortedObjects, pageStart, pageFolders.length]);

  const empty = listing && listing.configured && totalItems === 0;
  const busy = loading || refreshing;

  // Thumbnails and metadata for the rows currently on screen. Public-bucket
  // URLs are pure string building and signing is local HMAC work, so a batch
  // only costs R2 operations for roots that declare a metadata field to read.
  const wantsDescription = useCallback((object: R2AdminObject) => {
    if (thumbnails && detectPreviewKind(object.name).kind === "image") return true;
    return roots.some((root) => root.metadataLabelKey && object.key.startsWith(root.prefix));
  }, [roots, thumbnails]);

  useEffect(() => {
    const batch = pageObjects
      .filter(wantsDescription)
      .map((object) => object.key)
      .filter((key) => {
        const cacheKey = viewCacheKey(bucketId, key);
        if (describeInflight.has(cacheKey)) return false;
        const cached = describeCache.get(cacheKey);
        if (cached) return Date.now() - cached.fetchedAt > DESCRIBE_STALE_MS;
        return !describeSeen.has(cacheKey);
      })
      .slice(0, DESCRIBE_BATCH);
    if (batch.length === 0) return;

    let active = true;
    for (const key of batch) {
      describeSeen.add(viewCacheKey(bucketId, key));
      describeInflight.add(viewCacheKey(bucketId, key));
    }
    void describeR2Objects({ data: { bucket: bucketId, keys: batch } })
      .then((rows) => {
        for (const row of rows) {
          remember(
            describeCache,
            viewCacheKey(bucketId, row.key),
            { data: row, fetchedAt: Date.now() },
            DESCRIBE_CACHE_LIMIT,
          );
        }
        if (active) setDescribeTick((tick) => tick + 1);
      })
      .catch(() => {
        // Rows keep their icon and their key; nothing else depends on this.
      })
      .finally(() => {
        for (const key of batch) describeInflight.delete(viewCacheKey(bucketId, key));
      });

    return () => {
      active = false;
    };
  }, [bucketId, pageObjects, wantsDescription, describeTick]);

  const wantedItemsForPage = view.page * PAGE_SIZE;
  useEffect(() => {
    if (!listing?.configured) return;
    if (loading || loadingMore || refreshing) return;
    if (!hasMoreOnServer) return;
    if (totalItems >= wantedItemsForPage) return;
    void load(listing.nextContinuationToken, "append");
  }, [listing, loading, loadingMore, refreshing, hasMoreOnServer, totalItems, wantedItemsForPage, load]);

  return (
    <div className="flex-1">
      <R2Header
        fetchedAt={snapshot?.fetchedAt ?? null}
        busy={busy}
        onRefresh={refresh}
      />
      <div className="bg-osu-b5 min-h-[calc(100vh-60px)]">
        <div className="max-w-[1200px] mx-auto px-4 sm:px-5 py-5 space-y-4">
          {error ? <ErrorBanner message={error} /> : null}

          <BucketTabs buckets={buckets} activeId={bucketId} onSelect={goToBucket} />

          <Crumbs
            roots={roots}
            prefix={activePrefix}
            crumbs={crumbs}
            onNavigate={goToPrefix}
          />

          <div className="flex flex-col gap-3 lg:flex-row lg:items-center">
            <SearchInput value={view.queryInput} onChange={setQueryInput} />
            <div className="flex items-center gap-2">
              <SortToggles sort={sort} onToggle={toggleSort} />
              <ThumbnailToggle on={thumbnails} onToggle={() => setThumbnails((current) => !current)} />
            </div>
          </div>

          <div className="rounded-md border border-osu-b3/20 bg-osu-b5/60 overflow-hidden">
            {listing && !listing.configured ? (
              <NotConfigured bucket={listing.bucket} />
            ) : !listing ? (
              <EmptyState text={error ? "Nothing loaded." : "Loading R2 objects..."} />
            ) : empty ? (
              <EmptyState text={view.query ? "No matching objects in this scan window." : "This folder is empty."} />
            ) : (
              <div className="divide-y divide-osu-b3/20">
                {pageFolders.map((folder) => (
                  <FolderRow
                    key={folder.prefix}
                    folder={folder}
                    stats={folderStatsFor(bucketId, folder.prefix)}
                    downloadable={bucketId === "replay-cache" && isSkinFolderPrefix(folder.prefix)}
                    onOpen={() => goToPrefix(folder.prefix)}
                    onDelete={() => setPendingDelete({
                      bucket: bucketId,
                      kind: "prefix",
                      prefix: folder.prefix,
                      name: folder.name,
                    })}
                  />
                ))}
                {pageObjects.map((object) =>
                  isUploadedReplayObject(object.key) ? (
                    <UploadedReplayRow
                      key={object.key}
                      object={object}
                      onDelete={() => setPendingDelete({
                        bucket: bucketId,
                        kind: "object",
                        key: object.key,
                        name: object.name,
                      })}
                    />
                  ) : (
                    <ObjectRow
                      key={object.key}
                      object={object}
                      description={describedObject(bucketId, object.key)}
                      showThumbnail={thumbnails}
                      onPreview={() => setPreview(object)}
                      onDelete={() => setPendingDelete({
                        bucket: bucketId,
                        kind: "object",
                        key: object.key,
                        name: object.name,
                      })}
                    />
                  ),
                )}
              </div>
            )}
          </div>

          {listing?.configured ? (
            <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
              <div className="text-[11px] text-osu-f1 font-mono">
                {view.query
                  ? `${formatCount(listing.totalObjectsShown)} match · scanned ${formatCount(listing.scannedObjects)}`
                  : `${formatCount(listing.folders.length)} folders · ${formatCount(listing.totalObjectsShown)} files`}
                <span className="text-osu-l2/70"> · </span>
                {formatBytes(listing.totalBytesShown)}
                {listing.searchTruncated ? <span className="text-osu-yellow/90"> · scan capped</span> : null}
              </div>
              <Pagination
                page={safePage}
                pageCount={pageCount}
                hasMoreOnServer={hasMoreOnServer}
                loadingMore={loadingMore}
                onChange={setPage}
              />
            </div>
          ) : null}
        </div>
      </div>

      {preview ? (
        <PreviewDialog bucket={bucketId} object={preview} onClose={() => setPreview(null)} />
      ) : null}

      {pendingDelete ? (
        <DeleteDialog
          pending={pendingDelete}
          warning={deleteWarningFor(roots, pendingDelete)}
          summary={prefixSummary}
          summaryLoading={prefixSummaryLoading}
          summaryError={prefixSummaryError}
          confirmed={deleteReady}
          busy={deleteBusy}
          onCancel={() => {
            setPendingDelete(null);
            setPrefixSummary(null);
            setPrefixSummaryError(null);
          }}
          onConfirm={() => void confirmDelete()}
        />
      ) : null}
    </div>
  );
}

function deleteWarningFor(roots: R2AdminRoot[], pending: PendingDelete): string | null {
  const target = pending.kind === "prefix" ? pending.prefix : pending.key;
  return roots.find((root) => target.startsWith(root.prefix))?.deleteWarning ?? null;
}

function R2Header({
  fetchedAt,
  busy,
  onRefresh,
}: {
  fetchedAt: number | null;
  busy: boolean;
  onRefresh: () => void;
}) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

  const age = fetchedAt ? Math.max(0, Math.round((now - fetchedAt) / 1000)) : null;

  return (
    <div className="bg-osu-d5 border-b border-osu-b3/40">
      <div className="max-w-[1200px] mx-auto px-4 sm:px-5 py-3 flex items-center gap-3">
        <div className="relative flex-shrink-0">
          <span className="block w-2.5 h-2.5 rounded-full bg-osu-yellow" />
          {busy ? (
            <span className="absolute inset-0 rounded-full bg-osu-yellow animate-ping opacity-75" />
          ) : null}
        </div>
        <h2 className="text-[13px] sm:text-[15px] font-medium text-osu-c2">R2 buckets</h2>
        <div className="ml-auto flex items-center gap-3 text-[11px] text-osu-f1">
          {fetchedAt ? (
            <span className={busy ? "text-osu-pink-light" : ""}>
              {busy ? "refreshing..." : age != null ? `updated ${age}s ago` : ""}
            </span>
          ) : null}
          <button
            onClick={onRefresh}
            disabled={busy}
            className="px-2.5 py-1 rounded-md bg-osu-b4/60 border border-osu-b3/30 text-osu-l2 hover:bg-osu-b3/60 hover:text-white transition-colors duration-[120ms] disabled:opacity-50 disabled:cursor-not-allowed cursor-pointer"
          >
            Refresh
          </button>
        </div>
      </div>
    </div>
  );
}

function BucketTabs({
  buckets,
  activeId,
  onSelect,
}: {
  buckets: R2AdminBucketInfo[] | null;
  activeId: R2AdminBucketId;
  onSelect: (id: R2AdminBucketId) => void;
}) {
  // Before the metadata lands, the active bucket still gets a tab so the row
  // doesn't pop into place.
  const entries: Array<{ id: R2AdminBucketId; label: string; bucket: string | null; configured: boolean; isPublic: boolean }> =
    buckets
      ? buckets.map((entry) => ({
        id: entry.id,
        label: entry.label,
        bucket: entry.bucket,
        configured: entry.configured,
        isPublic: !!entry.publicBaseUrl,
      }))
      : [{ id: activeId, label: activeId, bucket: null, configured: true, isPublic: false }];

  return (
    <div className="flex flex-wrap items-end gap-x-6 gap-y-1 border-b border-osu-b3/25">
      {entries.map((entry) => {
        const active = entry.id === activeId;
        return (
          <button
            key={entry.id}
            type="button"
            onClick={() => onSelect(entry.id)}
            className={`relative flex items-baseline gap-2 pb-2 transition-colors duration-[120ms] cursor-pointer ${
              active ? "text-white" : "text-osu-l2 hover:text-white"
            }`}
          >
            <span className="text-[15px] font-medium">{entry.label}</span>
            <span className="text-[11px] font-mono text-osu-f1">
              {!entry.configured ? "not configured" : entry.bucket ?? ""}
            </span>
            {entry.isPublic ? (
              <span className="text-[9px] font-semibold uppercase tracking-wider text-osu-yellow">
                public
              </span>
            ) : null}
            {active ? (
              <span className="absolute inset-x-0 -bottom-px h-[2px] rounded-full bg-osu-pink" />
            ) : null}
          </button>
        );
      })}
    </div>
  );
}

function buildPageWindow(page: number, pageCount: number): Array<number | "…"> {
  if (pageCount <= 7) {
    return Array.from({ length: pageCount }, (_, i) => i + 1);
  }
  const window: Array<number | "…"> = [1];
  const start = Math.max(2, page - 1);
  const end = Math.min(pageCount - 1, page + 1);
  if (start > 2) window.push("…");
  for (let i = start; i <= end; i += 1) window.push(i);
  if (end < pageCount - 1) window.push("…");
  window.push(pageCount);
  return window;
}

function Pagination({
  page,
  pageCount,
  hasMoreOnServer,
  loadingMore,
  onChange,
}: {
  page: number;
  pageCount: number;
  hasMoreOnServer: boolean;
  loadingMore: boolean;
  onChange: (next: number) => void;
}) {
  if (pageCount <= 1 && !hasMoreOnServer) return null;
  const pages = buildPageWindow(page, pageCount);
  const canPrev = page > 1;
  const canNext = page < pageCount || hasMoreOnServer;
  return (
    <div className="flex items-center gap-1 rounded-lg bg-osu-b4/40 border border-osu-b3/30 p-1">
      <button
        type="button"
        onClick={() => onChange(Math.max(1, page - 1))}
        disabled={!canPrev}
        className="px-2.5 py-1 rounded-md text-[12px] font-medium text-osu-l2 hover:text-white hover:bg-osu-b3/40 transition-colors duration-[120ms] disabled:opacity-40 disabled:cursor-not-allowed cursor-pointer"
      >
        ‹
      </button>
      {pages.map((entry, i) =>
        entry === "…" ? (
          <span key={`gap-${i}`} className="px-1.5 text-[12px] text-osu-f1/60 select-none">
            …
          </span>
        ) : (
          <button
            key={entry}
            type="button"
            onClick={() => onChange(entry)}
            className={`min-w-[28px] px-2 py-1 rounded-md text-[12px] font-medium transition-colors duration-[120ms] cursor-pointer ${
              entry === page
                ? "bg-osu-pink/20 text-white"
                : "text-osu-l2 hover:text-white hover:bg-osu-b3/40"
            }`}
          >
            {entry}
          </button>
        ),
      )}
      <button
        type="button"
        onClick={() => onChange(page + 1)}
        disabled={!canNext}
        className="px-2.5 py-1 rounded-md text-[12px] font-medium text-osu-l2 hover:text-white hover:bg-osu-b3/40 transition-colors duration-[120ms] disabled:opacity-40 disabled:cursor-not-allowed cursor-pointer"
      >
        {loadingMore ? "…" : "›"}
      </button>
    </div>
  );
}

function Crumbs({
  roots,
  prefix,
  crumbs,
  onNavigate,
}: {
  roots: R2AdminRoot[];
  prefix: string;
  crumbs: Array<{ label: string; prefix: string }>;
  onNavigate: (prefix: string) => void;
}) {
  return (
    <div className="flex flex-wrap items-center gap-1 text-[12px] font-mono">
      {roots.map((root) => {
        const active = prefix.startsWith(root.prefix);
        return (
          <button
            key={root.prefix}
            type="button"
            onClick={() => onNavigate(root.prefix)}
            className={`px-2 py-0.5 rounded transition-colors duration-[120ms] cursor-pointer ${
              active
                ? "bg-osu-pink/15 text-white"
                : "text-osu-l2 hover:text-white hover:bg-osu-b3/40"
            }`}
          >
            {root.label}
          </button>
        );
      })}
      {crumbs.map((crumb, index) => {
        const isLast = index === crumbs.length - 1;
        return (
          <div key={crumb.prefix} className="flex items-center gap-0.5">
            <span className="text-osu-f1/60 px-0.5">/</span>
            <button
              type="button"
              onClick={() => onNavigate(crumb.prefix)}
              className={`px-2 py-0.5 rounded transition-colors duration-[120ms] cursor-pointer ${
                isLast
                  ? "bg-osu-pink/15 text-white"
                  : "text-osu-l2 hover:text-white hover:bg-osu-b3/40"
              }`}
            >
              {crumb.label}
            </button>
          </div>
        );
      })}
    </div>
  );
}

function SearchInput({ value, onChange }: { value: string; onChange: (next: string) => void }) {
  return (
    <div className="relative flex-1 min-w-0">
      <svg
        viewBox="0 0 24 24"
        className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-osu-f1"
        fill="none"
        stroke="currentColor"
        strokeWidth="2.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <circle cx="11" cy="11" r="7" />
        <path d="m20 20-3.5-3.5" />
      </svg>
      <input
        value={value}
        onChange={(event) => onChange(event.target.value)}
        className="w-full rounded-md bg-osu-b5/80 border border-osu-b3/30 py-2 pl-9 pr-3 text-[13px] text-white outline-none transition-colors duration-[120ms] placeholder:text-osu-f1/70 focus:border-osu-pink/40 cursor-text"
        placeholder="Search keys under this folder..."
      />
    </div>
  );
}

function SortToggles({
  sort,
  onToggle,
}: {
  sort: SortState;
  onToggle: (key: SortKey) => void;
}) {
  const items: Array<[SortKey, string]> = [
    ["name", "Name"],
    ["size", "Size"],
    ["modified", "Modified"],
  ];
  return (
    <div className="flex items-center gap-1 rounded-lg bg-osu-b4/40 border border-osu-b3/30 p-1">
      {items.map(([key, label]) => {
        const active = sort.key === key;
        return (
          <button
            key={key}
            type="button"
            onClick={() => onToggle(key)}
            className={`px-3 py-1.5 rounded-md text-[12px] font-medium transition-colors duration-[120ms] cursor-pointer flex items-center gap-1 ${
              active
                ? "bg-osu-pink/20 text-white"
                : "text-osu-l2 hover:text-white hover:bg-osu-b3/40"
            }`}
          >
            <span>{label}</span>
            {active ? (
              <span className="text-[10px] text-osu-pink-light font-mono">
                {sort.direction === "asc" ? "↑" : "↓"}
              </span>
            ) : null}
          </button>
        );
      })}
    </div>
  );
}

function ThumbnailToggle({ on, onToggle }: { on: boolean; onToggle: () => void }) {
  return (
    <button
      type="button"
      onClick={onToggle}
      title={on ? "Hide thumbnails" : "Show thumbnails"}
      className={`flex items-center gap-1.5 rounded-lg border px-3 py-1.5 text-[12px] font-medium transition-colors duration-[120ms] cursor-pointer ${
        on
          ? "border-osu-pink/30 bg-osu-pink/20 text-white"
          : "border-osu-b3/30 bg-osu-b4/40 text-osu-l2 hover:text-white"
      }`}
    >
      <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <rect x="3" y="3" width="18" height="18" rx="2" />
        <circle cx="9" cy="9" r="2" />
        <path d="m21 15-5-5L5 21" />
      </svg>
      <span>Thumbnails</span>
    </button>
  );
}

// skins/<id>/ folders hold one .osk plus preview images; those get a quick
// download so grabbing the archive doesn't need a trip into the folder.
function isSkinFolderPrefix(prefix: string): boolean {
  if (!prefix.startsWith("skins/")) return false;
  return prefix.replace(/\/+$/, "").split("/").length === 2;
}

function SkinOskDownloadButton({ prefix }: { prefix: string }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const download = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      const result = await signSkinOskDownload({ data: { prefix } });
      if (!result) {
        setError("No .osk in this folder.");
        return;
      }
      // The signed URL carries an attachment disposition, so a plain anchor
      // click saves the file instead of navigating away.
      const link = document.createElement("a");
      link.href = result.url;
      link.download = result.name;
      link.rel = "noreferrer noopener";
      document.body.appendChild(link);
      link.click();
      link.remove();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not sign the .osk URL.");
    } finally {
      setBusy(false);
    }
  }, [prefix]);

  return (
    <button
      type="button"
      onClick={() => void download()}
      disabled={busy}
      title={error ?? "Download .osk"}
      className={`inline-flex h-8 w-8 items-center justify-center rounded-md transition-colors duration-[120ms] cursor-pointer flex-shrink-0 disabled:opacity-50 disabled:cursor-not-allowed ${
        error
          ? "text-osu-red-light hover:bg-osu-red/15"
          : "text-osu-f1 hover:bg-osu-pink/15 hover:text-osu-pink-light"
      }`}
    >
      {busy ? (
        <span className="text-[13px] font-mono">…</span>
      ) : (
        <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M12 3v12" />
          <path d="m7 11 5 5 5-5" />
          <path d="M4 20h16" />
        </svg>
      )}
    </button>
  );
}

function FolderRow({
  folder,
  stats,
  downloadable,
  onOpen,
  onDelete,
}: {
  folder: R2AdminFolder;
  stats: R2AdminPrefixSummary | null;
  downloadable: boolean;
  onOpen: () => void;
  onDelete: () => void;
}) {
  return (
    <div className="flex items-center gap-3 px-3 py-2.5 hover:bg-osu-b3/20 transition-colors duration-[100ms]">
      <button
        type="button"
        onClick={onOpen}
        className="flex min-w-0 flex-1 items-center gap-3 text-left cursor-pointer"
      >
        <span className="flex h-12 w-12 shrink-0 items-center justify-center rounded-md bg-osu-yellow/15 text-osu-yellow">
          <svg viewBox="0 0 24 24" className="h-4 w-4" fill="currentColor">
            <path d="M3 6a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V6Z" />
          </svg>
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex items-baseline gap-2 flex-wrap">
            <span className="text-[14px] font-medium text-white truncate">
              {stats?.sampleName ?? folder.name}
            </span>
            <span className="text-[11px] text-osu-f1 font-mono shrink-0">
              {stats
                ? `${formatCount(stats.objectCount)}${stats.truncated ? "+" : ""} files · ${formatBytes(stats.sizeBytes)}`
                : <span className="text-osu-f1/40">counting…</span>}
            </span>
          </div>
          <div className="text-[11px] font-mono text-osu-f1/70 truncate mt-0.5">{folder.prefix}</div>
        </div>
        <span className="text-osu-f1/60 shrink-0 text-[14px]">›</span>
      </button>
      {downloadable ? <SkinOskDownloadButton prefix={folder.prefix} /> : null}
      <DeleteIconButton title="Delete folder" onClick={onDelete} />
    </div>
  );
}

function ObjectRow({
  object,
  description,
  showThumbnail,
  onPreview,
  onDelete,
}: {
  object: R2AdminObject;
  description: R2AdminObjectDescription | null;
  showThumbnail: boolean;
  onPreview: () => void;
  onDelete: () => void;
}) {
  const [thumbnailFailed, setThumbnailFailed] = useState(false);
  const { kind } = detectPreviewKind(object.name);
  const previewable = kind !== "other";
  const thumbnailUrl = showThumbnail && kind === "image" && !thumbnailFailed
    ? description?.url ?? null
    : null;
  const detail = description?.label ?? keyContext(object.key);
  const iconAccent = previewable
    ? "bg-osu-pink/15 text-osu-pink-light"
    : "bg-osu-b3/40 text-osu-l2";
  const Icon = (
    <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      {kind === "audio" ? (
        <>
          <path d="M9 18V5l12-2v13" />
          <circle cx="6" cy="18" r="3" />
          <circle cx="18" cy="16" r="3" />
        </>
      ) : kind === "image" ? (
        <>
          <rect x="3" y="3" width="18" height="18" rx="2" />
          <circle cx="9" cy="9" r="2" />
          <path d="m21 15-5-5L5 21" />
        </>
      ) : kind === "video" ? (
        <>
          <rect x="2" y="6" width="14" height="12" rx="2" />
          <path d="m22 8-6 4 6 4V8Z" />
        </>
      ) : (
        <>
          <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
          <path d="M14 2v6h6" />
        </>
      )}
    </svg>
  );

  return (
    <div className="flex items-center gap-3 px-3 py-2.5 hover:bg-osu-b3/20 transition-colors duration-[100ms]">
      <button
        type="button"
        onClick={onPreview}
        className="flex min-w-0 flex-1 items-center gap-3 text-left cursor-pointer"
        title={previewable ? object.name : object.key}
      >
        {thumbnailUrl ? (
          <span className="flex h-12 w-12 shrink-0 overflow-hidden rounded-md bg-osu-b3/30">
            <img
              src={thumbnailUrl}
              alt=""
              loading="lazy"
              decoding="async"
              onError={() => setThumbnailFailed(true)}
              className="h-full w-full object-cover"
            />
          </span>
        ) : (
          <span className={`flex h-12 w-12 shrink-0 items-center justify-center rounded-md ${iconAccent}`}>
            {Icon}
          </span>
        )}
        <div className="min-w-0 flex-1">
          <div className="flex items-baseline gap-2 flex-wrap">
            <span className="text-[14px] font-medium text-white truncate">
              {readableName(object.name)}
            </span>
            <span className="text-[11px] text-osu-f1 font-mono shrink-0">
              {formatBytes(object.sizeBytes)} · {formatDate(object.lastModified)}
              {detail ? ` · ${detail}` : ""}
            </span>
          </div>
          <div className="text-[11px] font-mono text-osu-f1/70 truncate mt-0.5">{object.key}</div>
        </div>
      </button>
      <DeleteIconButton title="Delete file" onClick={onDelete} />
    </div>
  );
}

function ReplayGlyph({ pulsing }: { pulsing?: boolean }) {
  return (
    <svg
      viewBox="0 0 24 24"
      className={`h-4 w-4 text-osu-pink-light ${pulsing ? "animate-pulse" : ""}`}
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <circle cx="12" cy="12" r="9" />
      <path d="M10 9l5 3-5 3z" fill="currentColor" stroke="none" />
    </svg>
  );
}

// Enriched row for uploaded .osr blobs: shows who played it and which score/map
// it is (parsed on demand), and links the whole row to the replay viewer. Falls
// back to the raw key when the replay can't be read.
function UploadedReplayRow({
  object,
  onDelete,
}: {
  object: R2AdminObject;
  onDelete: () => void;
}) {
  const state = useUploadedReplayDescription(object.key);
  const id = useMemo(() => uploadedReplayIdFromKey(object.key), [object.key]);

  const loading = state.status === "loading";
  const data = state.status === "ready" ? state.data : null;
  const beatmap = data?.beatmap ?? null;
  const watchHref = id ? `/replay?uploadId=${encodeURIComponent(id)}` : null;
  const mapLine = beatmap
    ? `${beatmap.artist ? `${beatmap.artist} - ` : ""}${beatmap.title || "(untitled)"}${beatmap.version ? ` [${beatmap.version}]` : ""}`
    : null;

  const content = (
    <>
      <span className="flex h-12 w-12 shrink-0 items-center justify-center rounded-md bg-osu-pink/10">
        {data ? <GradeImg grade={data.grade} size={30} /> : <ReplayGlyph pulsing={loading} />}
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline gap-2 flex-wrap">
          <span className={`text-[14px] font-medium truncate ${data ? "text-white" : "text-osu-l2"}`}>
            {data ? data.playerName : loading ? "Reading replay…" : object.name}
          </span>
          {data && data.mods.length > 0 ? (
            <span className="text-[11px] font-mono text-osu-pink-light shrink-0">+{data.mods.join("")}</span>
          ) : null}
          {data ? (
            <span className="text-[10px] font-mono text-osu-l2 px-1 rounded bg-osu-b3/40 shrink-0">
              {data.keyCount}K
            </span>
          ) : null}
          <span className="text-[11px] text-osu-f1 font-mono shrink-0">
            {formatBytes(object.sizeBytes)} · {formatDate(object.lastModified)}
          </span>
        </div>
        <div className="text-[12px] text-osu-l2 truncate mt-0.5">
          {mapLine ? (
            mapLine
          ) : loading ? (
            <span className="text-osu-f1/60">looking up map…</span>
          ) : data ? (
            <span className="text-osu-f1/60">map not on osu! (unsubmitted or deleted)</span>
          ) : (
            <span className="text-osu-f1/60">couldn't read replay metadata</span>
          )}
        </div>
        {data ? (
          <div className="text-[11px] font-mono text-osu-f1/70 truncate mt-0.5">
            {(data.accuracy * 100).toFixed(2)}% · {formatCount(data.totalScore)} · {formatCount(data.maxCombo)}x
            {data.judgements.miss > 0 ? ` · ${formatCount(data.judgements.miss)} miss` : ""}
            {beatmap?.starRating != null ? ` · ${beatmap.starRating.toFixed(2)}★` : ""}
          </div>
        ) : (
          <div className="text-[11px] font-mono text-osu-f1/50 truncate mt-0.5">{object.key}</div>
        )}
      </div>
      {watchHref ? <span className="text-osu-f1/50 shrink-0 text-[13px]">↗</span> : null}
    </>
  );

  return (
    <div className="flex items-center gap-3 px-3 py-2.5 hover:bg-osu-b3/20 transition-colors duration-[100ms]">
      {watchHref ? (
        <a
          href={watchHref}
          target="_blank"
          rel="noreferrer noopener"
          title="Watch replay"
          className="flex min-w-0 flex-1 items-center gap-3 text-left cursor-pointer"
        >
          {content}
        </a>
      ) : (
        <div className="flex min-w-0 flex-1 items-center gap-3">{content}</div>
      )}
      <DeleteIconButton title="Delete file" onClick={onDelete} />
    </div>
  );
}

function DeleteIconButton({ title, onClick }: { title: string; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      className="inline-flex h-8 w-8 items-center justify-center rounded-md text-osu-f1 hover:bg-osu-red/15 hover:text-osu-red-light transition-colors duration-[120ms] cursor-pointer flex-shrink-0"
    >
      <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M3 6h18" />
        <path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
        <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" />
      </svg>
    </button>
  );
}

function NotConfigured({ bucket }: { bucket: string }) {
  return (
    <div className="px-4 py-12 text-center">
      <div className="mx-auto flex h-9 w-9 items-center justify-center rounded-full bg-osu-yellow/15 text-osu-yellow">
        <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0Z" />
          <path d="M12 9v4" />
          <path d="M12 17h.01" />
        </svg>
      </div>
      <div className="mt-3 text-[12px] font-medium text-white">{bucket} is not configured</div>
      <div className="mt-1 text-[11px] text-osu-f1">
        Set the R2 environment variables to browse this bucket.
      </div>
    </div>
  );
}

function EmptyState({ text }: { text: string }) {
  return <div className="text-[11px] text-osu-f1 text-center py-10">{text}</div>;
}

function ErrorBanner({ message }: { message: string }) {
  return (
    <div className="rounded-lg border border-osu-red/30 bg-osu-red/10 px-4 py-3">
      <div className="text-[11px] font-semibold uppercase tracking-wider text-osu-red-light">
        R2 error
      </div>
      <div className="text-[12px] text-osu-l2 mt-1 break-words">{message}</div>
    </div>
  );
}

function PreviewDialog({
  bucket,
  object,
  onClose,
}: {
  bucket: R2AdminBucketId;
  object: R2AdminObject;
  onClose: () => void;
}) {
  const { kind, mimeType } = useMemo(() => detectPreviewKind(object.name), [object.name]);
  const [resolved, setResolved] = useState<R2AdminObjectUrl | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setResolved(null);
    setError(null);
    setCopied(false);
    resolveR2ObjectUrl({ data: { bucket, key: object.key, mimeType } })
      .then((result) => {
        if (!cancelled) setResolved(result);
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof Error ? err.message : "Could not resolve the object URL.");
      });
    return () => {
      cancelled = true;
    };
  }, [bucket, object.key, mimeType]);

  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [onClose]);

  const url = resolved?.url ?? null;

  return (
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center bg-black/65 px-4"
      onClick={onClose}
    >
      <div
        className="w-full max-w-[720px] rounded-lg border border-osu-b3/40 bg-osu-b5 shadow-2xl overflow-hidden"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="px-4 pt-3 pb-2 border-b border-osu-b3/20 flex items-center gap-3">
          <span className="block w-2 h-2 rounded-full bg-osu-pink-light flex-shrink-0" />
          <div className="min-w-0 flex-1">
            <div className="text-[11px] font-semibold text-osu-c2 uppercase tracking-wider">
              Preview
            </div>
            <div className="text-[12px] text-white truncate font-medium">{object.name}</div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="px-2.5 py-1 rounded-md bg-osu-b4/60 border border-osu-b3/30 text-[11px] text-osu-l2 hover:bg-osu-b3/60 hover:text-white transition-colors duration-[120ms] cursor-pointer"
          >
            Close
          </button>
        </div>

        <div className="p-4 space-y-3">
          <div className="rounded-md bg-osu-b4/60 border border-osu-b3/20 px-2.5 py-1.5 text-[10px] font-mono text-osu-l2 break-all">
            {object.key}
          </div>
          <div className="text-[11px] text-osu-f1 font-mono">
            {formatBytes(object.sizeBytes)} · {formatDate(object.lastModified)}
          </div>

          <div className="rounded-md bg-osu-b4/30 border border-osu-b3/20 p-3 min-h-[120px] flex items-center justify-center">
            {error ? (
              <div className="text-[11px] text-osu-red-light text-center">{error}</div>
            ) : !url ? (
              <div className="text-[11px] text-osu-f1">Resolving URL...</div>
            ) : kind === "audio" ? (
              <audio controls src={url} className="w-full" autoPlay />
            ) : kind === "image" ? (
              <img
                src={url}
                alt={object.name}
                className="max-w-full max-h-[60vh] rounded-md object-contain"
              />
            ) : kind === "video" ? (
              <video controls src={url} className="w-full max-h-[60vh] rounded-md" autoPlay />
            ) : (
              <div className="text-[11px] text-osu-f1 text-center">
                No inline preview for this file type.
              </div>
            )}
          </div>
        </div>

        <div className="px-4 py-3 border-t border-osu-b3/20 flex items-center justify-end gap-2">
          {url && resolved?.isPublic ? (
            <button
              type="button"
              onClick={() => {
                void navigator.clipboard?.writeText(url).then(() => setCopied(true)).catch(() => {});
              }}
              className="px-3 py-1.5 rounded-md bg-osu-b4/60 border border-osu-b3/30 text-[11px] font-medium text-osu-l2 hover:bg-osu-b3/60 hover:text-white transition-colors duration-[120ms] cursor-pointer"
            >
              {copied ? "Copied" : "Copy CDN URL"}
            </button>
          ) : null}
          {url ? (
            <a
              href={url}
              target="_blank"
              rel="noreferrer noopener"
              className="px-3 py-1.5 rounded-md bg-osu-pink/20 border border-osu-pink/30 text-[11px] font-medium text-osu-pink-light hover:bg-osu-pink/30 transition-colors duration-[120ms] cursor-pointer"
            >
              Open in new tab
            </a>
          ) : null}
        </div>
      </div>
    </div>
  );
}

function DeleteDialog({
  pending,
  warning,
  summary,
  summaryLoading,
  summaryError,
  confirmed,
  busy,
  onCancel,
  onConfirm,
}: {
  pending: PendingDelete;
  warning: string | null;
  summary: R2AdminPrefixSummary | null;
  summaryLoading: boolean;
  summaryError: string | null;
  confirmed: boolean;
  busy: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const [confirming, setConfirming] = useState(false);

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/65 px-4">
      <div className="w-full max-w-[480px] rounded-lg border border-osu-b3/40 bg-osu-b5 shadow-2xl overflow-hidden">
        <div className="px-4 pt-3 pb-2 border-b border-osu-b3/20 flex items-center gap-2">
          <span className="block w-2 h-2 rounded-full bg-osu-red-light flex-shrink-0" />
          <div className="text-[11px] font-semibold text-osu-c2 uppercase tracking-wider">
            Delete {pending.kind === "prefix" ? "folder" : "file"}
          </div>
        </div>

        <div className="p-4 space-y-3">
          <div className="text-[11px] text-osu-f1">
            {pending.kind === "prefix"
              ? "Recursively deletes every object under this prefix after the dry-run preview."
              : "Removes this object from R2."}
          </div>

          <div className="rounded-md bg-osu-b4/60 border border-osu-b3/20 px-2.5 py-1.5 text-[10px] font-mono text-osu-l2 break-all">
            {pending.kind === "prefix" ? pending.prefix : pending.key}
          </div>

          {warning ? (
            <div className="rounded-md border border-osu-yellow/25 bg-osu-yellow/10 px-2.5 py-2 text-[11px] text-osu-c2">
              {warning}
            </div>
          ) : null}

          {pending.kind === "prefix" ? (
            <div className="rounded-md bg-osu-b4/40 border border-osu-b3/20 px-2.5 py-2">
              <div className="text-[9px] uppercase tracking-wider text-osu-f1 font-semibold">
                Dry-run preview
              </div>
              <div className="mt-1 text-[12px] font-mono">
                {summaryLoading ? (
                  <span className="text-osu-f1">scanning...</span>
                ) : summaryError ? (
                  <span className="text-osu-red-light">{summaryError}</span>
                ) : summary ? (
                  <span className="text-white font-bold">
                    {formatCount(summary.objectCount)} files
                    <span className="text-osu-l2/70"> · </span>
                    {formatBytes(summary.sizeBytes)}
                    {summary.truncated ? <span className="text-osu-yellow/90"> (truncated)</span> : null}
                  </span>
                ) : (
                  <span className="text-osu-f1">—</span>
                )}
              </div>
            </div>
          ) : null}

          {confirming ? (
            <div className="rounded-md border border-osu-red/25 bg-osu-red/10 px-2.5 py-2 text-[11px] text-osu-c2">
              {pending.kind === "prefix"
                ? "Are you sure you want to delete this folder and every file shown in the preview?"
                : "Are you sure you want to delete this file?"}
            </div>
          ) : null}
        </div>

        <div className="px-4 py-3 border-t border-osu-b3/20 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
          <button
            type="button"
            onClick={onCancel}
            disabled={busy}
            className="px-3 py-1.5 rounded-md bg-osu-b4/60 border border-osu-b3/30 text-[11px] text-osu-l2 hover:bg-osu-b3/60 hover:text-white transition-colors duration-[120ms] disabled:opacity-50 disabled:cursor-not-allowed cursor-pointer"
          >
            {confirming ? "No, keep it" : "Cancel"}
          </button>
          <button
            type="button"
            onClick={confirming ? onConfirm : () => setConfirming(true)}
            disabled={busy || !confirmed}
            className="px-3 py-1.5 rounded-md bg-osu-red/20 border border-osu-red/30 text-[11px] font-medium text-osu-red-light hover:bg-osu-red/30 transition-colors duration-[120ms] disabled:opacity-40 disabled:cursor-not-allowed cursor-pointer"
          >
            {busy ? "Deleting..." : confirming ? "Yes, delete" : "Delete"}
          </button>
        </div>
      </div>
    </div>
  );
}
