import { useEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties, ReactNode } from "react";
import { Link, useRouter } from "@tanstack/react-router";
import { useLocale } from "../../lib/locale-context";
import { writeLocaleCookieClient } from "../../lib/locale-cookie";
import { loadLocaleCatalog } from "../../lib/i18n";
import type { AppLocale } from "../../lib/locale";
import { Trans, useLingui } from "@lingui/react/macro";
import { msg } from "@lingui/core/macro";
import { AnimatePresence } from "framer-motion";
import { ArrowDown, ArrowUp, Loader2, Pencil, RotateCcw, Search, Volume1, Volume2, VolumeX, X } from "lucide-react";

import { PageHeader } from "../layout/PageHeader";
import { PageTabs } from "../layout/PageTabs";
import { Avatar } from "../ui/Avatar";
import { CountryFlag } from "../ui/CountryFlag";
import { SelectMenu } from "../ui/SelectMenu";
import { ReplaySkinSettingsModal } from "../replay/ReplaySkinSettingsModal";
import { OwnerReplaySkinCustomizeModal } from "./OwnerReplaySkinCustomizeModal";
import { TranslationReportForm } from "./TranslationReportForm";
import {
  ReplaySkinColorWheel,
  ReplaySkinValueSlider,
  hexToRgbParts,
  hsvToRgb,
  rgbPartsToHex,
  rgbToHsv,
} from "../replay/ReplaySkinColorPanel";
import { searchUsers } from "../../lib/osu";
import { HIDDEN_USERS_LIMIT } from "../../store";
import type { HiddenUser } from "../../store";
import {
  DEFAULT_REPLAY_SKIN_SETTINGS,
  REPLAY_SKIN_SETTINGS_CHANGE_EVENT,
  normalizeReplaySkinSettings,
  readReplaySkinSettings,
  writeReplaySkinSettings,
} from "../../lib/replay-skin";
import {
  DEFAULT_REPLAY_SCROLL_SPEED,
  normalizeReplayScrollSpeed,
  readReplayScrollSpeed,
  writeReplayScrollSpeed,
} from "../../lib/replay-scroll-speed";
import {
  normalizeReplayBackgroundDim,
  normalizeReplayVolume,
  readReplayBackgroundDim,
  readReplayOwnerSkinEnabled,
  readReplaySpectatorNameShown,
  readReplayVolume,
  writeReplayBackgroundDim,
  writeReplayOwnerSkinEnabled,
  writeReplaySpectatorNameShown,
  writeReplayVolume,
} from "../../lib/replay-preferences";
import {
  appliedCommunityReplaySkinKey,
  clearMyReplaySkin,
  fetchMyReplaySkinCached,
  loadAppliedReplaySkinSettings,
  peekMyReplaySkinMemory,
  readAppliedCommunityReplaySkin,
  replaySkinSettingsEmbedAssets,
  replaySkinSettingsWithoutAssets,
  writeAppliedCommunityReplaySkin,
  writeMyReplaySkinMemory,
} from "../../lib/replay-owner-skin";
import type { AppliedCommunitySkinDraft, OwnerReplaySkinRecord } from "../../lib/replay-owner-skin";
import { useAuth } from "../../lib/auth-context";
import {
  DEFAULT_REPLAY_OVERLAY_SETTINGS,
  normalizeReplayOverlaySettings,
  readReplayOverlaySettings,
  writeReplayOverlaySettings,
} from "../../lib/replay-overlays";
import type { ReplaySkinSettings, ReplaySkinStyle } from "../../lib/replay-skin";
import type { ReplayOverlaySettings } from "../../lib/replay-overlays";
import { normalizeEditableHex } from "../../lib/replay-preferences";
import {
  CURSOR_COLOR_PRESETS,
  CURSOR_GLOW_MAX,
  CURSOR_GLOW_MIN,
  CURSOR_SIZE_MAX,
  CURSOR_SIZE_MIN,
  CURSOR_TRAIL_THICKNESS_MAX,
  CURSOR_TRAIL_THICKNESS_MIN,
  DEFAULT_CURSOR_SETTINGS,
  normalizeCursorSettings,
  readCursorSettings,
  writeCursorSettings,
} from "../../lib/cursor";
import type { CursorSettings } from "../../lib/cursor";
import { useAppStore } from "../../store";
import { Switch } from "../ui/Switch";

const MANIA_ARROW_ICON_STYLE: CSSProperties = {
  WebkitMask: "url('/images/notes/mania-arrow-right.svg') center / contain no-repeat",
  mask: "url('/images/notes/mania-arrow-right.svg') center / contain no-repeat",
};
const MANIA_BAR_ICON_STYLE: CSSProperties = {
  WebkitMask: "url('/images/notes/mania-bar.svg') center / contain no-repeat",
  mask: "url('/images/notes/mania-bar.svg') center / contain no-repeat",
};
const MANIA_CIRCLE_ICON_STYLE: CSSProperties = {
  WebkitMask: "url('/images/notes/mania-circle.svg') center / contain no-repeat",
  mask: "url('/images/notes/mania-circle.svg') center / contain no-repeat",
};

const STYLE_ICON_BY_NAME: Record<ReplaySkinStyle, CSSProperties> = {
  circles: MANIA_CIRCLE_ICON_STYLE,
  bars: MANIA_BAR_ICON_STYLE,
  arrows: MANIA_ARROW_ICON_STYLE,
};

const STYLE_LABELS: Record<ReplaySkinStyle, ReturnType<typeof msg>> = {
  circles: msg`Circles`,
  bars: msg`Bars`,
  arrows: msg`Arrows`,
};

type TabId = "skin" | "viewer" | "filters" | "appearance";
const TABS: { id: TabId; label: ReturnType<typeof msg> }[] = [
  { id: "skin", label: msg`skin & layout` },
  { id: "viewer", label: msg`playback` },
  { id: "filters", label: msg`filters` },
  { id: "appearance", label: msg`appearance` },
];

type Variant = "page" | "drawer";

interface SettingsPanelProps {
  variant?: Variant;
  onClose?: () => void;
}

