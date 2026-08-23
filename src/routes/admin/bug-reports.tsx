import { createFileRoute, Link, notFound } from "@tanstack/react-router";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Ban,
  Check,
  ChevronLeft,
  ChevronRight,
  Copy,
  Image as ImageIcon,
  Inbox,
  Layers,
  ListPlus,
  MessageSquare,
  Pencil,
  RefreshCw,
  Search,
  Trash2,
  User,
  Wrench,
  X,
} from "lucide-react";

import { Avatar } from "../../components/ui/Avatar";
import { ConfirmModal } from "../../components/ui/ConfirmModal";
import { ImageLightbox } from "../../components/ui/ImageLightbox";
import { Skeleton } from "../../components/ui/LoadingSkeleton";
import { canUseAdminFeatures } from "../../lib/auth-shared";
import { describeBrowser } from "../../lib/bug-report-context";
import {
  clearClosedBugReports,
  deleteBugReport,
  getBugReportScreenshotUrls,
  listBugReports,
  promoteBugReportToTodo,
  updateBugReport,
  type BugReport,
  type BugReportCounts,
  type BugReportStatus,
} from "../../lib/bug-reports";

/* What players say is broken, filed from /report.
 *
 * Two text fields on a row look alike and are not: the note is private triage
 * scratch, the reply is written for the reporter and shown back to them on
 * /report. Only a signed-in reporter has anywhere for a reply to land, so the
 * reply editor is missing entirely on an anonymous report rather than
 * accepting words nobody will ever read.
 *
 * Neither field is a permanently open input. A row is usually read and closed
 * without writing anything, so both open on demand and save on a button
 * rather than on blur, where the save is silent and a stray click loses it.
 *
 * Screenshots are fetched on demand behind signed URLs. They are never public,
 * so a row shows a placeholder until it is opened.
 *
 * A report worth acting on becomes an ordinary todo (category "bug") rather
 * than a second queue to remember. The link is one-way and permanent: the
 * button turns into the todo it made.
 */

export const Route = createFileRoute("/admin/bug-reports")({
  head: () => ({
    meta: [
      { title: "Bug reports - admin" },
      { name: "robots", content: "noindex, nofollow" },
    ],
  }),
  beforeLoad: ({ context }) => {
    if (!canUseAdminFeatures(context.auth)) {
      throw notFound();
    }
    return undefined as never;
  },
  component: BugReportsAdminPage,
});

const PAGE_SIZE = 50;

type StatusFilter = BugReportStatus | "all";

interface StatusMeta {
  label: string;
  Icon: typeof Inbox;
  /** Text colour for the tile icon and the row pill. */
  text: string;
  /** Pill background and border. */
  pill: string;
  /** The card's left edge, which is how a status reads while scrolling. */
  edge: string;
}

const STATUS_META: Record<BugReportStatus, StatusMeta> = {
  new: {
    label: "New",
    Icon: Inbox,
    text: "text-osu-pink-light",
    pill: "border-osu-pink/40 bg-osu-pink/15 text-osu-pink-light",
    edge: "border-l-osu-pink/70",
  },
  investigating: {
    label: "Investigating",
    Icon: Wrench,
    text: "text-osu-yellow",
    pill: "border-osu-yellow/35 bg-osu-yellow/10 text-osu-yellow",
    edge: "border-l-osu-yellow/60",
  },
  fixed: {
    label: "Fixed",
    Icon: Check,
    text: "text-emerald-300",
    pill: "border-emerald-400/30 bg-emerald-400/10 text-emerald-200",
    edge: "border-l-emerald-400/50",
  },
  wontfix: {
    label: "Won't fix",
    Icon: Ban,
    text: "text-osu-l2",
    pill: "border-osu-b3/40 bg-osu-b4/60 text-osu-l2",
    edge: "border-l-osu-b3/60",
  },
  duplicate: {
    label: "Duplicate",
    Icon: Copy,
    text: "text-osu-l2",
    pill: "border-osu-b3/40 bg-osu-b4/60 text-osu-l2",
    edge: "border-l-osu-b3/60",
  },
};

const FILTERS: StatusFilter[] = ["new", "investigating", "fixed", "wontfix", "duplicate", "all"];

