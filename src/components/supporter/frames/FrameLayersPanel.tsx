import { useLingui } from "@lingui/react/macro";
import { Reorder, useDragControls } from "framer-motion";
import {
  ArrowDown,
  ArrowUp,
  Copy,
  CornerDownRight,
  Crosshair,
  ChevronRight,
  Eye,
  EyeOff,
  Folder,
  FolderOpen,
  FlipHorizontal2,
  FlipVertical2,
  GripVertical,
  ImagePlus,
  Lock,
  LockOpen,
  Merge,
  MoreHorizontal,
  Pencil,
  Plus,
  Trash2,
  Type,
} from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";

import { BLEND_MODES, DOC_SIZE, findIn, LAYERS_MAX, maskKey, parentOf, walk, type BlendMode, type EditorState, type GroupLayer, type Layer } from "../../../lib/frame-editor/doc";
import { renderLayer } from "../../../lib/frame-editor/render";
import { useMediaQuery } from "../../../lib/use-media-query";
import { NumberField, Popover } from "../themes/EditorControls";
import { PanelHeader } from "../themes/EditorChrome";
import { ShapeIcon } from "./FrameTools";

/* The frame editor's layer list: top layer first, a thumbnail of each, drag
   to reorder, and the selected layer's blend mode and opacity above it. */

export type LayerAction =
  | "duplicate"
  | "delete"
  | "merge"
  | "rasterize"
  | "clip"
  | "lock"
  | "hide"
  | "flipX"
  | "flipY"
  | "centre"
  | "up"
  | "down"
  | "rename"
  | "addMask"
  | "deleteMask"
  | "toggleMask"
  | "applyMask"
  | "group"
  | "ungroup"
  | "moveOut"
  | `into:${string}`;

export function useBlendNames(): Record<BlendMode, string> {
  const { t } = useLingui();
  return {
    "source-over": t`Normal`,
    multiply: t`Multiply`,
    screen: t`Screen`,
    overlay: t`Overlay`,
    darken: t`Darken`,
    lighten: t`Lighten`,
    "color-dodge": t`Colour dodge`,
    "color-burn": t`Colour burn`,
    "hard-light": t`Hard light`,
    "soft-light": t`Soft light`,
    difference: t`Difference`,
    exclusion: t`Exclusion`,
    hue: t`Hue`,
    saturation: t`Saturation`,
    color: t`Colour`,
    luminosity: t`Luminosity`,
  };
}

