import { useState } from "react";
import { Trans, useLingui } from "@lingui/react/macro";

import { formatTimeAgo } from "#/lib/format";
import { useLocale } from "#/lib/locale-context";
import type { CompanellaInstallation } from "#/lib/companella-integration/shared";
import { ActionButton, Empty, Field, Panel, Pill } from "./primitives";

/*
 * Approved installations.
 *
 * "Last seen", never a live indicator: there is no socket here, and a green
 * dot would claim knowledge the server does not have. The platform label is
 * what the installation said about itself, not a hardware check.
 */
export function InstallationList({
  installations,
  busyId,
  onRename,
  onRevoke,
  onRevokeAll,
}: {
  installations: CompanellaInstallation[];
  busyId: string | null;
  onRename: (id: string, name: string) => void;
  onRevoke: (id: string) => void;
  onRevokeAll: () => void;
}) {
  const { t } = useLingui();
  const locale = useLocale();
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const active = installations.filter((installation) => installation.status === "active");

  return (
    <Panel
      title={<Trans>Approved installations</Trans>}
      right={active.length > 1 ? (
        <ActionButton tone="danger" onClick={onRevokeAll}><Trans>Revoke all</Trans></ActionButton>
      ) : null}
    >
      {installations.length === 0 ? (
        <Empty><Trans>No installation has been approved yet.</Trans></Empty>
      ) : (
        <div className="flex flex-col gap-2">
          {installations.map((installation) => (
            <div key={installation.id} className="rounded-lg border border-osu-b3/20 bg-osu-b5/40 p-3">
              <div className="flex flex-wrap items-center gap-2">
                {editing === installation.id ? (
                  <>
                    <input
                      value={draft}
                      onChange={(event) => setDraft(event.target.value)}
                      maxLength={60}
                      aria-label={t`Installation name`}
                      className="min-w-0 flex-1 rounded-lg bg-osu-b4 px-2 py-1 text-sm text-white outline-none focus:ring-1 focus:ring-osu-pink"
                    />
                    <ActionButton
                      onClick={() => {
                        onRename(installation.id, draft);
                        setEditing(null);
                      }}
                      disabled={!draft.trim()}
                    >
                      <Trans>Save</Trans>
                    </ActionButton>
                    <ActionButton onClick={() => setEditing(null)}><Trans>Cancel</Trans></ActionButton>
                  </>
                ) : (
                  <>
                    <span className="min-w-0 flex-1 truncate text-base font-semibold text-white">
                      {installation.displayName}
                    </span>
                    {installation.status === "active"
                      ? <Pill tone="good"><Trans>Active</Trans></Pill>
                      : <Pill tone="bad"><Trans>Revoked</Trans></Pill>}
                    {installation.status === "active" && (
                      <>
                        <ActionButton
                          onClick={() => {
                            setEditing(installation.id);
                            setDraft(installation.displayName);
                          }}
                        >
                          <Trans>Rename</Trans>
                        </ActionButton>
                        <ActionButton
                          tone="danger"
                          disabled={busyId === installation.id}
                          onClick={() => onRevoke(installation.id)}
                        >
                          <Trans>Revoke</Trans>
                        </ActionButton>
                      </>
                    )}
                  </>
                )}
              </div>
              <div className="mt-2 grid grid-cols-2 gap-3 sm:grid-cols-4">
                <Field label={<Trans>Client</Trans>}>{installation.clientId}</Field>
                <Field label={<Trans>Platform</Trans>}>{installation.platformHint ?? t`Not stated`}</Field>
                <Field label={<Trans>Approved</Trans>}>{formatTimeAgo(installation.approvedAt, locale)}</Field>
                <Field label={<Trans>Last seen</Trans>}>
                  {installation.lastSeenAt ? formatTimeAgo(installation.lastSeenAt, locale) : t`Never`}
                  {installation.lastSeenCountry ? ` (${installation.lastSeenCountry})` : ""}
                </Field>
              </div>
            </div>
          ))}
        </div>
      )}
      <p className="mt-3 text-xs text-osu-f1">
        <Trans>
          Revoking stops an installation from submitting straight away. Scores it already imported stay in your history
          until you delete them.
        </Trans>
      </p>
    </Panel>
  );
}
