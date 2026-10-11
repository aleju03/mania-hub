import { Check, X } from "lucide-react";
import { useState } from "react";

/* The inline video link editor the Add plays and Add video tabs share: Enter
 * saves, Escape cancels. An empty link is saved only where the play can go
 * without one.
 */
export function VideoLinkForm({
  initial,
  allowEmpty,
  busy,
  onSave,
  onCancel,
}: {
  initial: string;
  allowEmpty: boolean;
  busy: boolean;
  onSave: (videoUrl: string) => void;
  onCancel: () => void;
}) {
  const [value, setValue] = useState(initial);
  const trimmed = value.trim();
  const canSave = !busy && trimmed !== initial && (allowEmpty || trimmed !== "");
  return (
    <form
      className="mt-1 flex items-center gap-1.5"
      onSubmit={(event) => {
        event.preventDefault();
        if (canSave) onSave(trimmed);
      }}
    >
      <input
        autoFocus
        value={value}
        onChange={(event) => setValue(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Escape") onCancel();
        }}
        placeholder="https://www.youtube.com/watch?v=..."
        className="min-w-0 flex-1 rounded-md bg-osu-b4/60 border border-osu-b3/30 px-2.5 py-1.5 text-[13px] text-white placeholder:text-osu-f1 outline-none focus:border-osu-b3"
      />
      <button
        type="submit"
        disabled={!canSave}
        aria-label="Save"
        className="grid h-8 w-8 shrink-0 cursor-pointer place-items-center rounded-md text-osu-l2 hover:bg-osu-b3/60 hover:text-white disabled:cursor-default disabled:opacity-40"
      >
        <Check size={15} />
      </button>
      <button
        type="button"
        onClick={onCancel}
        aria-label="Cancel"
        className="grid h-8 w-8 shrink-0 cursor-pointer place-items-center rounded-md text-osu-f1 hover:bg-osu-b3/60 hover:text-white"
      >
        <X size={15} />
      </button>
    </form>
  );
}
