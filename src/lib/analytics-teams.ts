// Detail for the /team/<id> pageviews, so the admin activity feed reads
// `opened Team Name` instead of a bare numeric path.
//
// The route's loader only runs under SSR, so on a client navigation the team's
// data arrives after the pageview fires. A link hands the name forward the way
// the community cards do; a hard load has the loader's snapshot in time.
const TEAM_NAME_KEY_PREFIX = "mania-hub-team-name-v1:";
const MAX_NAME_CHARS = 80;

export function rememberTeamName(id: number | string, name: string): void {
  const key = String(id);
  if (!key || !name || typeof window === "undefined") return;
  try {
    window.sessionStorage.setItem(`${TEAM_NAME_KEY_PREFIX}${key}`, name.slice(0, MAX_NAME_CHARS));
  } catch {
    // sessionStorage can be unavailable; the id still identifies the team.
  }
}

function readTeamName(id: string): string | null {
  if (!id || typeof window === "undefined") return null;
  try {
    const stored = window.sessionStorage.getItem(`${TEAM_NAME_KEY_PREFIX}${id}`);
    return stored && stored.trim() ? stored : null;
  } catch {
    return null;
  }
}

/* The numeric id out of a /team/<id> path. */
export function teamIdFromPath(pathname: string): string {
  if (!pathname.startsWith("/team/")) return "";
  const raw = pathname.slice("/team/".length).split("/")[0] ?? "";
  return /^\d+$/.test(raw) ? raw : "";
}

/** Pageview properties for /team/<id>. */
export function getTeamDetailPageviewProperties(pathname: string): Record<string, unknown> {
  const id = teamIdFromPath(pathname);
  if (!id) return {};
  const props: Record<string, unknown> = { team_id: id };
  const name = readTeamName(id);
  if (name) props.team_name = name;
  return props;
}
