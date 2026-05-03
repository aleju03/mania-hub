import { createFileRoute, notFound } from "@tanstack/react-router";
import { useState } from "react";
import type { CSSProperties, ReactNode } from "react";
import { AnimatePresence } from "framer-motion";
import { ArrowDown, ArrowUp, Pencil, RotateCcw, Volume1, Volume2, VolumeX } from "lucide-react";

import { PageHeader } from "../components/layout/PageHeader";
import { PageTabs } from "../components/layout/PageTabs";
import { ReplaySkinSettingsModal } from "../components/replay/ReplaySkinSettingsModal";
import {
  DEFAULT_REPLAY_SKIN_SETTINGS,
  getReplaySkinProfile,
  normalizeReplaySkinSettings,
  readReplaySkinSettings,
  writeReplaySkinSettings,
} from "../lib/replay-skin";
import { DEFAULT_REPLAY_SCROLL_SPEED, normalizeReplayScrollSpeed, readReplayScrollSpeed, writeReplayScrollSpeed } from "../lib/replay-scroll-speed";
import {
  normalizeReplayBackgroundDim,
  normalizeReplayInputColor,
  normalizeReplayVolume,
  readReplayBackgroundDim,
  readReplayInputColor,
  readReplayInputOnly,
  readReplayInputOverlay,
  readReplayVolume,
  writeReplayBackgroundDim,
  writeReplayInputColor,
  writeReplayInputOnly,
  writeReplayInputOverlay,
  writeReplayVolume,
} from "../lib/replay-preferences";
import type { ReplaySkinSettings, ReplaySkinStyle } from "../lib/replay-skin";
import { pageSeo } from "../lib/seo";

export const Route = createFileRoute("/settings")({
  head: ({ match }) =>
    pageSeo({
      title: "Settings",
      description: "Manage app and replay preferences.",
      path: "/settings",
      origin: match.context.origin,
      noindex: true,
    }),
  beforeLoad: () => {
    if (typeof window !== "undefined") {
      const host = window.location.hostname;
      const isLocal = host === "localhost" || host === "127.0.0.1" || host === "::1";
      const isDevMode = import.meta.env.VITE_DEV_MODE === "1";
      if (!isLocal && !isDevMode) throw notFound();
    } else if (process.env.VITE_DEV_MODE !== "1" && process.env.NODE_ENV === "production") {
      throw notFound();
    }
  },
  component: SettingsPage,
});

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

const STYLE_LABELS: Record<ReplaySkinStyle, string> = {
  circles: "Circles",
  bars: "Bars",
  arrows: "Arrows",
};

type TabId = "skin" | "viewer" | "overlay" | "audio";
const TABS: { id: TabId; label: string }[] = [
  { id: "skin", label: "skin & layout" },
  { id: "viewer", label: "viewer" },
  { id: "overlay", label: "input overlay" },
  { id: "audio", label: "audio" },
];

