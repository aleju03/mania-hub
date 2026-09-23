import { useCallback, useEffect, useRef, useState } from "react";
import { Link, createFileRoute } from "@tanstack/react-router";
import { AnimatePresence, motion } from "framer-motion";
import { BookOpen } from "lucide-react";
import { Trans, useLingui } from "@lingui/react/macro";
import { msg } from "@lingui/core/macro";

import { getI18n } from "../lib/i18n";
import { PageHeader } from "../components/layout/PageHeader";
import { useAuth } from "../lib/auth-context";
import { pageSeo } from "../lib/seo";
import { InstallationList } from "../components/companella/InstallationList";
import { SecurityActivity } from "../components/companella/SecurityActivity";
import { SubmissionDetail } from "../components/companella/SubmissionDetail";
import { SubmissionList } from "../components/companella/SubmissionList";
import { ScoreDetailModal } from "../components/player/ScoreRows";
import { companellaRowToOsuScore } from "../lib/companella-scores";
import { TestClientPanel } from "../components/companella/TestClientPanel";
import { Empty, Panel } from "../components/companella/primitives";
import {
  clearRevokedCompanellaInstallations,
  fetchCompanellaAccess,
  fetchCompanellaInstallations,
  fetchCompanellaSecurityEvents,
  fetchCompanellaSubmissions,
  renameCompanellaInstallation,
  revokeAllCompanellaInstallations,
  revokeCompanellaInstallation,
} from "../lib/companella-integration/manage-server";
import type {
  CompanellaAccess,
  CompanellaInstallation,
  CompanellaSecurityEvent,
  CompanellaSubmissionRow,
} from "../lib/companella-integration/shared";

/*
 * /companella: the owner-facing side of the Companella score-import beta.
 *
 * Gated end to end. Hiding the navigation link is not the access control - the
 * backend applies the same policy to every route behind this page, so a signed
 * -out visitor, a non-allowlisted account and a disabled deployment each get a
 * deliberate answer rather than an empty shell.
 */

/** Rows still moving are re-read on one coalesced poll, paused when hidden. */
const ACTIVE_STATES = new Set(["awaiting_assets", "queued", "validating", "analyzing"]);
/** A deferred row waits minutes for its next retry, so it is re-read at the slow pace. */
const RETRYING_STATES = new Set(["deferred"]);
const POLL_MIN_MS = 4_000;
const POLL_MAX_MS = 30_000;
const PAGE_SIZE = 10;

export const Route = createFileRoute("/companella")({
  // The test client's callback hands its grant back through these, and the
  // panel removes them from the address bar as soon as it has them.
  validateSearch: (search: Record<string, unknown>) => ({
    code: typeof search.code === "string" ? search.code : undefined,
    state: typeof search.state === "string" ? search.state : undefined,
  }),
  head: ({ match }) => {
    const i18n = getI18n(match.context.locale);
    return pageSeo({
      title: i18n._(msg`Companella`),
      description: i18n._(msg`Connect Companella to Mania Tracker and review the plays it imported.`),
      path: "/companella",
      origin: match.context.origin,
      imageTitle: "Companella",
      // Per-viewer, gated content; there is nothing here for a crawler.
      noindex: true,
    });
  },
  component: CompanellaPage,
});

