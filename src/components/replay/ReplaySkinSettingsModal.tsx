import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import type { CSSProperties, ReactNode } from "react";
import { motion } from "framer-motion";
import { Copy, Settings, X } from "lucide-react";

import {
  DEFAULT_REPLAY_SKIN_SETTINGS,
  getReplaySkinProfile,
  normalizeReplaySkinSettings,
  OSU_MANIA_MAX_HIT_POSITION,
  OSU_MANIA_MIN_HIT_POSITION,
  osuManiaHitPositionToReplayHitPosition,
  REPLAY_SKIN_MAX_COLUMN_WIDTH,
  REPLAY_SKIN_MAX_COLUMN_SPACING,
  REPLAY_SKIN_MIN_COLUMN_WIDTH,
  REPLAY_SKIN_MIN_COLUMN_SPACING,
  replayHitPositionToOsuManiaHitPosition,
} from "#/lib/replay-skin";
import type { ReplaySkinKeymodeProfile, ReplaySkinSettings, ReplaySkinStyle } from "#/lib/replay-skin";

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

const REPLAY_SKIN_PALETTE = [
  "#9cf2ae",
  "#dfffe6",
  "#5a8fff",
  "#de31ae",
  "#ffcc22",
  "#88da20",
  "#e3a5de",
  "#8b8b93",
  "#ffffff",
  "#20222b",
];

interface ReplaySkinSettingsModalProps {
  settings: ReplaySkinSettings;
  keyCount: number;
  onSave: (settings: ReplaySkinSettings) => void;
  onClose: () => void;
}

