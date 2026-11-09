import { useEffect, useState } from "react";

import type { HighwayChart } from "../../lib/supporter-profile-themes";

/* A real chart for the Note highway, when its owner switched "Play my top
   plays" on: their best play in the highway's keymode (falling back to the
   next ones if a chart will not load), looped over its densest stretch. The
   .osu comes through the site's own cached path (getBeatmapFile: the
   backend's durable copy behind an hour of edge cache), the same one replays
   use, so no new osu! API traffic.

   The notes go to the shader as two float textures it can look up per pixel
   (profile-theme-gl.ts uploads them):
   - notes: one texel per note, (start ms, end ms), every lane's notes
     together in time order, lane after lane;
   - index: per lane and per BUCKET_MS of the section, the first note of that
     lane still sounding at the bucket's start, so a pixel finds its note in
     a step or two however long the chart. */

export const HIGHWAY_SECTION_MS = 24_000;
const SECTION_MS = HIGHWAY_SECTION_MS;
const LOOP_GAP_MS = 1_500;
const BUCKET_MS = 100;
const NOTES_WIDTH = 1024;
const TRIES = 3;

interface ChartScore {
  pp: number | null;
  beatmap: { id: number; beatmapset_id?: number; cs: number; mode?: string; checksum?: string | null };
}

/* The keymode a player plays most among these scores, or null. */
export function mainKeymode(scores: readonly ChartScore[] | null | undefined): number | null {
  const counts = new Map<number, number>();
  for (const score of scores ?? []) {
    const keys = Math.round(score.beatmap?.cs ?? 0);
    if (keys >= 1 && keys <= 10) counts.set(keys, (counts.get(keys) ?? 0) + 1);
  }
  let best: number | null = null;
  for (const [keys, count] of counts) if (best === null || count > counts.get(best)!) best = keys;
  return best;
}

export function buildHighwayChart(notes: { column: number; time: number; endTime: number }[], lanes: number, start: number, key: string): HighwayChart | null {
  const end = start + SECTION_MS;
  const perLane: { time: number; endTime: number }[][] = Array.from({ length: lanes }, () => []);
  for (const note of notes) {
    if (note.column < 0 || note.column >= lanes || note.endTime < start || note.time > end) continue;
    perLane[note.column].push({ time: note.time, endTime: Math.min(Math.max(note.endTime, note.time), end) });
  }
  const total = perLane.reduce((sum, lane) => sum + lane.length, 0);
  if (total < 20) return null;

  const height = Math.max(1, Math.ceil(total / NOTES_WIDTH));
  const texels = new Float32Array(NOTES_WIDTH * height * 4);
  const buckets = Math.ceil(SECTION_MS / BUCKET_MS) + 1;
  const index = new Float32Array(buckets * lanes).fill(-1);
  const laneEnd: number[] = [];
  let at = 0;
  perLane.forEach((laneNotes, lane) => {
    laneNotes.sort((a, b) => a.time - b.time);
    const first = at;
    for (const note of laneNotes) {
      texels.set([note.time - start, note.endTime - start, 0, 0], at * 4);
      at += 1;
    }
    laneEnd.push(at);
    // For each bucket: the first note of the lane whose end is at or past the bucket's start.
    let cursor = first;
    for (let bucket = 0; bucket < buckets; bucket += 1) {
      const bucketStart = bucket * BUCKET_MS;
      while (cursor < at && texels[cursor * 4 + 1] < bucketStart) cursor += 1;
      index[lane * buckets + bucket] = cursor < at ? cursor : -1;
    }
  });
  return { lanes, notes: texels, notesWidth: NOTES_WIDTH, notesHeight: height, index, buckets, bucketMs: BUCKET_MS, laneEnd, period: SECTION_MS + LOOP_GAP_MS, key };
}

export async function loadHighwayChart(scores: readonly ChartScore[], lanes: number): Promise<HighwayChart | null> {
  const candidates = scores
    .filter((score) => score.beatmap && (!score.beatmap.mode || score.beatmap.mode === "mania") && Math.round(score.beatmap.cs) === lanes)
    .sort((a, b) => (b.pp ?? 0) - (a.pp ?? 0))
    .filter((score, index, list) => list.findIndex((other) => other.beatmap.id === score.beatmap.id) === index)
    .slice(0, TRIES);
  if (candidates.length === 0) return null;
  const [{ getBeatmapFile }, { parseManiaBeatmap }, { findDensestPreviewStartTime }] = await Promise.all([
    import("../../lib/osu/replay"),
    import("../../lib/beatmap-parser"),
    import("../../lib/chart-preview"),
  ]);
  for (const score of candidates) {
    try {
      const file = await getBeatmapFile({ data: { beatmapId: score.beatmap.id, beatmapsetId: score.beatmap.beatmapset_id ?? null, checksum: score.beatmap.checksum ?? null } });
      if (!file?.content) continue;
      const beatmap = parseManiaBeatmap(file.content);
      if (beatmap.keyCount !== lanes || beatmap.notes.length === 0) continue;
      // The densest stretch, judged over the section's own length.
      const start = findDensestPreviewStartTime(beatmap);
      const chart = buildHighwayChart(beatmap.notes, lanes, start, `${score.beatmap.id}:${start}`);
      if (chart) return chart;
    } catch {
      // try the next play
    }
  }
  return null;
}

/* One load per player and keymode for the page's life. */
const loads = new Map<string, Promise<HighwayChart | null>>();

/* The chart for this player's highway, once loaded; null while loading, when
   switched off, or when none of their best plays will load. */
export function useHighwayChart(userId: number | null | undefined, scores: readonly ChartScore[] | null | undefined, lanes: number, enabled: boolean): HighwayChart | null {
  const [chart, setChart] = useState<{ for: string; value: HighwayChart | null } | null>(null);
  const ready = enabled && !!userId && !!scores && scores.length > 0;
  const request = ready ? `${userId}:${lanes}` : null;
  useEffect(() => {
    if (!request || !scores) return;
    let alive = true;
    let load = loads.get(request);
    if (!load) {
      load = loadHighwayChart(scores, lanes).catch(() => null);
      loads.set(request, load);
    }
    load.then((value) => {
      if (alive) setChart({ for: request, value });
    });
    return () => {
      alive = false;
    };
  }, [request]); // eslint-disable-line react-hooks/exhaustive-deps
  return request && chart?.for === request ? chart.value : null;
}
