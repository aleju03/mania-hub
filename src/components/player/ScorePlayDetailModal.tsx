import { Link } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { useLingui } from "@lingui/react/macro";
import { isLocalChartId, loadLiveMapSearchEntry, peekLiveMapSearchEntry, type LiveMapSearchEntry } from "../../lib/live-backend";
import {
  getBeatmapKeyCount,
  getModDisplayList,
  getScoreDisplayValues,
  getScoreRate,
  getScoreTimestamp,
  getScoreUrl,
  scoreHasReplay,
} from "../../lib/score";
import { companellaReplayImportId, sharedImportPath } from "../../lib/companella-scores";
import type { OsuScore } from "../../lib/types";
import { MapDetailModal, type MapDetailPlayContext } from "../maps/MapDetailModal";
import { rateModFor } from "./SkillPlaysModal";

type MapStatus = "ready" | "pending" | "missing" | "error";

/** What the score already knows about its map, so the card opens on the click
 *  and fills in once the catalog entry lands. */
function scoreMapStub(score: OsuScore, beatmapId: number): LiveMapSearchEntry {
  return {
    beatmapId,
    // A local chart's declared set is only where its cover comes from.
    beatmapsetId: isLocalChartId(beatmapId) ? 0 : score.beatmapset?.id ?? 0,
    title: score.beatmapset?.title ?? "",
    artist: score.beatmapset?.artist ?? "",
    creator: score.beatmapset?.creator ?? "",
    version: score.beatmap?.version ?? "",
    status: "",
    keyCount: getBeatmapKeyCount(score.beatmap) ?? 0,
    stars: 0,
    bpm: 0,
    length: 0,
    playCount: 0,
    lnCount: 0,
    primaryPattern: "",
    patterns: {},
    covers: score.beatmapset?.covers ? { ...score.beatmapset.covers } : null,
  };
}

function localChartId(id: number | undefined): number {
  return isLocalChartId(id) ? Math.floor(id as number) : 0;
}

function difficultyAdjustOd(score: OsuScore): number | null {
  for (const mod of score.mods ?? []) {
    if (typeof mod !== "object" || mod?.acronym !== "DA") continue;
    const od = Number((mod as { settings?: { overall_difficulty?: unknown } }).settings?.overall_difficulty);
    return Number.isFinite(od) ? od : null;
  }
  return null;
}

/** A profile play opened as the map card's Score tab, with the map behind the
 *  second tab, the way the skill play lists open theirs. */
export function ScorePlayDetailModal({
  score,
  username,
  onClose,
  scoreOnly = false,
}: {
  score: OsuScore;
  username: string;
  onClose: () => void;
  /** Opened from the map's own Scores tab, which is still open underneath. */
  scoreOnly?: boolean;
}) {
  const { t } = useLingui();
  // An import of a local copy (a rate edit) has no id of its own; the card
  // opens the official chart the backend matched it to, at the copy's rate.
  const reference = !(score.beatmap?.id) ? score.companella?.reference : undefined;
  // A chart osu! does not have, matched to nothing official, carries its own
  // negative id; its Map info tab reads the chart's analysis.
  const localBeatmapId = !(score.beatmap?.id) && !reference ? localChartId(score.companella?.localBeatmapId) : 0;
  const beatmapId = score.beatmap?.id || reference?.beatmapId || localBeatmapId || 0;
  const [map, setMap] = useState<{ entry: LiveMapSearchEntry; status: MapStatus }>(() => ({
    entry: scoreMapStub(score, beatmapId),
    status: "pending",
  }));

  useEffect(() => {
    const stub = scoreMapStub(score, beatmapId);
    const cached = peekLiveMapSearchEntry(beatmapId);
    if (cached !== undefined) {
      setMap({ entry: cached ?? stub, status: cached ? "ready" : "missing" });
      return;
    }
    setMap({ entry: stub, status: "pending" });
    let cancelled = false;
    loadLiveMapSearchEntry(beatmapId)
      .then((entry) => {
        if (!cancelled) setMap({ entry: entry ?? stub, status: entry ? "ready" : "missing" });
      })
      .catch(() => {
        if (!cancelled) setMap({ entry: stub, status: "error" });
      });
    return () => {
      cancelled = true;
    };
  }, [score, beatmapId]);

  const display = getScoreDisplayValues(score);
  const mods = getModDisplayList(score.mods).map((mod) => mod.acronym);
  const speedMod = mods.find((mod) => mod === "DT" || mod === "NC" || mod === "HT" || mod === "DC");
  const importId = companellaReplayImportId(score);
  const canReplay = importId != null || scoreHasReplay(score);
  const playedAt = getScoreTimestamp(score);

  const play: MapDetailPlayContext = {
    beatmapId,
    username: score.user?.username ?? username,
    accuracy: display.accuracy,
    pp: score.pp ?? null,
    rateMod: rateModFor(getScoreRate(score.mods), speedMod),
    chartRate: reference?.rate,
    playedAt: playedAt || null,
    source: "top",
    sourceLabel: display.isLazer ? t`played on Lazer` : t`played on Stable`,
    mods,
    daOd: difficultyAdjustOd(score),
    scoreId: score.id,
    // An import has no osu! page; its link opens this card on the Recent tab.
    sharePath: score.companella ? sharedImportPath(score.user?.username ?? username, score.companella.importId) : null,
    score: {
      statistics: score.statistics ?? null,
      maxCombo: score.max_combo ?? null,
      totalScore: display.totalScore,
      rank: display.rank,
      scoreUrl: getScoreUrl(score),
    },
    ratingLabel: "",
    ratingColor: "",
  };

  return (
    <MapDetailModal
      entry={map.entry}
      status={map.status}
      onClose={onClose}
      play={play}
      scoreOnly={scoreOnly}
      actions={canReplay ? (
        <Link
          to="/replay"
          search={importId != null ? { importId } : { scoreId: score.id, beatmapsetId: score.beatmapset?.id }}
          className="inline-flex items-center justify-center gap-1.5 whitespace-nowrap rounded-md bg-osu-b3/70 px-3 py-2 text-[12px] font-semibold text-osu-l2 hover:bg-osu-b3 hover:text-white transition-colors sm:justify-start sm:px-3"
        >
          {t`Watch replay`}
        </Link>
      ) : null}
    />
  );
}
