import { createFileRoute } from "@tanstack/react-router";
import { useCallback, useEffect, useRef, useState } from "react";
import { Check, ChevronRight, ImagePlus, Loader2, MessageSquare, X } from "lucide-react";
import { Trans, useLingui } from "@lingui/react/macro";

import { Avatar } from "../components/ui/Avatar";
import { ImageLightbox } from "../components/ui/ImageLightbox";
import { OsuLogo } from "../components/ui/OsuLogo";
import { useAuth } from "../lib/auth-context";
import {
  BUG_REPORT_BODY_MAX,
  BUG_REPORT_MAX_SCREENSHOTS,
  BUG_REPORT_MESSAGE_MAX,
  bugReportThreadMessages,
  getBugReportScreenshotUrls,
  listMyBugReports,
  replyToMyBugReport,
  submitBugReport,
  type BugReportContext,
  type BugReportFailReason,
  type BugReportStatus,
  type MyBugReport,
} from "../lib/bug-reports";
import {
  collectBugReportContext,
  describeBrowser,
  normalizeBugReportSourcePath,
} from "../lib/bug-report-context";
import {
  imagesFromClipboard,
  uploadBugReportScreenshots,
  useBugReportScreenshots,
  type BugReportUploadStatus,
} from "../lib/bug-report-screenshots";
import { track } from "../lib/analytics";
import { formatTimeAgo } from "../lib/format";
import { useLocale } from "../lib/locale-context";
import { pageSeo } from "../lib/seo";
import { useAppStore } from "../store";

/*
 * Telling the owner something on the site is broken.
 *
 * No login is asked for. Whoever hit the bug is the person worth hearing from,
 * and most people find one before they ever sign in. What a login buys is the
 * answer: a reply has to land somewhere, and an anonymous report has nowhere,
 * so the thread below is signed-in only and the form says that before it is
 * sent rather than after.
 *
 * The writing surface is one composer rather than a stack of labelled fields.
 * Images can be pasted, dropped or picked, because the screenshot is usually
 * already on the clipboard by the time someone gets here, and every extra step
 * between "this is broken" and "sent" loses reports.
 *
 * The browser context (page, user agent, window size, language, build) is
 * collected rather than typed, and named in full under the composer. A page
 * that quietly reads those should say so without being opened.
 */

/** The backend refuses anything shorter; catching it here saves a round trip. */
const BODY_MIN = 10;
/** The counter is noise until the ceiling is actually in reach. */
const COUNTER_FROM = BUG_REPORT_BODY_MAX - 250;

const REPLY_AUTHOR = {
  userId: 7095193,
  username: "Aleju03",
} as const;
const REPORTER_THREAD_PREVIEW_COUNT = 6;

type Phase = "idle" | "sending" | "sent";

type ReportSearch = { from?: string };

export const Route = createFileRoute("/report")({
  validateSearch: (search: Record<string, unknown>): ReportSearch => ({
    from: normalizeBugReportSourcePath(search.from),
  }),
  head: ({ match }) => pageSeo({
    title: "Report a bug",
    description: "Tell the owner something on Mania Tracker is broken.",
    path: "/report",
    origin: match.context.origin,
    noindex: true,
  }),
  component: ReportPage,
});