function SettingsPage() {
  const [scrollSpeed, setScrollSpeed] = useState(readReplayScrollSpeed);
  const [bgDim, setBgDim] = useState(readReplayBackgroundDim);
  const [volume, setVolume] = useState(readReplayVolume);
  const [showInputOverlay, setShowInputOverlay] = useState(readReplayInputOverlay);
  const [inputOverlayOnly, setInputOverlayOnly] = useState(readReplayInputOnly);
  const [inputOverlayColor, setInputOverlayColor] = useState(readReplayInputColor);
  const [skinSettings, setSkinSettings] = useState(readReplaySkinSettings);
  const [skinSettingsOpen, setSkinSettingsOpen] = useState(false);
  const [activeTab, setActiveTab] = useState<TabId>("skin");

  const saveSkinSettings = (settings: ReplaySkinSettings) => {
    const normalized = normalizeReplaySkinSettings(settings);
    setSkinSettings(normalized);
    writeReplaySkinSettings(normalized);
  };

  const updateSkin = (patch: Partial<ReplaySkinSettings>) => {
    const next = normalizeReplaySkinSettings({ ...skinSettings, ...patch, version: 2 });
    setSkinSettings(next);
    writeReplaySkinSettings(next);
  };

  const resetReplaySettings = () => {
    setScrollSpeed(DEFAULT_REPLAY_SCROLL_SPEED);
    writeReplayScrollSpeed(DEFAULT_REPLAY_SCROLL_SPEED);
    setBgDim(80);
    writeReplayBackgroundDim(80);
    setVolume(0.5);
    writeReplayVolume(0.5);
    setShowInputOverlay(false);
    writeReplayInputOverlay(false);
    setInputOverlayOnly(false);
    writeReplayInputOnly(false);
    setInputOverlayColor("#a855f7");
    writeReplayInputColor("#a855f7");
    setSkinSettings(DEFAULT_REPLAY_SKIN_SETTINGS);
    writeReplaySkinSettings(DEFAULT_REPLAY_SKIN_SETTINGS);
  };

  return (
    <div className="flex-1">
      <PageHeader
        iconSrc="/images/icons/settings.svg"
        title="settings"
        right={
          <button
            type="button"
            onClick={resetReplaySettings}
            className="group inline-flex h-8 cursor-pointer items-center gap-1.5 rounded-lg border border-osu-b3/60 bg-osu-b5/70 px-3 text-[11px] font-bold text-osu-f1 transition-colors hover:border-osu-red/60 hover:bg-osu-red/10 hover:text-osu-red"
          >
            <RotateCcw className="h-3 w-3 transition-transform group-hover:-rotate-180 duration-300" />
            Reset all
          </button>
        }
      />
      <PageTabs items={TABS} value={activeTab} onChange={setActiveTab} />

      <div className="bg-osu-b5 min-h-[80vh]">
        <div className="mx-auto max-w-[900px] px-3 py-6 sm:px-5 sm:py-8 space-y-6">
          <SettingsHeroPreview
            skinSettings={skinSettings}
            scrollSpeed={scrollSpeed}
            bgDim={bgDim}
            volume={volume}
            showInputOverlay={showInputOverlay}
            inputOverlayOnly={inputOverlayOnly}
            inputOverlayColor={inputOverlayColor}
          />

          {activeTab === "skin" ? (
            <SkinPanel
              skinSettings={skinSettings}
              onUpdateSkin={updateSkin}
              onOpenAdvanced={() => setSkinSettingsOpen(true)}
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
            />
          ) : null}
          {activeTab === "overlay" ? (
            <OverlayPanel
              showInputOverlay={showInputOverlay}
              inputOverlayOnly={inputOverlayOnly}
              inputOverlayColor={inputOverlayColor}
              onShowOverlayChange={(checked) => {
                setShowInputOverlay(checked);
                writeReplayInputOverlay(checked);
              }}
              onInputOnlyChange={(checked) => {
                setInputOverlayOnly(checked);
                writeReplayInputOnly(checked);
              }}
              onColorChange={(value) => {
                const normalized = normalizeReplayInputColor(value);
                setInputOverlayColor(normalized);
                writeReplayInputColor(normalized);
              }}
            />
          ) : null}
          {activeTab === "audio" ? (
            <AudioPanel
              volume={volume}
              onChange={(value) => {
                const normalized = normalizeReplayVolume(value / 100);
                setVolume(normalized);
                writeReplayVolume(normalized);
              }}
            />
          ) : null}
        </div>
      </div>

      <AnimatePresence>
        {skinSettingsOpen ? (
          <ReplaySkinSettingsModal
            settings={skinSettings}
            keyCount={4}
            onSave={saveSkinSettings}
            onClose={() => setSkinSettingsOpen(false)}
          />
        ) : null}
      </AnimatePresence>
    </div>
  );
}

// ─── Hero preview ────────────────────────────────────────────────────────────

