import { useLingui } from "@lingui/react/macro";
import { SegmentedControl } from "../ui/SegmentedControl";
import { OVERALL_AXIS_META, skillAxisMeta } from "../../lib/skill-axes";
import { formatNumber } from "../../lib/format";
import { LEADERBOARD_KEY_COUNTS, type LeaderboardAxisInfo, type LeaderboardKeyCount } from "../../lib/skill-leaderboards";

export function KeymodeControl({
  id,
  value,
  onChange,
}: {
  id: string;
  value: LeaderboardKeyCount;
  onChange: (keys: LeaderboardKeyCount) => void;
}) {
  const { t } = useLingui();
  return (
    <div role="group" aria-label={t`Key mode`}>
      <SegmentedControl
        id={id}
        value={String(value)}
        options={LEADERBOARD_KEY_COUNTS.map((keys) => ({ value: String(keys), label: `${keys}K` }))}
        onChange={(next) => onChange(Number(next) as LeaderboardKeyCount)}
      />
    </div>
  );
}

/* The axis row is driven entirely by the populations the backend published, so
   an axis nobody plays on this keymode is never offered and the list can never
   drift from what a profile would show. The active chip carries the axis's own
   color as a fill; the underline on this page belongs to the tab bar. */
export function AxisPicker({
  axes,
  value,
  onChange,
}: {
  axes: LeaderboardAxisInfo[];
  value: string | null;
  onChange: (axis: string) => void;
}) {
  const { t, i18n } = useLingui();
  if (axes.length === 0) return null;
  return (
    <div className="flex items-center gap-1.5 overflow-x-auto scrollbar-hide" role="group" aria-label={t`Skill`}>
      {axes.map((info) => {
        const meta = skillAxisMeta(info.axis);
        const label = meta ? i18n._(meta.labelMsg) : info.axis;
        const active = info.axis === value;
        const chip = (
          <button
            key={info.axis}
            type="button"
            aria-pressed={active}
            onClick={() => onChange(info.axis)}
            title={t`${formatNumber(info.players)} rated players`}
            className={`flex-shrink-0 rounded-md px-2.5 py-1 text-[11px] font-semibold transition-colors cursor-pointer ${
              active ? "text-white" : "bg-osu-b4/60 text-osu-f1 hover:bg-osu-b4"
            }`}
            style={active && meta ? { backgroundColor: `${meta.color}33`, color: meta.color } : undefined}
          >
            {label}
            <span className={`ml-1.5 text-[10px] font-normal ${active ? "opacity-70" : "text-osu-f1/70"}`}>
              {formatNumber(info.players)}
            </span>
          </button>
        );
        // The aggregate is not one of the specialties, so a hairline marks where
        // the list of skills actually starts.
        if (info.axis !== OVERALL_AXIS_META.key) return chip;
        return (
          <span key="overall" className="flex flex-shrink-0 items-center gap-1.5">
            {chip}
            <span aria-hidden="true" className="h-4 w-px flex-shrink-0 bg-osu-b3/50" />
          </span>
        );
      })}
    </div>
  );
}
