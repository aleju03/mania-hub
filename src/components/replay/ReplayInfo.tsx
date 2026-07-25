import { useEffect, useMemo, useState } from "react";
import { ArrowLeftRight, Check, Copy } from "lucide-react";
import { StarRatingBadge } from "#/components/maps/SearchCard";
import { ReplayCompareEntry } from "#/components/replay/ReplayCompareView";
import { avatarImageSrc } from "#/components/ui/Avatar";
import { ModBadge } from "#/components/ui/ModBadge";
import { formatDate } from "#/lib/format";
import { beatmapStatusAwardsPp, getDisplayedAccuracy, getModDisplayList, getScoreRate, getScoreTimestamp, isLazerScore, scoreUsesLazerScoring } from "#/lib/score";
import { computeManiaRulesetWhatIf } from "#/lib/replay-what-if";
import type { ManiaBeatmap } from "#/lib/beatmap-parser";
import type { ServerReplay } from "#/lib/replay-types";
import type { OsuMod, OsuScore } from "#/lib/types";

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
  /** Mod-adjusted star rating (rate mods applied); null while unknown. */
  stars?: number | null;
  /** The play's mods (from the API score, or the parsed replay for uploads). */
  mods?: OsuMod[];
  fallbackBeatmapsetId?: number;
  shareUrl?: string;
  playerProfile?: ReplayPlayerProfile | null;
  /** Effective judging ruleset while the Client what-if toggle is in play. */
  judgeAsLazer?: boolean;
  /** Enables the Client stat's stable/lazer toggle. */
  onSelectClient?: (lazer: boolean) => void;
  /** Already-loaded leaderboard scores for the compare picker (never fetched here). */
  compareCandidates?: OsuScore[];
  onClear: () => void;
  /** When set, the card grows a compare action that reveals a paste-a-score form. */
  onCompare?: (otherScoreId: number) => void;
}

