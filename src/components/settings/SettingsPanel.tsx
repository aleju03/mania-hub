import { useState } from "react";
import type { CSSProperties, ReactNode } from "react";
import { AnimatePresence } from "framer-motion";
import { ArrowDown, ArrowUp, Pencil, RotateCcw, Volume1, Volume2, VolumeX, X } from "lucide-react";

import { PageHeader } from "../layout/PageHeader";
import { PageTabs } from "../layout/PageTabs";
import { ReplaySkinSettingsModal } from "../replay/ReplaySkinSettingsModal";
import {
  DEFAULT_REPLAY_SKIN_SETTINGS,
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
  normalizeReplayInputColor,
  normalizeReplayVolume,
  readReplayBackgroundDim,
  readReplayInputColor,
  readReplayInputKeyHistory,
  readReplayInputOnly,
  readReplayInputOverlay,
  readReplayVolume,
  writeReplayBackgroundDim,
  writeReplayInputColor,
  writeReplayInputKeyHistory,
  writeReplayInputOnly,
  writeReplayInputOverlay,
  writeReplayVolume,
} from "../../lib/replay-preferences";
import type { ReplaySkinSettings, ReplaySkinStyle } from "../../lib/replay-skin";

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

type TabId = "skin" | "viewer" | "overlay";
const TABS: { id: TabId; label: string }[] = [
  { id: "skin", label: "skin & layout" },
  { id: "viewer", label: "playback" },
  { id: "overlay", label: "input overlay" },
];

type Variant = "page" | "drawer";

interface SettingsPanelProps {
  variant?: Variant;
  onClose?: () => void;
}

export function SettingsPanel({ variant = "page", onClose }: SettingsPanelProps) {
  const [scrollSpeed, setScrollSpeed] = useState(readReplayScrollSpeed);
  const [bgDim, setBgDim] = useState(readReplayBackgroundDim);
  const [volume, setVolume] = useState(readReplayVolume);
  const [showInputOverlay, setShowInputOverlay] = useState(readReplayInputOverlay);
  const [inputOverlayOnly, setInputOverlayOnly] = useState(readReplayInputOnly);
  const [inputOverlayKeyHistory, setInputOverlayKeyHistory] = useState(readReplayInputKeyHistory);
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
    setInputOverlayKeyHistory(false);
    writeReplayInputKeyHistory(false);
    setInputOverlayColor("#a855f7");
    writeReplayInputColor("#a855f7");
    setSkinSettings(DEFAULT_REPLAY_SKIN_SETTINGS);
    writeReplaySkinSettings(DEFAULT_REPLAY_SKIN_SETTINGS);
  };

  const resetButton = (
    <button
      type="button"
      onClick={resetReplaySettings}
      className="group inline-flex h-8 cursor-pointer items-center gap-1.5 rounded-lg border border-osu-b3/60 bg-osu-b5/70 px-3 text-[11px] font-bold text-osu-f1 transition-colors hover:border-osu-red/60 hover:bg-osu-red/10 hover:text-osu-red"
    >
      <RotateCcw className="h-3 w-3 transition-transform group-hover:-rotate-180 duration-300" />
      Reset all
    </button>
  );

  const body = (
    <>
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
          volume={volume}
          onVolumeChange={(value) => {
            const normalized = normalizeReplayVolume(value / 100);
            setVolume(normalized);
            writeReplayVolume(normalized);
          }}
        />
      ) : null}
      {activeTab === "overlay" ? (
        <OverlayPanel
          showInputOverlay={showInputOverlay}
          inputOverlayOnly={inputOverlayOnly}
          inputOverlayKeyHistory={inputOverlayKeyHistory}
          inputOverlayColor={inputOverlayColor}
          onShowOverlayChange={(checked) => {
            setShowInputOverlay(checked);
            writeReplayInputOverlay(checked);
          }}
          onInputOnlyChange={(checked) => {
            setInputOverlayOnly(checked);
            writeReplayInputOnly(checked);
          }}
          onInputKeyHistoryChange={(checked) => {
            setInputOverlayKeyHistory(checked);
            writeReplayInputKeyHistory(checked);
          }}
          onColorChange={(value) => {
            const normalized = normalizeReplayInputColor(value);
            setInputOverlayColor(normalized);
            writeReplayInputColor(normalized);
          }}
        />
      ) : null}
    </>
  );

  const skinModal = (
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
  );

  if (variant === "drawer") {
    return (
      <div className="flex h-full flex-col bg-osu-b5">
        <div className="flex items-center gap-2 border-b border-osu-b3/40 bg-osu-d5 px-4 py-3">
          <img src="/images/icons/settings.svg" alt="" width={22} height={22} className="opacity-60 shrink-0" />
          <h2 className="flex-1 text-[13px] font-semibold text-osu-c2">settings</h2>
          {resetButton}
          {onClose ? (
            <button
              type="button"
              onClick={onClose}
              className="grid h-8 w-8 cursor-pointer place-items-center rounded-lg text-osu-pink-light transition-colors hover:bg-osu-b3/50 hover:text-white"
              aria-label="Close settings"
            >
              <X className="h-4 w-4" strokeWidth={2.2} />
            </button>
          ) : null}
        </div>
        <PageTabs items={TABS} value={activeTab} onChange={setActiveTab} />
        <div className="flex-1 overflow-y-auto">
          <div className="px-3 py-5 sm:px-5 sm:py-6 space-y-6">{body}</div>
        </div>
        {skinModal}
      </div>
    );
  }

  return (
    <div className="flex-1">
      <PageHeader iconSrc="/images/icons/settings.svg" title="settings" right={resetButton} />
      <PageTabs items={TABS} value={activeTab} onChange={setActiveTab} />
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
  volume,
  onVolumeChange,
}: {
  scrollSpeed: number;
  onScrollSpeedChange: (value: number) => void;
  bgDim: number;
  onBgDimChange: (value: number) => void;
  volume: number;
  onVolumeChange: (value: number) => void;
}) {
  const volumePercent = Math.round(volume * 100);

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
      <PanelGroup label="Default volume">
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
            hint="Used when a replay or map preview opens."
            className="flex-1"
          />
        </div>
      </PanelGroup>
    </div>
  );
}

function OverlayPanel({
  showInputOverlay,
  inputOverlayOnly,
  inputOverlayKeyHistory,
  inputOverlayColor,
  onShowOverlayChange,
  onInputOnlyChange,
  onInputKeyHistoryChange,
  onColorChange,
}: {
  showInputOverlay: boolean;
  inputOverlayOnly: boolean;
  inputOverlayKeyHistory: boolean;
  inputOverlayColor: string;
  onShowOverlayChange: (checked: boolean) => void;
  onInputOnlyChange: (checked: boolean) => void;
  onInputKeyHistoryChange: (checked: boolean) => void;
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
        <ToggleRow
          label="Key overlay input stream"
          description="Show incoming replay inputs above the key labels"
          checked={inputOverlayKeyHistory}
          disabled={!showInputOverlay}
          onChange={onInputKeyHistoryChange}
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
