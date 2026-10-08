import { useCallback, useEffect, useState } from "react";
import { Link } from "@tanstack/react-router";
import { plural } from "@lingui/core/macro";
import { Trans, useLingui } from "@lingui/react/macro";

import { useAuth } from "../../lib/auth-context";
import { formatTimeAgo } from "../../lib/format";
import { useLocale } from "../../lib/locale-context";
import {
  fetchCompanellaAccess,
  fetchCompanellaInstallations,
  revokeCompanellaInstallation,
} from "../../lib/companella-integration/manage-server";
import { KNOWN_APPS, type CompanellaAccess, type CompanellaInstallation } from "../../lib/companella-integration/shared";
import { ConfirmModal } from "../ui/ConfirmModal";
import { PanelGroup } from "./PanelGroup";

interface CompanellaSnapshot {
  viewerId: number | null;
  access: CompanellaAccess | null;
  installations: CompanellaInstallation[];
  expiresAt: number;
}

// Settings unmounts a tab's panel when you switch away, so without this every return to Preferences refetched both.
const SNAPSHOT_TTL_MS = 60_000;
const BRIDGE_CLIENT_ID = "mania-bridge";
let snapshot: CompanellaSnapshot | null = null;

function freshSnapshot(viewerId: number | null): CompanellaSnapshot | null {
  return snapshot && snapshot.viewerId === viewerId && snapshot.expiresAt > Date.now() ? snapshot : null;
}

/*
 * The Integrations group in Settings: Companella, and Mania Bridge for admins until its release (like /bridge),
 * each with its connected computers and a Revoke. Connecting happens from inside the app.
 * /companella stays the client developer's test bench.
 */
