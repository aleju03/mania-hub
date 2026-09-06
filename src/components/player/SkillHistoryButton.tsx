import { useEffect, useRef, useState } from "react";
import { AnimatePresence } from "framer-motion";
import { History } from "lucide-react";
import { useLingui } from "@lingui/react/macro";
import { SkillHistoryModal } from "./SkillHistoryModal";

export function SkillHistoryButton({ userId, keyCount }: { userId: number; keyCount: number }) {
  const { t } = useLingui();
  const [open, setOpen] = useState(false);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const wasOpen = useRef(false);
  useEffect(() => {
    if (!open && wasOpen.current) buttonRef.current?.focus();
    wasOpen.current = open;
  }, [open]);
  const label = t`View ${keyCount}K skill history`;
  return (
    <>
      <button
        ref={buttonRef}
        type="button"
        onClick={() => setOpen(true)}
        title={label}
        aria-label={label}
        aria-haspopup="dialog"
        className="inline-flex h-8 w-8 shrink-0 cursor-pointer items-center justify-center rounded-lg text-osu-f1 transition-colors hover:bg-osu-b3/40 hover:text-white focus-visible:outline-2 focus-visible:outline-osu-pink-light"
      >
        <History className="h-4 w-4" aria-hidden="true" />
      </button>
      <AnimatePresence>
        {open ? (
          <SkillHistoryModal key={`${userId}:${keyCount}`} userId={userId} keyCount={keyCount} onClose={() => setOpen(false)} />
        ) : null}
      </AnimatePresence>
    </>
  );
}
