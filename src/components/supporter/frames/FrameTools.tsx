import { useLingui } from "@lingui/react/macro";
import {
  ArrowLeftRight,
  Brush,
  Circle,
  CircleDashed,
  Droplet,
  Eraser,
  Hand,
  Hexagon,
  Lasso,
  Minus,
  MousePointer2,
  PaintBucket,
  PenTool,
  Pipette,
  Square,
  SquareDashed,
  Star,
  Type,
  ZoomIn,
} from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";

import type { ShapeKind } from "../../../lib/frame-editor/doc";
import { FONTS } from "../../../lib/frame-editor/doc";
import type { BrushSettings, BrushTip, RetouchMode, Symmetry } from "../../../lib/frame-editor/paint";
import { Switch } from "../../ui/Switch";
import { ColorPanel, NumberField, Popover } from "../themes/EditorControls";

/* The frame editor's tools: the rail down the left, the colour pair under
   it, and the bar along the top that holds the current tool's settings. */

export type ToolId = "move" | "marquee" | "lasso" | "wand" | "brush" | "eraser" | "fill" | "gradient" | "eyedropper" | "retouch" | "shape" | "pen" | "text" | "hand" | "zoom";

export interface ToolSettings {
  brush: BrushSettings;
  eraser: BrushSettings;
  symmetry: Symmetry;
  fill: { tolerance: number; contiguous: boolean; sampleAll: boolean };
  wand: { tolerance: number; contiguous: boolean; sampleAll: boolean };
  shape: { kind: ShapeKind; style: "fill" | "outline"; lineWidth: number };
  marquee: "rect" | "ellipse";
  text: { font: string; size: number; weight: number };
  move: { autoSelect: boolean; mode: "transform" | "distort" };
  retouch: { mode: RetouchMode; size: number; strength: number };
  gradient: { kind: "linear" | "radial" | "conic"; fade: boolean; opacity: number };
  pen: { style: "fill" | "outline"; lineWidth: number };
}

export const DEFAULT_TOOL_SETTINGS: ToolSettings = {
  brush: { size: 18, hardness: 0.8, opacity: 1, flow: 1, spacing: 0.08, pressure: true, smoothing: 0.3 },
  eraser: { size: 30, hardness: 0.9, opacity: 1, flow: 1, spacing: 0.08, pressure: false, smoothing: 0.2 },
  symmetry: { mode: "none", count: 6, mirror: false },
  fill: { tolerance: 32, contiguous: true, sampleAll: false },
  wand: { tolerance: 32, contiguous: true, sampleAll: true },
  shape: { kind: "ellipse", style: "outline", lineWidth: 12 },
  marquee: "rect",
  text: { font: "Torus", size: 56, weight: 800 },
  move: { autoSelect: true, mode: "transform" },
  retouch: { mode: "smudge", size: 40, strength: 0.6 },
  gradient: { kind: "linear", fade: false, opacity: 1 },
  pen: { style: "outline", lineWidth: 10 },
};

export const TOOL_KEYS: Record<string, ToolId> = { v: "move", m: "marquee", l: "lasso", w: "wand", b: "brush", e: "eraser", g: "fill", i: "eyedropper", u: "shape", p: "pen", r: "retouch", t: "text", h: "hand", z: "zoom" };

/* A magic wand: a plain stick with a band, no glints. */
function WandIcon({ size = 18 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M4 20 15.5 8.5" />
      <path d="m14 7 3 3" strokeWidth={4.2} />
      <path d="M17.5 3.5v2.4M20.5 6.5h-2.4" opacity={0.55} />
    </svg>
  );
}

/* A square shaded from solid to clear, for the gradient tool. */
function GradientIcon({ size = 18 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} aria-hidden>
      <defs>
        <linearGradient id="frame-editor-gradient-icon" x1="0" x2="1" y1="0" y2="0">
          <stop offset="0" stopColor="currentColor" stopOpacity="1" />
          <stop offset="1" stopColor="currentColor" stopOpacity="0" />
        </linearGradient>
      </defs>
      <rect x="3.5" y="3.5" width="17" height="17" rx="3" />
      <rect x="5.5" y="5.5" width="13" height="13" rx="1.5" fill="url(#frame-editor-gradient-icon)" stroke="none" />
    </svg>
  );
}

