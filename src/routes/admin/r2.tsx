import { createFileRoute, notFound, useNavigate } from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { canUseAdminFeatures } from "../../lib/auth-shared";
import { requireAdminAccess } from "../../lib/auth";
import {
  deleteR2AdminObject,
  deleteR2AdminPrefix,
  getR2AdminListing,
  getR2AdminPrefixSummary,
  getR2AdminSignedUrl,
  type R2AdminFolder,
  type R2AdminListing,
  type R2AdminObject,
  type R2AdminPrefixSummary,
} from "../../lib/r2-cache";

type R2Search = {
  prefix: string;
};

type PendingDelete =
  | { kind: "object"; key: string; name: string }
  | { kind: "prefix"; prefix: string; name: string };

type SortKey = "name" | "size" | "modified";
type SortDirection = "asc" | "desc";

const ROOT_PREFIX = "replay-cache/";
const PAGE_SIZE = 25;

const listR2Objects = createServerFn({ method: "GET" })
  .inputValidator((data: { prefix?: string; continuationToken?: string | null; query?: string }) => ({
    prefix: typeof data?.prefix === "string" ? data.prefix : ROOT_PREFIX,
    continuationToken: typeof data?.continuationToken === "string" ? data.continuationToken : null,
    query: typeof data?.query === "string" ? data.query : "",
  }))
  .handler(async ({ data }): Promise<R2AdminListing> => {
    await requireAdminAccess("R2 bucket management");
    return getR2AdminListing(data.prefix, data.continuationToken, data.query);
  });

const summarizeR2Prefix = createServerFn({ method: "GET" })
  .inputValidator((data: { prefix?: string }) => ({
    prefix: typeof data?.prefix === "string" ? data.prefix : "",
  }))
  .handler(async ({ data }): Promise<R2AdminPrefixSummary> => {
    await requireAdminAccess("R2 folder preview");
    return getR2AdminPrefixSummary(data.prefix);
  });

const signR2AdminUrl = createServerFn({ method: "GET" })
  .inputValidator((data: { key?: string; mimeType?: string }) => ({
    key: typeof data?.key === "string" ? data.key : "",
    mimeType: typeof data?.mimeType === "string" && data.mimeType ? data.mimeType : undefined,
  }))
  .handler(async ({ data }): Promise<{ url: string }> => {
    await requireAdminAccess("R2 object preview");
    const url = await getR2AdminSignedUrl(data.key, data.mimeType);
    return { url };
  });

const deleteR2Object = createServerFn({ method: "POST" })
  .inputValidator((data: { key?: string }) => ({
    key: typeof data?.key === "string" ? data.key : "",
  }))
  .handler(async ({ data }) => {
    await requireAdminAccess("R2 object deletion");
    return deleteR2AdminObject(data.key);
  });

const deleteR2Prefix = createServerFn({ method: "POST" })
  .inputValidator((data: { prefix?: string }) => ({
    prefix: typeof data?.prefix === "string" ? data.prefix : "",
  }))
  .handler(async ({ data }) => {
    await requireAdminAccess("R2 folder deletion");
    return deleteR2AdminPrefix(data.prefix);
  });

