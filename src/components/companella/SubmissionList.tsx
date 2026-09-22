import { Trans, useLingui } from "@lingui/react/macro";

import { formatAccuracy, formatTimeAgo } from "#/lib/format";
import { useLocale } from "#/lib/locale-context";
import { effectiveSpeed, type CompanellaSubmissionRow } from "#/lib/companella-integration/shared";
import { ActionButton, Empty, Panel, Pill, type PillTone } from "./primitives";
import { unratedReasonText } from "./SubmissionDetail";

/*
 * Submission history.
 *
 * Processing state and trust state are shown as separate things on purpose: a
 * score can be stored perfectly and still be ineligible for the preview, and
 * conflating the two would read as "your upload failed".
 */

const STATE_TONES: Record<string, PillTone> = {
  accepted: "good",
  rejected: "bad",
  expired: "bad",
  deleted: "bad",
  deferred: "warn",
};

function stateLabel(row: CompanellaSubmissionRow): string {
  switch (row.state) {
    case "awaiting_assets": return "Waiting for files";
    case "queued": return "Queued";
    case "validating": return "Checking files";
    case "analyzing": return "Analyzing";
    case "accepted": return "Accepted";
    case "deferred": return "Retrying";
    case "rejected": return "Refused";
    case "expired": return "Expired";
    case "deleted": return "Deleted";
    default: return row.state;
  }
}

export function SubmissionList({
  rows,
  hasMore,
  loading,
  onLoadMore,
  onOpen,
}: {
  rows: CompanellaSubmissionRow[];
  hasMore: boolean;
  loading: boolean;
  onLoadMore: () => void;
  onOpen: (row: CompanellaSubmissionRow) => void;
}) {
  const { t } = useLingui();
  const locale = useLocale();

  return (
    <Panel title={<Trans>Imported plays</Trans>}>
      {rows.length === 0 && !loading ? (
        <Empty><Trans>Nothing has been submitted yet.</Trans></Empty>
      ) : (
        <div className="flex flex-col gap-2">
          {rows.map((row) => {
            const score = row.score;
            const analysis = row.analysis;
            const speed = effectiveSpeed(null, score?.runtimeRate ?? 1);
            return (
              <button
                key={row.submission_id}
                type="button"
                onClick={() => onOpen(row)}
                className="cursor-pointer rounded-lg border border-osu-b3/20 bg-osu-b5/40 p-3 text-left transition-colors hover:border-osu-b3/50"
              >
                <div className="flex flex-wrap items-center gap-2">
                  <span className="min-w-0 flex-1 truncate text-sm font-semibold text-white">
                    {score
                      ? `${score.playerName} · ${score.totalScore.toLocaleString("en-US")}`
                      : t`Waiting for files`}
                  </span>
                  <Pill tone={STATE_TONES[row.state] ?? "neutral"}>{stateLabel(row)}</Pill>
                  {row.client_kind === "test" && <Pill><Trans>Test</Trans></Pill>}
                </div>
                <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-osu-f1">
                  {score && (
                    <>
                      <span>{score.mods.length ? score.mods.join(", ") : "NM"}</span>
                      <span>{speed}x</span>
                      {score.stableAccuracy != null && <span>{formatAccuracy(score.stableAccuracy)}</span>}
                      <span>{score.countMiss} miss</span>
                    </>
                  )}
                  <span>
                    <Trans>Received</Trans> {formatTimeAgo(row.created_at, locale)}
                  </span>
                  {score?.playedAt && (
                    <span>
                      <Trans>Played</Trans> {formatTimeAgo(score.playedAt, locale)}
                    </span>
                  )}
                </div>
                {row.error && (
                  <p className="mt-1 text-xs text-rose-300">{row.error.message ?? row.error.code}</p>
                )}
                {!row.error && analysis && analysis.state !== "supported" && (
                  <p className="mt-1 text-xs text-amber-300">
                    <Trans>Stored, but not rated:</Trans>{" "}
                    {unratedReasonText(analysis.unratedReason) ?? analysis.state}
                  </p>
                )}
              </button>
            );
          })}
        </div>
      )}
      {hasMore && (
        <div className="mt-3 flex justify-center">
          <ActionButton onClick={onLoadMore} disabled={loading}>
            {loading ? <Trans>Loading...</Trans> : <Trans>Show more</Trans>}
          </ActionButton>
        </div>
      )}
    </Panel>
  );
}