export function ReplayInfo({ replay, score, beatmap, stars, mods, fallbackBeatmapsetId, shareUrl, playerProfile, judgeAsLazer, onSelectClient, compareCandidates, onClear, onCompare }: ReplayInfoProps) {
  const [compareOpen, setCompareOpen] = useState(false);
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
  const displayMods = getModDisplayList(mods);
  const compareEntry = onCompare && compareOpen ? (
    <ReplayCompareEntry
      onCompare={onCompare}
      onClose={() => setCompareOpen(false)}
      candidates={compareCandidates}
      requiredRate={getScoreRate(mods)}
    />
  ) : null;

  // Client what-if: flipping the Client stat re-judges the same keypresses
  // under the other ruleset. The stats below mirror what the viewer is now
  // playing; score and combo can't be simulated and stay from the real play.
  const sourceIsLazer = scoreUsesLazerScoring(score);
  const canToggleClient = Boolean(onSelectClient && beatmap && beatmap.notes.length > 0 && replay.frames.length > 0);
  const judgingIsLazer = canToggleClient ? judgeAsLazer ?? sourceIsLazer : sourceIsLazer;
  const simActive = canToggleClient && judgingIsLazer !== sourceIsLazer;
  const sim = useMemo(() => {
    if (!simActive || !beatmap) return null;
    return computeManiaRulesetWhatIf({
      frames: replay.frames,
      notes: beatmap.notes,
      keyCount: replay.keyCount,
      mods,
      timingPoints: beatmap.timingPoints,
      od: beatmap.od,
      isConvert: (score?.beatmap?.convert ?? false) || (beatmap.isConvert ?? false),
      sourceIsLazer,
      modRate: getScoreRate(mods),
    });
  }, [simActive, replay, beatmap, score, mods, sourceIsLazer]);

  const shownAccuracy = simActive && sim ? sim.accuracy : accuracy;
  const shownCounts = simActive && sim
    ? { geki: sim.counts[1], c300: sim.counts[2], katu: sim.counts[3], c100: sim.counts[4], c50: sim.counts[5], miss: sim.counts[6] }
    : { geki: h.countGeki, c300: h.count300, katu: h.countKatu, c100: h.count100, c50: h.count50, miss: h.countMiss };
  const actualPp = score?.pp ?? null;
  // Unranked maps award no pp, so a locally computed value would be fiction.
  const mapAwardsPp = beatmapStatusAwardsPp(score?.beatmap?.status);
  const shownPp = mapAwardsPp ? (simActive && sim ? sim.pp : actualPp) : null;
  const ppDelta = simActive && sim && actualPp != null ? sim.pp - actualPp : null;
  const accDelta = simActive && sim ? sim.accuracy - accuracy : null;
  // Score and combo come from the real play and can't be re-simulated.
  const realOnlyDim = simActive ? " opacity-40" : "";

  return (
    <>
      <div className="sm:hidden relative overflow-hidden bg-osu-b4 rounded-xl p-3 border border-osu-b3/20">
        <div className="flex items-start gap-3">
          <div className="min-w-0 flex-1">
            <div className="relative flex items-center gap-2">
              <BeatmapBanner coverUrl={beatmapCoverUrl} fade={BEATMAP_BANNER_FADE_COMPACT} className="absolute -top-3 bottom-0 left-0 right-0" />
              {/* Symmetric padding (the top pair cancels via the negative margin,
                  nothing extra below) keeps this block's content centered like the
                  map column, so the two label/value pairs sit on the same lines. */}
              <div className="relative -mt-3 -ml-3 pt-3 pl-3 pr-6 min-w-0">
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
                {/* h-5 matches the player name's text-sm line box so both value
                    rows share a centerline. */}
                <div className="flex h-5 items-center gap-1.5 min-w-0">
                  {beatmap ? (
                    mapUrl ? (
                      <a href={mapUrl} target="_blank" rel="noopener noreferrer" className={`min-w-0 truncate text-xs font-semibold text-osu-l2${mapTextShadow}`} title={`${beatmap.title} [${beatmap.version}]`}>
                        {beatmap.title} [{beatmap.version}]
                      </a>
                    ) : (
                      <div className={`min-w-0 truncate text-xs font-semibold text-osu-l2${mapTextShadow}`} title={`${beatmap.title} [${beatmap.version}]`}>{beatmap.title} [{beatmap.version}]</div>
                    )
                  ) : (
                    <div className="min-w-0 truncate text-xs font-semibold text-osu-l2">Replay loaded</div>
                  )}
                  {stars != null && <StarRatingBadge stars={stars} className="shrink-0" />}
                  {displayMods.length > 0 && (
                    <div className="flex shrink-0 items-center gap-0.5">
                      {displayMods.map((mod, index) => (
                        <ModBadge key={`${mod.acronym}-${index}`} mod={mod.acronym} rate={mod.rate} size={0.55} />
                      ))}
                    </div>
                  )}
                </div>
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
          <MobileReplayStat label="Acc" value={`${shownAccuracy.toFixed(2)}%`} compact />
          <MobileReplayStat label="Score" value={h.totalScore.toLocaleString()} valueClassName={`text-white${realOnlyDim}`} compact />
          <MobileReplayStat label="Combo" value={`${h.maxCombo}x`} valueClassName={`text-white${realOnlyDim}`} compact />
        </div>
        {(clientLabel || canToggleClient || playedDate || shownPp != null) && (
          <div className={`mt-1.5 grid gap-1.5 ${shownPp != null ? "grid-cols-3" : "grid-cols-2"}`}>
            {canToggleClient && onSelectClient ? (
              <div className="min-w-0 rounded-lg bg-osu-b5/55 px-1 py-1.5 text-center">
                <div className="text-[8px] uppercase tracking-wider text-osu-f1">Client</div>
                <ClientToggle compact judgingIsLazer={judgingIsLazer} simActive={simActive} onSelect={onSelectClient} />
              </div>
            ) : clientLabel ? (
              <MobileReplayStat label="Client" value={clientLabel} valueClassName={clientLabel === "Stable" ? "text-osu-pink-light" : "text-osu-l2"} compact />
            ) : null}
            {shownPp != null && (
              <div className="min-w-0 rounded-lg bg-osu-b5/55 px-1 py-1.5 text-center">
                <div className="text-[8px] uppercase tracking-wider text-osu-f1">PP</div>
                <div className="truncate text-xs font-bold tabular-nums text-white">{Math.round(shownPp)}pp<DeltaChip delta={ppDelta} suffix="pp" /></div>
              </div>
            )}
            {playedDate && <MobileReplayStat label="Played" value={playedDate} compact />}
          </div>
        )}
        <div className="mt-2 grid grid-cols-[minmax(0,1fr)_auto] items-center gap-3 rounded-lg bg-osu-b5/55 px-3 py-2.5">
          <div className="min-w-0">
            <div className="mb-1 text-[8px] uppercase tracking-wider text-osu-f1">Judgments</div>
            <div className="grid grid-cols-6 gap-1.5 text-center text-[11px] font-bold tabular-nums">
              <span className="rounded bg-osu-b4/70 px-1 py-1 text-osu-yellow">{shownCounts.geki}</span>
              <span className="rounded bg-osu-b4/70 px-1 py-1 text-osu-blue">{shownCounts.c300}</span>
              <span className="rounded bg-osu-b4/70 px-1 py-1 text-osu-green-light">{shownCounts.katu}</span>
              <span className="rounded bg-osu-b4/70 px-1 py-1 text-osu-green">{shownCounts.c100}</span>
              <span className="rounded bg-osu-b4/70 px-1 py-1 text-osu-orange">{shownCounts.c50}</span>
              <span className="rounded bg-osu-b4/70 px-1 py-1 text-osu-red-light">{shownCounts.miss}</span>
            </div>
          </div>
          {beatmap && (
            <div className="shrink-0 text-right">
              <div className="text-[8px] uppercase tracking-wider text-osu-f1">Notes</div>
              <div className="text-xs font-bold text-osu-f1">{beatmap.notes.length.toLocaleString()}</div>
            </div>
          )}
        </div>
        {/* The header cluster is already tight on phones (an extra icon there
            starves the map title), so mobile gets a slim bottom row instead
            that swaps into the form when tapped. */}
        {onCompare && !compareOpen && (
          <button
            type="button"
            onClick={() => setCompareOpen(true)}
            className="mt-2 flex w-full items-center justify-center gap-1.5 rounded-lg bg-osu-b5/55 px-2.5 py-2 text-[11px] font-semibold text-osu-f1 hover:text-white transition-colors cursor-pointer"
          >
            <ArrowLeftRight className="h-3.5 w-3.5" aria-hidden="true" />
            Compare with another score
          </button>
        )}
        {compareEntry}
      </div>

      <div className="hidden sm:block relative overflow-hidden bg-osu-b4 rounded-xl p-4 mb-4 border border-osu-b3/20">
        {/* Two rows: identity on top (player, full-width map title, actions),
            the stat strip below. The stats used to share the single row and
            starved the map title at most widths. The player cell spans both
            rows so its banner still bleeds to the card's top and bottom
            edges (stopping at the row while the compare form is open); the
            map cell only bleeds upward now that the stats sit under it. */}
        <div className="grid grid-cols-[minmax(64px,max-content)_minmax(0,1fr)_auto] grid-rows-[auto_auto] items-center gap-x-4 sm:gap-x-6 gap-y-2.5">
          <div className={`relative row-span-full self-stretch flex flex-col justify-center ${compareOpen ? "-mt-4 pt-4" : "-my-4 py-4"} -ml-4 pl-4 pr-2 min-w-0`}>
            <PlayerBanner coverUrl={playerCoverUrl} />
            <div className="relative flex items-center gap-2.5 min-w-0">
              <PlayerAvatar src={avatarSrc} name={displayName} size={36} />
              <div className="min-w-0"><div className={`text-[9px] uppercase tracking-wider ${playerLabelClass}`}>Player</div><div className={`text-sm font-bold text-white truncate${playerNameShadow}`}>{displayName}</div></div>
            </div>
          </div>
          {beatmap && (
            <div className="relative col-start-2 row-start-1 self-stretch -mt-4 pt-4 flex flex-col justify-center min-w-0">
              {/* The map column starts 24px further left than it used to (the player
                  block gave up padding), so bleed the cover 24px less to keep its
                  on-screen position unchanged. */}
              <BeatmapBanner coverUrl={beatmapCoverUrl} fade={BEATMAP_BANNER_FADE_MAP} bottomFade={BEATMAP_BANNER_BOTTOM_FADE} className="absolute inset-y-0 -left-14 right-0" />
              <div className="relative">
                <div className={`text-[9px] uppercase tracking-wider ${mapLabelClass}`}>Map</div>
                <div className="flex items-center gap-2 min-w-0">
                  {mapUrl ? (
                    <a href={mapUrl} target="_blank" rel="noopener noreferrer" className={`min-w-0 truncate text-sm font-medium text-osu-l2 hover:text-osu-pink-light transition-colors${mapTextShadow}`} title={`${beatmap.title} [${beatmap.version}]`}>
                      {beatmap.title} [{beatmap.version}]
                    </a>
                  ) : (
                    <div className={`min-w-0 truncate text-sm font-medium text-osu-l2${mapTextShadow}`} title={`${beatmap.title} [${beatmap.version}]`}>{beatmap.title} [{beatmap.version}]</div>
                  )}
                  {stars != null && <StarRatingBadge stars={stars} className="shrink-0" />}
                  {displayMods.length > 0 && (
                    <div className="flex shrink-0 items-center gap-0.5">
                      {displayMods.map((mod, index) => (
                        <ModBadge key={`${mod.acronym}-${index}`} mod={mod.acronym} rate={mod.rate} size={0.75} />
                      ))}
                    </div>
                  )}
                </div>
              </div>
            </div>
          )}
          <div className="col-start-2 col-span-2 row-start-2 flex flex-wrap items-center gap-x-4 sm:gap-x-6 gap-y-2 min-w-0">
            <div><div className="text-[9px] uppercase tracking-wider text-osu-f1">Keys</div><div className="text-sm font-bold text-osu-yellow">{replay.keyCount}K</div></div>
            <div><div className="text-[9px] uppercase tracking-wider text-osu-f1">Accuracy</div><div className="text-sm font-bold text-white">{shownAccuracy.toFixed(2)}%<DeltaChip delta={accDelta} suffix="%" decimals={2} /></div></div>
            {shownPp != null && <div><div className="text-[9px] uppercase tracking-wider text-osu-f1">PP</div><div className="text-sm font-bold text-white">{Math.round(shownPp)}pp<DeltaChip delta={ppDelta} suffix="pp" /></div></div>}
            <div title={simActive ? "From the real play (not simulated)" : undefined}><div className="text-[9px] uppercase tracking-wider text-osu-f1">Score</div><div className={`text-sm font-bold text-white${realOnlyDim}`}>{h.totalScore.toLocaleString()}</div></div>
            <div title={simActive ? "From the real play (not simulated)" : undefined}><div className="text-[9px] uppercase tracking-wider text-osu-f1">Combo</div><div className={`text-sm font-bold text-white${realOnlyDim}`}>{h.maxCombo}x</div></div>
            {canToggleClient && onSelectClient ? (
              <div><div className="text-[9px] uppercase tracking-wider text-osu-f1">Client</div><ClientToggle judgingIsLazer={judgingIsLazer} simActive={simActive} onSelect={onSelectClient} /></div>
            ) : clientLabel ? (
              <div><div className="text-[9px] uppercase tracking-wider text-osu-f1">Client</div><div className={`text-sm font-bold ${clientLabel === "Stable" ? "text-osu-pink-light" : "text-osu-l2"}`}>{clientLabel}</div></div>
            ) : null}
            {playedDate && <div><div className="text-[9px] uppercase tracking-wider text-osu-f1">Played</div><div className="text-sm font-bold text-white">{playedDate}</div></div>}
            <div>
              <div className="text-[9px] uppercase tracking-wider text-osu-f1">Judgments</div>
              <div className="text-xs text-osu-f1">
                <span className="text-osu-yellow">{shownCounts.geki}</span>/<span className="text-osu-blue">{shownCounts.c300}</span>/<span className="text-osu-green-light">{shownCounts.katu}</span>/<span className="text-osu-green">{shownCounts.c100}</span>/<span className="text-osu-orange">{shownCounts.c50}</span>/<span className="text-osu-red-light">{shownCounts.miss}</span>
              </div>
            </div>
            {beatmap && <div><div className="text-[9px] uppercase tracking-wider text-osu-f1">Notes</div><div className="text-sm font-bold text-osu-f1">{beatmap.notes.length.toLocaleString()}</div></div>}
          </div>
          <div className="col-start-3 row-start-1 justify-self-end flex items-center gap-2">
            {onCompare && <CompareToggleButton open={compareOpen} onToggle={() => setCompareOpen((open) => !open)} />}
            {shareUrl && <ShareReplayButton shareUrl={shareUrl} />}
            <button onClick={onClear} className="px-3 py-1.5 rounded-lg bg-osu-b3/50 text-xs text-osu-f1 hover:text-white hover:bg-osu-b2 transition-colors cursor-pointer">Back</button>
          </div>
        </div>
        {compareEntry}
      </div>
    </>
  );
}

