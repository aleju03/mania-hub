import { useEffect, useRef, useState } from "react";
import { Trans, useLingui } from "@lingui/react/macro";
import { useLocation } from "@tanstack/react-router";
import { fetchLivePlayerDanEvidenceDirect, fetchLivePlayerSkillPlaysDirect, loadLiveMapSearchEntry, type LiveMapSearchEntry } from "../../lib/live-backend";
import { parseSharedSkillPlaySearch, skillPlaySharePath } from "../../lib/skill-play-share";
import { skillAxisMeta, OVERALL_AXIS_META } from "../../lib/skill-axes";
import { MapDetailModal, type MapDetailPlayContext } from "../maps/MapDetailModal";
import { DanRejectionExplanation } from "./SkillPlaysExplorer";
import { rateModFor, stubEntry } from "./SkillPlaysModal";

/** Resolve a link against this player's retained evidence, never URL-supplied ratings. */
export function SharedSkillPlay({ userId, username }: { userId: number; username: string }) {
  const { t, i18n } = useLingui();
  const searchStr = useLocation({ select: (location) => location.searchStr });
  const { score: scoreId, keys, map, rating } = parseSharedSkillPlaySearch(Object.fromEntries(new URLSearchParams(searchStr)));
  const [result, setResult] = useState<{ entry: LiveMapSearchEntry; play: MapDetailPlayContext; missingMap: boolean } | null>(null);
  const [state, setState] = useState<"loading" | "ready" | "missing" | "error" | "closed">("loading");
  const requestRef = useRef<AbortController | null>(null);
  const dismiss = () => { requestRef.current?.abort(); setState("closed"); };
  const [retry, setRetry] = useState(0);

  useEffect(() => {
    if (!scoreId || !keys || !map || !rating) return;
    const controller = new AbortController();
    requestRef.current = controller;
    setResult(null);
    setState("loading");
    const load = async () => {
      const side = rating === "dan:rc" ? "rc" : rating === "dan:ln" ? "ln" : null;
      const evidence = side ? await fetchLivePlayerDanEvidenceDirect(userId, keys, side, { scoreId, includeRejected: true, signal: controller.signal }) : null;
      const clear = evidence?.clears.find((item) => item.play.scoreId === scoreId && item.play.beatmapId === map);
      const rejected = evidence?.rejected?.find((item) => item.play.scoreId === scoreId && item.play.beatmapId === map);
      const play = side ? clear?.play ?? rejected?.play : await fetchLivePlayerSkillPlaysDirect(userId, keys, rating, { scoreId, includeRejected: true, signal: controller.signal })
        .then((page) => [...page.items, ...(page.rejected ?? [])].find((item) => item.scoreId === scoreId && item.beatmapId === map));
      if (!play) {
        if (!controller.signal.aborted) setState("missing");
        return;
      }
      const entry = await loadLiveMapSearchEntry(play.beatmapId).catch(() => null);
      const axis = skillAxisMeta(rating) ?? OVERALL_AXIS_META;
      if (controller.signal.aborted) return;
      setResult({
        entry: entry ?? stubEntry(play),
        missingMap: entry == null,
        play: {
          ...play,
          username,
          score: play.score,
          sharePath: skillPlaySharePath(username, scoreId, keys, map, rating),
          rateMod: rateModFor(play.rate, play.rateMod),
          ratingLabel: i18n._(axis.labelMsg),
          ratingColor: axis.color,
          dan: side && clear ? {
            chartRating: clear.chartDan, chartLabel: clear.chartDanLabel,
            creditedRating: clear.creditedDan, creditedLabel: clear.creditedDanLabel,
            accuracy: clear.clearAccuracy, family: side,
          } : side && rejected ? {
            chartRating: rejected.chartDan, chartLabel: rejected.chartDanLabel,
            accuracy: rejected.clearAccuracy, family: rejected.side ?? side,
            rejection: <DanRejectionExplanation rejected={rejected} />,
          } : undefined,
        },
      });
      setState("ready");
    };
    void load().catch(() => { if (!controller.signal.aborted) setState("error"); });
    return () => controller.abort();
  }, [userId, username, scoreId, keys, map, rating, retry, i18n]);

  if (!scoreId || state === "closed") return null;
  if (state === "ready" && result) return <MapDetailModal entry={result.entry} play={result.play} status={result.missingMap ? "missing" : "ready"} onClose={dismiss} />;
  return (
    <div role="status" className="mb-4 flex items-center justify-between gap-3 rounded-xl bg-osu-b4 p-4 text-sm text-osu-l2">
      <span>{state === "loading" ? t`Loading shared score…` : state === "error" ? t`Could not load this score.` : t`This score is no longer in the player's rated history.`}</span>
      {state === "error" && <button type="button" onClick={() => setRetry((value) => value + 1)} className="text-osu-pink"><Trans>Retry</Trans></button>}
      <button type="button" onClick={dismiss} className="text-osu-f1"><Trans>Dismiss</Trans></button>
    </div>
  );
}
