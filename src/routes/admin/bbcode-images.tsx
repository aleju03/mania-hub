import { createFileRoute, notFound } from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Skeleton } from "../../components/ui/LoadingSkeleton";
import { canUseAdminFeatures } from "../../lib/auth-shared";
import { requireAdminAccess } from "../../lib/auth";
import {
  auditBbcodeImages,
  checkBbcodeUploaderProfile,
  deleteUnusedBbcodeImages,
  type BbcodeImageAudit,
  type BbcodeImageRow,
  type BbcodeImageStatus,
  type BbcodeUploader,
} from "../../lib/bbcode-image-audit";

export const Route = createFileRoute("/admin/bbcode-images")({
  head: () => ({
    meta: [
      { title: "BBCode images - admin" },
      { name: "robots", content: "noindex, nofollow" },
    ],
  }),
  beforeLoad: ({ context }) => {
    if (!canUseAdminFeatures(context.auth)) {
      throw notFound();
    }
    return undefined as never;
  },
  component: BbcodeImagesAdminPage,
});

const runAudit = createServerFn({ method: "GET" })
  .validator((data?: { fresh?: boolean }) => ({ fresh: data?.fresh === true }))
  .handler(async ({ data }): Promise<BbcodeImageAudit> => {
    await requireAdminAccess("BBCode image storage");
    return auditBbcodeImages({ fresh: data.fresh });
  });

/** One osu! call, for one uploader, because somebody pressed a button. */
const checkUploader = createServerFn({ method: "POST" })
  .validator((data: { userId?: number }) => {
    const userId = Number(data?.userId);
    if (!Number.isSafeInteger(userId) || userId <= 0) throw new Error("Invalid user id.");
    return { userId };
  })
  .handler(async ({ data }): Promise<BbcodeImageAudit> => {
    await requireAdminAccess("BBCode image profile check");
    return checkBbcodeUploaderProfile(data.userId);
  });

const deleteImages = createServerFn({ method: "POST" })
  .validator((data: { keys?: string[] }) => ({
    keys: Array.isArray(data?.keys)
      ? data.keys.filter((entry): entry is string => typeof entry === "string")
      : [],
  }))
  .handler(async ({ data }) => {
    await requireAdminAccess("BBCode image deletion");
    return deleteUnusedBbcodeImages(data.keys);
  });

const STATUS_FILTERS = ["all", "unused", "in-use", "unknown"] as const;
type StatusFilter = (typeof STATUS_FILTERS)[number];

const STATUS_LABEL: Record<BbcodeImageStatus, string> = {
  "in-use": "on a profile",
  unused: "unused",
  unknown: "unchecked",
};

const STATUS_CLASS: Record<BbcodeImageStatus, string> = {
  "in-use": "bg-osu-h1/20 text-osu-c1",
  unused: "bg-osu-yellow/15 text-osu-yellow",
  unknown: "bg-osu-b4/60 text-osu-f1",
};

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** The header time, so a listing that was reused rather than re-walked shows it. */
function formatTime(iso: string): string {
  return new Date(iso).toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit" });
}

function formatDate(iso: string | null): string {
  if (!iso) return "unknown date";
  return new Date(iso).toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric" });
}

