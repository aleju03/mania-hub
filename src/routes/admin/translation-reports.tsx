import { createFileRoute, notFound } from "@tanstack/react-router";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { ConfirmModal } from "../../components/ui/ConfirmModal";
import { Skeleton } from "../../components/ui/LoadingSkeleton";
import { canUseAdminFeatures } from "../../lib/auth-shared";
import { DEFAULT_LOCALE, SUPPORTED_LOCALES } from "../../lib/locale";
import {
  clearReviewedTranslationReports,
  deleteTranslationReport,
  listTranslationReports,
  updateTranslationReport,
  type TranslationReport,
  type TranslationReportCounts,
  type TranslationReportStatus,
} from "../../lib/translation-reports";

/* What readers say about the site's own translations, filed from the language
   tab of the settings panel (src/components/settings/TranslationReportForm.tsx).
 *
 * A report is one person's reading of one string, so the board keeps their
 * words intact and adds only what is needed to find the string again: the
 * locale, the page they were on, and who they were if they were signed in.
 * Fixing one means editing the catalog, which happens outside the site
 * entirely - so the only states here are the ones that say whether a report
 * still wants looking at.
 *
 * English is not offered as a filter: the source strings are written in it, so
 * nothing can be reported against it and no row will ever carry it.
 */

export const Route = createFileRoute("/admin/translation-reports")({
  head: () => ({
    meta: [
      { title: "Translation reports - admin" },
      { name: "robots", content: "noindex, nofollow" },
    ],
  }),
  beforeLoad: ({ context }) => {
    if (!canUseAdminFeatures(context.auth)) {
      throw notFound();
    }
    return undefined as never;
  },
  component: TranslationReportsAdminPage,
});

const PAGE_SIZE = 50;

const REPORTABLE_LOCALES = SUPPORTED_LOCALES.filter((locale) => locale !== DEFAULT_LOCALE);

type StatusFilter = TranslationReportStatus | "all";

const STATUS_FILTERS: { value: StatusFilter; label: string }[] = [
  { value: "new", label: "New" },
  { value: "resolved", label: "Resolved" },
  { value: "dismissed", label: "Dismissed" },
  { value: "all", label: "All" },
];

