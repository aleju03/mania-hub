interface Location {
  time: number;
  x: string;
  y: string;
  hitSound: string;
  sample: string;
}

interface TimingSection {
  time: number;
  beatLength: number;
}

const DEFAULT_SAMPLE = "0:0:0:0:";

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
    locations.sort((a, b) => a.time - b.time);
    for (let index = 0; index < locations.length - 1; index += 1) {
      const head = locations[index];
      const nextTime = locations[index + 1].time;
      const beatLength = beatLengthAt(timing, nextTime);
      const gap = nextTime - head.time;
      const duration = Math.max(gap / 2, gap - beatLength / 4);
      const endTime = Math.round(head.time + duration);
      const line = endTime > head.time
        ? `${head.x},${head.y},${head.time},128,${head.hitSound},${endTime}:${head.sample}`
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

function beatLengthAt(timing: TimingSection[], time: number): number {
  if (timing.length === 0) return 1000;
  let current = timing[0];
  for (const point of timing) {
    if (point.time > time) break;
    current = point;
  }
  return current.beatLength;
}
