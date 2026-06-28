import { useEffect, useState } from "react";
import { Check, Copy } from "lucide-react";
import { avatarImageSrc } from "#/components/ui/Avatar";
import { formatDate } from "#/lib/format";
import { getDisplayedAccuracy, getScoreTimestamp, isLazerScore } from "#/lib/score";
import type { ManiaBeatmap } from "#/lib/beatmap-parser";
import type { ServerReplay } from "#/lib/replay-types";
import type { OsuScore } from "#/lib/types";

// Avatar + banner resolved from the replay's player so the info bar carries the
// player's identity instead of a bare name. Seeded from the score's embedded
// user, then enriched with the profile cover once it loads.
export interface ReplayPlayerProfile {
  id: number | null;
  username: string;
  avatarUrl?: string;
  coverUrl?: string;
}

interface ReplayInfoProps {
  replay: ServerReplay;
  score: OsuScore | null;
  beatmap: ManiaBeatmap | null;
  fallbackBeatmapsetId?: number;
  shareUrl?: string;
  playerProfile?: ReplayPlayerProfile | null;
  onClear: () => void;
}

export function ReplayInfo({ replay, score, beatmap, fallbackBeatmapsetId, shareUrl, playerProfile, onClear }: ReplayInfoProps) {
  const h = replay.header;
  const totalHits = h.countGeki + h.count300 + h.countKatu + h.count100 + h.count50;
  const accuracy = score
    ? getDisplayedAccuracy(score) * 100
    : totalHits + h.countMiss > 0
      ? ((h.countGeki * 6 + h.count300 * 6 + h.countKatu * 4 + h.count100 * 2 + h.count50) / ((totalHits + h.countMiss) * 6) * 100)
      : 0;
  const beatmapsetId = score?.beatmapset?.id ?? fallbackBeatmapsetId;
  const beatmapId = score?.beatmap?.id;
  const mapUrl = beatmapsetId ? `https://osu.ppy.sh/beatmapsets/${beatmapsetId}${beatmapId ? `#mania/${beatmapId}` : ""}` : null;
  const clientLabel = score
    ? (isLazerScore(score) ? "Lazer" : "Stable")
    : getReplayHeaderClientLabel(h.gameVersion);
  const playedAt = score ? getScoreTimestamp(score) : "";
  const playedDate = playedAt ? formatDate(playedAt) : null;
  const displayName = playerProfile?.username?.trim() || h.playerName;
  const avatarSrc = avatarImageSrc(playerProfile?.avatarUrl, playerProfile?.id ?? undefined);
  const playerCoverUrl = playerProfile?.coverUrl;
  // Slim cover is osu!'s thin banner crop (the others are tall covers or small
  // thumbnails), so it matches this header strip and the player banner's aspect.
  const beatmapCoverUrl = beatmapsetId
    ? `https://assets.ppy.sh/beatmaps/${beatmapsetId}/covers/slimcover@2x.jpg`
    : undefined;
  // Over a banner the muted label washes out, so brighten it and outline both
  // label + name with a shadow. Without a banner keep the plain muted look that
  // matches the other stat labels.
  const playerLabelClass = playerCoverUrl
    ? "text-white/80 [text-shadow:0_1px_3px_rgba(0,0,0,0.95)]"
    : "text-osu-f1";
  const playerNameShadow = playerCoverUrl ? " [text-shadow:0_1px_3px_rgba(0,0,0,0.85)]" : "";
  // The map title now sits over the beatmap's slim cover when one exists, so brighten
  // its label and shadow the text the same way the player side does over its banner.
  const mapLabelClass = beatmapCoverUrl
    ? "text-white/80 [text-shadow:0_1px_3px_rgba(0,0,0,0.95)]"
    : "text-osu-f1";
  const mapTextShadow = beatmapCoverUrl ? " [text-shadow:0_1px_3px_rgba(0,0,0,0.85)]" : "";

  return (
    <>
      <div className="sm:hidden relative overflow-hidden bg-osu-b4 rounded-xl p-3 mb-3 border border-osu-b3/20">
        <div className="flex items-start gap-3">
          <div className="min-w-0 flex-1">
            <div className="relative flex items-center gap-2">
              <BeatmapBanner coverUrl={beatmapCoverUrl} fade={BEATMAP_BANNER_FADE_COMPACT} />
              <div className="relative -mt-3 -ml-3 pt-3 pl-3 pb-1.5 pr-12 min-w-0">
                <PlayerBanner coverUrl={playerCoverUrl} />
                <div className="relative flex items-center gap-2 min-w-0">
                  <PlayerAvatar src={avatarSrc} name={displayName} size={32} />
                  <div className="min-w-0">
                    <div className={`text-[8px] uppercase tracking-wider ${playerLabelClass}`}>Player</div>
                    <div className={`truncate text-sm font-bold text-white${playerNameShadow}`}>{displayName}</div>
                  </div>
                </div>
              </div>
              <div className="relative h-7 w-px bg-osu-b3/40" />
              <div className="relative min-w-0 flex-1">
                <div className={`text-[8px] uppercase tracking-wider ${mapLabelClass}`}>Map</div>
                {beatmap ? (
                  mapUrl ? (
                    <a href={mapUrl} target="_blank" rel="noopener noreferrer" className={`block truncate text-xs font-semibold text-osu-l2${mapTextShadow}`} title={`${beatmap.title} [${beatmap.version}]`}>
                      {beatmap.title} [{beatmap.version}]
                    </a>
                  ) : (
                    <div className={`truncate text-xs font-semibold text-osu-l2${mapTextShadow}`} title={`${beatmap.title} [${beatmap.version}]`}>{beatmap.title} [{beatmap.version}]</div>
                  )
                ) : (
                  <div className="truncate text-xs font-semibold text-osu-l2">Replay loaded</div>
                )}
              </div>
            </div>
          </div>
          <div className="flex shrink-0 items-center gap-1.5">
            {shareUrl && <ShareReplayButton shareUrl={shareUrl} compact />}
            <button onClick={onClear} className="px-3 py-1.5 rounded-lg bg-osu-b3/50 text-xs text-osu-f1 hover:text-white hover:bg-osu-b2 transition-colors cursor-pointer">Back</button>
          </div>
        </div>

        <div className="mt-3 grid grid-cols-4 gap-1.5">
          <MobileReplayStat label="Keys" value={`${replay.keyCount}K`} valueClassName="text-osu-yellow" compact />
          <MobileReplayStat label="Acc" value={`${accuracy.toFixed(2)}%`} compact />
          <MobileReplayStat label="Score" value={h.totalScore.toLocaleString()} compact />
          <MobileReplayStat label="Combo" value={`${h.maxCombo}x`} compact />
        </div>
        {(clientLabel || playedDate) && (
          <div className="mt-1.5 grid grid-cols-2 gap-1.5">
            {clientLabel && <MobileReplayStat label="Client" value={clientLabel} valueClassName={clientLabel === "Stable" ? "text-osu-pink-light" : "text-osu-l2"} compact />}
            {playedDate && <MobileReplayStat label="Played" value={playedDate} compact />}
          </div>
        )}
        <div className="mt-2 grid grid-cols-[minmax(0,1fr)_auto] items-center gap-3 rounded-lg bg-osu-b5/55 px-3 py-2.5">
          <div className="min-w-0">
            <div className="mb-1 text-[8px] uppercase tracking-wider text-osu-f1">Judgments</div>
            <div className="grid grid-cols-6 gap-1.5 text-center text-[11px] font-bold tabular-nums">
              <span className="rounded bg-osu-b4/70 px-1 py-1 text-osu-yellow">{h.countGeki}</span>
              <span className="rounded bg-osu-b4/70 px-1 py-1 text-osu-blue">{h.count300}</span>
              <span className="rounded bg-osu-b4/70 px-1 py-1 text-osu-green-light">{h.countKatu}</span>
              <span className="rounded bg-osu-b4/70 px-1 py-1 text-osu-green">{h.count100}</span>
              <span className="rounded bg-osu-b4/70 px-1 py-1 text-osu-orange">{h.count50}</span>
              <span className="rounded bg-osu-b4/70 px-1 py-1 text-osu-red-light">{h.countMiss}</span>
            </div>
          </div>
          {beatmap && (
            <div className="shrink-0 text-right">
              <div className="text-[8px] uppercase tracking-wider text-osu-f1">Notes</div>
              <div className="text-xs font-bold text-osu-f1">{beatmap.notes.length.toLocaleString()}</div>
            </div>
          )}
        </div>
      </div>

      <div className="hidden sm:block relative overflow-hidden bg-osu-b4 rounded-xl p-4 mb-4 border border-osu-b3/20">
        <div className="grid grid-cols-[minmax(56px,max-content)_minmax(0,1fr)_auto] lg:grid-cols-[minmax(64px,max-content)_minmax(160px,1fr)_auto_auto] items-center gap-x-4 sm:gap-x-6 gap-y-2">
          <div className="relative -my-4 -ml-4 py-4 pl-4 pr-14 min-w-0">
            <PlayerBanner coverUrl={playerCoverUrl} />
            <div className="relative flex items-center gap-2.5 min-w-0">
              <PlayerAvatar src={avatarSrc} name={displayName} size={36} />
              <div className="min-w-0"><div className={`text-[9px] uppercase tracking-wider ${playerLabelClass}`}>Player</div><div className={`text-sm font-bold text-white truncate${playerNameShadow}`}>{displayName}</div></div>
            </div>
          </div>
          {beatmap && (
            <div className="relative self-stretch -my-4 py-4 flex flex-col justify-center min-w-0">
              <BeatmapBanner coverUrl={beatmapCoverUrl} fade={BEATMAP_BANNER_FADE_MAP} className="absolute inset-y-0 -left-20 right-0" />
              <div className="relative">
                <div className={`text-[9px] uppercase tracking-wider ${mapLabelClass}`}>Map</div>
                {mapUrl ? (
                  <a href={mapUrl} target="_blank" rel="noopener noreferrer" className={`block truncate text-sm font-medium text-osu-l2 hover:text-osu-pink-light transition-colors${mapTextShadow}`} title={`${beatmap.title} [${beatmap.version}]`}>
                    {beatmap.title} [{beatmap.version}]
                  </a>
                ) : (
                  <div className={`truncate text-sm font-medium text-osu-l2${mapTextShadow}`} title={`${beatmap.title} [${beatmap.version}]`}>{beatmap.title} [{beatmap.version}]</div>
                )}
              </div>
            </div>
          )}
          <div className="col-span-1 lg:col-span-1 flex flex-wrap items-center justify-end gap-x-4 sm:gap-x-6 gap-y-2 min-w-0">
            <div><div className="text-[9px] uppercase tracking-wider text-osu-f1">Keys</div><div className="text-sm font-bold text-osu-yellow">{replay.keyCount}K</div></div>
            <div><div className="text-[9px] uppercase tracking-wider text-osu-f1">Accuracy</div><div className="text-sm font-bold text-white">{accuracy.toFixed(2)}%</div></div>
            <div><div className="text-[9px] uppercase tracking-wider text-osu-f1">Score</div><div className="text-sm font-bold text-white">{h.totalScore.toLocaleString()}</div></div>
            <div><div className="text-[9px] uppercase tracking-wider text-osu-f1">Combo</div><div className="text-sm font-bold text-white">{h.maxCombo}x</div></div>
            {clientLabel && <div><div className="text-[9px] uppercase tracking-wider text-osu-f1">Client</div><div className={`text-sm font-bold ${clientLabel === "Stable" ? "text-osu-pink-light" : "text-osu-l2"}`}>{clientLabel}</div></div>}
            {playedDate && <div><div className="text-[9px] uppercase tracking-wider text-osu-f1">Played</div><div className="text-sm font-bold text-white">{playedDate}</div></div>}
            <div>
              <div className="text-[9px] uppercase tracking-wider text-osu-f1">Judgments</div>
              <div className="text-xs text-osu-f1">
                <span className="text-osu-yellow">{h.countGeki}</span>/<span className="text-osu-blue">{h.count300}</span>/<span className="text-osu-green-light">{h.countKatu}</span>/<span className="text-osu-green">{h.count100}</span>/<span className="text-osu-orange">{h.count50}</span>/<span className="text-osu-red-light">{h.countMiss}</span>
              </div>
            </div>
            {beatmap && <div><div className="text-[9px] uppercase tracking-wider text-osu-f1">Notes</div><div className="text-sm font-bold text-osu-f1">{beatmap.notes.length.toLocaleString()}</div></div>}
          </div>
          <div className="justify-self-end flex items-center gap-2">
            {shareUrl && <ShareReplayButton shareUrl={shareUrl} />}
            <button onClick={onClear} className="px-3 py-1.5 rounded-lg bg-osu-b3/50 text-xs text-osu-f1 hover:text-white hover:bg-osu-b2 transition-colors cursor-pointer">Back</button>
          </div>
        </div>
      </div>
    </>
  );
}