function formatWhen(ms: number): string {
  if (!ms) return "";
  return new Date(ms).toLocaleString("en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function countFor(counts: TranslationReportCounts, filter: StatusFilter): number {
  return filter === "all" ? counts.total : counts[filter];
}

function chipClass(active: boolean): string {
  return `px-2.5 py-1 rounded-md border text-[12px] transition-colors duration-[120ms] cursor-pointer ${
    active
      ? "border-osu-pink/50 bg-osu-pink/15 text-osu-pink-light"
      : "border-osu-b3/30 bg-osu-b4/60 text-osu-l2 hover:bg-osu-b3/60 hover:text-white"
  }`;
}

const ACTION_CLASS =
  "px-2.5 py-1 rounded-md bg-osu-b4/60 border border-osu-b3/30 text-[11px] text-osu-l2 hover:bg-osu-b3/60 hover:text-white transition-colors duration-[120ms] disabled:opacity-50 cursor-pointer";

/* One report. The reporter's own three fields are the body; everything else is
   a line of context under them. The admin note saves when the field loses
   focus, so triaging a row is never blocked on remembering to press anything. */
function ReportRow({
  report,
  busy,
  onStatus,
  onNote,
  onDelete,
}: {
  report: TranslationReport;
  busy: boolean;
  onStatus: (status: TranslationReportStatus) => void;
  onNote: (note: string) => void;
  onDelete: () => void;
}) {
  const [note, setNote] = useState(report.adminNote ?? "");

  useEffect(() => { setNote(report.adminNote ?? ""); }, [report.adminNote]);

  return (
    <div className={`px-3 py-3 space-y-2 transition-opacity duration-[120ms] ${report.status === "new" ? "" : "opacity-60 hover:opacity-100"}`}>
      <div className="flex flex-wrap items-start gap-x-3 gap-y-1.5">
        <div className="min-w-0 flex-1 space-y-1">
          <p className="text-[13px] text-white whitespace-pre-wrap break-words">{report.sourceText}</p>
          {report.suggestion ? (
            <p className="text-[13px] text-osu-l2 whitespace-pre-wrap break-words">
              <span className="text-osu-f1">should be </span>
              {report.suggestion}
            </p>
          ) : null}
          {report.note ? (
            <p className="text-[12px] text-osu-f1 whitespace-pre-wrap break-words">{report.note}</p>
          ) : null}
        </div>

        <div className="flex flex-shrink-0 items-center gap-2">
          {report.status === "new" ? (
            <>
              <button disabled={busy} onClick={() => onStatus("resolved")} className={ACTION_CLASS}>Resolve</button>
              <button disabled={busy} onClick={() => onStatus("dismissed")} className={ACTION_CLASS}>Dismiss</button>
            </>
          ) : (
            <button disabled={busy} onClick={() => onStatus("new")} className={ACTION_CLASS}>Reopen</button>
          )}
          <button
            disabled={busy}
            onClick={onDelete}
            className="px-2.5 py-1 rounded-md border border-osu-red/40 bg-osu-red/10 text-[11px] text-osu-red-light hover:bg-osu-red/20 transition-colors duration-[120ms] disabled:opacity-50 cursor-pointer"
          >
            Delete
          </button>
        </div>
      </div>

      {/* Labelled rather than four bare values in a row: the path is the page the
          reporter had open when they filed, which is not the same claim as
          "the string lives here", and unlabelled it reads as one. */}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-osu-f1">
        <span className="text-osu-l2">{report.locale}</span>
        {report.pagePath ? <span>seen on <span className="text-osu-l2">{report.pagePath}</span></span> : null}
        <span>
          from{" "}
          {report.userId ? (
            <a
              href={`https://osu.ppy.sh/users/${report.userId}`}
              target="_blank"
              rel="noreferrer noopener"
              className="text-osu-l2 hover:text-osu-pink-light"
            >
              {report.username || report.userId}
            </a>
          ) : (
            "a signed-out visitor"
          )}
        </span>
        <span>{formatWhen(report.createdAt)}</span>
        {report.status !== "new" ? <span className="text-osu-l2">{report.status}</span> : null}
      </div>

      <input
        value={note}
        onChange={(event) => setNote(event.target.value)}
        onBlur={() => { if ((report.adminNote ?? "") !== note) onNote(note); }}
        onKeyDown={(event) => { if (event.key === "Enter") event.currentTarget.blur(); }}
        placeholder="Private note, only you see this"
        className="w-full rounded-md border border-osu-b3/30 bg-osu-b4/40 px-2.5 py-1 text-[11.5px] text-osu-l1 outline-none transition-colors placeholder:text-osu-f1/50 focus:border-osu-pink/40"
      />
    </div>
  );
}

function TranslationReportsAdminPage() {
  const [status, setStatus] = useState<StatusFilter>("new");
  const [locale, setLocale] = useState<string | null>(null);
  const [searchInput, setSearchInput] = useState("");
  const [search, setSearch] = useState("");
  const [offset, setOffset] = useState(0);
  const [reports, setReports] = useState<TranslationReport[] | null>(null);
  const [counts, setCounts] = useState<TranslationReportCounts>({ new: 0, resolved: 0, dismissed: 0, total: 0 });
  const [total, setTotal] = useState(0);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [deleteAsk, setDeleteAsk] = useState<TranslationReport | null>(null);
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
      const page = await listTranslationReports({
        data: {
          status: status === "all" ? undefined : status,
          locale: locale ?? undefined,
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
  }, [status, locale, search, offset]);

  useEffect(() => { void load(); }, [load]);

  // Any filter change starts at the top; keeping an old offset lands on an
  // empty page whenever the new filter has fewer rows than the old one.
  useEffect(() => { setOffset(0); }, [status, locale, search]);

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

  return (
    <div className="flex-1">
      <div className="bg-osu-d5 border-b border-osu-b3/40">
        <div className="max-w-[1000px] mx-auto px-4 sm:px-5 py-3 flex items-center gap-3">
          <div className="relative flex-shrink-0">
            <span className="block w-2.5 h-2.5 rounded-full bg-osu-yellow" />
            {reports === null || busyId ? (
              <span className="absolute inset-0 rounded-full bg-osu-yellow animate-ping opacity-75" />
            ) : null}
          </div>
          <h2 className="text-[13px] sm:text-[15px] font-medium text-osu-c2">Translation reports</h2>
          <div className="ml-auto flex items-center gap-3 text-[11px] text-osu-f1">
            <span>{counts.new} new of {counts.total}</span>
            <button onClick={() => void load()} className={ACTION_CLASS}>Refresh</button>
          </div>
        </div>
      </div>

      <div className="bg-osu-b5 min-h-[calc(100vh-60px)]">
        <div className="max-w-[1000px] mx-auto px-4 sm:px-5 py-5 space-y-4">
          <div className="flex flex-wrap items-center gap-2">
            {STATUS_FILTERS.map((filter) => (
              <button
                key={filter.value}
                onClick={() => setStatus(filter.value)}
                className={chipClass(status === filter.value)}
              >
                {filter.label} {countFor(counts, filter.value)}
              </button>
            ))}

            {/* Only worth a row of its own once there is a second translated
                locale to tell apart. */}
            {REPORTABLE_LOCALES.length > 1 ? (
              <>
                <span className="h-4 w-px bg-osu-b3/40" />
                <button onClick={() => setLocale(null)} className={chipClass(locale === null)}>Any language</button>
                {REPORTABLE_LOCALES.map((code) => (
                  <button key={code} onClick={() => setLocale(code)} className={chipClass(locale === code)}>{code}</button>
                ))}
              </>
            ) : null}

            <input
              value={searchInput}
              onChange={(event) => setSearchInput(event.target.value)}
              placeholder="Search text, suggestion, note, reporter"
              className="ml-auto w-[280px] max-w-full rounded-md border border-osu-b3/30 bg-osu-b4/60 px-2.5 py-1 text-[12px] text-osu-l1 outline-none transition-colors placeholder:text-osu-f1/55 focus:border-osu-pink/40"
            />
            <button
              onClick={() => setClearAsk(true)}
              disabled={counts.resolved + counts.dismissed === 0}
              className={ACTION_CLASS}
            >
              Clear triaged
            </button>
          </div>

          {error ? <p className="text-[12px] text-osu-red-light">{error}</p> : null}

          {reports === null ? (
            <div className="rounded-md border border-osu-b3/20 bg-osu-b5/60 divide-y divide-osu-b3/20">
              {Array.from({ length: 4 }, (_, index) => (
                <div key={index} className="px-3 py-3 space-y-2">
                  <Skeleton className="h-[15px] w-[260px] rounded" />
                  <Skeleton className="h-[13px] w-[180px]" />
                </div>
              ))}
            </div>
          ) : reports.length === 0 ? (
            <div className="rounded-md border border-osu-b3/20 bg-osu-b5/60 px-3 py-6 text-center text-[12px] text-osu-f1">
              {search || locale || status !== "new" ? "Nothing matches that." : "No open reports."}
            </div>
          ) : (
            <>
              <div className="rounded-md border border-osu-b3/20 bg-osu-b5/60 overflow-hidden divide-y divide-osu-b3/20">
                {reports.map((report) => (
                  <ReportRow
                    key={report.id}
                    report={report}
                    busy={busyId === report.id}
                    onStatus={(next) => void act(report.id, () => updateTranslationReport({ data: { id: report.id, status: next } }))}
                    onNote={(note) => void act(report.id, () => updateTranslationReport({ data: { id: report.id, adminNote: note } }))}
                    onDelete={() => setDeleteAsk(report)}
                  />
                ))}
              </div>

              {total > PAGE_SIZE ? (
                <div className="flex items-center gap-3 text-[11px] text-osu-f1">
                  <span>{pages.from}-{pages.to} of {total}</span>
                  <button
                    disabled={offset === 0}
                    onClick={() => setOffset(Math.max(0, offset - PAGE_SIZE))}
                    className={ACTION_CLASS}
                  >
                    Previous
                  </button>
                  <button
                    disabled={offset + PAGE_SIZE >= total}
                    onClick={() => setOffset(offset + PAGE_SIZE)}
                    className={ACTION_CLASS}
                  >
                    Next
                  </button>
                </div>
              ) : null}
            </>
          )}
        </div>
      </div>

      {deleteAsk ? (
        <ConfirmModal
          title="Delete this report?"
          body="It goes for good. Resolving or dismissing keeps it around instead."
          confirmLabel="Delete"
          danger
          onConfirm={() => void act(deleteAsk.id, () => deleteTranslationReport({ data: { id: deleteAsk.id } }))}
          onClose={() => setDeleteAsk(null)}
        />
      ) : null}

      {clearAsk ? (
        <ConfirmModal
          title="Clear every triaged report?"
          body={`${counts.resolved + counts.dismissed} resolved and dismissed reports go for good. New ones stay.`}
          confirmLabel="Clear"
          danger
          onConfirm={() => void act("clear", async () => { await clearReviewedTranslationReports(); })}
          onClose={() => setClearAsk(false)}
        />
      ) : null}
    </div>
  );
}
