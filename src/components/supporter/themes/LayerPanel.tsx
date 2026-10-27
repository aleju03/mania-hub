import { useLingui } from "@lingui/react/macro";
import { Reorder } from "framer-motion";
import { ArrowDown, ArrowUp, Copy, Eye, EyeOff, ImagePlus, Plus, Trash2 } from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";

import { CUSTOM_THEME_TEXTURES } from "#custom-themes/inputs";
import {
  layerAssets,
  LAYER_KINDS,
  LAYERS_MAX,
  newLayer,
  newLayerId,
  type Layer,
  type LayerBlend,
  type LayerDoc,
  type LayerFinish,
  type LayerKind,
  type ParticleShape,
} from "../../../lib/custom-theme-layers";
import { InspectorRow, InspectorSection, PanelHeader, ToolButton } from "./EditorChrome";
import { Choice, ColorField, NumberField, Popover } from "./EditorControls";
import { LayerIcon } from "./LayerIcons";

/* The layer editor's panels: the stack on the left (frontmost on top, drag to
   reorder, double-click to rename, right-click for more), the pictures the
   theme holds under it, and the picked layer's settings in the inspector.
   Everything here edits a LayerDoc; the stage turns it into a theme. */

export function useLayerNames() {
  const { t } = useLingui();
  const names: Record<LayerKind, string> = { background: t`Background`, image: t`Image`, particles: t`Particles`, fog: t`Fog`, glow: t`Glow`, stars: t`Stars` };
  const blurbs: Record<LayerKind, string> = {
    background: t`A colour, a gradient or a picture behind everything`,
    image: t`A picture you place, size and turn, that can sway or spin`,
    particles: t`Lots of small things drifting: petals, embers, snow, rain`,
    fog: t`Soft clouds that roll by`,
    glow: t`A light with rays, that can pulse and turn`,
    stars: t`Twinkling points`,
  };
  return { names, blurbs };
}

/* --- Doc edits shared by the panel, the stage and the shortcuts ------------ */

export function patchLayer(doc: LayerDoc, id: string, patch: Partial<Layer>): LayerDoc {
  return { ...doc, layers: doc.layers.map((layer) => (layer.id === id ? ({ ...layer, ...patch } as Layer) : layer)) };
}

export function duplicateLayer(doc: LayerDoc, id: string): { doc: LayerDoc; id: string } | null {
  const at = doc.layers.findIndex((layer) => layer.id === id);
  if (at < 0 || doc.layers.length >= LAYERS_MAX) return null;
  const source = doc.layers[at];
  const copy = { ...source, id: newLayerId(), name: `${source.name} 2`.slice(0, 40) } as Layer;
  return { doc: { ...doc, layers: [...doc.layers.slice(0, at + 1), copy, ...doc.layers.slice(at + 1)] }, id: copy.id };
}

/* Up is toward the front. */
export function moveLayer(doc: LayerDoc, id: string, direction: 1 | -1): LayerDoc {
  const at = doc.layers.findIndex((layer) => layer.id === id);
  const to = at + direction;
  if (at < 0 || to < 0 || to >= doc.layers.length) return doc;
  const layers = [...doc.layers];
  [layers[at], layers[to]] = [layers[to], layers[at]];
  return { ...doc, layers };
}

/* --- The stack --------------------------------------------------------------- */