export function SettingsPanel({ variant = "page", onClose }: SettingsPanelProps) {
  const { t, i18n } = useLingui();
  const [scrollSpeed, setScrollSpeed] = useState(readReplayScrollSpeed);
  const [bgDim, setBgDim] = useState(readReplayBackgroundDim);
  const [volume, setVolume] = useState(readReplayVolume);
  const [skinSettings, setSkinSettings] = useState(readReplaySkinSettings);
  const skinSettingsRef = useRef(skinSettings);
  const [overlaySettings, setOverlaySettings] = useState(readReplayOverlaySettings);
  const [skinSettingsOpen, setSkinSettingsOpen] = useState(false);
  const [skinSettingsLoading, setSkinSettingsLoading] = useState(false);
  const skinSettingsLoadRequestRef = useRef(0);
  /* Starts at defaults on both server and first client render (the appearance
     panel renders a different subtree when the cursor is enabled, so reading
     localStorage during render would break hydration); real values load after
     mount. */
  const [cursorSettings, setCursorSettings] = useState(DEFAULT_CURSOR_SETTINGS);
  /* Same reason: the switch renders differently once the stored value is in. */
  const [spectatorNameShown, setSpectatorNameShown] = useState(false);
  const [activeTab, setActiveTab] = useState<TabId>("skin");
  // Reset throws away every setting on this browser, so one click is not
  // enough: the button asks first and forgets the question on its own.
  const [confirmingReset, setConfirmingReset] = useState(false);

  useEffect(() => {
    setCursorSettings(readCursorSettings());
    setSpectatorNameShown(readReplaySpectatorNameShown());
  }, []);

  useEffect(() => {
    skinSettingsRef.current = skinSettings;
  }, [skinSettings]);

  useEffect(() => () => {
    skinSettingsLoadRequestRef.current += 1;
  }, []);

  useEffect(() => {
    if (!confirmingReset) return;
    const timer = setTimeout(() => setConfirmingReset(false), 4000);
    return () => clearTimeout(timer);
  }, [confirmingReset]);

  const updateCursor = (patch: Partial<CursorSettings>) => {
    const next = normalizeCursorSettings({ ...cursorSettings, ...patch });
    setCursorSettings(next);
    writeCursorSettings(next);
  };

  // Settings that embed a skin's art are megabytes of data URLs, which
  // localStorage rejects: the decoded copy stays in memory here and the
  // stored one keeps paths only, with the pointer beside it to rebuild from.
  // Without this the editor reopened on "Default" with the skin gone.
  const persistSkinSettings = (next: ReplaySkinSettings) => {
    setSkinSettings(next);
    writeReplaySkinSettings(replaySkinSettingsEmbedAssets(next) ? replaySkinSettingsWithoutAssets(next) : next);
  };

  const saveSkinSettings = (settings: ReplaySkinSettings, community?: AppliedCommunitySkinDraft | null) => {
    const normalized = normalizeReplaySkinSettings(settings);
    setSkinSettings(normalized);
    if (community) {
      writeAppliedCommunityReplaySkin({ skin: community.skin, payload: community.payload });
      writeReplaySkinSettings(community.assetFree);
      return;
    }
    writeAppliedCommunityReplaySkin(null);
    writeReplaySkinSettings(normalized);
  };

  const saveOverlaySettings = (settings: ReplayOverlaySettings) => {
    const normalized = normalizeReplayOverlaySettings(settings);
    setOverlaySettings(normalized);
    writeReplayOverlaySettings(normalized);
  };

  const updateSkin = (patch: Partial<ReplaySkinSettings>) => {
    persistSkinSettings(normalizeReplaySkinSettings({ ...skinSettings, ...patch, version: 2 }));
  };

  // A community skin's localStorage copy intentionally has no decoded image
  // data. The quick settings panel does not draw that art, so downloading,
  // unzipping and decoding the full .osk while the drawer opens only blocks
  // unrelated interactions (most noticeably a quick switch to Appearance).
  // Pay that cost only when the full editor actually needs the assets.
  const openAdvancedSkinEditor = () => {
    const applied = readAppliedCommunityReplaySkin();
    if (!applied || replaySkinSettingsEmbedAssets(skinSettingsRef.current)) {
      setSkinSettingsOpen(true);
      return;
    }

    const appliedKey = appliedCommunityReplaySkinKey(applied);
    const requestId = ++skinSettingsLoadRequestRef.current;
    setSkinSettingsLoading(true);
    void loadAppliedReplaySkinSettings()
      .then((full) => {
        if (skinSettingsLoadRequestRef.current !== requestId) return;
        const currentApplied = readAppliedCommunityReplaySkin();
        if (full && currentApplied && appliedCommunityReplaySkinKey(currentApplied) === appliedKey) {
          // Scroll direction remains editable in the lightweight panel. Keep
          // the latest click if it changed while the archive was loading; all
          // skin-derived geometry and decoded assets come from the full copy.
          const merged = normalizeReplaySkinSettings({
            ...full,
            upscroll: skinSettingsRef.current.upscroll,
          });
          skinSettingsRef.current = merged;
          setSkinSettings(merged);
        }
        setSkinSettingsOpen(true);
      })
      .catch(() => {
        if (skinSettingsLoadRequestRef.current === requestId) setSkinSettingsOpen(true);
      })
      .finally(() => {
        if (skinSettingsLoadRequestRef.current === requestId) setSkinSettingsLoading(false);
      });
  };

  const resetReplaySettings = () => {
    skinSettingsLoadRequestRef.current += 1;
    setSkinSettingsLoading(false);
    setScrollSpeed(DEFAULT_REPLAY_SCROLL_SPEED);
    writeReplayScrollSpeed(DEFAULT_REPLAY_SCROLL_SPEED);
    setBgDim(80);
    writeReplayBackgroundDim(80);
    setVolume(0.5);
    writeReplayVolume(0.5);
    setSkinSettings(DEFAULT_REPLAY_SKIN_SETTINGS);
    writeReplaySkinSettings(DEFAULT_REPLAY_SKIN_SETTINGS);
    // Drop the applied skin too, or the next read would rebuild it over the
    // defaults that were just written.
    writeAppliedCommunityReplaySkin(null);
    setOverlaySettings(DEFAULT_REPLAY_OVERLAY_SETTINGS);
    writeReplayOverlaySettings(DEFAULT_REPLAY_OVERLAY_SETTINGS);
    setCursorSettings(DEFAULT_CURSOR_SETTINGS);
    writeCursorSettings(DEFAULT_CURSOR_SETTINGS);
    setSpectatorNameShown(false);
    writeReplaySpectatorNameShown(false);
  };

  // One button in one place: the confirm lives inside it, so nothing around it
  // moves. Both labels render stacked in the same cell (the inactive one
  // invisible), so the width always fits the longer of the two in every locale.
  const resetButton = (
    <button
      type="button"
      onClick={() => {
        if (!confirmingReset) {
          setConfirmingReset(true);
          return;
        }
        resetReplaySettings();
        setConfirmingReset(false);
      }}
      className={`group inline-flex h-8 cursor-pointer items-center justify-center gap-1.5 rounded-lg border px-3 text-[11px] font-bold transition-colors ${
        confirmingReset
          ? "border-osu-red/60 bg-osu-red/15 text-osu-red-light hover:bg-osu-red/30"
          : "border-osu-b3/60 bg-osu-b5/70 text-osu-f1 hover:border-osu-red/60 hover:bg-osu-red/10 hover:text-osu-red"
      }`}
    >
      <RotateCcw
        className={`h-3 w-3 duration-300 ${confirmingReset ? "" : "transition-transform group-hover:-rotate-180"}`}
      />
      <span className="grid">
        <span aria-hidden="true" className="invisible col-start-1 row-start-1">
          {confirmingReset ? t`Reset all` : t`Sure?`}
        </span>
        <span className="col-start-1 row-start-1 whitespace-nowrap">{confirmingReset ? t`Sure?` : t`Reset all`}</span>
      </span>
    </button>
  );

  const tabs = TABS.map((tab) => ({ id: tab.id, label: i18n._(tab.label) }));

  const body = (
    <>
      {activeTab === "appearance" ? (
        <AppearancePanel cursorSettings={cursorSettings} onUpdateCursor={updateCursor} />
      ) : null}
      {activeTab === "skin" ? (
        <SkinPanel
          skinSettings={skinSettings}
          onUpdateSkin={updateSkin}
          onOpenAdvanced={openAdvancedSkinEditor}
          advancedLoading={skinSettingsLoading}
        />
      ) : null}
      {activeTab === "viewer" ? (
        <ViewerPanel
          scrollSpeed={scrollSpeed}
          onScrollSpeedChange={(value) => {
            const normalized = normalizeReplayScrollSpeed(value);
            setScrollSpeed(normalized);
            writeReplayScrollSpeed(normalized);
          }}
          bgDim={bgDim}
          onBgDimChange={(value) => {
            const normalized = normalizeReplayBackgroundDim(value);
            setBgDim(normalized);
            writeReplayBackgroundDim(normalized);
          }}
          volume={volume}
          onVolumeChange={(value) => {
            const normalized = normalizeReplayVolume(value / 100);
            setVolume(normalized);
            writeReplayVolume(normalized);
          }}
          spectatorNameShown={spectatorNameShown}
          onSpectatorNameShownChange={(shown) => {
            setSpectatorNameShown(shown);
            writeReplaySpectatorNameShown(shown);
          }}
        />
      ) : null}
      {activeTab === "filters" ? <HiddenPlayersPanel /> : null}
    </>
  );

  const skinModal = (
    <AnimatePresence>
      {skinSettingsOpen ? (
        <ReplaySkinSettingsModal
          settings={skinSettings}
          overlaySettings={overlaySettings}
          keyCount={4}
          onSave={saveSkinSettings}
          onSaveOverlays={saveOverlaySettings}
          onClose={() => setSkinSettingsOpen(false)}
        />
      ) : null}
    </AnimatePresence>
  );

  if (variant === "drawer") {
    return (
      <div className="flex h-full flex-col bg-osu-b5">
        <div className="flex items-center gap-2 border-b border-osu-b3/40 bg-osu-d5 px-4 py-3">
          <img src="/images/icons/settings.svg" alt="" width={22} height={22} className="opacity-60 shrink-0" />
          <h2 className="flex-1 text-[13px] font-semibold text-osu-c2"><Trans>settings</Trans></h2>
          {resetButton}
          {onClose ? (
            <button
              type="button"
              onClick={onClose}
              className="grid h-8 w-8 cursor-pointer place-items-center rounded-lg text-osu-pink-light transition-colors hover:bg-osu-b3/50 hover:text-white"
              aria-label={t`Close settings`}
            >
              <X className="h-4 w-4" strokeWidth={2.2} />
            </button>
          ) : null}
        </div>
        <PageTabs items={tabs} value={activeTab} onChange={setActiveTab} />
        <div className="flex-1 overflow-y-auto">
          <div className="px-3 py-5 sm:px-5 sm:py-6 space-y-6">{body}</div>
        </div>
        {skinModal}
      </div>
    );
  }

  return (
    <div className="flex-1">
      <PageHeader iconSrc="/images/icons/settings.svg" title={t`settings`} right={resetButton} />
      <PageTabs items={tabs} value={activeTab} onChange={setActiveTab} />
      <div className="bg-osu-b5 min-h-[80vh]">
        <div className="mx-auto max-w-[900px] px-3 py-6 sm:px-5 sm:py-8 space-y-6">{body}</div>
      </div>
      {skinModal}
    </div>
  );
}