function ReportPage() {
  const { t } = useLingui();
  const locale = useLocale();
  const auth = useAuth();
  const country = useAppStore((state) => state.selectedCountry);
  const search = Route.useSearch();
  const sourcePagePath = search.from;

  const [body, setBody] = useState("");
  const images = useBugReportScreenshots();
  const [phase, setPhase] = useState<Phase>("idle");
  const [error, setError] = useState<string | null>(null);
  const [uploadWarning, setUploadWarning] = useState(false);
  const [uploads, setUploads] = useState<BugReportUploadStatus[]>([]);
  const [dragActive, setDragActive] = useState(false);
  const [lightbox, setLightbox] = useState<{ urls: string[]; index: number } | null>(null);
  const [clientContext, setClientContext] = useState<BugReportContext | null>(null);
  const [mine, setMine] = useState<MyBugReport[] | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const dragDepth = useRef(0);
  const openedRef = useRef(false);

  const viewer = auth.viewer;
  const signedIn = Boolean(viewer);
  const busy = phase === "sending";
  const trimmedLength = body.trim().length;

  const refreshMine = useCallback(() => {
    if (!signedIn) {
      setMine(null);
      return;
    }
    void listMyBugReports().then(setMine).catch(() => setMine([]));
  }, [signedIn]);

  const updateMine = useCallback((report: MyBugReport) => {
    setMine((current) => current
      ? [report, ...current.filter((entry) => entry.id !== report.id)]
      : [report]);
  }, []);

  useEffect(() => {
    refreshMine();
  }, [refreshMine]);

  // Browser-only values stay out of the server render. The first client render
  // therefore matches SSR exactly, then the line fills after hydration.
  useEffect(() => {
    setClientContext(collectBugReportContext({ locale, country }));
  }, [locale, country]);

  useEffect(() => {
    if (openedRef.current) return;
    openedRef.current = true;
    track("bug_report_open", { from: sourcePagePath ?? "direct" });
  }, [sourcePagePath]);

  // Grows with the text instead of holding a scrollbar in a six-row box.
  useEffect(() => {
    const field = textareaRef.current;
    if (!field) return;
    field.style.height = "0px";
    field.style.height = `${Math.min(field.scrollHeight, 420)}px`;
  }, [body, phase]);

  const failMessage = (reason: BugReportFailReason): string => {
    if (reason === "invalid_report") return t`Say a little more about what went wrong.`;
    if (reason === "too_many_reports") return t`That is a lot of reports for one day. Try again tomorrow.`;
    if (reason === "rate_limited") return t`Too many reports just now. Try again in a bit.`;
    return t`Could not send that. Try again.`;
  };

  const addFiles = (picked: FileList | File[] | null) => {
    setError(null);
    images.add(picked);
    if (fileInputRef.current) fileInputRef.current.value = "";
  };

  const send = async () => {
    const trimmed = body.trim();
    if (trimmed.length < BODY_MIN || busy) return;
    setPhase("sending");
    setError(null);
    setUploadWarning(false);
    const selectedFiles = images.files.slice();
    setUploads(selectedFiles.map(() => "waiting"));
    try {
      const context = collectBugReportContext({ locale, country });
      const result = await submitBugReport({
        data: {
          body: trimmed,
          pagePath: sourcePagePath,
          context,
          screenshotCount: selectedFiles.length,
        },
      });
      if (!result.ok) {
        setError(failMessage(result.reason));
        setUploads([]);
        setPhase("idle");
        return;
      }
      if (selectedFiles.length && result.uploadToken) {
        const uploaded = await uploadBugReportScreenshots(result.id, result.uploadToken, selectedFiles, (index, status) => {
          setUploads((current) => current.map((entry, itemIndex) => (itemIndex === index ? status : entry)));
        });
        if (uploaded < selectedFiles.length) setUploadWarning(true);
      } else if (selectedFiles.length) {
        setUploads(selectedFiles.map(() => "failed"));
        setUploadWarning(true);
      }
      track("bug_report_submit", {
        duplicate: result.duplicate,
        screenshot_count: selectedFiles.length,
        signed_in: signedIn,
      });
      setBody("");
      images.clear();
      setUploads([]);
      setPhase("sent");
      refreshMine();
    } catch {
      setError(t`Could not send that. Try again.`);
      setUploads([]);
      setPhase("idle");
    }
  };

  const browser = describeBrowser(clientContext?.userAgent as string | undefined);
  const contextBits = [
    sourcePagePath,
    browser,
    clientContext?.viewport as string | undefined,
    clientContext?.locale as string | undefined,
  ].filter((bit): bit is string => Boolean(bit));

  const canSend = trimmedLength >= BODY_MIN && !busy;
  // Key names, not words: left untranslated on purpose, and read off the
  // platform so a Mac is not told to press a key it does not have.
  const sendShortcut = shortcutLabel();

  return (
    <div className="min-h-[calc(100vh-60px)] bg-osu-b5">
      <div className="mx-auto w-full max-w-[680px] px-4 py-7 sm:px-5 sm:py-9">
        <h1 className="text-[22px] font-bold text-white">
          <Trans>Report a bug</Trans>
        </h1>
        <p className="mt-1 text-[13px] text-osu-f1">
          <Trans>Found something broken? Describe what happened.</Trans>
        </p>

        {phase === "sent" ? (
          <SentPanel
            signedIn={signedIn}
            uploadWarning={uploadWarning}
            onAgain={() => {
              setPhase("idle");
              setUploadWarning(false);
              requestAnimationFrame(() => textareaRef.current?.focus());
            }}
          />
        ) : (
          <>
            <div
              onDragEnter={(event) => {
                if (busy || !Array.from(event.dataTransfer.items).some((item) => item.kind === "file")) return;
                event.preventDefault();
                dragDepth.current += 1;
                setDragActive(true);
              }}
              onDragOver={(event) => {
                if (dragDepth.current > 0) event.preventDefault();
              }}
              onDragLeave={() => {
                dragDepth.current = Math.max(0, dragDepth.current - 1);
                if (dragDepth.current === 0) setDragActive(false);
              }}
              onDrop={(event) => {
                if (!dragDepth.current) return;
                event.preventDefault();
                dragDepth.current = 0;
                setDragActive(false);
                if (!busy) addFiles(event.dataTransfer.files);
              }}
              className={`relative mt-5 rounded-xl border bg-osu-b6/50 transition-colors duration-[120ms] ${
                dragActive
                  ? "border-osu-pink/60 bg-osu-pink/[0.06]"
                  : "border-osu-b3/40 focus-within:border-osu-pink/45"
              }`}
            >
              <textarea
                ref={textareaRef}
                value={body}
                disabled={busy}
                autoFocus
                onChange={(event) => setBody(event.target.value.slice(0, BUG_REPORT_BODY_MAX))}
                onPaste={(event) => {
                  const pasted = imagesFromClipboard(event);
                  if (!pasted.length) return;
                  event.preventDefault();
                  addFiles(pasted);
                }}
                onKeyDown={(event) => {
                  if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
                    event.preventDefault();
                    void send();
                  }
                }}
                rows={1}
                placeholder={t`What seems wrong?`}
                className={`block max-h-[420px] w-full resize-none bg-transparent px-4 pt-3.5 pb-1 text-[14px] leading-relaxed text-osu-l1 outline-none placeholder:text-osu-f1/55 disabled:opacity-60 ${
                  images.files.length ? "min-h-[84px]" : "min-h-[136px]"
                }`}
              />

              <PendingScreenshots
                files={images.files}
                previews={images.previews}
                uploads={uploads}
                busy={busy}
                className="px-4 pb-1 pt-1"
                onOpen={(index) => setLightbox({ urls: images.previews, index })}
                onRemove={images.removeAt}
              />

              <div className="flex items-center gap-2 border-t border-osu-b3/25 px-2.5 py-2">
                <button
                  type="button"
                  disabled={busy || images.files.length >= BUG_REPORT_MAX_SCREENSHOTS}
                  onClick={() => fileInputRef.current?.click()}
                  title={t`Add an image`}
                  aria-label={t`Add an image`}
                  className="inline-flex h-7 w-7 flex-shrink-0 cursor-pointer items-center justify-center rounded-md text-osu-f1 transition-colors duration-[120ms] hover:bg-osu-b4/70 hover:text-white disabled:cursor-not-allowed disabled:opacity-40"
                >
                  <ImagePlus className="h-4 w-4" />
                </button>
                <input
                  ref={fileInputRef}
                  type="file"
                  accept="image/*"
                  multiple
                  className="hidden"
                  onChange={(event) => addFiles(event.target.files)}
                />
                <span className="min-w-0 truncate text-[11px] text-osu-f1">
                  {trimmedLength > 0 && trimmedLength < BODY_MIN
                    ? t`Say a little more about what went wrong.`
                    : t`Paste, drop or pick a screenshot.`}
                </span>
                <div className="ml-auto flex flex-shrink-0 items-center gap-2.5">
                  {body.length >= COUNTER_FROM ? (
                    <span className={`text-[11px] tabular-nums ${
                      body.length >= BUG_REPORT_BODY_MAX ? "text-osu-pink-light" : "text-osu-f1"
                    }`}
                    >
                      {BUG_REPORT_BODY_MAX - body.length}
                    </span>
                  ) : null}
                  <button
                    type="button"
                    onClick={() => void send()}
                    disabled={!canSend}
                    title={sendShortcut}
                    className="inline-flex h-8 cursor-pointer items-center gap-2 rounded-lg bg-osu-pink px-3.5 text-[12px] font-semibold text-white transition-[background-color,filter] duration-[120ms] hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-40"
                  >
                    {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
                    <Trans>Send report</Trans>
                  </button>
                </div>
              </div>
            </div>

            {error ?? images.error
              ? <p className="mt-2 text-[12px] text-osu-pink-light">{error ?? images.error}</p>
              : null}

            <p className="mt-2.5 text-[11px] leading-relaxed text-osu-f1" title={String(clientContext?.userAgent ?? "")}>
              <Trans>Sent along with it:</Trans>{" "}
              {contextBits.length
                ? contextBits.map((bit, index) => (
                  <span key={bit + index}>
                    {index ? <span className="px-1 text-osu-f1/50">/</span> : null}
                    <span className="text-osu-l2">{bit}</span>
                  </span>
                ))
                : null}
            </p>

          </>
        )}

        {signedIn ? (
          <MyReports
            reports={mine}
            locale={locale}
            onOpenImage={(urls, index) => setLightbox({ urls, index })}
            onReportUpdated={updateMine}
          />
        ) : null}

        {lightbox ? (
          <ImageLightbox
            urls={lightbox.urls}
            index={lightbox.index}
            onIndex={(index) => setLightbox({ urls: lightbox.urls, index })}
            onClose={() => setLightbox(null)}
          />
        ) : null}
      </div>
    </div>
  );
}