function SettingsHeroPreview({
  skinSettings,
  scrollSpeed,
  bgDim,
  volume,
  showInputOverlay,
  inputOverlayOnly,
  inputOverlayColor,
}: {
  skinSettings: ReplaySkinSettings;
  scrollSpeed: number;
  bgDim: number;
  volume: number;
  showInputOverlay: boolean;
  inputOverlayOnly: boolean;
  inputOverlayColor: string;
}) {
  const profile = getReplaySkinProfile(skinSettings, 4);
  return (
    <div className="overflow-hidden rounded-xl border border-osu-b3/40 bg-osu-b4/40">
      <div className="grid gap-4 p-4 sm:grid-cols-[minmax(0,1fr)_220px] sm:gap-6 sm:p-5">
        <div className="flex flex-col gap-3 min-w-0">
          <div className="flex items-center gap-2">
            <span className="text-[10px] font-bold uppercase tracking-[0.18em] text-osu-pink-light">Live preview</span>
            <span className="h-px flex-1 bg-osu-b3/40" />
            <span className="text-[10px] font-bold uppercase tracking-wider text-osu-f1">4K</span>
          </div>

          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            <SummaryChip label="Style" icon={<span aria-hidden="true" className="h-3.5 w-3.5 bg-osu-pink-light" style={STYLE_ICON_BY_NAME[skinSettings.style]} />}>
              {STYLE_LABELS[skinSettings.style]}
            </SummaryChip>
            <SummaryChip label="Direction" icon={skinSettings.upscroll ? <ArrowUp className="h-3.5 w-3.5 text-osu-pink-light" strokeWidth={2.6} /> : <ArrowDown className="h-3.5 w-3.5 text-osu-pink-light" strokeWidth={2.6} />}>
              {skinSettings.upscroll ? "Upscroll" : "Downscroll"}
            </SummaryChip>
            <SummaryChip label="Scroll" icon={<span className="text-[10px] font-bold text-osu-pink-light">×</span>}>
              {scrollSpeed}
            </SummaryChip>
            <SummaryChip label="BG dim" icon={<span className="h-3 w-3 rounded-sm border border-osu-pink-light/60" style={{ background: `rgba(0,0,0,${bgDim / 100})` }} />}>
              {bgDim}%
            </SummaryChip>
          </div>

          <div className="flex items-center gap-3 rounded-lg border border-osu-b3/40 bg-osu-b5/50 px-3 py-2">
            <VolumeIcon volume={volume} className="h-3.5 w-3.5 text-osu-pink-light shrink-0" />
            <div className="relative h-1.5 flex-1 overflow-hidden rounded-full bg-osu-b3/60">
              <div
                className="absolute inset-y-0 left-0 rounded-full bg-osu-pink"
                style={{ width: `${Math.round(volume * 100)}%` }}
              />
            </div>
            <span className="w-10 text-right text-[10px] font-bold tabular-nums text-osu-f1">{Math.round(volume * 100)}%</span>
            {showInputOverlay ? (
              <span className="ml-2 inline-flex items-center gap-1 rounded-md border border-osu-b3/40 bg-osu-b5/70 px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wider text-osu-f1">
                <span className="h-2 w-2 rounded-full" style={{ backgroundColor: inputOverlayColor, boxShadow: `0 0 6px ${inputOverlayColor}` }} />
                Overlay {inputOverlayOnly ? "only" : "on"}
              </span>
            ) : null}
          </div>
        </div>

        <div className="flex justify-center sm:justify-end">
          <ManiaPreviewCanvas
            settings={skinSettings}
            profile={profile}
            bgDim={bgDim}
            showInputOverlay={showInputOverlay}
            inputOverlayColor={inputOverlayColor}
            scrollSpeed={scrollSpeed}
          />
        </div>
      </div>
    </div>
  );
}

function SummaryChip({ label, icon, children }: { label: string; icon: ReactNode; children: ReactNode }) {
  return (
    <div className="flex items-center gap-2 rounded-lg border border-osu-b3/40 bg-osu-b5/55 px-3 py-2">
      <span className="grid h-6 w-6 shrink-0 place-items-center rounded-md bg-osu-pink/10 ring-1 ring-osu-pink/20">{icon}</span>
      <div className="min-w-0">
        <div className="text-[9px] font-bold uppercase tracking-wider text-osu-f1">{label}</div>
        <div className="truncate text-[12px] font-bold text-white">{children}</div>
      </div>
    </div>
  );
}

function VolumeIcon({ volume, className }: { volume: number; className?: string }) {
  if (volume <= 0.001) return <VolumeX className={className} />;
  if (volume < 0.5) return <Volume1 className={className} />;
  return <Volume2 className={className} />;
}