export function LayersPanel({ state, layers, selected, onSelect, onPatch, onReorder, onAction, onAddPaint, onAddShape, onAddText, onAddPicture, renaming, onRenaming, maskTarget, onMaskTarget }: {
  state: EditorState;
  layers: Layer[];
  selected: string | null;
  onSelect: (id: string | null) => void;
  onPatch: (id: string, patch: Partial<Layer>, merge?: string) => void;
  onReorder: (parent: string | null, ids: string[]) => void;
  onAction: (id: string, action: LayerAction) => void;
  onAddPaint: () => void;
  onAddShape: () => void;
  onAddText: () => void;
  onAddPicture: (file: File) => void;
  renaming: string | null;
  onRenaming: (id: string | null) => void;
  maskTarget: boolean;
  onMaskTarget: (id: string, mask: boolean) => void;
}) {
  const { t } = useLingui();
  const blendNames = useBlendNames();
  const [menu, setMenu] = useState<{ id: string; x: number; y: number } | null>(null);
  const [blendOpen, setBlendOpen] = useState(false);
  const [addOpen, setAddOpen] = useState(false);
  const pictureInput = useRef<HTMLInputElement>(null);
  const current = findIn(layers, selected);
  const all = walk(layers);
  const full = all.length >= LAYERS_MAX;
  const index = current ? parentOf(layers, current.id)?.index ?? -1 : -1;
  const groups = all.filter((layer): layer is GroupLayer => layer.kind === "group");

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

  const menuLayer = menu ? findIn(layers, menu.id) : null;
  const menuPlace = menu ? parentOf(layers, menu.id) : null;
  // the menu opens at the pointer, moved up as far as it needs to stay on screen
  const menuRef = useRef<HTMLDivElement>(null);
  const [menuTop, setMenuTop] = useState<number | null>(null);
  useLayoutEffect(() => {
    if (!menu || !menuRef.current) {
      setMenuTop(null);
      return;
    }
    const height = menuRef.current.offsetHeight;
    setMenuTop(Math.max(8, Math.min(menu.y, window.innerHeight - height - 8)));
  }, [menu]);
  const act = (action: LayerAction) => {
    if (menu) onAction(menu.id, action);
    setMenu(null);
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <PanelHeader title={t`Layers`}>
        <span className="mr-1 font-mono text-[10.5px] text-osu-f1/70">{all.length}/{LAYERS_MAX}</span>
      </PanelHeader>
      <div className="grid shrink-0 grid-cols-[minmax(0,1fr)_minmax(0,1fr)] gap-1.5 border-b border-white/[0.06] px-3 py-2">
        <Popover
          open={blendOpen && !!current}
          onOpenChange={setBlendOpen}
          className="w-44"
          trigger={
            <button
              type="button"
              disabled={!current}
              onClick={() => setBlendOpen((value) => !value)}
              className="flex h-8 w-full cursor-pointer items-center justify-between rounded-md bg-white/[0.045] px-2.5 text-[12px] text-osu-l2 ring-1 ring-white/[0.06] hover:bg-white/[0.07] disabled:cursor-default disabled:opacity-40"
            >
              <span className="truncate">{current ? blendNames[current.blend] : t`Blend`}</span>
              <span className="text-osu-f1">▾</span>
            </button>
          }
        >
          <div className="grid max-h-80 gap-0.5 overflow-y-auto">
            {BLEND_MODES.map((mode) => (
              <button
                key={mode}
                type="button"
                onClick={() => {
                  if (current) onPatch(current.id, { blend: mode });
                  setBlendOpen(false);
                }}
                className={`h-7 cursor-pointer rounded-md px-2 text-left text-[12px] ${current?.blend === mode ? "bg-osu-pink/20 text-white" : "text-osu-l2 hover:bg-white/[0.06] hover:text-white"}`}
              >
                {blendNames[mode]}
              </button>
            ))}
          </div>
        </Popover>
        {current ? (
          <NumberField label={t`Opacity`} value={current.opacity} min={0} max={1} step={0.01} scale={100} unit="%" onChange={(opacity) => onPatch(current.id, { opacity }, `opacity:${current.id}`)} />
        ) : (
          <div className="h-8 rounded-md bg-white/[0.03]" />
        )}
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-2 py-2" onPointerDown={(event) => event.target === event.currentTarget && onSelect(null)}>
        <LayerTree
          layers={layers}
          parent={null}
          depth={0}
          row={(layer, depth, startDrag) => (
            <LayerRow
              key={layer.id}
              layer={layer}
              depth={depth}
              startDrag={startDrag}
              state={state}
              selected={layer.id === selected}
              onMask={layer.id === selected && maskTarget}
              onPickMask={(mask) => onMaskTarget(layer.id, mask)}
              renaming={renaming === layer.id}
              onSelect={() => onSelect(layer.id)}
              onRename={() => onRenaming(layer.id)}
              onRenamed={(name) => {
                onRenaming(null);
                if (name) onPatch(layer.id, { name });
              }}
              onToggle={(key) => onPatch(layer.id, { [key]: !layer[key] } as Partial<Layer>)}
              onCollapse={() => layer.kind === "group" && onPatch(layer.id, { collapsed: !layer.collapsed } as Partial<Layer>)}
              onMenu={(x, y) => {
                onSelect(layer.id);
                setMenu({ id: layer.id, x, y });
              }}
            />
          )}
          onReorder={onReorder}
        />
        {layers.length === 0 ? <p className="px-3 py-6 text-center text-[11.5px] leading-relaxed text-osu-f1">{t`No layers yet. Paint with the brush, add a shape or text, or drop a picture on the canvas.`}</p> : null}
      </div>

      <div className="flex h-11 shrink-0 items-center gap-0.5 border-t border-white/[0.06] px-2">
        <IconButton label={t`New paint layer`} shortcut="Ctrl Shift N" disabled={full} onClick={onAddPaint}><Plus size={16} /></IconButton>
        <Popover
          open={addOpen}
          onOpenChange={setAddOpen}
          className="w-48"
          trigger={<IconButton label={t`Add a shape, text or picture`} disabled={full} onClick={() => setAddOpen((value) => !value)}><ShapeIcon kind="ellipse" size={15} /></IconButton>}
        >
          <MenuItem icon={<ShapeIcon kind="ellipse" size={13} />} label={t`Shape round the avatar`} onClick={() => { onAddShape(); setAddOpen(false); }} />
          <MenuItem icon={<Type size={13} />} label={t`Text`} onClick={() => { onAddText(); setAddOpen(false); }} />
          <MenuItem icon={<ImagePlus size={13} />} label={t`Picture...`} onClick={() => { pictureInput.current?.click(); setAddOpen(false); }} />
        </Popover>
        <input
          ref={pictureInput}
          type="file"
          accept="image/*"
          hidden
          onChange={(event) => {
            const file = event.target.files?.[0];
            event.target.value = "";
            if (file) onAddPicture(file);
          }}
        />
        <span className="flex-1" />
        <IconButton label={t`Duplicate`} shortcut="Ctrl J" disabled={!current || full} onClick={() => current && onAction(current.id, "duplicate")}><Copy size={15} /></IconButton>
        <IconButton label={t`Merge down`} shortcut="Ctrl E" disabled={!current || index <= 0} onClick={() => current && onAction(current.id, "merge")}><Merge size={15} /></IconButton>
        <IconButton label={t`Delete`} shortcut="Del" disabled={!current} onClick={() => current && onAction(current.id, "delete")}><Trash2 size={15} /></IconButton>
      </div>

      {menu && menuLayer ? (
        <div
          ref={menuRef}
          className="fixed z-[60] max-h-[calc(100dvh-16px)] w-52 overflow-y-auto rounded-lg border border-white/[0.08] bg-[#1c1720] p-1 shadow-[0_12px_40px_rgba(0,0,0,0.6)]"
          style={{ left: Math.max(8, Math.min(menu.x, window.innerWidth - 216)), top: menuTop ?? menu.y, visibility: menuTop === null ? "hidden" : "visible" }}
          onPointerDown={(event) => event.stopPropagation()}
        >
          <MenuItem icon={<Copy size={13} />} label={t`Duplicate`} shortcut="Ctrl J" disabled={full} onClick={() => act("duplicate")} />
          <MenuItem icon={<Pencil size={13} />} label={t`Rename`} onClick={() => act("rename")} />
          <MenuItem icon={<Merge size={13} />} label={t`Merge down`} shortcut="Ctrl E" disabled={(menuPlace?.index ?? 0) <= 0} onClick={() => act("merge")} />
          <MenuItem icon={<Folder size={13} />} label={t`Put in a new group`} shortcut="Ctrl G" disabled={full} onClick={() => act("group")} />
          {menuLayer.kind === "group" ? <MenuItem icon={<FolderOpen size={13} />} label={t`Ungroup`} shortcut="Ctrl Shift G" onClick={() => act("ungroup")} /> : null}
          {menuPlace?.parent ? <MenuItem icon={<FolderOpen size={13} />} label={t`Move out of the group`} onClick={() => act("moveOut")} /> : null}
          {groups.filter((group) => group.id !== menuLayer.id && group.id !== menuPlace?.parent && !(menuLayer.kind === "group" && findIn([menuLayer], group.id))).slice(0, 6).map((group) => (
            <MenuItem key={group.id} icon={<Folder size={13} />} label={t`Move into ${group.name}`} onClick={() => {
              onAction(menuLayer.id, `into:${group.id}`);
              setMenu(null);
            }} />
          ))}
          {menuLayer.kind !== "paint" || menuLayer.distort ? <MenuItem icon={<Brush13 />} label={t`Turn into paint`} onClick={() => act("rasterize")} /> : null}
          {menuLayer.mask ? (
            <>
              <MenuItem icon={<MaskIcon />} label={menuLayer.mask.enabled ? t`Turn the mask off` : t`Turn the mask on`} onClick={() => act("toggleMask")} />
              {menuLayer.kind === "paint" ? <MenuItem icon={<MaskIcon />} label={t`Apply the mask`} onClick={() => act("applyMask")} /> : null}
              <MenuItem icon={<MaskIcon />} label={t`Delete the mask`} onClick={() => act("deleteMask")} />
            </>
          ) : (
            <MenuItem icon={<MaskIcon />} label={t`Add a mask`} onClick={() => act("addMask")} />
          )}
          <MenuItem icon={<CornerDownRight size={13} />} label={menuLayer.clip ? t`Stop clipping` : t`Clip to the layer below`} shortcut="Ctrl Alt G" onClick={() => act("clip")} />
          <div className="my-1 h-px bg-white/[0.06]" />
          <MenuItem icon={<FlipHorizontal2 size={13} />} label={t`Flip horizontally`} onClick={() => act("flipX")} />
          <MenuItem icon={<FlipVertical2 size={13} />} label={t`Flip vertically`} onClick={() => act("flipY")} />
          <MenuItem icon={<Crosshair size={13} />} label={t`Centre on the avatar`} onClick={() => act("centre")} />
          <MenuItem icon={<ArrowUp size={13} />} label={t`Bring forward`} shortcut="Ctrl ]" onClick={() => act("up")} />
          <MenuItem icon={<ArrowDown size={13} />} label={t`Send backward`} shortcut="Ctrl [" onClick={() => act("down")} />
          <MenuItem icon={menuLayer.locked ? <LockOpen size={13} /> : <Lock size={13} />} label={menuLayer.locked ? t`Unlock` : t`Lock`} onClick={() => act("lock")} />
          <MenuItem icon={menuLayer.visible ? <EyeOff size={13} /> : <Eye size={13} />} label={menuLayer.visible ? t`Hide` : t`Show`} onClick={() => act("hide")} />
          <div className="my-1 h-px bg-white/[0.06]" />
          <MenuItem icon={<Trash2 size={13} />} label={t`Delete`} shortcut="Del" danger onClick={() => act("delete")} />
        </div>
      ) : null}
    </div>
  );
}