export function ReplaySkinSettingsModal({
  settings,
  keyCount,
  onSave,
  onClose,
}: ReplaySkinSettingsModalProps) {
  const [draft, setDraft] = useState(() => normalizeReplaySkinSettings(settings));
  const [selectedKeyCount, setSelectedKeyCount] = useState(() => Math.max(1, Math.min(10, keyCount)));
  const [activeColor, setActiveColor] = useState<"tap" | "lnHead" | "lnBody" | null>(null);
  const [activeTab, setActiveTab] = useState<"style" | "layout">("style");
  const [columnEditorOpen, setColumnEditorOpen] = useState(false);
  const [overrideKind, setOverrideKind] = useState<"tap" | "lnHead">("tap");
  const [overrideColumn, setOverrideColumn] = useState(0);
  const profile = getReplaySkinProfile(draft, selectedKeyCount);
  const [columnWidthInput, setColumnWidthInput] = useState(() => String(profile.columnWidth));
  const [columnSpacingInput, setColumnSpacingInput] = useState(() => String(profile.columnSpacing));
  const [hitPositionInput, setHitPositionInput] = useState(() => String(replayHitPositionToOsuManiaHitPosition(draft.hitPosition)));

  useEffect(() => {
    setColumnWidthInput(String(profile.columnWidth));
  }, [profile.columnWidth]);

  useEffect(() => {
    setColumnSpacingInput(String(profile.columnSpacing));
  }, [profile.columnSpacing]);

  useEffect(() => {
    setHitPositionInput(String(replayHitPositionToOsuManiaHitPosition(draft.hitPosition)));
  }, [draft.hitPosition]);

  const update = (patch: Partial<ReplaySkinSettings>) => {
    setDraft((current) => normalizeReplaySkinSettings({ ...current, ...patch, version: 2 }));
  };

  const updateStyle = (style: ReplaySkinStyle) => update({ style });

  const updateProfile = (patch: Partial<ReplaySkinKeymodeProfile>) => {
    setDraft((current) => {
      const currentProfile = getReplaySkinProfile(current, selectedKeyCount);
      return normalizeReplaySkinSettings({
        ...current,
        keymodeProfiles: {
          ...current.keymodeProfiles,
          [selectedKeyCount]: {
            ...currentProfile,
            ...patch,
          },
        },
        version: 2,
      });
    });
  };

  const updateBaseColor = (kind: "tap" | "lnHead", value: string) => {
    if (kind === "tap") updateProfile({ tapColor: value });
    else updateProfile({ lnHeadColor: value });
  };

  const updateOverrideColor = (kind: "tap" | "lnHead", column: number, value: string) => {
    setDraft((current) => {
      const currentProfile = getReplaySkinProfile(current, selectedKeyCount);
      const key = kind === "tap" ? "tapColors" : "lnHeadColors";
      const colors = [...currentProfile[key]];
      colors[column] = value;
      return normalizeReplaySkinSettings({
        ...current,
        keymodeProfiles: {
          ...current.keymodeProfiles,
          [selectedKeyCount]: {
            ...currentProfile,
            [key]: colors,
          },
        },
        version: 2,
      });
    });
  };

  const updateLnBodyColor = (value: string) => {
    update({ lnBodyColor: value });
  };

  const save = () => {
    onSave(draft);
    onClose();
  };

  const columns = Array.from({ length: selectedKeyCount }, (_, index) => index);
  const overrideColors = overrideKind === "tap" ? profile.tapColors : profile.lnHeadColors;
  const overrideBaseColor = overrideKind === "tap" ? profile.tapColor : profile.lnHeadColor;
  const hasOverride = !!overrideColors[overrideColumn];
  const overrideValue = overrideColors[overrideColumn] || overrideBaseColor;

  const commitColumnWidthInput = () => {
    const parsed = Number(columnWidthInput);
    if (!Number.isFinite(parsed)) {
      setColumnWidthInput(String(profile.columnWidth));
      return;
    }
    const next = Math.max(REPLAY_SKIN_MIN_COLUMN_WIDTH, Math.min(REPLAY_SKIN_MAX_COLUMN_WIDTH, Math.round(parsed)));
    setColumnWidthInput(String(next));
    updateProfile({ columnWidth: next });
  };

  const commitColumnSpacingInput = () => {
    const parsed = Number(columnSpacingInput);
    if (!Number.isFinite(parsed)) {
      setColumnSpacingInput(String(profile.columnSpacing));
      return;
    }
    const next = Math.max(REPLAY_SKIN_MIN_COLUMN_SPACING, Math.min(REPLAY_SKIN_MAX_COLUMN_SPACING, Math.round(parsed)));
    setColumnSpacingInput(String(next));
    updateProfile({ columnSpacing: next });
  };

  const commitHitPositionInput = () => {
    const parsed = Number(hitPositionInput);
    if (!Number.isFinite(parsed)) {
      setHitPositionInput(String(replayHitPositionToOsuManiaHitPosition(draft.hitPosition)));
      return;
    }
    const next = Math.max(OSU_MANIA_MIN_HIT_POSITION, Math.min(OSU_MANIA_MAX_HIT_POSITION, Math.round(parsed)));
    setHitPositionInput(String(next));
    update({ hitPosition: osuManiaHitPositionToReplayHitPosition(next) });
  };

  const handleColumnWidthInputChange = (value: string) => {
    setColumnWidthInput(value);
    if (value.trim() === "") return;
    const parsed = Number(value);
    if (!Number.isFinite(parsed) || parsed < REPLAY_SKIN_MIN_COLUMN_WIDTH || parsed > REPLAY_SKIN_MAX_COLUMN_WIDTH) return;
    updateProfile({ columnWidth: Math.round(parsed) });
  };

  const handleColumnSpacingInputChange = (value: string) => {
    setColumnSpacingInput(value);
    if (value.trim() === "") return;
    const parsed = Number(value);
    if (!Number.isFinite(parsed) || parsed < REPLAY_SKIN_MIN_COLUMN_SPACING || parsed > REPLAY_SKIN_MAX_COLUMN_SPACING) return;
    updateProfile({ columnSpacing: Math.round(parsed) });
  };

  const handleHitPositionInputChange = (value: string) => {
    setHitPositionInput(value);
    if (value.trim() === "") return;
    const parsed = Number(value);
    if (!Number.isFinite(parsed) || parsed < OSU_MANIA_MIN_HIT_POSITION || parsed > OSU_MANIA_MAX_HIT_POSITION) return;
    update({ hitPosition: osuManiaHitPositionToReplayHitPosition(Math.round(parsed)) });
  };

  if (typeof document === "undefined") return null;

  return createPortal(
    <>
      <motion.div
        className="fixed inset-0 z-[110] bg-black/60 backdrop-blur-[2px]"
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        transition={{ duration: 0.12 }}
        onClick={onClose}
      />
      <motion.div
        className="fixed inset-x-3 top-1/2 z-[111] mx-auto flex max-h-[calc(100vh-2rem)] max-w-3xl flex-col overflow-hidden rounded-xl border border-osu-b2/70 bg-osu-b4 shadow-2xl"
        initial={{ opacity: 0, y: "-48%", scale: 0.98 }}
        animate={{ opacity: 1, y: "-50%", scale: 1 }}
        exit={{ opacity: 0, y: "-48%", scale: 0.98 }}
        transition={{ duration: 0.14 }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-3 border-b border-osu-b3/50 px-5 py-4">
          <div>
            <h3 className="text-base font-bold text-white">Replay settings</h3>
            <div className="text-[10px] uppercase tracking-wider text-osu-f1">{activeTab === "style" ? "Style" : "Layout"}</div>
          </div>
          <button
            onClick={onClose}
            aria-label="Close replay settings"
            className="ml-auto flex h-8 w-8 cursor-pointer items-center justify-center rounded-lg bg-osu-b3/50 text-osu-f1 transition-colors hover:bg-osu-b3 hover:text-white"
          >
            <X className="h-4 w-4" strokeWidth={2.4} />
          </button>
        </div>

        <div className="grid min-h-0 flex-1 overflow-y-auto md:grid-cols-[minmax(0,1fr)_300px]">
          <div className="space-y-4 p-5">
            <label className="block">
              <span className="mb-2 block text-[10px] font-bold uppercase tracking-wider text-osu-f1">Skin preset</span>
              <select
                value="mania-dark"
                onChange={() => {}}
                className="h-10 w-full cursor-pointer rounded-lg border border-osu-b3/60 bg-osu-b5/70 px-3 text-sm font-semibold text-white outline-none transition-colors focus:border-osu-pink/70"
              >
                <option value="mania-dark">Mania Dark (Default)</option>
              </select>
            </label>

            <div className="grid grid-cols-2 rounded-lg bg-osu-b5/55 p-1">
              {([
                ["style", "Style"],
                ["layout", "Layout"],
              ] as const).map(([tab, label]) => (
                <button
                  key={tab}
                  type="button"
                  onClick={() => setActiveTab(tab)}
                  className={`h-8 cursor-pointer rounded-md text-xs font-bold transition-colors ${
                    activeTab === tab
                      ? "bg-osu-pink/20 text-white"
                      : "text-osu-f1 hover:text-white hover:bg-osu-b3/40"
                  }`}
                >
                  {label}
                </button>
              ))}
            </div>

            {activeTab === "style" ? (
              <>
                <section>
                  <div className="mb-2 text-[10px] font-bold uppercase tracking-wider text-osu-f1">Note shape</div>
                  <div className="grid grid-cols-3 gap-2">
                    <ReplaySkinShapeButton
                      active={draft.style === "circles"}
                      icon={<ReplaySkinShapeIcon style={MANIA_CIRCLE_ICON_STYLE} />}
                      label="Circles"
                      onClick={() => updateStyle("circles")}
                    />
                    <ReplaySkinShapeButton
                      active={draft.style === "bars"}
                      icon={<ReplaySkinShapeIcon style={MANIA_BAR_ICON_STYLE} />}
                      label="Bars"
                      onClick={() => updateStyle("bars")}
                    />
                    <ReplaySkinShapeButton
                      active={false}
                      disabled
                      icon={<ReplaySkinShapeIcon style={MANIA_ARROW_ICON_STYLE} />}
                      label="Arrows"
                      onClick={() => {}}
                    />
                  </div>
                </section>

                <section className="space-y-3 pt-2">
                  <ReplaySkinColorRow
                    label="Note color"
                    value={profile.tapColor}
                    selected={activeColor === "tap"}
                    onOpen={() => setActiveColor((current) => current === "tap" ? null : "tap")}
                  />
                  <ReplaySkinColorRow
                    label="LN Head color"
                    value={profile.lnHeadColor}
                    selected={activeColor === "lnHead"}
                    onOpen={() => setActiveColor((current) => current === "lnHead" ? null : "lnHead")}
                  />
                  <ReplaySkinColorRow
                    label="LN Body color"
                    value={draft.lnBodyColor}
                    selected={activeColor === "lnBody"}
                    onOpen={() => setActiveColor((current) => current === "lnBody" ? null : "lnBody")}
                  />
                  {activeColor ? (
                    <ReplaySkinColorPanel
                      value={activeColor === "tap" ? profile.tapColor : activeColor === "lnHead" ? profile.lnHeadColor : draft.lnBodyColor}
                      onChange={(value) => {
                        if (activeColor === "tap") updateBaseColor("tap", value);
                        else if (activeColor === "lnHead") updateBaseColor("lnHead", value);
                        else updateLnBodyColor(value);
                      }}
                    />
                  ) : null}
                </section>

                <section className="relative space-y-3 pt-2">
                  <div className="flex items-center justify-between gap-3">
                    <span className="text-sm font-semibold text-osu-l1">Per-column colors</span>
                    <span className="flex items-center gap-2">
                      <ReplaySkinSwitch checked={columnEditorOpen} onChange={setColumnEditorOpen} />
                      <button
                        type="button"
                        onClick={() => setColumnEditorOpen((value) => !value)}
                        aria-label="Edit per-column colors"
                        className="grid h-8 w-8 cursor-pointer place-items-center rounded-lg border border-osu-b3/60 bg-osu-b5/70 text-osu-f1 transition-colors hover:border-osu-b2 hover:text-white"
                      >
                        <Settings className="h-4 w-4" />
                      </button>
                    </span>
                  </div>
                  <div className="flex items-center justify-between gap-3">
                    <span className="text-sm font-semibold text-osu-l1">Cut LN tail</span>
                    <ReplaySkinSwitch checked={draft.percy} onChange={(checked) => update({ percy: checked })} />
                  </div>
                  <div className="flex items-center justify-between gap-3">
                    <span className="text-sm font-semibold text-osu-l1">Upscroll</span>
                    <ReplaySkinSwitch checked={draft.upscroll} onChange={(checked) => update({ upscroll: checked })} />
                  </div>

                  {columnEditorOpen ? (
                    <div className="absolute left-0 top-10 z-10 w-full rounded-xl border border-osu-b2/70 bg-osu-b4/95 p-4 shadow-2xl backdrop-blur sm:left-[46%] sm:w-80">
                      <div className="mb-3 grid grid-cols-7 gap-1.5">
                        {columns.map((column) => (
                          <button
                            key={column}
                            type="button"
                            onClick={() => setOverrideColumn(column)}
                            className={`h-8 cursor-pointer rounded-md text-xs font-bold transition-colors ${
                              overrideColumn === column
                                ? "bg-osu-pink text-white"
                                : "bg-osu-b5/80 text-osu-f1 hover:text-white"
                            }`}
                          >
                            {column + 1}
                          </button>
                        ))}
                      </div>
                      <div className="mb-3 inline-grid grid-cols-2 overflow-hidden rounded-lg bg-osu-b5/70 p-1">
                        {(["tap", "lnHead"] as const).map((kind) => (
                          <button
                            key={kind}
                            type="button"
                            onClick={() => setOverrideKind(kind)}
                            className={`cursor-pointer rounded-md px-3 py-1.5 text-xs font-bold transition-colors ${
                              overrideKind === kind ? "bg-osu-pink text-white" : "text-osu-f1 hover:text-white"
                            }`}
                          >
                            {kind === "tap" ? "Note" : "LN Head"}
                          </button>
                        ))}
                      </div>
                      <ReplaySkinColumnColorRow
                        label={overrideKind === "tap" ? "Note" : "LN Head"}
                        value={overrideValue}
                        onChange={(value) => updateOverrideColor(overrideKind, overrideColumn, value)}
                      />
                      <div className="mt-3 flex items-center gap-2">
                        <button
                          type="button"
                          onClick={() => {
                            for (const column of columns) updateOverrideColor(overrideKind, column, overrideValue);
                          }}
                          className="flex cursor-pointer items-center gap-1.5 rounded-lg border border-osu-b3/60 bg-osu-b5/70 px-2.5 py-1.5 text-xs font-semibold text-osu-f1 transition-colors hover:border-osu-b2 hover:text-white"
                        >
                          <Copy className="h-3.5 w-3.5" />
                          Copy to all
                        </button>
                        {hasOverride ? (
                          <button
                            type="button"
                            onClick={() => updateOverrideColor(overrideKind, overrideColumn, "")}
                            className="cursor-pointer rounded-lg px-2.5 py-1.5 text-xs font-semibold text-osu-f1 transition-colors hover:text-white"
                          >
                            Use base
                          </button>
                        ) : null}
                      </div>
                    </div>
                  ) : null}
                </section>
              </>
            ) : (
              <section className="space-y-4">
                <label className="block">
                  <span className="mb-2 flex items-center justify-between text-sm font-semibold text-osu-l1">
                    <span>Keymode</span>
                    <span className="text-[10px] uppercase tracking-wide text-osu-f1">Preview</span>
                  </span>
                  <select
                    value={selectedKeyCount}
                    onChange={(e) => setSelectedKeyCount(Number(e.target.value))}
                    className="h-9 w-full cursor-pointer rounded-lg border border-osu-b3/60 bg-osu-b5/70 px-3 text-sm font-semibold text-white outline-none transition-colors focus:border-osu-pink/70"
                  >
                    {Array.from({ length: 10 }, (_, index) => index + 1).map((count) => (
                      <option key={count} value={count}>{count}K</option>
                    ))}
                  </select>
                </label>

                <label className="block pt-1">
                  <span className="mb-2 flex items-center justify-between text-sm font-semibold text-osu-l1">
                    <span>Column width</span>
                    <span className="text-[10px] uppercase tracking-wide text-osu-f1">osu!mania skin.ini</span>
                  </span>
                  <input
                    type="number"
                    min={REPLAY_SKIN_MIN_COLUMN_WIDTH}
                    max={REPLAY_SKIN_MAX_COLUMN_WIDTH}
                    step={1}
                    value={columnWidthInput}
                    onChange={(e) => handleColumnWidthInputChange(e.target.value)}
                    onBlur={commitColumnWidthInput}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") e.currentTarget.blur();
                    }}
                    className="h-9 w-full rounded-lg border border-osu-b3/60 bg-osu-b5/70 px-3 text-sm font-semibold text-white outline-none transition-colors focus:border-osu-pink/70"
                  />
                  <span className="mt-1 block text-[10px] text-osu-f1">Default osu!mania value is 30.</span>
                </label>
                <label className="block pt-1">
                  <span className="mb-2 flex items-center justify-between text-sm font-semibold text-osu-l1">
                    <span>Column spacing</span>
                    <span className="text-[10px] uppercase tracking-wide text-osu-f1">osu!mania skin.ini</span>
                  </span>
                  <input
                    type="number"
                    min={REPLAY_SKIN_MIN_COLUMN_SPACING}
                    max={REPLAY_SKIN_MAX_COLUMN_SPACING}
                    step={1}
                    value={columnSpacingInput}
                    onChange={(e) => handleColumnSpacingInputChange(e.target.value)}
                    onBlur={commitColumnSpacingInput}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") e.currentTarget.blur();
                    }}
                    className="h-9 w-full rounded-lg border border-osu-b3/60 bg-osu-b5/70 px-3 text-sm font-semibold text-white outline-none transition-colors focus:border-osu-pink/70"
                  />
                  <span className="mt-1 block text-[10px] text-osu-f1">Default osu!mania value is 0.</span>
                </label>
                <label className="block pt-1">
                  <span className="mb-2 flex items-center justify-between text-sm font-semibold text-osu-l1">
                    <span>Hit position</span>
                    <span className="text-[10px] uppercase tracking-wide text-osu-f1">osu!mania skin.ini</span>
                  </span>
                  <input
                    type="number"
                    min={OSU_MANIA_MIN_HIT_POSITION}
                    max={OSU_MANIA_MAX_HIT_POSITION}
                    step={1}
                    value={hitPositionInput}
                    onChange={(e) => handleHitPositionInputChange(e.target.value)}
                    onBlur={commitHitPositionInput}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") e.currentTarget.blur();
                    }}
                    className="h-9 w-full rounded-lg border border-osu-b3/60 bg-osu-b5/70 px-3 text-sm font-semibold text-white outline-none transition-colors focus:border-osu-pink/70"
                  />
                  <span className="mt-1 block text-[10px] text-osu-f1">Default osu!mania value is 402. Higher values move receptors lower.</span>
                </label>
              </section>
            )}
          </div>

          <div className="border-l border-osu-b3/50 p-5">
            <div className="mb-2 text-sm font-semibold text-white">Live preview</div>
            <ReplaySkinPreview settings={draft} profile={profile} keyCount={selectedKeyCount} />
          </div>
        </div>

        <div className="flex shrink-0 items-center gap-2 border-t border-osu-b3/50 px-5 py-4">
          <button
            onClick={() => {
              setDraft(DEFAULT_REPLAY_SKIN_SETTINGS);
              setActiveColor(null);
              setOverrideColumn(0);
            }}
            className="mr-auto cursor-pointer rounded-lg bg-osu-b3/50 px-4 py-2 text-xs font-semibold text-osu-f1 transition-colors hover:bg-osu-b3 hover:text-white"
          >
            Reset
          </button>
          <button
            onClick={onClose}
            className="cursor-pointer rounded-lg bg-osu-b3/50 px-4 py-2 text-xs font-semibold text-osu-f1 transition-colors hover:bg-osu-b3 hover:text-white"
          >
            Cancel
          </button>
          <button
            onClick={save}
            className="cursor-pointer rounded-lg bg-osu-pink px-4 py-2 text-xs font-semibold text-white transition-colors hover:bg-osu-pink-light"
          >
            Apply
          </button>
        </div>
      </motion.div>
    </>,
    document.body,
  );
}