/* Every status a row can be moved to, in the order they get used. The row
   drops whichever one it is already on. */
const STATUS_MOVES: BugReportStatus[] = ["investigating", "fixed", "wontfix", "duplicate", "new"];

const CLOSED_STATUSES: BugReportStatus[] = ["fixed", "wontfix", "duplicate"];

function formatWhen(ms: number): string {
  if (!ms) return "";
  return new Date(ms).toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function countFor(counts: BugReportCounts, filter: StatusFilter): number {
  return filter === "all" ? counts.total : counts[filter];
}

function closedCount(counts: BugReportCounts): number {
  return CLOSED_STATUSES.reduce((sum, status) => sum + counts[status], 0);
}

const ACTION_CLASS =
  "inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-[11px] text-osu-f1 transition-colors duration-[120ms] hover:bg-osu-b4/70 hover:text-white disabled:opacity-40 cursor-pointer";

const FIELD_CLASS =
  "w-full rounded-lg border border-osu-b3/30 bg-osu-b6/50 px-3 py-2 text-[12.5px] text-osu-l1 outline-none transition-colors placeholder:text-osu-f1/50 focus:border-osu-pink/45";

const SAVE_CLASS =
  "inline-flex h-7 items-center rounded-md bg-osu-pink px-3 text-[11.5px] font-semibold text-white transition-[filter] duration-[120ms] hover:brightness-110 disabled:opacity-40 cursor-pointer";

/* Signed URLs expire, so they are fetched when the row is opened rather than
   held from the list load. */
function Screenshots({ report }: { report: BugReport }) {
  const [urls, setUrls] = useState<string[] | null>(null);
  const [open, setOpen] = useState(false);
  const [zoom, setZoom] = useState<number | null>(null);

  useEffect(() => {
    if (!open || urls) return;
    let cancelled = false;
    void getBugReportScreenshotUrls({ data: { id: report.id } })
      .then((next) => { if (!cancelled) setUrls(next); })
      .catch(() => { if (!cancelled) setUrls([]); });
    return () => { cancelled = true; };
  }, [open, urls, report.id]);

  const count = report.screenshotKeys.length;
  if (!count) return null;

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="mt-2 inline-flex h-16 w-24 cursor-pointer flex-col items-center justify-center gap-1 rounded-lg border border-dashed border-osu-b3/45 text-osu-f1 transition-colors duration-[120ms] hover:border-osu-b3 hover:text-osu-l2"
      >
        <ImageIcon className="h-4 w-4" />
        <span className="text-[11px] tabular-nums">{count}</span>
      </button>
    );
  }
  if (!urls) return <Skeleton className="mt-2 h-24 w-40 rounded-lg" />;
  if (!urls.length) return <p className="mt-2 text-[11px] text-osu-f1">Those images are gone.</p>;

  return (
    <>
      <div className="mt-2 flex flex-wrap gap-2">
        {urls.map((url, index) => (
          <button key={url} type="button" onClick={() => setZoom(index)} className="cursor-zoom-in">
            <img
              src={url}
              alt=""
              className="h-24 rounded-lg border border-osu-b3/30 object-cover transition-opacity duration-[120ms] hover:opacity-80"
            />
          </button>
        ))}
      </div>
      {zoom != null ? (
        <ImageLightbox urls={urls} index={zoom} onIndex={setZoom} onClose={() => setZoom(null)} />
      ) : null}
    </>
  );
}

/* One line instead of the raw key/value dump: the browser, the window it was
   in, and the build. The exact user agent is one hover away rather than four
   wrapped lines on every row. */
function ContextLine({ context }: { context: BugReport["context"] }) {
  if (!context) return null;
  const userAgent = typeof context.userAgent === "string" ? context.userAgent : undefined;
  const bits = [
    describeBrowser(userAgent),
    typeof context.viewport === "string" ? context.viewport : null,
    typeof context.locale === "string" ? context.locale : null,
    typeof context.country === "string" ? context.country : null,
    typeof context.siteVersion === "string" ? `build ${context.siteVersion}` : null,
  ].filter((bit): bit is string => Boolean(bit));
  if (!bits.length) return null;
  return (
    <p className="mt-1.5 text-[11px] text-osu-f1" title={userAgent}>
      {bits.join("  ·  ")}
    </p>
  );
}