/** "Cmd + Enter" on a Mac, "Ctrl + Enter" everywhere else. */
function shortcutLabel(): string {
  if (typeof navigator === "undefined") return "Ctrl + Enter";
  const platform = `${navigator.platform ?? ""} ${navigator.userAgent ?? ""}`;
  return /Mac|iPhone|iPad/.test(platform) ? "Cmd + Enter" : "Ctrl + Enter";
}

function SentPanel({
  signedIn,
  uploadWarning,
  onAgain,
}: {
  signedIn: boolean;
  uploadWarning: boolean;
  onAgain: () => void;
}) {
  return (
    <div className="mt-5 rounded-xl border border-osu-b3/40 bg-osu-b6/50 px-4 py-5">
      <div className="flex items-center gap-2.5">
        <span className="grid h-7 w-7 place-items-center rounded-full bg-emerald-400/15 text-emerald-300">
          <Check className="h-4 w-4" />
        </span>
        <span className="text-[15px] font-semibold text-white">
          <Trans>Report sent</Trans>
        </span>
      </div>
      {uploadWarning ? (
        <p className="mt-1.5 text-[12px] text-osu-pink-light">
          <Trans>The report was sent, but at least one image did not upload.</Trans>
        </p>
      ) : null}
      <div className="mt-4 flex flex-wrap items-center gap-3">
        <button
          type="button"
          onClick={onAgain}
          className="inline-flex h-8 cursor-pointer items-center rounded-lg border border-osu-b3/40 bg-osu-b4/60 px-3 text-[12px] text-osu-l2 transition-colors duration-[120ms] hover:bg-osu-b3/60 hover:text-white"
        >
          <Trans>Report something else</Trans>
        </button>
        {!signedIn ? <LoginLink label={<Trans>Sign in to read replies</Trans>} /> : null}
      </div>
    </div>
  );
}