// Sits behind the player avatar + name only: bleeds to the card's left/top/bottom
// edges (the parent uses negative margins) and dissolves to the right via a mask
// so it blends back into the bar instead of ending on a hard edge.
const PLAYER_BANNER_FADE = "linear-gradient(to right, #000 0%, #000 40%, transparent 90%)";

function PlayerBanner({ coverUrl }: { coverUrl?: string }) {
  if (!coverUrl) return null;
  return (
    <div
      className="pointer-events-none absolute inset-0"
      style={{ maskImage: PLAYER_BANNER_FADE, WebkitMaskImage: PLAYER_BANNER_FADE }}
      aria-hidden="true"
    >
      <div
        className="absolute inset-0 bg-cover bg-center opacity-60"
        style={{ backgroundImage: `url(${coverUrl})` }}
      />
      <div className="absolute inset-0 bg-osu-b4/30" />
    </div>
  );
}

// Beatmap cover, mirrored against the player banner. On desktop it's scoped to the map
// column (bled left to meet the player cover's fade) so it physically can't reach the
// stat columns at any width; the mask dissolves it in from that seam and back out
// before the column's right edge. The compact variant fills the mobile top row, which
// has no stats beside it.
// Front-loaded fade-in (already ~half strength a fifth of the way across) so the cover
// catches the player banner mid-dissolve and fills the seam instead of dipping dark.
const BEATMAP_BANNER_FADE_MAP = "linear-gradient(to right, transparent 0%, rgba(0,0,0,0.55) 22%, #000 46%, #000 82%, transparent 100%)";
const BEATMAP_BANNER_FADE_COMPACT = "linear-gradient(to right, transparent 18%, #000 44%, #000 82%, transparent 100%)";