function Editor({
  value,
  placeholder,
  saveLabel,
  tone,
  busy,
  onSave,
  onCancel,
}: {
  value: string;
  placeholder: string;
  saveLabel: string;
  tone: "note" | "reply";
  busy: boolean;
  onSave: (next: string) => void;
  onCancel: () => void;
}) {
  const [draft, setDraft] = useState(value);
  const ref = useRef<HTMLTextAreaElement | null>(null);
  useEffect(() => { ref.current?.focus(); }, []);

  return (
    <div className="space-y-2">
      <textarea
        ref={ref}
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Escape") onCancel();
          if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) onSave(draft);
        }}
        rows={tone === "reply" ? 3 : 2}
        placeholder={placeholder}
        className={`${FIELD_CLASS} resize-y ${tone === "reply" ? "border-osu-pink/25 bg-osu-pink/[0.05]" : ""}`}
      />
      <div className="flex items-center gap-2">
        <button type="button" disabled={busy || draft === value} onClick={() => onSave(draft)} className={SAVE_CLASS}>
          {saveLabel}
        </button>
        <button type="button" onClick={onCancel} className={ACTION_CLASS}>Cancel</button>
      </div>
    </div>
  );
}

function ReportCard({
  report,
  busy,
  onStatus,
  onNote,
  onReply,
  onPromote,
  onDelete,
}: {
  report: BugReport;
  busy: boolean;
  onStatus: (status: BugReportStatus) => void;
  onNote: (note: string) => void;
  onReply: (reply: string) => void;
  onPromote: () => void;
  onDelete: () => void;
}) {
  const [editing, setEditing] = useState<"note" | "reply" | null>(null);

  // A save lands as a new updatedAt, which is the signal to close the editor.
  useEffect(() => { setEditing(null); }, [report.updatedAt]);

  const meta = STATUS_META[report.status];
  const open = report.status === "new" || report.status === "investigating";

  return (
    <article
      className={`rounded-xl border border-osu-b3/25 border-l-2 bg-osu-b5/40 transition-opacity duration-[120ms] ${meta.edge} ${
        open ? "" : "opacity-70 hover:opacity-100"
      }`}
    >
      <div className="flex gap-3 px-3.5 pt-3.5">
        {report.userId ? (
          <Avatar userId={report.userId} size={30} />
        ) : (
          <span className="grid h-[30px] w-[30px] flex-shrink-0 place-items-center rounded-full bg-osu-b4/60 text-osu-f1">
            <User className="h-3.5 w-3.5" />
          </span>
        )}

        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            {report.userId ? (
              <a
                href={`https://osu.ppy.sh/users/${report.userId}`}
                target="_blank"
                rel="noreferrer noopener"
                className="text-[13px] font-bold text-white transition-colors duration-[120ms] hover:text-osu-pink-light"
              >
                {report.username || report.userId}
              </a>
            ) : (
              <span className="text-[13px] font-bold text-osu-l2">signed out</span>
            )}
            <span className="text-[11px] text-osu-f1">{formatWhen(report.createdAt)}</span>
            {report.pagePath ? (
              <span className="rounded bg-osu-b4/60 px-1.5 py-0.5 text-[10.5px] text-osu-l2">{report.pagePath}</span>
            ) : null}
            <span className={`rounded-md border px-1.5 py-0.5 text-[10.5px] ${meta.pill}`}>{meta.label}</span>
            {report.todoId ? (
              <Link
                to="/admin/todos"
                className="inline-flex items-center gap-1 text-[11px] text-osu-pink-light transition-colors duration-[120ms] hover:text-white"
              >
                <ListPlus className="h-3 w-3" />
                {report.todoSeq != null ? `#${report.todoSeq}` : "todo"}
              </Link>
            ) : null}
          </div>

          <p className="mt-1.5 whitespace-pre-wrap break-words text-[13.5px] leading-relaxed text-white">{report.body}</p>
          <ContextLine context={report.context} />
          <Screenshots report={report} />
        </div>
      </div>

      {(report.adminNote || report.reply) && editing === null ? (
        <div className="mt-3 space-y-2 px-3.5 sm:pl-[54px]">
          {report.adminNote ? (
            <button
              type="button"
              onClick={() => setEditing("note")}
              className="flex w-full cursor-pointer items-start gap-2 text-left text-[12px] text-osu-f1 transition-colors duration-[120ms] hover:text-osu-l2"
            >
              <Pencil className="mt-0.5 h-3 w-3 flex-shrink-0" />
              <span className="whitespace-pre-wrap break-words">{report.adminNote}</span>
            </button>
          ) : null}
          {report.reply ? (
            <button
              type="button"
              onClick={() => setEditing("reply")}
              className="block w-full cursor-pointer rounded-lg border border-osu-pink/25 bg-osu-pink/[0.06] px-3 py-2 text-left transition-colors duration-[120ms] hover:border-osu-pink/40"
            >
              <span className="block text-[10px] uppercase tracking-wider text-osu-pink-light/70">
                Sent to {report.username || "the reporter"}
              </span>
              <span className="mt-0.5 block whitespace-pre-wrap break-words text-[12.5px] text-osu-l1">
                {report.reply}
              </span>
            </button>
          ) : null}
        </div>
      ) : null}

      {editing ? (
        <div className="mt-3 px-3.5 sm:pl-[54px]">
          <Editor
            key={editing}
            value={(editing === "reply" ? report.reply : report.adminNote) ?? ""}
            placeholder={editing === "reply" ? "They read this on /report" : "Private note, only you see this"}
            saveLabel={editing === "reply" ? "Send reply" : "Save note"}
            tone={editing}
            busy={busy}
            onSave={(next) => (editing === "reply" ? onReply(next) : onNote(next))}
            onCancel={() => setEditing(null)}
          />
        </div>
      ) : null}

      <div className="mt-3 flex flex-wrap items-center gap-1 border-t border-osu-b3/20 px-2.5 py-1.5">
        {STATUS_MOVES.filter((status) => status !== report.status).map((status) => {
          const move = STATUS_META[status];
          return (
            <button key={status} disabled={busy} onClick={() => onStatus(status)} className={ACTION_CLASS}>
              <move.Icon className={`h-3.5 w-3.5 ${move.text}`} />
              {status === "new" ? "Reopen" : move.label}
            </button>
          );
        })}

        <div className="ml-auto flex items-center gap-1">
          {report.userId ? (
            <button
              disabled={busy}
              onClick={() => setEditing(editing === "reply" ? null : "reply")}
              className={ACTION_CLASS}
            >
              <MessageSquare className="h-3.5 w-3.5" />
              {report.reply ? "Edit reply" : "Reply"}
            </button>
          ) : null}
          <button
            disabled={busy}
            onClick={() => setEditing(editing === "note" ? null : "note")}
            title="Private note"
            className={ACTION_CLASS}
          >
            <Pencil className="h-3.5 w-3.5" />
            Note
          </button>
          {report.todoId ? null : (
            <button disabled={busy} onClick={onPromote} className={ACTION_CLASS}>
              <ListPlus className="h-3.5 w-3.5" />
              Todo
            </button>
          )}
          <button
            disabled={busy}
            onClick={onDelete}
            aria-label="Delete report"
            className="inline-flex cursor-pointer items-center rounded-md p-1.5 text-osu-f1 transition-colors duration-[120ms] hover:bg-osu-red/15 hover:text-osu-red-light disabled:opacity-40"
          >
            <Trash2 className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>
    </article>
  );
}