function ManiaPreviewCanvas({
  settings,
  profile,
  bgDim,
  showInputOverlay,
  inputOverlayColor,
  scrollSpeed,
}: {
  settings: ReplaySkinSettings;
  profile: ReturnType<typeof getReplaySkinProfile>;
  bgDim: number;
  showInputOverlay: boolean;
  inputOverlayColor: string;
  scrollSpeed: number;
}) {
  const width = 200;
  const height = 200;
  const keyCount = 4;
  const desiredPlayfieldWidth = keyCount * profile.columnWidth + Math.max(0, keyCount - 1) * profile.columnSpacing;
  const playfieldWidth = Math.min(160, desiredPlayfieldWidth);
  const layoutScale = desiredPlayfieldWidth > 0 ? playfieldWidth / desiredPlayfieldWidth : 1;
  const laneWidth = profile.columnWidth * layoutScale;
  const columnSpacing = profile.columnSpacing * layoutScale;
  const playfieldX = (width - playfieldWidth) / 2;
  const receptorY = height * (settings.upscroll ? settings.hitPosition : 768 - settings.hitPosition) / 768;
  const noteSize = settings.style === "circles" || settings.style === "arrows"
    ? Math.max(12, Math.min(laneWidth - 4, Math.max(20, laneWidth * 0.78)))
    : Math.max(6, Math.min(14, laneWidth - 6));

  const colorFor = (col: number) => profile.tapColors[col] || profile.tapColor;
  const pressedCols = showInputOverlay ? [1, 2] : [];
  const fallingNoteCount = 3;

  return (
    <div
      className="relative overflow-hidden rounded-lg ring-1 ring-osu-b3/40"
      style={{ width, height }}
    >
      {/* Faux background to demonstrate bg dim */}
      <div
        className="absolute inset-0"
        style={{
          background:
            "radial-gradient(circle at 30% 20%, rgba(232, 60, 144, 0.45), transparent 55%)," +
            "radial-gradient(circle at 75% 80%, rgba(102, 204, 255, 0.35), transparent 55%)," +
            "linear-gradient(135deg, #1a0e22, #0c0c14)",
        }}
      />
      <div className="absolute inset-0" style={{ backgroundColor: `rgba(0, 0, 0, ${bgDim / 100})` }} />

      {/* Lane separators */}
      {settings.style !== "circles" ? (
        <div className="absolute inset-y-0" style={{ left: playfieldX, width: playfieldWidth }}>
          {Array.from({ length: keyCount + 1 }, (_, index) => (
            <div
              key={index}
              className="absolute inset-y-0 w-px bg-white/10"
              style={{ left: index < keyCount ? index * (laneWidth + columnSpacing) : playfieldWidth }}
            />
          ))}
        </div>
      ) : null}

      {/* Hit line */}
      {settings.style !== "circles" ? (
        <div
          className="absolute h-0.5 bg-white/70"
          style={{ left: playfieldX, width: playfieldWidth, top: receptorY }}
        />
      ) : null}

      {/* Receptors + input overlay highlights */}
      {Array.from({ length: keyCount }, (_, col) => {
        const cx = playfieldX + (laneWidth + columnSpacing) * col + laneWidth / 2;
        const pressed = pressedCols.includes(col);
        const overlayHighlight = showInputOverlay && pressed ? (
          <div
            key={`overlay-${col}`}
            className="absolute"
            style={{
              left: cx - laneWidth / 2,
              top: settings.upscroll ? 0 : receptorY,
              width: laneWidth,
              height: settings.upscroll ? receptorY : height - receptorY,
              background: `linear-gradient(${settings.upscroll ? "180deg" : "0deg"}, ${inputOverlayColor}00, ${inputOverlayColor}66)`,
              boxShadow: `inset 0 0 12px ${inputOverlayColor}55`,
              pointerEvents: "none",
            }}
          />
        ) : null;

        if (settings.style === "circles") {
          return (
            <div key={`receptor-wrap-${col}`}>
              {overlayHighlight}
              <div
                className="absolute rounded-full border-2 border-white"
                style={{
                  left: cx - noteSize / 2,
                  top: receptorY - noteSize / 2,
                  width: noteSize,
                  height: noteSize,
                  opacity: pressed ? 1 : 0.5,
                }}
              />
            </div>
          );
        }
        return (
          <div key={`receptor-wrap-${col}`}>
            {overlayHighlight}
            <div
              className="absolute rounded-sm"
              style={{
                left: cx - noteSize / 2,
                top: settings.upscroll ? receptorY - 9 : receptorY + 3,
                width: noteSize,
                height: 6,
                backgroundColor: pressed ? colorFor(col) : "#ffffff",
                opacity: pressed ? 1 : 0.18,
              }}
            />
          </div>
        );
      })}

      {/* Falling notes - animated using scroll speed */}
      {Array.from({ length: fallingNoteCount }, (_, index) => {
        const col = (index + 1) % keyCount;
        const cx = playfieldX + (laneWidth + columnSpacing) * col + laneWidth / 2;
        const noteColor = colorFor(col);
        const animationDuration = Math.max(1.4, 6 - scrollSpeed * 0.13);
        const verticalRange = settings.upscroll ? receptorY : height - receptorY;
        const startY = settings.upscroll ? -16 : height + 6;
        const animationName = settings.upscroll ? "settings-preview-up" : "settings-preview-down";
        const style = {
          left: cx - noteSize / 2,
          top: startY,
          width: noteSize,
          height: settings.style === "bars" ? 8 : noteSize,
          backgroundColor: noteColor,
          animation: `${animationName} ${animationDuration}s linear ${(-index * animationDuration) / fallingNoteCount}s infinite`,
          "--preview-range": `${verticalRange + 24}px`,
        } as CSSProperties;
        if (settings.style === "circles") {
          return (
            <div
              key={`note-${index}`}
              className="absolute rounded-full ring-2 ring-white/50"
              style={style}
            />
          );
        }
        return (
          <div
            key={`note-${index}`}
            className="absolute rounded-sm shadow-[0_0_10px_rgba(255,255,255,0.15)]"
            style={style}
          />
        );
      })}

      <style>{`
        @keyframes settings-preview-down {
          to { transform: translateY(var(--preview-range)); }
        }
        @keyframes settings-preview-up {
          to { transform: translateY(calc(-1 * var(--preview-range))); }
        }
        @media (prefers-reduced-motion: reduce) {
          [style*="settings-preview-"] { animation: none !important; }
        }
      `}</style>

      <div className="absolute left-2 top-2 inline-flex items-center gap-1 rounded-md border border-osu-b3/50 bg-osu-b6/80 px-1.5 py-0.5 text-[8px] font-bold uppercase tracking-wider text-osu-pink-light backdrop-blur-sm">
        Preview
      </div>
    </div>
  );
}