export function LayersList({ doc, onChange, selected, onSelect, onUpload, uploading, canUpload }: {
  doc: LayerDoc;
  onChange: (doc: LayerDoc) => void;
  selected: string | null;
  onSelect: (id: string | null) => void;
  onUpload: (file: File) => Promise<string | null>;
  uploading: boolean;
  canUpload: boolean;
}) {
  const { t } = useLingui();
  const { names, blurbs } = useLayerNames();
  const [adding, setAdding] = useState(false);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [menu, setMenu] = useState<{ id: string; x: number; y: number } | null>(null);
  const front = [...doc.layers].reverse();
  const full = doc.layers.length >= LAYERS_MAX;
  const pictures = layerAssets(doc);

  const add = (kind: LayerKind, image: string | null = null) => {
    if (full) return;
    const layer = newLayer(kind, names[kind]);
    if (image && layer.kind === "image") layer.image = image;
    onChange({ ...doc, layers: [...doc.layers, layer] });
    onSelect(layer.id);
    setAdding(false);
  };

  useEffect(() => {
    if (!menu) return;
    const close = () => setMenu(null);
    window.addEventListener("pointerdown", close);
    window.addEventListener("blur", close);
    return () => {
      window.removeEventListener("pointerdown", close);
      window.removeEventListener("blur", close);
    };
  }, [menu]);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <PanelHeader title={t`Layers`}>
        <span className="mr-1 font-mono text-[10.5px] text-osu-f1/70">{doc.layers.length}/{LAYERS_MAX}</span>
        <Popover
          open={adding}
          onOpenChange={setAdding}
          align="right"
          className="w-[300px]"
          trigger={
            <ToolButton label={t`Add layer`} onClick={() => setAdding((value) => !value)} disabled={full} tone="accent">
              <Plus size={16} />
            </ToolButton>
          }
        >
          <div className="grid gap-0.5">
            {LAYER_KINDS.map((kind) => (
              <button key={kind} type="button" onClick={() => add(kind)} className="flex cursor-pointer items-start gap-2.5 rounded-lg px-2 py-1.5 text-left transition-colors hover:bg-white/[0.06]">
                <span className="grid h-8 w-8 shrink-0 place-items-center rounded-md bg-black/30 text-osu-pink-light"><LayerIcon kind={kind} className="h-[18px] w-[18px]" /></span>
                <span className="min-w-0">
                  <span className="block text-[12.5px] font-semibold text-white">{names[kind]}</span>
                  <span className="block text-[11px] leading-snug text-osu-f1">{blurbs[kind]}</span>
                </span>
              </button>
            ))}
          </div>
        </Popover>
      </PanelHeader>

      <div className="min-h-0 flex-1 overflow-y-auto p-2">
        <Reorder.Group
          axis="y"
          values={front.map((layer) => layer.id)}
          onReorder={(ids: string[]) => onChange({ ...doc, layers: [...ids].reverse().map((id) => doc.layers.find((layer) => layer.id === id)!) })}
          className="grid gap-0.5"
        >
          {front.map((layer) => (
            <Reorder.Item
              key={layer.id}
              value={layer.id}
              className={`group relative flex h-12 cursor-default items-center gap-3 rounded-lg pl-2 pr-1.5 transition-colors ${selected === layer.id ? "bg-osu-pink/[0.16] text-white" : "text-osu-l2 hover:bg-white/[0.04]"}`}
              onPointerDown={() => onSelect(layer.id)}
              onDoubleClick={() => setRenaming(layer.id)}
              onContextMenu={(event) => {
                event.preventDefault();
                onSelect(layer.id);
                setMenu({ id: layer.id, x: event.clientX, y: event.clientY });
              }}
            >
              {selected === layer.id ? <span aria-hidden className="absolute inset-y-1.5 left-0 w-0.5 rounded-full bg-osu-pink" /> : null}
              <LayerThumb layer={layer} />
              {renaming === layer.id ? (
                <RenameInput
                  value={layer.name}
                  placeholder={names[layer.kind]}
                  onDone={(name) => {
                    setRenaming(null);
                    if (name !== null) onChange(patchLayer(doc, layer.id, { name }));
                  }}
                />
              ) : (
                <span className={`min-w-0 flex-1 truncate text-[13px] ${layer.hidden ? "text-osu-f1/50 line-through decoration-white/20" : "font-medium"}`}>
                  {layer.name || names[layer.kind]}
                </span>
              )}
              <button
                type="button"
                aria-label={layer.hidden ? t`Show` : t`Hide`}
                title={layer.hidden ? t`Show` : t`Hide`}
                onPointerDown={(event) => event.stopPropagation()}
                onClick={() => onChange(patchLayer(doc, layer.id, { hidden: !layer.hidden }))}
                className={`grid h-8 w-8 shrink-0 cursor-pointer place-items-center rounded-md transition-colors hover:bg-white/[0.08] ${layer.hidden ? "text-osu-f1" : "text-osu-f1 opacity-0 group-hover:opacity-100"}`}
              >
                {layer.hidden ? <EyeOff size={15} /> : <Eye size={15} />}
              </button>
            </Reorder.Item>
          ))}
        </Reorder.Group>
        {doc.layers.length === 0 ? <p className="px-3 py-6 text-center text-[11.5px] leading-relaxed text-osu-f1">{t`No layers yet. Add one with +, or drop a picture on the stage.`}</p> : null}
        <button
          type="button"
          onClick={() => onSelect("finish")}
          className={`relative mt-2 flex h-12 w-full cursor-pointer items-center gap-3 rounded-lg pl-2 pr-2.5 text-left transition-colors ${selected === "finish" ? "bg-osu-pink/[0.16] text-white" : "text-osu-l2 hover:bg-white/[0.04]"}`}
        >
          {selected === "finish" ? <span aria-hidden className="absolute inset-y-1.5 left-0 w-0.5 rounded-full bg-osu-pink" /> : null}
          <span className="grid h-8 w-11 place-items-center rounded-md bg-black/30 ring-1 ring-white/[0.06]"><LayerIcon kind="finish" className="h-[18px] w-[18px]" /></span>
          <span className="flex-1 text-[13px] font-medium">{t`Finish`}</span>
          <span className="text-[10.5px] text-osu-f1">{t`on top of all`}</span>
        </button>
      </div>

      <PanelHeader title={t`Pictures`}>
        <span className="mr-1 font-mono text-[10.5px] text-osu-f1/70">{pictures.length}/{CUSTOM_THEME_TEXTURES}</span>
        <label className={`grid h-8 w-8 place-items-center rounded-md ${canUpload && !uploading && pictures.length < CUSTOM_THEME_TEXTURES && !full ? "cursor-pointer text-osu-pink-light hover:bg-white/[0.06]" : "cursor-default text-osu-f1/40"}`} title={t`Add a picture`}>
          <ImagePlus size={16} />
          <input type="file" accept="image/*" className="hidden" disabled={!canUpload || uploading || pictures.length >= CUSTOM_THEME_TEXTURES || full} onChange={(event) => {
            const file = event.target.files?.[0];
            event.target.value = "";
            if (file) void onUpload(file).then((url) => url && add("image", url));
          }} />
        </label>
      </PanelHeader>
      <div className="grid shrink-0 grid-cols-4 gap-2 p-3">
        {Array.from({ length: CUSTOM_THEME_TEXTURES }, (_, index) => {
          const url = pictures[index];
          return url ? (
            <button
              key={url}
              type="button"
              title={t`Place again as a new layer`}
              onClick={() => add("image", url)}
              className="aspect-square cursor-pointer overflow-hidden rounded-md bg-black/30 ring-1 ring-white/[0.06] transition hover:ring-osu-pink/60"
            >
              <img src={url} alt="" className="h-full w-full object-cover" draggable={false} />
            </button>
          ) : (
            <span key={index} className="grid aspect-square place-items-center rounded-md border border-dashed border-white/[0.08] text-[10px] text-osu-f1/40">
              {uploading && index === pictures.length ? "..." : ""}
            </span>
          );
        })}
      </div>

      {menu ? (
        <div
          className="fixed z-[60] w-44 rounded-lg border border-white/[0.08] bg-[#1c1720] p-1 shadow-[0_12px_40px_rgba(0,0,0,0.6)]"
          style={{ left: menu.x, top: menu.y }}
          onPointerDown={(event) => event.stopPropagation()}
        >
          <MenuItem icon={<Copy size={13} />} label={t`Duplicate`} shortcut="Ctrl D" disabled={full} onClick={() => {
            const result = duplicateLayer(doc, menu.id);
            if (result) {
              onChange(result.doc);
              onSelect(result.id);
            }
            setMenu(null);
          }} />
          <MenuItem icon={<ArrowUp size={13} />} label={t`Bring forward`} shortcut="]" onClick={() => { onChange(moveLayer(doc, menu.id, 1)); setMenu(null); }} />
          <MenuItem icon={<ArrowDown size={13} />} label={t`Send backward`} shortcut="[" onClick={() => { onChange(moveLayer(doc, menu.id, -1)); setMenu(null); }} />
          <MenuItem icon={<Eye size={13} />} label={doc.layers.find((layer) => layer.id === menu.id)?.hidden ? t`Show` : t`Hide`} shortcut="H" onClick={() => {
            const layer = doc.layers.find((entry) => entry.id === menu.id);
            if (layer) onChange(patchLayer(doc, layer.id, { hidden: !layer.hidden }));
            setMenu(null);
          }} />
          <div className="my-1 h-px bg-white/[0.06]" />
          <MenuItem icon={<Trash2 size={13} />} label={t`Delete`} shortcut="Del" danger onClick={() => {
            onChange({ ...doc, layers: doc.layers.filter((layer) => layer.id !== menu.id) });
            onSelect(null);
            setMenu(null);
          }} />
        </div>
      ) : null}
    </div>
  );
}