function VolumeIcon({ volume, className }: { volume: number; className?: string }) {
  if (volume <= 0.001) return <VolumeX className={className} />;
  if (volume < 0.5) return <Volume1 className={className} />;
  return <Volume2 className={className} />;
}

function PanelGroup({ label, children, action }: { label: string; children: ReactNode; action?: ReactNode }) {
  return (
    <section className="space-y-3">
      <div className="flex items-center gap-3">
        <span className="text-[10px] font-bold uppercase tracking-[0.18em] text-osu-pink-light">{label}</span>
        <span className="h-px flex-1 bg-osu-b3/35" />
        {action}
      </div>
      <div className="space-y-3">{children}</div>
    </section>
  );
}

// Option labels stay in their own language on purpose: a visitor stranded in
// the wrong locale must be able to recognize their way back. The Record is
// keyed by AppLocale so adding a locale without a row here fails to compile.
const LANGUAGE_OPTIONS: Record<AppLocale, { label: string; flag: string }> = {
  en: { label: "English", flag: "US" },
  "zh-CN": { label: "中文（简体）", flag: "CN" },
  es: { label: "Español", flag: "ES" },
};

function LanguageGroup() {
  const { t } = useLingui();
  const locale = useLocale();
  const router = useRouter();
  return (
    <PanelGroup label={t`Language`}>
      <div className="space-y-1.5">
        <span className="text-[11px] font-semibold text-osu-l1">{t`Interface language`}</span>
        <SelectMenu
          value={locale}
          block
          ariaLabel={t`Interface language`}
          options={(Object.keys(LANGUAGE_OPTIONS) as AppLocale[]).map((value) => ({
            value,
            label: LANGUAGE_OPTIONS[value].label,
            leading: <CountryFlag code={LANGUAGE_OPTIONS[value].flag} size="sm" decorative />,
          }))}
          onChange={(next) => {
            if (next === locale) return;
            writeLocaleCookieClient(next);
            // Load the catalog before invalidating so the re-render finds its
            // messages; invalidation re-runs the root beforeLoad, which reads
            // the cookie and swaps the provider, lang attribute and head.
            void loadLocaleCatalog(next).then(() => router.invalidate());
          }}
        />
      </div>
      {/* Spanish is maintained directly by the site's owner. Keep reader
          reports for Chinese, where community feedback is useful. */}
      {locale === "zh-CN" ? <TranslationReportForm key={locale} /> : null}
    </PanelGroup>
  );
}

