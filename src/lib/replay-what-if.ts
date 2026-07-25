// "What would this play have been on the other client?" - re-judges a
// replay's inputs under the opposite ruleset (stable <-> lazer) and prices
// the result with the official pp formula. Replay frames are client-agnostic
// keypress timelines, so the counterfactual only swaps the judge: hit
// windows, LN mechanics (stable judges a hold once, lazer judges head and
// tail separately), and the judgement counts that fall out. Star rating is
// client-independent; the pp difference comes purely from the counts.
//
// This answers "same inputs, different judge" - a real player on the other
// client would adapt (LN releases especially), so surface it as an estimate.

import type { ManiaNote, ManiaTimingPoint } from "./beatmap-parser";
import type { ReplayFrame } from "./types";
import type { ManiaReplayMod } from "./mania-replay-judgement";
import {
  applyManiaReplayModsToNotes,
  buildReplaySegments,
  calculateReplayAccuracy,
  getManiaReplayHitWindows,
  getManiaReplayModAcronym,
  getManiaReplayModSetting,
  getManiaReplayRuleset,
  simulateManiaReplayJudgements,
} from "./mania-replay-judgement";
import { calculateManiaPp, getManiaPpModMultiplier } from "./mania-pp";
import { calculateManiaStarRating } from "./mania-star-rating";

export interface ManiaWhatIfInput {
  frames: ReplayFrame[];
  /** Parsed beatmap notes, before replay mod transforms (MR/RD/IN/HO). */
  notes: ManiaNote[];
  keyCount: number;
  /** The play's mods (API score mods, or parsed replay mods for uploads). */
  mods?: ManiaReplayMod[];
  timingPoints?: ManiaTimingPoint[];
  od?: number;
  isConvert?: boolean;
  /** Ruleset the replay was actually judged on (the viewer's isLazer flag). */
  sourceIsLazer: boolean;
  /** Mod rate (DT/HT/speed_change); derived from mods when omitted. */
  modRate?: number;
}

export interface ManiaWhatIfResult {
  targetIsLazer: boolean;
  /** Judgment-indexed like the renderer: [_, MAX, 300, 200, 100, 50, miss]. */
  counts: number[];
  totalJudgements: number;
  /** Displayed accuracy percent (0-100) under the target ruleset. */
  accuracy: number;
  starRating: number;
  pp: number;
}

export function computeManiaRulesetWhatIf(input: ManiaWhatIfInput): ManiaWhatIfResult | null {
  const { frames, notes, keyCount, timingPoints, od, sourceIsLazer } = input;
  if (frames.length === 0 || notes.length === 0 || keyCount <= 0) return null;

  const inputMods = (input.mods ?? []).filter(Boolean);
  const acronyms = inputMods.map(getManiaReplayModAcronym).filter(Boolean);
  const targetIsLazer = !sourceIsLazer;
  // Converted stable scores carry CL in their lazer-API mod list; a fresh
  // lazer play wouldn't have it (CL exists to emulate stable), so drop it
  // from the target ruleset or "on lazer" would just re-judge with stable
  // windows.
  const targetAcronyms = targetIsLazer ? acronyms.filter((acronym) => acronym !== "CL") : acronyms;

  const rawModRate = Number(input.modRate);
  const ruleset = getManiaReplayRuleset(
    targetIsLazer,
    targetAcronyms,
    input.isConvert ?? false,
    Number.isFinite(rawModRate) && rawModRate > 0 ? rawModRate : undefined,
  );

  const difficultyAdjustMod = inputMods.find((mod) => getManiaReplayModAcronym(mod) === "DA");
  const overriddenOd = Number(getManiaReplayModSetting(difficultyAdjustMod, ["overall_difficulty", "overallDifficulty"]));
  const effectiveOd = Number.isFinite(overriddenOd)
    ? overriddenOd
    : od != null && Number.isFinite(od) ? od : 8;
  const windows = getManiaReplayHitWindows(effectiveOd, ruleset);

  const appliedNotes = applyManiaReplayModsToNotes(notes, keyCount, inputMods, { timingPoints });

  let noteDuration = 0;
  for (const note of appliedNotes) {
    noteDuration = Math.max(noteDuration, note.time, note.endTime);
  }
  const totalDuration = Math.max(frames[frames.length - 1].time, noteDuration + windows.miss * 1.5);
  const segments = buildReplaySegments(frames, keyCount, totalDuration);

  const simulated = simulateManiaReplayJudgements(appliedNotes, segments, keyCount, windows, ruleset.accuracyMode, {
    lazerNoReleaseTails: targetIsLazer && acronyms.includes("NR"),
    // Frame-time rounding is a property of the source replay file, not the
    // target ruleset (the viewer can conflate them because it always judges
    // a replay on its own ruleset).
    legacyReplayFrameRounding: !sourceIsLazer,
    speedMultiplier: ruleset.speedMultiplier,
  });

  const counts = [0, 0, 0, 0, 0, 0, 0];
  for (const event of simulated.events) {
    if (event.judgment != null && event.judgment > 0) counts[event.judgment]++;
  }
  const totalJudgements = counts.reduce((sum, count) => sum + count, 0);

  const starRating = calculateManiaStarRating(appliedNotes, keyCount, ruleset.speedMultiplier);
  const pp = calculateManiaPp({
    starRating,
    counts: { perfect: counts[1], great: counts[2], good: counts[3], ok: counts[4], meh: counts[5], miss: counts[6] },
    modMultiplier: getManiaPpModMultiplier(targetAcronyms),
  });

  return {
    targetIsLazer,
    counts,
    totalJudgements,
    accuracy: calculateReplayAccuracy(counts, ruleset.accuracyMode),
    starRating,
    pp,
  };
}
