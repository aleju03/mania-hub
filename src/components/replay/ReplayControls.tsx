import { useEffect, useState } from "react";
import type { MutableRefObject, ReactNode } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { Settings } from "lucide-react";

import type { ReplayRendererLike } from "#/lib/replay-types";

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
  inputOverlayColor: string;
  skinSettingsOpen: boolean;
  scrollSpeed: number;
  bgDim: number;
  onTogglePlay: () => void;
  onSetSpeed: (speed: number) => void;
  onToggleAudio: () => void;
  onSetVolume: (volume: number) => void;
  onToggleInputOverlay: () => void;
  onToggleInputOverlayOnly: () => void;
  onSetInputOverlayColor: (color: string) => void;
  onOpenSkinSettings: () => void;
  onSetScrollSpeed: (speed: number) => void;
  onSetBgDim: (dim: number) => void;
  onPointerDown: () => void;
  onPointerUp: () => void;
  onSeek: (timeMs: number) => void;
  onContextMenu: (timeMsGame: number, clientX: number, clientY: number) => void;
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
  inputOverlayColor,
  skinSettingsOpen,
  scrollSpeed,
  bgDim,
  onTogglePlay,
  onSetSpeed,
  onToggleAudio,
  onSetVolume,
  onToggleInputOverlay,
  onToggleInputOverlayOnly,
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
  const sliderClass = "h-1 appearance-none bg-osu-b3 rounded-full cursor-pointer [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:w-2.5 [&::-webkit-slider-thumb]:h-2.5 [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-osu-pink";

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

  return (
    <div className="bg-osu-b4 rounded-xl border border-osu-b3/20">
      {audioError && (
        <div className="text-[11px] text-osu-yellow bg-osu-yellow/10 border-b border-osu-yellow/20 px-4 py-2 rounded-t-xl">
          {audioError}
        </div>
      )}

      <ReplayProgressBar
        rendererRef={rendererRef}
        heatmap={heatmap}
        sliderClass=""
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

        <button
          onClick={onToggleInputOverlay}
          className={`px-2.5 py-1 rounded text-[10px] font-semibold cursor-pointer transition-colors ${
            showInputOverlay ? "bg-osu-pink text-white" : "bg-osu-b3/50 text-osu-f1 hover:text-white hover:bg-osu-b3"
          }`}
        >
          Input
        </button>
        {showInputOverlay ? (
          <>
            <button
              onClick={onToggleInputOverlayOnly}
              className={`px-2.5 py-1 rounded text-[10px] font-semibold cursor-pointer transition-colors ${
                inputOverlayOnly ? "bg-osu-pink text-white" : "bg-osu-b3/50 text-osu-f1 hover:text-white hover:bg-osu-b3"
              }`}
            >
              Only
            </button>
            <label className="relative h-6 w-6 cursor-pointer overflow-hidden rounded border border-osu-b3/60 bg-osu-b3/50" title="Input overlay color">
              <span className="absolute inset-1 rounded" style={{ backgroundColor: inputOverlayColor }} />
              <input
                type="color"
                value={inputOverlayColor}
                onChange={(e) => onSetInputOverlayColor(e.target.value)}
                className="absolute inset-0 cursor-pointer opacity-0"
                aria-label="Input overlay color"
              />
            </label>
          </>
        ) : null}

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

function ReplayProgressBar({
  rendererRef,
  heatmap,
  sliderClass,
  onPointerDown,
  onPointerUp,
  onSeek,
  onContextMenu,
  children,
}: {
  rendererRef: MutableRefObject<ReplayRendererLike | null>;
  heatmap: number[];
  sliderClass: string;
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
      className="group relative flex items-center gap-3 px-4 pt-3 pb-1"
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

function formatReplayMs(ms: number): string {
  const safe = Math.max(0, ms);
  const mins = Math.floor(safe / 60000);
  const secs = String(Math.floor((safe % 60000) / 1000)).padStart(2, "0");
  return `${mins}:${secs}`;
}
