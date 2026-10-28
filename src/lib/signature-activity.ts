// The activity render's data: the last N weeks of the player's calendar,
// ending today in the zone the backend bucketed their days in. Kept apart from
// the renderer so the window and the streak can be tested without satori.

export interface SignatureActivityDayInput {
  date: string;
  scoreCount: number;
  sessionCount: number;
}

export interface SignatureActivityCell {
  date: string;
  plays: number;
}

export interface SignatureActivityWindow {
  /** Sunday-first columns, like the Activity tab. Days after today are null. */
  weeks: Array<Array<SignatureActivityCell | null>>;
  /** The week each month starts in, for the labels over the grid. */
  months: Array<{ week: number; label: string }>;
  weeklyPlays: number[];
  plays: number;
  activeDays: number;
  streak: number;
  /** Plays on a day that gets the full colour: two and a half typical sessions. */
  fullAt: number;
}

const MONTH_LABELS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function parseKey(key: string): Date {
  const [year, month, day] = key.split("-").map(Number);
  return new Date(Date.UTC(year!, (month || 1) - 1, day || 1));
}

function toKey(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function addDays(key: string, days: number): string {
  const date = parseKey(key);
  date.setUTCDate(date.getUTCDate() + days);
  return toKey(date);
}

/** Today as YYYY-MM-DD in the given IANA zone. */
export function activityTodayKey(timeZone: string, now = Date.now()): string {
  try {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone, year: "numeric", month: "2-digit", day: "2-digit",
    }).formatToParts(new Date(now));
    const part = (type: string) => parts.find((entry) => entry.type === type)?.value ?? "";
    return `${part("year")}-${part("month")}-${part("day")}`;
  } catch {
    return new Date(now).toISOString().slice(0, 10);
  }
}

/** The first day the window can show, for deciding which years to fetch. */
export function activityWindowStart(todayKey: string, weekCount: number): string {
  const weekday = parseKey(todayKey).getUTCDay();
  return addDays(todayKey, -weekday - (weekCount - 1) * 7);
}

// The current day is still in progress: an empty today does not end it.
function activityStreak(byDate: Map<string, SignatureActivityDayInput>, todayKey: string): number {
  let streak = 0;
  let cursor = (byDate.get(todayKey)?.scoreCount ?? 0) > 0 ? todayKey : addDays(todayKey, -1);
  while ((byDate.get(cursor)?.scoreCount ?? 0) > 0) {
    streak++;
    cursor = addDays(cursor, -1);
  }
  return streak;
}

function activityFullAt(plays: number, sessions: number, activeDays: number): number {
  const typicalSession = sessions > 0 ? plays / sessions : activeDays > 0 ? plays / activeDays : 1;
  return Math.max(1, Math.round(typicalSession * 2.4));
}

export function buildSignatureActivityWindow(
  days: SignatureActivityDayInput[],
  todayKey: string,
  weekCount: number,
): SignatureActivityWindow {
  const byDate = new Map(days.map((day) => [day.date, day]));
  const start = activityWindowStart(todayKey, weekCount);
  const weeks: SignatureActivityWindow["weeks"] = [];
  const months: SignatureActivityWindow["months"] = [];
  const weeklyPlays: number[] = [];
  let plays = 0;
  let sessions = 0;
  let activeDays = 0;

  for (let week = 0; week < weekCount; week++) {
    const column: Array<SignatureActivityCell | null> = [];
    let weekPlays = 0;
    for (let weekday = 0; weekday < 7; weekday++) {
      const date = addDays(start, week * 7 + weekday);
      if (date > todayKey) {
        column.push(null);
        continue;
      }
      const day = byDate.get(date);
      const count = Math.max(0, day?.scoreCount ?? 0);
      column.push({ date, plays: count });
      weekPlays += count;
      plays += count;
      sessions += Math.max(0, day?.sessionCount ?? 0);
      if (count > 0) activeDays++;
      // A label sits on the week the month's first day falls in. The first
      // column gets one only in the month's first week, so it never lands
      // within three columns of the next label.
      if (date.endsWith("-01") || (week === 0 && weekday === 0 && Number(date.slice(8)) <= 7)) {
        months.push({ week, label: MONTH_LABELS[Number(date.slice(5, 7)) - 1]! });
      }
    }
    weeks.push(column);
    weeklyPlays.push(weekPlays);
  }

  return {
    weeks,
    months,
    weeklyPlays,
    plays,
    activeDays,
    streak: activityStreak(byDate, todayKey),
    fullAt: activityFullAt(plays, sessions, activeDays),
  };
}

export interface SignatureActivityMonth {
  label: string;
  /** Sunday-first rows. Days outside the month are null, days after today future. */
  rows: Array<Array<(SignatureActivityCell & { day: number; future: boolean }) | null>>;
  plays: number;
  activeDays: number;
  streak: number;
  fullAt: number;
}

const MONTH_NAMES = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

/* The calendar month today falls in. The streak reads every day given, so it
   can run back past the first of the month. */
export function buildSignatureActivityMonth(
  days: SignatureActivityDayInput[],
  todayKey: string,
): SignatureActivityMonth {
  const byDate = new Map(days.map((day) => [day.date, day]));
  const first = `${todayKey.slice(0, 8)}01`;
  const firstDate = parseKey(first);
  const length = new Date(Date.UTC(firstDate.getUTCFullYear(), firstDate.getUTCMonth() + 1, 0)).getUTCDate();
  const lead = firstDate.getUTCDay();
  const rows: SignatureActivityMonth["rows"] = [];
  let plays = 0;
  let sessions = 0;
  let activeDays = 0;

  for (let slot = 0; slot < Math.ceil((lead + length) / 7) * 7; slot++) {
    if (slot % 7 === 0) rows.push([]);
    const day = slot - lead + 1;
    if (day < 1 || day > length) {
      rows[rows.length - 1]!.push(null);
      continue;
    }
    const date = addDays(first, day - 1);
    const future = date > todayKey;
    const entry = future ? undefined : byDate.get(date);
    const count = Math.max(0, entry?.scoreCount ?? 0);
    rows[rows.length - 1]!.push({ date, plays: count, day, future });
    plays += count;
    sessions += Math.max(0, entry?.sessionCount ?? 0);
    if (count > 0) activeDays++;
  }

  return {
    label: MONTH_NAMES[firstDate.getUTCMonth()]!,
    rows,
    plays,
    activeDays,
    streak: activityStreak(byDate, todayKey),
    fullAt: activityFullAt(plays, sessions, activeDays),
  };
}