function hexToRgbParts(value: string): [number, number, number] {
  const normalized = /^#[0-9a-f]{6}$/i.test(value) ? value : "#ffffff";
  const raw = normalized.slice(1);
  return [
    Number.parseInt(raw.slice(0, 2), 16),
    Number.parseInt(raw.slice(2, 4), 16),
    Number.parseInt(raw.slice(4, 6), 16),
  ];
}

function rgbPartsToHex(r: number, g: number, b: number): string {
  return `#${[r, g, b].map((value) => Math.max(0, Math.min(255, Math.round(value))).toString(16).padStart(2, "0")).join("")}`;
}

function normalizeEditableHex(value: string): string | null {
  const trimmed = value.trim();
  if (/^#[0-9a-f]{6}$/i.test(trimmed)) return trimmed.toLowerCase();
  if (/^[0-9a-f]{6}$/i.test(trimmed)) return `#${trimmed.toLowerCase()}`;
  return null;
}

function ReplaySkinPreview({
  settings,
  profile,
  keyCount,
}: {
  settings: ReplaySkinSettings;
  profile: ReplaySkinKeymodeProfile;
  keyCount: number;
}) {
  const width = 260;
  const height = 300;
  const desiredPlayfieldWidth = keyCount * profile.columnWidth + Math.max(0, keyCount - 1) * profile.columnSpacing;
  const playfieldWidth = Math.min(230, desiredPlayfieldWidth);
  const layoutScale = desiredPlayfieldWidth > 0 ? playfieldWidth / desiredPlayfieldWidth : 1;
  const laneWidth = profile.columnWidth * layoutScale;
  const columnSpacing = profile.columnSpacing * layoutScale;
  const playfieldX = (width - playfieldWidth) / 2;
  const receptorY = height * (settings.upscroll ? settings.hitPosition : 768 - settings.hitPosition) / 768;
  const noteSize = settings.style === "circles"
    ? Math.max(18, Math.min(laneWidth - 4, Math.max(28, laneWidth * 0.74)))
    : Math.max(8, Math.min(18, laneWidth - 6));
  const lnCol = Math.min(keyCount - 1, Math.max(0, Math.floor(keyCount / 2)));
  const tapCols = [0, Math.max(0, keyCount - 2)].filter((col, index, arr) => arr.indexOf(col) === index && col !== lnCol);
  const colorFor = (colors: string[], fallback: string, col: number) => colors[col] || fallback;

  return (
    <div className="relative h-[300px] overflow-hidden rounded-lg border border-osu-b3/60 bg-[#07070c]">
      <div className="absolute inset-0 bg-gradient-to-b from-[#050509] to-[#10101a]" />
      {settings.style === "bars" ? (
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
      {settings.style === "bars" ? (
        <div className="absolute h-0.5 bg-white/70" style={{ left: playfieldX, width: playfieldWidth, top: receptorY }} />
      ) : null}
      {Array.from({ length: keyCount }, (_, col) => {
        const cx = playfieldX + (laneWidth + columnSpacing) * col + laneWidth / 2;
        const pressed = col === lnCol;
        if (settings.style === "circles") {
          return (
            <div
              key={col}
              className="absolute rounded-full border-2 border-white"
              style={{
                left: cx - noteSize / 2,
                top: receptorY - noteSize / 2,
                width: noteSize,
                height: noteSize,
                opacity: pressed ? 1 : 0.5,
              }}
            />
          );
        }
        return (
          <div
            key={col}
            className="absolute rounded-sm"
            style={{
              left: cx - noteSize / 2,
              top: receptorY + 4,
              width: noteSize,
              height: 7,
              backgroundColor: pressed ? colorFor(profile.tapColors, profile.tapColor, col) : "#ffffff",
              opacity: pressed ? 1 : 0.16,
            }}
          />
        );
      })}
      {tapCols.map((col, index) => {
        const cx = playfieldX + (laneWidth + columnSpacing) * col + laneWidth / 2;
        const y = settings.upscroll ? (index === 0 ? 204 : 154) : (index === 0 ? 54 : 104);
        const color = colorFor(profile.tapColors, profile.tapColor, col);
        return settings.style === "circles" ? (
          <div
            key={`tap-${col}`}
            className="absolute rounded-full ring-2 ring-white/55"
            style={{ left: cx - noteSize / 2, top: y, width: noteSize, height: noteSize, backgroundColor: color }}
          />
        ) : (
          <div
            key={`tap-${col}`}
            className="absolute rounded"
            style={{ left: cx - noteSize / 2, top: y, width: noteSize, height: 10, backgroundColor: color }}
          />
        );
      })}
      {(() => {
        const cx = playfieldX + (laneWidth + columnSpacing) * lnCol + laneWidth / 2;
        const bodyWidth = settings.style === "circles" ? Math.max(10, noteSize * 0.72) : noteSize;
        const bodyHeight = settings.percy ? 92 : 122;
        const bodyTop = settings.upscroll
          ? receptorY + 18
          : settings.percy ? 72 : 56;
        const headColor = colorFor(profile.lnHeadColors, profile.lnHeadColor, lnCol);
        return (
          <>
            <div
              className={`absolute ${settings.style === "circles" ? "rounded-t-full rounded-b-md" : "rounded-t-md rounded-b-sm"}`}
              style={{
                left: cx - bodyWidth / 2,
                top: bodyTop,
                width: bodyWidth,
                height: bodyHeight,
                backgroundColor: settings.lnBodyColor,
              }}
            />
            {settings.style === "circles" ? (
              <div
                className="absolute rounded-full ring-2 ring-white/55"
                style={{ left: cx - noteSize / 2, top: bodyTop + bodyHeight - noteSize / 2, width: noteSize, height: noteSize, backgroundColor: headColor }}
              />
            ) : (
              <div
                className="absolute rounded"
                style={{ left: cx - noteSize / 2, top: bodyTop + bodyHeight - 10, width: noteSize, height: 10, backgroundColor: headColor }}
              />
            )}
          </>
        );
      })()}
    </div>
  );
}

function ReplaySkinShapeIcon({ style }: { style: CSSProperties }) {
  return <span aria-hidden="true" className="h-4 w-4 bg-current" style={style} />;
}

function ReplaySkinShapeButton({
  active,
  disabled = false,
  icon,
  label,
  onClick,
}: {
  active: boolean;
  disabled?: boolean;
  icon: ReactNode;
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      className={`flex h-16 cursor-pointer flex-col items-center justify-center gap-1 rounded-lg border text-xs font-bold transition-colors disabled:cursor-not-allowed disabled:opacity-45 ${
        active
          ? "border-osu-pink bg-osu-pink/15 text-white"
          : "border-osu-b3/60 bg-osu-b5/55 text-osu-f1 hover:border-osu-b2 hover:text-white"
      }`}
    >
      {icon}
      <span>{label}</span>
    </button>
  );
}

function ReplaySkinColorRow({
  label,
  value,
  selected,
  onOpen,
}: {
  label: string;
  value: string;
  selected: boolean;
  onOpen: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onOpen}
      className={`grid w-full cursor-pointer grid-cols-[1fr_auto] items-center gap-3 rounded-lg text-left transition-colors ${
        selected ? "text-white" : "text-osu-f1 hover:text-white"
      }`}
    >
      <span className="text-sm font-semibold">{label}</span>
      <span className={`flex h-9 min-w-36 items-center gap-2 rounded-md border px-2 transition-colors ${
        selected ? "border-osu-pink/70 bg-osu-pink/10" : "border-osu-b3/60 bg-osu-b5/60"
      }`}>
        <span className="h-5 w-7 rounded-sm border border-white/35" style={{ backgroundColor: value }} />
        <span className="font-mono text-xs font-semibold text-osu-c1">{value}</span>
      </span>
    </button>
  );
}

function ReplaySkinColumnColorRow({
  label,
  value,
  onChange,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
}) {
  return (
    <div className="space-y-2">
      <ReplaySkinColorRow
        label={label}
        value={value}
        selected
        onOpen={() => {}}
      />
      <ReplaySkinColorPanel value={value} onChange={onChange} compact />
    </div>
  );
}

function ReplaySkinSwitch({ checked, onChange }: { checked: boolean; onChange: (checked: boolean) => void }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      onClick={() => onChange(!checked)}
      className={`inline-flex h-5 w-9 shrink-0 cursor-pointer items-center rounded-full border p-0.5 transition-colors ${
        checked ? "border-osu-pink bg-osu-pink" : "border-osu-b3/60 bg-osu-b5/80"
      }`}
    >
      <span
        className={`h-4 w-4 rounded-full bg-white shadow-sm transition-transform ${
          checked ? "translate-x-4" : "translate-x-0"
        }`}
      />
    </button>
  );
}

function ReplaySkinColorPanel({ value, onChange, compact = false }: { value: string; onChange: (value: string) => void; compact?: boolean }) {
  const [r, g, b] = hexToRgbParts(value);
  const updateRgb = (index: 0 | 1 | 2, next: number) => {
    const parts: [number, number, number] = [r, g, b];
    parts[index] = next;
    onChange(rgbPartsToHex(parts[0], parts[1], parts[2]));
  };

  return (
    <div className={`${compact ? "mt-2" : "mt-3 border-t border-osu-b3/45 pt-3"}`}>
      <div className="mb-3 flex flex-wrap gap-1.5">
        {REPLAY_SKIN_PALETTE.map((color) => (
          <button
            key={color}
            type="button"
            onClick={() => onChange(color)}
            className={`h-7 w-7 cursor-pointer rounded-md border transition-transform hover:scale-105 ${
              value === color ? "border-white" : "border-white/20"
            }`}
            style={{ backgroundColor: color }}
            title={color}
          />
        ))}
      </div>
      <div className="space-y-1.5">
        <ReplaySkinRgbSlider label="R" value={r} color="#ff5f7e" onChange={(next) => updateRgb(0, next)} />
        <ReplaySkinRgbSlider label="G" value={g} color="#45e37a" onChange={(next) => updateRgb(1, next)} />
        <ReplaySkinRgbSlider label="B" value={b} color="#5a8fff" onChange={(next) => updateRgb(2, next)} />
      </div>
      <input
        type="text"
        value={value}
        onChange={(event) => {
          const normalized = normalizeEditableHex(event.target.value);
          if (normalized) onChange(normalized);
        }}
        className="mt-3 w-full max-w-44 cursor-text rounded-md border border-osu-b3/50 bg-osu-b5 px-2 py-1.5 font-mono text-[11px] text-osu-c1 outline-none transition-colors focus:border-osu-pink/60"
      />
    </div>
  );
}

function ReplaySkinRgbSlider({
  label,
  value,
  color,
  onChange,
}: {
  label: string;
  value: number;
  color: string;
  onChange: (value: number) => void;
}) {
  return (
    <label className="grid grid-cols-[14px_1fr_32px] items-center gap-2 text-[10px] font-semibold text-osu-f1">
      <span>{label}</span>
      <input
        type="range"
        min={0}
        max={255}
        value={value}
        onChange={(event) => onChange(Number(event.target.value))}
        className="h-1.5 cursor-pointer appearance-none rounded-full bg-osu-b2 accent-osu-pink"
        style={{ backgroundImage: `linear-gradient(90deg, #15141d, ${color})` }}
      />
      <span className="text-right font-mono text-osu-c1">{value}</span>
    </label>
  );
}
