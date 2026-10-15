import { useEffect, useMemo, useState } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { msg } from "@lingui/core/macro";
import { useLingui } from "@lingui/react/macro";
import { ExternalLink } from "lucide-react";

import { PageHeader } from "../components/layout/PageHeader";
import { Panel } from "../components/companella/primitives";
import { ManiaCard3DPanel as ManiaCardPanel } from "../components/player/maniacard3d/LazyManiaCard3DPanel";
import { frameOverhangMargins, SupporterAvatarFrame } from "../components/player/SupporterAvatarFrame";
import { SupporterFramePicker } from "../components/supporter/SupporterFramePicker";
import { SupporterLookPicker } from "../components/supporter/SupporterLookPicker";
import { SupporterStyledName } from "../components/supporter/SupporterNameStyle";
import { SupporterNameStylePicker } from "../components/supporter/SupporterNameStylePicker";
import { avatarImageSrc } from "../components/ui/Avatar";
import { useAuth } from "../lib/auth-context";
import { getI18n } from "../lib/i18n";
import { fetchLivePackCardSnapshotDirect, forgetLiveSupporterLook, setSupporterFrameLocally, setSupporterNameStyleLocally, type LivePackCardSnapshot } from "../lib/live-backend";
import { framedAvatarStyle, type SupporterAvatarFrameId } from "../lib/supporter-avatar-frames";
import type { SupporterLook } from "../lib/supporter-card-looks";
import {
  fetchSupporterLookState,
  saveSupporterFrameSetting,
  saveSupporterNameFontSetting,
  saveSupporterNameStyleSetting,
  type SupporterLookState,
} from "../lib/supporter-look-settings";
import type { SupporterNameFontId } from "../lib/supporter-name-fonts";
import type { SupporterNameStyleId } from "../lib/supporter-name-styles";

/* Supporter perks in one place: the frame around the viewer's avatar and the
   style of their name on their profile, and the look every copy of their card
   wears. A supporter's picks
   save as they are made; anyone else can try them on here, with nothing
   saved. The profile itself only draws what was saved. */

const KOFI_PAGE_URL = "https://ko-fi.com/aleju03";
const NO_SCORES: [] = [];
const PREVIEW_NAME_CLASS = "min-w-0 truncate p-2 -m-2 text-[26px] font-black leading-none text-white sm:text-[40px]";

export const Route = createFileRoute("/supporter")({
  head: ({ match }) => {
    const i18n = getI18n(match.context.locale);
    return {
      meta: [
        { title: i18n._(msg`Supporter`) },
        { name: "description", content: "" },
        { name: "robots", content: "noindex, nofollow" },
      ],
    };
  },
  component: SupporterPage,
});