function AppearancePanel({
  cursorSettings,
  onUpdateCursor,
}: {
  cursorSettings: CursorSettings;
  onUpdateCursor: (patch: Partial<CursorSettings>) => void;
}) {
  const { t } = useLingui();
  return (
    <div className="space-y-6">
      <LanguageGroup />
      <PanelGroup
        label={t`Custom cursor`}
        action={<Switch checked={cursorSettings.enabled} onChange={(enabled) => onUpdateCursor({ enabled })} />}
      >
        <p className="text-[12px] leading-relaxed text-osu-f1">
          <Trans>Replaces the mouse cursor with an osu!-style cursor across the site. Desktop only.</Trans>
        </p>
        {cursorSettings.enabled ? (
          <>
            <div className="space-y-1.5">
              <span className="text-[11px] font-semibold text-osu-l1"><Trans>Color</Trans></span>
              <ColorSwatchRow value={cursorSettings.color} onChange={(color) => onUpdateCursor({ color })} />
            </div>
            <div className="space-y-1.5">
              <span className="text-[11px] font-semibold text-osu-l1"><Trans>Size</Trans></span>
              <PercentSlider
                value={cursorSettings.size}
                min={CURSOR_SIZE_MIN}
                max={CURSOR_SIZE_MAX}
                step={10}
                onChange={(size) => onUpdateCursor({ size })}
              />
            </div>
            <div className="space-y-1.5">
              <span className="text-[11px] font-semibold text-osu-l1"><Trans>Glow</Trans></span>
              <PercentSlider
                value={cursorSettings.glow}
                min={CURSOR_GLOW_MIN}
                max={CURSOR_GLOW_MAX}
                step={5}
                onChange={(glow) => onUpdateCursor({ glow })}
                hint={t`How far the colored glow reaches around the cursor core.`}
              />
            </div>
            <div className="space-y-3 rounded-lg border border-osu-b3/40 bg-osu-b5/40 px-3 py-2.5">
              <div className="flex items-center justify-between gap-3">
                <div>
                  <div className="text-[12px] font-semibold text-osu-l1"><Trans>Cursor trail</Trans></div>
                  <div className="text-[11px] text-osu-f1"><Trans>Leaves a short fading trail behind the cursor.</Trans></div>
                </div>
                <Switch checked={cursorSettings.trail} onChange={(trail) => onUpdateCursor({ trail })} />
              </div>
              {cursorSettings.trail ? (
                <>
                  <div className="space-y-1.5">
                    <span className="text-[11px] font-semibold text-osu-l1"><Trans>Trail color</Trans></span>
                    <ColorSwatchRow
                      value={cursorSettings.trailColor}
                      onChange={(trailColor) => onUpdateCursor({ trailColor })}
                    />
                  </div>
                  <div className="space-y-1.5">
                    <span className="text-[11px] font-semibold text-osu-l1"><Trans>Trail thickness</Trans></span>
                    <PercentSlider
                      value={cursorSettings.trailThickness}
                      min={CURSOR_TRAIL_THICKNESS_MIN}
                      max={CURSOR_TRAIL_THICKNESS_MAX}
                      step={5}
                      onChange={(trailThickness) => onUpdateCursor({ trailThickness })}
                    />
                  </div>
                </>
              ) : null}
            </div>
            <p className="text-[11px] text-osu-f1/80">
              <Trans>
                Hold <kbd className="rounded border border-osu-b3/60 bg-osu-b5/80 px-1.5 py-0.5 font-bold text-osu-pink-light">C</kbd>{" "}
                and move the cursor to draw smoke, just like mid-play drawing in osu!. It fades out on its own.
              </Trans>
            </p>
          </>
        ) : null}
      </PanelGroup>
    </div>
  );
}

function ColorSwatchRow({ value, onChange }: { value: string; onChange: (color: string) => void }) {
  const { t } = useLingui();
  const [pickerOpen, setPickerOpen] = useState(false);
  const isPreset = CURSOR_COLOR_PRESETS.some((preset) => preset.value === value);
  const [r, g, b] = hexToRgbParts(value);
  const [h, s, v] = rgbToHsv(r, g, b);

  const setHsv = (nextH: number, nextS: number, nextV: number) => {
    const [nr, ng, nb] = hsvToRgb(nextH, nextS, nextV);
    onChange(rgbPartsToHex(nr, ng, nb));
  };

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        {CURSOR_COLOR_PRESETS.map((preset) => {
          const active = preset.value === value;
          return (
            <button
              key={preset.value}
              type="button"
              title={preset.label}
              aria-label={preset.label}
              aria-pressed={active}
              onClick={() => onChange(preset.value)}
              className={`h-8 w-8 cursor-pointer rounded-full border-2 transition-transform hover:scale-110 ${
                active ? "border-white" : "border-transparent"
              }`}
              style={{ backgroundColor: preset.value }}
            />
          );
        })}
        <button
          type="button"
          title={t`Custom color`}
          aria-label={t`Custom color`}
          aria-expanded={pickerOpen}
          onClick={() => setPickerOpen((open) => !open)}
          className={`relative h-8 w-8 cursor-pointer overflow-hidden rounded-full border-2 p-0 transition-transform hover:scale-110 ${
            pickerOpen || !isPreset ? "border-white" : "border-transparent"
          }`}
        >
          <span
            aria-hidden="true"
            className="absolute inset-0 rounded-full"
            style={{
              background: "conic-gradient(#ff4444, #ffdd44, #66dd44, #44ddff, #4466ff, #dd44ff, #ff4444)",
              clipPath: "circle(50% at 50% 50%)",
            }}
          />
        </button>
      </div>
      {pickerOpen ? (
        <div className="w-fit rounded-lg border border-osu-b3/40 bg-osu-b5/40 px-4 pt-4 pb-3">
          <ReplaySkinColorWheel
            hue={h}
            saturation={s}
            value={v}
            onChange={(nextH, nextS) => setHsv(nextH, nextS, v)}
          />
          <ReplaySkinValueSlider hue={h} saturation={s} value={v} onChange={(nextV) => setHsv(h, s, nextV)} />
          <div className="mt-3 flex items-center gap-2">
            <span className="h-7 w-7 shrink-0 rounded-md border border-white/30" style={{ backgroundColor: value }} />
            <input
              type="text"
              value={value}
              onChange={(event) => {
                const normalized = normalizeEditableHex(event.target.value);
                if (normalized) onChange(normalized);
              }}
              spellCheck={false}
              aria-label={t`Custom color hex`}
              className="h-7 w-24 rounded-md border border-osu-b3/50 bg-osu-b5 px-2 font-mono text-[11px] text-osu-c1 outline-none transition-colors focus:border-osu-pink/60"
            />
          </div>
        </div>
      ) : null}
    </div>
  );
}

