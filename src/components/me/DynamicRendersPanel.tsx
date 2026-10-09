import type { ReactNode } from "react";
import { useLocation } from "@tanstack/react-router";
import { useLingui } from "@lingui/react/macro";

import { PageHeader } from "../layout/PageHeader";
import { OsuLogo } from "../ui/OsuLogo";
import { GalleryView } from "./dynamic-renders/GalleryView";
import { useDynamicRenders } from "./dynamic-renders/use-dynamic-renders";

/* Dynamic renders: auto-updating images a player embeds on their osu! profile.
   The image route itself stays public, since the point is that anyone viewing
   a profile can load the picture. */

/* `center` is for the states that are one sentence and a button. No skeleton
   while the settings load: the page resolves into either a one-line pitch or
   the whole editor, so any placeholder would be a guess at the wrong one. */
function PageShell({
  children,
  center = false,
  enter = false,
}: { children?: ReactNode; center?: boolean; enter?: boolean }) {
  const { t } = useLingui();
  return (
    <div className="min-h-screen">
      <PageHeader iconSrc="/images/icons/contests.svg" title={t`dynamic renders`} />
      <div className="min-h-[80vh] bg-osu-b5">
        <div
          className={`${center
            ? "mx-auto flex min-h-[68vh] w-full max-w-[560px] flex-col items-center justify-center px-4 text-center"
            : "mx-auto w-full max-w-[940px] px-3 py-5 sm:px-5 sm:py-7"}${enter ? " signature-enter" : ""}`}
        >
          {children}
        </div>
      </div>
    </div>
  );
}

export function DynamicRendersPanel() {
  const { t } = useLingui();
  const location = useLocation();
  const renders = useDynamicRenders();
  const { viewer, loading, settings, isLive, busy } = renders;

  if (!viewer) {
    const loginHref = `/api/auth/osu?next=${encodeURIComponent(`${location.pathname}${location.searchStr}`)}`;
    return (
      <PageShell center>
        <div className="text-[17px] font-bold text-white">{t`Log in with osu! to set one up.`}</div>
        <a
          href={loginHref}
          className="mt-4 inline-flex h-11 items-center gap-2 rounded-xl border border-osu-pink/45 bg-osu-pink/15 px-5 text-[13px] font-bold text-osu-pink-light transition-colors hover:bg-osu-pink/25 hover:text-white"
        >
          <OsuLogo className="h-4 w-4" />
          {t`Log in with osu!`}
        </a>
      </PageShell>
    );
  }

  if (loading) return <PageShell />;

  /* Blocked. Said plainly, with no controls: nothing the player does here
     would bring the images back. No actor named. */
  if (settings?.blockedAt) {
    return (
      <PageShell center enter>
        <div className="text-[17px] font-bold text-white">{t`Your dynamic renders were turned off.`}</div>
        <div className="mt-2.5 text-[13.5px] leading-5 text-osu-f1">
          {t`Any image you pasted has stopped loading. Get in touch if you think that is a mistake.`}
        </div>
      </PageShell>
    );
  }

  if (!isLive) {
    return (
      <PageShell center enter>
        <div className="text-[22px] font-bold leading-snug text-white">
          {t`A customizable picture for your osu! profile that keeps itself updated.`}
        </div>
        <div className="mt-2.5 text-[13.5px] leading-5 text-osu-f1">
          {t`Paste it once. It redraws when your stats change.`}
        </div>
        <button
          type="button"
          disabled={busy}
          onClick={() => void renders.setUp()}
          className="mt-5 inline-flex h-11 items-center rounded-xl border border-osu-pink/45 bg-osu-pink/15 px-5 text-[13px] font-bold text-osu-pink-light transition-colors hover:bg-osu-pink/25 hover:text-white cursor-pointer disabled:opacity-50"
        >
          {busy ? t`Setting up...` : t`Get my link`}
        </button>
      </PageShell>
    );
  }

  return (
    <PageShell enter>
      <GalleryView renders={renders} />
    </PageShell>
  );
}