function SupporterPage() {
  const { t, i18n } = useLingui();
  const viewer = useAuth().viewer;
  const [state, setState] = useState<SupporterLookState | null>(null);
  const [frame, setFrame] = useState<SupporterAvatarFrameId | null>(null);
  const [savingFrame, setSavingFrame] = useState(false);
  const [frameError, setFrameError] = useState<string | null>(null);
  const [nameStyle, setNameStyle] = useState<SupporterNameStyleId | null>(null);
  const [savingNameStyle, setSavingNameStyle] = useState(false);
  const [nameStyleError, setNameStyleError] = useState<string | null>(null);
  const [nameFont, setNameFont] = useState<SupporterNameFontId | null>(null);
  const [lookPreview, setLookPreview] = useState<SupporterLook | undefined>(undefined);
  const [card, setCard] = useState<LivePackCardSnapshot | null | undefined>(undefined);

  useEffect(() => {
    if (!viewer) return;
    let alive = true;
    fetchSupporterLookState()
      .then((next) => {
        if (!alive) return;
        setState(next);
        setFrame(next.frame);
        setNameStyle(next.nameStyle);
        setNameFont(next.nameFont);
      })
      .catch(() => {});
    fetchLivePackCardSnapshotDirect(String(viewer.id))
      .then((next) => alive && setCard(next))
      .catch(() => alive && setCard(null));
    return () => {
      alive = false;
    };
  }, [viewer?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const pickFrame = async (next: SupporterAvatarFrameId | null) => {
    setFrame(next);
    setFrameError(null);
    if (!state?.supporter || !viewer) return;
    setSavingFrame(true);
    try {
      const saved = await saveSupporterFrameSetting({ data: { frame: next } });
      setState(saved);
      forgetLiveSupporterLook(viewer.id);
      setSupporterFrameLocally(viewer.id, saved.frame);
    } catch (cause) {
      setFrame(state.frame);
      setFrameError(cause instanceof Error ? cause.message : t`Could not save that.`);
    } finally {
      setSavingFrame(false);
    }
  };

  const pickNameStyle = async (next: SupporterNameStyleId | null) => {
    setNameStyle(next);
    setNameStyleError(null);
    if (!state?.supporter || !viewer) return;
    setSavingNameStyle(true);
    try {
      const saved = await saveSupporterNameStyleSetting({ data: { nameStyle: next } });
      setState(saved);
      forgetLiveSupporterLook(viewer.id);
      setSupporterNameStyleLocally(viewer.id, saved.nameStyle, saved.nameFont);
    } catch (cause) {
      setNameStyle(state.nameStyle);
      setNameStyleError(cause instanceof Error ? cause.message : t`Could not save that.`);
    } finally {
      setSavingNameStyle(false);
    }
  };

  const pickNameFont = async (next: SupporterNameFontId | null) => {
    setNameFont(next);
    setNameStyleError(null);
    if (!state?.supporter || !viewer) return;
    setSavingNameStyle(true);
    try {
      const saved = await saveSupporterNameFontSetting({ data: { nameFont: next } });
      setState(saved);
      forgetLiveSupporterLook(viewer.id);
      setSupporterNameStyleLocally(viewer.id, saved.nameStyle, saved.nameFont);
    } catch (cause) {
      setNameFont(state.nameFont);
      setNameStyleError(cause instanceof Error ? cause.message : t`Could not save that.`);
    } finally {
      setSavingNameStyle(false);
    }
  };

  const until = state?.supporter && state.expiresAt
    ? new Date(state.expiresAt).toLocaleDateString(i18n.locale, { month: "short", day: "numeric", year: "numeric" })
    : null;
  const status = !viewer || !state ? null : until ? (
    <span className="text-[12px] text-osu-l2">{t`Supporter until ${until}`}</span>
  ) : (
    <a
      href={KOFI_PAGE_URL}
      target="_blank"
      rel="noopener noreferrer"
      className="inline-flex items-center gap-1.5 rounded-full bg-osu-pink px-4 py-1.5 text-[12px] font-semibold text-white transition hover:brightness-110"
    >
      {t`Support on Ko-fi`}
      <ExternalLink className="h-3 w-3" aria-hidden="true" />
    </a>
  );

  const avatar = viewer ? avatarImageSrc(viewer.avatarUrl, viewer.id) : undefined;
  // One object per snapshot, so the 3D card does not rebuild on every render.
  const cardUser = useMemo(() => {
    if (card) return { ...card.user, statistics: { global_rank: card.user.statistics.global_rank, pp: card.user.statistics.pp ?? undefined } };
    return viewer ? { id: viewer.id, username: viewer.username, avatar_url: viewer.avatarUrl, country_code: viewer.countryCode ?? "" } : null;
  }, [card, viewer]);

  return (
    <div className="flex-1">
      <PageHeader iconSrc="/images/icons/supporter-heart.svg" title={t`supporter`} right={status} />
      <div className="min-h-[80vh] bg-osu-b5">
        <div className="mx-auto max-w-[1000px] space-y-8 px-3 py-6 sm:px-5 sm:py-8">
          {!viewer ? (
            <p className="py-10 text-center text-[13px] text-osu-f1">
              <a href={`/api/auth/osu?next=${encodeURIComponent("/supporter")}`} className="font-semibold text-osu-pink-light hover:underline">
                {t`Log in with osu!`}
              </a>{" "}
              {t`to set up your avatar frame, name tag and card look.`}
            </p>
          ) : (
            <>
              {state?.supporter ? (
                <div className="py-2">
                  <p className="text-[22px] font-semibold text-white">{t`Thank you for supporting, ${viewer.username}.`}</p>
                  <p className="mt-1 text-[13px] text-osu-l2">
                    {t`Your support pays for the servers and gives me the time to keep working on the site. It means a lot, and these extras are my way of saying thanks.`}
                  </p>
                </div>
              ) : state ? (
                <div className="py-2">
                  {state.expiresAt ? (
                    <p className="text-[22px] font-semibold text-white">{t`Thank you for supporting before, ${viewer.username}.`}</p>
                  ) : null}
                  <p className="mt-1 text-[13px] text-osu-f1">
                    {t`Everything here is a preview until you support. Use your osu! username as your Ko-fi name so it counts for you.`}
                  </p>
                </div>
              ) : null}

              <Panel title={t`Avatar frame`}>
                {/* Sized and laid out like the profile hero, so the preview is
                    what the profile shows. Fixed height, so the grid under it
                    does not move between frames. */}
                <div className="flex min-h-[260px] items-center overflow-hidden rounded-xl bg-osu-b6/60 px-4 py-6 sm:min-h-[300px] sm:px-8">
                  <div className="flex w-full flex-wrap items-center gap-x-4 gap-y-3 sm:gap-x-5">
                    <div
                      className="relative flex-shrink-0 [--preview-avatar:84px] sm:[--preview-avatar:124px]"
                      style={frame ? frameOverhangMargins(frame, "var(--preview-avatar)") : undefined}
                    >
                      <img
                        src={avatar}
                        alt=""
                        className="h-[84px] w-[84px] rounded-2xl object-cover sm:h-[124px] sm:w-[124px]"
                        style={framedAvatarStyle(frame)}
                      />
                      {frame && <SupporterAvatarFrame frame={frame} />}
                    </div>
                    {/* The name shrinks to its text as in the hero's h1, so a
                        name style's gradient and plate size to the name. */}
                    <div className="flex min-w-0 flex-1 basis-[11rem]">
                      {nameStyle || nameFont ? (
                        <SupporterStyledName nameStyle={nameStyle} nameFont={nameFont} name={viewer.username} className={PREVIEW_NAME_CLASS} live />
                      ) : (
                        <span className={PREVIEW_NAME_CLASS}>{viewer.username}</span>
                      )}
                    </div>
                  </div>
                </div>
                <div className="mt-4">
                  <SupporterFramePicker frame={frame} avatar={avatar} disabled={savingFrame} onPick={(next) => void pickFrame(next)} />
                  {frameError && <div className="mt-2 text-[12px] text-osu-red-light">{frameError}</div>}
                </div>
              </Panel>

              <Panel title={t`Name tag`}>
                <SupporterNameStylePicker
                  nameStyle={nameStyle}
                  nameFont={nameFont}
                  onPickFont={(next) => void pickNameFont(next)}
                  username={viewer.username}
                  disabled={savingNameStyle}
                  onPick={(next) => void pickNameStyle(next)}
                />
                {nameStyleError && <div className="mt-2 text-[12px] text-osu-red-light">{nameStyleError}</div>}
              </Panel>

              <Panel title={t`Card`}>
                <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
                  <div className="min-w-0">
                    {card === null ? (
                      <p className="py-10 text-center text-[13px] text-osu-f1">{t`Your card is not ready yet.`}</p>
                    ) : (
                      <ManiaCardPanel
                        user={cardUser!}
                        scores={card?.bestScores ?? NO_SCORES}
                        loading={card === undefined}
                        isOwnProfile
                        supporterLookOverride={lookPreview}
                      />
                    )}
                  </div>
                  {state && (
                    <SupporterLookPicker
                      userId={viewer.id}
                      state={state}
                      onSaved={setState}
                      onPreview={setLookPreview}
                    />
                  )}
                </div>
              </Panel>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
