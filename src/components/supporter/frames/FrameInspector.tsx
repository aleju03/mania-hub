import { useLingui } from "@lingui/react/macro";
import { useEffect, useRef, type ReactNode } from "react";

import {
  AVATAR_RADIUS,
  AVATAR_SIZE,
  DOC_CENTRE,
  DOC_SIZE,
  FONTS,
  LOOP_SECONDS,
  identity,
  type BoardId,
  type Effects,
  type Fill,
  type FillKind,
  type Layer,
  type Motion,
  type MotionKey,
  type MotionKind,
  type PathLayer,
  type ShapeLayer,
  type TextLayer,
} from "../../../lib/frame-editor/doc";
import { Switch } from "../../ui/Switch";
import { InspectorRow, InspectorSection } from "../themes/EditorChrome";
import { Choice, NumberField } from "../themes/EditorControls";
import { FontPicker, ShapeIcon, Swatch } from "./FrameTools";

/* The selected layer's settings: where it sits, what it is (shape, text,
   picture, paint), its effects, its repeat round the avatar, colour
   adjustments and how it moves in the loop. */

type Patch = (patch: Partial<Layer>, merge?: string) => void;

function SmallButton({ onClick, children, disabled }: { onClick: () => void; children: ReactNode; disabled?: boolean }) {
  return (
    <button type="button" disabled={disabled} onClick={onClick} className="h-8 shrink-0 cursor-pointer rounded-md bg-white/[0.06] px-2.5 text-[11.5px] font-semibold text-osu-l2 transition-colors hover:bg-white/[0.1] hover:text-white disabled:cursor-default disabled:opacity-40">
      {children}
    </button>
  );
}

function FillEditor({ fill, onChange, merge }: { fill: Fill; onChange: (fill: Fill, merge?: string) => void; merge: string }) {
  const { t } = useLingui();
  return (
    <>
      <Choice<FillKind>
        value={fill.kind}
        onChange={(kind) => onChange({ ...fill, kind })}
        options={[{ id: "solid", label: t`Solid` }, { id: "linear", label: t`Linear` }, { id: "radial", label: t`Radial` }, { id: "conic", label: t`Sweep` }]}
      />
      <div className="flex items-center gap-2">
        <Swatch value={fill.color} onChange={(color) => onChange({ ...fill, color }, `${merge}:c1`)} label={t`Colour`} />
        {fill.kind !== "solid" ? (
          <>
            <Swatch value={fill.color2} onChange={(color2) => onChange({ ...fill, color2 }, `${merge}:c2`)} label={t`Second colour`} />
            <button type="button" onClick={() => onChange({ ...fill, color: fill.color2, color2: fill.color })} className="cursor-pointer text-[11.5px] text-osu-f1 hover:text-white">{t`Swap`}</button>
          </>
        ) : null}
      </div>
      {fill.kind === "linear" || fill.kind === "conic" ? (
        <NumberField label={t`Angle`} value={fill.angle} min={-180} max={180} step={1} unit="°" onChange={(angle) => onChange({ ...fill, angle }, `${merge}:angle`)} />
      ) : null}
    </>
  );
}

export type InspectorAction = "flipX" | "flipY" | "centre" | "clearPaint" | "rasterize" | "addMask" | "deleteMask" | "toggleMask" | "applyMask" | "resetDistort" | "ungroup";

export interface Keyframes {
  scrub: number;
  activeKey: string | null;
  onPick: (key: MotionKey | null) => void;
  onAdd: () => void;
}