/* A quarter arc, for the arc shape. */
export function ArcIcon({ size = 16 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" aria-hidden>
      <path d="M4.5 15a8.5 8.5 0 0 1 15 0" />
    </svg>
  );
}

export function ShapeIcon({ kind, size = 16 }: { kind: ShapeKind; size?: number }) {
  switch (kind) {
    case "rect":
      return <Square size={size} />;
    case "ellipse":
      return <Circle size={size} />;
    case "polygon":
      return <Hexagon size={size} />;
    case "star":
      return <Star size={size} />;
    case "line":
      return <Minus size={size} />;
    case "arc":
      return <ArcIcon size={size} />;
  }
}

function RailButton({ label, shortcut, active, onClick, children }: { label: string; shortcut?: string; active: boolean; onClick: () => void; children: ReactNode }) {
  return (
    <span className="group/rail relative inline-flex">
      <button
        type="button"
        aria-label={label}
        aria-pressed={active}
        onClick={onClick}
        className={`grid h-9 w-9 cursor-pointer place-items-center rounded-lg transition-colors ${active ? "bg-osu-pink/20 text-osu-pink-light" : "text-osu-l2 hover:bg-white/[0.06] hover:text-white"}`}
      >
        {children}
      </button>
      <span className="pointer-events-none absolute left-full top-1/2 z-50 ml-2 hidden -translate-y-1/2 whitespace-nowrap rounded-md bg-black/90 px-2 py-1 text-[11px] text-white shadow-lg md:group-hover/rail:block">
        {label}
        {shortcut ? <span className="ml-2 font-mono text-[10px] text-white/50">{shortcut}</span> : null}
      </span>
    </span>
  );
}

export function useToolNames(): Record<ToolId, string> {
  const { t } = useLingui();
  return {
    move: t`Move`,
    marquee: t`Select`,
    lasso: t`Lasso`,
    wand: t`Magic wand`,
    brush: t`Brush`,
    eraser: t`Eraser`,
    fill: t`Paint bucket`,
    gradient: t`Gradient`,
    pen: t`Pen`,
    eyedropper: t`Eyedropper`,
    retouch: t`Smudge and blur`,
    shape: t`Shape`,
    text: t`Text`,
    hand: t`Hand tool`,
    zoom: t`Zoom`,
  };
}

