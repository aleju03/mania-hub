import { Check } from "lucide-react";

/* The site's on/off control: the checkbox osu!'s own options menu uses.
 *
 * Lives here rather than beside one panel because a boolean is a boolean
 * everywhere: a pair of "Shown"/"Hidden" chips is a picker doing a switch's
 * job, and a lone chip you have to read as pressed-or-not is worse. `label`
 * is what a screen reader announces, since the visible name is usually the
 * row this sits on rather than anything inside it.
 *
 * A square rather than a sliding pill: the pill belongs to phone settings and
 * to lazer, the square to stable's options, which is where everyone here
 * learned what a setting looks like. No pop, no travel, no colour but the
 * accent it already uses - in a list of rows, the control should be the
 * quietest thing in the row.
 */
export function Switch({
  checked,
  onChange,
  label,
}: {
  checked: boolean;
  onChange: (checked: boolean) => void;
  label?: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      onClick={() => onChange(!checked)}
      className={`grid h-4 w-4 shrink-0 cursor-pointer place-items-center rounded-[4px] border transition-colors duration-150 ${
        checked
          ? "border-osu-pink bg-osu-pink hover:border-osu-pink-light hover:bg-osu-pink-light"
          : "border-osu-b3/70 bg-transparent hover:border-osu-pink/60"
      }`}
    >
      <Check
        className={`h-3 w-3 text-white transition-opacity duration-150 ${checked ? "opacity-100" : "opacity-0"}`}
        strokeWidth={3.5}
      />
    </button>
  );
}
