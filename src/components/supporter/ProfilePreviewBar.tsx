import { useEffect, useState, useSyncExternalStore } from "react";
import { Link } from "@tanstack/react-router";
import { Trans } from "@lingui/react/macro";
import { setSupporterLookPreview, subscribeSupporterLookPreview, supporterLookPreviewFor } from "#/lib/live-backend";
import { endSupporterProfilePreview, storedSupporterProfilePreview } from "#/lib/supporter-preview";

/* The viewer's own profile wearing what they tried on at /supporter
   (supporter-preview.ts). `ownUserId` is the viewer's id while they are on
   their own profile, null anywhere else. Returns whether the preview is on,
   and a key that changes when a reload brings it back after hydration (the
   server rendered the real look, so the page mounts again in the preview). */
export function useSupporterProfilePreview(ownUserId: number | null): { previewing: boolean; remountKey: number; end: () => void } {
  const [remountKey, setRemountKey] = useState(0);
  const previewing = useSyncExternalStore(
    subscribeSupporterLookPreview,
    () => ownUserId !== null && supporterLookPreviewFor(ownUserId) !== null,
    () => false,
  );

  // a reload of the previewed profile: put it back on, after hydration
  useEffect(() => {
    if (ownUserId === null || supporterLookPreviewFor(ownUserId)) return;
    const stored = storedSupporterProfilePreview(ownUserId);
    if (!stored) return;
    setSupporterLookPreview(ownUserId, stored);
    setRemountKey((key) => key + 1);
  }, [ownUserId]);

  // Leaving the profile ends it: on to someone else's, or off the profile
  // altogether. Checked a tick later, since a remount (StrictMode, the reload
  // above) also runs the cleanup while staying on the page.
  useEffect(() => {
    if (ownUserId === null) {
      endSupporterProfilePreview();
      return;
    }
    return () => {
      window.setTimeout(endIfLeft, 0);
    };
  }, [ownUserId]);

  // the page mounts again in the real look
  const end = () => {
    endSupporterProfilePreview();
    setRemountKey((key) => key + 1);
  };

  return { previewing, remountKey, end };
}

/* Ends the preview unless the page is still a profile with it on: the hook
   that keeps it re-reads the stored one if this ran during a remount. */
function endIfLeft() {
  if (typeof window === "undefined") return;
  if (window.location.pathname.startsWith("/player/") && document.querySelector("[data-supporter-preview]")) return;
  endSupporterProfilePreview();
}

/* Pinned to the bottom of the previewed profile: what this is, and the way out. */
export function ProfilePreviewBar({ supporter, onEnd }: { supporter: boolean; onEnd: () => void }) {
  return (
    <div data-supporter-preview className="pointer-events-none fixed inset-x-0 bottom-4 z-[90] flex justify-center px-3">
      <div className="pointer-events-auto flex flex-wrap items-center justify-center gap-x-4 gap-y-2 rounded-2xl border border-white/10 bg-osu-b3/95 px-4 py-2.5 shadow-[0_12px_40px_rgba(0,0,0,0.55)] backdrop-blur">
        <p className="text-[13px] text-osu-l2">
          <span className="font-semibold text-white"><Trans>Supporter preview</Trans></span>
          <span className="mx-2 inline-block h-3 w-px translate-y-[2px] bg-white/15" aria-hidden />
          <Trans>Only you can see this</Trans>
        </p>
        <div className="flex items-center gap-2">
          <Link to="/supporter" className="rounded-full bg-white/10 px-3 py-1.5 text-[12px] font-semibold text-white transition-colors hover:bg-white/15">
            <Trans>Back to supporter</Trans>
          </Link>
          {!supporter ? (
            <Link to="/support" className="rounded-full bg-osu-pink px-3 py-1.5 text-[12px] font-semibold text-white transition-colors hover:bg-osu-pink-light">
              <Trans>Become a supporter</Trans>
            </Link>
          ) : null}
          <button
            type="button"
            onClick={onEnd}
            className="cursor-pointer rounded-full px-3 py-1.5 text-[12px] font-semibold text-osu-f1 transition-colors hover:text-white"
          >
            <Trans>End preview</Trans>
          </button>
        </div>
      </div>
    </div>
  );
}
