import { useEffect, useState } from "react";
import { useLingui } from "@lingui/react/macro";
import { msg } from "@lingui/core/macro";
import type { MessageDescriptor } from "@lingui/core";

import { ProfileStatPicker, useExtraStatPreviews } from "#/components/player/ProfileStatCards";
import { fetchLiveSupporterProfileLook, forgetLiveSupporterLook } from "#/lib/live-backend";
import { DEFAULT_PROFILE_STATS, type ProfileStatId, type ProfileStatsData } from "#/lib/profile-stats";
import { saveSupporterProfileStatsSetting } from "#/lib/supporter-look-settings";

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
            onChange={change}
            disabled={!supporter}
          />
        ))}
      </div>
      {error && <p className="mt-2 text-[12px] text-osu-red-light">{t`That didn't save. Try again.`}</p>}
    </section>
  );
}

const PERKS: { title: MessageDescriptor; body: MessageDescriptor }[] = [
  { title: msg`Profile theme`, body: msg`Your whole profile takes on a theme, with a living backdrop behind it.` },
  { title: msg`Avatar frame`, body: msg`A frame around your avatar on your profile.` },
  { title: msg`Name style and font`, body: msg`Your name in its own style and font, on your profile and in every list it shows up in.` },
  { title: msg`Card foil and art`, body: msg`The light and the art on every copy of your card in packs, or an image of your own.` },
  { title: msg`Packs cosmetics`, body: msg`Keep your cards in a 3D case (toploader, magnetic case or graded slab), show your collection as binder pages, and print your packs on your own wrapper.` },
  { title: msg`Profile stats`, body: msg`Swap the four cards under your profile for your ratio, rice / LN split, longest streak or percentile.` },
  { title: msg`Video share links`, body: msg`After exporting a replay video, get a link that plays it right in Discord chat. Links last 24 hours.` },
  { title: msg`A week for a friend`, body: msg`A one-time code that gives someone else a week of supporter.` },
];

export function SupporterPerks() {
  const { t, i18n } = useLingui();
  return (
    <section>
      <h2 className="text-[13px] font-semibold text-white">{t`What supporting gets you`}</h2>
      <dl className="mt-3 grid gap-x-6 sm:grid-cols-2">
        {PERKS.map((perk) => (
          <div key={perk.title.id} className="border-t border-white/[0.07] py-2.5">
            <dt className="text-[13px] font-semibold text-osu-l2">{i18n._(perk.title)}</dt>
            <dd className="mt-0.5 text-[12px] leading-snug text-osu-f1">{i18n._(perk.body)}</dd>
          </div>
        ))}
      </dl>
    </section>
  );
}
