import { useEffect, useMemo, useState, type ReactNode } from "react";
import { Link } from "@tanstack/react-router";
import { ArrowLeftRight, Check, Share2 } from "lucide-react";
import { StarRatingBadge } from "#/components/maps/SearchCard";
import { avatarImageSrc } from "#/components/ui/Avatar";
import { ModBadge } from "#/components/ui/ModBadge";
import { formatDate } from "#/lib/format";
import { beatmapStatusAwardsPp, getDisplayedAccuracy, getManiaAccuracyFromCounts, getModDisplayList, getScoreRate, getScoreTimestamp, scoreUsesLazerScoring } from "#/lib/score";
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
  onClear: () => void;
}

export function ReplayInfo({ replay, score, beatmap, stars, mods, fallbackBeatmapsetId, shareUrl, playerProfile, judgeAsLazer, onSelectClient, onClear }: ReplayInfoProps) {
  const h = replay.header;
  // An upload has no API score, so the client comes from the .osr's own version
  // stamp; both the label and everything judged below follow from it.
  const sourceIsLazer = scoreUsesLazerScoring(score, h.gameVersion);
  const accuracy = score
    ? getDisplayedAccuracy(score) * 100
    : getManiaAccuracyFromCounts({
      count_geki: h.countGeki,
      count_300: h.count300,
      count_katu: h.countKatu,
      count_100: h.count100,
      count_50: h.count50,
      count_miss: h.countMiss,
    }, sourceIsLazer) * 100;
  const beatmapsetId = score?.beatmapset?.id ?? fallbackBeatmapsetId;
  const beatmapId = score?.beatmap?.id;
  const mapUrl = beatmapsetId ? `https://osu.ppy.sh/beatmapsets/${beatmapsetId}${beatmapId ? `#mania/${beatmapId}` : ""}` : null;
  // Nothing to claim when there is neither a score nor a version stamp.
  const clientLabel = score || h.gameVersion ? (sourceIsLazer ? "Lazer" : "Stable") : null;
  const playedAt = score ? getScoreTimestamp(score) : "";
  const playedDate = playedAt ? formatDate(playedAt) : null;
  const displayName = playerProfile?.username?.trim() || h.playerName;
  // Only a name that came from the profile is a real osu! account: an upload's
  // header name is whatever the client wrote and would link to a dead page.
  const playerPageUsername = playerProfile?.username?.trim() || null;
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

  // Client what-if: flipping the Client stat re-judges the same keypresses
  // under the other ruleset. The stats below mirror what the viewer is now
  // playing; score and combo can't be simulated and stay from the real play.
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
      {/* Desktop dresses in the viewer's near-black chrome as a full-bleed
          strip welded to the stage. Phones keep a rounded card in the site
          palette: it scrolls with the page, and the near-black base read as
          a black hole against the regular background. */}
      <div className="sm:hidden relative overflow-hidden rounded-xl border border-white/10 bg-osu-b4/70 p-3">
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
                    <PlayerName
                      username={playerPageUsername}
                      className={`truncate text-sm font-bold text-white${playerNameShadow}`}
                    >
                      {displayName}
                    </PlayerName>
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
            <BackButton onClear={onClear} />
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
              <div className="min-w-0 rounded-lg bg-white/5 px-1 py-1.5 text-center">
                <div className="text-[8px] uppercase tracking-wider text-osu-f1">Client</div>
                <ClientToggle compact judgingIsLazer={judgingIsLazer} simActive={simActive} onSelect={onSelectClient} />
              </div>
            ) : clientLabel ? (
              <MobileReplayStat label="Client" value={clientLabel} valueClassName={clientLabel === "Stable" ? "text-osu-pink-light" : "text-osu-l2"} compact />
            ) : null}
            {shownPp != null && (
              <div className="min-w-0 rounded-lg bg-white/5 px-1 py-1.5 text-center">
                <div className="text-[8px] uppercase tracking-wider text-osu-f1">PP</div>
                <div className="truncate text-xs font-bold tabular-nums text-white">{Math.round(shownPp)}pp<DeltaChip delta={ppDelta} suffix="pp" /></div>
              </div>
            )}
            {playedDate && <MobileReplayStat label="Played" value={playedDate} compact />}
          </div>
        )}
        <div className="mt-2 grid grid-cols-[minmax(0,1fr)_auto] items-center gap-3 rounded-lg bg-white/5 px-3 py-2.5">
          <div className="min-w-0">
            <div className="mb-1 text-[8px] uppercase tracking-wider text-osu-f1">Judgments</div>
            <div className="grid grid-cols-6 gap-1.5 text-center text-[11px] font-bold tabular-nums">
              <span className="rounded bg-white/10 px-1 py-1 text-osu-yellow">{shownCounts.geki}</span>
              <span className="rounded bg-white/10 px-1 py-1 text-osu-blue">{shownCounts.c300}</span>
              <span className="rounded bg-white/10 px-1 py-1 text-osu-green-light">{shownCounts.katu}</span>
              <span className="rounded bg-white/10 px-1 py-1 text-osu-green">{shownCounts.c100}</span>
              <span className="rounded bg-white/10 px-1 py-1 text-osu-orange">{shownCounts.c50}</span>
              <span className="rounded bg-white/10 px-1 py-1 text-osu-red-light">{shownCounts.miss}</span>
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

      {/* Desktop: a full-bleed footer strip welded to the stage, the map's
          cover art running behind the whole thing like the client's song
          bar. One row: player identity, then the map title with the stats
          under it, actions on the right. */}
      <div className="hidden sm:block relative overflow-hidden border-t border-white/10 bg-[#08080d]">
        {beatmapCoverUrl && (
          <div className="pointer-events-none absolute inset-0" aria-hidden="true">
            <div
              className="absolute inset-0 bg-cover bg-center opacity-60"
              style={{ backgroundImage: `url(${beatmapCoverUrl})` }}
            />
            {/* Edges settle into the page background so content stays
                readable; the art breathes through the middle. */}
            <div className="absolute inset-0 bg-gradient-to-r from-[#08080d]/65 via-[#08080d]/35 to-[#08080d]/65" />
            <div className="absolute inset-0 bg-gradient-to-t from-[#08080d]/70 via-transparent to-[#08080d]/30" />
          </div>
        )}
        <div className="relative mx-auto flex max-w-[1400px] items-center gap-6 px-6 py-4">
          <div className="flex min-w-0 shrink-0 items-center gap-3">
            <PlayerAvatar src={avatarSrc} name={displayName} size={46} />
            <div className="min-w-0">
              <div className="text-[9px] uppercase tracking-[0.16em] text-white/50">Player</div>
              <PlayerName
                username={playerPageUsername}
                className="max-w-[180px] truncate text-[15px] font-bold text-white [text-shadow:0_1px_3px_rgba(0,0,0,0.85)]"
              >
                {displayName}
              </PlayerName>
            </div>
          </div>
          <div className="h-11 w-px shrink-0 bg-white/10" />
          <div className="min-w-0 flex-1">
            {beatmap && (
              <div className="flex items-center gap-2 min-w-0">
                {mapUrl ? (
                  <a href={mapUrl} target="_blank" rel="noopener noreferrer" className="min-w-0 truncate text-[15px] font-semibold text-white transition-colors hover:text-osu-pink-light [text-shadow:0_1px_3px_rgba(0,0,0,0.85)]" title={`${beatmap.title} [${beatmap.version}]`}>
                    {beatmap.title} <span className="font-medium text-white/75">[{beatmap.version}]</span>
                  </a>
                ) : (
                  <div className="min-w-0 truncate text-[15px] font-semibold text-white [text-shadow:0_1px_3px_rgba(0,0,0,0.85)]" title={`${beatmap.title} [${beatmap.version}]`}>
                    {beatmap.title} <span className="font-medium text-white/75">[{beatmap.version}]</span>
                  </div>
                )}
                {stars != null && <StarRatingBadge stars={stars} className="shrink-0" size={1.2} />}
                {displayMods.length > 0 && (
                  <div className="flex shrink-0 items-center gap-0.5">
                    {displayMods.map((mod, index) => (
                      <ModBadge key={`${mod.acronym}-${index}`} mod={mod.acronym} rate={mod.rate} size={0.75} />
                    ))}
                  </div>
                )}
              </div>
            )}
            <div className="mt-1.5 flex flex-wrap items-center gap-x-6 gap-y-1.5 min-w-0">
              <StripStat label="Keys" valueClassName="text-osu-yellow">{replay.keyCount}K</StripStat>
              <StripStat label="Accuracy">{shownAccuracy.toFixed(2)}%<DeltaChip delta={accDelta} suffix="%" decimals={2} /></StripStat>
              {shownPp != null && <StripStat label="PP">{Math.round(shownPp)}pp<DeltaChip delta={ppDelta} suffix="pp" /></StripStat>}
              <StripStat label="Score" valueClassName={`text-white${realOnlyDim}`} title={simActive ? "From the real play (not simulated)" : undefined}>{h.totalScore.toLocaleString()}</StripStat>
              <StripStat label="Combo" valueClassName={`text-white${realOnlyDim}`} title={simActive ? "From the real play (not simulated)" : undefined}>{h.maxCombo}x</StripStat>
              {canToggleClient && onSelectClient ? (
                <div>
                  <div className="text-[9px] uppercase tracking-[0.16em] text-white/50">Client</div>
                  <ClientToggle judgingIsLazer={judgingIsLazer} simActive={simActive} onSelect={onSelectClient} />
                </div>
              ) : clientLabel ? (
                <StripStat label="Client" valueClassName={clientLabel === "Stable" ? "text-osu-pink-light" : "text-osu-l2"}>{clientLabel}</StripStat>
              ) : null}
              {playedDate && <StripStat label="Played">{playedDate}</StripStat>}
              <div>
                <div className="text-[9px] uppercase tracking-[0.16em] text-white/50">Judgments</div>
                <div className="text-xs font-semibold tabular-nums [text-shadow:0_1px_2px_rgba(0,0,0,0.8)]">
                  <span className="text-osu-yellow">{shownCounts.geki}</span><span className="text-white/40">/</span><span className="text-osu-blue">{shownCounts.c300}</span><span className="text-white/40">/</span><span className="text-osu-green-light">{shownCounts.katu}</span><span className="text-white/40">/</span><span className="text-osu-green">{shownCounts.c100}</span><span className="text-white/40">/</span><span className="text-osu-orange">{shownCounts.c50}</span><span className="text-white/40">/</span><span className="text-osu-red-light">{shownCounts.miss}</span>
                </div>
              </div>
              {beatmap && <StripStat label="Notes" valueClassName="text-white/80">{beatmap.notes.length.toLocaleString()}</StripStat>}
            </div>
          </div>
          <div className="flex shrink-0 items-center gap-2 self-start pt-1.5">
            {shareUrl && <ShareReplayButton shareUrl={shareUrl} />}
            <BackButton onClear={onClear} />
          </div>
        </div>
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

