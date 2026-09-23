export const AUTH_COOKIE_NAME = "mania-hub-auth-v1";
export const AUTH_STATE_COOKIE_NAME = "mania-hub-oauth-state-v1";
export const AUTH_COOKIE_MAX_AGE_SECONDS = 30 * 24 * 60 * 60;
export const AUTH_STATE_COOKIE_MAX_AGE_SECONDS = 10 * 60;

export interface AuthViewer {
  id: number;
  username: string;
  avatarUrl: string;
  countryCode: string | null;
}

export interface AuthState {
  viewer: AuthViewer | null;
  isAdmin: boolean;
  canUseDevFeatures: boolean;
  canUseAdminFeatures: boolean;
  /* The viewer is one of the admin osu! ids, on any host. Teams are their
     preview until TEAMS_OPEN (see canSeeTeams). */
  teamsPreview: boolean;
  loginAvailable: boolean;
  loginSuggested: boolean;
}

export const ANONYMOUS_AUTH_STATE: AuthState = {
  viewer: null,
  isAdmin: false,
  canUseDevFeatures: false,
  canUseAdminFeatures: false,
  teamsPreview: false,
  loginAvailable: false,
  loginSuggested: false,
};

export function canUseDevFeatures(auth: AuthState | undefined | null): boolean {
  return auth?.canUseDevFeatures === true;
}

export function canUseAdminFeatures(auth: AuthState | undefined | null): boolean {
  return auth?.canUseAdminFeatures === true;
}

/* Teams (the pages, the Team pack, team links, missing team cards) are the
   owner's preview. Flip this together with the backend's TEAMS_OPEN. Owned
   team cards show to everyone either way. */
export const TEAMS_OPEN = false;

export function canSeeTeams(auth: AuthState | undefined | null): boolean {
  return TEAMS_OPEN || auth?.teamsPreview === true;
}

export function isAdmin(auth: AuthState | undefined | null): boolean {
  return auth?.isAdmin === true;
}

export function hasAuthCookieHeader(cookieHeader: string | null): boolean {
  if (!cookieHeader) return false;
  return cookieHeader
    .split(";")
    .some((part) => part.trim().startsWith(`${AUTH_COOKIE_NAME}=`));
}
