// Storyboard trigger (T) support.
//
// A triggered command group runs every time a matching gameplay event happens
// inside the trigger's window, with its command times relative to the moment
// it fired. The only triggers a mania replay can resolve are the HitSound
// ones; Passing/Failing depend on a health bar the viewer does not simulate.
//
// Firings are resolved from the chart's hit objects at parse time rather than
// from the player's actual key presses. osu! plays a note's samples when it is
// hit, so a real firing sits within the hit window of the note time, and a
// missed note fires nothing. Sampling the chart instead keeps the compiled
// storyboard static (the video exporter reuses it) and stays within a few tens
// of milliseconds of the played timing.

// Trigger names follow HitSound(SampleSet)(AdditionsSampleSet)(Addition)(CustomSampleSet),
// every part optional: "HitSound" fires on any note, "HitSoundSoftWhistle" on
// a soft-bank note carrying a whistle, "HitSoundAllSoftClap3" on a clap from
// the soft additions bank at custom sample index 3. "All" means "any".
const HITSOUND_TRIGGER_PATTERN =
  /^hitsound(all|normal|soft|drum)?(all|normal|soft|drum)?(whistle|finish|clap)?(\d+)?$/;

export type StoryboardSampleBank = "normal" | "soft" | "drum";

const ADDITION_BITS: Record<string, number> = { whistle: 2, finish: 4, clap: 8 };

export interface StoryboardHitsoundEvent {
  time: number;
  // Bank of the note's hitnormal.
  bank: StoryboardSampleBank;
  // Bank of the note's whistle/finish/clap additions.
  additionBank: StoryboardSampleBank;
  // Addition bitmask (whistle 2, finish 4, clap 8).
  additions: number;
  // Custom sample index.
  index: number;
}

export interface StoryboardHitsoundFilter {
  // null on any of these means "matches anything".
  bank: StoryboardSampleBank | null;
  additionBank: StoryboardSampleBank | null;
  // 0 matches any note; otherwise the note must carry this addition bit.
  addition: number;
  index: number | null;
}

// Minimal view of a parsed chart note; matches ManiaNote structurally.
export interface StoryboardHitsoundSourceNote {
  time: number;
  sample?: {
    bank: StoryboardSampleBank;
    additionBank: StoryboardSampleBank;
    additions: number;
    index: number;
  };
}

function parseSampleBank(token: string | undefined): StoryboardSampleBank | null {
  if (!token || token === "all") return null;
  return token as StoryboardSampleBank;
}

export function parseStoryboardHitsoundTrigger(name: string): StoryboardHitsoundFilter | null {
  const match = HITSOUND_TRIGGER_PATTERN.exec(name.trim().toLowerCase());
  if (!match) return null;
  const index = match[4] ? parseInt(match[4], 10) : null;
  return {
    bank: parseSampleBank(match[1]),
    additionBank: parseSampleBank(match[2]),
    addition: match[3] ? ADDITION_BITS[match[3]] : 0,
    index: index != null && Number.isFinite(index) ? index : null,
  };
}

// Hit objects sorted by time, one event per note head. Hold tails carry no
// samples in mania, so they fire nothing.
export function buildStoryboardHitsoundEvents(
  notes: readonly StoryboardHitsoundSourceNote[],
): StoryboardHitsoundEvent[] {
  const events: StoryboardHitsoundEvent[] = [];
  for (const note of notes) {
    if (!Number.isFinite(note.time)) continue;
    const sample = note.sample;
    events.push({
      time: note.time,
      bank: sample?.bank ?? "normal",
      additionBank: sample?.additionBank ?? "normal",
      additions: sample?.additions ?? 0,
      index: sample?.index ?? 0,
    });
  }
  events.sort((a, b) => a.time - b.time);
  return events;
}

function matchesFilter(event: StoryboardHitsoundEvent, filter: StoryboardHitsoundFilter): boolean {
  if (filter.bank !== null && event.bank !== filter.bank) return false;
  if (filter.additionBank !== null && event.additionBank !== filter.additionBank) return false;
  if (filter.addition !== 0 && (event.additions & filter.addition) === 0) return false;
  if (filter.index !== null && event.index !== filter.index) return false;
  return true;
}

// Times the group fires at, in order. Simultaneous matching notes (chords) are
// one firing. The window is start-inclusive and end-exclusive, so back-to-back
// trigger windows never both fire on the note at their shared boundary.
export function collectStoryboardTriggerTimes(
  events: readonly StoryboardHitsoundEvent[],
  filter: StoryboardHitsoundFilter,
  startTime: number,
  endTime: number,
  limit: number,
): number[] {
  const times: number[] = [];
  if (events.length === 0 || endTime <= startTime) return times;

  // First event at or after the window start.
  let lo = 0;
  let hi = events.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (events[mid].time < startTime) lo = mid + 1;
    else hi = mid;
  }

  for (let i = lo; i < events.length && times.length < limit; i++) {
    const event = events[i];
    if (event.time >= endTime) break;
    if (!matchesFilter(event, filter)) continue;
    if (times.length > 0 && times[times.length - 1] === event.time) continue;
    times.push(event.time);
  }
  return times;
}