export function CompanellaGroup() {
  const { t } = useLingui();
  const auth = useAuth();
  const viewerId = auth.viewer?.id ?? null;
  const cached = freshSnapshot(viewerId);
  const [access, setAccess] = useState<CompanellaAccess | null>(cached?.access ?? null);
  const [installations, setInstallations] = useState<CompanellaInstallation[]>(cached?.installations ?? []);
  const [loading, setLoading] = useState(!cached);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const [pendingRevoke, setPendingRevoke] = useState<{ installation: CompanellaInstallation; appName: string } | null>(null);

  const load = useCallback(async (currentAccess: CompanellaAccess | null) => {
    const result = await fetchCompanellaInstallations().catch(() => ({ installations: [] }));
    setInstallations(result.installations);
    snapshot = { viewerId, access: currentAccess, installations: result.installations, expiresAt: Date.now() + SNAPSHOT_TTL_MS };
  }, [viewerId]);

  useEffect(() => {
    if (freshSnapshot(viewerId)) return;
    let cancelled = false;
    setLoading(true);
    setInstallations([]);
    void fetchCompanellaAccess()
      .then(async (result) => {
        if (cancelled) return;
        setAccess(result);
        if (result.allowed || result.hasData) await load(result);
        else snapshot = { viewerId, access: result, installations: [], expiresAt: Date.now() + SNAPSHOT_TTL_MS };
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
  }, [viewerId, load]);

  const active = installations.filter((installation) => installation.status === "active");
  const bridgeApp = KNOWN_APPS[BRIDGE_CLIENT_ID];
  const bridge = active.filter((installation) => installation.clientId === BRIDGE_CLIENT_ID);
  const companella = active.filter((installation) => installation.clientId !== BRIDGE_CLIENT_ID);
  // Both apps connect through the same integration, so whatever keeps one from connecting keeps the other too.
  const blocked = loading ? null
    : !access?.backendReachable ? t`Not reachable right now.`
    : !access.enabled ? t`Not available yet.`
    : !auth.viewer ? t`Sign in with osu! to connect it.`
    : !access.allowed && !access.hasData ? t`Not available for this account yet.`
    : !access.allowed ? t`Not available for this account.`
    : undefined;
  const statusFor = (connected: CompanellaInstallation[], appName: string) => blocked !== undefined ? blocked
    : connected.length > 0 ? t`${plural(connected.length, { one: "# connected", other: "# connected" })}`
    : t`Not connected. Connect from inside ${appName}.`;

  const revoke = (installation: CompanellaInstallation) => {
    setBusyId(installation.id);
    setFailed(false);
    void revokeCompanellaInstallation({ data: { installationId: installation.id } })
      .then(() => load(access))
      .catch(() => setFailed(true))
      .finally(() => setBusyId(null));
  };

  return (
    <PanelGroup label={t`Integrations`}>
      {auth.canUseAdminFeatures && (
        <IntegrationApp
          name={bridgeApp.name}
          icon={bridgeApp.icon}
          aboutTo="/bridge"
          status={statusFor(bridge, bridgeApp.name)}
          installations={bridge}
          busyId={busyId}
          onRevoke={(installation) => setPendingRevoke({ installation, appName: bridgeApp.name })}
        />
      )}
      <div className={auth.canUseAdminFeatures ? "space-y-3 border-t border-white/[0.07] pt-3" : "space-y-3"}>
        <IntegrationApp
          name="Companella"
          icon="/images/companella-icon.png"
          // The Companella art sits in transparent padding (218 of 256px) while Bridge's fills its square.
          iconClassName="scale-[1.17]"
          status={statusFor(companella, "Companella")}
          aboutTo="/news/companella"
          installations={companella}
          busyId={busyId}
          onRevoke={(installation) => setPendingRevoke({ installation, appName: "Companella" })}
        />
      </div>
      {failed && <p role="alert" className="text-[11px] text-red-300"><Trans>Could not revoke that connection.</Trans></p>}
      {pendingRevoke && (
        <ConfirmModal
          title={t`Revoke this connection?`}
          body={t`${pendingRevoke.appName} on that computer stops sending plays right away.`}
          confirmLabel={t`Revoke`}
          cancelLabel={t`Cancel`}
          danger
          onConfirm={() => revoke(pendingRevoke.installation)}
          onClose={() => setPendingRevoke(null)}
        />
      )}
    </PanelGroup>
  );
}

function IntegrationApp({ name, icon, iconClassName = "", status, aboutTo, installations, busyId, onRevoke }: {
  name: string;
  icon: string;
  iconClassName?: string;
  status: string | null;
  aboutTo?: "/news/companella" | "/bridge";
  installations: CompanellaInstallation[];
  busyId: string | null;
  onRevoke: (installation: CompanellaInstallation) => void;
}) {
  const { t } = useLingui();
  const locale = useLocale();
  const seen = (installation: CompanellaInstallation) => installation.lastSeenAt
    ? t`last seen ${formatTimeAgo(installation.lastSeenAt, locale)}`
    : t`never seen`;
  // One computer folds into the app row; the computer's name defaults to the app's, so it only shows when renamed.
  const single = installations.length === 1 ? installations[0] : null;
  const singleStatus = single && (single.lastSeenAt
    ? t`Connected, last seen ${formatTimeAgo(single.lastSeenAt, locale)}`
    : t`Connected, never seen`);
  const revokeButton = (installation: CompanellaInstallation, className: string) => (
    <button
      type="button"
      disabled={busyId === installation.id}
      onClick={() => onRevoke(installation)}
      className={`shrink-0 cursor-pointer text-[11px] font-semibold text-rose-300 transition-colors hover:text-rose-200 disabled:cursor-default disabled:opacity-40 ${className}`}
    >
      <Trans>Revoke</Trans>
    </button>
  );
  return (
    <div className="flex items-start gap-3">
      <img src={icon} alt="" width={32} height={32} className={`h-8 w-8 shrink-0 rounded-lg ${iconClassName}`} />
      <div className="min-w-0 flex-1">
        <div className="flex min-h-8 items-center gap-2">
          <div className="min-w-0 flex-1">
            <div className="text-[12px] font-semibold text-osu-l1">{name}</div>
            {status ? (
              <div className="text-[11px] text-osu-f1">
                {singleStatus ?? status}
                {single && single.displayName !== name && (
                  <>
                    <span aria-hidden className="mx-1.5 inline-block h-2.5 w-px translate-y-px bg-white/15" />
                    {single.displayName}
                  </>
                )}
              </div>
            ) : (
              <div className="mt-1 h-3 w-32 animate-pulse rounded bg-osu-b4/60" />
            )}
          </div>
          {single && revokeButton(single, "rounded-lg bg-osu-b4 px-3 py-1.5 hover:bg-rose-500/20")}
          {aboutTo && (
            <Link
              to={aboutTo}
              className="shrink-0 rounded-lg bg-osu-b4 px-3 py-1.5 text-[11px] font-semibold text-osu-f1 transition-colors hover:bg-osu-b3 hover:text-white"
            >
              <Trans>About</Trans>
            </Link>
          )}
        </div>
        {installations.length > 1 && (
          <div className="mt-1.5 space-y-1.5">
            {installations.map((installation) => (
              <div key={installation.id} className="flex items-center gap-3 text-[11px] text-osu-f1">
                <div className="min-w-0 flex-1 truncate">
                  {installation.displayName !== name && (
                    <>
                      <span className="font-semibold text-osu-l1">{installation.displayName}</span>
                      <span aria-hidden className="mx-1.5 inline-block h-2.5 w-px translate-y-px bg-white/15" />
                    </>
                  )}
                  {seen(installation)}
                </div>
                {revokeButton(installation, "")}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
