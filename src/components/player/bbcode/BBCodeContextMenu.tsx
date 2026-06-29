import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";

export interface ContextMenuItem {
  /** A separator ignores label/onSelect. */
  separator?: boolean;
  label?: string;
  icon?: ReactNode;
  danger?: boolean;
  disabled?: boolean;
  onSelect?: () => void;
}

export interface ContextMenuState {
  x: number;
  y: number;
  items: ContextMenuItem[];
}

const MENU_MARGIN = 8;

/** A right-click menu rendered to <body> so the editor's overflow can't clip it. */
export function BBCodeContextMenu({
  menu,
  onClose,
}: {
  menu: ContextMenuState | null;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement | null>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);

  // Place the menu, then nudge it back inside the viewport once measured.
  useLayoutEffect(() => {
    if (!menu) {
      setPos(null);
      return;
    }
    setPos({ left: menu.x, top: menu.y });
    const el = ref.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    let left = menu.x;
    let top = menu.y;
    if (left + rect.width > window.innerWidth - MENU_MARGIN) {
      left = Math.max(MENU_MARGIN, window.innerWidth - rect.width - MENU_MARGIN);
    }
    if (top + rect.height > window.innerHeight - MENU_MARGIN) {
      top = Math.max(MENU_MARGIN, window.innerHeight - rect.height - MENU_MARGIN);
    }
    setPos({ left, top });
  }, [menu]);

  useEffect(() => {
    if (!menu) return;
    // Capture so a click on the editor surface dismisses before it re-acts, but
    // ignore clicks inside the menu so item handlers still get to run.
    const closeOutside = (event: Event) => {
      const target = event.target;
      if (ref.current && target instanceof Node && ref.current.contains(target)) return;
      onClose();
    };
    const close = () => onClose();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("pointerdown", closeOutside, true);
    window.addEventListener("scroll", close, true);
    window.addEventListener("resize", close);
    window.addEventListener("blur", close);
    window.addEventListener("keydown", onKey, true);
    return () => {
      window.removeEventListener("pointerdown", closeOutside, true);
      window.removeEventListener("scroll", close, true);
      window.removeEventListener("resize", close);
      window.removeEventListener("blur", close);
      window.removeEventListener("keydown", onKey, true);
    };
  }, [menu, onClose]);

  if (!menu || typeof document === "undefined") return null;

  return createPortal(
    <div
      ref={ref}
      role="menu"
      // Keep our own pointerdown from bubbling to the global close handler.
      onPointerDown={(event) => event.stopPropagation()}
      onContextMenu={(event) => event.preventDefault()}
      style={{
        position: "fixed",
        left: pos?.left ?? menu.x,
        top: pos?.top ?? menu.y,
        visibility: pos ? "visible" : "hidden",
        maxHeight: `calc(100vh - ${MENU_MARGIN * 2}px)`,
        overflowY: "auto",
      }}
      className="z-[120] min-w-44 max-w-72 py-1 rounded-lg border border-osu-b3/50 bg-osu-b6 shadow-xl shadow-black/40 text-[13px] select-none"
    >
      {menu.items.map((item, index) => {
        if (item.separator) {
          return <div key={`sep-${index}`} className="my-1 h-px bg-osu-b3/40" />;
        }
        return (
          <button
            key={`${item.label}-${index}`}
            type="button"
            role="menuitem"
            disabled={item.disabled}
            // Keep the editor's text selection alive for copy/cut/format actions.
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => {
              if (item.disabled) return;
              onClose();
              item.onSelect?.();
            }}
            className={`flex w-full items-center gap-2.5 px-3 py-1.5 text-left transition-colors cursor-pointer disabled:cursor-default disabled:opacity-40 ${
              item.danger
                ? "text-osu-red-light hover:bg-osu-red/15"
                : "text-osu-l2 hover:bg-osu-b3/60 hover:text-osu-c1"
            }`}
          >
            {item.icon ? <span className="grid w-4 place-items-center shrink-0 text-osu-f1">{item.icon}</span> : null}
            <span className="truncate">{item.label}</span>
          </button>
        );
      })}
    </div>,
    document.body,
  );
}
