import { previewMascot, startSupporterProfilePreview } from "#/lib/supporter-preview";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { track } from "../lib/analytics";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { msg } from "@lingui/core/macro";
import { useLingui } from "@lingui/react/macro";
import { AnimatePresence, motion, useReducedMotion } from "framer-motion";

import { PageHeader } from "../components/layout/PageHeader";
import { LoadoutStage } from "../components/supporter/LoadoutStage";
import { LoadoutDrawer, SlotLock, SupporterNav, type CustomMotif } from "../components/supporter/LoadoutSlots";
import { CustomArtDialog, type CustomArtDraft } from "#/components/supporter/CustomArtDialog";
import { DiceIcon } from "../components/supporter/LoadoutIcons";
import { GiftCodePanel, RedeemGiftCode } from "../components/supporter/GiftCodePanel";
import { SupporterRankLadder } from "../components/supporter/SupporterRankBadge";
import { Switch } from "../components/ui/Switch";
import { useSettled } from "../components/supporter/use-settled";
import { useHighwayNotes } from "../components/supporter/use-highway-notes";
import { mainKeymode, useHighwayChart } from "../components/supporter/use-highway-chart";
import {
  DEFAULT_LOOK,
  LOADOUT_COMBINATIONS,
  isRolledSlot,
  isSlotSection,
  isSupporterSection,
  randomSlotValue,
  SLOT_LABELS,
  sameLook,
  SLOT_IDS,
  slotValue,
  withSlot,
  type Loadout,
  type SlotId,
  type SlotValue,
  type SupporterSection,
} from "../components/supporter/loadout";
import { avatarImageSrc } from "../components/ui/Avatar";
import { useAuth } from "../lib/auth-context";
import { getI18n } from "../lib/i18n";
import { formatNumber } from "../lib/format";
import {
  fetchLivePackCardSnapshotDirect,
  forgetLiveSupporterLook,
  setSupporterFrameLocally,
  setSupporterThemeLocally,
  setSupporterNameOutlineLocally,
  setSupporterNameStyleLocally,
  setSupporterSleeveLocally,
  type LivePackCardSnapshot,
} from "../lib/live-backend";
import type { SupporterLook } from "../lib/supporter-card-looks";
import { parseProfileThemeOptions, profileThemeStyle, type ProfileThemeOptions } from "../lib/supporter-profile-themes";
import { registerWorkshopFrames } from "../lib/supporter-avatar-frames";
import { rememberViewerSupporter } from "../lib/viewer-supporter";
import { CompanionSection, ProfileStatsSection, SupporterPerks } from "../components/supporter/SupporterExtras";
import { NO_PACK_STYLE } from "../lib/supporter-pack-style";
import {
  fetchSupporterLookState,
  saveSupporterFrameSetting,
  saveSupporterLookSetting,
  saveSupporterNameFontSetting,
  saveSupporterNameOutlineSetting,
  saveSupporterNameStyleSetting,
  saveSupporterPackStyleSetting,
  saveSupporterProfileThemeSetting,
  saveSupporterRankFireSetting,
  saveSupporterRankShownSetting,
  type SupporterLookState,
} from "../lib/supporter-look-settings";
import { wearCustomTheme } from "../lib/supporter-custom-themes";

/* Supporter perks as a loadout: the theme of the viewer's whole profile, the
   frame around their avatar, the style and font of their name, and the art
   and foil every copy of their card wears. The page itself takes on the
   theme being shown. The stage shows the loadout on them; the slots beside it open a
   drawer of items, where pointing at one tries it on and clicking puts it in.
   The dice rolls every unlocked slot, and the roll waits to be kept or undone.
   A supporter's loadout saves as it changes; anyone else can try everything
   on, with nothing saved. The profile itself only draws what was saved. */

const NO_SCORES: [] = [];
const MAX_UPLOAD_BYTES = 5 * 1024 * 1024;
/* A card image is stored fitted inside 256px (supporter-motif-upload-server.ts),
   so anything heavier than this is shrunk in the browser first, to twice that,
   and a pasted 20 MB screenshot goes up as a few hundred KB. */