function MaskIcon() {
  return (
    <svg width={13} height={13} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} aria-hidden>
      <rect x="3.5" y="3.5" width="17" height="17" rx="3" />
      <path d="M12 7.5a4.5 4.5 0 0 1 0 9z" fill="currentColor" stroke="none" />
      <circle cx="12" cy="12" r="4.5" />
    </svg>
  );
}

function Brush13() {
  return (
    <svg width={13} height={13} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="m9.06 11.9 8.07-8.06a2.85 2.85 0 1 1 4.03 4.03l-8.06 8.08" />
      <path d="M7.07 14.94c-1.66 0-3 1.35-3 3.02 0 1.33-2.5 1.52-2 2.02 1.08 1.1 2.49 2.02 4 2.02 2.2 0 4-1.8 4-4.04a3.01 3.01 0 0 0-3-3.02z" />
    </svg>
  );
}

function IconButton({ label, shortcut, disabled, onClick, children }: { label: string; shortcut?: string; disabled?: boolean; onClick: () => void; children: ReactNode }) {
  return (
    <button
      type="button"
      aria-label={label}
      title={shortcut ? `${label} (${shortcut})` : label}
      disabled={disabled}
      onClick={onClick}
      className="grid h-8 w-8 cursor-pointer place-items-center rounded-md text-osu-l2 transition-colors hover:bg-white/[0.06] hover:text-white disabled:cursor-default disabled:opacity-35"
    >
      {children}
    </button>
  );
}

