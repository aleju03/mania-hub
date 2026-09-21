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
 * accent it already uses.
 *
 * The empty box draws its border in osu-f1 (70% lightness) rather than a
 * b-scale grey: at 18px on a b4 panel, a 25%-lightness line is a control
 * nobody can find.
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
      className={`grid h-[18px] w-[18px] shrink-0 cursor-pointer place-items-center rounded-[4px] border-[1.5px] transition-colors duration-150 ${
        checked
          ? "border-osu-pink bg-osu-pink hover:border-osu-pink-light hover:bg-osu-pink-light"
          : "border-osu-f1/70 bg-osu-b6/60 hover:border-osu-pink hover:bg-osu-pink/10"
      }`}
    >
      <Check
        className={`h-3 w-3 text-white transition-opacity duration-150 ${checked ? "opacity-100" : "opacity-0"}`}
        strokeWidth={3.5}
      />
    </button>
  );
}