export function LayerInspector({ layer, board, onPatch, onAction, focusText, onFocusedText, maskTarget, onMaskTarget, keyframes }: {
  layer: Layer | null;
  board: BoardId;
  onPatch: Patch;
  onAction: (action: InspectorAction) => void;
  focusText: boolean;
  onFocusedText: () => void;
  maskTarget: boolean;
  onMaskTarget: (mask: boolean) => void;
  keyframes: Keyframes;
}) {
  const { t } = useLingui();
  if (!layer) {
    return <p className="px-4 py-8 text-center text-[12px] leading-relaxed text-osu-f1">{t`Pick a layer to change it. Its position, effects and motion show here.`}</p>;
  }
  const id = layer.id;
  const tf = layer.transform;
  const setTransform = (patch: Partial<Layer["transform"]>, key: string) => onPatch({ transform: { ...tf, ...patch } }, `${id}:tf:${key}`);
  const setEffects = <K extends keyof Effects>(key: K, patch: Partial<Effects[K]>, merge?: string) => onPatch({ effects: { ...layer.effects, [key]: { ...layer.effects[key], ...patch } } }, merge ? `${id}:fx:${key}:${merge}` : undefined);
  const fx = layer.effects;

  return (
    <div>
      {layer.locked ? <p className="border-b border-white/[0.06] bg-amber-300/[0.07] px-4 py-2 text-[11.5px] text-amber-200">{t`This layer is locked. Unlock it in the layer list to paint or move it.`}</p> : null}

      {layer.kind === "shape" ? <ShapeSection layer={layer} board={board} onPatch={onPatch} /> : null}
      {layer.kind === "path" ? <PathSection layer={layer} onPatch={onPatch} /> : null}
      {layer.kind === "text" ? <TextSection layer={layer} onPatch={onPatch} focus={focusText} onFocused={onFocusedText} /> : null}
      {layer.kind === "image" ? (
        <InspectorSection title={t`Picture`}>
          <p className="text-[11.5px] text-osu-f1">{t`Resize and turn it with the move tool's handles, or below.`}</p>
          <div className="flex flex-wrap gap-1.5">
            <SmallButton onClick={() => onAction("rasterize")}>{t`Turn into paint`}</SmallButton>
          </div>
        </InspectorSection>
      ) : null}
      {layer.kind === "paint" ? (
        <InspectorSection title={t`Paint`}>
          <p className="text-[11.5px] text-osu-f1">{t`Paint on it with the brush, fill it with the bucket, or erase.`}</p>
          <div className="flex flex-wrap gap-1.5">
            <SmallButton onClick={() => onAction("clearPaint")}>{t`Clear it`}</SmallButton>
          </div>
        </InspectorSection>
      ) : null}

      {layer.kind === "group" ? (
        <InspectorSection title={t`Group`}>
          <p className="text-[11.5px] text-osu-f1">{t`${layer.children.length} layers drawn as one. Its opacity, blend, mask, effects, repeat and motion apply to all of them. Move, turn and resize it like any layer.`}</p>
          <div className="flex flex-wrap gap-1.5">
            <SmallButton onClick={() => onAction("centre")}>{t`Centre`}</SmallButton>
            <SmallButton onClick={() => onAction("flipX")}>{t`Flip ⇆`}</SmallButton>
            <SmallButton onClick={() => onAction("flipY")}>{t`Flip ⇅`}</SmallButton>
            <SmallButton onClick={() => onAction("ungroup")}>{t`Ungroup`}</SmallButton>
          </div>
        </InspectorSection>
      ) : null}

      {layer.kind === "group" ? null : <InspectorSection title={t`Position`}>
        <div className="grid grid-cols-2 gap-1.5">
          <NumberField label="X" value={Math.round(tf.x - DOC_CENTRE)} min={-DOC_SIZE} max={DOC_SIZE} step={1} unit="px" onChange={(x) => setTransform({ x: x + DOC_CENTRE }, "x")} />
          <NumberField label="Y" value={Math.round(tf.y - DOC_CENTRE)} min={-DOC_SIZE} max={DOC_SIZE} step={1} unit="px" onChange={(y) => setTransform({ y: y + DOC_CENTRE }, "y")} />
          <NumberField label="W" value={Math.abs(tf.scaleX)} min={0.05} max={5} step={0.01} scale={100} unit="%" onChange={(value) => setTransform({ scaleX: value * Math.sign(tf.scaleX || 1) }, "sx")} />
          <NumberField label="H" value={Math.abs(tf.scaleY)} min={0.05} max={5} step={0.01} scale={100} unit="%" onChange={(value) => setTransform({ scaleY: value * Math.sign(tf.scaleY || 1) }, "sy")} />
        </div>
        <NumberField label={t`Turn`} value={tf.rotation} min={-180} max={180} step={1} unit="°" onChange={(rotation) => setTransform({ rotation }, "r")} />
        <div className="grid grid-cols-2 gap-1.5">
          <NumberField label={t`Slant X`} value={tf.skewX ?? 0} min={-70} max={70} step={1} unit="°" onChange={(skewX) => setTransform({ skewX }, "kx")} />
          <NumberField label={t`Slant Y`} value={tf.skewY ?? 0} min={-70} max={70} step={1} unit="°" onChange={(skewY) => setTransform({ skewY }, "ky")} />
        </div>
        {layer.distort ? <p className="text-[11px] text-osu-f1">{t`In perspective. Drag its corners with the move tool's Perspective mode.`}</p> : null}
        <div className="flex flex-wrap gap-1.5">
          <SmallButton onClick={() => onAction("centre")}>{t`Centre`}</SmallButton>
          <SmallButton onClick={() => onAction("flipX")}>{t`Flip ⇆`}</SmallButton>
          <SmallButton onClick={() => onAction("flipY")}>{t`Flip ⇅`}</SmallButton>
          <SmallButton onClick={() => onPatch({ transform: identity() })}>{t`Reset`}</SmallButton>
          {layer.distort ? <SmallButton onClick={() => onAction("resetDistort")}>{t`Undo perspective`}</SmallButton> : null}
        </div>
      </InspectorSection>}

      <InspectorSection title={t`Mask`} defaultOpen={!!layer.mask}>
        {layer.mask ? (
          <>
            <Choice value={maskTarget ? "mask" : "layer"} onChange={(value) => onMaskTarget(value === "mask")} options={[{ id: "layer", label: t`Paint the layer` }, { id: "mask", label: t`Paint the mask` }]} />
            <InspectorRow label={t`On`}><Switch checked={layer.mask.enabled} onChange={() => onAction("toggleMask")} label={t`Mask on`} /></InspectorRow>
            <p className="text-[11px] leading-relaxed text-osu-f1">{t`On the mask the brush hides the layer and the eraser brings it back. The gradient fades it out from where you start dragging.`}</p>
            <div className="flex flex-wrap gap-1.5">
              {layer.kind === "paint" ? <SmallButton onClick={() => onAction("applyMask")}>{t`Apply`}</SmallButton> : null}
              <SmallButton onClick={() => onAction("deleteMask")}>{t`Delete`}</SmallButton>
            </div>
          </>
        ) : (
          <>
            <p className="text-[11px] leading-relaxed text-osu-f1">{t`Hides parts of the layer without erasing them. With a selection, the mask shows only what's selected.`}</p>
            <div className="flex"><SmallButton onClick={() => onAction("addMask")}>{t`Add a mask`}</SmallButton></div>
          </>
        )}
      </InspectorSection>

      <InspectorSection title={t`Repeat round the avatar`} defaultOpen={fx.repeat.count > 1 || fx.repeat.mirror}>
        <NumberField label={t`Copies`} value={fx.repeat.count} min={1} max={36} step={1} onChange={(count) => setEffects("repeat", { count }, "count")} />
        <InspectorRow label={t`Mirror`}>
          <Switch checked={fx.repeat.mirror} onChange={(mirror) => setEffects("repeat", { mirror })} label={t`Mirror`} />
        </InspectorRow>
        <p className="text-[11px] leading-relaxed text-osu-f1">{t`Draws the layer again, evenly spaced round the avatar's centre. Mirror adds a flipped copy of each.`}</p>
      </InspectorSection>

      <EffectSection title={t`Outline`} on={fx.stroke.on} onToggle={(on) => setEffects("stroke", { on })}>
        <InspectorRow label={t`Colour`}><Swatch value={fx.stroke.color} onChange={(color) => setEffects("stroke", { color }, "color")} label={t`Outline colour`} /></InspectorRow>
        <NumberField label={t`Width`} value={fx.stroke.width} min={1} max={40} step={1} unit="px" onChange={(width) => setEffects("stroke", { width }, "width")} />
        <NumberField label={t`Opacity`} value={fx.stroke.opacity} min={0} max={1} step={0.01} scale={100} unit="%" onChange={(opacity) => setEffects("stroke", { opacity }, "opacity")} />
      </EffectSection>

      <EffectSection title={t`Glow`} on={fx.glow.on} onToggle={(on) => setEffects("glow", { on })}>
        <InspectorRow label={t`Colour`}><Swatch value={fx.glow.color} onChange={(color) => setEffects("glow", { color }, "color")} label={t`Glow colour`} /></InspectorRow>
        <NumberField label={t`Size`} value={fx.glow.size} min={1} max={120} step={1} unit="px" onChange={(size) => setEffects("glow", { size }, "size")} />
        <NumberField label={t`Opacity`} value={fx.glow.opacity} min={0} max={1} step={0.01} scale={100} unit="%" onChange={(opacity) => setEffects("glow", { opacity }, "opacity")} />
        <NumberField label={t`Strength`} value={fx.glow.strength} min={1} max={4} step={1} onChange={(strength) => setEffects("glow", { strength }, "strength")} />
      </EffectSection>

      <EffectSection title={t`Shadow`} on={fx.shadow.on} onToggle={(on) => setEffects("shadow", { on })}>
        <InspectorRow label={t`Colour`}><Swatch value={fx.shadow.color} onChange={(color) => setEffects("shadow", { color }, "color")} label={t`Shadow colour`} /></InspectorRow>
        <NumberField label={t`Blur`} value={fx.shadow.blur} min={0} max={80} step={1} unit="px" onChange={(blur) => setEffects("shadow", { blur }, "blur")} />
        <NumberField label={t`Distance`} value={fx.shadow.distance} min={0} max={80} step={1} unit="px" onChange={(distance) => setEffects("shadow", { distance }, "distance")} />
        <NumberField label={t`Angle`} value={fx.shadow.angle} min={-180} max={180} step={1} unit="°" onChange={(angle) => setEffects("shadow", { angle }, "angle")} />
        <NumberField label={t`Opacity`} value={fx.shadow.opacity} min={0} max={1} step={0.01} scale={100} unit="%" onChange={(opacity) => setEffects("shadow", { opacity }, "opacity")} />
      </EffectSection>

      <EffectSection title={t`Colour overlay`} on={fx.overlay.on} onToggle={(on) => setEffects("overlay", { on })}>
        <FillEditor fill={fx.overlay.fill} onChange={(fill, merge) => setEffects("overlay", { fill }, merge)} merge="overlay" />
        <NumberField label={t`Opacity`} value={fx.overlay.opacity} min={0} max={1} step={0.01} scale={100} unit="%" onChange={(opacity) => setEffects("overlay", { opacity }, "opacity")} />
        <p className="text-[11px] leading-relaxed text-osu-f1">{t`Paints over the layer, keeping its shape. Gradients run across the whole canvas, so a sweep turns round the avatar.`}</p>
      </EffectSection>

      <InspectorSection title={t`Adjust`} defaultOpen={false}>
        <NumberField label={t`Hue`} value={fx.adjust.hue} min={-180} max={180} step={1} unit="°" onChange={(hue) => setEffects("adjust", { hue }, "hue")} />
        <NumberField label={t`Saturation`} value={fx.adjust.saturation} min={0} max={300} step={1} unit="%" onChange={(saturation) => setEffects("adjust", { saturation }, "sat")} />
        <NumberField label={t`Brightness`} value={fx.adjust.brightness} min={0} max={300} step={1} unit="%" onChange={(brightness) => setEffects("adjust", { brightness }, "bright")} />
        <NumberField label={t`Contrast`} value={fx.adjust.contrast} min={0} max={300} step={1} unit="%" onChange={(contrast) => setEffects("adjust", { contrast }, "contrast")} />
        <NumberField label={t`Blur`} value={fx.adjust.blur} min={0} max={40} step={0.5} decimals={1} unit="px" onChange={(blur) => setEffects("adjust", { blur }, "blur")} />
      </InspectorSection>

      <MotionSection motion={layer.motion} keyframes={keyframes} onChange={(motion, merge) => onPatch({ motion }, merge ? `${id}:motion:${merge}` : undefined)} />
    </div>
  );
}