export function ToolRail({ tool, onTool, settings, primary, secondary, onPrimary, onSecondary, onSwap, horizontal = false, columns = 1 }: {
  tool: ToolId;
  onTool: (tool: ToolId) => void;
  settings: ToolSettings;
  primary: string;
  secondary: string;
  onPrimary: (hex: string) => void;
  onSecondary: (hex: string) => void;
  onSwap: () => void;
  horizontal?: boolean;
  /* two columns on short windows, so every tool and the colours fit */
  columns?: 1 | 2;
}) {
  const { t } = useLingui();
  const names = useToolNames();
  const groups: { id: ToolId; key: string; icon: ReactNode }[][] = [
    [
      { id: "move", key: "V", icon: <MousePointer2 size={17} /> },
      { id: "marquee", key: "M", icon: settings.marquee === "ellipse" ? <CircleDashed size={17} /> : <SquareDashed size={17} /> },
      { id: "lasso", key: "L", icon: <Lasso size={17} /> },
      { id: "wand", key: "W", icon: <WandIcon /> },
    ],
    [
      { id: "brush", key: "B", icon: <Brush size={17} /> },
      { id: "eraser", key: "E", icon: <Eraser size={17} /> },
      { id: "fill", key: "G", icon: <PaintBucket size={17} /> },
      { id: "gradient", key: "G", icon: <GradientIcon /> },
      { id: "eyedropper", key: "I", icon: <Pipette size={17} /> },
      { id: "retouch", key: "R", icon: <Droplet size={17} /> },
    ],
    [
      { id: "shape", key: "U", icon: <ShapeIcon kind={settings.shape.kind} size={17} /> },
      { id: "pen", key: "P", icon: <PenTool size={17} /> },
      { id: "text", key: "T", icon: <Type size={17} /> },
    ],
    [
      { id: "hand", key: "H", icon: <Hand size={17} /> },
      { id: "zoom", key: "Z", icon: <ZoomIn size={17} /> },
    ],
  ];
  const colours = (
    <div className={`flex items-center ${horizontal ? "ml-2 flex-row gap-1.5" : "mt-3 flex-col gap-1"}`}>
      <div className="relative h-11 w-11">
        <div className="absolute bottom-0 right-0">
          <Swatch value={secondary} onChange={onSecondary} label={t`Second colour`} />
        </div>
        <div className="absolute left-0 top-0">
          <Swatch value={primary} onChange={onPrimary} label={t`Colour`} />
        </div>
      </div>
      <button type="button" onClick={onSwap} title={`${t`Swap colours`} (X)`} aria-label={t`Swap colours`} className="grid h-6 w-6 cursor-pointer place-items-center rounded text-osu-f1 hover:bg-white/[0.06] hover:text-white">
        <ArrowLeftRight size={12} />
      </button>
    </div>
  );
  if (columns === 2 && !horizontal) {
    return (
      <div className="flex shrink-0 flex-col items-center py-2">
        <div className="grid grid-cols-2 gap-0.5">
          {groups.map((group, index) => [
            index > 0 ? <span key={`d${index}`} aria-hidden className="col-span-2 mx-auto my-1 h-px w-12 bg-white/10" /> : null,
            ...group.map((entry) => (
              <RailButton key={entry.id} label={names[entry.id]} shortcut={entry.key} active={tool === entry.id} onClick={() => onTool(entry.id)}>
                {entry.icon}
              </RailButton>
            )),
          ])}
        </div>
        {colours}
      </div>
    );
  }
  return (
    <div className={`flex shrink-0 items-center gap-1 ${horizontal ? "flex-row overflow-x-auto px-2 py-1" : "flex-col py-2"}`}>
      {groups.map((group, index) => (
        <div key={index} className={`flex items-center gap-0.5 ${horizontal ? "flex-row" : "flex-col"}`}>
          {index > 0 ? <span aria-hidden className={horizontal ? "mx-1 h-5 w-px bg-white/10" : "my-1 h-px w-5 bg-white/10"} /> : null}
          {group.map((entry) => (
            <RailButton key={entry.id} label={names[entry.id]} shortcut={entry.key} active={tool === entry.id} onClick={() => onTool(entry.id)}>
              {entry.icon}
            </RailButton>
          ))}
        </div>
      ))}
      {colours}
    </div>
  );
}

const SWATCHES = ["#ffffff", "#000000", "#ff66ab", "#ff4d6d", "#ff9f43", "#ffd166", "#7bd389", "#2ec4b6", "#66ccff", "#4d7cff", "#a35cff", "#ff8fd8", "#8a8a8a", "#3b2a33"];
const recent: string[] = [];

export function Swatch({ value, onChange, label, small = false }: { value: string; onChange: (hex: string) => void; label: string; small?: boolean }) {
  const [open, setOpen] = useState(false);
  const pick = (hex: string) => {
    onChange(hex);
    const at = recent.indexOf(hex);
    if (at >= 0) recent.splice(at, 1);
    recent.unshift(hex);
    recent.length = Math.min(recent.length, 7);
  };
  return (
    <Popover
      open={open}
      onOpenChange={setOpen}
      className="w-60"
      trigger={
        <button
          type="button"
          aria-label={label}
          title={label}
          onClick={() => setOpen((value) => !value)}
          className={`block cursor-pointer rounded-md ring-2 ring-black/70 transition hover:brightness-110 ${small ? "h-6 w-6" : "h-7 w-7"}`}
          style={{ background: value, boxShadow: "0 0 0 1px rgba(255,255,255,0.35) inset" }}
        />
      }
    >
      <div className="grid gap-2.5 p-1">
        <ColorPanel value={value} onChange={pick} label={label} />
        <div className="grid grid-cols-7 gap-1.5">
          {[...new Set([...recent, ...SWATCHES])].slice(0, 21).map((hex) => (
            <button key={hex} type="button" aria-label={hex} onClick={() => pick(hex)} className="aspect-square cursor-pointer rounded ring-1 ring-white/15 transition hover:scale-110" style={{ background: hex }} />
          ))}
        </div>
      </div>
    </Popover>
  );
}

