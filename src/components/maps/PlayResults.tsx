import { useLingui } from "@lingui/react/macro";
import { formatAccuracy, formatNumber, formatPP, formatTimeAgo, formatTimeAgoTooltip } from "../../lib/format";
import { getManiaGradeFromAccuracy, getManiaJudgementCounts } from "../../lib/score";
import { useLocale } from "../../lib/locale-context";
import type { AppLocale } from "../../lib/locale";
import { GradeImg } from "../ui/GradeImg";
import { PlayModRow, accuracyCurrencyLabel, type MapDetailPlayContext } from "./MapDetailModal";

// Follows the default osu!mania skin: 300 gold, 200 green, 100 blue, 50 grey and
// a miss red. The skin draws MAX as a rainbow, so it takes lazer's Perfect color.
const JUDGEMENT_FILL: Record<string, string> = {
  MAX: "#99eeff",
  "300": "#ffc933",
  "200": "#7ad530",
  "100": "#3d84ff",
  "50": "#8a9bb4",
  Miss: "#ee4b5a",
};

function JudgementCount({ label, value, available, locale }: { label: string; value: number; available: boolean; locale: AppLocale }) {
  const shown = available && value > 0;
  return (
    <div className="flex min-w-0 flex-col">
      <span className={`text-[24px] font-bold leading-none tabular-nums ${shown ? "" : "text-osu-f1/50"}`} style={shown ? { color: JUDGEMENT_FILL[label] } : undefined}>
        {available ? formatNumber(value, locale) : "—"}
      </span>
      <span className="mt-1.5 text-[11px] text-osu-f1">{label}</span>
    </div>
  );
}

function ResultStat({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex min-w-0 flex-col">
      <span className="text-[20px] font-bold leading-none tabular-nums text-osu-l1">{value}</span>
      <span className="mt-1.5 text-[11px] text-osu-f1">{label}</span>
    </div>
  );
}

function Hairline() {
  return <span className="h-3 w-px bg-white/15" aria-hidden="true" />;
}

// The score as a results screen: grade and accuracy first, and one bar for the
// spread of judgements.
export function PlayResults({ play }: { play: MapDetailPlayContext }) {
  const { t } = useLingui();
  const locale = useLocale();
  const score = play.score;
  const grade = score?.rank || (play.accuracy != null ? getManiaGradeFromAccuracy(play.accuracy, play.mods ?? []) : null);
  const accuracy = play.accuracy == null ? null : formatAccuracy(play.accuracy);
  const danAccuracy = play.dan?.accuracy == null ? null : formatAccuracy(play.dan.accuracy);
  const judgements = getManiaJudgementCounts(score?.statistics ?? {});
  const total = judgements.reduce((sum, { value }) => sum + value, 0);
  const available = total > 0;
  const countMax = judgements[0]?.value ?? 0;
  const count300 = judgements[1]?.value ?? 0;
  // MAX:300, the ratio mania players compare plays by. A play with no 300s has
  // no ratio to show.
  const ratio = count300 > 0 ? `${(countMax / count300).toFixed(2)} : 1` : null;

  return (
    <div className="min-w-0">
      <div className="flex flex-col gap-6 px-3 pb-2 pt-4 sm:px-6">
        <div className="flex items-start justify-between gap-4">
          <div className="flex min-w-0 items-center gap-4">
            {grade ? <GradeImg grade={grade} size={84} className="shrink-0" /> : null}
            <div className="flex min-w-0 flex-col">
              <span className="text-[52px] font-black leading-none tabular-nums text-white">{accuracy ?? "—"}</span>
              <span
                className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1 text-[12px] text-osu-l2"
                title={play.playedAt ? formatTimeAgoTooltip(play.playedAt, locale) : undefined}
              >
                <span className="font-semibold text-white">{play.username}</span>
                <Hairline />
                <span>{play.playedAt ? formatTimeAgo(play.playedAt, locale) : "—"}</span>
                <Hairline />
                <span>{play.sourceLabel ?? (play.source === "top" ? t`profile top play` : t`tracked history`)}</span>
              </span>
            </div>
          </div>
          <div className="flex shrink-0 flex-col items-end gap-3">
            <PlayModRow play={play} />
            {ratio ? (
              <div className="flex flex-col items-end">
                <span className="text-[24px] font-bold leading-none tabular-nums text-osu-l1">{ratio}</span>
                <span className="mt-1.5 text-[11px] text-osu-f1">MAX:300</span>
              </div>
            ) : null}
          </div>
        </div>
        <div className="grid grid-cols-6 gap-2" aria-label={available ? t`Judgments` : t`Judgments unavailable`}>
          {judgements.map(({ label, value }) => (
            <JudgementCount key={label} label={label} value={value} available={available} locale={locale} />
          ))}
        </div>
        <div className="grid grid-cols-2 gap-x-3 gap-y-5 border-t border-white/[0.07] pt-5 sm:grid-flow-col sm:auto-cols-fr sm:grid-cols-none">
          <ResultStat label={t`Max combo`} value={score?.maxCombo != null ? `${formatNumber(score.maxCombo, locale)}x` : "—"} />
          <ResultStat label={t`Score`} value={score?.totalScore != null ? formatNumber(score.totalScore, locale) : "—"} />
          {play.pp != null ? <ResultStat label={t`PP`} value={formatPP(play.pp)} /> : null}
          {danAccuracy != null && danAccuracy !== accuracy ? (
            <ResultStat
              label={play.dan?.currency ? `${t`Dan accuracy`} (${accuracyCurrencyLabel(play.dan.currency)})` : t`Dan accuracy`}
              value={danAccuracy}
            />
          ) : null}
        </div>
      </div>
    </div>
  );
}