// The Client stat doubles as the "what if this was played on the other
// client?" switch: it shows the ruleset currently judging the replay and one
// click flips it. Same footprint as the old static label plus a small swap
// glyph; the explanation lives in the tooltip instead of a caption row.
function ClientToggle({ judgingIsLazer, simActive, onSelect, compact = false }: {
  judgingIsLazer: boolean;
  simActive: boolean;
  onSelect: (lazer: boolean) => void;
  compact?: boolean;
}) {
  const otherLabel = judgingIsLazer ? "stable" : "lazer";
  const title = simActive
    ? `Simulated from the replay's keypresses; score and combo still show the real play. Click to judge with ${otherLabel} rules again.`
    : `See this play judged with ${otherLabel} windows and LN rules`;
  return (
    <button
      type="button"
      onClick={() => onSelect(!judgingIsLazer)}
      title={title}
      aria-pressed={simActive}
      className={`group flex items-center gap-1 font-bold transition-colors cursor-pointer ${
        compact ? "mx-auto text-xs" : "text-sm"
      } ${judgingIsLazer ? "text-osu-l2" : "text-osu-pink-light"}`}
    >
      {judgingIsLazer ? "Lazer" : "Stable"}
      <ArrowLeftRight
        className={`${compact ? "h-3 w-3" : "h-3.5 w-3.5"} transition-colors ${
          simActive ? "text-osu-pink-light" : "text-osu-f1/50 group-hover:text-white"
        }`}
        aria-hidden="true"
      />
    </button>
  );
}

