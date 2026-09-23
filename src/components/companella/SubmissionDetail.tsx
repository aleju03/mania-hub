import { useEffect, useState } from "react";
import { Trans, useLingui } from "@lingui/react/macro";

import { formatAccuracy } from "#/lib/format";
import { describeMatchOutcome, type CompanellaSubmissionRow } from "#/lib/companella-integration/shared";
import {
  deleteCompanellaScore,
  fetchCompanellaScore,
  type CompanellaScoreDetail,
} from "#/lib/companella-integration/manage-server";
import { ActionButton, Field, Pill, type PillTone } from "./primitives";

/*
 * What the import adds to the play popup: the checks it went through, its
 * rating, the chart it was matched to, and the owner's replay and delete.
 */

const COMPLETION_TONES: Record<string, PillTone> = {
  consistent_with_completed_play: "good",
  incomplete: "warn",
  unknown: "warn",
};

/** Why a stored play has no rating, in plain words. Unknown codes show as they are. */
const UNRATED_TEXT: Record<string, string> = {
  keymode_unsupported: "This keymode is not rated",
  rate_vibro: "Vibro is not rated",
  chart_vibro: "Vibro is not rated",
  vibro_check_failed: "The vibro check could not read this chart",
  analysis_failed: "The calculation kept failing, so this play is not rated",
  accuracy_below_calc_floor: "The accuracy is too low to rate",
  replay_timing_unavailable: "The key presses could not be judged",
  calculator_returned_nothing: "The calculator gave no rating for this chart",
  column_rewriting_mod: "Random is not rated",
  key_conversion_mod: "Key conversion mods are not rated",
  unsupported_mod: "This mod is not rated",
  unknown_mod_bits: "The replay has mods the site does not know",
};

export function unratedReasonText(reason: string | null | undefined): string | null {
  if (!reason) return null;
  return UNRATED_TEXT[reason] ?? reason;
}

export function SubmissionDetail({ row, onDeleted }: { row: CompanellaSubmissionRow; onDeleted: () => void }) {
  const { t } = useLingui();
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
  const match = detail?.match ?? null;
  const timing = detail?.timing ?? null;
  const chartDan = (analysis?.chartDan as { primaryLabel?: string } | null)?.primaryLabel ?? null;

  return (
    <div className="mt-5 flex flex-col gap-4 border-t border-osu-b3/20 pt-4">
      <div className="flex flex-wrap items-center gap-1.5">
        <Pill tone={row.state === "accepted" ? "good" : "warn"}>{row.state}</Pill>
        {score && (
          <Pill tone={COMPLETION_TONES[score.completionState] ?? "warn"}>{score.completionState.replaceAll("_", " ")}</Pill>
        )}
        {score && score.reviewState !== "clear" && <Pill tone="warn">{score.reviewState}</Pill>}
        {row.client_kind === "test" && <Pill><Trans>Test</Trans></Pill>}
      </div>
      {timing?.headerDisagrees && (
        <p className="-mt-2 text-[11px] text-amber-300">
          <Trans>The judgements saved in this replay don't match its key presses, so it's held for review.</Trans>
        </p>
      )}

      {loading && !detail ? (
        <div className="h-16 animate-pulse rounded-lg bg-osu-b5/60" />
      ) : !analysis ? (
        <p className="text-[12px] text-osu-f1"><Trans>Not analyzed yet.</Trans></p>
      ) : analysis.state === "supported" ? (
        <div>
          <div className="grid grid-cols-4 gap-3">
            <Field label="MSD">{Number(analysis.msd?.Overall ?? 0).toFixed(2)}</Field>
            <Field label="SSR">{Number(analysis.ssr?.Overall ?? 0).toFixed(2)}</Field>
            <Field label="Wife3">{analysis.goal != null ? formatAccuracy(analysis.goal) : "-"}</Field>
            <Field label={<Trans>Dan</Trans>}>{chartDan ?? "-"}</Field>
          </div>
          {timing && Math.abs(timing.ratingOd - timing.fileOd) > 0.001 && (
            <p className="mt-1.5 text-[11px] text-osu-f1">
              <Trans>Judged at OD {timing.ratingOd}, the original map's, instead of this file's OD {timing.fileOd}.</Trans>
            </p>
          )}
        </div>
      ) : (
        <p className="text-[12px] text-amber-300">
          {analysis.state === "failed_retryable"
            ? t`The calculation could not run; it will be retried.`
            : (unratedReasonText(analysis.unratedReason) ?? t`Not rated.`)}
        </p>
      )}

      {match && (
        <div className="text-[12px]">
          <span className="text-osu-f1"><Trans>Chart</Trans></span>{" "}
          <span className="text-white">{describeMatchOutcome(match)}</span>
          {match.outcome === "matched" && match.relativeRate != null && Math.abs(match.relativeRate - 1) > 0.001 && (
            <span className="text-osu-f1"> · {match.relativeRate.toFixed(2)}x</span>
          )}
          {match.gameplaySettingDifferences.length > 0 && (
            <p className="mt-1 text-[11px] text-amber-300">
              <Trans>Settings that differ from that file:</Trans> {match.gameplaySettingDifferences.join(", ")}
            </p>
          )}
        </div>
      )}

      {scoreId && (
        <div className="flex items-center justify-between gap-2">
          <a
            href={`/api/companella/replay?scoreId=${encodeURIComponent(scoreId)}`}
            className="text-[11px] text-osu-f1 transition-colors hover:text-osu-pink-light"
          >
            <Trans>Download replay</Trans>
          </a>
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
        </div>
      )}
    </div>
  );
}