function BbcodeImagesAdminPage() {
  const [audit, setAudit] = useState<BbcodeImageAudit | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [filter, setFilter] = useState<StatusFilter>("all");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [confirming, setConfirming] = useState(false);
  const [checkingId, setCheckingId] = useState<number | null>(null);
  const [sweep, setSweep] = useState<{ done: number; total: number } | null>(null);
  const stopSweep = useRef(false);

  /** Takes a new audit, dropping ticks for anything it no longer calls unused. */
  const applyAudit = useCallback((result: BbcodeImageAudit) => {
    setAudit(result);
    // A key that just vanished (or turned out to be in use) must not stay
    // ticked behind a filter where nobody can see it.
    setSelected((current) => {
      const stillDeletable = new Set(
        result.objects.filter((row) => row.status === "unused").map((row) => row.key),
      );
      return new Set([...current].filter((key) => stillDeletable.has(key)));
    });
  }, []);

  const load = useCallback(async (fresh = false) => {
    setLoading(true);
    setError(null);
    try {
      applyAudit(await runAudit({ data: { fresh } }));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [applyAudit]);

  useEffect(() => {
    void load();
  }, [load]);

  const usernameFor = useCallback(
    (userId: number | null): string | null => {
      if (userId === null) return null;
      return audit?.uploaders.find((uploader) => uploader.userId === userId)?.username ?? null;
    },
    [audit],
  );

  const checkOne = useCallback(async (userId: number): Promise<boolean> => {
    setCheckingId(userId);
    setError(null);
    try {
      applyAudit(await checkUploader({ data: { userId } }));
      return true;
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      return false;
    } finally {
      setCheckingId(null);
    }
  }, [applyAudit]);

  /**
   * Checks the uploaders that need it, strictly one request at a time.
   *
   * Sequential is the whole point: the site shares an osu! budget of ~45
   * calls/minute, and this way the page never has more than one of them in
   * flight, and can be stopped between any two.
   */
  const checkAll = useCallback(async (targets: BbcodeUploader[]) => {
    stopSweep.current = false;
    setSweep({ done: 0, total: targets.length });
    setMessage(null);
    for (const [index, uploader] of targets.entries()) {
      if (stopSweep.current) {
        setMessage(`Stopped after ${index} of ${targets.length}.`);
        break;
      }
      const ok = await checkOne(uploader.userId);
      setSweep({ done: index + 1, total: targets.length });
      if (!ok) {
        setMessage(`Stopped at ${uploader.username ?? `#${uploader.userId}`}; the rest are still unchecked.`);
        break;
      }
    }
    setSweep(null);
  }, [checkOne]);

  const rows = useMemo(() => {
    const all = audit?.objects ?? [];
    return filter === "all" ? all : all.filter((row) => row.status === filter);
  }, [audit, filter]);

  const selectedRows = useMemo(
    () => (audit?.objects ?? []).filter((row) => selected.has(row.key)),
    [audit, selected],
  );
  const selectedBytes = selectedRows.reduce((sum, row) => sum + row.sizeBytes, 0);

  const toggle = (key: string) => {
    setConfirming(false);
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const selectAllUnused = () => {
    setConfirming(false);
    const unused = (audit?.objects ?? []).filter((row) => row.status === "unused").map((row) => row.key);
    setSelected((current) => (current.size === unused.length ? new Set() : new Set(unused)));
  };

  const runDelete = async () => {
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      const result = await deleteImages({ data: { keys: [...selected] } });
      const parts: string[] = [];
      if (result.deleted.length > 0) {
        parts.push(`Deleted ${result.deleted.length} image${result.deleted.length > 1 ? "s" : ""}, freeing ${formatBytes(result.freedBytes)}.`);
      }
      for (const refusal of result.refused) {
        parts.push(`Kept ${refusal.key.replace("bbcode/", "")}: ${refusal.reason}.`);
      }
      setMessage(parts.join(" ") || "Nothing to delete.");
      setConfirming(false);
      setSelected(new Set());
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const counts = useMemo(() => {
    const all = audit?.objects ?? [];
    return {
      all: all.length,
      unused: all.filter((row) => row.status === "unused").length,
      "in-use": all.filter((row) => row.status === "in-use").length,
      unknown: all.filter((row) => row.status === "unknown").length,
    } satisfies Record<StatusFilter, number>;
  }, [audit]);

  const uploaders = audit?.uploaders ?? [];
  const needChecking = uploaders.filter((uploader) => uploader.state !== "checked");
  const anyBusy = loading || busy || checkingId !== null || sweep !== null;
  const pending = audit ? audit.coverage.total - audit.coverage.checked : 0;
  const checkedUploaderIds = useMemo(
    () => new Set(uploaders.filter((uploader) => uploader.state === "checked").map((uploader) => uploader.userId)),
    [uploaders],
  );

  return (
    <div className="flex-1">
      <div className="bg-osu-d5 border-b border-osu-b3/40">
        <div className="max-w-[1200px] mx-auto px-4 sm:px-5 py-3 flex items-center gap-3">
          <div className="relative flex-shrink-0">
            <span className="block w-2.5 h-2.5 rounded-full bg-osu-yellow" />
            {loading || busy ? (
              <span className="absolute inset-0 rounded-full bg-osu-yellow animate-ping opacity-75" />
            ) : null}
          </div>
          <h2 className="text-[13px] sm:text-[15px] font-medium text-osu-c2">BBCode images</h2>
          <div className="ml-auto flex items-center gap-3 text-[11px] text-osu-f1">
            {audit ? <span>listed {formatTime(audit.scannedAt)}</span> : null}
            <button
              onClick={() => void load(true)}
              disabled={anyBusy}
              className="px-2.5 py-1 rounded-md bg-osu-b4/60 border border-osu-b3/30 text-osu-l2 hover:bg-osu-b3/60 hover:text-white transition-colors duration-[120ms] disabled:opacity-50 disabled:cursor-not-allowed cursor-pointer"
            >
              Re-scan
            </button>
          </div>
        </div>
      </div>

      <div className="bg-osu-b5 min-h-[calc(100vh-60px)]">
        <div className="max-w-[1200px] mx-auto px-4 sm:px-5 py-5 space-y-4">
          {error ? (
            <div className="rounded-md border border-osu-red/40 bg-osu-red/10 px-3 py-2 text-[12px] text-osu-red-light">
              {error}
            </div>
          ) : null}
          {message ? (
            <div className="rounded-md border border-osu-b3/30 bg-osu-b4/40 px-3 py-2 text-[12px] text-osu-l2">
              {message}
            </div>
          ) : null}

          {!audit && loading ? <AuditSkeleton /> : null}

          {audit && !audit.configured ? (
            <div className="rounded-md border border-osu-b3/20 bg-osu-b5/60 px-4 py-8 text-center text-[13px] text-osu-f1">
              The public image bucket is not configured here.
            </div>
          ) : null}

          {audit?.configured ? (
            <>
              <div className="flex flex-wrap items-baseline gap-x-6 gap-y-2">
                <Stat value={String(audit.totals.objects)} label="images" />
                <Stat value={formatBytes(audit.totals.bytes)} label="stored" />
                <Stat value={String(audit.totals.unusedObjects)} label="unused" />
                <Stat value={formatBytes(audit.totals.unusedBytes)} label="reclaimable" />
              </div>

              {uploaders.length > 0 ? (
                <div className="space-y-2">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-[12px] text-osu-l2">
                      {audit.coverage.checked} of {audit.coverage.total} uploaders checked
                    </span>
                    <span className="text-[11px] text-osu-f1">
                      one osu! request each; an image counts as unused only once all of them are
                    </span>
                    {sweep ? (
                      <button
                        type="button"
                        onClick={() => { stopSweep.current = true; }}
                        className="ml-auto px-2.5 py-1 rounded-md bg-osu-b4/60 border border-osu-b3/30 text-[12px] text-osu-l2 hover:text-white transition-colors duration-[120ms] cursor-pointer"
                      >
                        Stop ({sweep.done}/{sweep.total})
                      </button>
                    ) : (
                      <button
                        type="button"
                        onClick={() => void checkAll(needChecking)}
                        disabled={anyBusy || needChecking.length === 0}
                        className="ml-auto px-2.5 py-1 rounded-md bg-osu-b4/60 border border-osu-b3/30 text-[12px] text-osu-l2 hover:text-white transition-colors duration-[120ms] disabled:opacity-40 disabled:cursor-not-allowed cursor-pointer"
                      >
                        Check {needChecking.length > 0 ? `${needChecking.length} remaining` : "all"}
                      </button>
                    )}
                  </div>

                  <div className="flex flex-wrap gap-1.5">
                    {uploaders.map((uploader) => (
                      <UploaderChip
                        key={uploader.userId}
                        uploader={uploader}
                        checking={checkingId === uploader.userId}
                        disabled={anyBusy}
                        onCheck={() => void checkOne(uploader.userId)}
                      />
                    ))}
                  </div>
                </div>
              ) : null}

              <div className="flex flex-wrap items-center gap-2">
                {STATUS_FILTERS.map((option) => (
                  <button
                    key={option}
                    type="button"
                    onClick={() => setFilter(option)}
                    className={`px-2.5 py-1 rounded-md text-[12px] font-semibold transition-colors duration-[120ms] cursor-pointer ${
                      filter === option
                        ? "bg-osu-pink/20 text-osu-c1"
                        : "bg-osu-b4/40 text-osu-f1 hover:text-osu-c1"
                    }`}
                  >
                    {option === "all" ? "All" : option === "in-use" ? "On a profile" : option === "unused" ? "Unused" : "Unchecked"}
                    <span className="ml-1.5 opacity-60">{counts[option]}</span>
                  </button>
                ))}
                <button
                  type="button"
                  onClick={selectAllUnused}
                  disabled={counts.unused === 0}
                  className="ml-auto px-2.5 py-1 rounded-md bg-osu-b4/60 border border-osu-b3/30 text-[12px] text-osu-l2 hover:text-white transition-colors duration-[120ms] disabled:opacity-40 disabled:cursor-not-allowed cursor-pointer"
                >
                  Select all unused
                </button>
              </div>

              <div className="rounded-md border border-osu-b3/20 bg-osu-b5/60 overflow-hidden">
                {rows.length === 0 ? (
                  <Empty text="Nothing here." />
                ) : (
                  <div className="divide-y divide-osu-b3/20">
                    {rows.map((row) => (
                      <ImageRow
                        key={row.key}
                        row={row}
                        checked={selected.has(row.key)}
                        pending={pending}
                        ownerChecked={row.uploaderId !== null && checkedUploaderIds.has(row.uploaderId)}
                        onToggle={() => toggle(row.key)}
                        usernameFor={usernameFor}
                      />
                    ))}
                  </div>
                )}
              </div>

              {audit.truncated ? (
                <p className="text-[11px] text-osu-f1">
                  The scan stopped early; some images are not listed.
                </p>
              ) : null}
            </>
          ) : null}
        </div>
      </div>

      {selected.size > 0 ? (
        <div className="sticky bottom-0 border-t border-osu-b3/40 bg-osu-d5">
          <div className="max-w-[1200px] mx-auto px-4 sm:px-5 py-3 flex flex-wrap items-center gap-3">
            <span className="text-[12px] text-osu-l2">
              {selected.size} selected, {formatBytes(selectedBytes)}
            </span>
            <div className="ml-auto flex items-center gap-2">
              <button
                type="button"
                onClick={() => { setSelected(new Set()); setConfirming(false); }}
                disabled={busy}
                className="px-3 py-1.5 rounded-md text-[12px] font-semibold text-osu-l2 hover:text-osu-c1 cursor-pointer disabled:opacity-50"
              >
                Clear
              </button>
              <button
                type="button"
                onClick={() => (confirming ? void runDelete() : setConfirming(true))}
                disabled={busy}
                className="px-3 py-1.5 rounded-md bg-osu-red/20 border border-osu-red/40 text-[12px] font-semibold text-osu-red-light hover:bg-osu-red/30 transition-colors duration-[120ms] cursor-pointer disabled:opacity-50"
              >
                {busy ? "Deleting..." : confirming ? "Yes, delete" : "Delete"}
              </button>
            </div>
            {confirming ? (
              <p className="w-full text-[11px] text-osu-f1">
                There is no other copy of these files, and any profile that embeds one would break. Each is re-judged
                server side, against a fresh listing and the checks you ran, before it goes.
              </p>
            ) : null}
          </div>
        </div>
      ) : null}
    </div>
  );
}

/** Mirrors the loaded layout (stats, filters, rows) so nothing jumps on arrival. */
function AuditSkeleton() {
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-baseline gap-x-6 gap-y-2">
        {["w-[64px]", "w-[72px]", "w-[56px]", "w-[80px]"].map((width) => (
          <Skeleton key={width} className={`h-[20px] ${width}`} />
        ))}
      </div>

      <div className="flex flex-wrap items-center gap-2">
        {["w-[52px]", "w-[74px]", "w-[82px]", "w-[86px]"].map((width) => (
          <Skeleton key={width} className={`h-[26px] rounded-md ${width}`} />
        ))}
        <Skeleton className="ml-auto h-[26px] w-[112px] rounded-md" />
      </div>

      <div className="rounded-md border border-osu-b3/20 bg-osu-b5/60 overflow-hidden">
        <div className="divide-y divide-osu-b3/20">
          {Array.from({ length: 6 }, (_, index) => (
            <div key={index} className="flex items-center gap-3 px-3 py-2.5">
              <Skeleton className="h-4 w-4 flex-shrink-0" />
              <Skeleton className="h-12 w-12 flex-shrink-0 rounded-md" />
              <div className="min-w-0 flex-1 space-y-1.5">
                <Skeleton className="h-[17px] w-[92px] rounded" />
                <Skeleton className="h-[13px] w-[220px] max-w-full" />
              </div>
              <div className="flex flex-shrink-0 flex-col items-end gap-1.5">
                <Skeleton className="h-[13px] w-[46px]" />
                <Skeleton className="h-[13px] w-[132px]" />
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

const UPLOADER_STATE_CLASS: Record<BbcodeUploader["state"], string> = {
  checked: "bg-osu-h1/15 text-osu-c1 border-osu-h1/30",
  unchecked: "bg-osu-b4/40 text-osu-f1 border-osu-b3/30",
  expired: "bg-osu-b4/40 text-osu-l2 border-osu-b3/30",
  failed: "bg-osu-red/10 text-osu-red-light border-osu-red/30",
};

/** One uploader, and the button that spends one osu! request on them. */
function UploaderChip({
  uploader,
  checking,
  disabled,
  onCheck,
}: {
  uploader: BbcodeUploader;
  checking: boolean;
  disabled: boolean;
  onCheck: () => void;
}) {
  const name = uploader.username ?? `#${uploader.userId}`;
  const detail = checking
    ? "checking..."
    : uploader.state === "checked"
      ? `${uploader.usedCount}/${uploader.uploadCount} in use`
      : uploader.state === "expired"
        ? "expired"
        : uploader.state === "failed"
          ? "failed"
          : `${uploader.uploadCount} image${uploader.uploadCount > 1 ? "s" : ""}`;

  return (
    <button
      type="button"
      onClick={onCheck}
      disabled={disabled}
      title={uploader.error ?? (uploader.checkedAt ? `Checked ${formatTime(uploader.checkedAt)}` : "Not checked yet")}
      className={`flex items-center gap-1.5 px-2 py-1 rounded-md border text-[12px] transition-colors duration-[120ms] cursor-pointer disabled:cursor-not-allowed ${
        checking ? "opacity-60" : disabled ? "opacity-50" : "hover:text-white"
      } ${UPLOADER_STATE_CLASS[uploader.state]}`}
    >
      <span className="font-semibold">{name}</span>
      <span className="opacity-70">{detail}</span>
    </button>
  );
}

function Stat({ value, label }: { value: string; label: string }) {
  return (
    <div className="flex items-baseline gap-1.5">
      <span className="text-[20px] font-semibold text-osu-c1 tabular-nums">{value}</span>
      <span className="text-[12px] text-osu-f1">{label}</span>
    </div>
  );
}

function Empty({ text }: { text: string }) {
  return <div className="px-4 py-8 text-center text-[13px] text-osu-f1">{text}</div>;
}

function ImageRow({
  row,
  checked,
  pending,
  ownerChecked,
  onToggle,
  usernameFor,
}: {
  row: BbcodeImageRow;
  checked: boolean;
  /** Uploaders still without a current profile read; until that is 0 nothing is deletable. */
  pending: number;
  /** Whether this image's own uploader is among the profiles already read. */
  ownerChecked: boolean;
  onToggle: () => void;
  usernameFor: (userId: number | null) => string | null;
}) {
  const selectable = row.status === "unused";
  const uploader = usernameFor(row.uploaderId);
  const users = row.usedBy.map((id) => usernameFor(id) ?? `#${id}`);
  // No uploader in the metadata means no profile can ever clear this one, so it
  // must not read as "checking will resolve it".
  const orphan = row.status === "unknown" && row.uploaderId === null;

  const label = row.status !== "unknown"
    ? STATUS_LABEL[row.status]
    : orphan
      ? "no uploader"
      : pending > 0
        ? `${pending} left to check`
        : STATUS_LABEL.unknown;

  // The one thing a check just bought for this row: its own uploader's page
  // does not embed it. It still takes every other uploader to call it unused.
  // The uploader is named on the right of the row already, so this says what
  // the check found rather than repeating who it was about.
  const note = users.length > 0
    ? users.join(", ")
    : orphan
      ? "no profile can clear it"
      : ownerChecked
        ? "not on the uploader's profile"
        : null;

  const reason = row.status === "in-use"
    ? "Still embedded on a profile."
    : orphan
      ? "No uploader is recorded for this image, so no profile can clear it."
      : `${pending} uploader profile${pending === 1 ? "" : "s"} still to check.`;

  return (
    <div className="flex items-center gap-3 px-3 py-2.5">
      {selectable ? (
        <input
          type="checkbox"
          checked={checked}
          onChange={onToggle}
          title="Select for deletion"
          className="h-4 w-4 flex-shrink-0 accent-osu-pink cursor-pointer"
        />
      ) : (
        // A disabled checkbox here is a row of blocked cursors with the reason
        // buried in a tooltip; a placeholder holds the column without inviting
        // the click, and the badge beside it says what is missing.
        <span aria-hidden title={reason} className="h-4 w-4 flex-shrink-0 rounded-sm border border-osu-b3/40" />
      )}
      {row.url ? (
        <a href={row.url} target="_blank" rel="noreferrer" className="flex-shrink-0">
          <img
            src={row.url}
            alt=""
            loading="lazy"
            className="h-12 w-12 rounded-md object-cover bg-osu-b4/60"
          />
        </a>
      ) : (
        <div className="h-12 w-12 flex-shrink-0 rounded-md bg-osu-b4/60" />
      )}

      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className={`px-1.5 py-0.5 rounded text-[11px] font-semibold ${STATUS_CLASS[row.status]}`}>
            {label}
          </span>
          {note ? <span className="truncate text-[12px] text-osu-l2">{note}</span> : null}
        </div>
        <div className="mt-0.5 truncate font-mono text-[11px] text-osu-f1">{row.fileName}</div>
      </div>

      <div className="flex-shrink-0 text-right text-[11px] text-osu-f1">
        <div className="text-osu-l2">{formatBytes(row.sizeBytes)}</div>
        <div>
          {uploader ?? (row.uploadedBy ?? "unknown uploader")} · {formatDate(row.lastModified)}
        </div>
      </div>
    </div>
  );
}