// ─── Tab panels ──────────────────────────────────────────────────────────────

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

function SkinPanel({
  skinSettings,
  onUpdateSkin,
  onOpenAdvanced,
}: {
  skinSettings: ReplaySkinSettings;
  onUpdateSkin: (patch: Partial<ReplaySkinSettings>) => void;
  onOpenAdvanced: () => void;
}) {
  return (
    <div className="space-y-6">
      <PanelGroup label="Note shape">
        <div className="grid grid-cols-3 gap-2">
          {(Object.keys(STYLE_LABELS) as ReplaySkinStyle[]).map((style) => (
            <ShapeOption
              key={style}
              active={skinSettings.style === style}
              label={STYLE_LABELS[style]}
              icon={<span aria-hidden="true" className="h-5 w-5 bg-current" style={STYLE_ICON_BY_NAME[style]} />}
              onClick={() => onUpdateSkin({ style })}
            />
          ))}
        </div>
      </PanelGroup>

      <PanelGroup label="Direction & long notes">
        <div className="grid gap-3 sm:grid-cols-2">
          <SegmentedField
            label="Scroll direction"
            value={skinSettings.upscroll ? "up" : "down"}
            options={[
              { value: "down", label: "Downscroll", icon: <ArrowDown className="h-3.5 w-3.5" strokeWidth={2.4} /> },
              { value: "up", label: "Upscroll", icon: <ArrowUp className="h-3.5 w-3.5" strokeWidth={2.4} /> },
            ]}
            onChange={(value) => onUpdateSkin({ upscroll: value === "up" })}
          />
          <SegmentedField
            label="LN tail"
            value={skinSettings.percy ? "cut" : "full"}
            options={[
              {
                value: "full",
                label: "Full",
                icon: <span aria-hidden="true" className="block h-3 w-2 rounded-sm bg-current" />,
              },
              {
                value: "cut",
                label: "Cut",
                icon: <span aria-hidden="true" className="block h-1.5 w-2 rounded-sm bg-current" />,
              },
            ]}
            onChange={(value) => onUpdateSkin({ percy: value === "cut" })}
          />
        </div>
      </PanelGroup>

      <PanelGroup
        label="Advanced"
        action={
          <button
            type="button"
            onClick={onOpenAdvanced}
            className="group inline-flex h-7 cursor-pointer items-center gap-1.5 rounded-md border border-osu-pink/40 bg-osu-pink/10 px-2.5 text-[10px] font-bold uppercase tracking-wider text-osu-pink-light transition-colors hover:border-osu-pink hover:bg-osu-pink/20 hover:text-white"
          >
            <Pencil className="h-3 w-3" />
            Open editor
          </button>
        }
      >
        <p className="text-[12px] leading-relaxed text-osu-f1">
          Fine-tune per-column colors, column width and spacing, hit position, and LN body color in the dedicated skin editor.
        </p>
      </PanelGroup>
    </div>
  );
}

