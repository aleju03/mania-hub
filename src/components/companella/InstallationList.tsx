import { useState } from "react";
import { Check, Pencil, X } from "lucide-react";
import { Trans, useLingui } from "@lingui/react/macro";

import { formatTimeAgo } from "#/lib/format";
import { useLocale } from "#/lib/locale-context";
import type { CompanellaInstallation } from "#/lib/companella-integration/shared";
import { ActionButton, Empty, Panel } from "./primitives";

/*
 * Approved connections.
 *
 * "Last seen", never a live indicator: there is no socket here, and a green
 * dot would claim knowledge the server does not have. Revoked ones fold into
 * one line the owner can open or clear.
 */
export function InstallationList({
  installations,
  busyId,
  onRename,
  onRevoke,
  onRevokeAll,
  onClearRevoked,
}: {
  installations: CompanellaInstallation[];
  busyId: string | null;
  onRename: (id: string, name: string) => void;
  onRevoke: (id: string) => void;
  onRevokeAll: () => void;
  onClearRevoked: () => void;
}) {
  const { t } = useLingui();
  const locale = useLocale();
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [showRevoked, setShowRevoked] = useState(false);
  const active = installations.filter((installation) => installation.status === "active");
  const revoked = installations.filter((installation) => installation.status !== "active");

  const row = (installation: CompanellaInstallation) => {
    const isActive = installation.status === "active";
    const meta = [
      installation.clientId,
      `${t`approved`} ${formatTimeAgo(installation.approvedAt, locale)}`,
      installation.lastSeenAt ? `${t`last seen`} ${formatTimeAgo(installation.lastSeenAt, locale)}` : t`never seen`,
    ].join(" · ");
    return (
      <div key={installation.id} className="flex items-center gap-3 py-2.5">
        <span className={`h-2 w-2 flex-shrink-0 rounded-full ${isActive ? "bg-emerald-400" : "bg-osu-b3"}`} />
        {editing === installation.id ? (
          <form
            className="flex min-w-0 flex-1 items-center gap-1.5"
            onSubmit={(event) => {
              event.preventDefault();
              onRename(installation.id, draft);
              setEditing(null);
            }}
          >
            <input
              autoFocus
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Escape") setEditing(null);
              }}
              maxLength={60}
              aria-label={t`Connection name`}
              className="min-w-0 flex-1 rounded-md bg-osu-b5 px-2 py-1 text-sm text-white outline-none focus:ring-1 focus:ring-osu-pink"
            />
            <button type="submit" aria-label={t`Save`} className="cursor-pointer rounded-md p-1.5 text-osu-f1 hover:bg-osu-b3 hover:text-white">
              <Check size={14} />
            </button>
            <button type="button" onClick={() => setEditing(null)} aria-label={t`Cancel`} className="cursor-pointer rounded-md p-1.5 text-osu-f1 hover:bg-osu-b3 hover:text-white">
              <X size={14} />
            </button>
          </form>
        ) : (
          <>
            <div className="min-w-0 flex-1">
              <div className={`truncate text-sm font-semibold ${isActive ? "text-white" : "text-osu-f1"}`}>{installation.displayName}</div>
              <div className="truncate text-[11px] text-osu-f1">{meta}</div>
            </div>
            {isActive && (
              <div className="flex flex-shrink-0 items-center gap-1">
                <button
                  type="button"
                  onClick={() => {
                    setEditing(installation.id);
                    setDraft(installation.displayName);
                  }}
                  disabled={busyId === installation.id}
                  aria-label={t`Rename`}
                  title={t`Rename`}
                  className="cursor-pointer rounded-md p-1.5 text-osu-f1 transition-colors hover:bg-osu-b3 hover:text-white disabled:opacity-40"
                >
                  <Pencil size={13} />
                </button>
                <ActionButton tone="danger" disabled={busyId === installation.id} onClick={() => onRevoke(installation.id)}>
                  <Trans>Revoke</Trans>
                </ActionButton>
              </div>
            )}
          </>
        )}
      </div>
    );
  };

  return (
    <Panel
      title={<Trans>Connections</Trans>}
      right={active.length > 1 ? (
        <ActionButton tone="danger" onClick={onRevokeAll}><Trans>Revoke all</Trans></ActionButton>
      ) : null}
    >
      {active.length === 0 && revoked.length === 0 ? (
        <Empty><Trans>Nothing is connected yet. Connect from Companella's settings.</Trans></Empty>
      ) : (
        <div className="divide-y divide-white/[0.06]">
          {active.map(row)}
          {active.length === 0 && (
            <p className="py-3 text-[12px] text-osu-f1"><Trans>Nothing is connected right now.</Trans></p>
          )}
          {revoked.length > 0 && (
            <div className="py-2">
              <div className="flex items-center gap-2 text-[11px] text-osu-f1">
                <button
                  type="button"
                  onClick={() => setShowRevoked((value) => !value)}
                  className="cursor-pointer transition-colors hover:text-white"
                >
                  {showRevoked ? t`Hide ${revoked.length} revoked` : t`Show ${revoked.length} revoked`}
                </button>
                <span className="text-osu-b3">·</span>
                <button type="button" onClick={onClearRevoked} className="cursor-pointer transition-colors hover:text-rose-300">
                  <Trans>Clear</Trans>
                </button>
              </div>
              {showRevoked && <div className="mt-1 divide-y divide-white/[0.06]">{revoked.map(row)}</div>}
            </div>
          )}
        </div>
      )}
    </Panel>
  );
}
