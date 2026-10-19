import { useEffect, useState } from "react";
import { useLingui } from "@lingui/react/macro";
import { msg } from "@lingui/core/macro";
import type { MessageDescriptor } from "@lingui/core";

import { LnSplitCard, PercentileCard, ProfileStatPicker, RatioCard, SessionCard, StatPreviewCell, StreakCard, useExtraStatPreviews } from "#/components/player/ProfileStatCards";
import { fetchLiveSupporterProfileLook, forgetLiveSupporterLook } from "#/lib/live-backend";
import { DEFAULT_PROFILE_STATS, type ProfileStatId, type ProfileStatsData } from "#/lib/profile-stats";
import { saveSupporterProfileStatsSetting } from "#/lib/supporter-look-settings";
import { BinderBook, FoilCard, FrameThumb, wrapperThumb } from "./LoadoutSlots";
import { ProfileThemeSwatch } from "./ProfileThemeBackdrop";
import { SupporterStyledName } from "./SupporterNameStyle";

/* The /supporter page's two sections under the loadout: the four stat cards
   under the viewer's profile (the same picker as the profile's own corner
   buttons), and every perk supporting brings, so the page says all of it in
   one place, including the ones that live elsewhere on the site. */

export function ProfileStatsSection({ viewerId, supporter }: { viewerId: number; supporter: boolean }) {
  const { t } = useLingui();
  const [stats, setStats] = useState<readonly ProfileStatId[]>(DEFAULT_PROFILE_STATS);
  const [data, setData] = useState<ProfileStatsData>({});
  const [error, setError] = useState(false);
  const previews = useExtraStatPreviews(data);

  useEffect(() => {
    let alive = true;
    void fetchLiveSupporterProfileLook(viewerId).then((value) => {
      if (!alive) return;
      setStats(value.profileStats ?? DEFAULT_PROFILE_STATS);
      setData(value.profileStatsData);
    });
    return () => {
      alive = false;
    };
  }, [viewerId]);

  // The usual four need the profile's own numbers, which this page has not
  // loaded; they show by name, the extras as the real cards.
  const renderCell = (stat: ProfileStatId) => {
    switch (stat) {
      case "ratio": return <RatioCard ratio={data.ratio} />;
      case "lnSplit": return <LnSplitCard lnSplit={data.lnSplit} />;
      case "streak": return <StreakCard streak={data.streak} />;
      case "percentile": return <PercentileCard percentile={data.percentile} />;
      case "session": return <SessionCard session={data.session} />;
      default: return <StatPreviewCell stat={stat} preview={previews[stat] ?? t`On your profile`} />;
    }
  };

  const change = (next: ProfileStatId[]) => {
    const before = stats;
    setStats(next);
    setError(false);
    const isDefault = next.every((stat, index) => stat === DEFAULT_PROFILE_STATS[index]);
    saveSupporterProfileStatsSetting({ data: { profileStats: isDefault ? null : next } })
      .then(() => forgetLiveSupporterLook(viewerId))
      .catch(() => {
        setStats(before);
        setError(true);
      });
  };

  return (
    <section>
      <h2 className="text-[13px] font-semibold text-white">{t`Profile stats`}</h2>
      <p className="mt-1 text-[12px] text-osu-f1">
        {t`The four cards under your profile's numbers. Swap any of them, here or from the card itself on your profile.`}
      </p>
      <div className="mt-3 grid gap-1.5 sm:grid-cols-2">
        {stats.map((stat, slot) => (
          <ProfileStatPicker
            key={`${slot}:${stat}`}
            variant="field"
            slot={slot}
            slots={stats}
            previews={previews}
            renderCell={renderCell}
            onChange={change}
            disabled={!supporter}
          />
        ))}
      </div>
      {error && <p className="mt-2 text-[12px] text-osu-red-light">{t`That didn't save. Try again.`}</p>}
    </section>
  );
}

type PerkId = "theme" | "frame" | "name" | "card" | "packs" | "stats" | "plays" | "clips" | "gift";

const PERKS: { id: PerkId; title: MessageDescriptor; body: MessageDescriptor }[] = [
  { id: "theme", title: msg`Profile theme`, body: msg`Your whole profile takes on a theme, with a living backdrop behind it.` },
  { id: "frame", title: msg`Avatar frame`, body: msg`A frame around your avatar on your profile.` },
  { id: "name", title: msg`Name style and font`, body: msg`Your name in its own style and font, on your profile and in every list it shows up in.` },
  { id: "card", title: msg`Card foil and art`, body: msg`The light and the art on every copy of your card in packs, or an image of your own.` },
  { id: "packs", title: msg`Packs cosmetics`, body: msg`Keep your cards in a 3D case (toploader, magnetic case or graded slab), show your collection as binder pages, print your packs on your own wrapper, and open them with your own blade.` },
  { id: "stats", title: msg`Profile stats`, body: msg`Swap the four cards under your profile for your ratio, rice / LN split, longest streak, longest session or percentile.` },
  { id: "plays", title: msg`Your own plays`, body: msg`Put any play the site tracked of you under your profile stats, with a title of your own and its pp, MSD or dan.` },
  { id: "clips", title: msg`Video share links`, body: msg`After exporting a replay video, get a link that plays it right in Discord chat.` },
  { id: "gift", title: msg`A week for a friend`, body: msg`A one-time code that gives someone else a week of supporter.` },
];