function CompanellaPage() {
  const { t } = useLingui();
  const auth = useAuth();
  const [access, setAccess] = useState<CompanellaAccess | null>(null);
  const [installations, setInstallations] = useState<CompanellaInstallation[]>([]);
  const [submissions, setSubmissions] = useState<CompanellaSubmissionRow[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  // The cursor each visited page was read with; the last one is the page shown.
  const [pageCursors, setPageCursors] = useState<Array<string | null>>([null]);
  const [pageLoading, setPageLoading] = useState(false);
  const [events, setEvents] = useState<CompanellaSecurityEvent[]>([]);
  const [selected, setSelected] = useState<CompanellaSubmissionRow | null>(null);
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const pollDelay = useRef(POLL_MIN_MS);

  const pageCursor = pageCursors[pageCursors.length - 1] ?? null;
  const loadAll = useCallback(async () => {
    const [installationsResult, submissionsResult, eventsResult] = await Promise.all([
      fetchCompanellaInstallations().catch(() => ({ installations: [] })),
      fetchCompanellaSubmissions({ data: { limit: PAGE_SIZE, cursor: pageCursor } }).catch(() => ({ submissions: [], next_cursor: null })),
      fetchCompanellaSecurityEvents().catch(() => ({ events: [] })),
    ]);
    setInstallations(installationsResult.installations);
    setSubmissions(submissionsResult.submissions);
    setNextCursor(submissionsResult.next_cursor);
    setEvents(eventsResult.events);
  }, [pageCursor]);

  const loadAllRef = useRef(loadAll);
  loadAllRef.current = loadAll;

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    void fetchCompanellaAccess()
      .then(async (result) => {
        if (cancelled) return;
        setAccess(result);
        // A former member keeps a view of what they have, to revoke or delete it.
        if (result.allowed || result.hasData) await loadAllRef.current();
      })
      .catch(() => {
        if (!cancelled) setAccess(null);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // One poll for the whole visible page, backing off while nothing moves and
  // stopping entirely in a hidden tab.
  useEffect(() => {
    if (!access?.allowed && !access?.hasData) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let stopped = false;
    const tick = async () => {
      if (stopped) return;
      if (document.visibilityState === "visible") {
        const active = submissions.some((row) => ACTIVE_STATES.has(row.state));
        const retrying = submissions.some((row) => RETRYING_STATES.has(row.state));
        if (active) {
          pollDelay.current = POLL_MIN_MS;
          await loadAll().catch(() => {});
        } else if (retrying) {
          pollDelay.current = POLL_MAX_MS;
          await loadAll().catch(() => {});
        } else {
          // Still fetched while idle: a play sent from the desktop client
          // shows up only through this poll.
          pollDelay.current = Math.min(pollDelay.current * 1.5, POLL_MAX_MS);
          await loadAll().catch(() => {});
        }
      }
      timer = setTimeout(() => void tick(), pollDelay.current);
    };
    timer = setTimeout(() => void tick(), pollDelay.current);
    return () => {
      stopped = true;
      if (timer) clearTimeout(timer);
    };
  }, [access?.allowed, access?.hasData, loadAll, submissions]);

  const activeInstallations = installations.filter((installation) => installation.status === "active").length;

  const turnPage = useCallback(async (direction: -1 | 1) => {
    const cursors = direction === 1
      ? (nextCursor ? [...pageCursors, nextCursor] : pageCursors)
      : pageCursors.slice(0, Math.max(1, pageCursors.length - 1));
    if (cursors === pageCursors) return;
    setPageLoading(true);
    const page = await fetchCompanellaSubmissions({ data: { limit: PAGE_SIZE, cursor: cursors[cursors.length - 1] ?? null } }).catch(() => null);
    setPageLoading(false);
    if (!page) return;
    setPageCursors(cursors);
    setSubmissions(page.submissions);
    setNextCursor(page.next_cursor);
  }, [nextCursor, pageCursors]);

  useEffect(() => {
    if (!selected) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setSelected(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [selected]);

  if (loading && !access) {
    return (
      <Shell>
        <div className="h-40 animate-pulse rounded-xl bg-osu-b4/40" />
      </Shell>
    );
  }

  if (!access?.backendReachable) {
    return (
      <Shell>
        <Panel title={<Trans>Companella</Trans>}>
          <Empty><Trans>The integration backend is not reachable right now.</Trans></Empty>
        </Panel>
      </Shell>
    );
  }

  if (!access.enabled) {
    return (
      <Shell>
        <Panel title={<Trans>Companella</Trans>}>
          <Empty><Trans>The Companella beta is not switched on for this site yet.</Trans></Empty>
        </Panel>
      </Shell>
    );
  }

  if (!auth.viewer) {
    return (
      <Shell>
        <Panel title={<Trans>Companella</Trans>}>
          <Empty><Trans>Sign in with osu! to connect Companella and see the plays it imported.</Trans></Empty>
        </Panel>
      </Shell>
    );
  }

  if (!access.allowed && !access.hasData) {
    return (
      <Shell>
        <Panel title={<Trans>Companella</Trans>}>
          <Empty><Trans>This account is not in the Companella beta.</Trans></Empty>
        </Panel>
      </Shell>
    );
  }

  return (
    <Shell>
      <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="flex flex-col gap-7">
        {notice && <p className="text-center text-xs text-osu-f1">{notice}</p>}
        {!access.allowed && (
          <p className="text-center text-xs text-osu-f1"><Trans>This account is not in the Companella beta.</Trans></p>
        )}

        <section className="flex flex-wrap items-center gap-x-4 gap-y-2">
          <div className="min-w-0 flex-1">
            <p className="text-sm text-white">
              {activeInstallations === 0
                ? <Trans>Signed in as {auth.viewer.username}. Nothing is connected yet.</Trans>
                : <Trans>Signed in as {auth.viewer.username}. {activeInstallations} connected.</Trans>}
            </p>
            <p className="mt-0.5 text-[12px] text-osu-f1">
              <Trans>Plays Companella sends show on the tracker and your profile. Their replays stay private to you.</Trans>
            </p>
            {!access.storageReady && (
              <p className="mt-1 text-[12px] text-rose-300">
                <Trans>Storage is not configured, so uploads will fail until it is.</Trans>
              </p>
            )}
          </div>
          <Link
            to="/companella/docs"
            className="inline-flex flex-shrink-0 items-center gap-1.5 rounded-lg bg-osu-b4 px-3 py-1.5 text-[12px] font-semibold text-osu-f1 transition-colors hover:bg-osu-b3 hover:text-white"
          >
            <BookOpen size={13} />
            <Trans>API docs</Trans>
          </Link>
        </section>

        <InstallationList
          installations={installations}
          busyId={busyId}
          onRename={(id, name) => {
            setBusyId(id);
            void renameCompanellaInstallation({ data: { installationId: id, displayName: name } })
              .then(() => loadAll())
              .catch(() => setNotice(t`Could not rename that connection.`))
              .finally(() => setBusyId(null));
          }}
          onRevoke={(id) => {
            if (!window.confirm(t`Revoke this connection? It stops submitting right away.`)) return;
            setBusyId(id);
            void revokeCompanellaInstallation({ data: { installationId: id } })
              .then(() => loadAll())
              .catch(() => setNotice(t`Could not revoke that connection.`))
              .finally(() => setBusyId(null));
          }}
          onRevokeAll={() => {
            if (!window.confirm(t`Revoke every connection on this account?`)) return;
            void revokeAllCompanellaInstallations().then(() => loadAll()).catch(() => {
              setNotice(t`Could not revoke the connections.`);
            });
          }}
          onClearRevoked={() => {
            void clearRevokedCompanellaInstallations().then(() => loadAll()).catch(() => {
              setNotice(t`Could not clear the revoked connections.`);
            });
          }}
        />

        <SubmissionList
          rows={submissions}
          loading={loading || pageLoading}
          page={pageCursors.length - 1}
          hasNext={Boolean(nextCursor)}
          onPage={(direction) => void turnPage(direction)}
          onOpen={setSelected}
        />

        <AnimatePresence>
          {selected?.play && (
            <ScoreDetailModal
              key={selected.submission_id}
              score={companellaRowToOsuScore(selected.play)}
              onClose={() => setSelected(null)}
              extra={(
                <SubmissionDetail
                  row={selected}
                  onDeleted={() => {
                    setSelected(null);
                    void loadAll();
                  }}
                />
              )}
            />
          )}
        </AnimatePresence>

        <SecurityActivity events={events} />

        {/* Creating a test installation starts a connection, which is for current members only. */}
        {access.testClientEnabled && access.allowed && <TestClientPanel onSubmitted={() => void loadAll()} />}
      </motion.div>
    </Shell>
  );
}

function Shell({ children }: { children: React.ReactNode }) {
  const { t } = useLingui();
  return (
    <div className="flex-1">
      <PageHeader iconSrc="/images/icons/home.svg" title={t`Companella`} />
      <div className="bg-osu-b5 min-h-[80vh]">
        <div className="mx-auto max-w-[1200px] px-3 py-3 sm:px-5 sm:py-6">
          <div className="mx-auto max-w-3xl">{children}</div>
        </div>
      </div>
    </div>
  );
}