function SkinPanel({
  skinSettings,
  onUpdateSkin,
  onOpenAdvanced,
  advancedLoading,
}: {
  skinSettings: ReplaySkinSettings;
  onUpdateSkin: (patch: Partial<ReplaySkinSettings>) => void;
  onOpenAdvanced: () => void;
  advancedLoading: boolean;
}) {
  const { t, i18n } = useLingui();
  const auth = useAuth();
  const viewerId = auth.viewer?.id ?? null;
  /* The first SSR/client render starts from hydration-safe defaults. Drawer
     remounts happen after hydration, so they can reuse the last known skin
     synchronously while the effect below revalidates it. */
  const [ownerSkinEnabled, setOwnerSkinEnabled] = useState(true);
  const rememberedMyReplaySkin = viewerId ? peekMyReplaySkinMemory(viewerId) : undefined;
  const [myReplaySkin, setMyReplaySkinRecord] = useState<OwnerReplaySkinRecord | null>(
    () => rememberedMyReplaySkin ?? null,
  );
  const [myReplaySkinLoaded, setMyReplaySkinLoaded] = useState(
    () => viewerId != null && rememberedMyReplaySkin !== undefined,
  );
  const [customizing, setCustomizing] = useState(false);
  /* A custom skin brings its own notes and LN caps, and its art only draws
     under the Bars style, so the shape buttons and the tail trim have nothing
     to act on. The editor hides them for the same reason. Read after mount
     like the values above: localStorage is empty during SSR. */
  const [hasCustomSkinArt, setHasCustomSkinArt] = useState(false);

  useEffect(() => {
    setOwnerSkinEnabled(readReplayOwnerSkinEnabled());
  }, []);

  useEffect(() => {
    const sync = () => {
      setHasCustomSkinArt(readAppliedCommunityReplaySkin() != null || replaySkinSettingsEmbedAssets(skinSettings));
    };
    sync();
    window.addEventListener(REPLAY_SKIN_SETTINGS_CHANGE_EVENT, sync);
    return () => window.removeEventListener(REPLAY_SKIN_SETTINGS_CHANGE_EVENT, sync);
  }, [skinSettings]);

  useEffect(() => {
    if (!viewerId) {
      setMyReplaySkinRecord(null);
      setMyReplaySkinLoaded(false);
      return;
    }
    let cancelled = false;
    const remembered = peekMyReplaySkinMemory(viewerId);
    setMyReplaySkinRecord(remembered ?? null);
    setMyReplaySkinLoaded(remembered !== undefined);
    void fetchMyReplaySkinCached(viewerId)
      .then((record) => {
        if (cancelled) return;
        setMyReplaySkinRecord(record);
      })
      .catch(() => {})
      .finally(() => {
        if (!cancelled) setMyReplaySkinLoaded(true);
      });
    return () => {
      cancelled = true;
    };
  }, [viewerId]);

  const updateOwnerSkinEnabled = (enabled: boolean) => {
    setOwnerSkinEnabled(enabled);
    writeReplayOwnerSkinEnabled(enabled);
  };

  const removeMyReplaySkin = () => {
    const previous = myReplaySkin;
    setMyReplaySkinRecord(null);
    if (viewerId) writeMyReplaySkinMemory(viewerId, null);
    void clearMyReplaySkin()
      .then((result) => {
        if (result.ok) return;
        setMyReplaySkinRecord(previous);
        if (viewerId) writeMyReplaySkinMemory(viewerId, previous);
      })
      .catch(() => {
        setMyReplaySkinRecord(previous);
        if (viewerId) writeMyReplaySkinMemory(viewerId, previous);
      });
  };

  const updatedAtLabel = myReplaySkin
    ? new Date(myReplaySkin.updatedAt).toLocaleDateString("en-US", {
        year: "numeric",
        month: "short",
        day: "numeric",
      })
    : "";

  return (
    <div className="space-y-6">
      {hasCustomSkinArt ? null : (
        <PanelGroup label={t`Note shape`}>
          <div className="grid grid-cols-3 gap-2">
            {(Object.keys(STYLE_LABELS) as ReplaySkinStyle[]).map((style) => (
              <ShapeOption
                key={style}
                active={skinSettings.style === style}
                label={i18n._(STYLE_LABELS[style])}
                icon={<span aria-hidden="true" className="h-5 w-5 bg-current" style={STYLE_ICON_BY_NAME[style]} />}
                onClick={() => onUpdateSkin({ style })}
              />
            ))}
          </div>
        </PanelGroup>
      )}

      <PanelGroup label={hasCustomSkinArt ? t`Direction` : t`Direction & long notes`}>
        <div className="grid gap-3 sm:grid-cols-2">
          <SegmentedField
            label={t`Scroll direction`}
            value={skinSettings.upscroll ? "up" : "down"}
            options={[
              { value: "down", label: t`Downscroll`, icon: <ArrowDown className="h-3.5 w-3.5" strokeWidth={2.4} /> },
              { value: "up", label: t`Upscroll`, icon: <ArrowUp className="h-3.5 w-3.5" strokeWidth={2.4} /> },
            ]}
            onChange={(value) => onUpdateSkin({ upscroll: value === "up" })}
          />
          {hasCustomSkinArt ? null : (
            <SegmentedField
              label={t`LN tail`}
              value={skinSettings.percy ? "cut" : "full"}
              options={[
                {
                  value: "full",
                  label: t`Full`,
                  icon: <span aria-hidden="true" className="block h-3 w-2 rounded-sm bg-current" />,
                },
                {
                  value: "cut",
                  label: t`Cut`,
                  icon: <span aria-hidden="true" className="block h-1.5 w-2 rounded-sm bg-current" />,
                },
              ]}
              onChange={(value) => onUpdateSkin({ percy: value === "cut" })}
            />
          )}
        </div>
      </PanelGroup>

      <PanelGroup
        label={t`Advanced`}
        action={
          <button
            type="button"
            onClick={onOpenAdvanced}
            disabled={advancedLoading}
            aria-busy={advancedLoading}
            className="group inline-flex h-7 cursor-pointer items-center gap-1.5 rounded-md border border-osu-pink/40 bg-osu-pink/10 px-2.5 text-[10px] font-bold uppercase tracking-wider text-osu-pink-light transition-colors hover:border-osu-pink hover:bg-osu-pink/20 hover:text-white disabled:cursor-wait disabled:opacity-70"
          >
            {advancedLoading ? <Loader2 className="h-3 w-3 animate-spin" /> : <Pencil className="h-3 w-3" />}
            <Trans>Viewer editor</Trans>
          </button>
        }
      >
        <p className="text-[12px] leading-relaxed text-osu-f1">
          <Trans>Customize how replays look for you. This does not change the replay skin other people see on your plays.</Trans>
        </p>
      </PanelGroup>

      <PanelGroup label={t`Replay skin`}>
        <div className="flex items-center justify-between gap-3">
          <div>
            <div className="text-[12px] font-semibold text-osu-l1"><Trans>Watch replays with the player's skin</Trans></div>
            <div className="text-[11px] text-osu-f1">
              <Trans>Replays play with their player's published skin. Turn off to always use yours.</Trans>
            </div>
          </div>
          <Switch checked={ownerSkinEnabled} onChange={updateOwnerSkinEnabled} />
        </div>
        {viewerId ? (
          <div className="rounded-lg border border-osu-b3/40 bg-osu-b5/40 px-3 py-2.5">
            <div className="mb-1.5 text-[11px] font-semibold text-osu-l1"><Trans>Your replay skin</Trans></div>
            {!myReplaySkinLoaded ? null : myReplaySkin ? (
              <div className="flex flex-wrap items-center gap-3">
                {myReplaySkin.skin.previewUrl ? (
                  <img
                    src={myReplaySkin.skin.previewUrl}
                    alt=""
                    className="h-10 w-[71px] shrink-0 rounded-md object-cover"
                  />
                ) : null}
                {/* A floor on the text column: below it the button group wraps to
                    its own row instead of crushing the name to a letter, which
                    the longer es/zh button labels hit well before English. */}
                <div className="min-w-[140px] flex-1">
                  <div className="truncate text-[13px] font-semibold text-osu-l1">{myReplaySkin.skin.name}</div>
                  <div className="text-[11px] text-osu-f1">
                    {myReplaySkin.private ? t`private · updated ${updatedAtLabel}` : t`updated ${updatedAtLabel}`}
                  </div>
                </div>
                <div className="flex shrink-0 flex-wrap items-center gap-1.5">
                  <button
                    type="button"
                    onClick={() => setCustomizing(true)}
                    className="inline-flex h-7 cursor-pointer items-center rounded-md border border-osu-pink/40 bg-osu-pink/10 px-2.5 text-[10px] font-bold uppercase tracking-wider text-osu-pink-light transition-colors hover:border-osu-pink hover:bg-osu-pink/20 hover:text-white"
                  >
                    <Trans>Customize</Trans>
                  </button>
                  <Link
                    to="/skins"
                    search={{}}
                    className="inline-flex h-7 items-center rounded-md border border-osu-b3/60 bg-osu-b5/70 px-2.5 text-[10px] font-bold uppercase tracking-wider text-osu-f1 transition-colors hover:border-osu-b2 hover:text-white"
                  >
                    <Trans>Change</Trans>
                  </Link>
                  <button
                    type="button"
                    onClick={removeMyReplaySkin}
                    className="inline-flex h-7 cursor-pointer items-center rounded-md border border-osu-b3/60 bg-osu-b5/70 px-2.5 text-[10px] font-bold uppercase tracking-wider text-osu-f1 transition-colors hover:border-osu-red/60 hover:bg-osu-red/10 hover:text-osu-red"
                  >
                    <Trans>Remove</Trans>
                  </button>
                </div>
              </div>
            ) : (
              <p className="text-[12px] text-osu-f1">
                <Trans>
                  None set.{" "}
                  <Link
                    to="/skins"
                    search={{}}
                    className="font-semibold text-osu-pink-light transition-colors hover:text-white"
                  >
                    Pick one from the skins page
                  </Link>
                  .
                </Trans>
              </p>
            )}
          </div>
        ) : (
          <p className="text-[12px] text-osu-f1"><Trans>Sign in to set a replay skin for your plays.</Trans></p>
        )}
      </PanelGroup>

      <AnimatePresence>
        {customizing && myReplaySkin ? (
          <OwnerReplaySkinCustomizeModal
            record={myReplaySkin}
            onSaved={(record) => {
              setMyReplaySkinRecord(record);
              if (viewerId) writeMyReplaySkinMemory(viewerId, record);
            }}
            onClose={() => setCustomizing(false)}
          />
        ) : null}
      </AnimatePresence>
    </div>
  );
}