const SHRINK_ABOVE_BYTES = 1024 * 1024;
const SHRINK_TO_PX = 512;

/* The image fitted inside SHRINK_TO_PX as a WebP (alpha kept), or the file as
   it was when it is already light or the browser cannot decode it. */
async function shrinkForUpload(file: File): Promise<Blob> {
  if (file.size <= SHRINK_ABOVE_BYTES || typeof createImageBitmap !== "function") return file;
  try {
    const bitmap = await createImageBitmap(file);
    const fit = Math.min(1, SHRINK_TO_PX / Math.max(bitmap.width, bitmap.height));
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(bitmap.width * fit));
    canvas.height = Math.max(1, Math.round(bitmap.height * fit));
    const context = canvas.getContext("2d");
    if (!context) return file;
    context.imageSmoothingQuality = "high";
    context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    bitmap.close();
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/webp", 0.92));
    // a browser without a WebP encoder hands back a PNG, still small at this size
    return blob ?? file;
  } catch {
    return file;
  }
}
/* Reels: how often a spinning slot changes, when the first stops, and the gap to the next. */
const REEL_TICK_MS = 70;
const REEL_FIRST_STOP_MS = 520;
const REEL_STOP_GAP_MS = 190;
/* How long a preview outlasts the pointer leaving its tile. */
const HOVER_END_MS = 90;

/* Each section opened and each slot tried on counts once per page load, so a
   visitor clicking through every font is one line in the feed, not forty. */
const trackedOnce = new Set<string>();
function trackOnce(event: string) {
  if (trackedOnce.has(event)) return;
  trackedOnce.add(event);
  track(event);
}

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
  validateSearch: (search: Record<string, unknown>): { s?: SupporterSection } => (isSupporterSection(search.s) && search.s !== "theme" ? { s: search.s } : {}),
  component: SupporterPage,
});

