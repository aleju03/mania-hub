import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import type { ReactNode } from "react";
import { AnimatePresence } from "framer-motion";
import { ChevronDown, ChevronUp, Eye, Keyboard, Palette, RotateCcw, Volume2 } from "lucide-react";

import { PageHeader } from "../components/layout/PageHeader";
import { ReplaySkinSettingsModal } from "../components/replay/ReplaySkinSettingsModal";
import {
  DEFAULT_REPLAY_SKIN_SETTINGS,
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
import type { ReplaySkinSettings } from "../lib/replay-skin";
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
  component: SettingsPage,
});

function SettingsPage() {
  const [scrollSpeed, setScrollSpeed] = useState(readReplayScrollSpeed);
  const [bgDim, setBgDim] = useState(readReplayBackgroundDim);
  const [volume, setVolume] = useState(readReplayVolume);
  const [showInputOverlay, setShowInputOverlay] = useState(readReplayInputOverlay);
  const [inputOverlayOnly, setInputOverlayOnly] = useState(readReplayInputOnly);
  const [inputOverlayColor, setInputOverlayColor] = useState(readReplayInputColor);
  const [skinSettings, setSkinSettings] = useState(readReplaySkinSettings);
  const [skinSettingsOpen, setSkinSettingsOpen] = useState(false);

  const saveSkinSettings = (settings: ReplaySkinSettings) => {
    const normalized = normalizeReplaySkinSettings(settings);
    setSkinSettings(normalized);
    writeReplaySkinSettings(normalized);
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
      <PageHeader iconSrc="/images/icons/settings.svg" title="settings" />

      <div className="bg-osu-b5 min-h-[80vh]">
        <div className="mx-auto max-w-[1200px] px-3 py-4 sm:px-5 sm:py-6">
          <div className="grid gap-4 lg:grid-cols-[220px_minmax(0,1fr)]">
            <aside className="rounded-lg border border-osu-b3/30 bg-osu-b4/70 p-2 lg:sticky lg:top-[76px] lg:self-start">
              <button
                type="button"
                className="flex w-full items-center gap-2 rounded-md bg-osu-pink/15 px-3 py-2 text-left text-xs font-bold text-white"
              >
                <Palette className="h-4 w-4 text-osu-pink-light" />
                Replay
              </button>
            </aside>

            <section className="space-y-4">
              <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-osu-b3/30 bg-osu-b4/70 px-4 py-3">
                <div>
                  <h1 className="text-base font-bold text-white">Replay settings</h1>
                  <p className="mt-0.5 text-xs text-osu-f1">Preferences here apply to the replay viewer and map previews.</p>
                </div>
                <button
                  type="button"
                  onClick={resetReplaySettings}
                  className="inline-flex h-9 items-center gap-2 rounded-lg border border-osu-b3/60 bg-osu-b5/70 px-3 text-xs font-bold text-osu-f1 transition-colors hover:border-osu-b2 hover:text-white"
                >
                  <RotateCcw className="h-4 w-4" />
                  Reset
                </button>
              </div>

              <div className="grid gap-3 xl:grid-cols-2">
                <SettingsPanel icon={<Palette className="h-5 w-5" />} title="Skin and layout">
                  <div className="grid grid-cols-2 gap-2 text-xs">
                    <Readout label="Style" value={skinSettings.style} />
                    <Readout label="Direction" value={skinSettings.upscroll ? "upscroll" : "downscroll"} />
                    <Readout label="LN tail" value={skinSettings.percy ? "cut" : "full"} />
                    <Readout label="Hit position" value={String(skinSettings.hitPosition)} />
                  </div>
                  <button
                    type="button"
                    onClick={() => setSkinSettingsOpen(true)}
                    className="mt-4 h-9 w-full rounded-lg bg-osu-pink px-3 text-xs font-bold text-white transition-colors hover:bg-osu-pink-light"
                  >
                    Edit skin
                  </button>
                </SettingsPanel>

                <SettingsPanel icon={<Eye className="h-5 w-5" />} title="Viewer">
                  <NumberStepper
                    label="Scroll speed"
                    value={scrollSpeed}
                    min={1}
                    max={40}
                    onChange={(value) => {
                      const normalized = normalizeReplayScrollSpeed(value);
                      setScrollSpeed(normalized);
                      writeReplayScrollSpeed(normalized);
                    }}
                  />
                  <RangeRow
                    label="Background dim"
                    value={bgDim}
                    min={0}
                    max={100}
                    step={5}
                    suffix="%"
                    onChange={(value) => {
                      const normalized = normalizeReplayBackgroundDim(value);
                      setBgDim(normalized);
                      writeReplayBackgroundDim(normalized);
                    }}
                  />
                </SettingsPanel>

                <SettingsPanel icon={<Keyboard className="h-5 w-5" />} title="Input overlay">
                  <ToggleRow
                    label="Show input overlay"
                    checked={showInputOverlay}
                    onChange={(checked) => {
                      setShowInputOverlay(checked);
                      writeReplayInputOverlay(checked);
                    }}
                  />
                  <ToggleRow
                    label="Input only"
                    checked={inputOverlayOnly}
                    disabled={!showInputOverlay}
                    onChange={(checked) => {
                      setInputOverlayOnly(checked);
                      writeReplayInputOnly(checked);
                    }}
                  />
                  <div className="flex items-center justify-between gap-3">
                    <span className="text-sm font-semibold text-osu-l1">Overlay color</span>
                    <label className="relative h-9 w-12 cursor-pointer overflow-hidden rounded-lg border border-osu-b3/60 bg-osu-b5/70">
                      <span className="absolute inset-2 rounded" style={{ backgroundColor: inputOverlayColor }} />
                      <input
                        type="color"
                        value={inputOverlayColor}
                        onChange={(event) => {
                          const normalized = normalizeReplayInputColor(event.target.value);
                          setInputOverlayColor(normalized);
                          writeReplayInputColor(normalized);
                        }}
                        className="absolute inset-0 cursor-pointer opacity-0"
                        aria-label="Input overlay color"
                      />
                    </label>
                  </div>
                </SettingsPanel>

                <SettingsPanel icon={<Volume2 className="h-5 w-5" />} title="Audio">
                  <RangeRow
                    label="Default volume"
                    value={Math.round(volume * 100)}
                    min={0}
                    max={100}
                    step={5}
                    suffix="%"
                    onChange={(value) => {
                      const normalized = normalizeReplayVolume(value / 100);
                      setVolume(normalized);
                      writeReplayVolume(normalized);
                    }}
                  />
                </SettingsPanel>
              </div>
            </section>
          </div>
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

function SettingsPanel({ icon, title, children }: { icon: ReactNode; title: string; children: ReactNode }) {
  return (
    <div className="rounded-lg border border-osu-b3/30 bg-osu-b4/70 p-4">
      <div className="mb-4 flex items-center gap-2 text-white">
        <span className="grid h-9 w-9 place-items-center rounded-lg bg-osu-b5/80 text-osu-pink-light">{icon}</span>
        <h2 className="text-sm font-bold">{title}</h2>
      </div>
      <div className="space-y-3">{children}</div>
    </div>
  );
}

function Readout({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-md bg-osu-b5/70 px-3 py-2">
      <div className="text-[10px] font-bold uppercase tracking-wider text-osu-f1">{label}</div>
      <div className="mt-1 truncate font-semibold capitalize text-white">{value}</div>
    </div>
  );
}

function NumberStepper({ label, value, min, max, onChange }: { label: string; value: number; min: number; max: number; onChange: (value: number) => void }) {
  return (
    <div className="flex items-center justify-between gap-3">
      <span className="text-sm font-semibold text-osu-l1">{label}</span>
      <div className="flex items-center gap-1">
        <button
          type="button"
          onClick={() => onChange(Math.max(min, value - 1))}
          className="grid h-8 w-8 place-items-center rounded-lg bg-osu-b3/50 text-osu-f1 transition-colors hover:bg-osu-b3 hover:text-white"
          aria-label={`Decrease ${label.toLowerCase()}`}
        >
          <ChevronDown className="h-4 w-4" />
        </button>
        <span className="w-9 text-center text-sm font-bold tabular-nums text-white">{value}</span>
        <button
          type="button"
          onClick={() => onChange(Math.min(max, value + 1))}
          className="grid h-8 w-8 place-items-center rounded-lg bg-osu-b3/50 text-osu-f1 transition-colors hover:bg-osu-b3 hover:text-white"
          aria-label={`Increase ${label.toLowerCase()}`}
        >
          <ChevronUp className="h-4 w-4" />
        </button>
      </div>
    </div>
  );
}

function RangeRow({
  label,
  value,
  min,
  max,
  step,
  suffix,
  onChange,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  suffix: string;
  onChange: (value: number) => void;
}) {
  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between gap-3">
        <span className="text-sm font-semibold text-osu-l1">{label}</span>
        <span className="text-xs font-bold tabular-nums text-white">{value}{suffix}</span>
      </div>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(event) => onChange(Number(event.target.value))}
        className="h-1.5 w-full appearance-none rounded-full bg-osu-b3 cursor-pointer [&::-webkit-slider-thumb]:h-3.5 [&::-webkit-slider-thumb]:w-3.5 [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-osu-pink"
      />
    </div>
  );
}

function ToggleRow({ label, checked, disabled = false, onChange }: { label: string; checked: boolean; disabled?: boolean; onChange: (checked: boolean) => void }) {
  return (
    <div className={`flex items-center justify-between gap-3 ${disabled ? "opacity-50" : ""}`}>
      <span className="text-sm font-semibold text-osu-l1">{label}</span>
      <button
        type="button"
        disabled={disabled}
        role="switch"
        aria-checked={checked}
        onClick={() => onChange(!checked)}
        className={`relative h-6 w-11 rounded-full transition-colors disabled:cursor-default ${
          checked ? "bg-osu-pink" : "bg-osu-b3"
        }`}
      >
        <span
          className={`absolute top-1 h-4 w-4 rounded-full bg-white transition-transform ${
            checked ? "translate-x-6" : "translate-x-1"
          }`}
        />
      </button>
    </div>
  );
}
