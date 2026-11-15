import { useEffect, useState } from "react";
import { Trans } from "@lingui/react/macro";
import { TriangleAlert } from "lucide-react";
import { DEFAULT_COUNTRY_CODE } from "#/lib/country";
import { fetchOsuStatusDirect, isLiveBackendConfigured, openLiveEventSource, type LiveOsuStatus } from "#/lib/live-backend";

/* A strip under the nav while osu! is down. The backend decides from its own
   osu! calls (backend/src/osu/outage.ts): read once on mount and on every
   stream reconnect, then moved by the country-less `osu_status` event, which
   the backend doesn't log, so a reconnect has to read it again. Renders
   nothing during SSR, while osu! is up, or when the backend is unreachable. */
export function OsuOutageBanner() {
  const [status, setStatus] = useState<LiveOsuStatus | null>(null);

  useEffect(() => {
    // ?osuOutagePreview=1 shows the banner without an outage, to check its look.
    if (new URLSearchParams(window.location.search).has("osuOutagePreview")) {
      setStatus({ down: true, since: null });
      return;
    }
    if (!isLiveBackendConfigured()) return;
    let cancelled = false;
    const read = () => {
      void fetchOsuStatusDirect().then((next) => {
        if (!cancelled && next) setStatus(next);
      });
    };
    const onStatus = (event: MessageEvent) => {
      try {
        setStatus(JSON.parse(event.data) as LiveOsuStatus);
      } catch {
        // Malformed frame: the next reconnect reads the truth.
      }
    };
    const source = openLiveEventSource(DEFAULT_COUNTRY_CODE, { observe: true });
    source?.addEventListener("osu_status", onStatus);
    source?.addEventListener("open", read);
    read();
    return () => {
      cancelled = true;
      source?.removeEventListener("osu_status", onStatus);
      source?.removeEventListener("open", read);
      source?.close();
    };
  }, []);

  if (!status?.down) return null;
  return (
    <div role="status" className="relative z-10 border-b border-amber-500/20 bg-amber-950/40 px-4 py-2 text-center text-[12px] text-amber-200">
      <TriangleAlert aria-hidden="true" className="mr-1.5 inline h-3.5 w-3.5 align-[-2px] text-amber-300" />
      <Trans>osu! is down right now. New scores, profiles and rankings will catch up once it's back.</Trans>
    </div>
  );
}