function ViewerPanel({
  scrollSpeed,
  onScrollSpeedChange,
  bgDim,
  onBgDimChange,
  volume,
  onVolumeChange,
  spectatorNameShown,
  onSpectatorNameShownChange,
}: {
  scrollSpeed: number;
  onScrollSpeedChange: (value: number) => void;
  bgDim: number;
  onBgDimChange: (value: number) => void;
  volume: number;
  onVolumeChange: (value: number) => void;
  spectatorNameShown: boolean;
  onSpectatorNameShownChange: (shown: boolean) => void;
}) {
  const { t } = useLingui();
  const volumePercent = Math.round(volume * 100);

  return (
    <div className="space-y-6">
      <PanelGroup label={t`Scroll speed`}>
        <NumberStepperSlider
          value={scrollSpeed}
          min={1}
          max={40}
          step={1}
          onChange={onScrollSpeedChange}
          hint={t`Higher values make notes travel faster across the playfield.`}
        />
      </PanelGroup>
      <PanelGroup label={t`Background dim`}>
        <PercentSlider
          value={bgDim}
          min={0}
          max={100}
          step={5}
          onChange={onBgDimChange}
          hint={t`Darkens the beatmap background so notes stay readable.`}
        />
      </PanelGroup>
      <PanelGroup label={t`Default volume`}>
        <div className="flex items-center gap-3">
          <span className="grid h-9 w-9 shrink-0 place-items-center rounded-lg border border-osu-b3/40 bg-osu-b5/55 text-osu-pink-light">
            <VolumeIcon volume={volume} className="h-4 w-4" />
          </span>
          <PercentSlider
            value={volumePercent}
            min={0}
            max={100}
            step={5}
            onChange={onVolumeChange}
            hint={t`Used when a replay or map preview opens.`}
            className="flex-1"
          />
        </div>
      </PanelGroup>
      <PanelGroup label={t`Spectators`}>
        <div className="flex items-center justify-between gap-3">
          <div>
            <div className="text-[12px] font-semibold text-osu-l1">
              <Trans>Show my name under spectators when watching a replay</Trans>
            </div>
            <div className="text-[11px] text-osu-f1">
              <Trans>Off means you are only part of the count. Needs you signed in.</Trans>
            </div>
          </div>
          <Switch checked={spectatorNameShown} onChange={onSpectatorNameShownChange} />
        </div>
      </PanelGroup>
    </div>
  );
}

