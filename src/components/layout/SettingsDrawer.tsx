import { useEffect } from "react";
import { SettingsPanel } from "../settings/SettingsPanel";
import { useLingui } from "@lingui/react/macro";

interface SettingsDrawerProps {
  open: boolean;
  onClose: () => void;
  onBackdropClose?: () => void;
}

export function SettingsDrawer({ open, onClose, onBackdropClose }: SettingsDrawerProps) {
  const { t } = useLingui();
  // Body scroll lock matches the mobile nav drawer pattern: defer the
  // layout-invalidating overflow write by two rAFs so the slide transition
  // gets a clean compositor frame before triggering a full-document restyle.
  useEffect(() => {
    if (!open) {
      document.body.style.overflow = "";
      return;
    }
    let raf2 = 0;
    const raf1 = requestAnimationFrame(() => {
      raf2 = requestAnimationFrame(() => {
        document.body.style.overflow = "hidden";
      });
    });
    return () => {
      cancelAnimationFrame(raf1);
      if (raf2) cancelAnimationFrame(raf2);
      document.body.style.overflow = "";
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const handleKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    document.addEventListener("keydown", handleKey);
    return () => document.removeEventListener("keydown", handleKey);
  }, [open, onClose]);

  return (
    <>
      <div
        className={`fixed inset-0 z-[55] bg-black/60 transition-opacity duration-200 ease-out ${
          open ? "opacity-100" : "opacity-0 pointer-events-none"
        }`}
        onClick={onBackdropClose ?? onClose}
        style={{ top: 60 }}
        aria-hidden={!open}
      />
      <div
        className={`fixed top-[60px] right-0 bottom-0 z-[60] w-[min(420px,90vw)] border-l border-osu-b3/30 bg-osu-b5 transform-gpu will-change-transform transition-transform duration-250 ease-out ${
          open ? "translate-x-0" : "translate-x-full pointer-events-none"
        }`}
        role="dialog"
        aria-modal="true"
        aria-label={t`Settings`}
        aria-hidden={!open}
      >
        {open ? <SettingsPanel variant="drawer" onClose={onClose} /> : null}
      </div>
    </>
  );
}
