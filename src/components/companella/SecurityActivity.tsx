import { Trans } from "@lingui/react/macro";

import { formatTimeAgo } from "#/lib/format";
import { useLocale } from "#/lib/locale-context";
import type { CompanellaSecurityEvent } from "#/lib/companella-integration/shared";
import { Empty, Panel, Pill } from "./primitives";

/*
 * What the server noticed.
 *
 * Informational by default, and worded as observations rather than
 * accusations: a new country means a request arrived from one, nothing more.
 */

const EVENT_TEXT: Record<string, string> = {
  installation_approved: "An installation was approved",
  installation_revoked: "An installation was revoked",
  new_country_observed: "A request arrived from a country this account had not used before",
  rapid_country_change: "Requests arrived from two countries close together, so this was flagged for a look",
  duplicate_replay_rejected: "The same play was submitted twice",
  judgements_disagree_with_inputs: "A replay's saved judgements did not match its key presses, so it was held for review",
  review_decision: "A reviewer made a decision",
};

export function SecurityActivity({ events }: { events: CompanellaSecurityEvent[] }) {
  const locale = useLocale();
  return (
    <Panel title={<Trans>Account activity</Trans>}>
      {events.length === 0 ? (
        <Empty><Trans>Nothing recorded yet.</Trans></Empty>
      ) : (
        <ul className="flex flex-col gap-2">
          {events.map((event) => (
            <li key={event.id} className="flex flex-wrap items-center gap-2 text-sm text-white">
              {event.severity === "review" ? <Pill tone="warn"><Trans>For review</Trans></Pill> : <Pill><Trans>Info</Trans></Pill>}
              <span className="min-w-0 flex-1">{EVENT_TEXT[event.kind] ?? event.kind}</span>
              {event.country && <span className="text-xs text-osu-f1">{event.country}</span>}
              <span className="text-xs text-osu-f1">{formatTimeAgo(event.createdAt, locale)}</span>
            </li>
          ))}
        </ul>
      )}
      <p className="mt-3 text-xs text-osu-f1">
        <Trans>
          A country change is not a problem on its own. VPNs, mobile networks and dual boot all move it, and nothing here
          bans an account or deletes a score.
        </Trans>
      </p>
    </Panel>
  );
}