function EffectSection({ title, on, onToggle, children }: { title: string; on: boolean; onToggle: (on: boolean) => void; children: ReactNode }) {
  return (
    <InspectorSection title={title} defaultOpen={on} right={<Switch checked={on} onChange={onToggle} label={title} />}>
      <div className={`grid gap-1.5 ${on ? "" : "pointer-events-none opacity-40"}`}>{children}</div>
    </InspectorSection>
  );
}

function ShapeSection({ layer, board, onPatch }: { layer: ShapeLayer; board: BoardId; onPatch: Patch }) {
  const { t } = useLingui();
  const id = layer.id;
  const set = (patch: Partial<ShapeLayer>, merge?: string) => onPatch(patch, merge ? `${id}:shape:${merge}` : undefined);
  const outlined = layer.style === "outline" || layer.shape === "line" || layer.shape === "arc";
  const hug = () => {
    const gap = 6;
    const width = outlined ? layer.lineWidth : 0;
    const size = AVATAR_SIZE + gap * 2 + width;
    onPatch({
      width: size,
      height: size,
      radius: board === "round" ? 0 : AVATAR_RADIUS + gap + width / 2,
      shape: board === "round" && layer.shape === "rect" ? "ellipse" : layer.shape,
      transform: identity(),
    } as Partial<ShapeLayer>);
  };
  return (
    <InspectorSection title={t`Shape`}>
      <div className="flex flex-wrap gap-1">
        {(["rect", "ellipse", "polygon", "star", "line", "arc"] as const).map((kind) => (
          <button
            key={kind}
            type="button"
            aria-pressed={layer.shape === kind}
            onClick={() => set({ shape: kind, style: kind === "line" || kind === "arc" ? "outline" : layer.style })}
            className={`grid h-8 w-9 cursor-pointer place-items-center rounded-md transition-colors ${layer.shape === kind ? "bg-osu-pink/20 text-osu-pink-light" : "bg-black/30 text-osu-f1 hover:text-white"}`}
          >
            <ShapeIcon kind={kind} size={15} />
          </button>
        ))}
      </div>
      {layer.shape !== "line" && layer.shape !== "arc" ? (
        <Choice value={layer.style} onChange={(style) => set({ style })} options={[{ id: "fill", label: t`Fill` }, { id: "outline", label: t`Outline` }]} />
      ) : null}
      <div className="grid grid-cols-2 gap-1.5">
        <NumberField label={layer.shape === "line" ? t`Length` : "W"} value={layer.width} min={1} max={DOC_SIZE * 1.5} step={1} unit="px" onChange={(width) => set({ width }, "w")} />
        {layer.shape !== "line" ? <NumberField label="H" value={layer.height} min={1} max={DOC_SIZE * 1.5} step={1} unit="px" onChange={(height) => set({ height }, "h")} /> : null}
      </div>
      {layer.shape === "rect" ? <NumberField label={t`Corners`} value={layer.radius} min={0} max={Math.min(layer.width, layer.height) / 2} step={1} unit="px" onChange={(radius) => set({ radius }, "radius")} /> : null}
      {layer.shape === "polygon" || layer.shape === "star" ? <NumberField label={layer.shape === "star" ? t`Points` : t`Sides`} value={layer.sides} min={3} max={24} step={1} onChange={(sides) => set({ sides }, "sides")} /> : null}
      {layer.shape === "star" ? <NumberField label={t`Inner`} value={layer.inner} min={0.05} max={0.95} step={0.01} scale={100} unit="%" onChange={(inner) => set({ inner }, "inner")} /> : null}
      {layer.shape === "arc" ? <NumberField label={t`Sweep`} value={layer.sweep} min={1} max={360} step={1} unit="°" onChange={(sweep) => set({ sweep }, "sweep")} /> : null}
      {outlined ? (
        <>
          <NumberField label={t`Line`} value={layer.lineWidth} min={1} max={160} step={1} unit="px" onChange={(lineWidth) => set({ lineWidth }, "lw")} />
          <div className="grid grid-cols-2 gap-1.5">
            <NumberField label={t`Dash`} value={layer.dash} min={0} max={200} step={1} unit="px" onChange={(dash) => set({ dash }, "dash")} />
            <NumberField label={t`Gap`} value={layer.gap} min={0} max={200} step={1} unit="px" onChange={(gap) => set({ gap }, "gap")} />
          </div>
          <Choice value={layer.cap} onChange={(cap) => set({ cap })} options={[{ id: "round", label: t`Round ends` }, { id: "butt", label: t`Square ends` }]} />
        </>
      ) : null}
      <FillEditor fill={layer.fill} onChange={(fill, merge) => set({ fill }, merge)} merge="fill" />
      <div className="flex flex-wrap gap-1.5 pt-1">
        <SmallButton onClick={hug}>{t`Fit round the avatar`}</SmallButton>
      </div>
    </InspectorSection>
  );
}

