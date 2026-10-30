import { useEffect, useState } from "react";
import { breakpointScale, normalizeUiScale, UI_SCALE_BREAKPOINTS, UI_SCALE_MAX, UI_SCALE_MIN, UI_SCALE_STEP } from "./ui-scale-values";

/* UI Scaling: how much bigger (or smaller) the whole interface draws, a
   0.8x-1.6x slider like lazer's. It is one CSS variable, --ui-scale, on the
   root element: rem sizes follow the root font size and every px size in the
   stylesheet is built to multiply by it (scripts/ui-scale-postcss.ts). The
   nearest prepared breakpoint step goes on the root as data-ui-scale, which
   picks the media query copies the build made for it, so layouts switch at
   about the widths they would under browser zoom. Stored per browser and
   applied by an inline script in the document head before first paint
   (UI_SCALE_BOOT_SCRIPT), so a scaled page never flashes at 1x. */
export const UI_SCALE_STORAGE_KEY = "mania-hub-ui-scale-v1";
export const UI_SCALE_EVENT = "mania-hub-ui-scale";
export { normalizeUiScale, UI_SCALE_MAX, UI_SCALE_MIN, UI_SCALE_STEP };

export function readUiScale(): number {
  try {
    return normalizeUiScale(localStorage.getItem(UI_SCALE_STORAGE_KEY) ?? 1);
  } catch {
    return 1;
  }
}

function applyUiScale(value: number): void {
  const root = document.documentElement;
  if (value === 1) root.style.removeProperty("--ui-scale");
  else root.style.setProperty("--ui-scale", String(value));
  const step = breakpointScale(value);
  if (step === 1) root.removeAttribute("data-ui-scale");
  else root.setAttribute("data-ui-scale", String(step));
}

/* Shows a scale without saving it, for the slider while it is dragged. */
export function previewUiScale(scale: number): void {
  applyUiScale(normalizeUiScale(scale));
}

export function setUiScale(scale: number): void {
  const value = normalizeUiScale(scale);
  applyUiScale(value);
  try {
    if (value === 1) localStorage.removeItem(UI_SCALE_STORAGE_KEY);
    else localStorage.setItem(UI_SCALE_STORAGE_KEY, String(value));
  } catch {
    // private mode: the scale still applies for this page
  }
  window.dispatchEvent(new CustomEvent(UI_SCALE_EVENT, { detail: value }));
}

export function useUiScale(): [number, (scale: number) => void] {
  // 1 on the server and the first client render, so hydration matches.
  const [scale, setScale] = useState(1);
  useEffect(() => {
    setScale(readUiScale());
    const onChange = (event: Event) => setScale(normalizeUiScale((event as CustomEvent).detail));
    const onStorage = (event: StorageEvent) => {
      if (event.key !== UI_SCALE_STORAGE_KEY) return;
      const next = normalizeUiScale(event.newValue ?? 1);
      applyUiScale(next);
      setScale(next);
    };
    window.addEventListener(UI_SCALE_EVENT, onChange);
    window.addEventListener("storage", onStorage);
    return () => {
      window.removeEventListener(UI_SCALE_EVENT, onChange);
      window.removeEventListener("storage", onStorage);
    };
  }, []);
  return [scale, setUiScale];
}

/* Runs in the head before the body paints. Mirrors normalizeUiScale and
   breakpointScale. */
export const UI_SCALE_BOOT_SCRIPT = `(function(){try{var v=Number(localStorage.getItem(${JSON.stringify(UI_SCALE_STORAGE_KEY)}));if(!isFinite(v)||v<=0)return;v=Math.min(${UI_SCALE_MAX},Math.max(${UI_SCALE_MIN},v));v=Number((Math.round(v/${UI_SCALE_STEP})*${UI_SCALE_STEP}).toFixed(2));if(v===1)return;var r=document.documentElement;r.style.setProperty("--ui-scale",String(v));var s=${JSON.stringify(UI_SCALE_BREAKPOINTS)},b=s[0];for(var i=0;i<s.length;i++)if(Math.abs(s[i]-v)<Math.abs(b-v))b=s[i];if(b!==1)r.setAttribute("data-ui-scale",String(b));}catch(e){}})();`;
