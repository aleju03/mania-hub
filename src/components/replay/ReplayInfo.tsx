import { formatDate } from "#/lib/format";
import { getDisplayedAccuracy, getScoreTimestamp, isLazerScore } from "#/lib/score";
import type { ManiaBeatmap } from "#/lib/beatmap-parser";
import type { ServerReplay } from "#/lib/replay-types";
import type { OsuScore } from "#/lib/types";

interface ReplayInfoProps {
  replay: ServerReplay;
  score: OsuScore | null;
  beatmap: ManiaBeatmap | null;
  onClear: () => void;
}

export function ReplayInfo({ replay, score, beatmap, onClear }: ReplayInfoProps) {
  const h = replay.header;
  const totalHits = h.countGeki + h.count300 + h.countKatu + h.count100 + h.count50;
  const accuracy = score
    ? getDisplayedAccuracy(score) * 100
    : totalHits + h.countMiss > 0
      ? ((h.countGeki * 6 + h.count300 * 6 + h.countKatu * 4 + h.count100 * 2 + h.count50) / ((totalHits + h.countMiss) * 6) * 100)
      : 0;
  const beatmapsetId = score?.beatmapset?.id;
  const beatmapId = score?.beatmap?.id;
  const mapUrl = beatmapsetId ? `https://osu.ppy.sh/beatmapsets/${beatmapsetId}${beatmapId ? `#mania/${beatmapId}` : ""}` : null;
  const clientLabel = score ? (isLazerScore(score) ? "Lazer" : "Stable") : null;
  const playedAt = score ? getScoreTimestamp(score) : "";
  const playedDate = playedAt ? formatDate(playedAt) : null;

  return (
    <>
      <div className="sm:hidden bg-osu-b4 rounded-xl p-3 mb-3 border border-osu-b3/20">
        <div className="flex items-start gap-3">
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <div className="min-w-0">
                <div className="text-[8px] uppercase tracking-wider text-osu-f1">Player</div>
                <div className="truncate text-sm font-bold text-white">{h.playerName}</div>
              </div>
              <div className="h-7 w-px bg-osu-b3/40" />
              <div className="min-w-0 flex-1">
                <div className="text-[8px] uppercase tracking-wider text-osu-f1">Map</div>
                {beatmap ? (
                  mapUrl ? (
                    <a href={mapUrl} target="_blank" rel="noopener noreferrer" className="block truncate text-xs font-semibold text-osu-l2" title={`${beatmap.title} [${beatmap.version}]`}>
                      {beatmap.title} [{beatmap.version}]
                    </a>
                  ) : (
                    <div className="truncate text-xs font-semibold text-osu-l2" title={`${beatmap.title} [${beatmap.version}]`}>{beatmap.title} [{beatmap.version}]</div>
                  )
                ) : (
                  <div className="truncate text-xs font-semibold text-osu-l2">Replay loaded</div>
                )}
              </div>
            </div>
          </div>
          <button onClick={onClear} className="shrink-0 px-3 py-1.5 rounded-lg bg-osu-b3/50 text-xs text-osu-f1 hover:text-white hover:bg-osu-b2 transition-colors cursor-pointer">Back</button>
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

      <div className="hidden sm:block bg-osu-b4 rounded-xl p-4 mb-4 border border-osu-b3/20">
        <div className="grid grid-cols-[minmax(56px,max-content)_minmax(0,1fr)_auto] lg:grid-cols-[minmax(64px,max-content)_minmax(160px,1fr)_auto_auto] items-center gap-x-4 sm:gap-x-6 gap-y-2">
          <div className="min-w-0"><div className="text-[9px] uppercase tracking-wider text-osu-f1">Player</div><div className="text-sm font-bold text-white truncate">{h.playerName}</div></div>
          {beatmap && (
            <div className="min-w-0">
              <div className="text-[9px] uppercase tracking-wider text-osu-f1">Map</div>
              {mapUrl ? (
                <a href={mapUrl} target="_blank" rel="noopener noreferrer" className="block truncate text-sm font-medium text-osu-l2 hover:text-osu-pink-light transition-colors" title={`${beatmap.title} [${beatmap.version}]`}>
                  {beatmap.title} [{beatmap.version}]
                </a>
              ) : (
                <div className="truncate text-sm font-medium text-osu-l2" title={`${beatmap.title} [${beatmap.version}]`}>{beatmap.title} [{beatmap.version}]</div>
              )}
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
          <button onClick={onClear} className="justify-self-end px-3 py-1.5 rounded-lg bg-osu-b3/50 text-xs text-osu-f1 hover:text-white hover:bg-osu-b2 transition-colors cursor-pointer">Back</button>
        </div>
      </div>
    </>
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
