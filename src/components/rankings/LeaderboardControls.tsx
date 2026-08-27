import { useLingui } from "@lingui/react/macro";
import { SegmentedControl } from "../ui/SegmentedControl";
import { DAN_SKILLSET_META, OVERALL_AXIS_META, skillAxisMeta } from "../../lib/skill-axes";
import { formatNumber } from "../../lib/format";
import { DEFAULT_DAN_SKILLSET, LEADERBOARD_KEY_COUNTS, type LeaderboardAxisInfo, type LeaderboardKeyCount } from "../../lib/skill-leaderboards";

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

/* The dan board's skillset row. Same chips as the axis picker and driven the
   same way - by the populations the backend published, so a keymode is never
   offered a bucket its ladder does not have (stamina is 4K's, stream the other
   keymodes'). The label and color come from DAN_SKILLSET_META, which is the
   same pair the dan-evidence window draws, so one bucket reads alike wherever
   it appears. */
export function DanSkillsetPicker({
  skillsets,
  value,
  onChange,
}: {
  skillsets: Array<{ skillset: string; players: number }>;
  value: string;
  onChange: (skillset: string) => void;
}) {
  const { t, i18n } = useLingui();
  if (skillsets.length < 2) return null;
  return (
    <div className="flex items-center gap-1.5 overflow-x-auto scrollbar-hide" role="group" aria-label={t`Dan skill`}>
      {skillsets.map((info) => {
        const overall = info.skillset === DEFAULT_DAN_SKILLSET;
        const meta = overall ? OVERALL_AXIS_META : DAN_SKILLSET_META[info.skillset];
        const label = meta ? i18n._(meta.labelMsg) : info.skillset;
        const color = overall ? OVERALL_AXIS_META.color : DAN_SKILLSET_META[info.skillset]?.color;
        const active = info.skillset === value;
        const chip = (
          <button
            key={info.skillset}
            type="button"
            aria-pressed={active}
            onClick={() => onChange(info.skillset)}
            title={t`${formatNumber(info.players)} rated players`}
            className={`flex-shrink-0 rounded-md px-2.5 py-1 text-[11px] font-semibold transition-colors cursor-pointer ${
              active ? "text-white" : "bg-osu-b4/60 text-osu-f1 hover:bg-osu-b4"
            }`}
            style={active && color ? { backgroundColor: `${color}33`, color } : undefined}
          >
            {label}
            <span className={`ml-1.5 text-[10px] font-normal ${active ? "opacity-70" : "text-osu-f1/70"}`}>
              {formatNumber(info.players)}
            </span>
          </button>
        );
        // Every-clear is not one of the skills, so a hairline marks where the
        // list of skills starts (same rule as the axis picker's Overall).
        if (!overall) return chip;
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
