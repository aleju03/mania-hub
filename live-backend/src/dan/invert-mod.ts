// osu!lazer's Invert mod (ManiaModInvert) applied to a mania .osu text, so a
// play set under it can be rated against the chart it actually played.
//
// Lazer rebuilds every column from its "locations": the start time of every
// object, note or hold (a hold's end is ignored, so an existing hold reaches
// the next object like any note would). Consecutive locations become one hold
// from the earlier to just short of the later, shortened by a quarter of the
// beat length in force at the later one but never by more than half the gap,
// so no hold is instantaneous. The last location in every column gets nothing
// (it was the end of the chart in that column), and breaks are cleared.
// Samples stay on the head; the release is silent.
//
// Everything outside [HitObjects] and the break lines under [Events] is copied
// through byte for byte, so MinaCalc, the classifier and the dan estimator
// read the inverted chart exactly as they would a mapper's own file.
// Reference: osu.Game.Rulesets.Mania/Mods/ManiaModInvert.cs.

interface Location {
  time: number;
  x: string;
  y: string;
  hitSound: string;
  // The osu! hit-sample block ("0:0:0:0:"), already stripped of a hold's end
  // time. Lazer keeps the head's samples and silences the release, which for
  // the text is the same thing as carrying the block over.
  sample: string;
}

interface TimingSection {
  time: number;
  beatLength: number;
}

const DEFAULT_SAMPLE = "0:0:0:0:";

/**
 * The inverted chart as .osu text, or null when the file is not a mania chart
 * this can rebuild (no CircleSize, no [HitObjects] section, or nothing in it).
 */
export function invertManiaOsuText(osuText: string): string | null {
  const lines = osuText.split("\n");
  let keyCount: number | null = null;
  const timing: TimingSection[] = [];
  const columns = new Map<number, Location[]>();
  let hitObjectsStart = -1;
  let hitObjectsEnd = lines.length;
  let section = "";
  let hitObjects = 0;

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index].trim();
    if (line.startsWith("[") && line.endsWith("]")) {
      if (section === "HitObjects") hitObjectsEnd = index;
      section = line.slice(1, -1);
      if (section === "HitObjects") hitObjectsStart = index;
      continue;
    }
    if (!line || line.startsWith("//")) continue;
    if (section === "Difficulty") {
      const match = line.match(/^CircleSize\s*:\s*(\d+(?:\.\d+)?)/);
      if (match) {
        const parsed = Math.round(Number(match[1]));
        keyCount = Number.isInteger(parsed) && parsed > 0 ? Math.min(18, parsed) : null;
      }
    } else if (section === "TimingPoints") {
      const parts = line.split(",");
      if (parts.length < 2) continue;
      const time = parseFloat(parts[0]);
      const beatLength = parseFloat(parts[1]);
      // Inherited (green) lines carry a negative multiplier, not a beat length;
      // the legacy format also predates the uninherited flag, so a short line is
      // a red line by definition.
      const uninherited = parts.length < 7 || parts[6].trim() !== "0";
      if (Number.isFinite(time) && Number.isFinite(beatLength) && beatLength > 0 && uninherited) {
        timing.push({ time, beatLength });
      }
    } else if (section === "HitObjects") {
      if (keyCount == null) return null;
      const parts = line.split(",");
      if (parts.length < 5) continue;
      const x = parseInt(parts[0], 10);
      const time = parseInt(parts[2], 10);
      const type = parseInt(parts[3], 10);
      if (!Number.isFinite(x) || !Number.isFinite(time) || !Number.isFinite(type)) continue;
      hitObjects += 1;
      const column = Math.max(0, Math.min(keyCount - 1, Math.floor((x * keyCount) / 512)));
      const isHold = (type & 128) !== 0;
      const rest = parts.slice(5).join(",");
      let sample = DEFAULT_SAMPLE;
      if (isHold) {
        // "endTime:sample"; the end time itself is not a location.
        const colon = rest.indexOf(":");
        if (colon >= 0 && rest.slice(colon + 1).trim()) sample = rest.slice(colon + 1).trim();
      } else if (rest.trim()) {
        sample = rest.trim();
      }
      const list = columns.get(column) ?? [];
      list.push({ time, x: parts[0].trim(), y: parts[1].trim(), hitSound: parts[4].trim(), sample });
      columns.set(column, list);
    }
  }
  if (keyCount == null || hitObjectsStart < 0 || hitObjects === 0) return null;
  timing.sort((a, b) => a.time - b.time);

  const inverted: Array<{ time: number; column: number; line: string }> = [];
  for (const [column, locations] of columns) {
    // A stable sort, like LINQ's OrderBy: two objects at one time keep file
    // order, and lazer then emits a zero-length hold between them.
    locations.sort((a, b) => a.time - b.time);
    for (let index = 0; index < locations.length - 1; index += 1) {
      const head = locations[index];
      const nextTime = locations[index + 1].time;
      const beatLength = beatLengthAt(timing, nextTime);
      const gap = nextTime - head.time;
      // "Decrease the duration by at most a 1/4 beat to ensure there's no
      // instantaneous notes."
      const duration = Math.max(gap / 2, gap - beatLength / 4);
      const endTime = Math.round(head.time + duration);
      const line = endTime > head.time
        ? `${head.x},${head.y},${head.time},128,${head.hitSound},${endTime}:${head.sample}`
        // Two locations at one instant leave lazer a zero-length hold, which is
        // a tap in everything but name; write the tap.
        : `${head.x},${head.y},${head.time},1,${head.hitSound},${head.sample}`;
      inverted.push({ time: head.time, column, line });
    }
  }
  inverted.sort((a, b) => a.time - b.time || a.column - b.column);

  const out: string[] = [];
  section = "";
  for (let index = 0; index < hitObjectsStart; index += 1) {
    const raw = lines[index];
    const line = raw.trim();
    if (line.startsWith("[") && line.endsWith("]")) section = line.slice(1, -1);
    // Lazer clears the breaks: an inverted column has no rest in it.
    else if (section === "Events" && /^(2|Break)\s*,/.test(line)) continue;
    out.push(raw);
  }
  out.push(lines[hitObjectsStart]);
  for (const entry of inverted) out.push(entry.line);
  if (hitObjectsEnd < lines.length) {
    out.push("");
    for (let index = hitObjectsEnd; index < lines.length; index += 1) out.push(lines[index]);
  }
  return out.join("\n");
}

/**
 * ControlPointInfo.TimingPointAt: the red line in force at `time`, falling back
 * to the first one for anything before it (and to lazer's default 1000ms beat
 * for a file with no red lines at all, which the decoder would also invent).
 */
function beatLengthAt(timing: TimingSection[], time: number): number {
  if (timing.length === 0) return 1000;
  let current = timing[0];
  for (const point of timing) {
    if (point.time > time) break;
    current = point;
  }
  return current.beatLength;
}