function MenuItem({ icon, label, shortcut, onClick, disabled, danger }: { icon: ReactNode; label: string; shortcut?: string; onClick: () => void; disabled?: boolean; danger?: boolean }) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      className={`flex h-8 w-full cursor-pointer items-center gap-2 rounded-md px-2 text-left text-[12px] transition-colors disabled:cursor-default disabled:opacity-40 ${danger ? "text-rose-300 hover:bg-rose-500/15" : "text-osu-l2 hover:bg-white/[0.06] hover:text-white"}`}
    >
      {icon}
      <span className="flex-1">{label}</span>
      {shortcut ? <span className="font-mono text-[10px] text-osu-f1/70">{shortcut}</span> : null}
    </button>
  );
}

function RenameInput({ value, placeholder, onDone }: { value: string; placeholder: string; onDone: (name: string | null) => void }) {
  const ref = useRef<HTMLInputElement>(null);
  const [text, setText] = useState(value);
  useEffect(() => {
    ref.current?.select();
  }, []);
  return (
    <input
      ref={ref}
      value={text}
      placeholder={placeholder}
      onChange={(event) => setText(event.target.value.slice(0, 40))}
      onPointerDown={(event) => event.stopPropagation()}
      onBlur={() => onDone(text.trim())}
      onKeyDown={(event) => {
        if (event.key === "Enter") onDone(text.trim());
        if (event.key === "Escape") onDone(null);
        event.stopPropagation();
      }}
      className="h-7 min-w-0 flex-1 rounded bg-black/40 px-1.5 text-[12.5px] text-white ring-1 ring-osu-pink/60 focus:outline-none"
    />
  );
}