function DeltaChip({ delta, suffix, decimals = 0 }: { delta: number | null; suffix: string; decimals?: number }) {
  if (delta == null) return null;
  const formatted = Math.abs(delta).toFixed(decimals);
  if (Number(formatted) <= 0) return null;
  const positive = delta > 0;
  return (
    <span className={`ml-1 text-[10px] font-semibold ${positive ? "text-osu-green-light" : "text-osu-red-light"}`}>
      {positive ? "+" : "-"}{formatted}{suffix}
    </span>
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
// The desktop map cover only spans the identity row now, so its bottom edge
// lands mid-card; without a vertical dissolve it reads as a hard straight
// line crossing the player banner's fade. Nested masks multiply, giving the
// strip a soft bottom in addition to the horizontal fade.
const BEATMAP_BANNER_BOTTOM_FADE = "linear-gradient(to bottom, #000 40%, transparent 98%)";

function BeatmapBanner({ coverUrl, fade, bottomFade, className = "absolute inset-0" }: { coverUrl?: string; fade: string; bottomFade?: string; className?: string }) {
  if (!coverUrl) return null;
  return (
    <div
      className={`pointer-events-none ${className}`}
      style={{ maskImage: fade, WebkitMaskImage: fade }}
      aria-hidden="true"
    >
      <div
        className="absolute inset-0"
        style={bottomFade ? { maskImage: bottomFade, WebkitMaskImage: bottomFade } : undefined}
      >
        <div
          className="absolute inset-0 bg-cover bg-center opacity-50"
          style={{ backgroundImage: `url(${coverUrl})` }}
        />
        <div className="absolute inset-0 bg-osu-b4/30" />
      </div>
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

// Deliberately quiet (muted icon, same treatment as Back): compare is a side
// tool, not a headline action, so it lives in the card's action cluster and
// only expands into a form on demand.
function CompareToggleButton({ open, onToggle }: { open: boolean; onToggle: () => void }) {
  return (
    <button
      type="button"
      onClick={onToggle}
      title="Compare with another score"
      aria-label="Compare with another score"
      aria-expanded={open}
      className={`inline-flex items-center justify-center rounded-lg p-1.5 transition-colors cursor-pointer ${
        open ? "bg-osu-b2 text-white" : "bg-osu-b3/50 text-osu-f1 hover:text-white hover:bg-osu-b2"
      }`}
    >
      <ArrowLeftRight className="h-4 w-4" aria-hidden="true" />
    </button>
  );
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