function ViewerPanel({
  scrollSpeed,
  onScrollSpeedChange,
  bgDim,
  onBgDimChange,
}: {
  scrollSpeed: number;
  onScrollSpeedChange: (value: number) => void;
  bgDim: number;
  onBgDimChange: (value: number) => void;
}) {
  return (
    <div className="space-y-6">
      <PanelGroup label="Scroll speed">
        <NumberStepperSlider
          value={scrollSpeed}
          min={1}
          max={40}
          step={1}
          onChange={onScrollSpeedChange}
          hint="Higher values make notes travel faster across the playfield."
        />
      </PanelGroup>
      <PanelGroup label="Background dim">
        <PercentSlider
          value={bgDim}
          min={0}
          max={100}
          step={5}
          onChange={onBgDimChange}
          hint="Darkens the beatmap background so notes stay readable."
        />
      </PanelGroup>
    </div>
  );
}

function OverlayPanel({
  showInputOverlay,
  inputOverlayOnly,
  inputOverlayColor,
  onShowOverlayChange,
  onInputOnlyChange,
  onColorChange,
}: {
  showInputOverlay: boolean;
  inputOverlayOnly: boolean;
  inputOverlayColor: string;
  onShowOverlayChange: (checked: boolean) => void;
  onInputOnlyChange: (checked: boolean) => void;
  onColorChange: (value: string) => void;
}) {
  return (
    <div className="space-y-6">
      <PanelGroup label="Visibility">
        <ToggleRow
          label="Show input overlay"
          description="Reveal column key presses synced to the replay"
          checked={showInputOverlay}
          onChange={onShowOverlayChange}
        />
        <ToggleRow
          label="Input only"
          description="Hide the playfield and only display the key flashes"
          checked={inputOverlayOnly}
          disabled={!showInputOverlay}
          onChange={onInputOnlyChange}
        />
      </PanelGroup>
      <PanelGroup label="Appearance">
        <div
          className={`flex items-center justify-between gap-3 rounded-lg border border-osu-b3/40 bg-osu-b5/40 px-4 py-3 transition-opacity ${
            showInputOverlay ? "" : "opacity-50"
          }`}
        >
          <div className="min-w-0">
            <div className="text-sm font-semibold text-osu-l1">Overlay color</div>
            <div className="mt-0.5 text-[11px] text-osu-f1">Tint applied to flashing column hits</div>
          </div>
          <label className="group relative h-9 w-16 shrink-0 cursor-pointer overflow-hidden rounded-lg border border-osu-b3/60 bg-osu-b5/70 transition-colors hover:border-osu-b2">
            <span
              className="absolute inset-1.5 rounded-md ring-1 ring-white/15 transition-transform group-hover:scale-95"
              style={{
                backgroundColor: inputOverlayColor,
                boxShadow: `0 0 12px ${inputOverlayColor}55`,
              }}
            />
            <input
              type="color"
              value={inputOverlayColor}
              onChange={(event) => onColorChange(event.target.value)}
              className="absolute inset-0 cursor-pointer opacity-0"
              aria-label="Input overlay color"
            />
          </label>
        </div>
      </PanelGroup>
    </div>
  );
}