function LayerThumb({ layer }: { layer: Layer }) {
  const picture = "image" in layer && layer.image && (layer.kind !== "background" || layer.fill === "image") ? layer.image : null;
  const tint = "color" in layer ? layer.color : "#ffffff";
  return (
    <span className="grid h-8 w-11 shrink-0 place-items-center overflow-hidden rounded-md bg-black/30 ring-1 ring-white/[0.06]">
      {picture ? (
        <img src={picture} alt="" className="h-full w-full object-cover" draggable={false} />
      ) : layer.kind === "background" ? (
        <span className="h-full w-full" style={{ background: layer.fill === "solid" ? layer.color : `linear-gradient(${180 - layer.angle}deg, ${layer.color}, ${layer.color2})` }} />
      ) : (
        <span style={{ color: tint }}><LayerIcon kind={layer.kind} className="h-[18px] w-[18px]" /></span>
      )}
    </span>
  );
}

/* --- The inspector --------------------------------------------------------- */

export function LayerInspector({ doc, selected, onChange, onUpload, uploading, canUpload }: {
  doc: LayerDoc;
  selected: string | null;
  onChange: (doc: LayerDoc) => void;
  onUpload: (file: File) => Promise<string | null>;
  uploading: boolean;
  canUpload: boolean;
}) {
  const { t } = useLingui();
  const { names } = useLayerNames();
  if (selected === "finish") return <FinishSettings finish={doc.finish} onChange={(finish) => onChange({ ...doc, finish })} />;
  const layer = doc.layers.find((entry) => entry.id === selected);
  if (!layer) {
    return (
      <div className="grid place-items-center px-6 py-14 text-center">
        <LayerIcon kind="image" className="mb-3 h-8 w-8 text-osu-f1/40" />
        <p className="text-[12px] leading-relaxed text-osu-f1">{t`Pick a layer to change it, or click a picture on the stage.`}</p>
      </div>
    );
  }
  return (
    <div>
      <div className="flex h-16 items-center gap-3 border-b border-white/[0.06] px-4">
        <span className="grid h-9 w-9 place-items-center rounded-lg bg-osu-pink/15 text-osu-pink-light"><LayerIcon kind={layer.kind} className="h-5 w-5" /></span>
        <div className="min-w-0 flex-1">
          <div className="truncate text-[14px] font-semibold text-white">{layer.name || names[layer.kind]}</div>
          <div className="text-[11.5px] text-osu-f1">{names[layer.kind]}</div>
        </div>
      </div>
      <LayerSettings layer={layer} doc={doc} onPatch={(patch) => onChange(patchLayer(doc, layer.id, patch))} onUpload={onUpload} uploading={uploading} canUpload={canUpload} />
    </div>
  );
}

