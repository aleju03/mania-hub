import { useEffect, useState } from "react";
import { useLingui } from "@lingui/react/macro";
import { Slider } from "./themes/EditorControls";

/* On the owner's own themed profile: how much the theme is dimmed and blurred
   behind the page, set while looking at the page itself. The sliders move the
   page as they go (`onLive`); letting one go saves (`onSave`). */
export function ThemeReadabilityPanel({ dim, blur, onLive, onSave }: {
  dim: number;
  blur: number;
  onLive: (value: { dim: number; blur: number } | null) => void;
  onSave: (value: { dim: number; blur: number }) => Promise<void>;
}) {
  const { t } = useLingui();
  const [open, setOpen] = useState(false);
  // /supporter links here with ?adjust=theme to open it straight away
  useEffect(() => {
    if (new URLSearchParams(window.location.search).get("adjust") === "theme") setOpen(true);
  }, []);
  const [draft, setDraft] = useState({ dim, blur });
  const [failed, setFailed] = useState(false);
  // a save landing moves the sliders to what was stored
  useEffect(() => setDraft({ dim, blur }), [dim, blur]);

  const move = (key: "dim" | "blur", percent: number) => {
    const next = { ...draft, [key]: percent / 100 };
    setDraft(next);
    onLive(next);
  };
  const save = () => {
    if (draft.dim === dim && draft.blur === blur) return;
    setFailed(false);
    onSave(draft)
      .catch(() => {
        setFailed(true);
        onLive(null);
        setDraft({ dim, blur });
      });
  };

  const row = (key: "dim" | "blur", label: string) => (
    <div className="flex items-center gap-3" onKeyUp={save} onBlur={save}>
      <span className="w-9 shrink-0 text-[12px] font-semibold text-osu-l1">{label}</span>
      <Slider
        value={Math.round(draft[key] * 100)}
        min={0}
        max={100}
        step={5}
        label={label}
        format={(value) => `${value}%`}
        onChange={(value) => move(key, value)}
        onDragEnd={save}
      />
    </div>
  );

  return (
    <div className="fixed bottom-4 right-4 z-40 flex flex-col items-end gap-2">
      {open ? (
        <div className="w-[280px] rounded-xl bg-osu-b4/95 p-3.5 shadow-[0_8px_30px_rgba(0,0,0,0.5)] ring-1 ring-white/[0.07] backdrop-blur-sm">
          {/* Only a failed save says anything, beside the title so the panel keeps its height. */}
          <div className="flex items-baseline justify-between gap-2">
            <span className="text-[13px] font-semibold text-white">{t`Behind text`}</span>
            {failed ? <span className="text-[11px] text-osu-red-light">{t`Couldn't save`}</span> : null}
          </div>
          <div className="mt-0.5 text-[11px] text-osu-f1">{t`Dims or blurs your theme so the page reads well over it. Saves when you let go.`}</div>
          <div className="mt-3 space-y-2">
            {row("dim", t`Dim`)}
            {row("blur", t`Blur`)}
          </div>
        </div>
      ) : null}
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        className="cursor-pointer rounded-full bg-osu-b4/95 px-4 py-2 text-[12px] font-semibold text-white shadow-[0_4px_16px_rgba(0,0,0,0.45)] ring-1 ring-white/[0.07] transition hover:brightness-110"
      >
        {open ? t`Done` : t`Dim and blur`}
      </button>
    </div>
  );
}
