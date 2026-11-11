import { previewMascot, rememberPreviewMascot } from "#/lib/supporter-preview";
import { useEffect, useRef, useState } from "react";
import { useLingui } from "@lingui/react/macro";
import { msg } from "@lingui/core/macro";
import type { MessageDescriptor } from "@lingui/core";

import { HoursCard, LnSplitCard, NotesCard, PercentileCard, ProfileStatPicker, RatioCard, SessionCard, SkillCard, SkillKeymodeChoice, StatPreviewCell, StreakCard, useExtraStatPreviews } from "#/components/player/ProfileStatCards";
import { fetchLiveSubmittedCompanions, fetchLiveSupporterProfileLook, forgetLiveSupporterLook } from "#/lib/live-backend";
import { DEFAULT_PROFILE_STATS, type ProfileStatId, type ProfileStatsData } from "#/lib/profile-stats";
import { fetchOwnSupporterCompanions, saveSupporterCompanionSetting, saveSupporterProfileSkillKeysSetting, saveSupporterProfileStatsSetting, submitSupporterCompanion } from "#/lib/supporter-look-settings";
import { deleteAdminCompanion, loadAdminCompanions, setAdminCompanionListed } from "#/lib/admin-supporters";
import { BUILT_IN_COMPANIONS, builtInCompanion, COMPANION_NAME_MAX, companionId, type SubmittedCompanion, type SupporterCompanion } from "#/lib/supporter-companions";
import { useAuth } from "#/lib/auth-context";
import { Loader2 } from "lucide-react";
import { GradeImg } from "#/components/ui/GradeImg";
import { CompanionFigure, CompanionThumb } from "./Companion";
import { UploadIcon } from "./LoadoutIcons";
import { BinderBook, FrameThumb } from "./LoadoutSlots";
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
  const [skillKeys, setSkillKeys] = useState<number | null>(null);
  const [error, setError] = useState(false);
  const previews = useExtraStatPreviews(data);

  useEffect(() => {
    let alive = true;
    void fetchLiveSupporterProfileLook(viewerId).then((value) => {
      if (!alive) return;
      setStats(value.profileStats ?? DEFAULT_PROFILE_STATS);
      setData(value.profileStatsData);
      setSkillKeys(value.profileSkillKeys);
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
      case "notes": return <NotesCard notes={data.notes} />;
      case "skill": return <SkillCard userId={viewerId} keyCount={skillKeys} />;
      case "hours": return <HoursCard hours={data.hours} />;
      default: return <StatPreviewCell stat={stat} preview={previews[stat] ?? t`On your profile`} />;
    }
  };

  const changeSkillKeys = (keys: number | null) => {
    const before = skillKeys;
    setSkillKeys(keys);
    setError(false);
    saveSupporterProfileSkillKeysSetting({ data: { skillKeyCount: keys } })
      .then(() => forgetLiveSupporterLook(viewerId))
      .catch(() => {
        setSkillKeys(before);
        setError(true);
      });
  };
  const skillExtra = (slots: readonly ProfileStatId[]) => slots.includes("skill") ? <SkillKeymodeChoice userId={viewerId} value={skillKeys} onChange={changeSkillKeys} /> : null;

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
            extra={skillExtra}
            disabled={!supporter}
          />
        ))}
      </div>
      {error && <p className="mt-2 text-[12px] text-osu-red-light">{t`That didn't save. Try again.`}</p>}
    </section>
  );
}

/* --- Companion ----------------------------------------------------------- */

const NONE = "none";

/* The companion beside the viewer's profile numbers: the site's own, the listed
   submissions and the viewer's own unlisted ones in one list. Pointing at one
   shows it in the preview; clicking puts it on the profile. A supporter can
   submit their own (a .glb model or an image), theirs alone until an admin
   lists it with their name on it. An admin sees every submission and can
   list, unlist or delete any. */
