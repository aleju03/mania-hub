import { useMemo } from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { Trans, useLingui } from "@lingui/react/macro";

import { formatTimeAgo } from "#/lib/format";
import { useLocale } from "#/lib/locale-context";
import { companellaRowToOsuScore } from "#/lib/companella-scores";
import type { CompanellaSubmissionRow } from "#/lib/companella-integration/shared";
import { ScoreRow, getScoreRowLayout } from "../player/ScoreRows";
import { Empty, Panel, Pill, type PillTone } from "./primitives";

/*
 * Imported plays, drawn the way the profile's Recent tab draws them, one page
 * at a time. A submission with no stored play yet (still uploading, refused)
 * gets a plain line in the same list.
 */

const STATE_TONES: Record<string, PillTone> = {
  accepted: "good",
  rejected: "bad",
  expired: "bad",
  deleted: "bad",
  deferred: "warn",
};

function stateLabel(state: string): string {
  switch (state) {
    case "awaiting_assets": return "Waiting for files";
    case "queued": return "Queued";
    case "validating": return "Checking files";
    case "analyzing": return "Analyzing";
    case "accepted": return "Accepted";
    case "deferred": return "Retrying";
    case "rejected": return "Refused";
    case "expired": return "Expired";
    case "deleted": return "Deleted";
    default: return state;
  }
}

export function SubmissionList({
  rows,
  loading,
  page,
  hasNext,
  onPage,
  onOpen,
}: {
  rows: CompanellaSubmissionRow[];
  loading: boolean;
  page: number;
  hasNext: boolean;
  onPage: (direction: -1 | 1) => void;
  onOpen: (row: CompanellaSubmissionRow) => void;
}) {
  const locale = useLocale();
  const { t } = useLingui();
  const scores = useMemo(
    () => rows.map((row) => (row.play ? companellaRowToOsuScore(row.play) : null)),
    [rows],
  );
  const layout = useMemo(
    () => getScoreRowLayout(scores.flatMap((score) => (score ? [{ kind: "score" as const, score }] : []))),
    [scores],
  );

  return (
    <Panel
      title={<Trans>Imported plays</Trans>}
      right={page > 0 || hasNext ? (
        <div className="flex items-center gap-1 text-[11px] text-osu-f1">
          <button
            type="button"
            onClick={() => onPage(-1)}
            disabled={page === 0 || loading}
            aria-label={t`Newer`}
            className="flex h-6 w-6 cursor-pointer items-center justify-center rounded-md transition-colors hover:bg-osu-b3 hover:text-white disabled:cursor-default disabled:opacity-30 disabled:hover:bg-transparent"
          >
            <ChevronLeft size={14} />
          </button>
          <span className="min-w-[3.5rem] text-center tabular-nums"><Trans>Page {page + 1}</Trans></span>
          <button
            type="button"
            onClick={() => onPage(1)}
            disabled={!hasNext || loading}
            aria-label={t`Older`}
            className="flex h-6 w-6 cursor-pointer items-center justify-center rounded-md transition-colors hover:bg-osu-b3 hover:text-white disabled:cursor-default disabled:opacity-30 disabled:hover:bg-transparent"
          >
            <ChevronRight size={14} />
          </button>
        </div>
      ) : null}
    >
      {rows.length === 0 && !loading ? (
        <Empty><Trans>Nothing has been submitted yet.</Trans></Empty>
      ) : (
        <div className={`flex flex-col gap-1.5 transition-opacity ${loading ? "opacity-60" : ""}`}>
          {rows.map((row, index) => {
            const score = scores[index];
            if (score) {
              return (
                <ScoreRow
                  key={row.submission_id}
                  score={score}
                  position={page * rows.length + index + 1}
                  layout={layout}
                  onOpenDetails={() => onOpen(row)}
                />
              );
            }
            return (
              <div key={row.submission_id} className="flex min-h-[52px] items-center gap-3 rounded-lg bg-osu-b5/40 px-3 py-2">
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm text-white">{stateLabel(row.state)}</div>
                  <div className="truncate text-[11px] text-osu-f1">
                    {row.error ? (row.error.message ?? row.error.code) : <><Trans>Received</Trans> {formatTimeAgo(row.created_at, locale)}</>}
                  </div>
                </div>
                <Pill tone={STATE_TONES[row.state] ?? "neutral"}>{stateLabel(row.state)}</Pill>
              </div>
            );
          })}
        </div>
      )}
    </Panel>
  );
}