function loadoutOf(state: SupporterLookState): Loadout {
  return { theme: state.profileTheme, themeOptions: state.profileThemeOptions, frame: state.frame, nameStyle: state.nameStyle, nameFont: state.nameFont, nameOutline: state.nameOutline, look: state.look ?? DEFAULT_LOOK, pack: state.packStyle };
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
  /* The open section, from the URL: a slot's items, or one of the page's other sections. */
  const section: SupporterSection = Route.useSearch().s ?? "theme";
  const navigate = useNavigate({ from: "/supporter" });
  const openSection = useCallback((next: SupporterSection) => {
    trackOnce(`supporter_section_${next}`);
    void navigate({ search: next === "theme" ? {} : { s: next }, replace: true, resetScroll: false });
  }, [navigate]);
  const open: SlotId | null = isSlotSection(section) ? section : null;
  const [locks, setLocks] = useState<ReadonlySet<SlotId>>(() => new Set());
  const [pop, setPop] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /* The loadout the server last confirmed, which a failed save falls back to. */
  const saved = useRef<Loadout | null>(null);
  const saveChain = useRef<Promise<void>>(Promise.resolve());
  const [artDraft, setArtDraft] = useState<CustomArtDraft | null>(null);
  const [artUploading, setArtUploading] = useState(false);
  const [artError, setArtError] = useState<string | null>(null);
  const reelTimers = useRef<ReturnType<typeof setTimeout>[]>([]);
  /* Bumped when a gift code turns the viewer into a supporter, to load the page again as one. */
  const [reload, setReload] = useState(0);

  useEffect(() => {
    if (!viewer) return;
    let alive = true;
    fetchSupporterLookState()
      .then((next) => {
        if (!alive) return;
        registerWorkshopFrames(next.frameArt ?? {});
        setState(next);
        rememberViewerSupporter(viewer.id, next.supporter ? next.expiresAt : null);
        saved.current = loadoutOf(next);
        setEquipped(loadoutOf(next));
      })
      .catch(() => alive && setEquipped({ theme: null, themeOptions: {}, frame: null, nameStyle: null, nameFont: null, nameOutline: null, look: DEFAULT_LOOK, pack: NO_PACK_STYLE }));
    fetchLivePackCardSnapshotDirect(String(viewer.id))
      .then((next) => alive && setCard(next))
      .catch(() => alive && setCard(null));
    return () => {
      alive = false;
    };
  }, [viewer?.id, reload]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => () => {
    reelTimers.current.forEach(clearTimeout);
  }, []);

  const supporter = state?.supporter === true;
  // A roll waiting to be kept can hold the image too (an upload lands on it).
  const heldLook = (pending ?? equipped)?.look;
  const customLook = heldLook?.motif === "custom" && heldLook.url ? heldLook : null;
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
        if (next.theme !== before.theme || JSON.stringify(parseProfileThemeOptions(next.themeOptions)) !== JSON.stringify(parseProfileThemeOptions(before.themeOptions))) {
          latest = await saveSupporterProfileThemeSetting({ data: { profileTheme: next.theme, profileThemeOptions: next.themeOptions } });
        }
        if (next.frame !== before.frame) latest = await saveSupporterFrameSetting({ data: { frame: next.frame } });
        if (next.nameStyle !== before.nameStyle) latest = await saveSupporterNameStyleSetting({ data: { nameStyle: next.nameStyle } });
        if (next.nameFont !== before.nameFont) latest = await saveSupporterNameFontSetting({ data: { nameFont: next.nameFont } });
        if (next.nameOutline !== before.nameOutline) latest = await saveSupporterNameOutlineSetting({ data: { nameOutline: next.nameOutline } });
        if (!sameLook(next.look, before.look)) latest = await saveSupporterLookSetting({ data: next.look });
        if (next.pack.sleeve !== before.pack.sleeve || next.pack.binder !== before.pack.binder || next.pack.wrapper !== before.pack.wrapper || next.pack.blade !== before.pack.blade) {
          latest = await saveSupporterPackStyleSetting({ data: { packStyle: next.pack } });
          setSupporterSleeveLocally(viewer.id, next.pack.sleeve);
        }
        if (latest) {
          setState(latest);
          saved.current = loadoutOf(latest);
          forgetLiveSupporterLook(viewer.id);
          setSupporterFrameLocally(viewer.id, latest.frame);
          setSupporterThemeLocally(viewer.id, latest.profileThemeOptions.rows ? latest.profileTheme : null);
          setSupporterNameStyleLocally(viewer.id, latest.nameStyle, latest.nameFont);
          setSupporterNameOutlineLocally(viewer.id, latest.nameOutline);
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

  /* One of the viewer's own themes on (or off, with null). It is stored apart
     from the built-ins, so the saved look is read back afterwards: a worn own
     theme leaves no built-in picked. */
  const wearOwnTheme = (themeId: number | null, options?: ProfileThemeOptions) => new Promise<void>((resolve) => {
    if (!supporter || !viewer) {
      resolve();
      return;
    }
    setError(null);
    saveChain.current = saveChain.current.then(async () => {
      setBusy(true);
      try {
        // without options the theme's switches stay as they were
        await wearCustomTheme({ data: { themeId, ...(options ? { rows: !!options.rows, hideCover: !!options.hideCover } : {}) } });
        const latest = await fetchSupporterLookState();
        setState(latest);
        saved.current = loadoutOf(latest);
        setEquipped(saved.current);
        forgetLiveSupporterLook(viewer.id);
        setSupporterThemeLocally(viewer.id, null);
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : t`Could not save that.`);
      } finally {
        setBusy(false);
        resolve();
      }
    });
  });

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
    trackOnce(`supporter_pick_${slot}`);
    equip(withSlot(equipped, slot, value, custom));
  };

  /* A theme's own switches go in with the theme, waiting with a roll like any pick. */
  /* The name's outline: `commit` false only previews it (the colour picker
     moving), true wears and saves it. */
  const [outlinePreview, setOutlinePreview] = useState<string | null | undefined>(undefined);
  const setNameOutline = (nameOutline: string | null, commit: boolean) => {
    if (!equipped) return;
    if (!commit) {
      setOutlinePreview(nameOutline);
      return;
    }
    setOutlinePreview(undefined);
    if (pending) {
      setPending({ ...pending, nameOutline });
      return;
    }
    equip({ ...equipped, nameOutline });
  };

  const setThemeOptions = (themeOptions: Loadout["themeOptions"]) => {
    if (!equipped) return;
    if (pending) {
      setPending({ ...pending, themeOptions });
      return;
    }
    equip({ ...equipped, themeOptions });
  };

  /* The viewer's own image goes through CustomArtDialog: an upload opens
     it with the upload running, the image's tile opens it to adjust, and only
     saving puts it on the card. */
  const upload = async (file: File) => {
    setError(null);
    setArtError(null);
    setArtDraft({ url: null, scale: custom?.scale ?? 1, opacity: custom?.opacity ?? 0.85 });
    setArtUploading(true);
    try {
      const body = await shrinkForUpload(file);
      if (body.size > MAX_UPLOAD_BYTES) throw new Error(t`That image is over 5 MB.`);
      const response = await fetch("/api/supporter-motif", { method: "POST", headers: { "content-type": body.type || file.type || "application/octet-stream" }, body });
      const reply = await response.json().catch(() => null) as { url?: unknown; error?: unknown } | null;
      if (!response.ok || typeof reply?.url !== "string") throw new Error(typeof reply?.error === "string" ? reply.error : t`Could not upload that image.`);
      const url = reply.url;
      setArtDraft((draft) => (draft ? { ...draft, url } : draft));
    } catch (cause) {
      setArtError(cause instanceof Error ? cause.message : t`Could not upload that image.`);
    } finally {
      setArtUploading(false);
    }
  };

  const editCustom = () => {
    if (!custom) return;
    setArtError(null);
    setArtDraft({ url: custom.url, scale: custom.scale, opacity: custom.opacity });
  };

  const saveArt = () => {
    const base = pending ?? equipped;
    if (!artDraft?.url || !base) return;
    const look: SupporterLook = { motif: "custom", foil: base.look.foil, url: artDraft.url, scale: artDraft.scale, opacity: artDraft.opacity };
    if (pending) setPending({ ...pending, look });
    else equip({ ...base, look });
    setArtDraft(null);
  };

  const spinning = reel !== null;
  const rollable = SLOT_IDS.filter((slot) => isRolledSlot(slot) && !locks.has(slot));

  /* Every unlocked slot spins and lands on something new, one after another,
     left to wait as a pending roll. */
  const roll = () => {
    const base = pending ?? equipped;
    if (!base || spinning || rollable.length === 0) return;
    trackOnce("supporter_roll");
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
  const BARE: Loadout = { theme: null, themeOptions: {}, frame: null, nameStyle: null, nameFont: null, nameOutline: null, look: DEFAULT_LOOK, pack: NO_PACK_STYLE };
  const clearAll = () => {
    if (!equipped || spinning) return;
    setHover(null);
    setError(null);
    setPending(BARE);
    setPop((n) => n + 1);
  };
  const bare = !!equipped && equipped.theme === null && equipped.frame === null && equipped.nameStyle === null && equipped.nameFont === null && equipped.nameOutline === null && sameLook(equipped.look, DEFAULT_LOOK)
    && !equipped.pack.sleeve && !equipped.pack.binder && !equipped.pack.wrapper && !equipped.pack.blade;

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
  const hovered = reel ?? (held && hover ? withSlot(held, hover.slot, hover.value, custom) : held);
  const shown = hovered && outlinePreview !== undefined ? { ...hovered, nameOutline: outlinePreview } : hovered;
  const viewerKeys = useMemo(() => mainKeymode(card?.bestScores), [card]);
  const highwayNotes = useHighwayNotes(viewer?.id, viewerKeys, (shown?.theme === "highway" && !shown.themeOptions.stockNotes) || shown?.theme === "judgements");
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
  const latest = useRef({ pick, upload, editCustom, setThemeOptions, setNameOutline, wearOwnTheme });
  latest.current = { pick, upload, editCustom, setThemeOptions, setNameOutline, wearOwnTheme };
  /* Leaving a tile waits a moment before the preview goes back, so crossing
     the gap to the next tile swaps straight to it instead of flashing what's
     equipped in between. */
  const hoverEnd = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => {
    if (hoverEnd.current) clearTimeout(hoverEnd.current);
  }, []);
  const onTry = useCallback((slot: SlotId, value: SlotValue | undefined) => {
    if (hoverEnd.current) clearTimeout(hoverEnd.current);
    hoverEnd.current = null;
    if (value !== undefined) {
      setHover({ slot, value });
      return;
    }
    hoverEnd.current = setTimeout(() => {
      hoverEnd.current = null;
      setHover(null);
    }, HOVER_END_MS);
  }, []);
  const onPick = useCallback((slot: SlotId, value: SlotValue) => latest.current.pick(slot, value), []);
  const onUpload = useCallback((file: File) => void latest.current.upload(file), []);
  const onEditCustom = useCallback(() => latest.current.editCustom(), []);
  const onThemeOptions = useCallback((options: Loadout["themeOptions"]) => latest.current.setThemeOptions(options), []);
  const onNameOutline = useCallback((outline: string | null, commit: boolean) => latest.current.setNameOutline(outline, commit), []);
  const onWearOwnTheme = useCallback((themeId: number | null, options?: ProfileThemeOptions) => latest.current.wearOwnTheme(themeId, options), []);

  const giftFrom = state?.giftFrom ?? null;
  const until = supporter && state?.expiresAt
    ? new Date(state.expiresAt).toLocaleDateString(i18n.locale, { month: "short", day: "numeric", year: "numeric" })
    : null;
  /* The viewer's own profile wearing what is on now (a roll waiting to be
     kept included), in this browser only: supporter-preview.ts. Someone who
     has not supported also gets a first rank and the mascot they picked. */
  const previewOnProfile = () => {
    const loadout = pending ?? equipped;
    if (!viewer || !loadout) return;
    track("supporter_preview");
    const mascot = supporter ? undefined : previewMascot();
    startSupporterProfilePreview(viewer.id, {
      look: loadout.look,
      frame: loadout.frame,
      nameStyle: loadout.nameStyle,
      nameFont: loadout.nameFont,
      nameOutline: loadout.nameOutline,
      profileTheme: loadout.theme,
      profileThemeOptions: loadout.themeOptions,
      // a built-in theme picked here takes the place of their own
      ...(loadout.theme ? { customTheme: null } : {}),
      packStyle: loadout.pack,
      ...(supporter ? {} : { runStartedAt: Date.now(), companion: mascot ?? null }),
    });
    void navigate({ to: "/player/$username", params: { username: viewer.username } });
  };
  const previewButton = viewer && state && equipped ? (
    <button
      type="button"
      onClick={previewOnProfile}
      className="inline-flex cursor-pointer items-center gap-1.5 rounded-full bg-white/10 px-4 py-1.5 text-[12px] font-semibold text-white transition-colors hover:bg-white/15"
    >
      {t`Preview on my profile`}
    </button>
  ) : null;
  const status = !viewer || !state ? null : until ? (
    <span className="flex items-center gap-3">
      {previewButton}
      {/* a subscription keeps going: an end date months away would only ask why they still pay */}
      <span className="text-[12px] text-osu-l2">
        {state.renewing ? (state.patron ? t`Gold supporter, renews every month` : t`Renews every month`) : t`Supporter until ${until}`}
      </span>
    </span>
  ) : (
    <span className="flex items-center gap-2">
      {previewButton}
      <Link
        to="/support"
        hash="checkout"
        className="inline-flex items-center gap-1.5 rounded-full bg-osu-pink px-4 py-1.5 text-[12px] font-semibold text-white transition hover:brightness-110"
      >
        {t`Become a supporter`}
      </Link>
    </span>
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
      <PageHeader iconSrc="/images/icons/supporter-gem.svg" title={t`supporter`} right={status} />
      <div className="min-h-[80vh] bg-osu-b5" style={profileThemeStyle(shown?.theme ?? null, highwayNotes)}>
        <div className="mx-auto max-w-[1200px] px-3 py-6 sm:px-5 sm:py-8 xl:max-w-[1440px]">
          {!viewer ? (
            <p className="py-10 text-center text-[13px] text-osu-f1">
              <a href={`/api/auth/osu?next=${encodeURIComponent("/supporter")}`} className="font-semibold text-osu-pink-light hover:underline">
                {t`Log in with osu!`}
              </a>{" "}
              {t`to set up your avatar frame, name tag and card look.`}
            </p>
          ) : (
            <>
              {/* Only someone browsing in preview needs telling up front; a supporter's thanks, rank and gift code have their own section. */}
              {state && !state.supporter ? (
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

              {/* From lg up the three columns fill the window between the page header and
                  the footer, each scrolling on its own, so the page itself holds still. */}
              <div className="grid items-start gap-6 lg:h-[calc(100dvh-214px)] lg:min-h-[520px] lg:grid-cols-[minmax(0,1fr)_minmax(0,440px)] lg:items-stretch xl:grid-cols-[220px_minmax(0,1fr)_minmax(0,440px)]">
                <aside className="scroll-slim min-h-0 overflow-y-auto pb-4 pr-1 max-xl:hidden">
                  {shown && (
                    <SupporterNav
                      layout="column"
                      shown={shown}
                      section={section}
                      onSection={openSection}
                      locks={locks}
                      spinning={spinning}
                      trying={hover && !spinning ? hover.slot : null}
                      avatar={avatar}
                      supporter={supporter}
                    />
                  )}
                  <p className="mt-4 px-2 text-[11px] text-osu-f1">
                    <span className="font-semibold tabular-nums text-osu-l2">{formatNumber(LOADOUT_COMBINATIONS)}</span> {t`possible combinations`}
                  </p>
                </aside>

                {/* Below lg only the avatar and name stay in view; the card, the
                    test pack and the binder are too tall to, and pinned they
                    would cover the drawer under them. */}
                <div className={`z-20 lg:min-h-0 ${open === "motif" || open === "foil" || open === "sleeve" || open === "wrapper" || open === "blade" || open === "binder" ? "" : "max-lg:sticky max-lg:top-[60px]"}`}>
                  {shown && held ? (
                    <LoadoutStage
                      shown={shown}
                      notes={highwayNotes}
                      chart={highwayChart}
                      cardLook={cardLook}
                      username={viewer.username}
                      avatar={avatar}
                      card={stageCard}
                      focus={open === "motif" || open === "foil" || open === "sleeve" ? "card" : open === "wrapper" || open === "blade" ? "pack" : open === "binder" ? "binder" : "hero"}
                      pop={pop}
                      spinning={spinning}
                      footer={footer}
                      tall
                    />
                  ) : (
                    <div className="h-[280px] animate-pulse rounded-2xl bg-osu-b6 lg:h-full" />
                  )}
                </div>

                <div className="scroll-slim min-w-0 lg:-mx-2 lg:-my-2 lg:min-h-0 lg:overflow-y-auto lg:p-2">
                  {shown && (
                    <div className="mb-4 xl:hidden">
                      <SupporterNav
                        layout="row"
                        shown={shown}
                        section={section}
                        onSection={openSection}
                        locks={locks}
                        spinning={spinning}
                        trying={null}
                        avatar={avatar}
                        supporter={supporter}
                      />
                    </div>
                  )}
                  {open && shown && held ? (
                    <>
                      <div className="mb-3 flex items-center justify-between gap-3">
                        <h2 className="text-[15px] font-semibold text-white">{i18n._(SLOT_LABELS[open])}</h2>
                        {isRolledSlot(open) && <SlotLock locked={locks.has(open)} onToggle={() => toggleLock(open)} />}
                      </div>
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
                        onEditCustom={onEditCustom}
                        onThemeOptions={onThemeOptions}
                        onNameOutline={onNameOutline}
                        onWearOwnTheme={onWearOwnTheme}
                      />
                      {error && <div className="mt-3 text-[12px] text-osu-red-light">{error}</div>}
                      <AnimatePresence>
                      {artDraft && (
                        <CustomArtDialog
                          draft={artDraft}
                          uploading={artUploading}
                          error={artError}
                          foil={held.look.foil}
                          card={stageCard}
                          sleeve={held.pack.sleeve}
                          onChange={setArtDraft}
                          onSave={saveArt}
                          onClose={() => setArtDraft(null)}
                        />
                      )}
                      </AnimatePresence>
                    </>
                  ) : section === "companion" ? (
                    <CompanionSection viewerId={viewer.id} supporter={supporter} />
                  ) : section === "stats" ? (
                    <ProfileStatsSection viewerId={viewer.id} supporter={supporter} />
                  ) : section === "perks" ? (
                    <SupporterPerks avatar={avatar} />
                  ) : section === "you" && state?.supporter ? (
                    <div>
                      {giftFrom ? (
                        <>
                          <p className="text-[18px] font-semibold text-white">{t`Enjoy your supporter week, ${viewer.username}.`}</p>
                          <p className="mt-1 text-[13px] text-osu-l2">{t`${giftFrom} gave you a week of supporter.`}</p>
                        </>
                      ) : (
                        <>
                          <p className="text-[18px] font-semibold text-white">{t`Thank you for supporting, ${viewer.username}.`}</p>
                          <p className="mt-1 text-[13px] text-osu-l2">
                            {t`Your support keeps the servers running and new features coming. These extras are the thank-you.`}
                          </p>
                          {state.runStartedAt != null ? (
                            <SupporterRankLadder
                              runStartedAt={state.runStartedAt}
                              renewing={state.renewing}
                              fire={state.rankFire}
                              bestRank={state.bestRank}
                              shownRank={state.shownRank}
                              onShow={(rank) => {
                                const before = state.shownRank;
                                setState((current) => (current ? { ...current, shownRank: rank } : current));
                                saveSupporterRankShownSetting({ data: { rank } })
                                  .then(() => forgetLiveSupporterLook(viewer.id))
                                  .catch(() => setState((current) => (current ? { ...current, shownRank: before } : current)));
                              }}
                            />
                          ) : null}
                          {state.renewing ? (
                            <p className="mt-2 text-[12px] leading-relaxed text-osu-f1">
                              {state.patron
                                ? t`You're a Gold supporter. Your subscription keeps up to 3 months banked, and anything past that turns into gift codes for your friends.`
                                : t`Your subscription keeps up to 3 months banked, and anything past that turns into gift codes for your friends.`}
                            </p>
                          ) : null}
                          {state.runStartedAt != null && state.renewing ? (
                            <RankFireSwitch viewerId={viewer.id} on={state.rankFire} onChange={(rankFire) => setState((current) => (current ? { ...current, rankFire } : current))} />
                          ) : null}
                          <GiftCodePanel viewerId={viewer.id} />
                        </>
                      )}
                    </div>
                  ) : null}
                </div>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

/* Whether a renewing supporter's rank burns, on their profile and here. */
function RankFireSwitch({ viewerId, on, onChange }: { viewerId: number; on: boolean; onChange: (on: boolean) => void }) {
  const { t } = useLingui();
  const [error, setError] = useState(false);
  const toggle = (next: boolean) => {
    onChange(next);
    setError(false);
    saveSupporterRankFireSetting({ data: { rankFire: next } })
      .then(() => forgetLiveSupporterLook(viewerId))
      .catch(() => {
        onChange(!next);
        setError(true);
      });
  };
  return (
    <div className="mt-3">
      <label className="inline-flex cursor-pointer items-center gap-2.5 text-[13px] text-osu-l2">
        <Switch checked={on} onChange={toggle} label={t`Show the fire on your rank`} />
        <span>{t`Show the fire on your rank`}</span>
      </label>
      {error ? <p className="mt-1 text-[12px] text-osu-red-light">{t`Could not save that.`}</p> : null}
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
