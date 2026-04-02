// Parse .osu file format for mania note data

export interface ManiaNote {
  column: number;  // 0-indexed column
  time: number;    // start time in ms
  endTime: number; // end time in ms (same as time for regular notes, > time for holds)
  isHold: boolean;
}

export interface ManiaBeatmap {
  title: string;
  artist: string;
  version: string;
  creator: string;
  keyCount: number;
  od: number;
  bpm: number;
  notes: ManiaNote[];
  totalLength: number;
  audioFilename: string;
  previewTime: number;
  backgroundFilename: string;
}

export function parseManiaBeatmap(content: string): ManiaBeatmap {
  const lines = content.split("\n").map((l) => l.trim());

  let title = "";
  let artist = "";
  let version = "";
  let creator = "";
  let circleSize = 4; // CS = key count in mania
  let overallDifficulty = 8;
  let audioFilename = "";
  let previewTime = 0;
  let backgroundFilename = "";
  let section = "";
  const notes: ManiaNote[] = [];
  const timingPoints: { time: number; beatLength: number }[] = [];

  for (const line of lines) {
    if (line.startsWith("[") && line.endsWith("]")) {
      section = line.slice(1, -1);
      continue;
    }

    if (section === "General") {
      if (line.startsWith("AudioFilename:")) audioFilename = line.slice(14).trim();
      if (line.startsWith("PreviewTime:")) previewTime = parseInt(line.split(":")[1].trim(), 10) || 0;
    }

    if (section === "Metadata") {
      if (line.startsWith("Title:")) title = line.slice(6).trim();
      if (line.startsWith("Artist:")) artist = line.slice(7).trim();
      if (line.startsWith("Version:")) version = line.slice(8).trim();
      if (line.startsWith("Creator:")) creator = line.slice(8).trim();
    }

    if (section === "Events" && !backgroundFilename) {
      const match = line.match(/^0,0,"([^"]+)"/);
      if (match) backgroundFilename = match[1];
    }

    if (section === "Difficulty") {
      if (line.startsWith("CircleSize:")) circleSize = parseFloat(line.split(":")[1].trim());
      if (line.startsWith("OverallDifficulty:")) overallDifficulty = parseFloat(line.split(":")[1].trim());
    }

    if (section === "TimingPoints" && line.includes(",")) {
      const parts = line.split(",");
      if (parts.length >= 2) {
        const time = parseFloat(parts[0]);
        const beatLength = parseFloat(parts[1]);
        if (beatLength > 0) {
          timingPoints.push({ time, beatLength });
        }
      }
    }

    if (section === "HitObjects" && line.includes(",")) {
      const parts = line.split(",");
      if (parts.length >= 5) {
        const x = parseInt(parts[0], 10);
        const time = parseInt(parts[2], 10);
        const type = parseInt(parts[3], 10);

        // In mania, column is determined by x position: column = floor(x * keyCount / 512)
        const column = Math.floor((x * circleSize) / 512);

        // Check if it's a hold note (type bit 7 = 128)
        const isHold = (type & 128) !== 0;
        let endTime = time;

        if (isHold && parts.length >= 6) {
          // Hold note end time is in the extras field: endTime:hitSample
          const extras = parts[5].split(":");
          endTime = parseInt(extras[0], 10) || time;
        }

        notes.push({ column: Math.min(column, circleSize - 1), time, endTime, isHold });
      }
    }
  }

  // Calculate BPM from first timing point
  const bpm = timingPoints.length > 0 ? Math.round(60000 / timingPoints[0].beatLength) : 0;

  // Total length = last note's end time
  const totalLength = notes.length > 0
    ? Math.max(...notes.map((n) => n.endTime))
    : 0;

  return {
    title,
    artist,
    version,
    creator,
    keyCount: Math.round(circleSize),
    od: overallDifficulty,
    bpm,
    notes: notes.sort((a, b) => a.time - b.time),
    totalLength,
    audioFilename,
    previewTime,
    backgroundFilename,
  };
}
