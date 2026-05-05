import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { CSSProperties, PointerEvent as ReactPointerEvent, ReactNode } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { ChevronDown, Copy, Download, FileArchive, GripHorizontal, Pencil, Save, Settings, Trash2, Upload, X } from "lucide-react";

import {
  DEFAULT_REPLAY_SKIN_SETTINGS,
  OSU_MANIA_DEFAULT_COMBO_POSITION,
  OSU_MANIA_DEFAULT_SCORE_POSITION,
  getReplaySkinProfile,
  normalizeReplaySkinSettings,
  OSU_MANIA_MAX_HIT_POSITION,
  OSU_MANIA_MIN_HIT_POSITION,
  osuManiaHitPositionToReplayHitPosition,
  osuManiaStagePositionToReplayPosition,
  createReplaySkinPreset,
  createReplaySkinShareKey,
  parseReplaySkinShareKey,
  readReplaySkinPresets,
  REPLAY_SKIN_MAX_COLUMN_WIDTH,
  REPLAY_SKIN_MAX_COLUMN_SPACING,
  REPLAY_SKIN_MAX_NOTE_HEIGHT_SCALE,
  REPLAY_SKIN_MIN_COLUMN_WIDTH,
  REPLAY_SKIN_MIN_COLUMN_SPACING,
  REPLAY_SKIN_MIN_NOTE_HEIGHT_SCALE,
  replayHitPositionToOsuManiaHitPosition,
  replayStagePositionToOsuManiaPosition,
  writeReplaySkinPresets,
} from "#/lib/replay-skin";
import { importReplaySkinFromOsk } from "#/lib/replay-skin-import";
import type { ReplaySkinImageAsset, ReplaySkinKeymodeProfile, ReplaySkinPreset, ReplaySkinSettings, ReplaySkinStyle } from "#/lib/replay-skin";

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

type ColorTarget = "tap" | "lnHead" | "lnBody";
type OverrideKind = "tap" | "lnHead";
type PreviewMode = "tap" | "ln";
type ArrowDirection = "left" | "right" | "up" | "down";

type SelectionMode = "replace" | "toggle" | "range";

function applySelection(current: number[], column: number, mode: SelectionMode): number[] {
  if (mode === "toggle") {
    if (current.includes(column)) {
      const next = current.filter((c) => c !== column);
      return next.length > 0 ? next : current;
    }
    return [...current, column].sort((a, b) => a - b);
  }
  if (mode === "range") {
    const anchor = current[current.length - 1] ?? column;
    const lo = Math.min(anchor, column);
    const hi = Math.max(anchor, column);
    const range: number[] = [];
    for (let i = lo; i <= hi; i += 1) range.push(i);
    return range;
  }
  return [column];
}

function arraysEqualUnordered(a: number[], b: number[]): boolean {
  if (a.length !== b.length) return false;
  const sa = [...a].sort((x, y) => x - y);
  const sb = [...b].sort((x, y) => x - y);
  return sa.every((v, i) => v === sb[i]);
}