// The name over to that player's page, in a new tab like the map link beside
// it: a same-tab navigation would tear down the replay the viewer is watching.
// Without a username from the profile (an upload carries whatever name the
// client wrote) it stays plain text rather than linking somewhere dead.
function PlayerName({ username, className, children }: { username: string | null; className: string; children: ReactNode }) {
  if (!username) return <div className={className}>{children}</div>;
  return (
    <Link
      to="/player/$username"
      params={{ username }}
      target="_blank"
      rel="noopener noreferrer"
      title={username}
      className={`block transition-colors hover:text-osu-pink-light ${className}`}
    >
      {children}
    </Link>
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
      <div className="absolute inset-0 bg-black/30" />
    </div>
  );
}

// Beatmap cover for the mobile card's top row (desktop paints its own
// full-strip backdrop inline); the mask dissolves it in past the player
// cluster and back out before the card's right edge.
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
      <div className="absolute inset-0 bg-black/30" />
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

// On desktop this sits over the map's cover art, where muted grey on a bright
// crop was barely legible: solid white text over a heavier plate, outlined the
// same way the strip's other text is.
function BackButton({ onClear }: { onClear: () => void }) {
  return (
    <button
      type="button"
      onClick={onClear}
      className="rounded-lg border border-white/20 bg-white/15 px-3 py-1.5 text-xs font-semibold text-white transition-colors hover:border-white/30 hover:bg-white/25 [text-shadow:0_1px_2px_rgba(0,0,0,0.8)] cursor-pointer"
    >
      Back
    </button>
  );
}