export function CompanionSection({ viewerId, supporter }: { viewerId: number; supporter: boolean }) {
  const { t, i18n } = useLingui();
  const auth = useAuth();
  const [saved, setSaved] = useState<string>(NONE);
  const [hovered, setHovered] = useState<string | null>(null);
  // a tile takes the preview only once the pointer rests on it, so crossing
  // other tiles on the way to the preview (to drag it) leaves it alone
  const hoverTimer = useRef(0);
  const pointAt = (id: string) => {
    window.clearTimeout(hoverTimer.current);
    hoverTimer.current = window.setTimeout(() => setHovered(id), 140);
  };
  const pointAway = () => window.clearTimeout(hoverTimer.current);
  useEffect(() => () => window.clearTimeout(hoverTimer.current), []);
  const [submitted, setSubmitted] = useState<SubmittedCompanion[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [draftName, setDraftName] = useState("");
  const [draftFile, setDraftFile] = useState<File | null>(null);
  const [formOpen, setFormOpen] = useState(false);

  useEffect(() => {
    let alive = true;
    void fetchLiveSupporterProfileLook(viewerId).then((value) => {
      if (!alive) return;
      if (value.companion) setSaved(companionId(value.companion));
      else if (!supporter) {
        // what they picked for the profile preview, this session
        const tried = previewMascot();
        if (tried) setSaved(companionId(tried));
      }
    });
    const lists = auth.isAdmin
      ? [loadAdminCompanions()]
      : [fetchOwnSupporterCompanions().catch(() => []), fetchLiveSubmittedCompanions().catch(() => [])];
    void Promise.all(lists).then((found) => {
      if (alive) setSubmitted(found.flat());
    }).catch(() => {});
    return () => {
      alive = false;
    };
  }, [viewerId, auth.isAdmin, supporter]);

  const choices: Array<{ id: string; companion: SupporterCompanion }> = [
    ...BUILT_IN_COMPANIONS.map((builtIn) => ({ id: builtIn.id, companion: { builtIn } })),
    ...submitted.map((entry) => ({ id: entry.id, companion: { submitted: entry } })),
  ];
  const find = (id: string | null) => choices.find((choice) => choice.id === id)?.companion ?? null;
  const shownId = hovered ?? saved;
  const shown = find(shownId);

  const pick = (id: string) => {
    if (id === saved) return;
    if (!supporter) {
      // nothing saves; kept for "Preview on my profile"
      setSaved(id);
      rememberPreviewMascot(id === NONE ? null : find(id));
      return;
    }
    const before = saved;
    setSaved(id);
    setError(null);
    saveSupporterCompanionSetting({ data: { companion: id === NONE ? null : id } })
      .then(() => forgetLiveSupporterLook(viewerId))
      .catch((reason: unknown) => {
        setSaved(before);
        setError(reason instanceof Error ? reason.message : t`That didn't save. Try again.`);
      });
  };

  const remove = (id: string) => {
    void deleteAdminCompanion({ data: { id } }).then(() => {
      setSubmitted((list) => list.filter((entry) => entry.id !== id));
      if (saved === id) setSaved(NONE);
      setHovered(null);
    }).catch((reason: unknown) => setError(reason instanceof Error ? reason.message : String(reason)));
  };

  const setListed = (id: string, listed: boolean) => {
    void setAdminCompanionListed({ data: { id, listed } }).then(() => {
      setSubmitted((list) => list.map((entry) => (entry.id === id ? { ...entry, listed } : entry)));
    }).catch((reason: unknown) => setError(reason instanceof Error ? reason.message : String(reason)));
  };

  const submit = async () => {
    if (!draftFile || !draftName.trim()) return;
    setSubmitting(true);
    setError(null);
    try {
      const response = await fetch("/api/supporter-companion", { method: "POST", headers: { "content-type": draftFile.type || "application/octet-stream" }, body: draftFile });
      const body = await response.json().catch(() => null) as { url?: unknown; kind?: unknown; error?: unknown } | null;
      if (!response.ok || typeof body?.url !== "string") throw new Error(typeof body?.error === "string" ? body.error : t`Could not upload that file.`);
      const { companion } = await submitSupporterCompanion({ data: { name: draftName, kind: body.kind, url: body.url } });
      setSubmitted((list) => [companion, ...list]);
      setDraftName("");
      setDraftFile(null);
      setFormOpen(false);
      pick(companion.id);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setSubmitting(false);
    }
  };

  const credit = shown && "builtIn" in shown ? shown.builtIn.credit : null;
  const by = shown && "submitted" in shown ? shown.submitted.submittedBy : null;
  const unlisted = shown && "submitted" in shown && !shown.submitted.listed;
  const shownName = !shown ? t`No mascot` : "builtIn" in shown ? i18n._(shown.builtIn.name) : shown.submitted.name;
  const tile = (active: boolean) =>
    `relative grid h-[58px] place-items-center overflow-hidden rounded-[10px] bg-osu-b6 transition-[box-shadow,background-color] ${active ? "ring-2 ring-osu-pink" : "ring-1 ring-inset ring-white/[0.06] hover:bg-osu-b4"} ${supporter ? "cursor-pointer" : "cursor-default"}`;

  return (
    <section>
      <h2 className="text-[13px] font-semibold text-white">{t`Mascot`}</h2>
      <p className="mt-1 text-[12px] text-osu-f1">{t`A figure that stands beside your profile's numbers. Drag a 3D one to turn it.`}</p>
      {/* the preview keeps the last one rested on, so it can be dragged */}
      <div className="mt-3 grid gap-4 sm:grid-cols-[150px_minmax(0,1fr)]" onMouseLeave={() => {
        pointAway();
        setHovered(null);
      }}>
        <div className="flex flex-col items-center rounded-xl bg-osu-b6/60 p-3 ring-1 ring-inset ring-white/[0.05]">
          <div className="relative h-[150px] w-[120px]">
            {shown && (
              <>
                <span className="pointer-events-none absolute inset-x-5 bottom-0 h-3 rounded-full bg-black/40 blur-md" />
                <CompanionFigure companion={shown} />
              </>
            )}
          </div>
          <p className="mt-2 max-w-full truncate text-center text-[12px] font-semibold text-osu-l2">{shownName}</p>
          {credit && (
            <a href={credit.url} target="_blank" rel="noreferrer" className="mt-0.5 text-center text-[10.5px] leading-tight text-osu-f1 hover:text-white">
              {credit.basedOn ? t`Based on a model by ${credit.author}` : t`Model by ${credit.author}`}
            </a>
          )}
          {by && (
            <a href={`/player/${encodeURIComponent(by.username || String(by.id))}`} className="mt-0.5 text-center text-[10.5px] text-osu-f1 hover:text-white">
              {t`by ${by.username || by.id}`}
            </a>
          )}
          {unlisted && (
            <p className="mt-1 text-center text-[10.5px] leading-tight text-osu-f1">
              {by?.id === viewerId ? t`Only on your profile until it's reviewed` : t`Waiting for review`}
            </p>
          )}
          {by && auth.isAdmin && shown && "submitted" in shown && (
            <div className="mt-2 flex flex-col items-center">
              <button type="button" onClick={() => setListed(shown.submitted.id, !shown.submitted.listed)} className="cursor-pointer rounded-md px-2 py-1 text-[11px] font-semibold text-osu-l2 hover:bg-white/[0.06]">
                {shown.submitted.listed ? t`Take off the list` : t`Add to the list`}
              </button>
              <button type="button" onClick={() => remove(shown.submitted.id)} className="cursor-pointer rounded-md px-2 py-1 text-[11px] font-semibold text-osu-red-light hover:bg-osu-red/15">
                {t`Delete for everyone`}
              </button>
            </div>
          )}
        </div>
        <div className="min-w-0">
          <div className="grid grid-cols-[repeat(auto-fill,minmax(58px,1fr))] gap-1.5">
            <button
              type="button"
              aria-label={t`No mascot`}
              disabled={!supporter}
              onMouseEnter={() => pointAt(NONE)}
              onMouseLeave={pointAway}
              onFocus={() => setHovered(NONE)}
              onClick={() => pick(NONE)}
              className={tile(saved === NONE)}
            >
              <span className="h-5 w-5 rounded-full border-2 border-osu-f1/60" />
            </button>
            {choices.map((choice) => (
              <button
                key={choice.id}
                type="button"
                disabled={!supporter}
                aria-label={"builtIn" in choice.companion ? i18n._(choice.companion.builtIn.name) : choice.companion.submitted.name}
                onMouseEnter={() => pointAt(choice.id)}
                onMouseLeave={pointAway}
                onFocus={() => setHovered(choice.id)}
                onClick={() => pick(choice.id)}
                className={tile(saved === choice.id)}
              >
                <CompanionThumb companion={choice.companion} className="h-[50px] w-[50px]" />
              </button>
            ))}
            {supporter && (
              <button
                type="button"
                onClick={() => setFormOpen((open) => !open)}
                className={`${tile(formOpen)} text-osu-f1 hover:text-white`}
                aria-label={t`Submit your own`}
              >
                <UploadIcon className="h-5 w-5" />
              </button>
            )}
          </div>
          {formOpen && supporter && (
            <div className="mt-3 rounded-xl bg-osu-b6/60 p-3 ring-1 ring-inset ring-white/[0.05]">
              <p className="text-[12px] leading-snug text-osu-f1">
                {t`A .glb model (up to 100,000 triangles, textures inside it) or an image, up to 10 MB. It goes on your profile right away. Once it's reviewed, it can be added to this list for everyone, with your name on it.`}
              </p>
              <div className="mt-3 flex flex-wrap items-center gap-2">
                <label className="cursor-pointer rounded-lg bg-osu-b4 px-3 py-1.5 text-[12px] font-semibold text-white hover:bg-osu-b3">
                  {draftFile ? draftFile.name : t`Choose a file`}
                  <input
                    type="file"
                    accept=".glb,model/gltf-binary,image/png,image/webp,image/jpeg,image/gif"
                    className="hidden"
                    onChange={(event) => setDraftFile(event.target.files?.[0] ?? null)}
                  />
                </label>
                <input
                  value={draftName}
                  maxLength={COMPANION_NAME_MAX}
                  onChange={(event) => setDraftName(event.target.value)}
                  placeholder={t`Its name`}
                  className="h-8 min-w-0 flex-1 rounded-lg bg-osu-b5 px-2.5 text-[12px] text-white outline-none ring-1 ring-inset ring-white/[0.08] placeholder:text-osu-f1 focus:ring-osu-pink/60"
                />
                <button
                  type="button"
                  disabled={!draftFile || !draftName.trim() || submitting}
                  onClick={() => void submit()}
                  className="inline-flex h-8 cursor-pointer items-center gap-1.5 rounded-lg bg-osu-pink px-3 text-[12px] font-bold text-white transition hover:brightness-110 disabled:cursor-default disabled:opacity-40"
                >
                  {submitting && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
                  {t`Submit`}
                </button>
              </div>
            </div>
          )}
          {error && <p className="mt-2 text-[12px] text-osu-red-light">{error}</p>}
        </div>
      </div>
    </section>
  );
}

type PerkId = "theme" | "frame" | "name" | "card" | "packs" | "stats" | "plays" | "companion" | "clips" | "dms" | "gift";

const PERKS: { id: PerkId; title: MessageDescriptor; body: MessageDescriptor }[] = [
  { id: "theme", title: msg`Profile theme`, body: msg`Your whole profile takes on a theme, with a living backdrop behind it.` },
  { id: "frame", title: msg`Avatar frame`, body: msg`A frame around your avatar on your profile.` },
  { id: "name", title: msg`Name style and font`, body: msg`Your name in its own style and font, on your profile and in every list it shows up in.` },
  { id: "card", title: msg`Card foil and art`, body: msg`The light on every copy of your card in packs, and an image of your own on it.` },
  { id: "packs", title: msg`Packs cosmetics`, body: msg`Keep your cards in a 3D case (toploader, magnetic case or graded slab), show your collection as binder pages, print your packs on your own wrapper, and open them with your own blade.` },
  { id: "stats", title: msg`Profile stats`, body: msg`Swap the four cards under your profile for your ratio, rice / LN split, longest streak, longest session or percentile.` },
  { id: "plays", title: msg`Your own plays`, body: msg`Put any play the site tracked of you under your profile stats, with a title of your own and its pp, rating or dan.` },
  { id: "companion", title: msg`Mascot`, body: msg`A figure that stands beside your profile's numbers. Pick one from the list, or submit your own.` },
  { id: "clips", title: msg`Video share links`, body: msg`After exporting a replay video, get a link that plays it right in Discord chat.` },
  { id: "dms", title: msg`DMs from the bot`, body: msg`Optional Discord DMs when you get sniped, finish a goal or someone pulls your card, and a weekly recap. Off until you turn them on from the Discord bot page.` },
  { id: "gift", title: msg`A week for a friend`, body: msg`A one-time code that gives someone else a week of supporter.` },
];

/* A pack printed on the holo wrapper: a still of the canvas the packs draw
   (wrapperThumb), saved as a file so the tile shows it with the page instead
   of drawing it in after load. */
function PackThumb() {
  return <img src="/images/supporter-perks/pack-holo.webp" alt="" width={28} height={46} className="h-[46px] w-[28px] rounded-[2px] object-cover shadow-[0_2px_6px_rgba(0,0,0,0.5)]" />;
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
      // a still of the holo foil, not the live shader: the tile only needs to show what it is
      return <img src="/images/supporter-perks/foil-holo.webp" alt="" width={32} height={44} className="h-[44px] w-[32px] -rotate-6 rounded-[6px] object-cover shadow-[0_2px_6px_rgba(0,0,0,0.5)]" />;
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
      // a featured play card in miniature: the map's cover dimmed as on the
      // profile, the grade and the pp it shows
      return (
        <span className="relative block h-[36px] w-[50px] overflow-hidden rounded-[5px] bg-osu-b4 shadow-[0_3px_8px_rgba(0,0,0,0.55)] ring-1 ring-inset ring-white/[0.1]">
          <img src="/images/supporter-perks/play-cover.webp" alt="" width={50} height={36} className="absolute inset-0 h-full w-full object-cover brightness-[0.6]" />
          <span className="absolute inset-0 bg-gradient-to-r from-black/45 via-black/10 to-black/60" />
          <span className="relative flex h-full items-end justify-between px-[4px] pb-[4px]">
            <GradeImg grade="S" size={14} className="h-[9px] w-auto" />
            <span className="flex flex-col items-end">
              <span className="text-[13px] font-black leading-none tabular-nums text-osu-pink-light">512</span>
              <span className="mt-[1px] text-[5px] font-semibold uppercase leading-none tracking-wider text-white/55">pp</span>
            </span>
          </span>
        </span>
      );
    case "companion":
      return <CompanionThumb companion={{ builtIn: builtInCompanion("fumo-cirno")! }} className="h-[50px] w-[50px]" />;
    case "dms":
      return <img src="/images/discord/bot-avatar.png" alt="" width={40} height={40} className="h-[40px] w-[40px] rounded-full shadow-[0_2px_6px_rgba(0,0,0,0.5)]" />;
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
