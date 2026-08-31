// The Skills tab plays explorer's control state, kept across visits.
//
// These are view preferences, not data: which skill you read a profile by,
// whether you care about ranked charts, how many rates of one chart you want
// to see. Re-picking all six on every profile is the whole reason they are
// here, so they live in their own small localStorage key rather than in the
// country-keyed `mania-hub-cache-v5` blob, which is data with a TTL.

export const SKILL_PLAYS_PREFS_STORAGE_KEY = "mania-hub-skill-plays-prefs-v1";

/** How many plays of one chart a list may repeat; 0 is no cap. */
export const SKILL_PLAYS_RATE_CAPS = [0, 1, 2, 3] as const;

export interface SkillPlaysPrefs {
  /**
   * The keymode last shown, or null before anything has been. It is only a
   * starting point: a profile that has no rating for it falls back to the one
   * it does have, and that fallback is what gets stored next - so this tracks
   * the last keymode actually read, not a keymode you can pin.
   */
  keyCount: number | null;
  /** An MSD axis key ("Overall", "Technical", "pattern:jack", ...). */
  axis: string;
  side: "rc" | "ln";
  sort: "rating" | "recent";
  hideRanked: boolean;
  maxPerChart: number;
  /**
   * Dan list only: whether the plays the clear rules turned away are listed
   * beside the clears. On by default, because a list that silently omits them
   * is the list every other dan surface already shows.
   */
  showRejected: boolean;
}

export const DEFAULT_SKILL_PLAYS_PREFS: SkillPlaysPrefs = {
  keyCount: null,
  axis: "Overall",
  side: "rc",
  sort: "rating",
  hideRanked: false,
  maxPerChart: 0,
  showRejected: true,
};

/**
 * Every field independently, so one bad value cannot cost the other five.
 *
 * The axis is only checked for shape here: which axes exist depends on the
 * keymode being read, and the explorer already falls back to Overall when the
 * stored one is not among them.
 */
export function normalizeSkillPlaysPrefs(raw: unknown): SkillPlaysPrefs {
  const value = raw != null && typeof raw === "object" ? raw as Record<string, unknown> : {};
  const keyCount = Number(value.keyCount);
  const maxPerChart = Number(value.maxPerChart);
  return {
    keyCount: Number.isInteger(keyCount) && keyCount > 0 && keyCount <= 18 ? keyCount : null,
    axis: typeof value.axis === "string" && value.axis.trim() !== "" ? value.axis : DEFAULT_SKILL_PLAYS_PREFS.axis,
    side: value.side === "ln" ? "ln" : "rc",
    sort: value.sort === "recent" ? "recent" : "rating",
    hideRanked: value.hideRanked === true,
    // Defaults on, so an entry written before this existed keeps showing them.
    showRejected: value.showRejected !== false,
    maxPerChart: (SKILL_PLAYS_RATE_CAPS as readonly number[]).includes(maxPerChart) ? maxPerChart : 0,
  };
}

export function readSkillPlaysPrefs(): SkillPlaysPrefs {
  if (typeof window === "undefined") return { ...DEFAULT_SKILL_PLAYS_PREFS };
  try {
    const stored = window.localStorage.getItem(SKILL_PLAYS_PREFS_STORAGE_KEY);
    return normalizeSkillPlaysPrefs(stored ? JSON.parse(stored) : null);
  } catch {
    return { ...DEFAULT_SKILL_PLAYS_PREFS };
  }
}

export function writeSkillPlaysPrefs(prefs: SkillPlaysPrefs): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(SKILL_PLAYS_PREFS_STORAGE_KEY, JSON.stringify(normalizeSkillPlaysPrefs(prefs)));
  } catch {
    // Quota or privacy mode. The controls still work for this session.
  }
}