export const Route = createFileRoute("/admin/r2")({
  validateSearch: (search: Record<string, unknown>): R2Search => ({
    prefix: typeof search.prefix === "string" && search.prefix.trim()
      ? search.prefix.trim()
      : ROOT_PREFIX,
  }),
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

function compareFolders(a: R2AdminFolder, b: R2AdminFolder, sortKey: SortKey): number {
  if (sortKey === "size") return a.sizeBytes - b.sizeBytes;
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

function pathCrumbs(prefix: string): Array<{ label: string; prefix: string }> {
  const parts = prefix.replace(/\/+$/, "").split("/").filter(Boolean);
  const crumbs = [{ label: "replay-cache", prefix: ROOT_PREFIX }];
  if (parts[0] !== "replay-cache") return crumbs;

  let current = "replay-cache/";
  for (const part of parts.slice(1)) {
    current += `${part}/`;
    crumbs.push({ label: part, prefix: current });
  }
  return crumbs;
}

function R2AdminPage() {
  const search = Route.useSearch();
  const navigate = useNavigate();
  const [listing, setListing] = useState<R2AdminListing | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [pendingDelete, setPendingDelete] = useState<PendingDelete | null>(null);
  const [queryInput, setQueryInput] = useState("");
  const [query, setQuery] = useState("");
  const [sortKey, setSortKey] = useState<SortKey>("name");
  const [sortDirection, setSortDirection] = useState<SortDirection>("asc");
  const [prefixSummary, setPrefixSummary] = useState<R2AdminPrefixSummary | null>(null);
  const [prefixSummaryLoading, setPrefixSummaryLoading] = useState(false);
  const [prefixSummaryError, setPrefixSummaryError] = useState<string | null>(null);
  const [deleteBusy, setDeleteBusy] = useState(false);
  const [fetchedAt, setFetchedAt] = useState<number | null>(null);
  const [page, setPage] = useState(1);
  const [preview, setPreview] = useState<R2AdminObject | null>(null);
  const requestIdRef = useRef(0);

  const prefix = search.prefix || ROOT_PREFIX;
  const crumbs = useMemo(() => pathCrumbs(prefix), [prefix]);
  const deleteReady = pendingDelete?.kind !== "prefix" || (
    !!prefixSummary &&
    !prefixSummaryLoading &&
    !prefixSummaryError
  );

  useEffect(() => {
    const timeout = window.setTimeout(() => {
      setQuery(queryInput.trim());
    }, 250);
    return () => window.clearTimeout(timeout);
  }, [queryInput]);

  const load = useCallback(async (token: string | null, append: boolean) => {
    const requestId = ++requestIdRef.current;
    if (append) {
      setLoadingMore(true);
    } else {
      setLoading(true);
    }
    setError(null);

    try {
      const next = await listR2Objects({ data: { prefix, continuationToken: token, query } });
      if (requestId !== requestIdRef.current) return;
      setListing((previous) => append && previous ? mergeListing(previous, next) : next);
      setFetchedAt(Date.now());
    } catch (err) {
      if (requestId !== requestIdRef.current) return;
      setError(err instanceof Error ? err.message : "Could not load R2 objects.");
    } finally {
      if (requestId !== requestIdRef.current) return;
      setLoading(false);
      setLoadingMore(false);
    }
  }, [prefix, query]);

  useEffect(() => {
    setListing(null);
    setPage(1);
    void load(null, false);
  }, [load]);

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
    summarizeR2Prefix({ data: { prefix: pendingDelete.prefix } })
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
    setQueryInput("");
    setQuery("");
    navigate({
      to: "/admin/r2",
      search: { prefix: nextPrefix },
    });
  }, [navigate]);

  const toggleSort = useCallback((nextKey: SortKey) => {
    setPage(1);
    setSortKey((currentKey) => {
      if (currentKey !== nextKey) {
        setSortDirection(nextKey === "modified" || nextKey === "size" ? "desc" : "asc");
        return nextKey;
      }
      setSortDirection((currentDirection) => currentDirection === "asc" ? "desc" : "asc");
      return currentKey;
    });
  }, []);

  const confirmDelete = useCallback(async () => {
    if (!pendingDelete || !deleteReady) return;
    setDeleteBusy(true);
    setError(null);
    try {
      if (pendingDelete.kind === "object") {
        await deleteR2Object({ data: { key: pendingDelete.key } });
      } else {
        await deleteR2Prefix({ data: { prefix: pendingDelete.prefix } });
      }
      setPendingDelete(null);
      setPrefixSummary(null);
      await load(null, false);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Delete failed.");
    } finally {
      setDeleteBusy(false);
    }
  }, [deleteReady, load, pendingDelete]);

  const sortedFolders = useMemo(() => {
    const direction = sortDirection === "asc" ? 1 : -1;
    return [...(listing?.folders ?? [])].sort((a, b) => compareFolders(a, b, sortKey) * direction);
  }, [listing?.folders, sortDirection, sortKey]);
  const sortedObjects = useMemo(() => {
    const direction = sortDirection === "asc" ? 1 : -1;
    return [...(listing?.objects ?? [])].sort((a, b) => compareObjects(a, b, sortKey) * direction);
  }, [listing?.objects, sortDirection, sortKey]);

  const totalItems = sortedFolders.length + sortedObjects.length;
  const hasMoreOnServer = !!listing?.nextContinuationToken;
  const pageCount = Math.max(1, Math.ceil(totalItems / PAGE_SIZE));
  const safePage = Math.min(page, pageCount);
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

  const wantedItemsForPage = page * PAGE_SIZE;
  useEffect(() => {
    if (!listing?.configured) return;
    if (loading || loadingMore) return;
    if (!hasMoreOnServer) return;
    if (totalItems >= wantedItemsForPage) return;
    void load(listing.nextContinuationToken, true);
  }, [listing, loading, loadingMore, hasMoreOnServer, totalItems, wantedItemsForPage, load]);

  return (
    <div className="flex-1">
      <R2Header
        fetchedAt={fetchedAt}
        refreshing={loading}
        onRefresh={() => void load(null, false)}
      />
      <div className="bg-osu-b5 min-h-[calc(100vh-60px)]">
        <div className="max-w-[1200px] mx-auto px-4 sm:px-5 py-5 space-y-5">
          {error ? <ErrorBanner message={error} /> : null}

          <SectionCard
            title="Bucket browser"
            subtitle={listing?.bucket ? `bucket: ${listing.bucket}` : "browse and prune cached objects"}
            right={<Crumbs crumbs={crumbs} onNavigate={goToPrefix} />}
          >
            <div className="flex flex-col gap-3 lg:flex-row lg:items-center">
              <SearchInput value={queryInput} onChange={setQueryInput} />
              <SortToggles sortKey={sortKey} sortDirection={sortDirection} onToggle={toggleSort} />
            </div>

            <div className="mt-3 rounded-md border border-osu-b3/20 bg-osu-b5/60 overflow-hidden">
              {listing && !listing.configured ? (
                <NotConfigured />
              ) : loading && !listing ? (
                <EmptyState text="Loading R2 objects..." />
              ) : empty ? (
                <EmptyState text={query ? "No matching objects in this scan window." : "This folder is empty."} />
              ) : (
                <div className="divide-y divide-osu-b3/20">
                  {pageFolders.map((folder) => (
                    <FolderRow
                      key={folder.prefix}
                      folder={folder}
                      onOpen={() => goToPrefix(folder.prefix)}
                      onDelete={() => setPendingDelete({ kind: "prefix", prefix: folder.prefix, name: folder.name })}
                    />
                  ))}
                  {pageObjects.map((object) => (
                    <ObjectRow
                      key={object.key}
                      object={object}
                      onPreview={() => setPreview(object)}
                      onDelete={() => setPendingDelete({ kind: "object", key: object.key, name: object.name })}
                    />
                  ))}
                </div>
              )}
            </div>

            {listing?.configured ? (
              <div className="mt-3 flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                <div className="text-[11px] text-osu-f1 font-mono">
                  {query
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
          </SectionCard>
        </div>
      </div>

      {preview ? (
        <PreviewDialog object={preview} onClose={() => setPreview(null)} />
      ) : null}

      {pendingDelete ? (
        <DeleteDialog
          pending={pendingDelete}
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

function R2Header({
  fetchedAt,
  refreshing,
  onRefresh,
}: {
  fetchedAt: number | null;
  refreshing: boolean;
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
          {refreshing ? (
            <span className="absolute inset-0 rounded-full bg-osu-yellow animate-ping opacity-75" />
          ) : null}
        </div>
        <h2 className="text-[13px] sm:text-[15px] font-medium text-osu-c2">R2 bucket</h2>
        <span className="text-[9px] font-semibold uppercase tracking-wider px-1.5 py-0.5 rounded bg-osu-yellow/15 text-osu-yellow">
          dev
        </span>
        <div className="ml-auto flex items-center gap-3 text-[11px] text-osu-f1">
          {fetchedAt ? (
            <span className={refreshing ? "text-osu-pink-light" : ""}>
              {refreshing ? "refreshing..." : age != null ? `updated ${age}s ago` : ""}
            </span>
          ) : null}
          <button
            onClick={onRefresh}
            disabled={refreshing}
            className="px-2.5 py-1 rounded-md bg-osu-b4/60 border border-osu-b3/30 text-osu-l2 hover:bg-osu-b3/60 hover:text-white transition-colors duration-[120ms] disabled:opacity-50 disabled:cursor-not-allowed cursor-pointer"
          >
            Refresh
          </button>
        </div>
      </div>
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

function SectionCard({
  title,
  subtitle,
  right,
  children,
}: {
  title: string;
  subtitle?: string;
  right?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div className="rounded-lg border border-osu-b3/30 bg-osu-b4/30 overflow-hidden">
      <div className="px-4 pt-3 pb-2 border-b border-osu-b3/20 flex items-start gap-3">
        <div className="min-w-0 flex-1">
          <div className="text-[11px] font-semibold text-osu-c2 uppercase tracking-wider">{title}</div>
          {subtitle ? <div className="text-[10px] text-osu-f1 mt-0.5 truncate">{subtitle}</div> : null}
        </div>
        {right ? <div className="flex-shrink-0">{right}</div> : null}
      </div>
      <div className="p-3">{children}</div>
    </div>
  );
}

function Crumbs({
  crumbs,
  onNavigate,
}: {
  crumbs: Array<{ label: string; prefix: string }>;
  onNavigate: (prefix: string) => void;
}) {
  return (
    <div className="flex flex-wrap items-center gap-0.5 text-[12px] font-mono">
      {crumbs.map((crumb, index) => {
        const isLast = index === crumbs.length - 1;
        return (
          <div key={crumb.prefix} className="flex items-center gap-0.5">
            {index > 0 ? <span className="text-osu-f1/60 px-0.5">/</span> : null}
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
  sortKey,
  sortDirection,
  onToggle,
}: {
  sortKey: SortKey;
  sortDirection: SortDirection;
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
        const active = sortKey === key;
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
                {sortDirection === "asc" ? "↑" : "↓"}
              </span>
            ) : null}
          </button>
        );
      })}
    </div>
  );
}

function FolderRow({
  folder,
  onOpen,
  onDelete,
}: {
  folder: R2AdminFolder;
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
        <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md bg-osu-yellow/15 text-osu-yellow">
          <svg viewBox="0 0 24 24" className="h-4 w-4" fill="currentColor">
            <path d="M3 6a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V6Z" />
          </svg>
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex items-baseline gap-2 flex-wrap">
            <span className="text-[14px] font-medium text-white truncate">{folder.name}</span>
            <span className="text-[11px] text-osu-f1 font-mono shrink-0">
              {formatCount(folder.objectCount)}{folder.statsTruncated ? "+" : ""} files · {formatBytes(folder.sizeBytes)}
            </span>
          </div>
          <div className="text-[11px] font-mono text-osu-f1/70 truncate mt-0.5">{folder.prefix}</div>
        </div>
        <span className="text-osu-f1/60 shrink-0 text-[14px]">›</span>
      </button>
      <DeleteIconButton title="Delete folder" onClick={onDelete} />
    </div>
  );
}

function ObjectRow({
  object,
  onPreview,
  onDelete,
}: {
  object: R2AdminObject;
  onPreview: () => void;
  onDelete: () => void;
}) {
  const { kind } = detectPreviewKind(object.name);
  const previewable = kind !== "other";
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
        title={previewable ? "Preview" : "Open"}
      >
        <span className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-md ${iconAccent}`}>
          {Icon}
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex items-baseline gap-2 flex-wrap">
            <span className="text-[14px] font-medium text-white truncate">{object.name}</span>
            <span className="text-[11px] text-osu-f1 font-mono shrink-0">
              {formatBytes(object.sizeBytes)} · {formatDate(object.lastModified)}
            </span>
          </div>
          <div className="text-[11px] font-mono text-osu-f1/70 truncate mt-0.5">{object.key}</div>
        </div>
      </button>
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

function NotConfigured() {
  return (
    <div className="px-4 py-12 text-center">
      <div className="mx-auto flex h-9 w-9 items-center justify-center rounded-full bg-osu-yellow/15 text-osu-yellow">
        <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0Z" />
          <path d="M12 9v4" />
          <path d="M12 17h.01" />
        </svg>
      </div>
      <div className="mt-3 text-[12px] font-medium text-white">R2 is not configured</div>
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

function PreviewDialog({ object, onClose }: { object: R2AdminObject; onClose: () => void }) {
  const { kind, mimeType } = useMemo(() => detectPreviewKind(object.name), [object.name]);
  const [url, setUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setUrl(null);
    setError(null);
    signR2AdminUrl({ data: { key: object.key, mimeType } })
      .then((result) => {
        if (!cancelled) setUrl(result.url);
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof Error ? err.message : "Could not sign URL.");
      });
    return () => {
      cancelled = true;
    };
  }, [object.key, mimeType]);

  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [onClose]);

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
              <div className="text-[11px] text-osu-f1">Signing URL...</div>
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

        <div className="px-4 py-3 border-t border-osu-b3/20 flex justify-end">
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
  summary,
  summaryLoading,
  summaryError,
  confirmed,
  busy,
  onCancel,
  onConfirm,
}: {
  pending: PendingDelete;
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

          {pending.kind === "prefix" ? (
            <>
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
            </>
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
