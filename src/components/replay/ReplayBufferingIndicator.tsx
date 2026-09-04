import { useEffect, useState } from "react";
import { Trans } from "@lingui/react/macro";
import { LoaderCircle } from "lucide-react";

// Brief audio handoffs should not flash an overlay over the playfield.
const SHOW_DELAY_MS = 250;

export function ReplayBufferingIndicator({ loading }: { loading: boolean }) {
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    if (!loading) {
      setVisible(false);
      return;
    }
    const timer = window.setTimeout(() => setVisible(true), SHOW_DELAY_MS);
    return () => window.clearTimeout(timer);
  }, [loading]);

  if (!loading || !visible) return null;

  return (
    <div className="pointer-events-none absolute inset-0 z-10 grid place-items-center" role="status" aria-live="polite" aria-atomic="true">
      <div className="grid h-11 w-11 place-items-center rounded-full bg-black/25 text-white/70 shadow-sm">
        <LoaderCircle className="h-6 w-6 animate-spin motion-reduce:animate-none" strokeWidth={1.7} aria-hidden="true" />
      </div>
      <span className="sr-only"><Trans>Loading...</Trans></span>
    </div>
  );
}