function LoginLink({ label }: { label: React.ReactNode }) {
  const [href, setHref] = useState("/api/auth/osu");
  useEffect(() => {
    setHref(`/api/auth/osu?next=${encodeURIComponent(`${window.location.pathname}${window.location.search}`)}`);
  }, []);
  return (
    <a
      href={href}
      className="inline-flex h-8 items-center gap-2 rounded-lg border border-osu-pink/45 bg-osu-pink/15 px-3 text-[12px] font-semibold text-osu-pink-light transition-colors duration-[120ms] hover:bg-osu-pink/25 hover:text-white"
    >
      <OsuLogo className="h-3.5 w-3.5" />
      {label}
    </a>
  );
}

function UploadBadge({ status }: { status: BugReportUploadStatus }) {
  if (status === "done") {
    return (
      <span className="absolute inset-0 grid place-items-center rounded-md bg-osu-b6/55 text-emerald-300">
        <Check className="h-4 w-4" />
      </span>
    );
  }
  if (status === "failed") {
    return (
      <span className="absolute inset-0 grid place-items-center rounded-md bg-osu-b6/70 text-osu-pink-light">
        <X className="h-4 w-4" />
      </span>
    );
  }
  return (
    <span className="absolute inset-0 grid place-items-center rounded-md bg-osu-b6/55 text-osu-l2">
      <Loader2 className={`h-4 w-4 ${status === "uploading" ? "animate-spin" : "opacity-40"}`} />
    </span>
  );
}

/** The picked-but-not-yet-sent images under whatever is being written. */
function PendingScreenshots({
  files,
  previews,
  uploads,
  busy,
  className = "",
  onOpen,
  onRemove,
}: {
  files: File[];
  previews: string[];
  uploads: BugReportUploadStatus[];
  busy: boolean;
  className?: string;
  onOpen: (index: number) => void;
  onRemove: (index: number) => void;
}) {
  const { t } = useLingui();
  if (!files.length) return null;
  return (
    <ul className={`flex flex-wrap gap-2 ${className}`}>
      {files.map((file, index) => (
        <li key={`${file.name}-${index}`} className="relative">
          <button
            type="button"
            onClick={() => onOpen(index)}
            aria-label={t`Open image`}
            className="block cursor-zoom-in"
          >
            <ScreenshotThumb url={previews[index]} />
          </button>
          {uploads[index] ? <UploadBadge status={uploads[index]!} /> : null}
          {!busy ? (
            <button
              type="button"
              onClick={() => onRemove(index)}
              aria-label={t`Remove image`}
              className="absolute -right-1.5 -top-1.5 cursor-pointer rounded-full border border-osu-b3/50 bg-osu-b5 p-0.5 text-osu-l2 transition-colors duration-[120ms] hover:text-white"
            >
              <X className="h-3 w-3" />
            </button>
          ) : null}
        </li>
      ))}
    </ul>
  );
}