function BeatmapBanner({ coverUrl, fade, className = "absolute inset-0" }: { coverUrl?: string; fade: string; className?: string }) {
  if (!coverUrl) return null;
  return (
    <div
      className={`pointer-events-none ${className}`}
      style={{ maskImage: fade, WebkitMaskImage: fade }}
      aria-hidden="true"
    >
      <div
        className="absolute inset-0 bg-cover bg-center opacity-50"
        style={{ backgroundImage: `url(${coverUrl})` }}
      />
      <div className="absolute inset-0 bg-osu-b4/30" />
    </div>
  );
}

function PlayerAvatar({ src, name, size }: { src?: string; name: string; size: number }) {
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    setFailed(false);
  }, [src]);

  if (src && !failed) {
    return (
      <img
        src={src}
        alt=""
        width={size}
        height={size}
        className="flex-shrink-0 rounded-full object-cover ring-2 ring-white/10"
        style={{ width: size, height: size }}
        loading="lazy"
        onError={() => setFailed(true)}
      />
    );
  }

  return (
    <div
      className="flex flex-shrink-0 items-center justify-center rounded-full bg-osu-b6 font-bold text-osu-f1 ring-2 ring-white/10"
      style={{ width: size, height: size, fontSize: Math.round(size * 0.42) }}
      aria-hidden="true"
    >
      {name.trim().charAt(0).toUpperCase() || "?"}
    </div>
  );
}

