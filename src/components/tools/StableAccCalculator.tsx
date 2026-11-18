import { useState } from "react";
import { useLingui } from "@lingui/react/macro";

import { PageHeader } from "../layout/PageHeader";
import { GradeImg } from "../ui/GradeImg";
import { formatAccuracy } from "../../lib/format";
import { getManiaAccuracyFromCounts, getManiaGradeFromAccuracy } from "../../lib/score";
import type { OsuScoreStatistics } from "../../lib/types";

// Same colors as the play results in the map modal.
const JUDGEMENTS = [
  { key: "perfect", label: "MAX", color: "#99eeff" },
  { key: "great", label: "300", color: "#ffc933" },
  { key: "good", label: "200", color: "#7ad530" },
  { key: "ok", label: "100", color: "#3d84ff" },
  { key: "meh", label: "50", color: "#8a9bb4" },
  { key: "miss", label: "Miss", color: "#ee4b5a" },
] as const;

type JudgementKey = (typeof JUDGEMENTS)[number]["key"];
type Counts = Record<JudgementKey, string>;

const EMPTY_COUNTS: Counts = { perfect: "", great: "", good: "", ok: "", meh: "", miss: "" };

function toStatistics(counts: Counts): OsuScoreStatistics {
  const stats: Record<string, number> = {};
  for (const { key } of JUDGEMENTS) {
    const value = Number.parseInt(counts[key], 10);
    stats[key] = Number.isFinite(value) && value > 0 ? value : 0;
  }
  return stats as OsuScoreStatistics;
}

export function StableAccCalculator() {
  const { t } = useLingui();
  const [counts, setCounts] = useState<Counts>(EMPTY_COUNTS);

  const stats = toStatistics(counts);
  const hasCounts = JUDGEMENTS.some(({ key }) => (stats[key] ?? 0) > 0);
  const stableAccuracy = hasCounts ? getManiaAccuracyFromCounts(stats, false) : null;
  const lazerAccuracy = hasCounts ? getManiaAccuracyFromCounts(stats, true) : null;
  const grade = stableAccuracy != null ? getManiaGradeFromAccuracy(stableAccuracy) : null;

  return (
    <div className="flex min-h-screen flex-col">
      <PageHeader iconSrc="/images/icons/rankings.svg" title={t`stable acc calculator`} />
      <div className="min-h-[80vh] flex-1 bg-osu-b5">
        <div className="mx-auto max-w-[720px] space-y-6 px-3 py-6 sm:px-5 sm:py-8">
          <div className="grid grid-cols-3 gap-3 sm:grid-cols-6">
            {JUDGEMENTS.map(({ key, label, color }) => (
              <label key={key} className="flex min-w-0 flex-col gap-1.5">
                <span className="text-[12px] font-semibold" style={{ color }}>{label}</span>
                <input
                  type="text"
                  inputMode="numeric"
                  autoComplete="off"
                  placeholder="0"
                  value={counts[key]}
                  onChange={(event) => {
                    const digits = event.target.value.replace(/\D/g, "").slice(0, 7);
                    setCounts((current) => ({ ...current, [key]: digits }));
                  }}
                  className="w-full min-w-0 rounded-lg bg-osu-b4 px-2.5 py-2 text-[18px] font-bold tabular-nums text-white outline-none placeholder:text-osu-f1/40 focus:bg-osu-b3"
                />
              </label>
            ))}
          </div>

          <div className="flex items-center gap-4 border-t border-white/[0.07] pt-6">
            {grade ? <GradeImg grade={grade} size={84} className="size-16 shrink-0 sm:size-[84px]" /> : null}
            <div className="flex min-w-0 flex-col">
              <span className="text-[40px] font-black leading-none tabular-nums text-white sm:text-[52px]">
                {stableAccuracy != null ? formatAccuracy(stableAccuracy) : "—"}
              </span>
              <span className="mt-2 text-[12px] text-osu-f1">{t`Stable`}</span>
            </div>
            <div className="ml-auto flex flex-col items-end">
              <span className="text-[24px] font-bold leading-none tabular-nums text-osu-l1">
                {lazerAccuracy != null ? formatAccuracy(lazerAccuracy) : "—"}
              </span>
              <span className="mt-1.5 text-[11px] text-osu-f1">{t`Lazer`}</span>
            </div>
          </div>

          {hasCounts ? (
            <button
              type="button"
              onClick={() => setCounts(EMPTY_COUNTS)}
              className="cursor-pointer rounded-lg bg-osu-b4 px-2.5 py-1 text-[11px] font-semibold text-osu-f1 transition-colors hover:bg-osu-b3 hover:text-white"
            >
              {t`Clear`}
            </button>
          ) : null}
        </div>
      </div>
    </div>
  );
}
