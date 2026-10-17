import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { msg } from "@lingui/core/macro";
import { useLingui } from "@lingui/react/macro";
import { motion, useReducedMotion } from "framer-motion";
import { ExternalLink } from "lucide-react";

import { PageHeader } from "../components/layout/PageHeader";
import { LoadoutStage } from "../components/supporter/LoadoutStage";
import { LoadoutDrawer, LoadoutSlots, type CustomMotif } from "../components/supporter/LoadoutSlots";
import { DiceIcon } from "../components/supporter/LoadoutIcons";
import { GiftCodePanel, RedeemGiftCode } from "../components/supporter/GiftCodePanel";
import { useSettled } from "../components/supporter/use-settled";
import { useHighwayNotes } from "../components/supporter/use-highway-notes";
import { mainKeymode, useHighwayChart } from "../components/supporter/use-highway-chart";
import {
  DEFAULT_LOOK,
  LOADOUT_COMBINATIONS,
  randomSlotValue,
  sameLook,
  SLOT_IDS,
  slotValue,
  withSlot,
  type Loadout,
  type SlotId,
  type SlotValue,
} from "../components/supporter/loadout";
import { avatarImageSrc } from "../components/ui/Avatar";
import { useAuth } from "../lib/auth-context";
import { getI18n } from "../lib/i18n";
import { formatNumber } from "../lib/format";
import {
  fetchLivePackCardSnapshotDirect,
  forgetLiveSupporterLook,
  setSupporterFrameLocally,
  setSupporterNameStyleLocally,
  type LivePackCardSnapshot,
} from "../lib/live-backend";
import type { SupporterLook } from "../lib/supporter-card-looks";
import { profileThemeStyle } from "../lib/supporter-profile-themes";
import { rememberViewerSupporter } from "../lib/viewer-supporter";
import {
  fetchSupporterLookState,
  saveSupporterFrameSetting,
  saveSupporterLookSetting,
  saveSupporterNameFontSetting,
  saveSupporterNameStyleSetting,
  saveSupporterProfileThemeSetting,
  type SupporterLookState,
} from "../lib/supporter-look-settings";

/* Supporter perks as a loadout: the theme of the viewer's whole profile, the
   frame around their avatar, the style and font of their name, and the art
   and foil every copy of their card wears. The page itself takes on the
   theme being shown. The stage shows the loadout on them; the slots beside it open a
   drawer of items, where pointing at one tries it on and clicking puts it in.
   The dice rolls every unlocked slot, and the roll waits to be kept or undone.
   A supporter's loadout saves as it changes; anyone else can try everything
   on, with nothing saved. The profile itself only draws what was saved. */

const KOFI_PAGE_URL = "https://ko-fi.com/aleju03";
const NO_SCORES: [] = [];
const MAX_UPLOAD_BYTES = 5 * 1024 * 1024;
const SLIDER_SAVE_DELAY_MS = 450;
/* Reels: how often a spinning slot changes, when the first stops, and the gap to the next. */
const REEL_TICK_MS = 70;
const REEL_FIRST_STOP_MS = 520;
const REEL_STOP_GAP_MS = 190;

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

function loadoutOf(state: SupporterLookState): Loadout {
  return { theme: state.profileTheme, themeOptions: state.profileThemeOptions, frame: state.frame, nameStyle: state.nameStyle, nameFont: state.nameFont, look: state.look ?? DEFAULT_LOOK };
}

