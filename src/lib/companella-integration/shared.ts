/*
 * Types and constants shared by the Companella page, its server functions and
 * the reference client. No server-only imports: this module is safe to pull
 * into the browser bundle.
 */

/** What can cross a server-function boundary: plain JSON, nothing else. */
export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

export const COMPANELLA_API_PREFIX = "/api/integrations/companella/v1";
export const COMPANELLA_PROTOCOL_VERSION = 1;

/** The fixed route map. A public path resolves to exactly one backend route;
 *  nothing derives a destination from a header or a client-supplied value. */
export const COMPANELLA_NATIVE_ROUTES = {
  capabilities: "capabilities",
  token: "oauth/token",
  revoke: "oauth/revoke",
  me: "me",
  submissions: "submissions",
  submissionRead: "submissions/:id",
  submissionReplay: "submissions/:id/replay",
  submissionBeatmap: "submissions/:id/beatmap",
  submissionComplete: "submissions/:id/complete",
} as const;

export type SubmissionState =
  | "awaiting_assets" | "queued" | "validating" | "analyzing"
  | "accepted" | "deferred" | "rejected" | "expired" | "deleted";

export type IdentityState = "name_matches_account" | "name_mismatch" | "identity_unresolved";
export type CompletionState = "consistent_with_completed_play" | "incomplete" | "unknown";
export type ReviewState = "clear" | "flagged" | "quarantined";
export type AnalysisState = "supported" | "unsupported" | "pending" | "failed_retryable";

export interface CompanellaInstallation {
  id: string;
  displayName: string;
  clientId: string;
  platformHint: string | null;
  scopes: string[];
  status: "active" | "revoked";
  consentCharts: boolean;
  approvedAt: string;
  lastSeenAt: string | null;
  lastSeenCountry: string | null;
  revokedAt: string | null;
}

export interface CompanellaScore {
  id: string;
  userId: number;
  installationId: string;
  submissionId: string;
  chartSha256: string;
  playerName: string;
  identityState: IdentityState;
  completionState: CompletionState;
  reviewState: ReviewState;
  provenance: string;
  clientKind: "native" | "test";
  mods: string[];
  runtimeRate: number;
  scoreV2: boolean;
  totalScore: number;
  maxCombo: number;
  count300: number;
  count100: number;
  count50: number;
  countGeki: number;
  countKatu: number;
  countMiss: number;
  stableAccuracy: number | null;
  scoreV2Accuracy: number | null;
  onlineScoreId: string | null;
  playedAt: string | null;
  receivedAt: string;
}

export interface CompanellaAnalysis {
  state: AnalysisState;
  unratedReason: string | null;
  keyCount: number | null;
  runtimeRate: number | null;
  goal: number | null;
  lnGoal: number | null;
  msd: Record<string, number> | null;
  ssr: Record<string, number> | null;
  chartDan: Record<string, JsonValue> | null;
  danEligible: boolean;
  danRejectReason: string | null;
  error: string | null;
  computedAt: string;
}

export interface CompanellaChartMatch {
  outcome: "matched" | "unmatched_in_index" | "ambiguous" | "deferred";
  relationship: "exact_file" | "strict_note_rate_copy" | "padded_family" | null;
  referenceBeatmapId: number | null;
  familyAlias: string | null;
  timeScale: number | null;
  timeOffsetMs: number | null;
  relativeRate: number | null;
  unmatchedNoteCount: number | null;
  maxTimingErrorMs: number | null;
  gameplaySettingDifferences: string[];
  notes: string | null;
  /** The upload's relative rate against each family member it matched, by beatmap id. */
  memberRates?: Record<string, number>;
}

/** What the replay's key presses say, beside what its header says. */
export interface CompanellaScoreTiming {
  fileOd: number;
  /** The OD the rating judged at: the original map's when the chart is recognised. */
  ratingOd: number;
  pressTarget: number;
  lnTarget: number;
  replayAccuracy: number;
  headerAccuracy: number;
  headerGapPp: number;
  headerDisagrees: boolean;
}

export interface CompanellaChart {
  sha256: string;
  md5: string;
  keyCount: number | null;
  noteCount: number | null;
  od: number | null;
  totalLengthMs: number | null;
  title: string | null;
  artist: string | null;
  creator: string | null;
  version: string | null;
  shared: boolean;
  declaredBeatmapId: number | null;
}

export interface CompanellaSubmissionRow {
  submission_id: string;
  state: SubmissionState;
  needs_replay: boolean;
  needs_beatmap: boolean;
  expires_at: string;
  error: { code: string; message: string | null } | null;
  local_score_id: string | null;
  created_at: string;
  updated_at: string;
  capture_kind: string;
  client_kind: "native" | "test";
  chart_md5: string;
  score: CompanellaScore | null;
  analysis: CompanellaAnalysis | null;
}

export interface CompanellaPreviewMode {
  keyCount: number;
  official: Record<string, number>;
  preview: Record<string, number>;
  contributingLocalPlays: number;
}

export interface CompanellaPreview {
  policy: string;
  version: number;
  baselineVersion: number | null;
  baselineComplete: boolean;
  modes: CompanellaPreviewMode[];
  excluded: Array<{ localScoreId: string; reason: string; detail?: string }>;
  contributing: Array<{ localScoreId: string; keyCount: number; rate: number; overall: number; familyIdentity: string }>;
  computedAt: string;
}

export interface CompanellaSecurityEvent {
  id: number;
  kind: string;
  severity: "info" | "notice" | "review";
  country: string | null;
  detail: Record<string, JsonValue>;
  installationId: string | null;
  reviewerDecision: string | null;
  createdAt: string;
}

export interface CompanellaAccess {
  /** The integration is switched on for this deployment at all. */
  enabled: boolean;
  /** This viewer may connect installations: current beta membership. */
  allowed: boolean;
  /** This viewer has approved an installation before, so has plays and
      installations to manage even after leaving the beta. */
  hasData: boolean;
  signedIn: boolean;
  /** The beta-only browser test client is registered. */
  testClientEnabled: boolean;
  environment: string;
  /** Storage is actually usable; false means uploads would fail. */
  storageReady: boolean;
  backendReachable: boolean;
}

/** Display-only: the effective speed a play ran at, relative to its reference. */
export function effectiveSpeed(relativeRate: number | null, runtimeRate: number): number {
  return Number(((relativeRate ?? 1) * runtimeRate).toFixed(3));
}

export function describeMatchOutcome(match: CompanellaChartMatch | null): string {
  if (!match) return "Not checked yet";
  switch (match.outcome) {
    case "matched":
      return match.relationship === "strict_note_rate_copy" ? "Rate copy of a known chart" : "Close to a known chart";
    case "ambiguous":
      return "Matches more than one known chart";
    case "deferred":
      return "Still checking";
    default:
      return "Not found in the index";
  }
}

/** The signed-in name as the manage hop's header value. Cut to length first,
    then percent-encoded, so the cut can never land inside an escape sequence;
    the backend decodes it once on arrival. */
export function encodeActorName(username: string): string {
  return encodeURIComponent(Array.from(username.trim()).slice(0, 60).join(""));
}