function PathSection({ layer, onPatch }: { layer: PathLayer; onPatch: Patch }) {
  const { t } = useLingui();
  const set = (patch: Partial<PathLayer>, merge?: string) => onPatch(patch, merge ? `${layer.id}:path:${merge}` : undefined);
  const outlined = layer.style === "outline" || !layer.closed;
  return (
    <InspectorSection title={t`Path`}>
      <p className="text-[11.5px] text-osu-f1">{t`Edit its points with the pen. Drag a point to move it, drag a handle to bend the curve.`}</p>
      <InspectorRow label={t`Closed`}><Switch checked={layer.closed} onChange={(closed) => set({ closed })} label={t`Closed`} /></InspectorRow>
      {layer.closed ? <Choice value={layer.style} onChange={(style) => set({ style })} options={[{ id: "fill", label: t`Fill` }, { id: "outline", label: t`Outline` }]} /> : null}
      {outlined ? (
        <>
          <NumberField label={t`Line`} value={layer.lineWidth} min={1} max={160} step={1} unit="px" onChange={(lineWidth) => set({ lineWidth }, "lw")} />
          <div className="grid grid-cols-2 gap-1.5">
            <NumberField label={t`Dash`} value={layer.dash} min={0} max={200} step={1} unit="px" onChange={(dash) => set({ dash }, "dash")} />
            <NumberField label={t`Gap`} value={layer.gap} min={0} max={200} step={1} unit="px" onChange={(gap) => set({ gap }, "gap")} />
          </div>
          <Choice value={layer.cap} onChange={(cap) => set({ cap })} options={[{ id: "round", label: t`Round ends` }, { id: "butt", label: t`Square ends` }]} />
        </>
      ) : null}
      <FillEditor fill={layer.fill} onChange={(fill, merge) => set({ fill }, merge)} merge="fill" />
    </InspectorSection>
  );
}