function SupporterPage() {
  const { t, i18n } = useLingui();
  const viewer = useAuth().viewer;
  const reduced = useReducedMotion();
  const [state, setState] = useState<SupporterLookState | null>(null);
  const [card, setCard] = useState<LivePackCardSnapshot | null | undefined>(undefined);
  /* What the slots hold. For a supporter it runs ahead of the server while saves are in flight. */
  const [equipped, setEquipped] = useState<Loadout | null>(null);
  /* A roll that landed and waits to be kept or undone. */
  const [pending, setPending] = useState<Loadout | null>(null);
  const [hover, setHover] = useState<{ slot: SlotId; value: SlotValue } | null>(null);
  /* The reels while a roll spins: what each spinning slot shows this tick. */
  const [reel, setReel] = useState<Loadout | null>(null);
  const [open, setOpen] = useState<SlotId>("theme");
  const [locks, setLocks] = useState<ReadonlySet<SlotId>>(() => new Set());
  const [pop, setPop] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /* The loadout the server last confirmed, which a failed save falls back to. */
  const saved = useRef<Loadout | null>(null);
  const saveChain = useRef<Promise<void>>(Promise.resolve());
  const sliderTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const reelTimers = useRef<ReturnType<typeof setTimeout>[]>([]);
  /* Bumped when a gift code turns the viewer into a supporter, to load the page again as one. */
  const [reload, setReload] = useState(0);

  useEffect(() => {
    if (!viewer) return;
    let alive = true;
    fetchSupporterLookState()
      .then((next) => {
        if (!alive) return;
        setState(next);
        rememberViewerSupporter(viewer.id, next.supporter ? next.expiresAt : null);
        saved.current = loadoutOf(next);
        setEquipped(loadoutOf(next));
      })
      .catch(() => alive && setEquipped({ theme: null, themeOptions: {}, frame: null, nameStyle: null, nameFont: null, look: DEFAULT_LOOK }));
    fetchLivePackCardSnapshotDirect(String(viewer.id))
      .then((next) => alive && setCard(next))
      .catch(() => alive && setCard(null));
    return () => {
      alive = false;
    };
  }, [viewer?.id, reload]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => () => {
    if (sliderTimer.current) clearTimeout(sliderTimer.current);
    reelTimers.current.forEach(clearTimeout);
  }, []);

  const supporter = state?.supporter === true;
  const customLook = equipped?.look.motif === "custom" && equipped.look.url ? equipped.look : null;
  const customUrl = customLook?.url ?? state?.custom?.url ?? null;
  const customScale = customLook ? customLook.scale ?? 1 : state?.custom?.scale ?? 1;
  const customOpacity = customLook ? customLook.opacity ?? 0.85 : state?.custom?.opacity ?? 0.85;
  // One object per image, size and strength, so the drawer's props hold still between renders.
  const custom: CustomMotif | null = useMemo(
    () => (customUrl ? { url: customUrl, scale: customScale, opacity: customOpacity } : null),
    [customUrl, customScale, customOpacity],
  );

  /* Writes what changed between the last saved loadout and `next`, one save
     at a time in order, so a quick run of picks lands as the last one. */
  const persist = (next: Loadout) => {
    if (!supporter || !viewer) return;
    saveChain.current = saveChain.current.then(async () => {
      const before = saved.current;
      if (!before) return;
      let latest: SupporterLookState | null = null;
      setBusy(true);
      try {
        if (next.theme !== before.theme || !!next.themeOptions.charts !== !!before.themeOptions.charts) {
          latest = await saveSupporterProfileThemeSetting({ data: { profileTheme: next.theme, profileThemeOptions: next.themeOptions } });
        }
        if (next.frame !== before.frame) latest = await saveSupporterFrameSetting({ data: { frame: next.frame } });
        if (next.nameStyle !== before.nameStyle) latest = await saveSupporterNameStyleSetting({ data: { nameStyle: next.nameStyle } });
        if (next.nameFont !== before.nameFont) latest = await saveSupporterNameFontSetting({ data: { nameFont: next.nameFont } });
        if (!sameLook(next.look, before.look)) latest = await saveSupporterLookSetting({ data: next.look });
        if (latest) {
          setState(latest);
          saved.current = loadoutOf(latest);
          forgetLiveSupporterLook(viewer.id);
          setSupporterFrameLocally(viewer.id, latest.frame);
          setSupporterNameStyleLocally(viewer.id, latest.nameStyle, latest.nameFont);
        }
      } catch (cause) {
        if (latest) saved.current = loadoutOf(latest);
        setEquipped(saved.current);
        setError(cause instanceof Error ? cause.message : t`Could not save that.`);
      } finally {
        setBusy(false);
      }
    });
  };

  const equip = (next: Loadout) => {
    setError(null);
    setEquipped(next);
    setPop((n) => n + 1);
    persist(next);
  };

  const pick = (slot: SlotId, value: SlotValue) => {
    if (!equipped) return;
    setHover(null);
    if (pending) {
      setPending(withSlot(pending, slot, value, custom));
      setPop((n) => n + 1);
      return;
    }
    if (slotValue(equipped, slot) === value) return;
    equip(withSlot(equipped, slot, value, custom));
  };

  /* A theme's own switches go in with the theme, waiting with a roll like any pick. */
  const setThemeOptions = (themeOptions: Loadout["themeOptions"]) => {
    if (!equipped) return;
    if (pending) {
      setPending({ ...pending, themeOptions });
      return;
    }
    equip({ ...equipped, themeOptions });
  };

  /* Sliders on the viewer's own image show every step and save once they stop. */
  const adjust = (look: SupporterLook) => {
    if (!equipped) return;
    if (pending) {
      setPending({ ...pending, look });
      return;
    }
    const next = { ...equipped, look };
    setEquipped(next);
    if (sliderTimer.current) clearTimeout(sliderTimer.current);
    sliderTimer.current = setTimeout(() => persist(next), SLIDER_SAVE_DELAY_MS);
  };

  const upload = async (file: File) => {
    setError(null);
    if (file.size > MAX_UPLOAD_BYTES) {
      setError(t`That image is over 5 MB.`);
      return;
    }
    setBusy(true);
    try {
      const response = await fetch("/api/supporter-motif", { method: "POST", headers: { "content-type": file.type || "application/octet-stream" }, body: file });
      const body = await response.json().catch(() => null) as { url?: unknown; error?: unknown } | null;
      if (!response.ok || typeof body?.url !== "string") throw new Error(typeof body?.error === "string" ? body.error : t`Could not upload that image.`);
      setBusy(false);
      const base = pending ?? equipped;
      if (!base) return;
      const look: SupporterLook = { motif: "custom", foil: base.look.foil, url: body.url, scale: custom?.scale ?? 1, opacity: custom?.opacity ?? 0.85 };
      if (pending) setPending({ ...pending, look });
      else equip({ ...base, look });
    } catch (cause) {
      setBusy(false);
      setError(cause instanceof Error ? cause.message : t`Could not upload that image.`);
    }
  };

  const spinning = reel !== null;
  const rollable = SLOT_IDS.filter((slot) => !locks.has(slot));

  /* Every unlocked slot spins and lands on something new, one after another,
     left to wait as a pending roll. */
  const roll = () => {
    const base = pending ?? equipped;
    if (!base || spinning || rollable.length === 0) return;
    setHover(null);
    setError(null);
    let target = base;
    for (const slot of rollable) target = withSlot(target, slot, randomSlotValue(slot, slotValue(base, slot)));
    if (reduced) {
      setPending(target);
      setPop((n) => n + 1);
      return;
    }
    const stopped = new Set<SlotId>();
    let current = base;
    setReel(current);
    const tick = setInterval(() => {
      for (const slot of rollable) {
        if (!stopped.has(slot)) current = withSlot(current, slot, randomSlotValue(slot, slotValue(current, slot)));
      }
      setReel(current);
    }, REEL_TICK_MS);
    rollable.forEach((slot, index) => {
      reelTimers.current.push(setTimeout(() => {
        stopped.add(slot);
        current = withSlot(current, slot, slotValue(target, slot), custom);
        setReel(current);
        if (stopped.size === rollable.length) {
          clearInterval(tick);
          reelTimers.current = [];
          setReel(null);
          setPending(target);
          setPop((n) => n + 1);
        }
      }, REEL_FIRST_STOP_MS + index * REEL_STOP_GAP_MS));
    });
    reelTimers.current.push(tick as unknown as ReturnType<typeof setTimeout>);
  };

  const keep = () => {
    if (!pending) return;
    const next = pending;
    setPending(null);
    equip(next);
  };

  /* Everything back to bare, waiting like a roll, so Keep saves it and Undo takes it back. */
  const BARE: Loadout = { theme: null, themeOptions: {}, frame: null, nameStyle: null, nameFont: null, look: DEFAULT_LOOK };
  const clearAll = () => {
    if (!equipped || spinning) return;
    setHover(null);
    setError(null);
    setPending(BARE);
    setPop((n) => n + 1);
  };
  const bare = !!equipped && equipped.theme === null && equipped.frame === null && equipped.nameStyle === null && equipped.nameFont === null && sameLook(equipped.look, DEFAULT_LOOK);

  const undo = () => {
    setPending(null);
    setPop((n) => n + 1);
  };

  useEffect(() => {
    if (!pending) return;
    const onKey = (event: KeyboardEvent) => event.key === "Escape" && undo();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [pending]); // eslint-disable-line react-hooks/exhaustive-deps

  const toggleLock = (slot: SlotId) => setLocks((prev) => {
    const next = new Set(prev);
    if (next.has(slot)) next.delete(slot);
    else next.add(slot);
    return next;
  });

  const held = pending ?? equipped;
  const shown = reel ?? (held && hover ? withSlot(held, hover.slot, hover.value, custom) : held);
  const viewerKeys = useMemo(() => mainKeymode(card?.bestScores), [card]);
  const highwayNotes = useHighwayNotes(viewer?.id, viewerKeys, shown?.theme === "highway" || shown?.theme === "judgements");
  const highwayChart = useHighwayChart(viewer?.id, card?.bestScores, highwayNotes?.lanes ?? viewerKeys ?? 4, shown?.theme === "highway" && !!shown.themeOptions.charts);
  /* The card holds still while the reels spin, and its art waits for the
     pointer to rest: new art repaints every texture on the card, where a new
     foil only swaps two shader values, so the foil follows at once. One
     object per look, since the card rebuilds its data on a new one. */
  const lookNow = (spinning ? held : shown)?.look ?? DEFAULT_LOOK;
  const artKey = `${lookNow.motif}|${lookNow.url ?? ""}|${lookNow.scale ?? ""}|${lookNow.opacity ?? ""}`;
  const art = useSettled(lookNow, 160, artKey);
  const settledArtKey = `${art.motif}|${art.url ?? ""}|${art.scale ?? ""}|${art.opacity ?? ""}`;
  const cardLook = useMemo<SupporterLook>(
    () => ({ ...art, foil: lookNow.foil }),
    [settledArtKey, lookNow.foil], // eslint-disable-line react-hooks/exhaustive-deps
  );

  /* Stable handlers for the drawer, so a hover (which re-renders the page)
     does not re-render every tile in it. */
  const latest = useRef({ pick, adjust, upload, setThemeOptions });
  latest.current = { pick, adjust, upload, setThemeOptions };
  const onTry = useCallback((slot: SlotId, value: SlotValue | undefined) => setHover(value === undefined ? null : { slot, value }), []);
  const onPick = useCallback((slot: SlotId, value: SlotValue) => latest.current.pick(slot, value), []);
  const onUpload = useCallback((file: File) => void latest.current.upload(file), []);
  const onAdjust = useCallback((look: SupporterLook) => latest.current.adjust(look), []);
  const onThemeOptions = useCallback((options: Loadout["themeOptions"]) => latest.current.setThemeOptions(options), []);

  const giftFrom = state?.giftFrom ?? null;
  const until = supporter && state?.expiresAt
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
  const stageCard = useMemo(
    () => (card === null || !cardUser ? null : { user: cardUser, scores: card?.bestScores ?? NO_SCORES, loading: card === undefined }),
    [card, cardUser],
  );

  const footer = pending && !spinning ? (
    <>
      <button type="button" onClick={keep} className="h-9 cursor-pointer rounded-full bg-osu-pink px-5 text-[13px] font-semibold text-white transition hover:brightness-110">
        {t`Keep`}
      </button>
      <RollButton onClick={roll} disabled={rollable.length === 0} spinning={false} label={t`Roll again`} />
      <button type="button" onClick={undo} className="h-9 cursor-pointer rounded-full px-4 text-[13px] font-semibold text-osu-l2 transition-colors hover:text-white">
        {t`Undo`}
      </button>
    </>
  ) : (
    <>
      <RollButton onClick={roll} disabled={rollable.length === 0 || !equipped} spinning={spinning} label={t`Roll`} />
      {locks.size > 0 && (
        <span className="text-[11px] text-osu-f1">{t`${locks.size} locked`}</span>
      )}
      <button
        type="button"
        onClick={clearAll}
        disabled={!equipped || spinning || bare}
        className="ml-auto h-9 cursor-pointer rounded-full px-4 text-[13px] font-semibold text-osu-l2 transition-colors hover:text-white disabled:cursor-default disabled:opacity-40 disabled:hover:text-osu-l2"
      >
        {t`Clear all`}
      </button>
    </>
  );

  return (
    <div className="flex-1">
      <PageHeader iconSrc="/images/icons/supporter-heart.svg" title={t`supporter`} right={status} />
      <div className="min-h-[80vh] bg-osu-b5" style={profileThemeStyle(shown?.theme ?? null, highwayNotes)}>
        <div className="mx-auto max-w-[1200px] px-3 py-6 sm:px-5 sm:py-8">
          {!viewer ? (
            <p className="py-10 text-center text-[13px] text-osu-f1">
              <a href={`/api/auth/osu?next=${encodeURIComponent("/supporter")}`} className="font-semibold text-osu-pink-light hover:underline">
                {t`Log in with osu!`}
              </a>{" "}
              {t`to set up your avatar frame, name tag and card look.`}
            </p>
          ) : (
            <>
              {state?.supporter && giftFrom ? (
                <div className="mb-6">
                  <p className="text-[22px] font-semibold text-white">{t`Enjoy your supporter week, ${viewer.username}.`}</p>
                  <p className="mt-1 text-[13px] text-osu-l2">{t`${giftFrom} gave you a week of supporter.`}</p>
                </div>
              ) : state?.supporter ? (
                <div className="mb-6">
                  <p className="text-[22px] font-semibold text-white">{t`Thank you for supporting, ${viewer.username}.`}</p>
                  <p className="mt-1 text-[13px] text-osu-l2">
                    {t`Your support pays for the servers and gives me the time to keep working on the site. It means a lot, and these extras are my way of saying thanks.`}
                  </p>
                  <GiftCodePanel viewerId={viewer.id} />
                </div>
              ) : state ? (
                <div className="mb-6">
                  {state.expiresAt ? (
                    <p className="text-[22px] font-semibold text-white">{t`Thank you for supporting before, ${viewer.username}.`}</p>
                  ) : null}
                  <p className="mt-1 text-[13px] text-osu-f1">
                    {t`Everything here is a preview until you support. Use your osu! username as your Ko-fi name so it counts for you.`}
                  </p>
                  <RedeemGiftCode viewerId={viewer.id} onClaimed={() => setReload((n) => n + 1)} />
                </div>
              ) : null}

              <div className="grid items-start gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,440px)]">
                {/* Below lg only the avatar and name stay in view; the card is too tall to. */}
                <div className={`z-20 lg:sticky lg:top-[76px] ${open === "motif" || open === "foil" ? "" : "max-lg:sticky max-lg:top-[60px]"}`}>
                  {shown && held ? (
                    <LoadoutStage
                      shown={shown}
                      notes={highwayNotes}
                      chart={highwayChart}
                      cardLook={cardLook}
                      username={viewer.username}
                      avatar={avatar}
                      card={stageCard}
                      focus={open === "motif" || open === "foil" ? "card" : "hero"}
                      pop={pop}
                      spinning={spinning}
                      footer={footer}
                    />
                  ) : (
                    <div className="h-[280px] animate-pulse rounded-2xl bg-osu-b6" />
                  )}
                </div>

                {shown && held && (
                  <div className="min-w-0">
                    <p className="mb-2 text-right text-[12px] text-osu-f1">
                      <span className="font-semibold tabular-nums text-osu-l2">{formatNumber(LOADOUT_COMBINATIONS)}</span> {t`possible looks`}
                    </p>
                    <LoadoutSlots
                      shown={shown}
                      open={open}
                      onOpen={setOpen}
                      locks={locks}
                      onToggleLock={toggleLock}
                      spinning={spinning}
                      trying={hover && !spinning ? hover.slot : null}
                      avatar={avatar}
                    />
                    <div className="mt-4 border-t border-white/[0.07] pt-4">
                      <LoadoutDrawer
                        slot={open}
                        current={held}
                        disabled={spinning || busy}
                        avatar={avatar}
                        username={viewer.username}
                        custom={custom}
                        canUpload={supporter}
                        onTry={onTry}
                        onPick={onPick}
                        onUpload={onUpload}
                        onAdjust={onAdjust}
                        onThemeOptions={onThemeOptions}
                      />
                      {error && <div className="mt-3 text-[12px] text-osu-red-light">{error}</div>}
                    </div>
                  </div>
                )}
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function RollButton({ onClick, disabled, spinning, label }: { onClick: () => void; disabled: boolean; spinning: boolean; label: string }) {
  const reduced = useReducedMotion();
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled || spinning}
      className="inline-flex h-9 cursor-pointer items-center gap-2 rounded-full bg-osu-b4 pl-3 pr-4 text-[13px] font-semibold text-white transition-colors hover:bg-osu-b3 disabled:cursor-default disabled:opacity-60"
    >
      <motion.span
        className="inline-flex"
        animate={spinning && !reduced ? { rotate: 360 } : { rotate: 0 }}
        transition={spinning ? { duration: 0.45, ease: "linear", repeat: Infinity } : { duration: 0 }}
      >
        <DiceIcon className="h-5 w-5" />
      </motion.span>
      {label}
    </button>
  );
}