function getColumnArrowDirection(col: number, keyCount: number): ArrowDirection {
  if (keyCount <= 1) return "down";
  if (col === 0) return "left";
  if (col === keyCount - 1) return "right";
  return col % 2 === 1 ? "down" : "up";
}

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
  const modalRef = useRef<HTMLDivElement | null>(null);
  const oskInputRef = useRef<HTMLInputElement | null>(null);
  const [windowRect, setWindowRect] = useState<WindowRect | null>(null);
  const dragStateRef = useRef<{ pointerId: number; startX: number; startY: number; startRect: WindowRect } | null>(null);
  const resizeStateRef = useRef<{ pointerId: number; dir: ResizeDirection; startX: number; startY: number; startRect: WindowRect } | null>(null);
  const [draft, setDraft] = useState(() => normalizeReplaySkinSettings(settings));
  const [presets, setPresets] = useState<ReplaySkinPreset[]>(() => readReplaySkinPresets());
  const [selectedPresetId, setSelectedPresetId] = useState("custom");
  const [toast, setToast] = useState<{ id: number; message: string; tone: "info" | "error" } | null>(null);
  const toastIdRef = useRef(0);
  const pushStatus = useCallback((message: string, tone: "info" | "error" = "info") => {
    toastIdRef.current += 1;
    setToast({ id: toastIdRef.current, message, tone });
  }, []);
  const [promptDialog, setPromptDialog] = useState<{
    title: string;
    label?: string;
    initial: string;
    placeholder?: string;
    confirmLabel?: string;
    multiline?: boolean;
    onSubmit: (value: string) => void;
  } | null>(null);
  const [keyDialog, setKeyDialog] = useState<{ title: string; value: string } | null>(null);
  const [importingOsk, setImportingOsk] = useState(false);
  const [selectedKeyCount, setSelectedKeyCount] = useState(() => Math.max(1, Math.min(10, keyCount)));
  const [activeColor, setActiveColor] = useState<ColorTarget | null>(null);
  const [activeTab, setActiveTab] = useState<"style" | "layout">("style");
  const [columnEditorOpen, setColumnEditorOpen] = useState(false);
  const [overrideKind, setOverrideKind] = useState<OverrideKind>("tap");
  const [selectedColumns, setSelectedColumns] = useState<number[]>([]);
  const [previewMode, setPreviewMode] = useState<PreviewMode>("tap");
  const profile = getReplaySkinProfile(draft, selectedKeyCount);
  const [columnWidthInput, setColumnWidthInput] = useState(() => String(profile.columnWidth));
  const [columnSpacingInput, setColumnSpacingInput] = useState(() => String(profile.columnSpacing));
  const [noteHeightScaleInput, setNoteHeightScaleInput] = useState(() => String(profile.noteHeightScale));
  const [hitPositionInput, setHitPositionInput] = useState(() => String(replayHitPositionToOsuManiaHitPosition(draft.hitPosition)));
  const [scorePositionInput, setScorePositionInput] = useState(() => String(replayStagePositionToOsuManiaPosition(draft.scorePosition)));
  const [comboPositionInput, setComboPositionInput] = useState(() => String(replayStagePositionToOsuManiaPosition(draft.comboPosition)));

  useEffect(() => {
    setColumnWidthInput(String(profile.columnWidth));
  }, [profile.columnWidth]);

  useEffect(() => {
    setColumnSpacingInput(String(profile.columnSpacing));
  }, [profile.columnSpacing]);

  useEffect(() => {
    setNoteHeightScaleInput(String(profile.noteHeightScale));
  }, [profile.noteHeightScale]);

  useEffect(() => {
    setHitPositionInput(String(replayHitPositionToOsuManiaHitPosition(draft.hitPosition)));
  }, [draft.hitPosition]);

  useEffect(() => {
    setScorePositionInput(String(replayStagePositionToOsuManiaPosition(draft.scorePosition)));
  }, [draft.scorePosition]);

  useEffect(() => {
    setComboPositionInput(String(replayStagePositionToOsuManiaPosition(draft.comboPosition)));
  }, [draft.comboPosition]);

  useEffect(() => {
    setSelectedColumns((current) => {
      const filtered = current.filter((col) => col < selectedKeyCount);
      return filtered.length === current.length ? current : filtered;
    });
  }, [selectedKeyCount]);

  useEffect(() => {
    if (selectedColumns.length === 0) return;
    const handler = (event: PointerEvent) => {
      const target = event.target;
      if (!(target instanceof Element)) return;
      if (target.closest("[data-replay-selectable-area]")) return;
      setSelectedColumns([]);
    };
    document.addEventListener("pointerdown", handler);
    return () => document.removeEventListener("pointerdown", handler);
  }, [selectedColumns.length]);

  useEffect(() => {
    if (windowRect != null) return;
    if (typeof window === "undefined") return;
    const stored = readStoredWindowRect();
    const initial = stored ?? defaultWindowRect(window.innerWidth, window.innerHeight);
    setWindowRect(clampWindowRect(initial, window.innerWidth, window.innerHeight));
  }, [windowRect]);

  useEffect(() => {
    if (!windowRect) return;
    writeStoredWindowRect(windowRect);
  }, [windowRect]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const handle = () => {
      setWindowRect((current) => (current ? clampWindowRect(current, window.innerWidth, window.innerHeight) : current));
    };
    window.addEventListener("resize", handle);
    return () => window.removeEventListener("resize", handle);
  }, []);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const handler = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [onClose]);

  const handleHeaderPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    if (!windowRect) return;
    const target = event.target;
    if (target instanceof Element && target.closest("[data-window-no-drag]")) return;
    event.preventDefault();
    dragStateRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      startRect: windowRect,
    };
    event.currentTarget.setPointerCapture(event.pointerId);
  };

  const handleHeaderPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const state = dragStateRef.current;
    if (!state || state.pointerId !== event.pointerId) return;
    const dx = event.clientX - state.startX;
    const dy = event.clientY - state.startY;
    setWindowRect(clampWindowRect(
      { ...state.startRect, x: state.startRect.x + dx, y: state.startRect.y + dy },
      window.innerWidth,
      window.innerHeight,
    ));
  };

  const handleHeaderPointerEnd = (event: ReactPointerEvent<HTMLDivElement>) => {
    const state = dragStateRef.current;
    if (!state || state.pointerId !== event.pointerId) return;
    dragStateRef.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  };

  const handleResizePointerDown = (dir: ResizeDirection) => (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    if (!windowRect) return;
    event.preventDefault();
    event.stopPropagation();
    resizeStateRef.current = {
      pointerId: event.pointerId,
      dir,
      startX: event.clientX,
      startY: event.clientY,
      startRect: windowRect,
    };
    event.currentTarget.setPointerCapture(event.pointerId);
  };

  const handleResizePointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const state = resizeStateRef.current;
    if (!state || state.pointerId !== event.pointerId) return;
    const dx = event.clientX - state.startX;
    const dy = event.clientY - state.startY;
    let { x, y, w, h } = state.startRect;
    if (state.dir.includes("e")) {
      w = state.startRect.w + dx;
    }
    if (state.dir.includes("s")) {
      h = state.startRect.h + dy;
    }
    if (state.dir.includes("w")) {
      const requested = state.startRect.w - dx;
      const newW = Math.max(WINDOW_MIN_WIDTH, requested);
      x = state.startRect.x + (state.startRect.w - newW);
      w = newW;
    }
    if (state.dir.includes("n")) {
      const requested = state.startRect.h - dy;
      const newH = Math.max(WINDOW_MIN_HEIGHT, requested);
      y = state.startRect.y + (state.startRect.h - newH);
      h = newH;
    }
    setWindowRect(clampWindowRect({ x, y, w, h }, window.innerWidth, window.innerHeight));
  };

  const handleResizePointerEnd = (event: ReactPointerEvent<HTMLDivElement>) => {
    const state = resizeStateRef.current;
    if (!state || state.pointerId !== event.pointerId) return;
    resizeStateRef.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  };

  const update = (patch: Partial<ReplaySkinSettings>) => {
    setDraft((current) => normalizeReplaySkinSettings({ ...current, ...patch, version: 2 }));
    setSelectedPresetId("custom");
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
    setSelectedPresetId("custom");
  };

  const updateBaseColor = (kind: "tap" | "lnHead", value: string) => {
    if (kind === "tap") updateProfile({ tapColor: value });
    else updateProfile({ lnHeadColor: value });
  };

  const updateOverrideColors = (kind: "tap" | "lnHead", targetColumns: number[], value: string) => {
    if (targetColumns.length === 0) return;
    setDraft((current) => {
      const currentProfile = getReplaySkinProfile(current, selectedKeyCount);
      const key = kind === "tap" ? "tapColors" : "lnHeadColors";
      const colors = [...currentProfile[key]];
      for (const column of targetColumns) {
        if (column >= 0 && column < selectedKeyCount) colors[column] = value;
      }
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

  const selectedPreset = presets.find((preset) => preset.id === selectedPresetId) ?? null;
  const noteHeightDefault = Math.max(
    REPLAY_SKIN_MIN_NOTE_HEIGHT_SCALE,
    Math.min(
      REPLAY_SKIN_MAX_NOTE_HEIGHT_SCALE,
      profile.columnWidths.length > 0 ? Math.min(...profile.columnWidths) : profile.columnWidth,
    ),
  );
  const hasNoteAssets = profile.assets.columns.some((col) => col?.tap || col?.lnHead || col?.lnBody || col?.lnTail);
  const showNoteHeightScale = draft.style === "bars" || hasNoteAssets;

  const persistPresets = (nextPresets: ReplaySkinPreset[]) => {
    setPresets(nextPresets);
    writeReplaySkinPresets(nextPresets);
  };

  const applyPreset = (presetId: string) => {
    setSelectedPresetId(presetId);
    if (presetId === "custom") return;
    const preset = presets.find((candidate) => candidate.id === presetId);
    if (!preset) return;
    setDraft(preset.settings);
    setActiveColor(null);
    pushStatus(`Loaded ${preset.name}`);
  };

  const createPresetFromDraft = () => {
    setPromptDialog({
      title: "Create preset",
      label: "Preset name",
      initial: selectedPreset?.name ?? "My mania skin",
      placeholder: "My mania skin",
      confirmLabel: "Create",
      onSubmit: (name) => {
        const trimmed = name.trim();
        if (!trimmed) return;
        const preset = createReplaySkinPreset(trimmed, draft);
        persistPresets([preset, ...presets].slice(0, 24));
        setSelectedPresetId(preset.id);
        pushStatus(`Created ${preset.name}`);
      },
    });
  };

  const overwriteSelectedPreset = () => {
    if (!selectedPreset) return;
    const nextPreset = {
      ...selectedPreset,
      settings: normalizeReplaySkinSettings(draft),
      updatedAt: Date.now(),
    };
    persistPresets(presets.map((preset) => preset.id === selectedPreset.id ? nextPreset : preset));
    pushStatus(`Saved ${selectedPreset.name}`);
  };

  const renameSelectedPreset = () => {
    if (!selectedPreset) return;
    const target = selectedPreset;
    setPromptDialog({
      title: "Rename preset",
      label: "Preset name",
      initial: target.name,
      placeholder: target.name,
      confirmLabel: "Rename",
      onSubmit: (name) => {
        const trimmed = name.trim();
        if (!trimmed) return;
        const nextPreset = {
          ...target,
          name: trimmed.slice(0, 80),
          updatedAt: Date.now(),
        };
        persistPresets(presets.map((preset) => preset.id === target.id ? nextPreset : preset));
        pushStatus(`Renamed to ${nextPreset.name}`);
      },
    });
  };

  const deleteSelectedPreset = () => {
    if (!selectedPreset) return;
    persistPresets(presets.filter((preset) => preset.id !== selectedPreset.id));
    setSelectedPresetId("custom");
    pushStatus(`Deleted ${selectedPreset.name}`);
  };

  const exportDraft = () => {
    const key = createReplaySkinShareKey(selectedPreset?.name ?? "Replay settings", draft);
    if (navigator.clipboard?.writeText) {
      navigator.clipboard.writeText(key).then(
        () => pushStatus("Export key copied"),
        () => setKeyDialog({ title: "Export key", value: key }),
      );
    } else {
      setKeyDialog({ title: "Export key", value: key });
    }
  };

  const importShareKey = () => {
    setPromptDialog({
      title: "Import export key",
      label: "Paste export key",
      initial: "",
      placeholder: "mhreplay2.…",
      confirmLabel: "Import",
      multiline: true,
      onSubmit: (key) => {
        const trimmed = key.trim();
        if (!trimmed) return;
        const payload = parseReplaySkinShareKey(trimmed);
        if (!payload) {
          pushStatus("That export key could not be imported", "error");
          return;
        }
        const preset = createReplaySkinPreset(payload.name, payload.settings);
        persistPresets([preset, ...presets].slice(0, 24));
        setDraft(payload.settings);
        setSelectedPresetId(preset.id);
        setActiveColor(null);
        pushStatus(`Imported ${preset.name}`);
      },
    });
  };

  const importOsk = async (file: File) => {
    setImportingOsk(true);
    pushStatus(`Importing ${file.name}…`);
    try {
      const result = await importReplaySkinFromOsk(file, {
        targetKeyCount: selectedKeyCount,
        baseSettings: draft,
      });
      setDraft(result.settings);
      setSelectedPresetId("custom");
      setActiveColor(null);
      const pieces = [
        `${result.summary.selectedKeyCount ?? selectedKeyCount}K`,
        `${result.summary.noteAssets} note`,
        `${result.summary.receptorAssets} receptor`,
        `${result.summary.judgementAssets} judgement`,
        `${result.summary.comboDigits} combo`,
      ];
      pushStatus(`Imported ${result.summary.name} (${pieces.join(", ")})`);
    } catch (error) {
      pushStatus(error instanceof Error ? error.message : "Failed to import .osk", "error");
    } finally {
      setImportingOsk(false);
      if (oskInputRef.current) oskInputRef.current.value = "";
    }
  };

  const save = () => {
    onSave(draft);
    onClose();
  };

  const columns = Array.from({ length: selectedKeyCount }, (_, index) => index);
  const overrideColors = overrideKind === "tap" ? profile.tapColors : profile.lnHeadColors;
  const overrideBaseColor = overrideKind === "tap" ? profile.tapColor : profile.lnHeadColor;
  const primarySelected = selectedColumns[0] ?? 0;
  const selectedValues = selectedColumns.map((col) => overrideColors[col] || overrideBaseColor);
  const allSelectedSameValue = selectedValues.every((value) => value === selectedValues[0]);
  const overrideValue = allSelectedSameValue ? selectedValues[0] ?? overrideBaseColor : overrideColors[primarySelected] || overrideBaseColor;
  const anySelectedHasOverride = selectedColumns.some((col) => !!overrideColors[col]);

  const commitColumnWidthInput = () => {
    const parsed = Number(columnWidthInput);
    if (!Number.isFinite(parsed)) {
      setColumnWidthInput(String(profile.columnWidth));
      return;
    }
    const next = Math.max(REPLAY_SKIN_MIN_COLUMN_WIDTH, Math.min(REPLAY_SKIN_MAX_COLUMN_WIDTH, Math.round(parsed)));
    setColumnWidthInput(String(next));
    updateProfile({ columnWidth: next, columnWidths: [] });
  };

  const commitColumnSpacingInput = () => {
    const parsed = Number(columnSpacingInput);
    if (!Number.isFinite(parsed)) {
      setColumnSpacingInput(String(profile.columnSpacing));
      return;
    }
    const next = Math.max(REPLAY_SKIN_MIN_COLUMN_SPACING, Math.min(REPLAY_SKIN_MAX_COLUMN_SPACING, Math.round(parsed)));
    setColumnSpacingInput(String(next));
    updateProfile({ columnSpacing: next, columnSpacings: [] });
  };

  const commitNoteHeightScaleInput = () => {
    const parsed = Number(noteHeightScaleInput);
    if (!Number.isFinite(parsed)) {
      setNoteHeightScaleInput(String(profile.noteHeightScale));
      return;
    }
    const next = Math.max(REPLAY_SKIN_MIN_NOTE_HEIGHT_SCALE, Math.min(REPLAY_SKIN_MAX_NOTE_HEIGHT_SCALE, Math.round(parsed)));
    setNoteHeightScaleInput(String(next));
    updateProfile({ noteHeightScale: next });
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

  const commitScorePositionInput = () => {
    const parsed = Number(scorePositionInput);
    if (!Number.isFinite(parsed)) {
      setScorePositionInput(String(replayStagePositionToOsuManiaPosition(draft.scorePosition)));
      return;
    }
    const next = Math.max(OSU_MANIA_MIN_HIT_POSITION, Math.min(OSU_MANIA_MAX_HIT_POSITION, Math.round(parsed)));
    setScorePositionInput(String(next));
    update({ scorePosition: osuManiaStagePositionToReplayPosition(next) });
  };

  const commitComboPositionInput = () => {
    const parsed = Number(comboPositionInput);
    if (!Number.isFinite(parsed)) {
      setComboPositionInput(String(replayStagePositionToOsuManiaPosition(draft.comboPosition)));
      return;
    }
    const next = Math.max(OSU_MANIA_MIN_HIT_POSITION, Math.min(OSU_MANIA_MAX_HIT_POSITION, Math.round(parsed)));
    setComboPositionInput(String(next));
    update({ comboPosition: osuManiaStagePositionToReplayPosition(next) });
  };

  const handleColumnWidthInputChange = (value: string) => {
    setColumnWidthInput(value);
    if (value.trim() === "") return;
    const parsed = Number(value);
    if (!Number.isFinite(parsed) || parsed < REPLAY_SKIN_MIN_COLUMN_WIDTH || parsed > REPLAY_SKIN_MAX_COLUMN_WIDTH) return;
    updateProfile({ columnWidth: Math.round(parsed), columnWidths: [] });
  };

  const handleColumnSpacingInputChange = (value: string) => {
    setColumnSpacingInput(value);
    if (value.trim() === "") return;
    const parsed = Number(value);
    if (!Number.isFinite(parsed) || parsed < REPLAY_SKIN_MIN_COLUMN_SPACING || parsed > REPLAY_SKIN_MAX_COLUMN_SPACING) return;
    updateProfile({ columnSpacing: Math.round(parsed), columnSpacings: [] });
  };

  const handleNoteHeightScaleInputChange = (value: string) => {
    setNoteHeightScaleInput(value);
    if (value.trim() === "") return;
    const parsed = Number(value);
    if (!Number.isFinite(parsed) || parsed < REPLAY_SKIN_MIN_NOTE_HEIGHT_SCALE || parsed > REPLAY_SKIN_MAX_NOTE_HEIGHT_SCALE) return;
    updateProfile({ noteHeightScale: Math.round(parsed) });
  };

  const handleHitPositionInputChange = (value: string) => {
    setHitPositionInput(value);
    if (value.trim() === "") return;
    const parsed = Number(value);
    if (!Number.isFinite(parsed) || parsed < OSU_MANIA_MIN_HIT_POSITION || parsed > OSU_MANIA_MAX_HIT_POSITION) return;
    update({ hitPosition: osuManiaHitPositionToReplayHitPosition(Math.round(parsed)) });
  };

  const handleScorePositionInputChange = (value: string) => {
    setScorePositionInput(value);
    if (value.trim() === "") return;
    const parsed = Number(value);
    if (!Number.isFinite(parsed) || parsed < OSU_MANIA_MIN_HIT_POSITION || parsed > OSU_MANIA_MAX_HIT_POSITION) return;
    update({ scorePosition: osuManiaStagePositionToReplayPosition(Math.round(parsed)) });
  };

  const handleComboPositionInputChange = (value: string) => {
    setComboPositionInput(value);
    if (value.trim() === "") return;
    const parsed = Number(value);
    if (!Number.isFinite(parsed) || parsed < OSU_MANIA_MIN_HIT_POSITION || parsed > OSU_MANIA_MAX_HIT_POSITION) return;
    update({ comboPosition: osuManiaStagePositionToReplayPosition(Math.round(parsed)) });
  };

  if (typeof document === "undefined") return null;

  const colorTargetValue = (target: ColorTarget) =>
    target === "tap" ? profile.tapColor : target === "lnHead" ? profile.lnHeadColor : draft.lnBodyColor;

  const colorTargetLabel: Record<ColorTarget, string> = {
    tap: "Note color",
    lnHead: "LN head color",
    lnBody: "LN body color",
  };

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
        ref={modalRef}
        className={`fixed z-[111] flex flex-col overflow-hidden rounded-xl border border-osu-b2/70 bg-osu-b4 shadow-2xl ${
          windowRect ? "" : "pointer-events-none opacity-0"
        }`}
        style={{
          left: windowRect?.x ?? -9999,
          top: windowRect?.y ?? -9999,
          width: windowRect?.w ?? WINDOW_DEFAULT_WIDTH,
          height: windowRect?.h ?? WINDOW_DEFAULT_HEIGHT,
        }}
        initial={{ opacity: 0, scale: 0.98 }}
        animate={{ opacity: 1, scale: 1 }}
        exit={{ opacity: 0, scale: 0.98 }}
        transition={{ duration: 0.14 }}
        onClick={(e) => e.stopPropagation()}
      >
        <div
          onPointerDown={handleHeaderPointerDown}
          onPointerMove={handleHeaderPointerMove}
          onPointerUp={handleHeaderPointerEnd}
          onPointerCancel={handleHeaderPointerEnd}
          className="flex cursor-grab select-none items-center gap-3 border-b border-osu-b3/50 px-5 py-4 active:cursor-grabbing"
        >
          <GripHorizontal className="h-4 w-4 shrink-0 text-osu-f1" />
          <div>
            <h3 className="text-base font-bold text-white">Replay settings</h3>
            <div className="text-[10px] uppercase tracking-wider text-osu-f1">{activeTab === "style" ? "Style" : "Layout"}</div>
          </div>
          <button
            onClick={onClose}
            onPointerDown={(e) => e.stopPropagation()}
            aria-label="Close replay settings"
            data-window-no-drag
            className="ml-auto flex h-8 w-8 cursor-pointer items-center justify-center rounded-lg bg-osu-b3/50 text-osu-f1 transition-colors hover:bg-osu-b3 hover:text-white"
          >
            <X className="h-4 w-4" strokeWidth={2.4} />
          </button>
        </div>

        <div className="grid min-h-0 flex-1 md:grid-cols-[minmax(0,1fr)_300px]">
          <div className="space-y-4 overflow-y-auto p-5">
            <div className="grid gap-3 md:grid-cols-[minmax(0,1fr)_110px]">
              <div className="min-w-0 space-y-2">
                <FancySelect
                  label="Skin preset"
                  value={selectedPresetId}
                  onChange={applyPreset}
                  options={[
                    { value: "custom", label: "Current draft" },
                    ...presets.map((preset) => ({ value: preset.id, label: preset.name })),
                  ]}
                />
                <div className="flex flex-wrap items-center gap-1.5">
                  <PresetIconButton label="Create preset" onClick={createPresetFromDraft}>
                    <Save className="h-3.5 w-3.5" />
                  </PresetIconButton>
                  <PresetIconButton label="Overwrite preset" onClick={overwriteSelectedPreset} disabled={!selectedPreset}>
                    <Download className="h-3.5 w-3.5" />
                  </PresetIconButton>
                  <PresetIconButton label="Rename preset" onClick={renameSelectedPreset} disabled={!selectedPreset}>
                    <Pencil className="h-3.5 w-3.5" />
                  </PresetIconButton>
                  <PresetIconButton label="Delete preset" onClick={deleteSelectedPreset} disabled={!selectedPreset}>
                    <Trash2 className="h-3.5 w-3.5" />
                  </PresetIconButton>
                  <span className="h-5 w-px bg-osu-b3/50" />
                  <PresetIconButton label="Copy export key" onClick={exportDraft}>
                    <Copy className="h-3.5 w-3.5" />
                  </PresetIconButton>
                  <PresetIconButton label="Import export key" onClick={importShareKey}>
                    <Upload className="h-3.5 w-3.5" />
                  </PresetIconButton>
                  <PresetIconButton label="Import .osk" onClick={() => oskInputRef.current?.click()} disabled={importingOsk}>
                    <FileArchive className="h-3.5 w-3.5" />
                  </PresetIconButton>
                  <input
                    ref={oskInputRef}
                    type="file"
                    accept=".osk,.zip,application/zip"
                    className="hidden"
                    onChange={(event) => {
                      const file = event.currentTarget.files?.[0];
                      if (file) void importOsk(file);
                    }}
                  />
                </div>
              </div>
              <FancySelect
                label="Keymode"
                value={String(selectedKeyCount)}
                onChange={(value) => setSelectedKeyCount(Number(value))}
                options={Array.from({ length: 10 }, (_, index) => ({
                  value: String(index + 1),
                  label: `${index + 1}K`,
                }))}
              />
            </div>

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
                      active={draft.style === "arrows"}
                      icon={<ReplaySkinShapeIcon style={MANIA_ARROW_ICON_STYLE} />}
                      label="Arrows"
                      onClick={() => updateStyle("arrows")}
                    />
                  </div>
                </section>

                <section className="space-y-2 pt-2">
                  <ReplaySkinColorRow
                    label="Note color"
                    title="Base tap color used for any column without a per-column override."
                    value={profile.tapColor}
                    selected={activeColor === "tap"}
                    onOpen={() => setActiveColor((current) => (current === "tap" ? null : "tap"))}
                  />
                  <ReplaySkinColorRow
                    label="LN Head color"
                    title="Base LN head color used for any column without a per-column override."
                    value={profile.lnHeadColor}
                    selected={activeColor === "lnHead"}
                    onOpen={() => setActiveColor((current) => (current === "lnHead" ? null : "lnHead"))}
                  />
                  <ReplaySkinColorRow
                    label="LN Body color"
                    title="Color of the LN body. Always global (no per-column override)."
                    value={draft.lnBodyColor}
                    selected={activeColor === "lnBody"}
                    onOpen={() => setActiveColor((current) => (current === "lnBody" ? null : "lnBody"))}
                  />
                </section>

                <section className="space-y-3 pt-1">
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
                  <div className="flex items-center justify-between gap-3">
                    <span className="text-sm font-semibold text-osu-l1">Keys under notes</span>
                    <ReplaySkinSwitch checked={draft.keysUnderNotes} onChange={(checked) => update({ keysUnderNotes: checked })} />
                  </div>
                </section>
              </>
            ) : (
              <section className="space-y-5">
                <LayoutNumberControl
                  label="Column width"
                  inputValue={columnWidthInput}
                  numericValue={profile.columnWidth}
                  min={REPLAY_SKIN_MIN_COLUMN_WIDTH}
                  max={REPLAY_SKIN_MAX_COLUMN_WIDTH}
                  defaultValue={30}
                  onSliderChange={(value) => updateProfile({ columnWidth: value, columnWidths: [] })}
                  onInputChange={handleColumnWidthInputChange}
                  onCommit={commitColumnWidthInput}
                  onResetToDefault={() => updateProfile({ columnWidth: 30, columnWidths: [] })}
                />
                <LayoutNumberControl
                  label="Column spacing"
                  inputValue={columnSpacingInput}
                  numericValue={profile.columnSpacing}
                  min={REPLAY_SKIN_MIN_COLUMN_SPACING}
                  max={REPLAY_SKIN_MAX_COLUMN_SPACING}
                  defaultValue={0}
                  onSliderChange={(value) => updateProfile({ columnSpacing: value, columnSpacings: [] })}
                  onInputChange={handleColumnSpacingInputChange}
                  onCommit={commitColumnSpacingInput}
                  onResetToDefault={() => updateProfile({ columnSpacing: 0, columnSpacings: [] })}
                />
                {showNoteHeightScale ? (
                  <LayoutNumberControl
                    label="Note height"
                    inputValue={noteHeightScaleInput}
                    numericValue={profile.noteHeightScale}
                    min={REPLAY_SKIN_MIN_NOTE_HEIGHT_SCALE}
                    max={REPLAY_SKIN_MAX_NOTE_HEIGHT_SCALE}
                    defaultValue={noteHeightDefault}
                    onSliderChange={(value) => updateProfile({ noteHeightScale: value })}
                    onInputChange={handleNoteHeightScaleInputChange}
                    onCommit={commitNoteHeightScaleInput}
                    onResetToDefault={() => updateProfile({ noteHeightScale: noteHeightDefault })}
                    hint={draft.style === "bars" ? "Bar note height." : "Imported note image height scaling."}
                  />
                ) : null}
                <LayoutNumberControl
                  label="Hit position"
                  inputValue={hitPositionInput}
                  numericValue={replayHitPositionToOsuManiaHitPosition(draft.hitPosition)}
                  min={OSU_MANIA_MIN_HIT_POSITION}
                  max={OSU_MANIA_MAX_HIT_POSITION}
                  defaultValue={402}
                  onSliderChange={(value) => update({ hitPosition: osuManiaHitPositionToReplayHitPosition(value) })}
                  onInputChange={handleHitPositionInputChange}
                  onCommit={commitHitPositionInput}
                  onResetToDefault={() => update({ hitPosition: osuManiaHitPositionToReplayHitPosition(402) })}
                  hint="Higher values move receptors lower."
                />
                <LayoutNumberControl
                  label="ScorePosition"
                  inputValue={scorePositionInput}
                  numericValue={replayStagePositionToOsuManiaPosition(draft.scorePosition)}
                  min={OSU_MANIA_MIN_HIT_POSITION}
                  max={OSU_MANIA_MAX_HIT_POSITION}
                  defaultValue={OSU_MANIA_DEFAULT_SCORE_POSITION}
                  onSliderChange={(value) => update({ scorePosition: osuManiaStagePositionToReplayPosition(value) })}
                  onInputChange={handleScorePositionInputChange}
                  onCommit={commitScorePositionInput}
                  onResetToDefault={() => update({ scorePosition: osuManiaStagePositionToReplayPosition(OSU_MANIA_DEFAULT_SCORE_POSITION) })}
                  hint="Hitburst and judgement height."
                />
                <LayoutNumberControl
                  label="ComboPosition"
                  inputValue={comboPositionInput}
                  numericValue={replayStagePositionToOsuManiaPosition(draft.comboPosition)}
                  min={OSU_MANIA_MIN_HIT_POSITION}
                  max={OSU_MANIA_MAX_HIT_POSITION}
                  defaultValue={OSU_MANIA_DEFAULT_COMBO_POSITION}
                  onSliderChange={(value) => update({ comboPosition: osuManiaStagePositionToReplayPosition(value) })}
                  onInputChange={handleComboPositionInputChange}
                  onCommit={commitComboPositionInput}
                  onResetToDefault={() => update({ comboPosition: osuManiaStagePositionToReplayPosition(OSU_MANIA_DEFAULT_COMBO_POSITION) })}
                  hint="Combo counter height."
                />
              </section>
            )}
          </div>

          <div className="border-l border-osu-b3/50 overflow-y-auto p-5">
            <div className="mb-2 flex items-center justify-between gap-2">
              <span className="text-sm font-semibold text-white">Live preview</span>
              <div className="grid grid-cols-2 rounded-md bg-osu-b5/70 p-0.5 text-[10px] font-bold uppercase tracking-wider">
                {(["tap", "ln"] as const).map((mode) => (
                  <button
                    key={mode}
                    type="button"
                    onClick={() => setPreviewMode(mode)}
                    className={`cursor-pointer rounded px-2 py-1 transition-colors ${
                      previewMode === mode ? "bg-osu-pink/20 text-white" : "text-osu-f1 hover:text-white"
                    }`}
                  >
                    {mode === "tap" ? "Notes" : "LN"}
                  </button>
                ))}
              </div>
            </div>
            <ReplaySkinPreview
              settings={draft}
              profile={profile}
              keyCount={selectedKeyCount}
              previewMode={previewMode}
              selectedColumns={selectedColumns}
              onSelectionChange={(next) => {
                setSelectedColumns((current) => (arraysEqualUnordered(current, next) ? current : next));
                if (next.length > 0) setColumnEditorOpen(true);
              }}
            />
            <div className="mt-2 text-[10px] text-osu-f1">
              Click a column to select. Drag a box for multi-select. Hold Shift for range, Ctrl/Cmd to toggle.
            </div>
          </div>
        </div>

        <div className="flex shrink-0 items-center gap-2 border-t border-osu-b3/50 px-5 py-4">
          <button
            onClick={() => {
              setDraft(DEFAULT_REPLAY_SKIN_SETTINGS);
              setActiveColor(null);
              setSelectedColumns([]);
              setSelectedPresetId("custom");
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

        {RESIZE_HANDLES.map(({ dir, className, cursor }) => (
          <div
            key={dir}
            onPointerDown={handleResizePointerDown(dir)}
            onPointerMove={handleResizePointerMove}
            onPointerUp={handleResizePointerEnd}
            onPointerCancel={handleResizePointerEnd}
            className={`absolute z-10 ${className}`}
            style={{ cursor }}
          />
        ))}
      </motion.div>

      {activeColor ? (
        <DraggableColorPopover
          key={`base-${activeColor}`}
          title={colorTargetLabel[activeColor]}
          anchorRef={modalRef}
          storageKey={`base-color`}
          onClose={() => setActiveColor(null)}
        >
          <ReplaySkinColorPanel
            value={colorTargetValue(activeColor)}
            onChange={(value) => {
              if (activeColor === "tap") updateBaseColor("tap", value);
              else if (activeColor === "lnHead") updateBaseColor("lnHead", value);
              else updateLnBodyColor(value);
            }}
          />
        </DraggableColorPopover>
      ) : null}

      {columnEditorOpen ? (
        <DraggableColorPopover
          key="per-column"
          title="Per-column colors"
          width={296}
          anchorRef={modalRef}
          storageKey="per-column"
          onClose={() => setColumnEditorOpen(false)}
        >
          <div className="mb-3 grid gap-1.5" style={{ gridTemplateColumns: `repeat(${Math.min(selectedKeyCount, 10)}, minmax(0, 1fr))` }}>
            {columns.map((column) => {
              const overridden = !!overrideColors[column];
              const swatch = overrideColors[column] || overrideBaseColor;
              const isSelected = selectedColumns.includes(column);
              return (
                <button
                  key={column}
                  type="button"
                  onClick={(event) => {
                    const mode: SelectionMode = event.shiftKey
                      ? "range"
                      : event.metaKey || event.ctrlKey
                        ? "toggle"
                        : "replace";
                    setSelectedColumns((current) => applySelection(current, column, mode));
                  }}
                  className={`relative flex h-9 cursor-pointer flex-col items-center justify-center rounded-md border text-[10px] font-bold transition-colors ${
                    isSelected
                      ? "border-osu-pink text-white"
                      : "border-osu-b3/50 text-osu-f1 hover:border-osu-b2 hover:text-white"
                  }`}
                  style={{ backgroundColor: isSelected ? "rgba(232, 60, 144, 0.1)" : "rgba(15, 15, 24, 0.5)" }}
                >
                  <span>{column + 1}</span>
                  <span
                    className="mt-0.5 h-1.5 w-5 rounded-sm"
                    style={{
                      backgroundColor: swatch,
                      opacity: overridden ? 1 : 0.45,
                    }}
                  />
                </button>
              );
            })}
          </div>
          <div className="mb-2 flex items-center justify-between text-[10px] font-semibold uppercase tracking-wider text-osu-f1">
            <span>
              {selectedColumns.length === 0
                ? "Select columns to edit"
                : selectedColumns.length === 1
                  ? `Column ${primarySelected + 1}`
                  : `${selectedColumns.length} columns selected`}
            </span>
            {selectedColumns.length < selectedKeyCount ? (
              <button
                type="button"
                onClick={() => setSelectedColumns(columns)}
                className="cursor-pointer text-osu-f1 transition-colors hover:text-white"
              >
                Select all
              </button>
            ) : null}
          </div>
          <div className="mb-3 grid grid-cols-2 rounded-lg bg-osu-b5/70 p-1">
            {(["tap", "lnHead"] as const).map((kind) => (
              <button
                key={kind}
                type="button"
                onClick={() => {
                  setOverrideKind(kind);
                  setPreviewMode(kind === "lnHead" ? "ln" : "tap");
                }}
                className={`cursor-pointer rounded-md px-3 py-1.5 text-xs font-bold transition-colors ${
                  overrideKind === kind ? "bg-osu-pink/20 text-white" : "text-osu-f1 hover:text-white"
                }`}
              >
                {kind === "tap" ? "Note" : "LN Head"}
              </button>
            ))}
          </div>
          <ReplaySkinColorPanel
            value={overrideValue}
            onChange={(value) => updateOverrideColors(overrideKind, selectedColumns, value)}
          />
          {anySelectedHasOverride ? (
            <div className="mt-3 flex items-center gap-2">
              <button
                type="button"
                onClick={() => updateOverrideColors(overrideKind, selectedColumns, "")}
                className="cursor-pointer rounded-lg px-2.5 py-1.5 text-xs font-semibold text-osu-f1 transition-colors hover:text-white"
              >
                Use base
              </button>
            </div>
          ) : null}
        </DraggableColorPopover>
      ) : null}

      <AnimatePresence>
        {toast ? (
          <ReplaySkinToast
            key={toast.id}
            message={toast.message}
            tone={toast.tone}
            onDismiss={() => setToast((current) => (current && current.id === toast.id ? null : current))}
          />
        ) : null}
      </AnimatePresence>

      {promptDialog ? (
        <ReplaySkinPromptDialog
          title={promptDialog.title}
          label={promptDialog.label}
          initial={promptDialog.initial}
          placeholder={promptDialog.placeholder}
          confirmLabel={promptDialog.confirmLabel}
          multiline={promptDialog.multiline}
          onCancel={() => setPromptDialog(null)}
          onConfirm={(value) => {
            const submit = promptDialog.onSubmit;
            setPromptDialog(null);
            submit(value);
          }}
        />
      ) : null}

      {keyDialog ? (
        <ReplaySkinKeyDialog
          title={keyDialog.title}
          value={keyDialog.value}
          onClose={() => setKeyDialog(null)}
          onCopy={() => {
            if (navigator.clipboard?.writeText) {
              navigator.clipboard.writeText(keyDialog.value).then(
                () => pushStatus("Export key copied"),
                () => pushStatus("Could not copy to clipboard", "error"),
              );
            }
          }}
        />
      ) : null}
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

const PREVIEW_TAP_Y_OFFSETS_DOWN: ReadonlyArray<number> = [60, 95, 130, 165, 200];
const PREVIEW_LN_LENGTHS: ReadonlyArray<number> = [120, 95, 75];

function getPreviewAssetHeight(asset: ReplaySkinImageAsset, targetWidth: number, heightScaleWidth: number, fallbackHeight: number): number {
  const scale = asset.scale && asset.scale > 0 ? asset.scale : 1;
  const width = asset.width && asset.width > 0 ? asset.width / scale : 0;
  const height = asset.height && asset.height > 0 ? asset.height / scale : 0;
  if (width > 0 && height > 0) return Math.max(1, height * (heightScaleWidth / width));
  return Math.max(1, fallbackHeight || targetWidth);
}

function ReplaySkinPreview({
  settings,
  profile,
  keyCount,
  previewMode,
  selectedColumns,
  onSelectionChange,
}: {
  settings: ReplaySkinSettings;
  profile: ReplaySkinKeymodeProfile;
  keyCount: number;
  previewMode: PreviewMode;
  selectedColumns: number[];
  onSelectionChange: (next: number[]) => void;
}) {
  const width = 260;
  const height = 300;
  const columnWidths = Array.from({ length: keyCount }, (_, col) => profile.columnWidths[col] ?? profile.columnWidth);
  const columnSpacings = Array.from({ length: Math.max(0, keyCount - 1) }, (_, col) => profile.columnSpacings[col] ?? profile.columnSpacing);
  const desiredPlayfieldWidth = columnWidths.reduce((sum, value) => sum + value, 0) + columnSpacings.reduce((sum, value) => sum + value, 0);
  const playfieldWidth = Math.min(230, desiredPlayfieldWidth);
  const layoutScale = desiredPlayfieldWidth > 0 ? playfieldWidth / desiredPlayfieldWidth : 1;
  const averageLaneWidth = columnWidths.reduce((sum, value) => sum + value, 0) / Math.max(1, columnWidths.length) * layoutScale;
  const playfieldX = (width - playfieldWidth) / 2;
  const receptorY = height * (settings.upscroll ? settings.hitPosition : 768 - settings.hitPosition) / 768;
  const scoreY = height * (settings.upscroll ? settings.scorePosition : 768 - settings.scorePosition) / 768;
  const comboY = height * (settings.upscroll ? settings.comboPosition : 768 - settings.comboPosition) / 768;
  const noteSize = settings.style === "circles" || settings.style === "arrows"
    ? Math.max(18, Math.min(averageLaneWidth - 4, Math.max(28, averageLaneWidth * 0.78)))
    : Math.max(8, Math.min(18, averageLaneWidth - 6));
  const colorFor = (colors: string[], fallback: string, col: number) => colors[col] || fallback;

  const containerRef = useRef<HTMLDivElement | null>(null);
  const dragStateRef = useRef<{
    pointerId: number;
    startClientX: number;
    startClientY: number;
    startLocalX: number;
    startLocalY: number;
    initialSelection: number[];
    additive: boolean;
    moved: boolean;
    pendingColumn: number | null;
    pendingMode: SelectionMode;
  } | null>(null);
  const [marqueeRect, setMarqueeRect] = useState<{ left: number; top: number; width: number; height: number } | null>(null);

  let cursorX = playfieldX;
  const lanePositions = Array.from({ length: keyCount }, (_, col) => {
    const laneWidth = columnWidths[col] * layoutScale;
    const startX = cursorX;
    cursorX += laneWidth + (columnSpacings[col] ?? 0) * layoutScale;
    return { col, startX, endX: startX + laneWidth, cx: startX + laneWidth / 2, width: laneWidth };
  });

  const tapYForColumn = (col: number) => {
    const offset = PREVIEW_TAP_Y_OFFSETS_DOWN[col % PREVIEW_TAP_Y_OFFSETS_DOWN.length];
    const downscrollY = receptorY - offset;
    if (settings.upscroll) return receptorY + offset - noteSize;
    return downscrollY;
  };

  const lnLengthForColumn = (col: number) => {
    const base = PREVIEW_LN_LENGTHS[col % PREVIEW_LN_LENGTHS.length];
    return settings.percy ? Math.max(50, base - 30) : base;
  };

  const findColumnAtX = (localX: number): number | null => {
    for (const lane of lanePositions) {
      if (localX >= lane.startX && localX <= lane.endX) return lane.col;
    }
    if (lanePositions.length === 0) return null;
    const first = lanePositions[0];
    const last = lanePositions[lanePositions.length - 1];
    const gapHalf = Math.max(2, profile.columnSpacing * layoutScale / 2 + 2);
    for (const lane of lanePositions) {
      if (localX >= lane.startX - gapHalf && localX <= lane.endX + gapHalf) return lane.col;
    }
    if (localX < first.startX - gapHalf || localX > last.endX + gapHalf) return null;
    return null;
  };

  const columnsInRange = (loX: number, hiX: number): number[] => {
    const cols: number[] = [];
    for (const lane of lanePositions) {
      if (lane.endX >= loX && lane.startX <= hiX) cols.push(lane.col);
    }
    return cols;
  };

  const mergeMarqueeSelection = (initial: number[], hit: number[], additive: boolean): number[] => {
    if (additive) {
      const merged = new Set(initial);
      for (const col of hit) merged.add(col);
      return Array.from(merged).sort((a, b) => a - b);
    }
    return hit.slice().sort((a, b) => a - b);
  };

  const handlePointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!containerRef.current) return;
    if (event.button !== 0) return;
    const rect = containerRef.current.getBoundingClientRect();
    const localX = event.clientX - rect.left;
    const localY = event.clientY - rect.top;
    const additive = event.shiftKey || event.metaKey || event.ctrlKey;
    const pendingColumn = findColumnAtX(localX);
    const pendingMode: SelectionMode = event.shiftKey
      ? "range"
      : event.metaKey || event.ctrlKey
        ? "toggle"
        : "replace";
    dragStateRef.current = {
      pointerId: event.pointerId,
      startClientX: event.clientX,
      startClientY: event.clientY,
      startLocalX: localX,
      startLocalY: localY,
      initialSelection: selectedColumns,
      additive,
      moved: false,
      pendingColumn,
      pendingMode,
    };
    event.currentTarget.setPointerCapture(event.pointerId);
  };

  const handlePointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const state = dragStateRef.current;
    if (!state || state.pointerId !== event.pointerId) return;
    if (!containerRef.current) return;
    const dx = event.clientX - state.startClientX;
    const dy = event.clientY - state.startClientY;
    if (!state.moved && Math.hypot(dx, dy) < 4) return;
    state.moved = true;
    const rect = containerRef.current.getBoundingClientRect();
    const localX = event.clientX - rect.left;
    const localY = event.clientY - rect.top;
    const left = Math.max(0, Math.min(state.startLocalX, localX));
    const right = Math.min(rect.width, Math.max(state.startLocalX, localX));
    const top = Math.max(0, Math.min(state.startLocalY, localY));
    const bottom = Math.min(rect.height, Math.max(state.startLocalY, localY));
    setMarqueeRect({ left, top, width: right - left, height: bottom - top });
    const hit = columnsInRange(left, right);
    onSelectionChange(mergeMarqueeSelection(state.initialSelection, hit, state.additive));
  };

  const handlePointerEnd = (event: ReactPointerEvent<HTMLDivElement>) => {
    const state = dragStateRef.current;
    if (!state || state.pointerId !== event.pointerId) return;
    dragStateRef.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    setMarqueeRect(null);
    if (!state.moved && state.pendingColumn != null) {
      onSelectionChange(applySelection(state.initialSelection, state.pendingColumn, state.pendingMode));
    }
  };

  return (
    <div
      ref={containerRef}
      data-replay-selectable-area="preview"
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerEnd}
      onPointerCancel={handlePointerEnd}
      className="relative h-[300px] overflow-hidden rounded-lg border border-osu-b3/60 bg-[#07070c] select-none touch-none"
    >
      {settings.style !== "circles" ? (
        <div className="pointer-events-none absolute inset-y-0" style={{ left: playfieldX, width: playfieldWidth }}>
          {[...lanePositions.map((lane) => lane.startX - playfieldX), playfieldWidth].map((left, index) => (
            <div
              key={index}
              className="absolute inset-y-0 w-px bg-white/10"
              style={{ left }}
            />
          ))}
        </div>
      ) : null}
      {lanePositions.map(({ col, startX, width: laneWidth }) => {
        const isSelected = selectedColumns.includes(col);
        return (
          <div
            key={`lane-bg-${col}`}
            className={`pointer-events-none absolute inset-y-0 transition-colors ${
              isSelected ? "bg-osu-pink/15" : ""
            }`}
            style={{ left: startX, width: laneWidth }}
          />
        );
      })}
      {settings.style !== "circles" ? (
        <div className="pointer-events-none absolute h-0.5 bg-white/70" style={{ left: playfieldX, width: playfieldWidth, top: receptorY }} />
      ) : null}
      {lanePositions.map(({ col, cx, width: laneWidth }) => {
        const isSelected = selectedColumns.includes(col);
        const receptorAsset = profile.assets.columns[col]?.receptor;
        if (receptorAsset) {
          const receptorHeight = getPreviewAssetHeight(receptorAsset, laneWidth, laneWidth, noteSize);
          return (
            <img
              key={`receptor-${col}`}
              src={receptorAsset.src}
              alt=""
              draggable={false}
              className="pointer-events-none absolute object-fill"
              style={{
                left: cx - laneWidth / 2,
                top: settings.upscroll ? receptorY - receptorHeight : receptorY,
                width: laneWidth,
                height: receptorHeight,
                opacity: isSelected ? 1 : 0.62,
              }}
            />
          );
        }
        if (settings.style === "circles") {
          return (
            <div
              key={`receptor-${col}`}
              className="pointer-events-none absolute rounded-full border-2"
              style={{
                left: cx - noteSize / 2,
                top: receptorY - noteSize / 2,
                width: noteSize,
                height: noteSize,
                borderColor: isSelected ? "#e83c90" : "#ffffff",
                opacity: isSelected ? 1 : 0.5,
              }}
            />
          );
        }
        if (settings.style === "arrows") {
          return (
            <ArrowShape
              key={`receptor-${col}`}
              cx={cx}
              cy={receptorY}
              size={noteSize}
              direction={getColumnArrowDirection(col, keyCount)}
              fill="transparent"
              fillOpacity={0}
              stroke={isSelected ? "#e83c90" : "#ffffff"}
              strokeOpacity={isSelected ? 1 : 0.5}
            />
          );
        }
        return (
          <div
            key={`receptor-${col}`}
            className="pointer-events-none absolute rounded-sm"
            style={{
              left: cx - noteSize / 2,
              top: settings.upscroll ? receptorY - 11 : receptorY + 4,
              width: noteSize,
              height: 7,
              backgroundColor: "#ffffff",
              opacity: isSelected ? 0.45 : 0.16,
            }}
          />
        );
      })}
      {previewMode === "tap"
        ? lanePositions.map(({ col, cx, width: laneWidth }) => {
            const y = tapYForColumn(col);
            const color = colorFor(profile.tapColors, profile.tapColor, col);
            const tapAsset = profile.assets.columns[col]?.tap;
            if (tapAsset) {
              const assetHeight = getPreviewAssetHeight(tapAsset, laneWidth, profile.noteHeightScale * layoutScale, noteSize);
              return (
                <img
                  key={`tap-${col}`}
                  src={tapAsset.src}
                  alt=""
                  draggable={false}
                  className="pointer-events-none absolute object-fill"
                  style={{ left: cx - laneWidth / 2, top: settings.upscroll ? y : y + noteSize - assetHeight, width: laneWidth, height: assetHeight }}
                />
              );
            }
            if (settings.style === "circles") {
              return (
                <div
                  key={`tap-${col}`}
                  className="pointer-events-none absolute rounded-full ring-2 ring-white/55"
                  style={{ left: cx - noteSize / 2, top: y, width: noteSize, height: noteSize, backgroundColor: color }}
                />
              );
            }
            if (settings.style === "arrows") {
              return (
                <ArrowShape
                  key={`tap-${col}`}
                  cx={cx}
                  cy={y + noteSize / 2}
                  size={noteSize}
                  direction={getColumnArrowDirection(col, keyCount)}
                  fill={color}
                  fillOpacity={1}
                  stroke="#ffffff"
                  strokeOpacity={0.55}
                />
              );
            }
            return (
              <div
                key={`tap-${col}`}
                className="pointer-events-none absolute rounded"
                style={{ left: cx - noteSize / 2, top: y, width: noteSize, height: 10, backgroundColor: color }}
              />
            );
          })
        : lanePositions.map(({ col, cx, width: laneWidth }) => {
            const headColor = colorFor(profile.lnHeadColors, profile.lnHeadColor, col);
            const length = lnLengthForColumn(col);
            const lnHeadY = receptorY;
            const lnTailEnd = settings.upscroll ? lnHeadY + length : lnHeadY - length;
            const lnTop = Math.min(lnHeadY, lnTailEnd);
            const lnBottom = Math.max(lnHeadY, lnTailEnd);
            const columnAssets = profile.assets.columns[col];
            if (columnAssets?.lnHead || columnAssets?.lnBody || columnAssets?.lnTail) {
              const headAsset = columnAssets.lnHead ?? columnAssets.tap;
              const bodyAsset = columnAssets.lnBody;
              const tailAsset = columnAssets.lnTail;
              const headHeight = headAsset ? getPreviewAssetHeight(headAsset, laneWidth, profile.noteHeightScale * layoutScale, noteSize) : noteSize;
              const tailHeight = tailAsset ? getPreviewAssetHeight(tailAsset, laneWidth, profile.noteHeightScale * layoutScale, noteSize) : noteSize;
              return (
                <div key={`ln-${col}`} className="pointer-events-none">
                  {bodyAsset ? (
                    <img
                      src={bodyAsset.src}
                      alt=""
                      draggable={false}
                      className="absolute object-fill"
                      style={{ left: cx - laneWidth / 2, top: lnTop, width: laneWidth, height: lnBottom - lnTop }}
                    />
                  ) : (
                    <div
                      className="absolute"
                      style={{ left: cx - Math.max(10, noteSize * 0.5) / 2, top: lnTop, width: Math.max(10, noteSize * 0.5), height: lnBottom - lnTop, backgroundColor: settings.lnBodyColor }}
                    />
                  )}
                  {tailAsset ? (
                    <img
                      src={tailAsset.src}
                      alt=""
                      draggable={false}
                      className="absolute object-fill"
                      style={{ left: cx - laneWidth / 2, top: settings.upscroll ? lnTailEnd - tailHeight : lnTailEnd, width: laneWidth, height: tailHeight }}
                    />
                  ) : null}
                  {headAsset ? (
                    <img
                      src={headAsset.src}
                      alt=""
                      draggable={false}
                      className="absolute object-fill"
                      style={{ left: cx - laneWidth / 2, top: settings.upscroll ? lnHeadY : lnHeadY - headHeight, width: laneWidth, height: headHeight }}
                    />
                  ) : null}
                </div>
              );
            }
            if (settings.style === "circles") {
              const bodyWidth = Math.max(10, noteSize * 0.72);
              return (
                <div key={`ln-${col}`} className="pointer-events-none">
                  <div
                    className="absolute"
                    style={{
                      left: cx - bodyWidth / 2,
                      top: lnTop,
                      width: bodyWidth,
                      height: lnBottom - lnTop,
                      backgroundColor: settings.lnBodyColor,
                      borderRadius: bodyWidth / 2,
                    }}
                  />
                  <div
                    className="absolute rounded-full ring-2 ring-white/55"
                    style={{
                      left: cx - noteSize / 2,
                      top: lnHeadY - noteSize / 2,
                      width: noteSize,
                      height: noteSize,
                      backgroundColor: headColor,
                    }}
                  />
                </div>
              );
            }
            if (settings.style === "arrows") {
              const bodyWidth = Math.max(10, noteSize * 0.5);
              return (
                <div key={`ln-${col}`} className="pointer-events-none">
                  <div
                    className="absolute"
                    style={{
                      left: cx - bodyWidth / 2,
                      top: lnTop,
                      width: bodyWidth,
                      height: lnBottom - lnTop,
                      backgroundColor: settings.lnBodyColor,
                    }}
                  />
                  <ArrowShape
                    cx={cx}
                    cy={lnHeadY}
                    size={noteSize}
                    direction={getColumnArrowDirection(col, keyCount)}
                    fill={headColor}
                    fillOpacity={1}
                    stroke="#ffffff"
                    strokeOpacity={0.55}
                  />
                </div>
              );
            }
            const bodyWidth = noteSize;
            return (
              <div key={`ln-${col}`} className="pointer-events-none">
                <div
                  className="absolute rounded-sm"
                  style={{
                    left: cx - bodyWidth / 2,
                    top: lnTop,
                    width: bodyWidth,
                    height: lnBottom - lnTop,
                    backgroundColor: settings.lnBodyColor,
                  }}
                />
                <div
                  className="absolute rounded"
                  style={{
                    left: cx - noteSize / 2,
                    top: lnHeadY - 5,
                    width: noteSize,
                    height: 10,
                    backgroundColor: headColor,
                  }}
                />
              </div>
            );
          })}
      <div
        className="pointer-events-none absolute flex -translate-y-1/2 items-center justify-center text-[15px] font-bold leading-none"
        style={{
          left: playfieldX,
          width: playfieldWidth,
          top: comboY,
          color: "rgba(255,255,255,0.85)",
        }}
      >
        1234x
      </div>
      <div
        className="pointer-events-none absolute flex -translate-y-1/2 items-center justify-center text-[11px] font-bold leading-none"
        style={{
          left: playfieldX,
          width: playfieldWidth,
          top: scoreY,
          color: "#b3f5ff",
        }}
      >
        MAX
      </div>
      {marqueeRect ? (
        <div
          className="pointer-events-none absolute"
          style={{
            left: marqueeRect.left,
            top: marqueeRect.top,
            width: marqueeRect.width,
            height: marqueeRect.height,
            border: "1px solid #4ea3ff",
            backgroundColor: "rgba(78, 163, 255, 0.22)",
          }}
        />
      ) : null}
    </div>
  );
}