function ScreenshotThumb({ url }: { url: string | undefined }) {
  return url
    ? <img src={url} alt="" className="h-14 w-20 rounded-md border border-osu-b3/30 object-cover transition-opacity duration-[120ms] hover:opacity-85" />
    : <div className="h-14 w-20 rounded-md border border-osu-b3/30 bg-osu-b4/60" />;
}

/** Signed URLs cost a round trip each and expire, so they are asked for on the
 *  click rather than for every report and message on the page. The same reader
 *  serves the report's own images and any one follow-up's. */
function ReporterScreenshots({
  reportId,
  messageId,
  count,
  onOpen,
  align,
}: {
  reportId: string;
  messageId?: string;
  count: number;
  onOpen: (urls: string[], index: number) => void;
  align: "start" | "end";
}) {
  const { t } = useLingui();
  const [urls, setUrls] = useState<string[] | null>(null);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (!open || urls) return;
    let cancelled = false;
    void getBugReportScreenshotUrls({ data: { id: reportId, messageId } })
      .then((next) => { if (!cancelled) setUrls(next); })
      .catch(() => { if (!cancelled) setUrls([]); });
    return () => { cancelled = true; };
  }, [open, reportId, messageId, urls]);

  if (count <= 0) return null;
  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="inline-flex cursor-pointer items-center gap-1.5 text-[11.5px] text-osu-f1 transition-colors duration-[120ms] hover:text-osu-pink-light"
      >
        <ImagePlus className="h-3.5 w-3.5" />
        {count === 1
          ? <Trans>1 screenshot</Trans>
          : <Trans>{count} screenshots</Trans>}
      </button>
    );
  }
  if (!urls) return <Loader2 className="h-3.5 w-3.5 animate-spin text-osu-f1" />;
  if (!urls.length) {
    return <p className="text-[11.5px] text-osu-f1"><Trans>Those images are no longer available.</Trans></p>;
  }
  return (
    <div className={`flex flex-wrap gap-2 ${align === "end" ? "justify-end" : ""}`}>
      {urls.map((url, index) => (
        <button
          key={url}
          type="button"
          onClick={() => onOpen(urls, index)}
          aria-label={t`Open image`}
          className="cursor-zoom-in"
        >
          <img src={url} alt="" className="h-20 rounded-xl border border-osu-b3/30 object-cover transition-opacity duration-[120ms] hover:opacity-80" />
        </button>
      ))}
    </div>
  );
}

/*
 * A bubble, not a timeline entry. Yours sit on the right and the owner's on the
 * left, which is the one layout everybody already reads without a legend, so
 * neither side needs a label saying whose turn it was.
 */
function MessageBubble({
  children,
  mine,
  time,
  className = "",
}: {
  children: React.ReactNode;
  mine: boolean;
  time: string | null;
  className?: string;
}) {
  const bubble = (
    <div className={`max-w-[min(88%,34rem)] whitespace-pre-wrap break-words rounded-2xl px-3.5 py-2.5 text-[13.5px] leading-relaxed ${
      mine
        ? "rounded-br-md bg-osu-pink/12 text-osu-c1"
        : "rounded-bl-md bg-osu-b4/50 text-osu-l1"
    }`}
    >
      {children}
    </div>
  );
  const stamp = time
    ? <span className="flex-shrink-0 pb-1 text-[10.5px] text-osu-f1">{time}</span>
    : null;
  return (
    <div className={`flex items-end gap-2 ${mine ? "justify-end" : ""} ${className}`}>
      {mine ? stamp : null}
      {bubble}
      {mine ? null : stamp}
    </div>
  );
}

