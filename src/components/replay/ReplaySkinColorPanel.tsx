import { useEffect, useRef } from "react";
import type { PointerEvent as ReactPointerEvent } from "react";

export const REPLAY_SKIN_PALETTE = [
  "#9cf2ae",
  "#dfffe6",
  "#5a8fff",
  "#de31ae",
  "#ffcc22",
  "#88da20",
  "#e3a5de",
  "#8b8b93",
  "#ffffff",
  "#20222b",
];

export function hexToRgbParts(value: string): [number, number, number] {
  const normalized = /^#[0-9a-f]{6}$/i.test(value) ? value : "#ffffff";
  const raw = normalized.slice(1);
  return [
    Number.parseInt(raw.slice(0, 2), 16),
    Number.parseInt(raw.slice(2, 4), 16),
    Number.parseInt(raw.slice(4, 6), 16),
  ];
}

export function rgbPartsToHex(r: number, g: number, b: number): string {
  return `#${[r, g, b].map((value) => Math.max(0, Math.min(255, Math.round(value))).toString(16).padStart(2, "0")).join("")}`;
}

export function normalizeEditableHex(value: string): string | null {
  const trimmed = value.trim();
  if (/^#[0-9a-f]{6}$/i.test(trimmed)) return trimmed.toLowerCase();
  if (/^[0-9a-f]{6}$/i.test(trimmed)) return `#${trimmed.toLowerCase()}`;
  return null;
}

export function rgbToHsv(r: number, g: number, b: number): [number, number, number] {
  const rn = r / 255;
  const gn = g / 255;
  const bn = b / 255;
  const max = Math.max(rn, gn, bn);
  const min = Math.min(rn, gn, bn);
  const delta = max - min;
  let h = 0;
  if (delta !== 0) {
    if (max === rn) h = ((gn - bn) / delta) % 6;
    else if (max === gn) h = (bn - rn) / delta + 2;
    else h = (rn - gn) / delta + 4;
    h *= 60;
    if (h < 0) h += 360;
  }
  const s = max === 0 ? 0 : delta / max;
  return [h, s, max];
}

export function hsvToRgb(h: number, s: number, v: number): [number, number, number] {
  const c = v * s;
  const hh = (((h % 360) + 360) % 360) / 60;
  const x = c * (1 - Math.abs((hh % 2) - 1));
  let r1 = 0;
  let g1 = 0;
  let b1 = 0;
  if (hh < 1) [r1, g1, b1] = [c, x, 0];
  else if (hh < 2) [r1, g1, b1] = [x, c, 0];
  else if (hh < 3) [r1, g1, b1] = [0, c, x];
  else if (hh < 4) [r1, g1, b1] = [0, x, c];
  else if (hh < 5) [r1, g1, b1] = [x, 0, c];
  else [r1, g1, b1] = [c, 0, x];
  const m = v - c;
  return [
    Math.round((r1 + m) * 255),
    Math.round((g1 + m) * 255),
    Math.round((b1 + m) * 255),
  ];
}

export function ReplaySkinColorPanel({ value, onChange }: { value: string; onChange: (value: string) => void }) {
  const [r, g, b] = hexToRgbParts(value);
  const [h, s, v] = rgbToHsv(r, g, b);

  const setHsv = (nextH: number, nextS: number, nextV: number) => {
    const [nr, ng, nb] = hsvToRgb(nextH, nextS, nextV);
    onChange(rgbPartsToHex(nr, ng, nb));
  };

  return (
    <div>
      <div className="mb-3 grid grid-cols-10 gap-1.5">
        {REPLAY_SKIN_PALETTE.map((color) => (
          <button
            key={color}
            type="button"
            onClick={() => onChange(color)}
            className={`aspect-square cursor-pointer rounded-md border transition-transform hover:scale-105 ${
              value.toLowerCase() === color ? "border-white" : "border-white/20"
            }`}
            style={{ backgroundColor: color }}
            title={color}
          />
        ))}
      </div>
      <ReplaySkinColorWheel
        hue={h}
        saturation={s}
        value={v}
        onChange={(nextH, nextS) => setHsv(nextH, nextS, v)}
      />
      <ReplaySkinValueSlider
        hue={h}
        saturation={s}
        value={v}
        onChange={(nextV) => setHsv(h, s, nextV)}
      />
      <div className="mt-3 flex items-center gap-2">
        <span className="h-7 w-7 shrink-0 rounded-md border border-white/30" style={{ backgroundColor: value }} />
        <input
          type="text"
          value={value}
          onChange={(event) => {
            const normalized = normalizeEditableHex(event.target.value);
            if (normalized) onChange(normalized);
          }}
          className="h-7 w-full cursor-text rounded-md border border-osu-b3/50 bg-osu-b5 px-2 font-mono text-[11px] text-osu-c1 outline-none transition-colors focus:border-osu-pink/60"
        />
      </div>
    </div>
  );
}

const COLOR_WHEEL_SIZE = 132;

export function ReplaySkinColorWheel({
  hue,
  saturation,
  value,
  onChange,
}: {
  hue: number;
  saturation: number;
  value: number;
  onChange: (hue: number, saturation: number) => void;
}) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const draggingRef = useRef(false);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const dpr = window.devicePixelRatio || 1;
    const size = COLOR_WHEEL_SIZE;
    canvas.width = size * dpr;
    canvas.height = size * dpr;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const image = ctx.createImageData(size * dpr, size * dpr);
    const data = image.data;
    const center = (size * dpr) / 2;
    const radius = center;
    for (let py = 0; py < size * dpr; py++) {
      for (let px = 0; px < size * dpr; px++) {
        const dx = px - center;
        const dy = py - center;
        const dist = Math.sqrt(dx * dx + dy * dy);
        const idx = (py * size * dpr + px) * 4;
        if (dist > radius) {
          data[idx + 3] = 0;
          continue;
        }
        let angle = Math.atan2(dy, dx) * (180 / Math.PI);
        if (angle < 0) angle += 360;
        const sat = Math.min(1, dist / radius);
        const [r, g, b] = hsvToRgb(angle, sat, 1);
        data[idx] = r;
        data[idx + 1] = g;
        data[idx + 2] = b;
        const edge = radius - dist;
        data[idx + 3] = edge < 1 ? Math.round(edge * 255) : 255;
      }
    }
    ctx.putImageData(image, 0, 0);
  }, []);

  const updateFromEvent = (event: ReactPointerEvent<HTMLDivElement>) => {
    const node = wrapRef.current;
    if (!node) return;
    const rect = node.getBoundingClientRect();
    const cx = rect.width / 2;
    const cy = rect.height / 2;
    const x = event.clientX - rect.left - cx;
    const y = event.clientY - rect.top - cy;
    const radius = Math.min(cx, cy);
    const distance = Math.sqrt(x * x + y * y);
    const sat = Math.max(0, Math.min(1, distance / radius));
    let angle = Math.atan2(y, x) * (180 / Math.PI);
    if (angle < 0) angle += 360;
    onChange(angle, sat);
  };

  const handlePointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    draggingRef.current = true;
    event.currentTarget.setPointerCapture(event.pointerId);
    updateFromEvent(event);
  };

  const handlePointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!draggingRef.current) return;
    updateFromEvent(event);
  };

  const handlePointerUp = (event: ReactPointerEvent<HTMLDivElement>) => {
    draggingRef.current = false;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  };

  const angleRad = (hue * Math.PI) / 180;
  const cursorX = 50 + Math.cos(angleRad) * saturation * 50;
  const cursorY = 50 + Math.sin(angleRad) * saturation * 50;
  const [cr, cg, cb] = hsvToRgb(hue, saturation, value);
  const cursorColor = rgbPartsToHex(cr, cg, cb);

  return (
    <div className="mb-3 flex justify-center">
      <div
        ref={wrapRef}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerCancel={handlePointerUp}
        className="relative touch-none"
        style={{ width: COLOR_WHEEL_SIZE, height: COLOR_WHEEL_SIZE, filter: `brightness(${0.4 + value * 0.6})` }}
      >
        <canvas
          ref={canvasRef}
          style={{ width: COLOR_WHEEL_SIZE, height: COLOR_WHEEL_SIZE, display: "block", borderRadius: "9999px" }}
        />
        <div
          className="pointer-events-none absolute h-3 w-3 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-white shadow-md"
          style={{
            left: `${cursorX}%`,
            top: `${cursorY}%`,
            backgroundColor: cursorColor,
          }}
        />
      </div>
    </div>
  );
}

export function ReplaySkinValueSlider({
  hue,
  saturation,
  value,
  onChange,
}: {
  hue: number;
  saturation: number;
  value: number;
  onChange: (value: number) => void;
}) {
  const [maxR, maxG, maxB] = hsvToRgb(hue, saturation, 1);
  const maxHex = rgbPartsToHex(maxR, maxG, maxB);
  return (
    <label className="flex items-center gap-2 text-[10px] font-semibold text-osu-f1">
      <span className="w-10 shrink-0 uppercase tracking-wider">Bright</span>
      <input
        type="range"
        min={0}
        max={100}
        value={Math.round(value * 100)}
        onChange={(event) => onChange(Number(event.target.value) / 100)}
        className="h-2 flex-1 cursor-pointer appearance-none rounded-full accent-osu-pink"
        style={{ backgroundImage: `linear-gradient(90deg, #000000, ${maxHex})` }}
      />
      <span className="w-8 text-right font-mono text-osu-c1">{Math.round(value * 100)}</span>
    </label>
  );
}