function LayerSettings({ layer, doc, onPatch, onUpload, uploading, canUpload }: {
  layer: Layer;
  doc: LayerDoc;
  onPatch: (patch: Partial<Layer>) => void;
  onUpload: (file: File) => Promise<string | null>;
  uploading: boolean;
  canUpload: boolean;
}) {
  const { t } = useLingui();
  const values = layer as unknown as Record<string, number & string>;
  const blends: { id: LayerBlend; label: string }[] = [
    { id: "normal", label: t`Normal` },
    { id: "add", label: t`Light` },
    { id: "screen", label: t`Screen` },
    { id: "multiply", label: t`Darken` },
  ];
  type Num = { scale?: number; unit?: string; decimals?: number };
  const n = (key: string, label: string, min: number, max: number, step: number, show: Num = {}) => (
    <NumberField key={key} label={label} value={values[key]} min={min} max={max} step={step} onChange={(value) => onPatch({ [key]: value } as Partial<Layer>)} {...show} />
  );
  const pct: Num = { scale: 100, unit: "%" };
  const deg: Num = { unit: "°" };
  const c = (key: string, label: string) => (
    <ColorField key={key} bar value={values[key]} onChange={(value) => onPatch({ [key]: value } as Partial<Layer>)} label={label} />
  );
  const picture = (
    <InspectorRow label={t`Picture`}>
      <ImagePick value={"image" in layer ? layer.image : null} doc={doc} onChange={(image) => onPatch({ image } as Partial<Layer>)} onUpload={onUpload} uploading={uploading} canUpload={canUpload} />
    </InspectorRow>
  );

  let sections: ReactNode = null;
  switch (layer.kind) {
    case "background":
      sections = (
        <InspectorSection title={t`Fill`}>
          <InspectorRow label={t`Type`}>
            <Choice value={layer.fill} onChange={(fill) => onPatch({ fill })} options={[{ id: "solid", label: t`Colour` }, { id: "linear", label: t`Linear` }, { id: "radial", label: t`Round` }, { id: "image", label: t`Picture` }]} />
          </InspectorRow>
          {layer.fill === "image" ? (
            <>
              {picture}
              {n("zoom", t`Zoom`, 1, 4, 0.01, { unit: "x", decimals: 2 })}
              {n("x", t`Pan across`, -1, 1, 0.01, pct)}
              {n("y", t`Pan down`, -1, 1, 0.01, pct)}
              {n("brightness", t`Brightness`, 0, 1.5, 0.01, pct)}
            </>
          ) : (
            <>
              {c("color", layer.fill === "solid" ? t`Colour` : t`From`)}
              {layer.fill !== "solid" ? c("color2", t`To`) : null}
              {layer.fill === "linear" ? n("angle", t`Angle`, 0, 360, 1, deg) : null}
              {layer.fill === "radial" ? <>{n("x", t`Centre across`, -1, 1, 0.01, pct)}{n("y", t`Centre up`, -1, 1, 0.01, pct)}</> : null}
            </>
          )}
        </InspectorSection>
      );
      break;
    case "image":
      sections = (
        <>
          <InspectorSection title={t`Picture`}>{picture}{n("brightness", t`Brightness`, 0, 1.5, 0.01, pct)}</InspectorSection>
          <InspectorSection title={t`Transform`}>
            {n("x", t`X`, -2, 2, 0.001, { scale: 100, decimals: 1 })}
            {n("y", t`Y`, -1.5, 1.5, 0.001, { scale: 100, decimals: 1 })}
            {n("size", t`Size`, 0.02, 3, 0.005, pct)}
            {n("angle", t`Rotation`, -180, 180, 1, deg)}
          </InspectorSection>
          <InspectorSection title={t`Motion`}>
            {n("spin", t`Spin`, -0.5, 0.5, 0.005, { unit: "/s", decimals: 3 })}
            {n("sway", t`Sway`, 0, 0.2, 0.001, { scale: 100, decimals: 1 })}
            {n("swaySpeed", t`Sway speed`, 0, 3, 0.01, { decimals: 2 })}
          </InspectorSection>
        </>
      );
      break;
    case "particles": {
      const shapes: { id: ParticleShape; label: string }[] = [
        { id: "dot", label: t`Dot` },
        { id: "soft", label: t`Soft` },
        { id: "ring", label: t`Ring` },
        { id: "streak", label: t`Streak` },
        { id: "image", label: t`Picture` },
      ];
      sections = (
        <>
          <InspectorSection title={t`Look`}>
            <InspectorRow label={t`Shape`}><Choice value={layer.shape} onChange={(shape) => onPatch({ shape })} options={shapes} /></InspectorRow>
            {layer.shape === "image" ? picture : null}
            {c("color", t`Colour`)}
            {c("color2", t`Second colour`)}
            {n("size", t`Size`, 0.02, 0.45, 0.005, pct)}
            {n("sizeVariety", t`Size variety`, 0, 1, 0.01, pct)}
            {n("twinkle", t`Twinkle`, 0, 1, 0.01, pct)}
          </InspectorSection>
          <InspectorSection title={t`Amount`}>
            {n("amount", t`Fill`, 0, 1, 0.01, pct)}
            {n("scale", t`Grid`, 2, 40, 0.1, { decimals: 1 })}
          </InspectorSection>
          <InspectorSection title={t`Motion`}>
            {n("speed", t`Speed`, 0, 0.6, 0.001, { scale: 100, decimals: 1 })}
            {n("direction", t`Direction`, 0, 360, 1, deg)}
            {n("wander", t`Wander`, 0, 1, 0.01, pct)}
          </InspectorSection>
        </>
      );
      break;
    }
    case "fog":
      sections = (
        <>
          <InspectorSection title={t`Look`}>
            {c("color", t`Colour`)}
            {n("density", t`Density`, 0, 1, 0.01, pct)}
            {n("softness", t`Softness`, 0.05, 1, 0.01, pct)}
            {n("scale", t`Scale`, 0.3, 6, 0.01, { decimals: 2 })}
            {n("low", t`Keep low`, 0, 1, 0.01, pct)}
          </InspectorSection>
          <InspectorSection title={t`Motion`}>
            {n("speed", t`Speed`, 0, 0.5, 0.001, { scale: 100, decimals: 1 })}
            {n("direction", t`Direction`, 0, 360, 1, deg)}
          </InspectorSection>
        </>
      );
      break;
    case "glow":
      sections = (
        <>
          <InspectorSection title={t`Light`}>
            {c("color", t`Colour`)}
            {n("radius", t`Size`, 0.01, 1, 0.005, pct)}
            {n("x", t`X`, -2, 2, 0.001, { scale: 100, decimals: 1 })}
            {n("y", t`Y`, -1.5, 1.5, 0.001, { scale: 100, decimals: 1 })}
          </InspectorSection>
          <InspectorSection title={t`Rays`}>
            {n("rays", t`Strength`, 0, 1, 0.01, pct)}
            {n("rayCount", t`Count`, 2, 40, 1)}
            {n("spin", t`Spin`, -0.5, 0.5, 0.005, { unit: "/s", decimals: 3 })}
          </InspectorSection>
          <InspectorSection title={t`Pulse`}>
            {n("pulse", t`Strength`, 0, 1, 0.01, pct)}
            {n("pulseSpeed", t`Speed`, 0, 4, 0.01, { decimals: 2 })}
          </InspectorSection>
        </>
      );
      break;
    case "stars":
      sections = (
        <InspectorSection title={t`Stars`}>
          {c("color", t`Colour`)}
          {n("density", t`Amount`, 0.01, 0.6, 0.005, pct)}
          {n("scale", t`Grid`, 10, 200, 1)}
          {n("brightness", t`Brightness`, 0, 2, 0.01, pct)}
        </InspectorSection>
      );
      break;
  }

  return (
    <>
      {sections}
      <InspectorSection title={t`Layer`}>
        {n("opacity", t`Opacity`, 0, 1, 0.01, pct)}
        <InspectorRow label={t`Blend`}><Choice value={layer.blend} onChange={(blend) => onPatch({ blend })} options={blends} /></InspectorRow>
      </InspectorSection>
      <InspectorSection title={t`Depth`}>
        {n("depth", t`Scroll depth`, -1, 1, 0.01, pct)}
        {n("follow", t`Follow pointer`, 0, 1, 0.01, pct)}
      </InspectorSection>
    </>
  );
}