function ReporterThread({
  report,
  locale,
  onOpenImage,
}: {
  report: MyBugReport;
  locale: ReturnType<typeof useLocale>;
  onOpenImage: (urls: string[], index: number) => void;
}) {
  const messages = bugReportThreadMessages(report);
  const [expanded, setExpanded] = useState(false);
  const hiddenCount = Math.max(0, messages.length - REPORTER_THREAD_PREVIEW_COUNT);
  const visible = expanded || !hiddenCount
    ? messages
    : messages.slice(-REPORTER_THREAD_PREVIEW_COUNT);

  if (!messages.length) return null;
  return (
    <div className="mt-3 space-y-1.5">
      {hiddenCount > 0 ? (
        <button
          type="button"
          onClick={() => setExpanded((value) => !value)}
          className="mx-auto mb-2 block cursor-pointer text-[11px] text-osu-f1 transition-colors duration-[120ms] hover:text-osu-l2"
        >
          {expanded
            ? <Trans>Show fewer</Trans>
            : <Trans>Show {hiddenCount} earlier</Trans>}
        </button>
      ) : null}
      {visible.map((message, index) => {
        const admin = message.author === "admin";
        const opensRun = visible[index - 1]?.author !== message.author;
        const time = message.createdAt
          ? formatTimeAgo(new Date(message.createdAt).toISOString(), locale)
          : null;
        const spacing = opensRun && index > 0 ? "pt-2.5" : "";
        const screenshots = message.screenshotCount > 0
          ? (
            <div className={`mt-1.5 flex ${admin ? "" : "justify-end"}`}>
              <ReporterScreenshots
                reportId={report.id}
                messageId={message.id}
                count={message.screenshotCount}
                onOpen={onOpenImage}
                align={admin ? "start" : "end"}
              />
            </div>
          )
          : null;
        if (!admin) {
          return (
            <div key={message.id} className={spacing}>
              <MessageBubble mine time={time}>{message.body}</MessageBubble>
              {screenshots}
            </div>
          );
        }
        return (
          <div key={message.id} className={`flex items-end gap-2 ${spacing}`}>
            {opensRun
              ? <Avatar userId={REPLY_AUTHOR.userId} size={26} />
              : <span className="w-[26px] flex-shrink-0" aria-hidden />}
            <div className="min-w-0 flex-1">
              {opensRun ? (
                <span className="mb-1 block pl-1 text-[11px] font-semibold text-osu-pink-light">
                  {REPLY_AUTHOR.username}
                </span>
              ) : null}
              <MessageBubble mine={false} time={time}>{message.body}</MessageBubble>
              {screenshots}
            </div>
          </div>
        );
      })}
    </div>
  );
}

function ReporterReplyComposer({
  report,
  onSent,
  onCancel,
  onOpenImage,
}: {
  report: MyBugReport;
  onSent: (report: MyBugReport, uploadWarning: boolean) => void;
  onCancel: () => void;
  onOpenImage: (urls: string[], index: number) => void;
}) {
  const { t } = useLingui();
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [uploads, setUploads] = useState<BugReportUploadStatus[]>([]);
  const images = useBugReportScreenshots();
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const send = async () => {
    const body = draft.trim();
    if (!body || busy) return;
    setBusy(true);
    setError(null);
    const selectedFiles = images.files.slice();
    setUploads(selectedFiles.map(() => "waiting"));
    try {
      const result = await replyToMyBugReport({
        data: { id: report.id, body, screenshotCount: selectedFiles.length },
      });
      if (!result.ok) {
        setError(result.reason === "too_many_messages"
          ? t`Too many updates today. Try again tomorrow.`
          : result.reason === "invalid_message"
            ? t`Write something first.`
            : t`Could not send that update. Try again.`);
        setUploads([]);
        return;
      }
      // The words are already stored, so a failed image is a line under the
      // thread rather than a lost reply.
      let uploaded = 0;
      if (selectedFiles.length) {
        uploaded = result.uploadToken && result.messageId
          ? await uploadBugReportScreenshots(report.id, result.uploadToken, selectedFiles, (index, status) => {
            setUploads((current) => current.map((entry, itemIndex) => (itemIndex === index ? status : entry)));
          }, result.messageId)
          : 0;
      }
      // The reply answered before its images were attached, so the counts it
      // came back with are one write behind what is now stored.
      const sentReport: MyBugReport = uploaded > 0
        ? {
          ...result.report,
          messages: result.report.messages.map((message) => (
            message.id === result.messageId ? { ...message, screenshotCount: uploaded } : message
          )),
        }
        : result.report;
      setDraft("");
      images.clear();
      setUploads([]);
      onSent(sentReport, uploaded < selectedFiles.length);
    } catch {
      setError(t`Could not send that update. Try again.`);
      setUploads([]);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mt-2.5 flex justify-end">
      <div
        onDragOver={(event) => {
          if (!busy) event.preventDefault();
        }}
        onDrop={(event) => {
          if (busy) return;
          event.preventDefault();
          images.add(event.dataTransfer.files);
        }}
        className="w-full max-w-[min(88%,34rem)] rounded-2xl rounded-br-md bg-osu-pink/10 px-3.5 py-2.5 ring-1 ring-osu-pink/20"
      >
        <textarea
          autoFocus
          value={draft}
          disabled={busy}
          maxLength={BUG_REPORT_MESSAGE_MAX}
          rows={2}
          onChange={(event) => setDraft(event.target.value)}
          onPaste={(event) => {
            const pasted = imagesFromClipboard(event);
            if (!pasted.length) return;
            event.preventDefault();
            images.add(pasted);
          }}
          onKeyDown={(event) => {
            if (event.key === "Escape" && !draft.trim()) onCancel();
            if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
              event.preventDefault();
              void send();
            }
          }}
          placeholder={t`Anything else that might help?`}
          className="block w-full resize-y bg-transparent text-[13.5px] leading-relaxed text-osu-c1 outline-none placeholder:text-osu-f1/55 disabled:opacity-60"
        />
        <PendingScreenshots
          files={images.files}
          previews={images.previews}
          uploads={uploads}
          busy={busy}
          className="pt-2"
          onOpen={(index) => onOpenImage(images.previews, index)}
          onRemove={images.removeAt}
        />
        <div className="mt-2 flex items-center gap-3">
          <button
            type="button"
            disabled={busy || images.files.length >= BUG_REPORT_MAX_SCREENSHOTS}
            onClick={() => fileInputRef.current?.click()}
            title={t`Add an image`}
            aria-label={t`Add an image`}
            className="inline-flex h-7 w-7 flex-shrink-0 cursor-pointer items-center justify-center rounded-md text-osu-f1 transition-colors duration-[120ms] hover:bg-osu-b4/70 hover:text-white disabled:cursor-not-allowed disabled:opacity-40"
          >
            <ImagePlus className="h-4 w-4" />
          </button>
          <input
            ref={fileInputRef}
            type="file"
            accept="image/*"
            multiple
            className="hidden"
            onChange={(event) => {
              images.add(event.target.files);
              event.target.value = "";
            }}
          />
          <button
            type="button"
            onClick={onCancel}
            className="cursor-pointer text-[11px] text-osu-f1 transition-colors duration-[120ms] hover:text-osu-l2"
          >
            <Trans>Cancel</Trans>
          </button>
          <button
            type="button"
            disabled={busy || !draft.trim()}
            onClick={() => void send()}
            className="ml-auto inline-flex h-7 cursor-pointer items-center gap-1.5 rounded-full bg-osu-pink px-3.5 text-[11.5px] font-semibold text-white transition-[filter] duration-[120ms] hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-40"
          >
            {busy ? <Loader2 className="h-3 w-3 animate-spin" /> : null}
            {busy ? t`Sending...` : t`Send`}
          </button>
        </div>
        {error ?? images.error
          ? <p className="mt-1.5 text-[11.5px] text-osu-pink-light">{error ?? images.error}</p>
          : null}
      </div>
    </div>
  );
}

