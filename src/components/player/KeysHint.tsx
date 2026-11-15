import { useEffect, useState } from "react";
import { useLingui } from "@lingui/react/macro";

/* Under a frame that answers the viewer's keys (DFJK, 7K board): a small row
   of keycaps saying which keys play it. Only where there is a keyboard to
   press (a fine pointer that hovers), hidden while the frame is being played,
   and gone for good on this browser once it has been played once. */

const PLAYED_KEY = "mt-frame-keys-played";

function alreadyPlayed(): boolean {
  try {
    return window.localStorage.getItem(PLAYED_KEY) === "1";
  } catch {
    return false;
  }
}

export function KeysHint({ keys, live, top }: { keys: string[]; live: boolean; /* just under the drawn art */ top: string }) {
  const { t } = useLingui();
  const [show, setShow] = useState(false);
  useEffect(() => {
    setShow(window.matchMedia("(hover: hover) and (pointer: fine)").matches && !alreadyPlayed());
  }, []);
  useEffect(() => {
    if (!live) return;
    try {
      window.localStorage.setItem(PLAYED_KEY, "1");
    } catch {
      // private mode: the hint just comes back next visit
    }
    setShow(false);
  }, [live]);
  if (!show) return null;
  return (
    <div style={{ top }} className="absolute left-1/2 mt-1 flex -translate-x-1/2 items-center gap-1 whitespace-nowrap rounded-full bg-black/35 px-1.5 py-0.5 text-[9px] font-semibold leading-none text-white/70 backdrop-blur-sm">
      <span>{t`Try`}</span>
      {keys.map((key) => (
        <kbd
          key={key}
          className={`grid h-3.5 place-items-center rounded-[3px] border border-white/15 border-b-white/5 bg-white/10 font-sans text-[8px] font-bold text-white/80 shadow-[0_1px_0_rgba(0,0,0,0.5)] ${key === " " ? "w-5" : "w-3.5"}`}
        >
          {key === " " ? "" : key}
        </kbd>
      ))}
    </div>
  );
}
