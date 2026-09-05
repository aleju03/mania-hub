import { useEffect, useRef, type HTMLAttributes } from "react";

type OpenMenu = (x: number, y: number) => void;

/* iOS image callouts do not reliably dispatch contextmenu. Own the touch
   hold as well as desktop right-click, without preventing normal scrolling. */
export function useCardContextMenu() {
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const origin = useRef<{ x: number; y: number } | null>(null);
  const held = useRef(false);

  const cancel = () => {
    if (timer.current !== null) clearTimeout(timer.current);
    timer.current = null;
    origin.current = null;
  };

  useEffect(() => {
    window.addEventListener("scroll", cancel, true);
    window.addEventListener("blur", cancel);
    return () => {
      cancel();
      window.removeEventListener("scroll", cancel, true);
      window.removeEventListener("blur", cancel);
    };
  }, []);

  return (open: OpenMenu | null) => open ? {
    style: { WebkitTouchCallout: "none", WebkitUserSelect: "none", userSelect: "none" },
    onTouchStart: (event) => {
      cancel();
      held.current = false;
      if (event.touches.length !== 1) return;
      const { clientX: x, clientY: y } = event.touches[0];
      origin.current = { x, y };
      timer.current = setTimeout(() => {
        cancel();
        held.current = true;
        open(x, y);
      }, 500);
    },
    onTouchMove: (event) => {
      if (!origin.current) return;
      const touch = event.touches[0];
      if (event.touches.length !== 1 || Math.hypot(
        touch.clientX - origin.current.x, touch.clientY - origin.current.y,
      ) > 10) cancel();
    },
    onTouchEnd: (event) => {
      cancel();
      // Cancel only a completed hold, so lifting cannot click the card or a
      // menu item that appeared under the finger. Ordinary taps stay native.
      if (held.current) event.preventDefault();
    },
    onTouchCancel: cancel,
    onClickCapture: (event) => {
      if (!held.current || event.detail === 0) return;
      held.current = false;
      event.preventDefault();
      event.stopPropagation();
    },
    onPointerDownCapture: (event) => {
      if (event.pointerType === "mouse") held.current = false;
    },
    onContextMenu: (event) => {
      event.preventDefault();
      const touching = origin.current !== null;
      cancel();
      // Android may also emit its native event for the same touch hold.
      if (held.current) return;
      held.current = touching;
      open(event.clientX, event.clientY);
    },
  } satisfies HTMLAttributes<HTMLElement> : {};
}
