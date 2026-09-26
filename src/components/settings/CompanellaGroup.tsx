import { useCallback, useEffect, useState } from "react";
import { Link } from "@tanstack/react-router";
import { Trans, useLingui } from "@lingui/react/macro";

import { useAuth } from "../../lib/auth-context";
import { formatTimeAgo } from "../../lib/format";
import { useLocale } from "../../lib/locale-context";
import {
  fetchCompanellaAccess,
  fetchCompanellaInstallations,
  revokeCompanellaInstallation,
} from "../../lib/companella-integration/manage-server";
import type { CompanellaAccess, CompanellaInstallation } from "../../lib/companella-integration/shared";
import { PanelGroup } from "./PanelGroup";

/*
 * The Integrations group in Settings, with Companella its only entry so far: whether it is connected, and each
 * connected computer with a Revoke. Connecting happens from inside the app.
 * /companella stays the client developer's test bench.
 */
export function CompanellaGroup() {
  const { t } = useLingui();
  const auth = useAuth();
  const locale = useLocale();
  const [access, setAccess] = useState<CompanellaAccess | null>(null);
  const [installations, setInstallations] = useState<CompanellaInstallation[]>([]);
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);

  const load = useCallback(async () => {
    const result = await fetchCompanellaInstallations().catch(() => ({ installations: [] }));
    setInstallations(result.installations);
  }, []);

  useEffect(() => {
    let cancelled = false;
    void fetchCompanellaAccess()
      .then(async (result) => {
        if (cancelled) return;
        setAccess(result);
        if (result.allowed || result.hasData) await load();
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
  }, [load]);

  const active = installations.filter((installation) => installation.status === "active");
  const status = loading ? null
    : !access?.backendReachable ? t`Not reachable right now.`
    : !access.enabled ? t`Not available yet.`
    : !auth.viewer ? t`Sign in with osu! to connect it.`
    : !access.allowed && !access.hasData ? t`Not available for this account yet.`
    : !access.allowed ? t`Not available for this account.`
    : active.length > 0 ? t`${active.length} connected`
    : t`Not connected. Connect from inside Companella.`;

  return (
    <PanelGroup label={t`Integrations`}>
      <div className="flex items-center gap-3">
        <img src="/images/companella-icon.png" alt="" width={32} height={32} className="h-8 w-8 shrink-0 rounded-lg" />
        <div className="min-w-0 flex-1">
          <div className="text-[12px] font-semibold text-osu-l1">Companella</div>
          {status ? (
            <div className="text-[11px] text-osu-f1">{status}</div>
          ) : (
            <div className="mt-1 h-3 w-32 animate-pulse rounded bg-osu-b4/60" />
          )}
        </div>
        <Link
          to="/news/companella"
          className="shrink-0 rounded-lg bg-osu-b4 px-3 py-1.5 text-[11px] font-semibold text-osu-f1 transition-colors hover:bg-osu-b3 hover:text-white"
        >
          <Trans>About</Trans>
        </Link>
      </div>
      {active.length > 0 && (
        <div className="divide-y divide-white/[0.06] border-t border-white/[0.07]">
          {active.map((installation) => (
            <div key={installation.id} className="flex items-center gap-3 py-2.5">
              <div className="min-w-0 flex-1">
                <div className="truncate text-[12px] font-semibold text-white">{installation.displayName}</div>
                <div className="text-[11px] text-osu-f1">
                  {installation.lastSeenAt
                    ? t`last seen ${formatTimeAgo(installation.lastSeenAt, locale)}`
                    : t`never seen`}
                </div>
              </div>
              <button
                type="button"
                disabled={busyId === installation.id}
                onClick={() => {
                  if (!window.confirm(t`Revoke this connection? Companella on that computer stops sending plays right away.`)) return;
                  setBusyId(installation.id);
                  setFailed(false);
                  void revokeCompanellaInstallation({ data: { installationId: installation.id } })
                    .then(() => load())
                    .catch(() => setFailed(true))
                    .finally(() => setBusyId(null));
                }}
                className="shrink-0 cursor-pointer rounded-lg bg-osu-b4 px-2.5 py-1 text-[11px] font-semibold text-rose-300 transition-colors hover:bg-rose-500/20 hover:text-rose-200 disabled:cursor-default disabled:opacity-40"
              >
                <Trans>Revoke</Trans>
              </button>
            </div>
          ))}
        </div>
      )}
      {failed && <p role="alert" className="text-[11px] text-red-300"><Trans>Could not revoke that connection.</Trans></p>}
    </PanelGroup>
  );
}