function ImagePick({ value, doc, onChange, onUpload, uploading, canUpload }: {
  value: string | null;
  doc: LayerDoc;
  onChange: (url: string) => void;
  onUpload: (file: File) => Promise<string | null>;
  uploading: boolean;
  canUpload: boolean;
}) {
  const { t } = useLingui();
  const used = layerAssets(doc);
  // a new picture fits under the four, or replaces one only this layer uses
  const users = value ? doc.layers.filter((layer) => "image" in layer && layer.image === value).length : 0;
  const room = used.length < CUSTOM_THEME_TEXTURES || (value !== null && used.includes(value) && users === 1);
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {used.map((url) => (
        <button
          key={url}
          type="button"
          onClick={() => onChange(url)}
          className={`h-9 w-9 cursor-pointer overflow-hidden rounded-md ring-2 transition ${url === value ? "ring-osu-pink" : "ring-transparent hover:ring-white/30"}`}
        >
          <img src={url} alt="" className="h-full w-full object-cover" draggable={false} />
        </button>
      ))}
      <label className={`grid h-9 w-9 place-items-center rounded-md border border-dashed ${canUpload && room && !uploading ? "cursor-pointer border-white/20 text-osu-l2 hover:border-osu-pink/60 hover:text-white" : "cursor-default border-white/[0.08] text-osu-f1/40"}`} title={room ? t`Upload` : t`A theme holds up to four pictures.`}>
        {uploading ? <span className="text-[10px]">...</span> : <Plus size={14} />}
        <input type="file" accept="image/*" className="hidden" disabled={!canUpload || !room || uploading} onChange={(event) => {
          const file = event.target.files?.[0];
          event.target.value = "";
          if (file) void onUpload(file).then((url) => url && onChange(url));
        }} />
      </label>
    </div>
  );
}