function getReplayHeaderClientLabel(gameVersion: number | undefined): "Lazer" | "Stable" | null {
  if (!gameVersion) return null;
  return gameVersion >= 30_000_000 ? "Lazer" : "Stable";
}

function ShareReplayButton({ shareUrl, compact = false }: { shareUrl: string; compact?: boolean }) {
  const [copied, setCopied] = useState(false);

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(shareUrl);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1400);
    } catch {
      setCopied(false);
    }
  };

  const Icon = copied ? Check : Copy;
  return (
    <button
      type="button"
      onClick={handleCopy}
      className={`inline-flex items-center gap-1.5 rounded-lg bg-osu-pink/20 font-semibold text-osu-pink-light transition-colors cursor-pointer hover:bg-osu-pink/30 hover:text-white ${compact ? "px-2.5 py-1.5 text-[11px]" : "px-3 py-1.5 text-xs"}`}
      title={shareUrl}
    >
      <Icon className="h-3.5 w-3.5" aria-hidden="true" />
      {copied ? "Copied" : "Copy Link"}
    </button>
  );
}

function MobileReplayStat({ label, value, valueClassName = "text-white", compact = false }: { label: string; value: string; valueClassName?: string; compact?: boolean }) {
  return (
    <div className={`min-w-0 rounded-lg bg-osu-b5/55 text-center ${compact ? "px-1 py-1.5" : "px-2 py-2"}`}>
      <div className="text-[8px] uppercase tracking-wider text-osu-f1">{label}</div>
      <div className={`truncate text-xs font-bold tabular-nums ${valueClassName}`}>{value}</div>
    </div>
  );
}
