import { useLingui } from "@lingui/react/macro";
import { ChevronDown } from "lucide-react";
import { useState } from "react";

import { SUPPORTER_PROFILE_THEME_LABELS, type SupporterProfileThemeId } from "../../../lib/supporter-profile-themes";
import { profileThemeThumb } from "../ProfileThemeBackdrop";
import { Popover } from "./EditorControls";

/* "Start from": the starter example or a built-in theme's own code, as a grid
   of their stills. */
export function StartPicker({ themes, onPick }: { themes: readonly SupporterProfileThemeId[]; onPick: (start: "starter" | SupporterProfileThemeId) => void }) {
  const { t, i18n } = useLingui();
  const [open, setOpen] = useState(false);
  const pick = (start: "starter" | SupporterProfileThemeId) => {
    setOpen(false);
    onPick(start);
  };
  return (
    <Popover
      open={open}
      onOpenChange={setOpen}
      className="w-[min(560px,calc(100vw-2rem))]"
      trigger={
        <button
          type="button"
          aria-expanded={open}
          onClick={() => setOpen((value) => !value)}
          className="inline-flex h-8 cursor-pointer items-center gap-1.5 rounded-lg bg-osu-b4 pl-3 pr-2 text-[12px] font-semibold text-osu-l2 transition-colors hover:bg-osu-b3 hover:text-white"
        >
          {t`Start from`}
          <ChevronDown size={14} className={`transition-transform ${open ? "rotate-180" : ""}`} />
        </button>
      }
    >
      <p className="px-1.5 pb-2 pt-0.5 text-[11.5px] text-osu-f1">{t`Replaces the code with a theme's own, to change as you like.`}</p>
      <div className="grid max-h-[340px] grid-cols-3 gap-1.5 overflow-y-auto sm:grid-cols-4">
        <button type="button" onClick={() => pick("starter")} className="group cursor-pointer rounded-lg p-1 text-left transition-colors hover:bg-osu-b3">
          <span className="grid aspect-[16/10] w-full place-items-center rounded-md border border-dashed border-white/15 bg-osu-b6 font-mono text-[13px] text-osu-pink-light">{"{ }"}</span>
          <span className="mt-1 block truncate px-0.5 text-[11px] font-semibold text-osu-l2 group-hover:text-white">{t`Starter`}</span>
        </button>
        {themes.map((id) => (
          <button key={id} type="button" onClick={() => pick(id)} className="group cursor-pointer rounded-lg p-1 text-left transition-colors hover:bg-osu-b3">
            <img src={profileThemeThumb(id)} alt="" loading="lazy" className="aspect-[16/10] w-full rounded-md object-cover" />
            <span className="mt-1 block truncate px-0.5 text-[11px] font-semibold text-osu-l2 group-hover:text-white">{i18n._(SUPPORTER_PROFILE_THEME_LABELS[id])}</span>
          </button>
        ))}
      </div>
    </Popover>
  );
}
