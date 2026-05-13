import { useEffect, useRef, useState } from "react";
import type { MutableRefObject, ReactNode } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { ChevronDown, Film, Settings } from "lucide-react";

import type { ReplayRendererLike } from "#/lib/replay-types";
import { ReplaySkinColorPanel } from "./ReplaySkinColorPanel";

interface ReplayControlsProps {
  rendererRef: MutableRefObject<ReplayRendererLike | null>;
  heatmap: number[];
  audioUrl: string | null;
  audioError: string | null;
  isPlaying: boolean;
  buffering: boolean;
  pendingPlay: boolean;
  speed: number;
  modRate: number;
  audioEnabled: boolean;
  volume: number;
  showInputOverlay: boolean;
  inputOverlayOnly: boolean;
  inputOverlayKeyHistory: boolean;
  inputOverlayColor: string;
  keypressOverlayEnabled: boolean;
  skinSettingsOpen: boolean;
  scrollSpeed: number;
  bgDim: number;
  videoExporting?: boolean;
  videoExportProgress?: number;
  videoExportError?: string | null;
  videoExportUrl?: string | null;
  onTogglePlay: () => void;
  onExportVideo?: (options: ReplayVideoExportOptions) => void;
  onSetSpeed: (speed: number) => void;
  onToggleAudio: () => void;
  onSetVolume: (volume: number) => void;
  onToggleInputOverlay: () => void;
  onToggleInputOverlayOnly: () => void;
  onToggleInputOverlayKeyHistory: () => void;
  onSetInputOverlayColor: (color: string) => void;
  onOpenSkinSettings: () => void;
  onSetScrollSpeed: (speed: number) => void;
  onSetBgDim: (dim: number) => void;
  onPointerDown: () => void;
  onPointerUp: () => void;
  onSeek: (timeMs: number) => void;
  onContextMenu: (timeMsGame: number, clientX: number, clientY: number) => void;
}

export type ReplayVideoExportOptions = {
  kind: "clip" | "full" | "custom";
  durationSeconds?: number;
  startTimeMs?: number;
  endTimeMs?: number;
  resolution: "720p" | "1080p";
  fps: 30 | 48 | 60;
};

async function copyTextToClipboard(text: string): Promise<boolean> {
  try {
    await navigator.clipboard?.writeText(text);
    return true;
  } catch {
    const textarea = document.createElement("textarea");
    textarea.value = text;
    textarea.setAttribute("readonly", "");
    textarea.style.position = "fixed";
    textarea.style.left = "-9999px";
    textarea.style.top = "0";
    document.body.appendChild(textarea);
    textarea.focus();
    textarea.select();
    try {
      return document.execCommand("copy");
    } catch {
      return false;
    } finally {
      textarea.remove();
    }
  }
}