/** Always on screen, shaped like the box you type in, so replying is obviously allowed. */
function ReporterReply({
  report,
  onSent,
  conversation,
  onOpenImage,
}: {
  report: MyBugReport;
  onSent: (report: MyBugReport) => void;
  conversation: boolean;
  onOpenImage: (urls: string[], index: number) => void;
}) {
  const [open, setOpen] = useState(false);
  const [uploadWarning, setUploadWarning] = useState(false);
  if (open) {
    return (
      <ReporterReplyComposer
        report={report}
        onCancel={() => setOpen(false)}
        onOpenImage={onOpenImage}
        onSent={(updated, warning) => {
          setOpen(false);
          setUploadWarning(warning);
          onSent(updated);
        }}
      />
    );
  }
  return (
    <>
      {uploadWarning ? (
        <p className={`mt-2 text-[11.5px] text-osu-pink-light ${conversation ? "text-right" : ""}`}>
          <Trans>Your reply was sent, but at least one image did not upload.</Trans>
        </p>
      ) : null}
      <div className={`mt-3 flex ${conversation ? "justify-end" : ""}`}>
        <button
          type="button"
          onClick={() => {
            setUploadWarning(false);
            setOpen(true);
          }}
          className="inline-flex cursor-pointer items-center gap-2 rounded-full bg-osu-b5/40 px-4 py-2 text-[12.5px] text-osu-f1 ring-1 ring-osu-b3/25 transition-colors duration-[120ms] hover:bg-osu-b4/50 hover:text-osu-l2"
        >
          <MessageSquare className="h-3.5 w-3.5" />
          {conversation ? <Trans>Write a reply</Trans> : <Trans>Add more details</Trans>}
        </button>
      </div>
    </>
  );
}

/*
 * The reporter's receipt. A report is one closed line until it is opened,
 * because the reason to come back is usually one particular report, not all of
 * them at once. Open it and it reads as a conversation: what you said, what
 * came back, and a reply box at the end.
 */
