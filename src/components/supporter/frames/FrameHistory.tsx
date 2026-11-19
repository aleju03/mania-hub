import { useLingui } from "@lingui/react/macro";
import { useEffect, useRef } from "react";

import { walk, type EditorState, type Layer } from "../../../lib/frame-editor/doc";

/* Every step of the editing session, oldest first, named by what changed;
   clicking one goes back (or forward) to it. Steps after the current one
   stay listed, dimmed, until something new is done. */

export function HistoryPanel({ steps, position, onJump }: { steps: (EditorState | null)[]; position: number; onJump: (index: number) => void }) {
  const { t } = useLingui();
  function describe(prev: EditorState | null, next: EditorState): string {
    if (!prev) return t`Opened`;
    if (prev.doc.name !== next.doc.name) return t`Renamed the frame`;
    for (const board of ["square", "round"] as const) {
      const before = walk(prev.doc.boards[board]);
      const after = walk(next.doc.boards[board]);
      const old = new Map(before.map((layer) => [layer.id, layer]));
      const now = new Map(after.map((layer) => [layer.id, layer]));
      const added = after.find((layer) => !old.has(layer.id));
      if (added) return t`Added ${added.name}`;
      const removed = before.find((layer) => !now.has(layer.id));
      if (removed) return t`Deleted ${removed.name}`;
      // the layer that changed itself, before any group that changed because of it
      const leaves = after.filter((layer) => layer.kind !== "group" && old.get(layer.id) !== layer);
      const groups = after.filter((layer) => layer.kind === "group" && old.get(layer.id) !== layer);
      // several layers changing together is a group being moved: name the group
      const changed = leaves.length === 1 ? leaves[0] : groups.at(-1) ?? leaves[0];
      if (changed) return leaves.length > 1 && changed.kind === "group" && old.get(changed.id)!.kind === "group" ? t`Moved ${changed.name}` : what(old.get(changed.id)!, changed);
      if (before.map((layer) => layer.id).join() !== after.map((layer) => layer.id).join()) return t`Reordered layers`;
    }
    const layers = [...walk(next.doc.boards.square), ...walk(next.doc.boards.round)];
    for (const key of Object.keys(next.pixels)) {
      if (prev.pixels[key] === next.pixels[key]) continue;
      const mask = key.endsWith(":mask");
      const layer = layers.find((entry) => entry.id === (mask ? key.slice(0, -5) : key));
      if (!layer) continue;
      return mask ? t`Painted the mask of ${layer.name}` : t`Painted on ${layer.name}`;
    }
    return t`Edited`;
  }

  function what(before: Layer, after: Layer): string {
    const name = after.name;
    if (before.visible !== after.visible) return after.visible ? t`Showed ${name}` : t`Hid ${name}`;
    if (before.name !== after.name) return t`Renamed ${name}`;
    if (before.transform !== after.transform || before.distort !== after.distort) return t`Moved ${name}`;
    if (before.effects !== after.effects) return t`Effects on ${name}`;
    if (before.motion !== after.motion) return t`Motion on ${name}`;
    if (before.mask !== after.mask) return t`Mask on ${name}`;
    if (before.opacity !== after.opacity || before.blend !== after.blend) return t`Blending of ${name}`;
    return t`Changed ${name}`;
  }


  const listRef = useRef<HTMLDivElement>(null);
  const currentRef = useRef<HTMLButtonElement>(null);
  // keeps the current step in view inside the list, without scrolling the page
  useEffect(() => {
    const list = listRef.current;
    const row = currentRef.current;
    if (!list || !row) return;
    if (row.offsetTop < list.scrollTop) list.scrollTop = row.offsetTop - 8;
    else if (row.offsetTop + row.offsetHeight > list.scrollTop + list.clientHeight) list.scrollTop = row.offsetTop + row.offsetHeight - list.clientHeight + 8;
  }, [position, steps.length]);
  return (
    <div ref={listRef} className="relative min-h-0 flex-1 overflow-y-auto overscroll-contain px-2 py-2">
      <ol className="grid gap-0.5">
        {steps.map((step, index) => {
          if (!step) return null;
          const label = describe(index ? steps[index - 1] : null, step);
          const current = index === position;
          return (
            <li key={index}>
              <button
                ref={current ? currentRef : undefined}
                type="button"
                onClick={() => onJump(index)}
                className={`flex h-8 w-full cursor-pointer items-center gap-2 rounded-md px-2.5 text-left text-[12.5px] transition-colors ${current ? "bg-osu-pink/[0.16] font-semibold text-white" : index > position ? "text-osu-f1/50 hover:bg-white/[0.04]" : "text-osu-l2 hover:bg-white/[0.04] hover:text-white"}`}
              >
                <span className="w-5 shrink-0 text-right font-mono text-[10.5px] text-osu-f1">{index + 1}</span>
                <span className="min-w-0 flex-1 truncate">{label}</span>
              </button>
            </li>
          );
        })}
      </ol>
      <p className="px-2.5 pt-2 text-[11px] text-osu-f1">{t`Click a step to go back to it. The last 80 are kept.`}</p>
    </div>
  );
}