function HiddenPlayersPanel() {
  const { t } = useLingui();
  const hiddenUsers = useAppStore((state) => state.hiddenUsers);
  const addHiddenUser = useAppStore((state) => state.addHiddenUser);
  const removeHiddenUser = useAppStore((state) => state.removeHiddenUser);

  const [query, setQuery] = useState("");
  const [results, setResults] = useState<HiddenUser[]>([]);
  const [status, setStatus] = useState<"idle" | "searching" | "error">("idle");
  const requestRef = useRef(0);

  const hiddenList = useMemo(
    () =>
      Object.values(hiddenUsers).sort((a, b) =>
        a.username.toLowerCase().localeCompare(b.username.toLowerCase()),
      ),
    [hiddenUsers],
  );
  const atLimit = hiddenList.length >= HIDDEN_USERS_LIMIT;

  useEffect(() => {
    const trimmed = query.trim();
    if (trimmed.length < 2) {
      setResults([]);
      setStatus("idle");
      return;
    }
    const requestId = ++requestRef.current;
    setStatus("searching");
    const timer = setTimeout(async () => {
      try {
        const res = await searchUsers({ data: { query: trimmed } });
        if (requestRef.current !== requestId) return;
        setResults(
          (res.user?.data ?? []).slice(0, 8).map((u) => ({
            id: u.id,
            username: u.username,
            avatarUrl: u.avatar_url,
            countryCode: u.country_code,
          })),
        );
        setStatus("idle");
      } catch {
        if (requestRef.current !== requestId) return;
        setResults([]);
        setStatus("error");
      }
    }, 300);
    return () => clearTimeout(timer);
  }, [query]);

  const trimmedQuery = query.trim();

  return (
    <div className="space-y-6">
      <PanelGroup label={t`Hide players`}>
        <p className="text-[12px] leading-relaxed text-osu-f1">
          <Trans>
            Players you hide are filtered out of rankings and feeds across the site. This list is
            stored on this browser only.
          </Trans>
        </p>
        <div className="relative">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-osu-f1" />
          <input
            type="text"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder={t`Search players by username`}
            disabled={atLimit}
            className="h-10 w-full rounded-lg border border-osu-b3/50 bg-osu-b5/70 pl-9 pr-9 text-sm text-osu-l1 outline-none transition-colors placeholder:text-osu-f1/70 focus:border-osu-pink/60 disabled:cursor-not-allowed disabled:opacity-50"
          />
          {status === "searching" ? (
            <Loader2 className="absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 animate-spin text-osu-pink-light" />
          ) : query ? (
            <button
              type="button"
              onClick={() => setQuery("")}
              className="absolute right-2 top-1/2 grid h-6 w-6 -translate-y-1/2 cursor-pointer place-items-center rounded text-osu-f1 transition-colors hover:bg-osu-b3/50 hover:text-white"
              aria-label={t`Clear search`}
            >
              <X className="h-3.5 w-3.5" strokeWidth={2.4} />
            </button>
          ) : null}
        </div>

        {atLimit ? (
          <p className="text-[11px] text-osu-red">
            <Trans>
              You have reached the limit of {HIDDEN_USERS_LIMIT} hidden players. Remove someone to add more.
            </Trans>
          </p>
        ) : trimmedQuery.length >= 2 ? (
          <div className="overflow-hidden rounded-lg border border-osu-b3/40 bg-osu-b5/40">
            {status === "error" ? (
              <p className="px-3 py-3 text-[12px] text-osu-f1"><Trans>Search failed. Try again.</Trans></p>
            ) : results.length === 0 && status === "idle" ? (
              <p className="px-3 py-3 text-[12px] text-osu-f1"><Trans>No players found.</Trans></p>
            ) : (
              <ul className="divide-y divide-osu-b3/30">
                {results.map((user) => {
                  const isHidden = user.id in hiddenUsers;
                  return (
                    <li key={user.id} className="flex items-center gap-3 px-3 py-2">
                      <Avatar url={user.avatarUrl} userId={user.id} size={32} />
                      <CountryFlag code={user.countryCode} size="md" />
                      <span className="min-w-0 flex-1 truncate text-[13px] font-semibold text-osu-l1">
                        {user.username}
                      </span>
                      {isHidden ? (
                        <span className="rounded-md border border-osu-b3/50 bg-osu-b5/70 px-2 py-1 text-[10px] font-bold uppercase tracking-wider text-osu-f1">
                          <Trans>Hidden</Trans>
                        </span>
                      ) : (
                        <button
                          type="button"
                          onClick={() => addHiddenUser(user)}
                          className="inline-flex h-7 cursor-pointer items-center rounded-md border border-osu-pink/40 bg-osu-pink/10 px-2.5 text-[10px] font-bold uppercase tracking-wider text-osu-pink-light transition-colors hover:border-osu-pink hover:bg-osu-pink/20 hover:text-white"
                        >
                          <Trans>Hide</Trans>
                        </button>
                      )}
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        ) : null}
      </PanelGroup>

      <PanelGroup label={t`Hidden list (${hiddenList.length})`}>
        {hiddenList.length === 0 ? (
          <p className="rounded-lg border border-osu-b3/40 bg-osu-b5/40 px-4 py-6 text-center text-[12px] text-osu-f1">
            <Trans>No players hidden.</Trans>
          </p>
        ) : (
          <ul className="space-y-2">
            {hiddenList.map((user) => (
              <li
                key={user.id}
                className="flex items-center gap-3 rounded-lg border border-osu-b3/40 bg-osu-b5/40 px-3 py-2"
              >
                <Avatar url={user.avatarUrl} userId={user.id} size={32} />
                <CountryFlag code={user.countryCode} size="md" />
                <span className="min-w-0 flex-1 truncate text-[13px] font-semibold text-osu-l1">
                  {user.username}
                </span>
                <button
                  type="button"
                  onClick={() => removeHiddenUser(user.id)}
                  className="inline-flex h-7 cursor-pointer items-center rounded-md border border-osu-b3/60 bg-osu-b5/70 px-2.5 text-[10px] font-bold uppercase tracking-wider text-osu-f1 transition-colors hover:border-osu-red/60 hover:bg-osu-red/10 hover:text-osu-red"
                >
                  <Trans>Unhide</Trans>
                </button>
              </li>
            ))}
          </ul>
        )}
      </PanelGroup>
    </div>
  );
}

function ShapeOption({
  active,
  label,
  icon,
  onClick,
}: {
  active: boolean;
  label: string;
  icon: ReactNode;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`flex h-16 cursor-pointer flex-col items-center justify-center gap-1 rounded-lg border text-xs font-bold transition-colors ${
        active
          ? "border-osu-pink bg-osu-pink/15 text-white"
          : "border-osu-b3/50 bg-osu-b5/55 text-osu-f1 hover:border-osu-b2 hover:text-white"
      }`}
    >
      {icon}
      <span>{label}</span>
    </button>
  );
}

function SegmentedField<T extends string>({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: T;
  options: { value: T; label: string; icon?: ReactNode }[];
  onChange: (value: T) => void;
}) {
  return (
    <div className="space-y-1.5">
      <span className="text-[11px] font-semibold text-osu-l1">{label}</span>
      <div
        className="grid rounded-lg border border-osu-b3/40 bg-osu-b5/55 p-1"
        style={{ gridTemplateColumns: `repeat(${options.length}, minmax(0, 1fr))` }}
      >
        {options.map((option) => {
          const active = option.value === value;
          return (
            <button
              key={option.value}
              type="button"
              onClick={() => onChange(option.value)}
              className={`inline-flex h-8 cursor-pointer items-center justify-center gap-1.5 rounded-md text-xs font-bold transition-colors ${
                active
                  ? "bg-osu-pink/20 text-white"
                  : "text-osu-f1 hover:bg-osu-b3/40 hover:text-white"
              }`}
            >
              {option.icon}
              {option.label}
            </button>
          );
        })}
      </div>
    </div>
  );
}

function NumberStepperSlider({
  value,
  min,
  max,
  step,
  onChange,
  hint,
}: {
  value: number;
  min: number;
  max: number;
  step: number;
  onChange: (value: number) => void;
  hint?: string;
}) {
  const { t } = useLingui();
  const fillRatio = max > min ? (value - min) / (max - min) : 0;
  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-1 rounded-lg border border-osu-b3/50 bg-osu-b5/70 p-1">
          <button
            type="button"
            onClick={() => onChange(Math.max(min, value - step))}
            disabled={value <= min}
            className="grid h-6 w-6 cursor-pointer place-items-center rounded text-osu-f1 transition-colors hover:bg-osu-b3/60 hover:text-white disabled:cursor-default disabled:opacity-40 disabled:hover:bg-transparent disabled:hover:text-osu-f1"
            aria-label={t`Decrease`}
          >
            <span className="text-base leading-none">−</span>
          </button>
          <span className="w-10 text-center text-sm font-bold tabular-nums text-white">{value}</span>
          <button
            type="button"
            onClick={() => onChange(Math.min(max, value + step))}
            disabled={value >= max}
            className="grid h-6 w-6 cursor-pointer place-items-center rounded text-osu-f1 transition-colors hover:bg-osu-b3/60 hover:text-white disabled:cursor-default disabled:opacity-40 disabled:hover:bg-transparent disabled:hover:text-osu-f1"
            aria-label={t`Increase`}
          >
            <span className="text-base leading-none">+</span>
          </button>
        </div>
        <div className="flex items-center gap-2 text-[10px] font-semibold text-osu-f1/80">
          <span>{min}</span>
          <span className="opacity-50">·</span>
          <span>{max}</span>
        </div>
      </div>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(event) => onChange(Number(event.target.value))}
        className="h-1.5 w-full cursor-pointer appearance-none rounded-full accent-osu-pink [&::-webkit-slider-thumb]:h-3.5 [&::-webkit-slider-thumb]:w-3.5 [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:border-2 [&::-webkit-slider-thumb]:border-white [&::-webkit-slider-thumb]:bg-osu-pink"
        style={{
          background: `linear-gradient(90deg, var(--color-osu-pink, #e83c90) 0%, var(--color-osu-pink, #e83c90) ${fillRatio * 100}%, rgba(38, 38, 51, 0.7) ${fillRatio * 100}%, rgba(38, 38, 51, 0.7) 100%)`,
        }}
      />
      {hint ? <p className="text-[11px] text-osu-f1">{hint}</p> : null}
    </div>
  );
}

function PercentSlider({
  value,
  min,
  max,
  step,
  onChange,
  hint,
  className = "",
}: {
  value: number;
  min: number;
  max: number;
  step: number;
  onChange: (value: number) => void;
  hint?: string;
  className?: string;
}) {
  const fillRatio = max > min ? (value - min) / (max - min) : 0;
  return (
    <div className={`space-y-2 ${className}`}>
      <div className="flex items-center justify-between gap-3">
        <span className="rounded-md border border-osu-b3/50 bg-osu-b5/70 px-2 py-0.5 text-xs font-bold tabular-nums text-white">
          {value}
          <span className="ml-0.5 text-osu-f1">%</span>
        </span>
        <div className="flex items-center gap-2 text-[10px] font-semibold text-osu-f1/80">
          <span>{min}%</span>
          <span className="opacity-50">·</span>
          <span>{max}%</span>
        </div>
      </div>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(event) => onChange(Number(event.target.value))}
        className="h-1.5 w-full cursor-pointer appearance-none rounded-full accent-osu-pink [&::-webkit-slider-thumb]:h-3.5 [&::-webkit-slider-thumb]:w-3.5 [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:border-2 [&::-webkit-slider-thumb]:border-white [&::-webkit-slider-thumb]:bg-osu-pink"
        style={{
          background: `linear-gradient(90deg, var(--color-osu-pink, #e83c90) 0%, var(--color-osu-pink, #e83c90) ${fillRatio * 100}%, rgba(38, 38, 51, 0.7) ${fillRatio * 100}%, rgba(38, 38, 51, 0.7) 100%)`,
        }}
      />
      {hint ? <p className="text-[11px] text-osu-f1">{hint}</p> : null}
    </div>
  );
}
