import { useEffect, useState } from "react";
import { Trans, useLingui } from "@lingui/react/macro";

import { formatAccuracy, formatTimeAgo } from "#/lib/format";
import { useLocale } from "#/lib/locale-context";
import {
  describeMatchOutcome,
  effectiveSpeed,
  type CompanellaSubmissionRow,
} from "#/lib/companella-integration/shared";
import {
  deleteCompanellaScore,
  fetchCompanellaScore,
  type CompanellaScoreDetail,
} from "#/lib/companella-integration/manage-server";
import { ActionButton, Field, Pill, type PillTone } from "./primitives";

/*
 * One submission, in full.
 *
 * Says what was checked, what it found, and what is still unknown. The chart
 * identity is the exact file's digest; a beatmap id copied inside that file is
 * labelled as the uploader's own metadata, because that is all it is.
 */

const IDENTITY_TONES: Record<string, PillTone> = {
  name_matches_account: "good",
  name_mismatch: "bad",
  identity_unresolved: "warn",
};

const COMPLETION_TONES: Record<string, PillTone> = {
  consistent_with_completed_play: "good",
  incomplete: "warn",
  unknown: "warn",
};

export function SubmissionDetail({
  row,
  onClose,
  onDeleted,
}: {
  row: CompanellaSubmissionRow;
  onClose: () => void;
  onDeleted: () => void;
}) {
  const { t } = useLingui();
  const locale = useLocale();
  const [detail, setDetail] = useState<CompanellaScoreDetail | null>(null);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const scoreId = row.local_score_id;

  useEffect(() => {
    if (!scoreId) return;
    let cancelled = false;
    setLoading(true);
    void fetchCompanellaScore({ data: { scoreId } })
      .then((result) => {
        if (!cancelled) setDetail(result);
      })
      .catch(() => {
        if (!cancelled) setDetail(null);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [scoreId]);

  const score = detail?.score ?? row.score;
  const analysis = detail?.analysis ?? row.analysis;
  const chart = detail?.chart ?? null;
  const match = detail?.match ?? null;
  const timing = detail?.timing ?? null;

  return (
    <div className="rounded-xl border border-osu-b3/30 bg-osu-b4/40 p-4">
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <h3 className="text-xs font-semibold uppercase tracking-wider text-osu-f1">
          <Trans>Submission detail</Trans>
        </h3>
        <div className="ml-auto flex items-center gap-2">
          {scoreId && (
            <ActionButton
              tone="danger"
              disabled={busy}
              onClick={() => {
                if (!window.confirm(t`Delete this imported play? Its replay is removed and the preview is recalculated.`)) return;
                setBusy(true);
                void deleteCompanellaScore({ data: { scoreId } })
                  .then((result) => {
                    if (result.ok) onDeleted();
                  })
                  .finally(() => setBusy(false));
              }}
            >
              <Trans>Delete</Trans>
            </ActionButton>
          )}
          <ActionButton onClick={onClose}><Trans>Close</Trans></ActionButton>
        </div>
      </div>

      {loading && !detail ? (
        <div className="h-24 animate-pulse rounded-lg bg-osu-b5/60" />
      ) : (
        <div className="flex flex-col gap-4">
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <Field label={<Trans>Processing</Trans>}>{row.state}</Field>
            <Field label={<Trans>Name on the replay</Trans>}>
              {score?.playerName ?? "-"}{" "}
              {score && <Pill tone={IDENTITY_TONES[score.identityState] ?? "warn"}>{score.identityState}</Pill>}
            </Field>
            <Field label={<Trans>Completion</Trans>}>
              {score && <Pill tone={COMPLETION_TONES[score.completionState] ?? "warn"}>{score.completionState}</Pill>}
            </Field>
            <Field label={<Trans>Review</Trans>}>{score?.reviewState ?? "-"}</Field>
          </div>
          {timing?.headerDisagrees && (
            <p className="-mt-2 text-xs text-amber-300">
              <Trans>The judgements saved in this replay don't match its key presses, so it's held for review.</Trans>
            </p>
          )}

          {score && (
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
              <Field label={<Trans>Score</Trans>}>{score.totalScore.toLocaleString("en-US")}</Field>
              <Field label={<Trans>Accuracy</Trans>}>
                {score.stableAccuracy != null ? formatAccuracy(score.stableAccuracy) : "-"}
              </Field>
              <Field label={<Trans>Mods</Trans>}>{score.mods.length ? score.mods.join(", ") : "NM"}</Field>
              <Field label={<Trans>Speed played at</Trans>}>{effectiveSpeed(null, score.runtimeRate)}x</Field>
            </div>
          )}

          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <Field label={<Trans>Chart file</Trans>}>{row.chart_md5.slice(0, 12)}</Field>
            <Field label={<Trans>Key count</Trans>}>{chart?.keyCount ?? "-"}</Field>
            <Field label={<Trans>Notes</Trans>}>{chart?.noteCount ?? "-"}</Field>
            <Field label={<Trans>OD</Trans>}>{chart?.od ?? "-"}</Field>
          </div>

          <div>
            <div className="text-[10px] font-semibold uppercase tracking-wider text-osu-f1/70">
              <Trans>Chart relationship</Trans>
            </div>
            <div className="text-sm text-white">{describeMatchOutcome(match)}</div>
            <p className="mt-1 text-xs text-osu-f1">
              {match?.outcome === "matched" && match.relativeRate != null && (
                <Trans>About {match.relativeRate.toFixed(2)}x the file this was matched against.</Trans>
              )}
              {match?.outcome === "unmatched_in_index" && (
                <Trans>The site has no matching chart indexed. That does not mean this chart is new, only that nothing here matched it.</Trans>
              )}
              {match?.outcome === "deferred" && (
                <Trans>The comparison budget ran out; this is still being checked.</Trans>
              )}
              {match?.outcome === "ambiguous" && (
                <Trans>This file looks like more than one known chart, so it is left out of the preview until that is resolved.</Trans>
              )}
            </p>
            {match && match.gameplaySettingDifferences.length > 0 && (
              <p className="mt-1 text-xs text-amber-300">
                <Trans>Settings that differ from that file:</Trans> {match.gameplaySettingDifferences.join(", ")}
              </p>
            )}
            {chart?.declaredBeatmapId != null && (
              <p className="mt-1 text-xs text-osu-f1">
                <Trans>The file names beatmap {chart.declaredBeatmapId}. That is metadata inside the upload, not a verified identity.</Trans>
              </p>
            )}
          </div>

          <div>
            <div className="text-[10px] font-semibold uppercase tracking-wider text-osu-f1/70">
              <Trans>Analysis</Trans>
            </div>
            {!analysis ? (
              <div className="text-sm text-osu-f1"><Trans>Not analyzed yet.</Trans></div>
            ) : analysis.state === "supported" ? (
              <>
                <div className="mt-1 grid grid-cols-2 gap-3 sm:grid-cols-4">
                  <Field label="MSD">{Number(analysis.msd?.Overall ?? 0).toFixed(2)}</Field>
                  <Field label="SSR">{Number(analysis.ssr?.Overall ?? 0).toFixed(2)}</Field>
                  <Field label="Wife3">{analysis.goal != null ? formatAccuracy(analysis.goal) : "-"}</Field>
                  <Field label={<Trans>Chart dan</Trans>}>
                    {String((analysis.chartDan as { primaryLabel?: string } | null)?.primaryLabel ?? "-")}
                  </Field>
                </div>
                <p className="mt-1 text-xs text-osu-f1">
                  <Trans>Wife3 is measured from the replay's key presses at {analysis.runtimeRate}x.</Trans>
                  {timing && Math.abs(timing.ratingOd - timing.fileOd) > 0.001 && (
                    <> <Trans>Judged at OD {timing.ratingOd}, the original map's, instead of this file's OD {timing.fileOd}.</Trans></>
                  )}
                </p>
              </>
            ) : (
              <div className="text-sm text-amber-300">
                {analysis.state === "failed_retryable"
                  ? t`The calculation could not run; it will be retried.`
                  : (analysis.unratedReason ?? t`Not rated.`)}
              </div>
            )}
          </div>

          {scoreId && (
            <div className="flex flex-wrap items-center gap-2">
              <a
                href={`/api/companella/replay?scoreId=${encodeURIComponent(scoreId)}`}
                className="rounded-lg bg-osu-b4 px-2.5 py-1 text-[11px] font-semibold text-osu-f1 transition-colors hover:bg-osu-b3 hover:text-white"
              >
                <Trans>Download replay</Trans>
              </a>
              <span className="text-xs text-osu-f1">
                <Trans>Only you can open this. It is not listed anywhere and has no share link.</Trans>
              </span>
            </div>
          )}

          {score && (
            <p className="text-xs text-osu-f1">
              <Trans>Received</Trans> {formatTimeAgo(score.receivedAt, locale)}
              {" · "}
              <Trans>Imported from your own client, so it is not an osu! verified score.</Trans>
            </p>
          )}
        </div>
      )}
    </div>
  );
}