export function ReplayControls({
  rendererRef,
  heatmap,
  audioUrl,
  audioError,
  isPlaying,
  buffering,
  pendingPlay,
  speed,
  modRate,
  audioEnabled,
  volume,
  showInputOverlay,
  inputOverlayOnly,
  inputOverlayKeyHistory,
  inputOverlayColor,
  keypressOverlayEnabled,
  skinSettingsOpen,
  scrollSpeed,
  bgDim,
  videoExporting = false,
  videoExportProgress = 0,
  videoExportError = null,
  videoExportUrl = null,
  onTogglePlay,
  onExportVideo,
  onSetSpeed,
  onToggleAudio,
  onSetVolume,
  onToggleInputOverlay,
  onToggleInputOverlayOnly,
  onToggleInputOverlayKeyHistory,
  onSetInputOverlayColor,
  onOpenSkinSettings,
  onSetScrollSpeed,
  onSetBgDim,
  onPointerDown,
  onPointerUp,
  onSeek,
  onContextMenu,
}: ReplayControlsProps) {
  const [shareUrl, setShareUrl] = useState<string | null>(null);
  const [sharePos, setSharePos] = useState<{ x: number; y: number }>({ x: 0, y: 0 });
  const [shareLabel, setShareLabel] = useState("");
  const [copied, setCopied] = useState(false);
  const [videoMenuOpen, setVideoMenuOpen] = useState(false);
  const [videoClipMode, setVideoClipMode] = useState(false);
  const [videoExportKind, setVideoExportKind] = useState<ReplayVideoExportOptions["kind"]>("custom");
  const [videoCustomStartMs, setVideoCustomStartMs] = useState<number | null>(null);
  const [videoCustomEndMs, setVideoCustomEndMs] = useState<number | null>(null);
  const [videoResolution, setVideoResolution] = useState<ReplayVideoExportOptions["resolution"]>("1080p");
  const [videoFps, setVideoFps] = useState<ReplayVideoExportOptions["fps"]>(48);
  const [videoToast, setVideoToast] = useState<{ id: number; message: string; url?: string } | null>(null);
  const videoToastIdRef = useRef(0);
  const wasVideoExportingRef = useRef(videoExporting);
  const videoMenuRef = useRef<HTMLDivElement>(null);
  const sliderClass = "h-1 appearance-none bg-osu-b3 rounded-full cursor-pointer [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:w-2.5 [&::-webkit-slider-thumb]:h-2.5 [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-osu-pink";

  useEffect(() => {
    if (!videoMenuOpen) return;
    const onDocPointer = (event: PointerEvent) => {
      const el = videoMenuRef.current;
      if (el && !el.contains(event.target as Node)) setVideoMenuOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setVideoMenuOpen(false);
    };
    document.addEventListener("pointerdown", onDocPointer);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onDocPointer);
      document.removeEventListener("keydown", onKey);
    };
  }, [videoMenuOpen]);

  useEffect(() => {
    const completedExport = wasVideoExportingRef.current && !videoExporting && Boolean(videoExportUrl);
    wasVideoExportingRef.current = videoExporting;
    if (!completedExport || !videoExportUrl) return;
    videoToastIdRef.current += 1;
    const toastId = videoToastIdRef.current;
    const showToast = (message: string, url?: string) => {
      setVideoToast({ id: toastId, message, url });
      window.setTimeout(() => {
        setVideoToast((current) => (current?.id === toastId ? null : current));
      }, url ? 9000 : 3500);
    };
    showToast("Discord video ready", videoExportUrl);
  }, [videoExporting, videoExportUrl]);

  const handleProgressContextMenu = (timeMsGame: number, clientX: number, clientY: number) => {
    onContextMenu(timeMsGame, clientX, clientY);
    const wallMs = timeMsGame / modRate;
    const t = Math.round((wallMs / 1000) * 10) / 10;
    const url = new URL(window.location.href);
    url.searchParams.set("t", String(t));
    setShareUrl(url.toString());
    setSharePos({ x: clientX, y: clientY });
    setShareLabel(formatReplayMs(wallMs));
    setCopied(false);
  };

  const currentReplayTimeMs = () => rendererRef.current?.time ?? 0;
  const customStart = Math.min(videoCustomStartMs ?? 0, videoCustomEndMs ?? 0);
  const customEnd = Math.max(videoCustomStartMs ?? 0, videoCustomEndMs ?? 0);
  const hasCustomRange = videoCustomStartMs != null && videoCustomEndMs != null && customEnd > customStart;
  const selectedExportLabel = videoExportKind === "full"
    ? "Full"
    : videoCustomStartMs == null || videoCustomEndMs != null ? "Set start" : "Set end";

  const markCustomVideoPoint = () => {
    const timeMs = currentReplayTimeMs();
    setVideoClipMode(true);
    if (videoCustomStartMs == null || videoCustomEndMs != null) {
      setVideoCustomStartMs(timeMs);
      setVideoCustomEndMs(null);
      return;
    }
    setVideoCustomEndMs(timeMs);
  };

  return (
    <div className="bg-osu-b4 rounded-xl border border-osu-b3/20">
      {audioError && (
        <div className="text-[11px] text-osu-yellow bg-osu-yellow/10 border-b border-osu-yellow/20 px-4 py-2 rounded-t-xl">
          {audioError}
        </div>
      )}
      {videoExportError && (
        <div className="text-[11px] text-red-100 bg-red-500/10 border-b border-red-400/20 px-4 py-2 rounded-t-xl">
          {videoExportError}
        </div>
      )}
      <AnimatePresence>
        {videoToast && (
          <motion.div
            key={videoToast.id}
            initial={{ opacity: 0, y: -6 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -6 }}
            transition={{ duration: 0.14 }}
            className="fixed right-4 top-4 z-[200] flex items-center gap-2 rounded-lg border border-osu-pink/30 bg-osu-b3 px-3 py-2 text-[12px] font-semibold text-white shadow-2xl"
          >
            <span>{videoToast.message}</span>
            {videoToast.url && (
              <button
                type="button"
                onClick={() => {
                  void copyTextToClipboard(videoToast.url!).then((ok) => {
                    if (ok) setVideoToast({ id: videoToast.id, message: "Discord video URL copied" });
                  });
                }}
                className="rounded bg-osu-pink px-2 py-1 text-[11px] font-bold text-white hover:bg-osu-pink-light"
              >
                Copy
              </button>
            )}
          </motion.div>
        )}
      </AnimatePresence>

      <ReplayProgressBar
        rendererRef={rendererRef}
        heatmap={heatmap}
        sliderClass=""
        clipPreviewSeconds={null}
        clipPreviewRate={speed * modRate}
        customPreviewRange={onExportVideo && videoClipMode && videoExportKind === "custom"
          ? { startMs: videoCustomStartMs, endMs: videoCustomEndMs }
          : null}
        onPointerDown={onPointerDown}
        onPointerUp={onPointerUp}
        onSeek={onSeek}
        onContextMenu={handleProgressContextMenu}
      >
        <ShareTimestampTooltip
          shareUrl={shareUrl}
          sharePos={sharePos}
          shareLabel={shareLabel}
          copied={copied}
          onClose={() => setShareUrl(null)}
          onCopied={() => setCopied(true)}
        />
      </ReplayProgressBar>

      <div className="flex items-center gap-2 sm:gap-3 px-3 sm:px-4 py-3 flex-wrap">
        <button
          onClick={onTogglePlay}
          title={pendingPlay ? "Waiting for audio to load..." : isPlaying && buffering ? "Buffering..." : undefined}
          className="w-9 h-9 rounded-full bg-osu-pink hover:bg-osu-pink-light transition-colors flex items-center justify-center cursor-pointer shrink-0"
        >
          {pendingPlay || (isPlaying && buffering) ? (
            <svg viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2.5" strokeLinecap="round" className="w-4 h-4 animate-spin">
              <path d="M12 2a10 10 0 0 1 10 10" />
            </svg>
          ) : isPlaying ? (
            <svg viewBox="0 0 24 24" fill="white" className="w-4 h-4">
              <rect x="6" y="4" width="4" height="16" rx="1" />
              <rect x="14" y="4" width="4" height="16" rx="1" />
            </svg>
          ) : (
            <svg viewBox="0 0 24 24" fill="white" className="w-4 h-4 ml-0.5">
              <path d="M8 5v14l11-7z" />
            </svg>
          )}
        </button>

        <div className="flex items-center gap-0.5">
          {[0.25, 0.5, 1, 1.5, 2].map((nextSpeed) => (
            <button
              key={nextSpeed}
              onClick={() => onSetSpeed(nextSpeed)}
              className={`px-1.5 sm:px-2 py-1 rounded text-[10px] font-semibold cursor-pointer transition-colors ${speed === nextSpeed ? "bg-osu-pink text-white" : "bg-osu-b3/50 text-osu-f1 hover:text-white hover:bg-osu-b3"}`}
            >
              {nextSpeed}x
            </button>
          ))}
        </div>

        <div className="w-px h-5 bg-osu-b3/40 hidden sm:block" />

        {audioUrl && (
          <div className="flex items-center gap-1.5">
            <button onClick={onToggleAudio} className="w-7 h-7 rounded flex items-center justify-center cursor-pointer transition-colors hover:bg-osu-b3/50">
              <VolumeIcon muted={!audioEnabled || volume === 0} low={volume < 0.5} />
            </button>
            <input
              type="range"
              min={0}
              max={1}
              step={0.05}
              value={audioEnabled ? volume : 0}
              onChange={(e) => onSetVolume(Number(e.target.value))}
              className={`w-12 sm:w-16 ${sliderClass}`}
            />
          </div>
        )}

        <div className="w-px h-5 bg-osu-b3/40 hidden sm:block" />

        <InputOverlayMenu
          showInputOverlay={showInputOverlay}
          inputOverlayOnly={inputOverlayOnly}
          inputOverlayKeyHistory={inputOverlayKeyHistory}
          inputOverlayColor={inputOverlayColor}
          keypressOverlayEnabled={keypressOverlayEnabled}
          onToggleInputOverlay={onToggleInputOverlay}
          onToggleInputOverlayOnly={onToggleInputOverlayOnly}
          onToggleInputOverlayKeyHistory={onToggleInputOverlayKeyHistory}
          onSetInputOverlayColor={onSetInputOverlayColor}
        />

        <button
          onClick={onOpenSkinSettings}
          aria-label="Replay settings"
          title="Replay settings"
          className={`w-7 h-7 rounded flex items-center justify-center cursor-pointer transition-colors ${
            skinSettingsOpen
              ? "bg-osu-pink text-white"
              : "bg-osu-b3/50 text-osu-f1 hover:text-white hover:bg-osu-b3"
          }`}
        >
          <Settings className="h-4 w-4" strokeWidth={2.2} />
        </button>

        {onExportVideo && (
          <div ref={videoMenuRef} className="relative inline-flex">
            <button
              type="button"
              onClick={() => {
                if (videoExportKind === "custom") {
                  markCustomVideoPoint();
                } else {
                  setVideoClipMode((enabled) => !enabled);
                }
              }}
              disabled={videoExporting}
              aria-label="Generate replay video URL"
              className={`h-7 rounded-l px-2.5 text-[10px] font-semibold transition-colors flex items-center gap-1.5 ${
                videoExporting
                  ? "cursor-default bg-osu-b3/40 text-osu-f1"
                  : videoClipMode
                    ? "cursor-pointer bg-osu-pink text-white hover:bg-osu-pink-light"
                    : "cursor-pointer bg-osu-b3/50 text-osu-f1 hover:text-white hover:bg-osu-b3"
              }`}
            >
              <Film className="h-3.5 w-3.5" strokeWidth={2.3} />
              <span className="tabular-nums">
                {videoExporting
                  ? `${Math.round(videoExportProgress * 100)}%`
                  : selectedExportLabel}
              </span>
            </button>
            <button
              type="button"
              onClick={() => setVideoMenuOpen((open) => !open)}
              disabled={videoExporting}
              aria-label="Replay video export options"
              aria-expanded={videoMenuOpen}
              className={`h-7 rounded-r border-l border-osu-b4/40 px-1 transition-colors flex items-center ${
                videoExporting
                  ? "cursor-default bg-osu-b3/40 text-osu-f1"
                  : videoClipMode
                    ? "cursor-pointer bg-osu-pink text-white hover:bg-osu-pink-light"
                    : "cursor-pointer bg-osu-b3/50 text-osu-f1 hover:text-white hover:bg-osu-b3"
              }`}
            >
              <ChevronDown className={`h-3.5 w-3.5 transition-transform ${videoMenuOpen ? "" : "rotate-180"}`} strokeWidth={2.3} />
            </button>
            <AnimatePresence>
              {videoMenuOpen && (
                <motion.div
                  initial={{ opacity: 0, y: 4 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, y: 4 }}
                  transition={{ duration: 0.1 }}
                  className="absolute left-0 bottom-full z-50 mb-1.5 w-36 rounded-lg border border-osu-b2 bg-osu-b3 p-1.5 shadow-2xl"
                >
                  <button
                    type="button"
                    onClick={() => {
                      if (videoExportKind === "custom" && videoClipMode) {
                        setVideoClipMode(false);
                        setVideoCustomStartMs(null);
                        setVideoCustomEndMs(null);
                      } else {
                        setVideoExportKind("custom");
                        setVideoClipMode(true);
                      }
                    }}
                    className={`flex w-full cursor-pointer items-center justify-between rounded px-2 py-1.5 text-[11px] font-medium hover:bg-osu-b4 ${
                      videoExportKind === "custom" && videoClipMode ? "text-white" : "text-osu-f0"
                    }`}
                  >
                    <span>Custom</span>
                    <CheckMark on={videoExportKind === "custom" && videoClipMode} />
                  </button>
                  {videoExportKind === "custom" && videoClipMode && (
                    <div className="space-y-1.5 px-1 pb-1">
                      <div className="grid grid-cols-2 gap-1">
                        <button
                          type="button"
                          onClick={() => {
                            setVideoCustomStartMs(currentReplayTimeMs());
                            setVideoClipMode(true);
                          }}
                          className={`cursor-pointer rounded px-1.5 py-1 text-[10px] font-semibold transition-colors ${
                            videoCustomStartMs != null
                              ? "bg-osu-pink/25 text-white ring-1 ring-inset ring-osu-pink/50"
                              : "bg-osu-b4 text-osu-f0 hover:text-white"
                          }`}
                        >
                          Start here
                        </button>
                        <button
                          type="button"
                          onClick={() => {
                            setVideoCustomEndMs(currentReplayTimeMs());
                            setVideoClipMode(true);
                          }}
                          className={`cursor-pointer rounded px-1.5 py-1 text-[10px] font-semibold transition-colors ${
                            videoCustomEndMs != null
                              ? "bg-osu-pink/25 text-white ring-1 ring-inset ring-osu-pink/50"
                              : "bg-osu-b4 text-osu-f0 hover:text-white"
                          }`}
                        >
                          End here
                        </button>
                      </div>
                      <div className="rounded bg-osu-b4/60 px-1.5 py-1 text-[10px] leading-tight text-osu-f1">
                        <div className="flex justify-between gap-2">
                          <span>Start</span>
                          <span className={videoCustomStartMs != null ? "font-semibold text-white" : ""}>
                            {videoCustomStartMs != null ? formatReplayMs(videoCustomStartMs / modRate) : "--:--"}
                          </span>
                        </div>
                        <div className="flex justify-between gap-2">
                          <span>End</span>
                          <span className={videoCustomEndMs != null ? "font-semibold text-white" : ""}>
                            {videoCustomEndMs != null ? formatReplayMs(videoCustomEndMs / modRate) : "--:--"}
                          </span>
                        </div>
                      </div>
                      {(videoCustomStartMs != null || videoCustomEndMs != null) && (
                        <button
                          type="button"
                          onClick={() => {
                            setVideoCustomStartMs(null);
                            setVideoCustomEndMs(null);
                          }}
                          className="w-full cursor-pointer rounded bg-osu-b4/70 px-1.5 py-1 text-[10px] font-semibold text-osu-f0 hover:text-white"
                        >
                          Clear marks
                        </button>
                      )}
                    </div>
                  )}
                  <div className="my-1 h-px bg-osu-b2" />
                  <button
                    type="button"
                    onClick={() => {
                      setVideoExportKind("full");
                      setVideoClipMode(false);
                    }}
                    className={`flex w-full cursor-pointer items-center justify-between rounded px-2 py-1.5 text-[11px] font-medium hover:bg-osu-b4 ${
                      videoExportKind === "full" ? "text-white" : "text-osu-f0"
                    }`}
                  >
                    <span>Full play</span>
                    <CheckMark on={videoExportKind === "full"} />
                  </button>
                  <div className="my-1 h-px bg-osu-b2" />
                  <button
                    type="button"
                    onClick={() => {
                      setVideoClipMode(true);
                      setVideoMenuOpen(false);
                      if (videoExportKind === "full") {
                        onExportVideo({ kind: "full", resolution: videoResolution, fps: videoFps });
                      } else if (videoExportKind === "custom") {
                        if (!hasCustomRange) return;
                        onExportVideo({ kind: "custom", startTimeMs: customStart, endTimeMs: customEnd, resolution: videoResolution, fps: videoFps });
                      }
                    }}
                    disabled={videoExportKind === "custom" && !hasCustomRange}
                    className="flex w-full cursor-pointer items-center justify-center rounded bg-osu-pink px-2 py-1.5 text-[11px] font-semibold text-white hover:bg-osu-pink-light disabled:cursor-not-allowed disabled:opacity-45 disabled:hover:bg-osu-pink"
                  >
                    Generate URL
                  </button>
                  <div className="px-1 py-1 text-center text-[10px] leading-tight text-osu-f1">
                    For Discord embeds
                  </div>
                  <div className="my-1 h-px bg-osu-b2" />
                  <div className="grid grid-cols-2 gap-1">
                    {(["720p", "1080p"] as const).map((resolution) => (
                      <button
                        key={resolution}
                        type="button"
                        onClick={() => setVideoResolution(resolution)}
                        className={`cursor-pointer rounded px-2 py-1.5 text-[11px] font-semibold hover:bg-osu-b4 ${
                          videoResolution === resolution ? "bg-osu-pink text-white" : "text-osu-f0"
                        }`}
                      >
                        {resolution}
                      </button>
                    ))}
                  </div>
                  <div className="my-1 h-px bg-osu-b2" />
                  <div className="grid grid-cols-3 gap-1">
                    {([30, 48, 60] as const).map((fps) => (
                      <button
                        key={fps}
                        type="button"
                        onClick={() => setVideoFps(fps)}
                        className={`cursor-pointer rounded px-2 py-1.5 text-[11px] font-semibold hover:bg-osu-b4 ${
                          videoFps === fps ? "bg-osu-pink text-white" : "text-osu-f0"
                        }`}
                      >
                        {fps}
                      </button>
                    ))}
                  </div>
                </motion.div>
              )}
            </AnimatePresence>
          </div>
        )}

        <div className="flex items-center gap-1">
          <span className="text-[10px] text-osu-f1 mr-0.5">Scroll</span>
          <button
            onClick={() => onSetScrollSpeed(Math.max(1, scrollSpeed - 1))}
            className="w-5 h-5 rounded bg-osu-b3/50 text-osu-f1 hover:text-white hover:bg-osu-b3 transition-colors cursor-pointer flex items-center justify-center text-xs leading-none"
          >
            -
          </button>
          <span className="text-xs text-white font-bold w-5 text-center tabular-nums">{scrollSpeed}</span>
          <button
            onClick={() => onSetScrollSpeed(Math.min(40, scrollSpeed + 1))}
            className="w-5 h-5 rounded bg-osu-b3/50 text-osu-f1 hover:text-white hover:bg-osu-b3 transition-colors cursor-pointer flex items-center justify-center text-xs leading-none"
          >
            +
          </button>
        </div>

        <div className="flex items-center gap-2 ml-0 sm:ml-auto w-full sm:w-auto">
          <span className="text-[10px] text-osu-f1">BG Dim</span>
          <input
            type="range"
            min={0}
            max={100}
            step={5}
            value={bgDim}
            onChange={(e) => onSetBgDim(Number(e.target.value))}
            className={`w-16 sm:w-20 ${sliderClass}`}
          />
          <span className="text-[10px] text-osu-f1 tabular-nums w-7">{bgDim}%</span>
        </div>
      </div>
    </div>
  );
}