/* A pack printed on the holo wrapper, drawn once on the client (the art is a canvas). */
function PackThumb() {
  const [src, setSrc] = useState<string | null>(null);
  useEffect(() => setSrc(wrapperThumb("holo")), []);
  return src ? <img src={src} alt="" className="h-[46px] w-[28px] rounded-[2px] object-cover shadow-[0_2px_6px_rgba(0,0,0,0.5)]" /> : null;
}

/* Each perk's tile: a small piece of the real thing where there is one. */
function PerkArt({ id, avatar }: { id: PerkId; avatar: string | undefined }) {
  switch (id) {
    case "theme":
      return <ProfileThemeSwatch theme="sakura" still className="absolute inset-0 h-full w-full" />;
    case "frame":
      return <FrameThumb frame="autumn-maple" avatar={avatar} size={50} />;
    case "name":
      return <SupporterStyledName nameStyle="sunset" nameFont={null} name="Aa" className="text-[22px] font-bold leading-none" />;
    case "card":
      return <FoilCard foil="holo" className="h-[44px] w-[32px] -rotate-6 shadow-[0_2px_6px_rgba(0,0,0,0.5)]" />;
    case "packs":
      return (
        <span className="flex items-end gap-1">
          <PackThumb />
          <BinderBook binder="leather" className="h-[36px] w-[28px]" />
        </span>
      );
    case "stats":
      return (
        <span className="w-[42px]">
          <span className="block text-[15px] font-bold leading-none text-osu-l2">62<span className="text-[9px] text-osu-f1">%</span></span>
          <span className="mt-1.5 flex h-[3px] overflow-hidden rounded-full">
            <span className="w-[62%] bg-osu-blue" />
            <span className="flex-1 bg-osu-pink" />
          </span>
        </span>
      );
    case "plays":
      return (
        <span className="text-center leading-none">
          <span className="block text-[15px] font-bold text-white">33.6</span>
          <span className="mt-1 block text-[8px] font-semibold uppercase tracking-[0.12em] text-osu-f1">MSD</span>
        </span>
      );
    case "clips":
      return (
        <svg viewBox="0 0 44 30" aria-hidden className="w-[44px]">
          <rect x="0" y="0" width="44" height="30" rx="3" fill="#2b2d31" />
          <rect x="0" y="0" width="2.5" height="30" rx="1.2" fill="#5865f2" />
          <rect x="7" y="5" width="32" height="20" rx="2" fill="#111214" />
          <path d="M20 10.5 L27 15 L20 19.5 Z" fill="#fff" />
        </svg>
      );
    case "gift":
      return (
        <svg viewBox="0 0 48 28" aria-hidden className="w-[46px] -rotate-6">
          <path d="M3 2 H45 a2 2 0 0 1 2 2 V10 a4 4 0 0 0 0 8 V24 a2 2 0 0 1 -2 2 H3 a2 2 0 0 1 -2 -2 V18 a4 4 0 0 0 0 -8 V4 a2 2 0 0 1 2 -2 Z" fill="#ff66aa" />
          <path d="M34 4 V24" stroke="#fff" strokeOpacity="0.55" strokeWidth="1" strokeDasharray="2 2" />
          <text x="18" y="17.5" textAnchor="middle" fontSize="9" fontWeight="700" fill="#fff">7d</text>
        </svg>
      );
  }
}

export function SupporterPerks({ avatar }: { avatar?: string }) {
  const { t, i18n } = useLingui();
  return (
    <section>
      <h2 className="text-[13px] font-semibold text-white">{t`What supporting gets you`}</h2>
      <dl className="mt-3 grid gap-x-5 gap-y-1 sm:grid-cols-2">
        {PERKS.map((perk) => (
          <div key={perk.id} className="flex gap-3 rounded-xl p-2 transition-colors hover:bg-white/[0.03]">
            <span className="relative grid h-[56px] w-[56px] shrink-0 place-items-center overflow-hidden rounded-[10px] bg-osu-b6 ring-1 ring-inset ring-white/[0.06]">
              <PerkArt id={perk.id} avatar={avatar} />
            </span>
            <div className="min-w-0 pt-0.5">
              <dt className="text-[13px] font-semibold text-osu-l2">{i18n._(perk.title)}</dt>
              <dd className="mt-0.5 text-[12px] leading-snug text-osu-f1">{i18n._(perk.body)}</dd>
            </div>
          </div>
        ))}
      </dl>
    </section>
  );
}
