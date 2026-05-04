import { getManiaJudgementCounts, type ManiaJudgementCount, type ManiaJudgementLabel } from "#/lib/score";
import type { OsuScore, OsuScoreStatistics } from "#/lib/types";

export const MAX_JUDGEMENT_TEXT_CLASS =
  "inline-block leading-none bg-[linear-gradient(180deg,#9b2cff_20%,#1d65ff_35%,#41d9ff_54%,#4fdc3a_66%,#ffe234_78%,#ff9a1f_90%)] bg-clip-text text-transparent";

const JUDGEMENT_TEXT_CLASS_BY_LABEL: Record<ManiaJudgementLabel, string> = {
  MAX: MAX_JUDGEMENT_TEXT_CLASS,
  "300": "text-osu-yellow",
  "200": "text-osu-green-light",
  "100": "text-osu-blue",
  "50": "text-slate-400",
  Miss: "text-osu-red-light",
};

export interface ManiaJudgementStat extends ManiaJudgementCount {
  className: string;
}

function resolveScoreStatistics(source: OsuScore | OsuScoreStatistics | null | undefined): OsuScoreStatistics | null | undefined {
  return source && "statistics" in source ? source.statistics : source;
}

export function getManiaJudgementStats(source: OsuScore | OsuScoreStatistics | null | undefined): ManiaJudgementStat[] {
  return getManiaJudgementCounts(resolveScoreStatistics(source)).map((judgement) => ({
    ...judgement,
    className: JUDGEMENT_TEXT_CLASS_BY_LABEL[judgement.label],
  }));
}