function FinishSettings({ finish, onChange }: { finish: LayerFinish; onChange: (finish: LayerFinish) => void }) {
  const { t } = useLingui();
  const n = (key: keyof LayerFinish, label: string, min: number, max: number, step: number, scale = 100, unit = "%") => (
    <NumberField label={label} value={finish[key] as number} min={min} max={max} step={step} onChange={(value) => onChange({ ...finish, [key]: value })} scale={scale} unit={unit} />
  );
  return (
    <div>
      <div className="flex h-16 items-center gap-3 border-b border-white/[0.06] px-4">
        <span className="grid h-9 w-9 place-items-center rounded-lg bg-osu-pink/15 text-osu-pink-light"><LayerIcon kind="finish" className="h-5 w-5" /></span>
        <div>
          <div className="text-[14px] font-semibold text-white">{t`Finish`}</div>
          <div className="text-[11.5px] text-osu-f1">{t`Applies on top of every layer`}</div>
        </div>
      </div>
      <InspectorSection title={t`Colour`}>
        {n("exposure", t`Brightness`, 0.2, 2, 0.01)}
        {n("saturation", t`Saturation`, 0, 2, 0.01)}
        <ColorField bar value={finish.tint} onChange={(tint) => onChange({ ...finish, tint })} label={t`Tint`} />
        {n("tintAmount", t`Tint strength`, 0, 1, 0.01)}
      </InspectorSection>
      <InspectorSection title={t`Effects`}>
        {n("vignette", t`Vignette`, 0, 1, 0.01)}
        {n("grain", t`Grain`, 0, 0.2, 0.001, 500)}
        {n("scanlines", t`Scanlines`, 0, 1, 0.01)}
      </InspectorSection>
    </div>
  );
}
