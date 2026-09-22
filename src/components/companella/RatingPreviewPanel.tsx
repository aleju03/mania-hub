import { Trans } from "@lingui/react/macro";

import type { CompanellaPreview } from "#/lib/companella-integration/shared";
import { Empty, Panel, Pill } from "./primitives";

/*
 * The experimental preview.
 *
 * Two numbers, side by side, with the official one first: what the site rates
 * you at today, and what the same algorithms produce once the eligible local
 * imports are included. The second number changes nothing anywhere else.
 */

const EXCLUSION_TEXT: Record<string, string> = {
  analysis_pending: "Still being analyzed",
  analysis_failed: "The calculation could not run",
  analysis_unsupported: "This play has no rating (the play itself says why)",
  vibro_excluded: "Vibro is not rated",
  vibro_check_failed: "The vibro check could not read this chart",
  under_review: "Held for review",
  completion_unconfirmed: "The play does not look completed",
  relationship_ambiguous: "The chart matches more than one known chart",
  chart_not_recognized: "The chart is not one the site knows",
  chart_match_pending: "Still checking which chart this is",
  scroll_speed_changed: "The chart's scroll speed changes differ from the original",
  already_counted_officially: "Already counted from your osu! scores",
  duplicate_effective_play: "The same play on the same chart at the same speed",
};

export function RatingPreviewPanel({ preview }: { preview: CompanellaPreview | null }) {
  if (!preview) {
    return (
      <Panel title={<Trans>Experimental rating preview</Trans>}>
        <Empty><Trans>Nothing to preview yet.</Trans></Empty>
      </Panel>
    );
  }

  const excludedCounts = new Map<string, number>();
  for (const entry of preview.excluded) {
    excludedCounts.set(entry.reason, (excludedCounts.get(entry.reason) ?? 0) + 1);
  }

  return (
    <Panel
      title={<Trans>Experimental rating preview</Trans>}
      right={<Pill tone="warn"><Trans>Experimental local evidence</Trans></Pill>}
    >
      {!preview.baselineComplete && (
        <p className="mb-3 text-xs text-amber-300">
          <Trans>Your official rating has not been computed yet, so the comparison below is incomplete.</Trans>
        </p>
      )}

      {preview.modes.length === 0 ? (
        <Empty><Trans>No keymode has enough evidence yet.</Trans></Empty>
      ) : (
        <div className="flex flex-col gap-3">
          {preview.modes.map((mode) => {
            const official = Number(mode.official.Overall ?? 0);
            const previewValue = Number(mode.preview.Overall ?? 0);
            const delta = previewValue - official;
            return (
              <div key={mode.keyCount} className="rounded-lg border border-osu-b3/20 bg-osu-b5/40 p-3">
                <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1">
                  <span className="text-sm font-semibold text-osu-f1">{mode.keyCount}K</span>
                  <span className="text-2xl font-semibold text-white tabular-nums">{official.toFixed(2)}</span>
                  <span className="text-osu-f1">&rarr;</span>
                  <span className="text-2xl font-semibold text-osu-pink-light tabular-nums">{previewValue.toFixed(2)}</span>
                  {delta !== 0 && (
                    <span className="text-sm text-osu-f1 tabular-nums">
                      {delta > 0 ? "+" : ""}{delta.toFixed(2)}
                    </span>
                  )}
                  <span className="ml-auto text-xs text-osu-f1">
                    <Trans>{mode.contributingLocalPlays} imported plays counted</Trans>
                  </span>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {excludedCounts.size > 0 && (
        <div className="mt-3">
          <div className="text-[10px] font-semibold uppercase tracking-wider text-osu-f1/70">
            <Trans>Left out</Trans>
          </div>
          <ul className="mt-1 flex flex-col gap-0.5 text-xs text-osu-f1">
            {[...excludedCounts.entries()].map(([reason, count]) => (
              <li key={reason}>
                {count} · {EXCLUSION_TEXT[reason] ?? reason}
              </li>
            ))}
          </ul>
        </div>
      )}

      <p className="mt-3 text-xs text-osu-f1">
        <Trans>
          This is a private preview computed from files your own client sent. It is not an osu! result, it does not change
          any ranking, pp, snipe or reward, and nobody else can see it unless your osu! account is restricted.
        </Trans>
      </p>
    </Panel>
  );
}