function AudioPanel({ volume, onChange }: { volume: number; onChange: (value: number) => void }) {
  const percent = Math.round(volume * 100);
  return (
    <div className="space-y-6">
      <PanelGroup label="Default volume">
        <div className="space-y-3">
          <div className="flex items-center gap-3">
            <span className="grid h-9 w-9 shrink-0 place-items-center rounded-lg border border-osu-b3/40 bg-osu-b5/55 text-osu-pink-light">
              <VolumeIcon volume={volume} className="h-4 w-4" />
            </span>
            <PercentSlider
              value={percent}
              min={0}
              max={100}
              step={5}
              onChange={onChange}
              hint="Used when a replay or map preview opens."
              className="flex-1"
            />
          </div>
        </div>
      </PanelGroup>
    </div>
  );
}

// ─── Atoms ──────────────────────────────────────────────────────────────────

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
            aria-label="Decrease"
          >
            <span className="text-base leading-none">−</span>
          </button>
          <span className="w-10 text-center text-sm font-bold tabular-nums text-white">{value}</span>
          <button
            type="button"
            onClick={() => onChange(Math.min(max, value + step))}
            disabled={value >= max}
            className="grid h-6 w-6 cursor-pointer place-items-center rounded text-osu-f1 transition-colors hover:bg-osu-b3/60 hover:text-white disabled:cursor-default disabled:opacity-40 disabled:hover:bg-transparent disabled:hover:text-osu-f1"
            aria-label="Increase"
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
        className="h-1.5 w-full cursor-pointer appearance-none rounded-full accent-osu-pink [&::-webkit-slider-thumb]:h-3.5 [&::-webkit-slider-thumb]:w-3.5 [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:border-2 [&::-webkit-slider-thumb]:border-white [&::-webkit-slider-thumb]:bg-osu-pink [&::-webkit-slider-thumb]:shadow-[0_0_8px_rgba(232,60,144,0.6)]"
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
        className="h-1.5 w-full cursor-pointer appearance-none rounded-full accent-osu-pink [&::-webkit-slider-thumb]:h-3.5 [&::-webkit-slider-thumb]:w-3.5 [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:border-2 [&::-webkit-slider-thumb]:border-white [&::-webkit-slider-thumb]:bg-osu-pink [&::-webkit-slider-thumb]:shadow-[0_0_8px_rgba(232,60,144,0.6)]"
        style={{
          background: `linear-gradient(90deg, var(--color-osu-pink, #e83c90) 0%, var(--color-osu-pink, #e83c90) ${fillRatio * 100}%, rgba(38, 38, 51, 0.7) ${fillRatio * 100}%, rgba(38, 38, 51, 0.7) 100%)`,
        }}
      />
      {hint ? <p className="text-[11px] text-osu-f1">{hint}</p> : null}
    </div>
  );
}

function ToggleRow({
  label,
  description,
  checked,
  disabled = false,
  onChange,
}: {
  label: string;
  description?: string;
  checked: boolean;
  disabled?: boolean;
  onChange: (checked: boolean) => void;
}) {
  return (
    <div
      className={`flex items-center justify-between gap-3 rounded-lg border px-4 py-3 transition-colors ${
        disabled
          ? "border-osu-b3/30 bg-osu-b5/30 opacity-50"
          : checked
            ? "border-osu-pink/30 bg-osu-pink/5"
            : "border-osu-b3/40 bg-osu-b5/40 hover:border-osu-b3/60"
      }`}
    >
      <div className="min-w-0">
        <div className="text-sm font-semibold text-osu-l1">{label}</div>
        {description ? (
          <div className="mt-0.5 text-[11px] text-osu-f1">{description}</div>
        ) : null}
      </div>
      <button
        type="button"
        disabled={disabled}
        role="switch"
        aria-checked={checked}
        onClick={() => onChange(!checked)}
        className={`relative inline-flex h-5 w-9 shrink-0 cursor-pointer items-center rounded-full border p-0.5 transition-colors disabled:cursor-default ${
          checked ? "border-osu-pink bg-osu-pink" : "border-osu-b3/60 bg-osu-b5/80"
        }`}
      >
        <span
          className={`h-4 w-4 rounded-full bg-white shadow-sm transition-transform ${
            checked ? "translate-x-4" : "translate-x-0"
          }`}
        />
      </button>
    </div>
  );
}