/* --- The options bar ------------------------------------------------------------- */

function Field({ children, width = "w-[150px]" }: { children: ReactNode; width?: string }) {
  return <div className={`${width} shrink-0`}>{children}</div>;
}

function Toggle({ label, checked, onChange }: { label: string; checked: boolean; onChange: (value: boolean) => void }) {
  return (
    <label className="flex shrink-0 cursor-pointer items-center gap-2 text-[12px] text-osu-l2">
      <Switch checked={checked} onChange={onChange} label={label} />
      {label}
    </label>
  );
}

function Segments<T extends string>({ value, options, onChange }: { value: T; options: { id: T; label: ReactNode; title: string }[]; onChange: (value: T) => void }) {
  return (
    <div className="flex shrink-0 gap-0.5 rounded-lg bg-black/30 p-[3px] ring-1 ring-white/[0.07]">
      {options.map((option) => (
        <button
          key={option.id}
          type="button"
          title={option.title}
          aria-label={option.title}
          aria-pressed={value === option.id}
          onClick={() => onChange(option.id)}
          className={`grid h-7 min-w-7 cursor-pointer place-items-center rounded-md px-1.5 text-[12px] font-semibold transition-colors ${value === option.id ? "bg-white/[0.12] text-white" : "text-osu-f1 hover:text-white"}`}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

export function ToolOptions({ tool, settings, onChange, onFitView }: {
  tool: ToolId;
  settings: ToolSettings;
  onChange: (settings: ToolSettings) => void;
  onFitView: () => void;
}) {
  const { t } = useLingui();
  const names = useToolNames();
  const set = <K extends keyof ToolSettings>(key: K, value: Partial<ToolSettings[K]> | ToolSettings[K]) =>
    onChange({ ...settings, [key]: typeof value === "object" && value !== null ? { ...(settings[key] as object), ...value } : value });

  const brushKey = tool === "eraser" ? "eraser" : "brush";
  const brush = settings[brushKey];
  const symmetry = settings.symmetry;

  let body: ReactNode = null;
  if (tool === "brush" || tool === "eraser") {
    body = (
      <>
        <Segments
          value={brush.tip ?? "round"}
          onChange={(tip) => set(brushKey, { tip })}
          options={([
            ["round", t`Round`, <span key="r" className="block h-3.5 w-3.5 rounded-full bg-current" />],
            ["square", t`Square`, <span key="s" className="block h-3 w-3 bg-current" />],
            ["flat", t`Flat`, <span key="f" className="block h-1.5 w-4 -rotate-45 rounded-full bg-current" />],
            ["chalk", t`Chalk`, <span key="c" className="block h-3.5 w-3.5 rounded-full bg-[radial-gradient(currentColor_35%,transparent_40%)] bg-[length:3px_3px]" />],
            ["scatter", t`Scatter`, <span key="d" className="relative block h-3.5 w-3.5"><span className="absolute left-0 top-0 h-1.5 w-1.5 rounded-full bg-current" /><span className="absolute bottom-0 left-1 h-1 w-1 rounded-full bg-current" /><span className="absolute right-0 top-1 h-1.5 w-1.5 rounded-full bg-current" /></span>],
          ] as [BrushTip, string, ReactNode][]).map(([id, title, label]) => ({ id, title, label }))}
        />
        <Field><NumberField label={t`Size`} value={brush.size} min={1} max={300} step={1} unit="px" onChange={(size) => set(brushKey, { size })} /></Field>
        <Field><NumberField label={t`Hardness`} value={brush.hardness} min={0} max={1} step={0.01} scale={100} unit="%" onChange={(hardness) => set(brushKey, { hardness })} /></Field>
        <Field><NumberField label={t`Opacity`} value={brush.opacity} min={0.01} max={1} step={0.01} scale={100} unit="%" onChange={(opacity) => set(brushKey, { opacity })} /></Field>
        <Field><NumberField label={t`Flow`} value={brush.flow} min={0.01} max={1} step={0.01} scale={100} unit="%" onChange={(flow) => set(brushKey, { flow })} /></Field>
        <Field><NumberField label={t`Smoothing`} value={brush.smoothing} min={0} max={0.95} step={0.01} scale={100} unit="%" onChange={(smoothing) => set(brushKey, { smoothing })} /></Field>
        <Toggle label={t`Pen pressure`} checked={brush.pressure} onChange={(pressure) => set(brushKey, { pressure })} />
        <span aria-hidden className="h-5 w-px shrink-0 bg-white/10" />
        <span className="shrink-0 text-[11px] font-bold uppercase tracking-[0.08em] text-osu-f1">{t`Symmetry`}</span>
        <Segments
          value={symmetry.mode}
          onChange={(mode) => set("symmetry", { mode })}
          options={[
            { id: "none", label: t`Off`, title: t`No symmetry` },
            { id: "x", label: "⇆", title: t`Mirror left and right` },
            { id: "y", label: "⇅", title: t`Mirror top and bottom` },
            { id: "xy", label: "✛", title: t`Mirror four ways` },
            { id: "radial", label: t`Radial`, title: t`Round the avatar` },
          ]}
        />
        {symmetry.mode === "radial" ? (
          <>
            <Field width="w-[130px]"><NumberField label={t`Copies`} value={symmetry.count} min={2} max={32} step={1} onChange={(count) => set("symmetry", { count })} /></Field>
            <Toggle label={t`Mirror`} checked={symmetry.mirror} onChange={(mirror) => set("symmetry", { mirror })} />
          </>
        ) : null}
      </>
    );
  } else if (tool === "fill" || tool === "wand") {
    const key = tool;
    const value = settings[key];
    body = (
      <>
        <Field><NumberField label={t`Tolerance`} value={value.tolerance} min={0} max={255} step={1} onChange={(tolerance) => set(key, { tolerance })} /></Field>
        <Toggle label={t`Connected only`} checked={value.contiguous} onChange={(contiguous) => set(key, { contiguous })} />
        <Toggle label={t`All layers`} checked={value.sampleAll} onChange={(sampleAll) => set(key, { sampleAll })} />
        {tool === "wand" ? <span className="shrink-0 text-[11.5px] text-osu-f1">{t`Shift adds, Alt takes away`}</span> : null}
      </>
    );
  } else if (tool === "shape") {
    body = (
      <>
        <Segments
          value={settings.shape.kind}
          onChange={(kind) => set("shape", { kind })}
          options={(["rect", "ellipse", "polygon", "star", "line", "arc"] as const).map((kind) => ({
            id: kind,
            label: <ShapeIcon kind={kind} size={15} />,
            title: { rect: t`Rectangle`, ellipse: t`Ellipse`, polygon: t`Polygon`, star: t`Star`, line: t`Line`, arc: t`Arc` }[kind],
          }))}
        />
        <Segments
          value={settings.shape.style}
          onChange={(style) => set("shape", { style })}
          options={[{ id: "fill", label: t`Fill`, title: t`Filled` }, { id: "outline", label: t`Outline`, title: t`Outline only` }]}
        />
        <Field><NumberField label={t`Line`} value={settings.shape.lineWidth} min={1} max={120} step={1} unit="px" onChange={(lineWidth) => set("shape", { lineWidth })} /></Field>
        <span className="shrink-0 text-[11.5px] text-osu-f1">{t`Shift keeps it even, Alt draws from the middle`}</span>
      </>
    );
  } else if (tool === "marquee") {
    body = (
      <>
        <Segments
          value={settings.marquee}
          onChange={(marquee) => set("marquee", marquee)}
          options={[{ id: "rect", label: <SquareDashed size={15} />, title: t`Rectangle` }, { id: "ellipse", label: <CircleDashed size={15} />, title: t`Ellipse` }]}
        />
        <span className="shrink-0 text-[11.5px] text-osu-f1">{t`Shift adds, Alt takes away. Ctrl D drops the selection.`}</span>
      </>
    );
  } else if (tool === "retouch") {
    body = (
      <>
        <Segments
          value={settings.retouch.mode}
          onChange={(mode) => set("retouch", { mode })}
          options={[
            { id: "smudge", label: t`Smudge`, title: t`Smudge` },
            { id: "blur", label: t`Blur`, title: t`Blur` },
            { id: "lighten", label: t`Lighten`, title: t`Lighten` },
            { id: "darken", label: t`Darken`, title: t`Darken` },
          ]}
        />
        <Field><NumberField label={t`Size`} value={settings.retouch.size} min={4} max={300} step={1} unit="px" onChange={(size) => set("retouch", { size })} /></Field>
        <Field><NumberField label={t`Strength`} value={settings.retouch.strength} min={0.05} max={1} step={0.01} scale={100} unit="%" onChange={(strength) => set("retouch", { strength })} /></Field>
        <span className="shrink-0 text-[11.5px] text-osu-f1">{t`Works on paint layers. The brush's symmetry applies.`}</span>
      </>
    );
  } else if (tool === "gradient") {
    body = (
      <>
        <Segments
          value={settings.gradient.kind}
          onChange={(kind) => set("gradient", { kind })}
          options={[{ id: "linear", label: t`Linear`, title: t`Linear` }, { id: "radial", label: t`Radial`, title: t`Radial` }, { id: "conic", label: t`Sweep`, title: t`Sweep` }]}
        />
        <Toggle label={t`Colour to clear`} checked={settings.gradient.fade} onChange={(fade) => set("gradient", { fade })} />
        <Field><NumberField label={t`Opacity`} value={settings.gradient.opacity} min={0.01} max={1} step={0.01} scale={100} unit="%" onChange={(opacity) => set("gradient", { opacity })} /></Field>
        <span className="shrink-0 text-[11.5px] text-osu-f1">{settings.gradient.fade ? t`Drag across the canvas, from the colour to clear` : t`Drag across the canvas, from the colour to the second colour`}</span>
      </>
    );
  } else if (tool === "pen") {
    body = (
      <>
        <Segments
          value={settings.pen.style}
          onChange={(style) => set("pen", { style })}
          options={[{ id: "outline", label: t`Outline`, title: t`Outline only` }, { id: "fill", label: t`Fill`, title: t`Filled` }]}
        />
        <Field><NumberField label={t`Line`} value={settings.pen.lineWidth} min={1} max={120} step={1} unit="px" onChange={(lineWidth) => set("pen", { lineWidth })} /></Field>
        <span className="shrink-0 text-[11.5px] text-osu-f1">{t`Click for corners, drag for curves. Click the first point to close, Enter to finish. Alt-drag a handle to break it.`}</span>
      </>
    );
  } else if (tool === "lasso") {
    body = <span className="shrink-0 text-[11.5px] text-osu-f1">{t`Draw round what to select. Shift adds, Alt takes away.`}</span>;
  } else if (tool === "text") {
    body = (
      <>
        <FontPicker value={settings.text.font} onChange={(font) => set("text", { font, weight: FONTS.find((entry) => entry.family === font)?.weights.at(-1) ?? 400 })} />
        <Field><NumberField label={t`Size`} value={settings.text.size} min={8} max={240} step={1} unit="px" onChange={(size) => set("text", { size })} /></Field>
        <span className="shrink-0 text-[11.5px] text-osu-f1">{t`Click to add text`}</span>
      </>
    );
  } else if (tool === "move") {
    body = (
      <>
        <Segments
          value={settings.move.mode}
          onChange={(mode) => set("move", { mode })}
          options={[{ id: "transform", label: t`Transform`, title: t`Move, resize and turn` }, { id: "distort", label: t`Perspective`, title: t`Drag each corner on its own` }]}
        />
        <Toggle label={t`Pick the layer under the pointer`} checked={settings.move.autoSelect} onChange={(autoSelect) => set("move", { autoSelect })} />
        <span className="shrink-0 text-[11.5px] text-osu-f1">{t`Shift keeps a move on one axis and turns in 15° steps`}</span>
      </>
    );
  } else if (tool === "eyedropper") {
    body = <span className="shrink-0 text-[11.5px] text-osu-f1">{t`Click to take a colour. Alt-click with the brush does the same.`}</span>;
  } else if (tool === "hand" || tool === "zoom") {
    body = (
      <>
        <button type="button" onClick={onFitView} className="h-8 shrink-0 cursor-pointer rounded-md bg-white/[0.06] px-2.5 text-[11.5px] font-semibold text-osu-l2 hover:bg-white/[0.1] hover:text-white">{t`Fit`}</button>
        <span className="shrink-0 text-[11.5px] text-osu-f1">{tool === "zoom" ? t`Click to zoom in, Alt-click to zoom out` : t`Drag to move around. Space does it from any tool.`}</span>
      </>
    );
  }
  return (
    // wraps onto a second row on wide screens instead of running off the edge; scrolls sideways on phones
    <div className="flex h-11 shrink-0 items-center gap-2.5 overflow-x-auto border-b border-white/[0.07] bg-osu-b6/80 px-3 [scrollbar-width:none] md:h-auto md:min-h-11 md:flex-wrap md:gap-y-1.5 md:overflow-visible md:py-1.5">
      <span className="shrink-0 text-[12px] font-semibold text-white">{names[tool]}</span>
      <span aria-hidden className="h-5 w-px shrink-0 bg-white/10" />
      {body}
    </div>
  );
}

export function FontPicker({ value, onChange }: { value: string; onChange: (family: string) => void }) {
  const { t } = useLingui();
  const [open, setOpen] = useState(false);
  const label = FONTS.find((font) => font.family === value)?.label ?? value;
  return (
    <Popover
      open={open}
      onOpenChange={setOpen}
      className="w-56"
      trigger={
        <button type="button" aria-label={t`Font`} onClick={() => setOpen((current) => !current)} className="flex h-8 w-44 shrink-0 cursor-pointer items-center justify-between rounded-md bg-white/[0.045] px-3 text-[12.5px] text-white ring-1 ring-white/[0.06] hover:bg-white/[0.07]">
          <span className="truncate" style={{ fontFamily: `"${value}"` }}>{label}</span>
          <span className="text-osu-f1">▾</span>
        </button>
      }
    >
      <div className="grid max-h-72 gap-0.5 overflow-y-auto">
        {FONTS.map((font) => (
          <button
            key={font.family}
            type="button"
            onClick={() => {
              onChange(font.family);
              setOpen(false);
            }}
            className={`h-9 cursor-pointer truncate rounded-md px-2.5 text-left text-[15px] transition-colors ${font.family === value ? "bg-osu-pink/20 text-white" : "text-osu-l2 hover:bg-white/[0.06] hover:text-white"}`}
            style={{ fontFamily: `"${font.family}"` }}
          >
            {font.label}
          </button>
        ))}
      </div>
    </Popover>
  );
}

/* A modal over the editor, for the start and submit steps. */
export function EditorModal({ label, onClose, children, wide = false }: { label: string; onClose?: () => void; children: ReactNode; wide?: boolean }) {
  // portals open after hydration, so the server's markup and the first client render agree
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  if (!mounted) return null;
  return createPortal(
    <div className="fixed inset-0 z-[140] grid place-items-center overflow-y-auto bg-black/70 p-4" role="dialog" aria-modal="true" aria-label={label} onPointerDown={(event) => onClose && event.target === event.currentTarget && onClose()}>
      <div className={`w-full ${wide ? "max-w-[760px]" : "max-w-[440px]"} overflow-hidden rounded-xl border border-white/[0.08] bg-[color-mix(in_srgb,var(--color-osu-b5)_50%,var(--color-osu-b6))] shadow-[0_24px_80px_rgba(0,0,0,0.7)]`}>
        {children}
      </div>
    </div>,
    document.body,
  );
}