function VolumeIcon({ muted, low }: { muted: boolean; low: boolean }) {
  if (muted) {
    return (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="w-4 h-4 text-osu-f1">
        <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" fill="currentColor" />
        <line x1="23" y1="9" x2="17" y2="15" />
        <line x1="17" y1="9" x2="23" y2="15" />
      </svg>
    );
  }

  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="w-4 h-4 text-white">
      <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" fill="currentColor" />
      <path d="M15.54 8.46a5 5 0 0 1 0 7.07" />
      {!low && <path d="M19.07 4.93a10 10 0 0 1 0 14.14" />}
    </svg>
  );
}

function InputOverlayMenu({
  showInputOverlay,
  inputOverlayOnly,
  inputOverlayKeyHistory,
  inputOverlayColor,
  keypressOverlayEnabled,
  onToggleInputOverlay,
  onToggleInputOverlayOnly,
  onToggleInputOverlayKeyHistory,
  onSetInputOverlayColor,
}: {
  showInputOverlay: boolean;
  inputOverlayOnly: boolean;
  inputOverlayKeyHistory: boolean;
  inputOverlayColor: string;
  keypressOverlayEnabled: boolean;
  onToggleInputOverlay: () => void;
  onToggleInputOverlayOnly: () => void;
  onToggleInputOverlayKeyHistory: () => void;
  onSetInputOverlayColor: (color: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [colorOpen, setColorOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) {
      setColorOpen(false);
      return;
    }
    const onDocPointer = (e: PointerEvent) => {
      const el = containerRef.current;
      if (el && !el.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("pointerdown", onDocPointer);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onDocPointer);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const activeBtn = "bg-osu-pink text-white";
  const inactiveBtn = "bg-osu-b3/50 text-osu-f1 hover:text-white hover:bg-osu-b3";
  const keyHistoryVisible = keypressOverlayEnabled && inputOverlayKeyHistory;
  const anyInputVisualization = showInputOverlay || keyHistoryVisible;

  return (
    <div ref={containerRef} className="relative inline-flex items-stretch">
      <button
        onClick={onToggleInputOverlay}
        title="Toggle field input overlay"
        className={`pl-2.5 pr-2 py-1 rounded-l text-[10px] font-semibold cursor-pointer transition-colors ${
          showInputOverlay ? activeBtn : inactiveBtn
        }`}
      >
        Inputs
      </button>
      <button
        onClick={() => setOpen((v) => !v)}
        aria-label="Input overlay options"
        aria-expanded={open}
        title="Input overlay options"
        className={`px-1 py-1 rounded-r border-l border-osu-b4/40 cursor-pointer transition-colors ${
          anyInputVisualization ? activeBtn : inactiveBtn
        }`}
      >
        <ChevronDown className={`h-3 w-3 transition-transform ${open ? "" : "rotate-180"}`} strokeWidth={2.5} />
      </button>
      <AnimatePresence>
        {open && (
          <motion.div
            initial={{ opacity: 0, y: 4 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 4 }}
            transition={{ duration: 0.1 }}
            className={`absolute left-0 bottom-full z-50 mb-1.5 rounded-lg border border-osu-b2 bg-osu-b3 shadow-2xl p-1.5 ${colorOpen ? "w-56" : "w-44"}`}
          >
            <button
              onClick={onToggleInputOverlay}
              className="flex w-full items-center justify-between gap-2 rounded px-2 py-1.5 text-[11px] font-medium text-osu-f0 hover:bg-osu-b4 cursor-pointer"
            >
              <span>Column presses</span>
              <CheckMark on={showInputOverlay} />
            </button>
            <button
              onClick={onToggleInputOverlayOnly}
              disabled={!showInputOverlay}
              className="flex w-full items-center justify-between gap-2 rounded px-2 py-1.5 text-[11px] font-medium text-osu-f0 hover:bg-osu-b4 cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:bg-transparent"
            >
              <span>Notes only</span>
              <CheckMark on={inputOverlayOnly} />
            </button>
            {keypressOverlayEnabled && (
              <button
                onClick={onToggleInputOverlayKeyHistory}
                className="flex w-full items-center justify-between gap-2 rounded px-2 py-1.5 text-[11px] font-medium text-osu-f0 hover:bg-osu-b4 cursor-pointer"
              >
                <span>Key history</span>
                <CheckMark on={inputOverlayKeyHistory} />
              </button>
            )}
            <div className="my-1 h-px bg-osu-b2" />
            <button
              type="button"
              onClick={() => {
                if (anyInputVisualization) setColorOpen((v) => !v);
              }}
              disabled={!anyInputVisualization}
              aria-expanded={colorOpen}
              className={`flex w-full items-center justify-between gap-2 rounded px-2 py-1.5 text-[11px] font-medium text-osu-f0 ${anyInputVisualization ? "cursor-pointer hover:bg-osu-b4" : "opacity-40 cursor-not-allowed"}`}
            >
              <span>Color</span>
              <span className="inline-flex items-center gap-1.5">
                <span className="text-[10px] tabular-nums text-osu-f1">{inputOverlayColor.toUpperCase()}</span>
                <span
                  className="h-4 w-4 rounded border border-osu-b2"
                  style={{ backgroundColor: inputOverlayColor }}
                />
                <ChevronDown className={`h-3 w-3 text-osu-f1 transition-transform ${colorOpen ? "rotate-180" : ""}`} strokeWidth={2.5} />
              </span>
            </button>
            {colorOpen && anyInputVisualization && (
              <div className="mt-1 rounded border border-osu-b2/60 bg-osu-b4/40 p-2">
                <ReplaySkinColorPanel value={inputOverlayColor} onChange={onSetInputOverlayColor} />
              </div>
            )}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

function CheckMark({ on }: { on: boolean }) {
  return (
    <span
      className={`inline-flex h-3.5 w-3.5 items-center justify-center rounded-sm border ${
        on ? "border-osu-pink bg-osu-pink text-white" : "border-osu-b2 bg-osu-b4"
      }`}
    >
      {on && (
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" className="h-2.5 w-2.5">
          <polyline points="20 6 9 17 4 12" />
        </svg>
      )}
    </span>
  );
}

function ShareTimestampTooltip({
  shareUrl,
  sharePos,
  shareLabel,
  copied,
  onClose,
  onCopied,
}: {
  shareUrl: string | null;
  sharePos: { x: number; y: number };
  shareLabel: string;
  copied: boolean;
  onClose: () => void;
  onCopied: () => void;
}) {
  return (
    <AnimatePresence>
      {shareUrl && (
        <>
          <div className="fixed inset-0 z-[99]" onClick={onClose} />
          <motion.div
            initial={{ opacity: 0, y: 4 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 4 }}
            transition={{ duration: 0.1 }}
            style={{ left: Math.min(sharePos.x, window.innerWidth - 340), top: sharePos.y - 8 }}
            className="fixed -translate-y-full z-[100] bg-osu-b3 border border-osu-b2 rounded-lg shadow-2xl p-2.5 w-80"
          >
            <div className="text-[11px] text-osu-f1 mb-1.5">Copy URL at {shareLabel}</div>
            <div className="flex gap-1.5">
              <input
                type="text"
                readOnly
                value={shareUrl}
                className="flex-1 min-w-0 bg-osu-b4 text-[10px] text-osu-f0 rounded px-2 py-1 border border-osu-b2 outline-none select-all"
                onFocus={(e) => e.target.select()}
              />
          <button
            onClick={() => {
              navigator.clipboard.writeText(shareUrl);
              onCopied();
            }}
                className="px-2.5 py-1 rounded bg-osu-pink hover:bg-osu-pink-light text-white text-[11px] font-medium transition-colors cursor-pointer shrink-0"
              >
                {copied ? "Copied!" : "Copy"}
              </button>
            </div>
          </motion.div>
        </>
      )}
    </AnimatePresence>
  );
}

export function ReplayProgressBar({
  rendererRef,
  heatmap,
  sliderClass,
  className = "",
  clipPreviewSeconds = null,
  clipPreviewRate = 1,
  customPreviewRange = null,
  onPointerDown,
  onPointerUp,
  onSeek,
  onContextMenu,
  children,
}: {
  rendererRef: MutableRefObject<ReplayRendererLike | null>;
  heatmap: number[];
  sliderClass: string;
  className?: string;
  clipPreviewSeconds?: number | null;
  clipPreviewRate?: number;
  customPreviewRange?: { startMs: number | null; endMs: number | null } | null;
  onPointerDown: () => void;
  onPointerUp: () => void;
  onSeek: (timeMs: number) => void;
  onContextMenu: (timeMsGame: number, clientX: number, clientY: number) => void;
  children?: ReactNode;
}) {
  const [progress, setProgress] = useState(0);

  useEffect(() => {
    const pollOnce = () => {
      const r = rendererRef.current;
      if (!r || r.duration <= 0) return;
      setProgress(r.time / r.duration);
    };
    pollOnce();
    const id = setInterval(pollOnce, 100);
    return () => clearInterval(id);
  }, [rendererRef]);

  const displayDuration = rendererRef.current?.displayDuration ?? 0;
  const leftLabel = formatReplayMs(progress * displayDuration);
  const rightLabel = formatReplayMs(displayDuration);

  return (
    <div
      className={`group relative flex items-center gap-3 px-4 pt-3 pb-1 ${className}`}
      onContextMenu={(e) => {
        e.preventDefault();
        const r = rendererRef.current;
        if (!r) return;
        onContextMenu(r.time, e.clientX, e.clientY);
      }}
    >
      <span className="text-[10px] text-osu-f1 tabular-nums w-10">{leftLabel}</span>
      <div className="relative flex-1">
        <KeypressHeatmap heatmap={heatmap} />
        <input
          type="range"
          min={0}
          max={1}
          step={0.001}
          value={progress}
          onPointerDown={onPointerDown}
          onPointerUp={onPointerUp}
          onChange={(e) => {
            const v = Number(e.target.value);
            setProgress(v);
            const r = rendererRef.current;
            if (r) onSeek(v * r.duration);
          }}
          className={`block w-full h-1.5 appearance-none bg-osu-b3 rounded-full cursor-pointer [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:w-3 [&::-webkit-slider-thumb]:h-3 [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-osu-pink ${sliderClass}`}
        />
        <ClipPreviewRange
          progress={progress}
          duration={rendererRef.current?.duration ?? 0}
          seconds={clipPreviewSeconds}
          rate={clipPreviewRate}
          customRange={customPreviewRange}
        />
      </div>
      <span className="text-[10px] text-osu-f1 tabular-nums w-10 text-right">{rightLabel}</span>
      {children}
    </div>
  );
}

function KeypressHeatmap({ heatmap }: { heatmap: number[] }) {
  const n = heatmap.length;
  if (n === 0) return null;
  const width = 1000;
  const height = 100;
  const step = width / (n - 1 || 1);
  const points = new Array<{ x: number; y: number }>(n);
  for (let i = 0; i < n; i++) {
    points[i] = { x: i * step, y: height - heatmap[i] * height };
  }
  const first = `${points[0].x.toFixed(2)} ${points[0].y.toFixed(2)}`;
  let curve = "";
  for (let i = 0; i < n - 1; i++) {
    const cur = points[i];
    const next = points[i + 1];
    const mx = (cur.x + next.x) / 2;
    const my = (cur.y + next.y) / 2;
    curve += ` Q ${cur.x.toFixed(2)} ${cur.y.toFixed(2)} ${mx.toFixed(2)} ${my.toFixed(2)}`;
  }
  const last = `${points[n - 1].x.toFixed(2)} ${points[n - 1].y.toFixed(2)}`;
  const topD = `M ${first}${curve} L ${last}`;
  const fillD = `M 0 ${height} L ${first}${curve} L ${last} L ${width} ${height} Z`;
  return (
    <svg
      viewBox={`0 0 ${width} ${height}`}
      preserveAspectRatio="none"
      className="absolute inset-x-0 bottom-full h-5 w-full pointer-events-none text-osu-pink opacity-0 group-hover:opacity-100 transition-opacity duration-200"
      aria-hidden="true"
    >
      <defs>
        <linearGradient id="replay-keypress-heatmap-fade" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="currentColor" stopOpacity="0.6" />
          <stop offset="40%" stopColor="currentColor" stopOpacity="0.1" />
          <stop offset="100%" stopColor="currentColor" stopOpacity="0" />
        </linearGradient>
      </defs>
      <path d={fillD} fill="url(#replay-keypress-heatmap-fade)" />
      <path
        d={topD}
        fill="none"
        stroke="currentColor"
        strokeWidth={1.5}
        strokeLinejoin="round"
        strokeLinecap="round"
        vectorEffect="non-scaling-stroke"
      />
    </svg>
  );
}

function ClipPreviewRange({
  progress,
  duration,
  seconds,
  rate,
  customRange,
}: {
  progress: number;
  duration: number;
  seconds: number | null;
  rate: number;
  customRange: { startMs: number | null; endMs: number | null } | null;
}) {
  if (duration <= 0) return null;

  if (customRange) {
    const startMs = customRange.startMs == null ? null : Math.max(0, Math.min(duration, customRange.startMs));
    const endMs = customRange.endMs == null ? null : Math.max(0, Math.min(duration, customRange.endMs));
    const markers = [
      startMs == null ? null : { key: "start", left: startMs / duration, label: "S" },
      endMs == null ? null : { key: "end", left: endMs / duration, label: "E" },
    ].filter((marker): marker is { key: string; left: number; label: string } => marker != null);

    if (startMs != null && endMs != null && startMs !== endMs) {
      const rangeStart = Math.min(startMs, endMs) / duration;
      const maxWidth = Math.max(0, 1 - rangeStart);
      const rangeWidth = Math.min(maxWidth, Math.abs(endMs - startMs) / duration);
      return (
        <>
          <ClipPreviewPill start={rangeStart} width={rangeWidth} />
          {markers.map((marker) => (
            <ClipPreviewMarker key={marker.key} left={marker.left} label={marker.label} />
          ))}
        </>
      );
    }

    return (
      <>
        {markers.map((marker) => (
          <ClipPreviewMarker key={marker.key} left={marker.left} label={marker.label} />
        ))}
      </>
    );
  }

  let start = 0;
  let width = 0;
  if (seconds) {
    start = Math.max(0, Math.min(1, progress));
    width = Math.min(1 - start, (seconds * 1000 * Math.max(0.01, rate)) / duration);
  }

  const maxWidth = Math.max(0, 1 - start);
  width = Math.min(maxWidth, width);
  if (width <= 0) return null;
  width = Math.max(Math.min(0.006, maxWidth), width);
  return <ClipPreviewPill start={start} width={width} />;
}

function ClipPreviewPill({ start, width }: { start: number; width: number }) {
  return (
    <div
      className="pointer-events-none absolute top-1/2 z-10 h-1.5 -translate-y-1/2 rounded-full bg-osu-pink/35 ring-1 ring-inset ring-white/15"
      style={{
        left: `${start * 100}%`,
        width: `${width * 100}%`,
      }}
      aria-hidden="true"
    />
  );
}

function ClipPreviewMarker({ left, label }: { left: number; label: string }) {
  return (
    <div
      className="pointer-events-none absolute top-1/2 z-20 flex h-4 w-4 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full bg-osu-pink text-[8px] font-black text-white shadow-[0_0_0_2px_rgba(255,255,255,0.18)]"
      style={{ left: `${left * 100}%` }}
      aria-hidden="true"
    >
      {label}
    </div>
  );
}

function formatReplayMs(ms: number): string {
  const safe = Math.max(0, ms);
  const mins = Math.floor(safe / 60000);
  const secs = String(Math.floor((safe % 60000) / 1000)).padStart(2, "0");
  return `${mins}:${secs}`;
}