function TextSection({ layer, onPatch, focus, onFocused }: { layer: TextLayer; onPatch: Patch; focus: boolean; onFocused: () => void }) {
  const { t } = useLingui();
  const id = layer.id;
  const set = (patch: Partial<TextLayer>, merge?: string) => onPatch(patch, merge ? `${id}:text:${merge}` : undefined);
  const area = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    if (!focus) return;
    area.current?.focus();
    area.current?.select();
    onFocused();
  }, [focus]); // eslint-disable-line react-hooks/exhaustive-deps
  const weights = FONTS.find((font) => font.family === layer.font)?.weights ?? [400];
  return (
    <InspectorSection title={t`Text`}>
      <textarea
        ref={area}
        value={layer.text}
        rows={2}
        onChange={(event) => set({ text: event.target.value.slice(0, 120), name: event.target.value.split("\n")[0].slice(0, 40) || layer.name }, "body")}
        onKeyDown={(event) => event.stopPropagation()}
        className="min-h-[64px] w-full resize-y rounded-md bg-black/30 px-2.5 py-2 text-[13px] text-white ring-1 ring-white/[0.08] focus:outline-none focus:ring-osu-pink/60"
      />
      <FontPicker value={layer.font} onChange={(font) => set({ font, weight: FONTS.find((entry) => entry.family === font)?.weights.at(-1) ?? 400 })} />
      {weights.length > 1 ? (
        <NumberField label={t`Weight`} value={layer.weight} min={weights[0]} max={weights[weights.length - 1]} step={100} onChange={(weight) => set({ weight: weights.reduce((best, w) => (Math.abs(w - weight) < Math.abs(best - weight) ? w : best), weights[0]) }, "weight")} />
      ) : null}
      <div className="grid grid-cols-2 gap-1.5">
        <NumberField label={t`Size`} value={layer.size} min={8} max={240} step={1} unit="px" onChange={(size) => set({ size }, "size")} />
        <NumberField label={t`Spacing`} value={layer.spacing} min={-20} max={60} step={1} unit="px" onChange={(spacing) => set({ spacing }, "spacing")} />
      </div>
      <InspectorRow label={t`Italic`}><Switch checked={layer.italic} onChange={(italic) => set({ italic })} label={t`Italic`} /></InspectorRow>
      <NumberField label={t`Curve`} value={layer.arc} min={0} max={DOC_SIZE} step={1} unit="px" onChange={(arc) => set({ arc }, "arc")} />
      {layer.arc > 0 ? (
        <InspectorRow label={t`Along the bottom`}><Switch checked={layer.arcBelow} onChange={(arcBelow) => set({ arcBelow })} label={t`Along the bottom`} /></InspectorRow>
      ) : null}
      <div className="flex flex-wrap gap-1.5">
        <SmallButton onClick={() => onPatch({ arc: Math.round(AVATAR_SIZE / 2 + 30), transform: identity() } as Partial<TextLayer>)}>{t`Curve round the avatar`}</SmallButton>
        {layer.arc > 0 ? <SmallButton onClick={() => set({ arc: 0 })}>{t`Straighten`}</SmallButton> : null}
      </div>
      <FillEditor fill={layer.fill} onChange={(fill, merge) => set({ fill }, merge)} merge="fill" />
    </InspectorSection>
  );
}