export function MenuItem({ icon, label, shortcut, onClick, disabled, danger }: { icon: ReactNode; label: string; shortcut?: string; onClick: () => void; disabled?: boolean; danger?: boolean }) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      className={`flex h-8 w-full cursor-pointer items-center gap-2 rounded-md px-2 text-left text-[12px] transition-colors disabled:cursor-default disabled:opacity-40 ${danger ? "text-rose-300 hover:bg-rose-500/15" : "text-osu-l2 hover:bg-white/[0.06] hover:text-white"}`}
    >
      {icon}
      <span className="flex-1">{label}</span>
      {shortcut ? <span className="font-mono text-[10px] text-osu-f1/70 [@media(hover:none)]:hidden">{shortcut}</span> : null}
    </button>
  );
}

/* One list of layers, top first, dragged to reorder within it; a group's layers nest under its row. */
type RowRender = (layer: Layer, depth: number, startDrag: (event: React.PointerEvent) => void) => ReactNode;

function LayerTree({ layers, parent, depth, row, onReorder }: { layers: Layer[]; parent: string | null; depth: number; row: RowRender; onReorder: (parent: string | null, ids: string[]) => void }) {
  const front = [...layers].reverse();
  return (
    <Reorder.Group axis="y" values={front.map((layer) => layer.id)} onReorder={(ids) => onReorder(parent, [...ids].reverse())} className="grid gap-0.5">
      {front.map((layer) => <TreeItem key={layer.id} layer={layer} depth={depth} row={row} onReorder={onReorder} />)}
    </Reorder.Group>
  );
}