function BugReportsAdminPage() {
  const [status, setStatus] = useState<StatusFilter>("new");
  const [searchInput, setSearchInput] = useState("");
  const [search, setSearch] = useState("");
  const [offset, setOffset] = useState(0);
  const [reports, setReports] = useState<BugReport[] | null>(null);
  const [counts, setCounts] = useState<BugReportCounts>({
    new: 0,
    investigating: 0,
    fixed: 0,
    wontfix: 0,
    duplicate: 0,
    total: 0,
  });
  const [total, setTotal] = useState(0);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [deleteAsk, setDeleteAsk] = useState<BugReport | null>(null);
  const [clearAsk, setClearAsk] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Guards against a slow response for an old filter landing after a newer one.
  const requestRef = useRef(0);

  useEffect(() => {
    const timer = setTimeout(() => setSearch(searchInput.trim()), 250);
    return () => clearTimeout(timer);
  }, [searchInput]);

  const load = useCallback(async () => {
    const request = ++requestRef.current;
    try {
      const page = await listBugReports({
        data: {
          status: status === "all" ? undefined : status,
          search: search || undefined,
          limit: PAGE_SIZE,
          offset,
        },
      });
      if (request !== requestRef.current) return;
      setReports(page.reports);
      setCounts(page.counts);
      setTotal(page.total);
      setError(null);
    } catch {
      if (request !== requestRef.current) return;
      setReports([]);
      setError("Could not load reports.");
    }
  }, [status, search, offset]);

  useEffect(() => { void load(); }, [load]);

  // Any filter change starts at the top; keeping an old offset lands on an
  // empty page whenever the new filter has fewer rows than the old one.
  useEffect(() => { setOffset(0); }, [status, search]);

  const act = useCallback(async (id: string, run: () => Promise<unknown>) => {
    setBusyId(id);
    try {
      await run();
      await load();
    } catch {
      setError("That did not go through.");
    } finally {
      setBusyId(null);
    }
  }, [load]);

  const pages = useMemo(() => ({
    from: total === 0 ? 0 : offset + 1,
    to: Math.min(offset + PAGE_SIZE, total),
  }), [offset, total]);

  const loading = reports === null;

  return (
    <div className="flex-1 bg-osu-b5 min-h-[calc(100vh-60px)]">
      <div className="mx-auto max-w-[1000px] space-y-4 px-4 py-6 sm:px-5">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <span className="h-4 w-1 rounded-full bg-osu-pink" />
              <h1 className="text-sm font-bold uppercase tracking-[0.14em] text-osu-l1">Bug reports</h1>
            </div>
            <p className="mt-1 text-[11px] text-osu-f1">
              {counts.new} waiting{counts.total ? ` · ${counts.total} filed` : ""}
              <span className="hidden sm:inline"> · what players say is broken</span>
            </p>
          </div>

          <div className="flex items-center gap-2">
            <div className="relative min-w-0 flex-1 sm:w-[260px] sm:flex-none">
              <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-osu-f1" />
              <input
                value={searchInput}
                onChange={(event) => setSearchInput(event.target.value)}
                onKeyDown={(event) => { if (event.key === "Escape") setSearchInput(""); }}
                placeholder="Search text, page, reporter"
                className="w-full rounded-md border border-osu-b3/50 bg-osu-b6/70 py-1.5 pl-8 pr-8 text-xs text-osu-l1 outline-none transition-colors placeholder:text-osu-f1/60 focus:border-osu-pink/45"
              />
              {searchInput ? (
                <button
                  type="button"
                  onClick={() => setSearchInput("")}
                  aria-label="Clear search"
                  className="absolute right-1.5 top-1/2 inline-flex h-5 w-5 -translate-y-1/2 cursor-pointer items-center justify-center rounded text-osu-f1 transition-colors hover:bg-osu-b3/50 hover:text-osu-l1"
                >
                  <X className="h-3.5 w-3.5" />
                </button>
              ) : null}
            </div>
            <button
              type="button"
              onClick={() => void load()}
              aria-label="Refresh"
              title="Refresh"
              className="inline-flex h-[30px] w-[30px] flex-shrink-0 cursor-pointer items-center justify-center rounded-md border border-osu-b3/50 bg-osu-b4/60 text-osu-f1 transition-colors duration-[120ms] hover:text-white"
            >
              <RefreshCw className={`h-3.5 w-3.5 ${loading ? "animate-spin" : ""}`} />
            </button>
          </div>
        </div>

        <div className="grid grid-cols-3 overflow-hidden rounded-xl border border-osu-b3/25 bg-osu-b5/40 sm:grid-cols-6">
          {FILTERS.map((filter) => {
            const active = status === filter;
            const meta = filter === "all" ? null : STATUS_META[filter];
            const FilterIcon = meta?.Icon ?? Layers;
            return (
              <button
                key={filter}
                onClick={() => setStatus(filter)}
                className={`relative cursor-pointer border-b border-r border-osu-b3/20 px-3 py-2 text-left transition-colors duration-[120ms] last:border-r-0 sm:border-b-0 ${
                  active ? "bg-osu-b4/45" : "hover:bg-osu-b4/25"
                }`}
              >
                {active ? <span className="absolute inset-x-0 top-0 h-[2px] bg-osu-pink" /> : null}
                <span className="flex items-center gap-1.5">
                  <FilterIcon className={`h-3.5 w-3.5 flex-shrink-0 ${meta?.text ?? "text-osu-f1"}`} />
                  <span className="truncate text-[10px] font-semibold uppercase tracking-wider text-osu-f1">
                    {meta?.label ?? "All"}
                  </span>
                </span>
                <span className="mt-0.5 block text-[17px] font-bold tabular-nums text-white">
                  {countFor(counts, filter)}
                </span>
              </button>
            );
          })}
        </div>

        {error ? <p className="text-[12px] text-osu-red-light">{error}</p> : null}

        {loading ? (
          <div className="space-y-2">
            {Array.from({ length: 3 }, (_, index) => (
              <div key={index} className="space-y-2 rounded-xl border border-osu-b3/25 bg-osu-b5/40 p-3.5">
                <Skeleton className="h-[15px] w-[240px] rounded" />
                <Skeleton className="h-[13px] w-[420px] max-w-full rounded" />
              </div>
            ))}
          </div>
        ) : reports.length === 0 ? (
          <div className="rounded-xl border border-dashed border-osu-b3/30 px-3 py-10 text-center text-[12px] text-osu-f1">
            {search || status !== "new" ? "Nothing matches that." : "No open reports."}
          </div>
        ) : (
          <div className="space-y-2">
            {reports.map((report) => (
              <ReportCard
                key={report.id}
                report={report}
                busy={busyId === report.id}
                onStatus={(next) => void act(report.id, () => updateBugReport({ data: { id: report.id, status: next } }))}
                onNote={(note) => void act(report.id, () => updateBugReport({ data: { id: report.id, adminNote: note } }))}
                onReply={(reply) => void act(report.id, () => updateBugReport({ data: { id: report.id, reply } }))}
                onPromote={() => void act(report.id, () => promoteBugReportToTodo({ data: { id: report.id } }))}
                onDelete={() => setDeleteAsk(report)}
              />
            ))}
          </div>
        )}

        <div className="flex flex-wrap items-center gap-3 pt-1 text-[11px] text-osu-f1">
          {total > PAGE_SIZE ? (
            <>
              <span className="tabular-nums">{pages.from}-{pages.to} of {total}</span>
              <button
                disabled={offset === 0}
                onClick={() => setOffset(Math.max(0, offset - PAGE_SIZE))}
                className={ACTION_CLASS}
              >
                <ChevronLeft className="h-3.5 w-3.5" />
                Previous
              </button>
              <button
                disabled={offset + PAGE_SIZE >= total}
                onClick={() => setOffset(offset + PAGE_SIZE)}
                className={ACTION_CLASS}
              >
                Next
                <ChevronRight className="h-3.5 w-3.5" />
              </button>
            </>
          ) : null}
          <button
            onClick={() => setClearAsk(true)}
            disabled={closedCount(counts) === 0}
            className={`${ACTION_CLASS} ml-auto`}
          >
            <Trash2 className="h-3.5 w-3.5" />
            Clear closed
          </button>
        </div>
      </div>

      {deleteAsk ? (
        <ConfirmModal
          title="Delete this report?"
          body="The row and its screenshots go for good. Closing it keeps both instead."
          confirmLabel="Delete"
          danger
          onConfirm={() => void act(deleteAsk.id, () => deleteBugReport({ data: { id: deleteAsk.id } }))}
          onClose={() => setDeleteAsk(null)}
        />
      ) : null}

      {clearAsk ? (
        <ConfirmModal
          title="Clear every closed report?"
          body={`${closedCount(counts)} fixed, won't fix and duplicate reports go for good, screenshots included. New and investigating ones stay.`}
          confirmLabel="Clear"
          danger
          onConfirm={() => void act("clear", async () => { await clearClosedBugReports(); })}
          onClose={() => setClearAsk(false)}
        />
      ) : null}
    </div>
  );
}