const ARROW_BASE_POINTS: ReadonlyArray<readonly [number, number]> = [
  [0.0, 0.32],
  [0.5, 0.32],
  [0.5, 0.05],
  [1.0, 0.5],
  [0.5, 0.95],
  [0.5, 0.68],
  [0.0, 0.68],
];

function rotateArrowPoint(px: number, py: number, direction: ArrowDirection): [number, number] {
  switch (direction) {
    case "right":
      return [px, py];
    case "left":
      return [1 - px, 1 - py];
    case "down":
      return [1 - py, px];
    case "up":
      return [py, 1 - px];
  }
}

function ArrowShape({
  cx,
  cy,
  size,
  direction,
  fill,
  fillOpacity,
  stroke,
  strokeOpacity,
}: {
  cx: number;
  cy: number;
  size: number;
  direction: ArrowDirection;
  fill: string;
  fillOpacity: number;
  stroke: string;
  strokeOpacity: number;
}) {
  const half = size / 2;
  const points = ARROW_BASE_POINTS.map(([x, y]) => {
    const [rx, ry] = rotateArrowPoint(x, y, direction);
    return `${cx - half + rx * size},${cy - half + ry * size}`;
  }).join(" ");
  return (
    <svg
      className="pointer-events-none absolute inset-0"
      width="100%"
      height="100%"
      viewBox="0 0 260 300"
      preserveAspectRatio="none"
    >
      <polygon
        points={points}
        fill={fill}
        fillOpacity={fillOpacity}
        stroke={stroke}
        strokeOpacity={strokeOpacity}
        strokeWidth={1.5}
        strokeLinejoin="round"
      />
    </svg>
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
  title,
  value,
  selected,
  onOpen,
}: {
  label: string;
  title?: string;
  value: string;
  selected: boolean;
  onOpen: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onOpen}
      title={title}
      className={`grid w-full cursor-pointer grid-cols-[1fr_auto] items-center gap-3 rounded-lg text-left transition-colors ${
        selected ? "text-white" : "text-osu-f1 hover:text-white"
      }`}
    >
      <span className="text-sm font-semibold">{label}</span>
      <span
        className={`flex h-9 min-w-36 items-center gap-2 rounded-md border px-2 transition-colors ${
          selected ? "border-osu-pink/70 bg-osu-pink/10" : "border-osu-b3/60 bg-osu-b5/60"
        }`}
      >
        <span className="h-5 w-7 rounded-sm border border-white/35" style={{ backgroundColor: value }} />
        <span className="font-mono text-xs font-semibold text-osu-c1">{value}</span>
      </span>
    </button>
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

function PresetIconButton({
  label,
  disabled = false,
  children,
  onClick,
}: {
  label: string;
  disabled?: boolean;
  children: ReactNode;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      disabled={disabled}
      onClick={onClick}
      className="grid h-7 w-7 cursor-pointer place-items-center rounded-md border border-osu-b3/60 bg-osu-b5/70 text-osu-f1 transition-colors hover:border-osu-b2 hover:text-white disabled:cursor-not-allowed disabled:opacity-45 disabled:hover:border-osu-b3/60 disabled:hover:text-osu-f1"
    >
      {children}
    </button>
  );
}

function ReplaySkinColorPanel({ value, onChange }: { value: string; onChange: (value: string) => void }) {
  const [r, g, b] = hexToRgbParts(value);
  const updateRgb = (index: 0 | 1 | 2, next: number) => {
    const parts: [number, number, number] = [r, g, b];
    parts[index] = next;
    onChange(rgbPartsToHex(parts[0], parts[1], parts[2]));
  };

  return (
    <div>
      <div className="mb-3 grid grid-cols-10 gap-1.5">
        {REPLAY_SKIN_PALETTE.map((color) => (
          <button
            key={color}
            type="button"
            onClick={() => onChange(color)}
            className={`aspect-square cursor-pointer rounded-md border transition-transform hover:scale-105 ${
              value.toLowerCase() === color ? "border-white" : "border-white/20"
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
      <div className="mt-3 flex items-center gap-2">
        <span className="h-7 w-7 shrink-0 rounded-md border border-white/30" style={{ backgroundColor: value }} />
        <input
          type="text"
          value={value}
          onChange={(event) => {
            const normalized = normalizeEditableHex(event.target.value);
            if (normalized) onChange(normalized);
          }}
          className="h-7 w-full cursor-text rounded-md border border-osu-b3/50 bg-osu-b5 px-2 font-mono text-[11px] text-osu-c1 outline-none transition-colors focus:border-osu-pink/60"
        />
      </div>
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

function LayoutNumberControl({
  label,
  inputValue,
  numericValue,
  min,
  max,
  defaultValue,
  hint,
  onSliderChange,
  onInputChange,
  onCommit,
  onResetToDefault,
}: {
  label: string;
  inputValue: string;
  numericValue: number;
  min: number;
  max: number;
  defaultValue: number;
  hint?: string;
  onSliderChange: (value: number) => void;
  onInputChange: (value: string) => void;
  onCommit: () => void;
  onResetToDefault: () => void;
}) {
  const safeValue = Math.max(min, Math.min(max, Number.isFinite(numericValue) ? numericValue : defaultValue));
  const fillRatio = max > min ? (safeValue - min) / (max - min) : 0;
  const isDefault = safeValue === defaultValue;
  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between text-sm font-semibold text-osu-l1">
        <span>{label}</span>
        <button
          type="button"
          onClick={onResetToDefault}
          disabled={isDefault}
          className="text-[10px] uppercase tracking-wide text-osu-f1 transition-colors hover:text-white disabled:cursor-default disabled:opacity-50 disabled:hover:text-osu-f1"
        >
          Reset to {defaultValue}
        </button>
      </div>
      <div className="flex items-center gap-3">
        <input
          type="range"
          min={min}
          max={max}
          step={1}
          value={safeValue}
          onChange={(event) => onSliderChange(Number(event.target.value))}
          className="h-1.5 flex-1 cursor-pointer appearance-none rounded-full accent-osu-pink"
          style={{
            background: `linear-gradient(90deg, var(--color-osu-pink, #e83c90) 0%, var(--color-osu-pink, #e83c90) ${fillRatio * 100}%, rgba(38, 38, 51, 0.9) ${fillRatio * 100}%, rgba(38, 38, 51, 0.9) 100%)`,
          }}
        />
        <input
          type="number"
          min={min}
          max={max}
          step={1}
          value={inputValue}
          onChange={(event) => onInputChange(event.target.value)}
          onBlur={onCommit}
          onKeyDown={(event) => {
            if (event.key === "Enter") event.currentTarget.blur();
          }}
          className="h-9 w-20 shrink-0 rounded-lg border border-osu-b3/60 bg-osu-b5/70 px-2 text-center text-sm font-semibold text-white outline-none transition-colors focus:border-osu-pink/70 [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
        />
      </div>
      <div className="flex items-center justify-between text-[10px] text-osu-f1">
        <span>{min}</span>
        {hint ? <span>{hint}</span> : <span className="opacity-0">.</span>}
        <span>{max}</span>
      </div>
    </div>
  );
}

function FancySelect({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: string;
  options: { value: string; label: string }[];
  onChange: (value: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const handler = (event: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(event.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [open]);

  const selected = options.find((option) => option.value === value) ?? options[0];

  return (
    <div className="block">
      <span className="mb-2 block text-[10px] font-bold uppercase tracking-wider text-osu-f1">{label}</span>
      <div ref={containerRef} className="relative">
        <button
          type="button"
          onClick={() => setOpen((value) => !value)}
          aria-haspopup="listbox"
          aria-expanded={open}
          className={`flex h-10 w-full cursor-pointer items-center justify-between gap-2 rounded-lg border px-3 text-sm font-semibold outline-none transition-all ${
            open
              ? "border-osu-pink/50 bg-osu-pink/10 text-white"
              : "border-osu-b3/60 bg-osu-b5/70 text-white hover:border-osu-pink/40 hover:bg-osu-b4"
          }`}
        >
          <span className="truncate">{selected?.label ?? ""}</span>
          <ChevronDown
            className={`h-4 w-4 shrink-0 transition-transform duration-200 ${open ? "rotate-180 text-osu-pink-light" : "text-osu-f1"}`}
            strokeWidth={2.4}
          />
        </button>
        <div
          className={`absolute left-0 right-0 top-full z-[115] mt-1.5 overflow-hidden rounded-lg border border-osu-pink/20 bg-osu-b4/95 shadow-xl shadow-black/40 backdrop-blur-md transition-all duration-150 origin-top ${
            open ? "opacity-100 scale-y-100 translate-y-0 pointer-events-auto" : "opacity-0 scale-y-95 -translate-y-1 pointer-events-none"
          }`}
          role="listbox"
        >
          <div className="max-h-[240px] overflow-y-auto p-1">
            {options.map((option) => {
              const isSelected = option.value === value;
              return (
                <button
                  key={option.value}
                  type="button"
                  role="option"
                  aria-selected={isSelected}
                  onClick={() => {
                    onChange(option.value);
                    setOpen(false);
                  }}
                  className={`flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs font-semibold transition-colors cursor-pointer ${
                    isSelected
                      ? "bg-osu-pink/15 text-osu-pink-light"
                      : "text-osu-l2 hover:bg-osu-b3 hover:text-white"
                  }`}
                >
                  <span className={`flex h-3 w-3 shrink-0 items-center justify-center transition-opacity ${isSelected ? "opacity-100" : "opacity-0"}`}>
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" className="h-3 w-3 text-osu-pink">
                      <polyline points="20 6 9 17 4 12" />
                    </svg>
                  </span>
                  <span className="truncate">{option.label}</span>
                </button>
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );
}

const POPOVER_POSITION_STORAGE_PREFIX = "mania-hub-replay-popover-pos:";

const WINDOW_RECT_STORAGE_KEY = "mania-hub-replay-settings-window-v1";
const WINDOW_DEFAULT_WIDTH = 720;
const WINDOW_DEFAULT_HEIGHT = 640;
const WINDOW_MIN_WIDTH = 460;
const WINDOW_MIN_HEIGHT = 380;
const WINDOW_VIEWPORT_MARGIN = 8;

type WindowRect = { x: number; y: number; w: number; h: number };
type ResizeDirection = "n" | "s" | "e" | "w" | "ne" | "nw" | "se" | "sw";

function readStoredWindowRect(): WindowRect | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(WINDOW_RECT_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed.x !== "number" || typeof parsed.y !== "number" || typeof parsed.w !== "number" || typeof parsed.h !== "number") {
      return null;
    }
    return { x: parsed.x, y: parsed.y, w: parsed.w, h: parsed.h };
  } catch {
    return null;
  }
}

function writeStoredWindowRect(rect: WindowRect): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(WINDOW_RECT_STORAGE_KEY, JSON.stringify(rect));
  } catch {
    // ignore quota errors
  }
}

function clampWindowRect(rect: WindowRect, viewportW: number, viewportH: number): WindowRect {
  const margin = WINDOW_VIEWPORT_MARGIN;
  const maxW = Math.max(WINDOW_MIN_WIDTH, viewportW - margin * 2);
  const maxH = Math.max(WINDOW_MIN_HEIGHT, viewportH - margin * 2);
  const w = Math.max(WINDOW_MIN_WIDTH, Math.min(rect.w, maxW));
  const h = Math.max(WINDOW_MIN_HEIGHT, Math.min(rect.h, maxH));
  const x = Math.max(margin, Math.min(rect.x, Math.max(margin, viewportW - w - margin)));
  const y = Math.max(margin, Math.min(rect.y, Math.max(margin, viewportH - h - margin)));
  return { x, y, w, h };
}

function defaultWindowRect(viewportW: number, viewportH: number): WindowRect {
  const w = Math.min(WINDOW_DEFAULT_WIDTH, Math.max(WINDOW_MIN_WIDTH, viewportW - WINDOW_VIEWPORT_MARGIN * 2));
  const h = Math.min(WINDOW_DEFAULT_HEIGHT, Math.max(WINDOW_MIN_HEIGHT, viewportH - WINDOW_VIEWPORT_MARGIN * 2));
  const x = Math.max(WINDOW_VIEWPORT_MARGIN, Math.round((viewportW - w) / 2));
  const y = Math.max(WINDOW_VIEWPORT_MARGIN, Math.round((viewportH - h) / 2));
  return { x, y, w, h };
}

const RESIZE_HANDLES: ReadonlyArray<{ dir: ResizeDirection; className: string; cursor: string }> = [
  { dir: "n",  className: "left-2 right-2 top-0 h-1.5",            cursor: "ns-resize" },
  { dir: "s",  className: "left-2 right-2 bottom-0 h-1.5",         cursor: "ns-resize" },
  { dir: "w",  className: "top-2 bottom-2 left-0 w-1.5",           cursor: "ew-resize" },
  { dir: "e",  className: "top-2 bottom-2 right-0 w-1.5",          cursor: "ew-resize" },
  { dir: "nw", className: "top-0 left-0 h-3 w-3",                  cursor: "nwse-resize" },
  { dir: "ne", className: "top-0 right-0 h-3 w-3",                 cursor: "nesw-resize" },
  { dir: "sw", className: "bottom-0 left-0 h-3 w-3",               cursor: "nesw-resize" },
  { dir: "se", className: "bottom-0 right-0 h-3 w-3",              cursor: "nwse-resize" },
];

function readStoredPopoverPosition(storageKey: string | undefined): { x: number; y: number } | null {
  if (!storageKey || typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(POPOVER_POSITION_STORAGE_PREFIX + storageKey);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed.x !== "number" || typeof parsed.y !== "number") return null;
    return { x: parsed.x, y: parsed.y };
  } catch {
    return null;
  }
}

function writeStoredPopoverPosition(storageKey: string | undefined, position: { x: number; y: number }): void {
  if (!storageKey || typeof window === "undefined") return;
  try {
    window.localStorage.setItem(POPOVER_POSITION_STORAGE_PREFIX + storageKey, JSON.stringify(position));
  } catch {
    // ignore quota errors
  }
}

function DraggableColorPopover({
  title,
  children,
  width = 264,
  anchorRef,
  onClose,
  storageKey,
}: {
  title: string;
  children: ReactNode;
  width?: number;
  anchorRef?: React.RefObject<HTMLElement | null>;
  onClose: () => void;
  storageKey?: string;
}) {
  const ref = useRef<HTMLDivElement | null>(null);
  const [position, setPosition] = useState<{ x: number; y: number } | null>(null);
  const dragState = useRef<{ pointerId: number; offsetX: number; offsetY: number } | null>(null);

  useEffect(() => {
    if (position != null) return;
    if (typeof window === "undefined") return;
    const margin = 12;
    const w = width;
    const h = ref.current?.offsetHeight ?? 360;
    const stored = readStoredPopoverPosition(storageKey);
    if (stored) {
      const clampedX = Math.min(Math.max(margin, stored.x), Math.max(margin, window.innerWidth - w - margin));
      const clampedY = Math.min(Math.max(margin, stored.y), Math.max(margin, window.innerHeight - h - margin));
      setPosition({ x: clampedX, y: clampedY });
      return;
    }
    const anchor = anchorRef?.current?.getBoundingClientRect();
    let x: number;
    let y: number;
    if (anchor) {
      const rightRoom = window.innerWidth - anchor.right - margin;
      const leftRoom = anchor.left - margin;
      if (rightRoom >= w + margin) {
        x = Math.round(anchor.right + margin);
      } else if (leftRoom >= w + margin) {
        x = Math.round(anchor.left - margin - w);
      } else {
        x = Math.round(anchor.left + margin);
      }
      y = Math.round(anchor.top + 64);
      x = Math.min(Math.max(margin, x), Math.max(margin, window.innerWidth - w - margin));
      y = Math.min(Math.max(margin, y), Math.max(margin, window.innerHeight - h - margin));
    } else {
      x = Math.max(margin, window.innerWidth - w - margin - 24);
      y = Math.max(margin, Math.round((window.innerHeight - h) / 2));
    }
    setPosition({ x, y });
  }, [position, width, anchorRef, storageKey]);

  useEffect(() => {
    if (!position) return;
    writeStoredPopoverPosition(storageKey, position);
  }, [position, storageKey]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const handle = () => {
      setPosition((current) => {
        if (!current) return current;
        const w = width;
        const h = ref.current?.offsetHeight ?? 360;
        return {
          x: Math.min(Math.max(8, current.x), Math.max(8, window.innerWidth - w - 8)),
          y: Math.min(Math.max(8, current.y), Math.max(8, window.innerHeight - h - 8)),
        };
      });
    };
    window.addEventListener("resize", handle);
    return () => window.removeEventListener("resize", handle);
  }, [width]);

  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!ref.current || !position) return;
    event.preventDefault();
    const rect = ref.current.getBoundingClientRect();
    dragState.current = {
      pointerId: event.pointerId,
      offsetX: event.clientX - rect.left,
      offsetY: event.clientY - rect.top,
    };
    event.currentTarget.setPointerCapture(event.pointerId);
  };

  const onPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const state = dragState.current;
    if (!state || state.pointerId !== event.pointerId) return;
    const w = width;
    const h = ref.current?.offsetHeight ?? 360;
    const nextX = Math.min(Math.max(8, event.clientX - state.offsetX), Math.max(8, window.innerWidth - w - 8));
    const nextY = Math.min(Math.max(8, event.clientY - state.offsetY), Math.max(8, window.innerHeight - h - 8));
    setPosition({ x: nextX, y: nextY });
  };

  const endDrag = (event: ReactPointerEvent<HTMLDivElement>) => {
    const state = dragState.current;
    if (!state || state.pointerId !== event.pointerId) return;
    dragState.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  };

  return (
    <div
      ref={ref}
      data-replay-selectable-area="popover"
      className={`fixed z-[120] rounded-xl border border-osu-b2/70 bg-osu-b4/95 shadow-2xl backdrop-blur transition-opacity duration-100 ${
        position ? "opacity-100" : "opacity-0"
      }`}
      style={{ width, left: position?.x ?? -9999, top: position?.y ?? -9999 }}
      onClick={(e) => e.stopPropagation()}
    >
      <div
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        className="flex cursor-grab items-center gap-2 rounded-t-xl border-b border-osu-b3/50 px-3 py-2 select-none active:cursor-grabbing"
      >
        <GripHorizontal className="h-4 w-4 text-osu-f1" />
        <span className="text-xs font-bold uppercase tracking-wider text-osu-l1">{title}</span>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close picker"
          className="ml-auto grid h-6 w-6 cursor-pointer place-items-center rounded-md text-osu-f1 transition-colors hover:bg-osu-b3/50 hover:text-white"
          onPointerDown={(e) => e.stopPropagation()}
        >
          <X className="h-3.5 w-3.5" strokeWidth={2.4} />
        </button>
      </div>
      <div className="p-3">{children}</div>
    </div>
  );
}

function ReplaySkinToast({
  message,
  tone,
  onDismiss,
}: {
  message: string;
  tone: "info" | "error";
  onDismiss: () => void;
}) {
  useEffect(() => {
    const timer = window.setTimeout(onDismiss, 2400);
    return () => window.clearTimeout(timer);
  }, [onDismiss]);
  const toneClasses = tone === "error"
    ? "border-red-400/60 bg-red-500/15 text-red-100"
    : "border-osu-pink/50 bg-osu-b4/95 text-white";
  return (
    <motion.div
      initial={{ opacity: 0, y: -10 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: -10 }}
      transition={{ duration: 0.16 }}
      className={`fixed left-1/2 top-6 z-[140] -translate-x-1/2 rounded-lg border px-3.5 py-2 text-xs font-semibold shadow-lg backdrop-blur ${toneClasses}`}
    >
      {message}
    </motion.div>
  );
}

function ReplaySkinPromptDialog({
  title,
  label,
  initial,
  placeholder,
  confirmLabel = "Confirm",
  multiline = false,
  onCancel,
  onConfirm,
}: {
  title: string;
  label?: string;
  initial: string;
  placeholder?: string;
  confirmLabel?: string;
  multiline?: boolean;
  onCancel: () => void;
  onConfirm: (value: string) => void;
}) {
  const [value, setValue] = useState(initial);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  useEffect(() => {
    const target = multiline ? textareaRef.current : inputRef.current;
    if (!target) return;
    target.focus();
    if (target instanceof HTMLInputElement) target.select();
  }, [multiline]);
  const submit = () => {
    if (!value.trim()) return;
    onConfirm(value);
  };
  return (
    <>
      <motion.div
        className="fixed inset-0 z-[130] bg-black/55 backdrop-blur-[2px]"
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        transition={{ duration: 0.1 }}
        onClick={onCancel}
      />
      <motion.div
        role="dialog"
        aria-modal="true"
        initial={{ opacity: 0, y: -12, scale: 0.98 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        exit={{ opacity: 0, y: -8, scale: 0.98 }}
        transition={{ duration: 0.14 }}
        className="fixed left-1/2 top-1/2 z-[131] w-[min(420px,calc(100vw-2rem))] -translate-x-1/2 -translate-y-1/2 rounded-xl border border-osu-b2/70 bg-osu-b4 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="border-b border-osu-b3/50 px-5 py-3 text-sm font-bold text-white">{title}</div>
        <div className="space-y-2 px-5 py-4">
          {label ? <div className="text-[10px] font-bold uppercase tracking-wider text-osu-f1">{label}</div> : null}
          {multiline ? (
            <textarea
              ref={textareaRef}
              value={value}
              onChange={(event) => setValue(event.target.value)}
              placeholder={placeholder}
              rows={4}
              onKeyDown={(event) => {
                if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
                  event.preventDefault();
                  submit();
                }
                if (event.key === "Escape") onCancel();
              }}
              className="w-full resize-none rounded-md border border-osu-b3/60 bg-osu-b5/70 px-3 py-2 font-mono text-xs text-white outline-none transition-colors focus:border-osu-pink/70"
            />
          ) : (
            <input
              ref={inputRef}
              type="text"
              value={value}
              onChange={(event) => setValue(event.target.value)}
              placeholder={placeholder}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  submit();
                }
                if (event.key === "Escape") onCancel();
              }}
              className="h-10 w-full rounded-md border border-osu-b3/60 bg-osu-b5/70 px-3 text-sm font-semibold text-white outline-none transition-colors focus:border-osu-pink/70"
            />
          )}
        </div>
        <div className="flex items-center justify-end gap-2 border-t border-osu-b3/50 px-5 py-3">
          <button
            type="button"
            onClick={onCancel}
            className="cursor-pointer rounded-lg bg-osu-b3/50 px-4 py-2 text-xs font-semibold text-osu-f1 transition-colors hover:bg-osu-b3 hover:text-white"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={submit}
            disabled={!value.trim()}
            className="cursor-pointer rounded-lg bg-osu-pink px-4 py-2 text-xs font-semibold text-white transition-colors hover:bg-osu-pink-light disabled:cursor-not-allowed disabled:bg-osu-pink/40"
          >
            {confirmLabel}
          </button>
        </div>
      </motion.div>
    </>
  );
}

function ReplaySkinKeyDialog({
  title,
  value,
  onClose,
  onCopy,
}: {
  title: string;
  value: string;
  onClose: () => void;
  onCopy: () => void;
}) {
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  useEffect(() => {
    const target = textareaRef.current;
    if (!target) return;
    target.focus();
    target.select();
  }, []);
  return (
    <>
      <motion.div
        className="fixed inset-0 z-[130] bg-black/55 backdrop-blur-[2px]"
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        transition={{ duration: 0.1 }}
        onClick={onClose}
      />
      <motion.div
        role="dialog"
        aria-modal="true"
        initial={{ opacity: 0, y: -12, scale: 0.98 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        exit={{ opacity: 0, y: -8, scale: 0.98 }}
        transition={{ duration: 0.14 }}
        className="fixed left-1/2 top-1/2 z-[131] w-[min(480px,calc(100vw-2rem))] -translate-x-1/2 -translate-y-1/2 rounded-xl border border-osu-b2/70 bg-osu-b4 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="border-b border-osu-b3/50 px-5 py-3 text-sm font-bold text-white">{title}</div>
        <div className="space-y-2 px-5 py-4">
          <textarea
            ref={textareaRef}
            value={value}
            readOnly
            rows={5}
            onKeyDown={(event) => {
              if (event.key === "Escape") onClose();
            }}
            className="w-full resize-none rounded-md border border-osu-b3/60 bg-osu-b5/70 px-3 py-2 font-mono text-[11px] text-osu-c1 outline-none focus:border-osu-pink/70"
          />
          <div className="text-[10px] text-osu-f1">Select all and copy, or use the button below.</div>
        </div>
        <div className="flex items-center justify-end gap-2 border-t border-osu-b3/50 px-5 py-3">
          <button
            type="button"
            onClick={onClose}
            className="cursor-pointer rounded-lg bg-osu-b3/50 px-4 py-2 text-xs font-semibold text-osu-f1 transition-colors hover:bg-osu-b3 hover:text-white"
          >
            Close
          </button>
          <button
            type="button"
            onClick={onCopy}
            className="flex cursor-pointer items-center gap-1.5 rounded-lg bg-osu-pink px-4 py-2 text-xs font-semibold text-white transition-colors hover:bg-osu-pink-light"
          >
            <Copy className="h-3.5 w-3.5" />
            Copy
          </button>
        </div>
      </motion.div>
    </>
  );
}