/* A layer and, for a group, the layers inside it, dragged as one from the layer's own row. */
function TreeItem({ layer, depth, row, onReorder }: { layer: Layer; depth: number; row: RowRender; onReorder: (parent: string | null, ids: string[]) => void }) {
  const controls = useDragControls();
  return (
    <Reorder.Item value={layer.id} dragListener={false} dragControls={controls} as="div" className="grid gap-0.5">
      {row(layer, depth, (event) => controls.start(event))}
      {layer.kind === "group" && !layer.collapsed && layer.children.length ? (
        <LayerTree layers={layer.children} parent={layer.id} depth={depth + 1} row={row} onReorder={onReorder} />
      ) : null}
    </Reorder.Item>
  );
}

function LayerRow({ layer, depth, startDrag, state, selected, onMask, onPickMask, renaming, onSelect, onRename, onRenamed, onToggle, onCollapse, onMenu }: {
  layer: Layer;
  depth: number;
  startDrag: (event: React.PointerEvent) => void;
  onCollapse: () => void;
  state: EditorState;
  selected: boolean;
  onMask: boolean;
  onPickMask: (mask: boolean) => void;
  renaming: boolean;
  onSelect: () => void;
  onRename: () => void;
  onRenamed: (name: string | null) => void;
  onToggle: (key: "visible" | "locked") => void;
  onMenu: (x: number, y: number) => void;
}) {
  const { t } = useLingui();
  const touch = useMediaQuery("(hover: none)") === true;
  return (
    <div
      className={`group relative flex h-12 cursor-default items-center gap-2.5 rounded-lg pl-2 pr-1 transition-colors ${selected ? "bg-osu-pink/[0.16] text-white" : "text-osu-l2 hover:bg-white/[0.04]"} ${layer.clip ? "ml-4" : ""}`}
      style={depth ? { marginLeft: depth * 14 } : undefined}
      onPointerDown={(event) => {
        onSelect();
        if (!touch && !renaming) startDrag(event);
      }}
      onDoubleClick={onRename}
      onContextMenu={(event) => {
        event.preventDefault();
        onMenu(event.clientX, event.clientY);
      }}
    >
      {selected ? <span aria-hidden className="absolute inset-y-1.5 left-0 w-0.5 rounded-full bg-osu-pink" /> : null}
      {touch ? (
        <span aria-hidden onPointerDown={(event) => startDrag(event)} className="-ml-1 -mr-1.5 grid h-10 w-5 shrink-0 touch-none place-items-center text-osu-f1/60">
          <GripVertical size={14} />
        </span>
      ) : null}
      {layer.clip ? <CornerDownRight size={13} className="-ml-1 shrink-0 text-osu-f1" /> : null}
      {layer.kind === "group" ? (
        <button
          type="button"
          aria-label={layer.collapsed ? t`Open the group` : t`Close the group`}
          onPointerDown={(event) => event.stopPropagation()}
          onClick={onCollapse}
          className="-ml-1 -mr-1.5 grid h-7 w-5 shrink-0 cursor-pointer place-items-center text-osu-f1 hover:text-white"
        >
          <ChevronRight size={14} className={`transition-transform ${layer.collapsed ? "" : "rotate-90"}`} />
        </button>
      ) : null}
      <span
        onPointerDown={() => layer.mask && onPickMask(false)}
        className={`rounded-md ${selected && layer.mask && !onMask ? "ring-2 ring-white/80" : ""}`}
        title={layer.mask ? t`Paint the layer` : undefined}
      >
        <LayerThumb layer={layer} state={state} />
      </span>
      {layer.mask ? (
        <span
          onPointerDown={(event) => {
            event.stopPropagation();
            onPickMask(true);
          }}
          title={t`Paint the mask: the brush hides, the eraser brings back`}
          className={`relative -ml-1 cursor-pointer rounded-md ${onMask ? "ring-2 ring-white/80" : ""}`}
        >
          <MaskThumb canvas={state.pixels[maskKey(layer.id)]} />
          {layer.mask.enabled ? null : <span aria-hidden className="absolute inset-0 grid place-items-center text-[16px] font-bold text-rose-400">×</span>}
        </span>
      ) : null}
      {renaming ? (
        <RenameInput value={layer.name} onDone={onRenamed} />
      ) : (
        <span className={`min-w-0 flex-1 truncate text-[12.5px] ${layer.visible ? "font-medium" : "text-osu-f1/50"}`}>{layer.name}</span>
      )}
      {layer.motion.kind !== "none" ? <span title={t`Moves in the loop`} className="h-1.5 w-1.5 shrink-0 rounded-full bg-sky-300/80" /> : null}
      <button
        type="button"
        aria-label={layer.locked ? t`Unlock` : t`Lock`}
        title={layer.locked ? t`Unlock` : t`Lock`}
        onPointerDown={(event) => event.stopPropagation()}
        onClick={() => onToggle("locked")}
        className={`grid h-7 w-7 shrink-0 cursor-pointer place-items-center rounded-md text-osu-f1 transition-colors hover:bg-white/[0.08] ${layer.locked || touch ? "" : "opacity-0 group-hover:opacity-100"}`}
      >
        {layer.locked ? <Lock size={13} /> : <LockOpen size={13} />}
      </button>
      <button
        type="button"
        aria-label={layer.visible ? t`Hide` : t`Show`}
        title={layer.visible ? t`Hide` : t`Show`}
        onPointerDown={(event) => event.stopPropagation()}
        onClick={() => onToggle("visible")}
        className="grid h-7 w-7 shrink-0 cursor-pointer place-items-center rounded-md text-osu-f1 transition-colors hover:bg-white/[0.08]"
      >
        {layer.visible ? <Eye size={14} /> : <EyeOff size={14} />}
      </button>
      {touch ? (
        <button
          type="button"
          aria-label={t`Layer menu`}
          onPointerDown={(event) => event.stopPropagation()}
          onClick={(event) => {
            const box = event.currentTarget.getBoundingClientRect();
            onMenu(box.right - 208, box.bottom + 4);
          }}
          className="grid h-7 w-7 shrink-0 cursor-pointer place-items-center rounded-md text-osu-f1"
        >
          <MoreHorizontal size={15} />
        </button>
      ) : null}
    </div>
  );
}

