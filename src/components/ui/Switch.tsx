/* The site's on/off control, as the settings panel has always drawn it.
 *
 * Lives here rather than beside one panel because a boolean is a boolean
 * everywhere: a pair of "Shown"/"Hidden" chips is a picker doing a switch's
 * job, and a lone chip you have to read as pressed-or-not is worse. `label`
 * is what a screen reader announces, since the visible name is usually the
 * row this sits on rather than anything inside it.
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
      className={`inline-flex h-5 w-9 shrink-0 cursor-pointer items-center rounded-full border p-0.5 transition-colors ${
        checked ? "border-osu-pink bg-osu-pink" : "border-osu-b3/60 bg-osu-b5/80"
      }`}
    >
      <span
        className={`h-4 w-4 rounded-full bg-white shadow-sm transition-transform ${
          checked ? "translate-x-4" : "translate-x-0"
        }`}
      />
    </button>
  );
}
