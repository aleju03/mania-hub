import { useEffect, useState, type PointerEvent as ReactPointerEvent } from "react";
import { createPortal } from "react-dom";
import { Link } from "@tanstack/react-router";
import { useLingui } from "@lingui/react/macro";

import { useAuth } from "../../lib/auth-context";
import { canUseAdminFeatures } from "../../lib/auth-shared";
import { KNOWN_APPS, REPLAY_IMPORT_APP, knownApp } from "../../lib/companella-integration/shared";

// Marks a score row that came from an app import (Companella, Mania Bridge) instead of osu!, with the icon of the
// app that sent it; a row without one predates the field and was Companella. The icon is full colour on a solid
// disc, so it is an <img>, not a mask like the mod glyphs. The small mark copies keep a row from pulling the originals.
// Rows draw their content above a full-row button with pointer events off, so the mark turns them back on for its
// own hover label and, on a Mania Bridge play, its link to /bridge. Mania Bridge marks show to admins only until
// its release, like /bridge itself. A play an admin imported from the player's replay files carries no mark.
export function CompanellaMark({ app, className = "h-[18px] w-[18px]" }: { app?: string; className?: string }) {
  const { t } = useLingui();
  const auth = useAuth();
  const known = knownApp(app) ?? KNOWN_APPS.companella;
  const label = t`Sent through ${known.name}`;
  const [tip, setTip] = useState<{ left: number; top: number } | null>(null);
  const isBridge = app === "mania-bridge";
  const isAdmin = canUseAdminFeatures(auth);
  const showTip = (event: ReactPointerEvent<HTMLElement>) => {
    if (event.pointerType !== "mouse") return;
    const rect = event.currentTarget.getBoundingClientRect();
    setTip({ left: rect.left + rect.width / 2, top: rect.top });
  };
  useEffect(() => {
    if (!tip) return;
    const hide = () => setTip(null);
    window.addEventListener("scroll", hide, true);
    return () => window.removeEventListener("scroll", hide, true);
  }, [tip]);

  if (isBridge && !isAdmin) return null;
  if (app === REPLAY_IMPORT_APP) return null;

  const image = (
    <img
      src={known.mark}
      alt={label}
      width={48}
      height={48}
      loading="lazy"
      className={`inline-block rounded-full align-middle ${className}`}
    />
  );
  const hover = { onPointerEnter: showTip, onPointerLeave: () => setTip(null) };
  const tooltip = tip && typeof document !== "undefined" ? createPortal(
    <div
      className="pointer-events-none fixed z-[60] -translate-x-1/2 -translate-y-full whitespace-nowrap rounded-lg bg-osu-b3 px-3 py-1.5 text-[12px] font-semibold text-white shadow-xl shadow-black/50"
      style={{ left: tip.left, top: tip.top - 6 }}
    >
      {label}
    </div>,
    document.body,
  ) : null;

  return (
    <>
      {isBridge ? (
        <Link
          to="/bridge"
          onClick={(event) => event.stopPropagation()}
          className="pointer-events-auto relative z-10 inline-flex flex-shrink-0 rounded-full hover:brightness-110"
          {...hover}
        >
          {image}
        </Link>
      ) : (
        <span className="pointer-events-auto relative z-10 inline-flex flex-shrink-0 cursor-default" {...hover}>
          {image}
        </span>
      )}
      {tooltip}
    </>
  );
}