function MotionSection({ motion, onChange, keyframes }: { motion: Motion; onChange: (motion: Motion, merge?: string) => void; keyframes: Keyframes }) {
  const { t } = useLingui();
  const kinds: { id: MotionKind; label: string }[] = [
    { id: "none", label: t`Still` },
    { id: "spin", label: t`Spin` },
    { id: "orbit", label: t`Orbit` },
    { id: "pulse", label: t`Pulse` },
    { id: "bob", label: t`Bob` },
    { id: "sway", label: t`Sway` },
    { id: "blink", label: t`Fade` },
    { id: "hue", label: t`Colour cycle` },
    { id: "shimmer", label: t`Shine` },
    { id: "keys", label: t`Keyframes` },
  ];
  const keys = [...(motion.keys ?? [])].sort((a, b) => a.t - b.t);
  const active = keys.find((key) => key.id === keyframes.activeKey) ?? null;
  const setKey = (changes: Partial<MotionKey>, merge?: string) => active && onChange({ ...motion, keys: (motion.keys ?? []).map((key) => (key.id === active.id ? { ...key, ...changes } : key)) }, merge ? `key:${active.id}:${merge}` : undefined);
  const hasAmount = motion.kind === "pulse" || motion.kind === "bob" || motion.kind === "sway" || motion.kind === "blink";
  return (
    <InspectorSection title={t`Motion`} defaultOpen={motion.kind !== "none"}>
      <Choice value={motion.kind} onChange={(kind) => {
        onChange({ ...motion, kind });
        if (kind === "keys" && !motion.keys?.length) keyframes.onAdd();
      }} options={kinds} />
      {motion.kind === "keys" ? (
        <>
          <p className="text-[11px] leading-relaxed text-osu-f1">{t`Drag the playhead under the canvas to a moment and add a key. With a key picked, the move tool moves, turns and resizes the layer at that moment.`}</p>
          <div className="flex flex-wrap gap-1">
            {keys.map((key) => (
              <button key={key.id} type="button" onClick={() => keyframes.onPick(key)} className={`h-7 cursor-pointer rounded-md px-2 font-mono text-[11px] ${key.id === keyframes.activeKey ? "bg-osu-pink/25 text-white ring-1 ring-osu-pink/60" : "bg-black/30 text-osu-l2 hover:text-white"}`}>
                {(key.t * LOOP_SECONDS).toFixed(2)}s
              </button>
            ))}
            <button type="button" onClick={keyframes.onAdd} className="h-7 cursor-pointer rounded-md bg-white/[0.06] px-2 text-[11.5px] font-semibold text-osu-l2 hover:text-white">{t`Add key`}</button>
          </div>
          {active ? (
            <>
              <NumberField label={t`Time`} value={active.t * LOOP_SECONDS} min={0} max={LOOP_SECONDS - 0.01} step={0.01} decimals={2} unit="s" onChange={(value) => setKey({ t: Math.round((value / LOOP_SECONDS) * 1000) / 1000 }, "t")} />
              <div className="grid grid-cols-2 gap-1.5">
                <NumberField label="X" value={active.dx} min={-DOC_SIZE} max={DOC_SIZE} step={1} unit="px" onChange={(dx) => setKey({ dx }, "dx")} />
                <NumberField label="Y" value={active.dy} min={-DOC_SIZE} max={DOC_SIZE} step={1} unit="px" onChange={(dy) => setKey({ dy }, "dy")} />
              </div>
              <NumberField label={t`Turn`} value={active.rotation} min={-720} max={720} step={1} unit="°" onChange={(rotation) => setKey({ rotation }, "r")} />
              <div className="grid grid-cols-2 gap-1.5">
                <NumberField label={t`Size`} value={active.scale} min={0.05} max={4} step={0.01} scale={100} unit="%" onChange={(scale) => setKey({ scale }, "s")} />
                <NumberField label={t`Opacity`} value={active.opacity} min={0} max={1} step={0.01} scale={100} unit="%" onChange={(opacity) => setKey({ opacity }, "o")} />
              </div>
              <Choice value={active.ease} onChange={(ease) => setKey({ ease })} options={[{ id: "smooth", label: t`Ease in and out` }, { id: "linear", label: t`Steady` }]} />
              <div className="flex">
                <SmallButton onClick={() => {
                  onChange({ ...motion, keys: (motion.keys ?? []).filter((key) => key.id !== active.id) });
                  keyframes.onPick(null);
                }}>{t`Delete key`}</SmallButton>
              </div>
            </>
          ) : null}
        </>
      ) : motion.kind !== "none" ? (
        <>
          <NumberField label={t`Times per loop`} value={motion.speed} min={-6} max={6} step={1} onChange={(speed) => onChange({ ...motion, speed: speed === 0 ? (motion.speed > 0 ? -1 : 1) : speed }, "speed")} />
          {hasAmount ? <NumberField label={t`Amount`} value={motion.amount} min={0.05} max={1} step={0.01} scale={100} unit="%" onChange={(amount) => onChange({ ...motion, amount }, "amount")} /> : null}
          <NumberField label={t`Offset`} value={motion.phase} min={0} max={1} step={0.01} scale={100} unit="%" onChange={(phase) => onChange({ ...motion, phase }, "phase")} />
          <p className="text-[11px] leading-relaxed text-osu-f1">{t`The loop is 3 seconds. Moving layers make the frame a looping video; play it from the top bar. Spin and Orbit backwards with a negative number.`}</p>
        </>
      ) : null}
    </InspectorSection>
  );
}
