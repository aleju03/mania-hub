import { useCallback, useEffect, useRef, useState } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { motion } from "framer-motion";
import { Trans, useLingui } from "@lingui/react/macro";
import { msg } from "@lingui/core/macro";

import { getI18n } from "../lib/i18n";
import { PageHeader } from "../components/layout/PageHeader";
import { useAuth } from "../lib/auth-context";
import { pageSeo } from "../lib/seo";
import { InstallationList } from "../components/companella/InstallationList";
import { RatingPreviewPanel } from "../components/companella/RatingPreviewPanel";
import { SecurityActivity } from "../components/companella/SecurityActivity";
import { SubmissionDetail } from "../components/companella/SubmissionDetail";
import { SubmissionList } from "../components/companella/SubmissionList";
import { TestClientPanel } from "../components/companella/TestClientPanel";
import { Empty, Panel } from "../components/companella/primitives";
import {
  fetchCompanellaAccess,
  fetchCompanellaInstallations,
  fetchCompanellaPreview,
  fetchCompanellaSecurityEvents,
  fetchCompanellaSubmissions,
  renameCompanellaInstallation,
  revokeAllCompanellaInstallations,
  revokeCompanellaInstallation,
} from "../lib/companella-integration/manage-server";
import type {
  CompanellaAccess,
  CompanellaInstallation,
  CompanellaPreview,
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
  const [cursor, setCursor] = useState<string | null>(null);
  const [preview, setPreview] = useState<CompanellaPreview | null>(null);
  const [events, setEvents] = useState<CompanellaSecurityEvent[]>([]);
  const [selected, setSelected] = useState<CompanellaSubmissionRow | null>(null);
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const pollDelay = useRef(POLL_MIN_MS);

  const loadAll = useCallback(async () => {
    const [installationsResult, submissionsResult, previewResult, eventsResult] = await Promise.all([
      fetchCompanellaInstallations().catch(() => ({ installations: [] })),
      fetchCompanellaSubmissions({ data: { limit: 20 } }).catch(() => ({ submissions: [], next_cursor: null })),
      fetchCompanellaPreview({ data: {} }).catch(() => ({ preview: null })),
      fetchCompanellaSecurityEvents().catch(() => ({ events: [] })),
    ]);
    setInstallations(installationsResult.installations);
    setSubmissions(submissionsResult.submissions);
    setCursor(submissionsResult.next_cursor);
    setPreview(previewResult.preview);
    setEvents(eventsResult.events);
  }, []);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    void fetchCompanellaAccess()
      .then(async (result) => {
        if (cancelled) return;
        setAccess(result);
        // A former member keeps a view of what they have, to revoke or delete it.
        if (result.allowed || result.hasData) await loadAll();
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
  }, [loadAll]);

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
          pollDelay.current = Math.min(pollDelay.current * 1.5, POLL_MAX_MS);
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

  const loadMore = useCallback(async () => {
    if (!cursor) return;
    const page = await fetchCompanellaSubmissions({ data: { limit: 20, cursor } }).catch(() => null);
    if (!page) return;
    setSubmissions((previous) => [...previous, ...page.submissions]);
    setCursor(page.next_cursor);
  }, [cursor]);

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
      <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="flex flex-col gap-4">
        {notice && <p className="text-center text-xs text-osu-f1">{notice}</p>}
        {!access.allowed && (
          <p className="text-center text-xs text-osu-f1"><Trans>This account is not in the Companella beta.</Trans></p>
        )}

        <Panel title={<Trans>Connection</Trans>}>
          {/* Being signed in to the site is not the same as having connected
              an installation, and the first line has to say which it is. */}
          <p className="text-sm text-white">
            {activeInstallations === 0
              ? <Trans>Signed in as {auth.viewer.username}. Nothing is connected yet.</Trans>
              : <Trans>Signed in as {auth.viewer.username}. {activeInstallations} connected.</Trans>}
          </p>
          <p className="mt-2 text-xs text-osu-f1">
            <Trans>
              Companella can send completed osu!stable mania plays here after you approve it. Approve from the app: it
              opens this site in your browser, you name the installation, and the approval is bound to that installation
              only.
            </Trans>
          </p>
          <p className="mt-2 text-xs text-osu-f1">
            <Trans>
              Imported plays that pass the checks show on the tracker and your profile. Their replays stay private to you
              unless your osu! account is restricted. Public rankings, pp, snipes and rewards are not affected by anything
              on this page.
            </Trans>
          </p>
          {!access.storageReady && (
            <p className="mt-2 text-xs text-rose-300">
              <Trans>Storage is not configured, so uploads will fail until it is.</Trans>
            </p>
          )}
        </Panel>

        <InstallationList
          installations={installations}
          busyId={busyId}
          onRename={(id, name) => {
            setBusyId(id);
            void renameCompanellaInstallation({ data: { installationId: id, displayName: name } })
              .then(() => loadAll())
              .catch(() => setNotice(t`Could not rename that installation.`))
              .finally(() => setBusyId(null));
          }}
          onRevoke={(id) => {
            if (!window.confirm(t`Revoke this installation? It stops submitting right away.`)) return;
            setBusyId(id);
            void revokeCompanellaInstallation({ data: { installationId: id } })
              .then(() => loadAll())
              .catch(() => setNotice(t`Could not revoke that installation.`))
              .finally(() => setBusyId(null));
          }}
          onRevokeAll={() => {
            if (!window.confirm(t`Revoke every installation on this account?`)) return;
            void revokeAllCompanellaInstallations().then(() => loadAll()).catch(() => {
              setNotice(t`Could not revoke the installations.`);
            });
          }}
        />

        <SubmissionList
          rows={submissions}
          hasMore={Boolean(cursor)}
          loading={loading}
          onLoadMore={() => void loadMore()}
          onOpen={setSelected}
        />

        {selected && (
          <SubmissionDetail
            row={selected}
            onClose={() => setSelected(null)}
            onDeleted={() => {
              setSelected(null);
              void loadAll();
            }}
          />
        )}

        <RatingPreviewPanel preview={preview} />

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