const THUMB = 40;

function LayerThumb({ layer, state }: { layer: Layer; state: EditorState }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const source = layer.kind === "paint" ? state.pixels[layer.id] : layer.kind === "image" ? state.assets[layer.asset] : null;
  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d")!;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(renderLayer(layer, { pixels: state.pixels, assets: state.assets, size: DOC_SIZE }), 0, 0, canvas.width, canvas.height);
  }, [layer, source]); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <span className="grid h-10 w-10 shrink-0 place-items-center overflow-hidden rounded-md bg-[conic-gradient(#ffffff14_25%,transparent_0_50%,#ffffff14_0_75%,transparent_0)] bg-[length:8px_8px] ring-1 ring-white/[0.08]">
      <canvas ref={ref} width={THUMB * 2} height={THUMB * 2} className="h-full w-full" />
    </span>
  );
}

function MaskThumb({ canvas }: { canvas: HTMLCanvasElement | undefined }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const target = ref.current;
    if (!target) return;
    const ctx = target.getContext("2d")!;
    ctx.fillStyle = "#000";
    ctx.fillRect(0, 0, target.width, target.height);
    if (canvas) ctx.drawImage(canvas, 0, 0, target.width, target.height);
  }, [canvas]);
  return (
    <span className="grid h-10 w-10 shrink-0 overflow-hidden rounded-md ring-1 ring-white/[0.08]">
      <canvas ref={ref} width={THUMB * 2} height={THUMB * 2} className="h-full w-full" />
    </span>
  );
}

function RenameInput({ value, onDone }: { value: string; onDone: (name: string | null) => void }) {
  const ref = useRef<HTMLInputElement>(null);
  const [text, setText] = useState(value);
  useEffect(() => {
    ref.current?.select();
  }, []);
  return (
    <input
      ref={ref}
      value={text}
      onChange={(event) => setText(event.target.value.slice(0, 40))}
      onPointerDown={(event) => event.stopPropagation()}
      onBlur={() => onDone(text.trim() || null)}
      onKeyDown={(event) => {
        if (event.key === "Enter") onDone(text.trim() || null);
        if (event.key === "Escape") onDone(null);
        event.stopPropagation();
      }}
      className="h-7 w-0 min-w-0 flex-1 rounded bg-black/40 px-1.5 text-[12.5px] text-white ring-1 ring-osu-pink/60 focus:outline-none"
    />
  );
}