function ReportRow({
  report,
  locale,
  onOpenImage,
  onReportUpdated,
}: {
  report: MyBugReport;
  locale: ReturnType<typeof useLocale>;
  onOpenImage: (urls: string[], index: number) => void;
  onReportUpdated: (report: MyBugReport) => void;
}) {
  const [open, setOpen] = useState(false);
  const messages = bugReportThreadMessages(report);
  const waitingOnYou = messages[messages.length - 1]?.author === "admin";

  return (
    <li className="overflow-hidden rounded-2xl bg-osu-b6/45 ring-1 ring-osu-b3/20">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        className="flex w-full cursor-pointer items-center gap-2.5 px-3.5 py-3 text-left transition-colors duration-[120ms] hover:bg-osu-b5/30"
      >
        <ChevronRight
          className={`h-3.5 w-3.5 flex-shrink-0 text-osu-f1 transition-transform duration-150 ${open ? "rotate-90" : ""}`}
        />
        <span className={`min-w-0 flex-1 truncate text-[13.5px] ${open ? "text-osu-f1" : "text-osu-l1"}`}>
          {open ? report.pagePath ?? "" : report.body}
        </span>
        {messages.length ? (
          <span className={`inline-flex flex-shrink-0 items-center gap-1 text-[11.5px] tabular-nums ${
            waitingOnYou ? "text-osu-pink-light" : "text-osu-f1"
          }`}
          >
            <MessageSquare className="h-3 w-3" />
            {messages.length}
          </span>
        ) : null}
        <span className="flex-shrink-0 text-[11px] text-osu-f1">
          {formatTimeAgo(new Date(report.createdAt).toISOString(), locale)}
        </span>
        <StatusChip status={report.status} />
      </button>

      {open ? (
        <div className="px-3.5 pb-3.5">
          {messages.length ? (
            <>
              <MessageBubble mine time={null}>{report.body}</MessageBubble>
              <div className="mt-1.5 flex justify-end">
                <ReporterScreenshots
                  reportId={report.id}
                  count={report.screenshotCount}
                  onOpen={onOpenImage}
                  align="end"
                />
              </div>
              <ReporterThread report={report} locale={locale} onOpenImage={onOpenImage} />
            </>
          ) : (
            <div className="pl-6">
              <p className="whitespace-pre-wrap break-words text-[13.5px] leading-relaxed text-osu-l1">
                {report.body}
              </p>
              <div className="mt-2">
                <ReporterScreenshots
                  reportId={report.id}
                  count={report.screenshotCount}
                  onOpen={onOpenImage}
                  align="start"
                />
              </div>
            </div>
          )}
          <div className={messages.length ? "" : "pl-6"}>
            <ReporterReply
              report={report}
              onSent={onReportUpdated}
              conversation={messages.length > 0}
              onOpenImage={onOpenImage}
            />
          </div>
        </div>
      ) : null}
    </li>
  );
}

function MyReports({
  reports,
  locale,
  onOpenImage,
  onReportUpdated,
}: {
  reports: MyBugReport[] | null;
  locale: ReturnType<typeof useLocale>;
  onOpenImage: (urls: string[], index: number) => void;
  onReportUpdated: (report: MyBugReport) => void;
}) {
  if (!reports?.length) return null;
  return (
    <section className="mt-10">
      <h2 className="text-[11px] font-semibold uppercase tracking-wider text-osu-f1">
        <Trans>Your reports</Trans>
      </h2>
      <ul className="mt-3.5 space-y-2">
        {reports.map((report) => (
          <ReportRow
            key={report.id}
            report={report}
            locale={locale}
            onOpenImage={onOpenImage}
            onReportUpdated={onReportUpdated}
          />
        ))}
      </ul>
    </section>
  );
}

function StatusChip({ status }: { status: BugReportStatus }) {
  const { t } = useLingui();
  const label: Record<BugReportStatus, string> = {
    new: t`open`,
    investigating: t`looking into it`,
    pending: t`on the to-do list`,
    fixed: t`fixed`,
    wontfix: t`not a bug`,
    duplicate: t`already reported`,
    // The backend never sends this one to a reporter (it reads as "open"
    // instead, see toBugReportForReporter); the arm only keeps the map total.
    notabug: t`open`,
  };
  const tone = status === "fixed"
    ? "bg-emerald-400/10 text-emerald-200"
    : status === "new" || status === "investigating" || status === "pending" || status === "notabug"
      ? "bg-osu-pink/10 text-osu-pink-light"
      : "bg-osu-b4/60 text-osu-l2";
  return (
    <span className={`inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-[10.5px] ${tone}`}>
      <span className="h-1.5 w-1.5 rounded-full bg-current opacity-70" />
      {label[status]}
    </span>
  );
}