function ShareReplayButton({ shareUrl, compact = false }: { shareUrl: string; compact?: boolean }) {
  const [copied, setCopied] = useState(false);

  // Straight to the clipboard, never the browser's own share sheet: desktop
  // Chrome answers that with a QR-code-and-email window, which is not what
  // anyone pressing this expects. The controls' Share panel keeps the sheet
  // for touch devices, where it is genuinely the fastest way into a DM.
  const handleShare = async () => {
    try {
      await navigator.clipboard.writeText(shareUrl);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1400);
    } catch {
      setCopied(false);
    }
  };

  const Icon = copied ? Check : Share2;
  return (
    <button
      type="button"
      onClick={handleShare}
      className={`inline-flex items-center gap-1.5 rounded-lg bg-osu-pink/20 font-semibold text-osu-pink-light transition-colors cursor-pointer hover:bg-osu-pink/30 hover:text-white ${compact ? "px-2.5 py-1.5 text-[11px]" : "px-3 py-1.5 text-xs"}`}
      title={shareUrl}
    >
      <Icon className="h-3.5 w-3.5" aria-hidden="true" />
      {copied ? "Copied" : "Share"}
    </button>
  );
}

// One stat in the desktop footer strip: whisper label over a bold value,
// shadowed so it reads over the cover art.
function StripStat({ label, children, valueClassName = "text-white", title }: {
  label: string;
  children: ReactNode;
  valueClassName?: string;
  title?: string;
}) {
  return (
    <div title={title}>
      <div className="text-[9px] uppercase tracking-[0.16em] text-white/50">{label}</div>
      <div className={`text-[13.5px] font-bold tabular-nums [text-shadow:0_1px_2px_rgba(0,0,0,0.8)] ${valueClassName}`}>{children}</div>
    </div>
  );
}

function MobileReplayStat({ label, value, valueClassName = "text-white", compact = false }: { label: string; value: string; valueClassName?: string; compact?: boolean }) {
  return (
    <div className={`min-w-0 rounded-lg bg-white/5 text-center ${compact ? "px-1 py-1.5" : "px-2 py-2"}`}>
      <div className="text-[8px] uppercase tracking-wider text-osu-f1">{label}</div>
      <div className={`truncate text-xs font-bold tabular-nums ${valueClassName}`}>{value}</div>
    </div>
  );
}
