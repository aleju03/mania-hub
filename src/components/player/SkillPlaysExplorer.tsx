// The Skills tab's plays explorer: the rated plays behind a profile, listed
// rather than summarized.
//
// The skill tiles answer "how good is this player at X" and the dan chips
// answer "what dan are they". Neither answers "which plays say so, and why is
// the one I remember setting not in there" - that is what this surface is for,
// so it is built around filtering and ordering a list, not around a headline.
//
// Two sources, deliberately filtered in two different places:
//   MSD  - /skill-plays, one 200-play cohort for each ordering.
//   Dan  - /dan-evidence, merged from the best/newest 200 clears and rejected
//          plays into the same bounded 200-play cohort.
//
// The cohort is fetched once, cached briefly, filtered in memory, and revealed
// 50 rows at a time. Controls that only rearrange or narrow it never wait on a
// round trip; changing the actual subject (keymode/skill/side) loads a new one.
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Ban, ChevronDown, RefreshCw, SlidersHorizontal } from "lucide-react";
import { Trans, useLingui } from "@lingui/react/macro";
import {
  fetchLivePlayerDanEvidenceDirect,
  fetchLivePlayerSkillPlaysDirect,
  loadLiveMapSearchEntry,
  peekLiveMapSearchEntry,
  prefetchLiveMapSearchEntry,
  type LiveMapSearchEntry,
  type LivePlayerDanEvidencePlay,
  type LivePlayerDanRejectedPlay,
  type LivePlayerSkillPlay,
} from "#/lib/live-backend";
import type { MyDataSkillMode } from "#/lib/my-data";
import { formatAccuracy, formatAccuracyAgainst, formatPP, formatTimeAgo, formatTimeAgoTooltip } from "#/lib/format";
import { DAN_SKILLSET_META, OVERALL_AXIS_META, skillModeEntries, type SkillAxisMeta } from "#/lib/skill-axes";
import { beatmapStatusPill } from "#/lib/beatmap-status";
import { Skeleton } from "#/components/ui/LoadingSkeleton";
import { ModBadge } from "#/components/ui/ModBadge";
import { ModFilterChip } from "#/components/ui/ModFilterChip";
import { MapDetailModal } from "#/components/maps/MapDetailModal";
import { danBareLabel, danTierColor, danTierSuffix, getDanImageSrc } from "#/lib/dan-images";
import {
  SKILL_PLAYS_RATE_CAPS,
  readSkillPlaysPrefs,
  writeSkillPlaysPrefs,
} from "#/lib/skill-plays-prefs";
import { rateModFor, stubEntry } from "./SkillPlaysModal";
import { track } from "#/lib/analytics";
import { useLocale } from "#/lib/locale-context";
import {
  cycleModFilterMode,
  matchesModAcronymFilter,
  relevantModFilterKeys,
  reverseCycleModFilterMode,
  type ModFilterState,
} from "#/lib/mod-filter";

const PLAYS_COHORT_SIZE = 200;
const PLAYS_REVEAL_STEP = 50;
const COHORT_CACHE_TTL_MS = 60_000;
const COHORT_CACHE_MAX_ENTRIES = 64;
// The refresh button answers every click, but asks the backend at most this
// often. Clicks inside the window only replay the spin.
const REFRESH_MIN_INTERVAL_MS = 3_000;

export type SkillPlaysExplorerView = "msd" | "dan";

/** A clear and a turned-away play share a row shape; only the tail differs. */
type DanRow =
  | { kind: "clear"; play: LivePlayerSkillPlay; dan: number | null; clear: LivePlayerDanEvidencePlay }
  | { kind: "rejected"; play: LivePlayerSkillPlay; dan: number | null; rejected: LivePlayerDanRejectedPlay };

interface CohortCacheEntry<T> {
  expiresAt: number;
  promise: Promise<T>;
  value?: T;
}

const msdCohortCache = new Map<string, CohortCacheEntry<LivePlayerSkillPlay[]>>();
const danCohortCache = new Map<string, CohortCacheEntry<DanRow[]>>();

function loadCachedCohort<T>(
  cache: Map<string, CohortCacheEntry<T>>,
  key: string,
  loader: () => Promise<T>,
): Promise<T> {
  const now = Date.now();
  const existing = cache.get(key);
  if (existing && existing.expiresAt > now) return existing.promise;
  if (existing) cache.delete(key);
  while (cache.size >= COHORT_CACHE_MAX_ENTRIES) {
    const oldest = cache.keys().next().value as string | undefined;
    if (oldest == null) break;
    cache.delete(oldest);
  }
  const entry: CohortCacheEntry<T> = {
    expiresAt: now + COHORT_CACHE_TTL_MS,
    promise: Promise.resolve(undefined as T),
  };
  entry.promise = loader()
    .then((value) => {
      entry.value = value;
      return value;
    })
    .catch((error) => {
      if (cache.get(key) === entry) cache.delete(key);
      throw error;
    });
  cache.set(key, entry);
  return entry.promise;
}

function peekCachedCohort<T>(cache: Map<string, CohortCacheEntry<T>>, key: string): T | undefined {
  const entry = cache.get(key);
  if (!entry || entry.expiresAt <= Date.now()) {
    if (entry) cache.delete(key);
    return undefined;
  }
  return entry.value;
}

function msdCohortKey(userId: number, keyCount: number, axis: string, sort: "rating" | "recent"): string {
  return `${userId}:${keyCount}:${axis}:${sort}`;
}

function loadMsdCohort(
  userId: number,
  keyCount: number,
  axis: string,
  sort: "rating" | "recent",
  options: { fresh?: boolean } = {},
): Promise<LivePlayerSkillPlay[]> {
  const key = msdCohortKey(userId, keyCount, axis, sort);
  if (options.fresh) msdCohortCache.delete(key);
  return loadCachedCohort(msdCohortCache, key, async () => {
    const page = await fetchLivePlayerSkillPlaysDirect(userId, keyCount, axis, {
      limit: PLAYS_COHORT_SIZE,
      offset: 0,
      sort,
      ...(options.fresh ? { fresh: true } : {}),
    });
    return page.items.slice(0, PLAYS_COHORT_SIZE);
  });
}

function compareDanRows(sort: "rating" | "recent", left: DanRow, right: DanRow): number {
  if (sort === "recent") {
    const leftAt = left.play.playedAt ?? "";
    const rightAt = right.play.playedAt ?? "";
    if (leftAt !== rightAt) {
      if (leftAt === "") return 1;
      if (rightAt === "") return -1;
      return rightAt.localeCompare(leftAt);
    }
  }
  return (right.dan ?? -1) - (left.dan ?? -1) || left.play.beatmapId - right.play.beatmapId;
}

function danCohortKey(userId: number, keyCount: number, side: "rc" | "ln", sort: "rating" | "recent"): string {
  return `${userId}:${keyCount}:${side}:${sort}`;
}

function loadDanCohort(
  userId: number,
  keyCount: number,
  side: "rc" | "ln",
  sort: "rating" | "recent",
  options: { fresh?: boolean } = {},
): Promise<DanRow[]> {
  const key = danCohortKey(userId, keyCount, side, sort);
  if (options.fresh) danCohortCache.delete(key);
  return loadCachedCohort(danCohortCache, key, async () => {
    const payload = await fetchLivePlayerDanEvidenceDirect(userId, keyCount, side, {
      limit: PLAYS_COHORT_SIZE,
      includeRejected: true,
      rejectedLimit: PLAYS_COHORT_SIZE,
      sort,
      ...(options.fresh ? { fresh: true } : {}),
    });
    const rows: DanRow[] = [
      ...payload.clears.map((clear): DanRow => ({ kind: "clear", play: clear.play, dan: clear.creditedDan, clear })),
      ...(payload.rejected ?? []).map((rejected): DanRow => ({
        kind: "rejected",
        play: rejected.play,
        dan: rejected.chartDan,
        rejected,
      })),
    ];
    return rows.sort((left, right) => compareDanRows(sort, left, right)).slice(0, PLAYS_COHORT_SIZE);
  });
}

function oppositeSort(sort: "rating" | "recent"): "rating" | "recent" {
  return sort === "rating" ? "recent" : "rating";
}

/** Warm the view a pointer or keyboard focus is about to open. */
export function prefetchSkillPlaysExplorerView(
  userId: number,
  modes: MyDataSkillMode[],
  view: SkillPlaysExplorerView,
): void {
  const prefs = readSkillPlaysPrefs();
  const mode = modes.find((entry) => entry.keyCount === prefs.keyCount) ?? modes[0];
  if (!mode) return;
  const sort = prefs.sort;
  if (view === "dan") {
    void loadDanCohort(userId, mode.keyCount, prefs.side, sort)
      .then(() => loadDanCohort(userId, mode.keyCount, prefs.side, oppositeSort(sort)))
      .catch(() => {});
    return;
  }
  const axes = [OVERALL_AXIS_META, ...skillModeEntries(mode)];
  const axis = axes.some((option) => axisKeyOf(option) === prefs.axis) ? prefs.axis : OVERALL_AXIS_META.key;
  void loadMsdCohort(userId, mode.keyCount, axis, sort)
    .then(() => loadMsdCohort(userId, mode.keyCount, axis, oppositeSort(sort)))
    .catch(() => {});
}

interface SkillPlaysExplorerProps {
  userId: number;
  username: string;
  /** The keymodes this profile has a rating for, in the panel's own order. */
  modes: MyDataSkillMode[];
  view: SkillPlaysExplorerView;
  /** Fired when a list read settles, either way. The panel holds its height
   *  across a view switch and needs to know when to let go of it. */
  onListSettled?: () => void;
}

export function SkillPlaysExplorer({ userId, username, modes, view, onListSettled }: SkillPlaysExplorerProps) {
  const { t, i18n } = useLingui();
  // Read once, on mount. Safe to touch localStorage in the initializer here
  // because this panel only mounts after a click on the view switch, never
  // during SSR, so there is no server render for it to disagree with.
  const [storedPrefs] = useState(readSkillPlaysPrefs);
  const [keyCount, setKeyCount] = useState(() => storedPrefs.keyCount ?? modes[0]?.keyCount ?? 4);
  // Axis and side live here rather than in the two lists so the whole toolbar
  // is one row of controls the reader scans once, instead of a second bar
  // appearing under the first when the view changes.
  const [axis, setAxis] = useState<string>(storedPrefs.axis);
  const [side, setSide] = useState<"rc" | "ln">(storedPrefs.side);
  const [sort, setSort] = useState<"rating" | "recent">(storedPrefs.sort);
  const [hideRanked, setHideRanked] = useState(storedPrefs.hideRanked);
  const [maxPerChart, setMaxPerChart] = useState<number>(storedPrefs.maxPerChart);
  const [showRejected, setShowRejected] = useState(storedPrefs.showRejected);
  // The mod filter is not stored with the rest: it is a question about one
  // list ("only my rate-up plays"), not a way the reader likes this panel set
  // up, and a chip left on from last visit would silently thin a new one.
  const [modFilter, setModFilter] = useState<ModFilterState>({});
  // Reported by whichever list is mounted, from the cohort it actually holds,
  // so no chip is offered for a mod nothing in view was played with.
  const [availableMods, setAvailableMods] = useState<string[]>([]);
  // Three narrowing controls plus the order is four tracks, which is one row
  // on a desktop and four stacked ones on a phone, where they pushed the first
  // play off the screen. Narrow screens get them behind one button instead;
  // from sm up the disclosure is gone and they are simply on.
  const [showFilters, setShowFilters] = useState(false);
  // Refresh: the nonce tells the mounted list to fetch its cohort again past
  // every cache. It only moves when a request is actually made; the spin runs
  // on every click, so the button never looks like it ignored one.
  const [refreshNonce, setRefreshNonce] = useState(0);
  const [refreshSpinning, setRefreshSpinning] = useState(false);
  const lastRefreshAtRef = useRef(0);
  const refreshSpinTimerRef = useRef<number | null>(null);
  // The rating column travels with the play: the detail card prints the same
  // number the row did, under the same name, and the dan list's rows carry the
  // Overall rating their evidence payload rated them at.
  const [detail, setDetail] = useState<
    {
      play: LivePlayerSkillPlay;
      entry: LiveMapSearchEntry;
      status: "ready" | "pending" | "missing" | "error";
      ratingLabel: string;
      ratingColor: string;
    } | null
  >(null);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      if (refreshSpinTimerRef.current != null) window.clearTimeout(refreshSpinTimerRef.current);
    };
  }, []);

  const refresh = useCallback(() => {
    setRefreshSpinning(true);
    if (refreshSpinTimerRef.current != null) window.clearTimeout(refreshSpinTimerRef.current);
    refreshSpinTimerRef.current = window.setTimeout(() => {
      refreshSpinTimerRef.current = null;
      setRefreshSpinning(false);
    }, 700);
    const now = Date.now();
    if (now - lastRefreshAtRef.current < REFRESH_MIN_INTERVAL_MS) return;
    lastRefreshAtRef.current = now;
    setRefreshNonce((nonce) => nonce + 1);
  }, []);

  // A profile whose keymodes changed under us (a recompute landing while the
  // tab is open) must not keep a selection that no longer exists.
  useEffect(() => {
    if (modes.length > 0 && !modes.some((entry) => entry.keyCount === keyCount)) setKeyCount(modes[0].keyCount);
  }, [keyCount, modes]);

  const mode = modes.find((entry) => entry.keyCount === keyCount) ?? modes[0] ?? null;

  // An empty report is a cohort that has not landed yet far more often than it
  // is a player with no plays, so the chips (and any filter set on them) hold
  // across a keymode or skill switch instead of blinking out and back.
  const handleAvailableMods = useCallback((mods: string[]) => {
    if (mods.length === 0) return;
    setAvailableMods((current) => (current.length === mods.length && current.every((mod, index) => mod === mods[index]) ? current : mods));
  }, []);
  // A chip that stopped being on offer (another keymode, the other view) must
  // not keep filtering from off screen, where nothing could switch it back.
  useEffect(() => {
    setModFilter((current) => {
      const kept = Object.entries(current).filter(([mod]) => availableMods.includes(mod));
      return kept.length === Object.keys(current).length ? current : Object.fromEntries(kept);
    });
  }, [availableMods]);

  // What the button has to say for itself while the controls behind it are
  // closed: how many of them are currently thinning the list.
  const activeFilterCount = (maxPerChart !== 0 ? 1 : 0)
    + Object.keys(modFilter).length
    + (hideRanked ? 1 : 0)
    + (view === "dan" && !showRejected ? 1 : 0);

  const cycleMod = useCallback((mod: string, reverse: boolean) => {
    setModFilter((current) => {
      const next = reverse ? reverseCycleModFilterMode(current[mod]) : cycleModFilterMode(current[mod]);
      const { [mod]: _dropped, ...rest } = current;
      return next ? { ...rest, [mod]: next } : rest;
    });
  }, []);

  // Written back whenever any of them moves, including the corrections the two
  // effects above make: what is stored is the state the reader was last left
  // looking at, which is the only thing worth restoring.
  useEffect(() => {
    writeSkillPlaysPrefs({ keyCount, axis, side, sort, hideRanked, maxPerChart, showRejected });
  }, [axis, hideRanked, keyCount, maxPerChart, showRejected, side, sort]);

  // Which axes this keymode actually rates, so the picker never offers a list
  // that would come back empty. Overall leads: it is the one axis every
  // keymode has, and what a "best plays" list means before anyone narrows it.
  const axisOptions = useMemo<SkillAxisMeta[]>(
    () => (mode ? [OVERALL_AXIS_META, ...skillModeEntries(mode)] : [OVERALL_AXIS_META]),
    [mode],
  );
  useEffect(() => {
    if (!axisOptions.some((option) => axisKeyOf(option) === axis)) setAxis(OVERALL_AXIS_META.key);
  }, [axis, axisOptions]);
  const activeAxis = axisOptions.find((option) => axisKeyOf(option) === axis) ?? OVERALL_AXIS_META;

  /* What the reader is actually looking at, reported once per distinct list:
     which of the two views, in which keymode and skill (or dan side), and in
     which order. Sent from an effect rather than from the controls because
     the first list of a visit is opened by the tab strip above this component,
     not by anything in the toolbar, and it counts the same as a switch made in
     here. The key dedupes re-renders, so only a real change emits. */
  const trackedListRef = useRef<string | null>(null);
  const activeAxisKey = axisKeyOf(activeAxis);
  useEffect(() => {
    if (!mode) return;
    const listKey = view === "msd"
      ? `msd:${mode.keyCount}:${activeAxisKey}:${sort}`
      : `dan:${mode.keyCount}:${side}:${sort}`;
    if (trackedListRef.current === listKey) return;
    trackedListRef.current = listKey;
    track("skill_plays_view", {
      skill_plays_player: username,
      skill_plays_view: view,
      // The toolbar's own two labels, so the feed reads the way the page does.
      skill_plays_order: sort === "rating" ? "best" : "recent",
      skill_plays_keys: String(mode.keyCount),
      ...(view === "msd" ? { skill_plays_axis: activeAxisKey } : { skill_plays_side: side }),
    });
  }, [activeAxisKey, mode, side, sort, username, view]);

  const openDetail = useCallback((play: LivePlayerSkillPlay, rating: { label: string; color: string }) => {
    const context = { ratingLabel: rating.label, ratingColor: rating.color };
    // A hovered row answers from memory, so the card opens complete; otherwise
    // the stub carries it until the catalog request lands.
    const cached = peekLiveMapSearchEntry(play.beatmapId);
    if (cached !== undefined) {
      setDetail({ play, entry: cached ?? stubEntry(play), status: cached ? "ready" : "missing", ...context });
      return;
    }
    setDetail({ play, entry: stubEntry(play), status: "pending", ...context });
    loadLiveMapSearchEntry(play.beatmapId)
      .then((entry) => {
        if (!mountedRef.current) return;
        setDetail((current) => (
          current && current.play.beatmapId === play.beatmapId && current.status === "pending"
            ? { play, entry: entry ?? current.entry, status: entry ? "ready" : "missing", ...context }
            : current
        ));
      })
      .catch(() => {
        if (!mountedRef.current) return;
        setDetail((current) => (
          current && current.play.beatmapId === play.beatmapId && current.status === "pending"
            ? { ...current, status: "error" }
            : current
        ));
      });
  }, []);

  // Two rows, by what the control does rather than by how many there are.
  // The first picks what the list is OF and carries the emphasis (the active
  // skill wears its own color); the second is how the list is arranged and
  // stays muted, so five controls read as two decisions instead of five.
  const toolbar = (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-1.5">
        {modes.length > 1 ? (
          <Segmented
            ariaLabel={t`Keymode`}
            value={keyCount}
            options={modes.map((entry) => ({
              value: entry.keyCount,
              label: `${entry.keyCount}K`,
              onPrefetch: () => {
                if (view === "dan") {
                  void loadDanCohort(userId, entry.keyCount, side, sort).catch(() => {});
                  return;
                }
                const targetAxes = [OVERALL_AXIS_META, ...skillModeEntries(entry)];
                const targetAxis = targetAxes.some((option) => axisKeyOf(option) === axis) ? axis : OVERALL_AXIS_META.key;
                void loadMsdCohort(userId, entry.keyCount, targetAxis, sort).catch(() => {});
              },
            }))}
            onChange={setKeyCount}
          />
        ) : null}
        {view === "msd" ? (
          <PillGroup
            ariaLabel={t`Skill`}
            value={axis}
            options={axisOptions.map((option) => ({
              value: axisKeyOf(option),
              label: i18n._(option.labelMsg),
              color: option.color,
              onPrefetch: () => void loadMsdCohort(userId, mode?.keyCount ?? keyCount, axisKeyOf(option), sort).catch(() => {}),
            }))}
            onChange={setAxis}
          />
        ) : (
          <PillGroup
            ariaLabel={t`Side`}
            value={side}
            options={[
              { value: "rc" as const, label: t`Regular`, color: SIDE_COLOR.rc },
              { value: "ln" as const, label: t`LN`, color: SIDE_COLOR.ln },
            ].map((option) => ({
              ...option,
              onPrefetch: () => void loadDanCohort(userId, mode?.keyCount ?? keyCount, option.value, sort).catch(() => {}),
            }))}
            onChange={setSide}
          />
        )}
      </div>
      {/* Two rows on a phone (the order, then the filters it opens) and one
          wrapped row from sm up, where the disclosure is gone and all four
          tracks belong to the same line. */}
      <div className="space-y-2 sm:flex sm:flex-wrap sm:items-center sm:gap-x-3 sm:gap-y-1.5 sm:space-y-0">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
          <Segmented
            ariaLabel={t`Order`}
            value={sort}
            options={[
              {
                value: "rating" as const,
                label: t`Best`,
                onPrefetch: () => {
                  if (view === "msd") void loadMsdCohort(userId, mode?.keyCount ?? keyCount, axis, "rating").catch(() => {});
                  else void loadDanCohort(userId, mode?.keyCount ?? keyCount, side, "rating").catch(() => {});
                },
              },
              {
                value: "recent" as const,
                label: t`Recent`,
                onPrefetch: () => {
                  if (view === "msd") void loadMsdCohort(userId, mode?.keyCount ?? keyCount, axis, "recent").catch(() => {});
                  else void loadDanCohort(userId, mode?.keyCount ?? keyCount, side, "recent").catch(() => {});
                },
              },
            ]}
            onChange={setSort}
          />
          <FiltersToggle
            open={showFilters}
            activeCount={activeFilterCount}
            onToggle={() => setShowFilters((current) => !current)}
          />
          <button
            type="button"
            onClick={refresh}
            title={t`Refresh`}
            aria-label={t`Refresh`}
            className={`inline-flex h-[26px] w-[26px] cursor-pointer items-center justify-center text-osu-f1 transition-colors hover:text-osu-l1 ${CONTROL_TRACK_CLASS}`}
          >
            <RefreshCw size={12} className={refreshSpinning ? "animate-spin" : ""} />
          </button>
        </div>
        <div className={`${showFilters ? "flex" : "hidden"} flex-wrap items-center gap-x-3 gap-y-1.5 sm:flex`}>
          <RateCapControl value={maxPerChart} onChange={setMaxPerChart} />
          {availableMods.length > 1 ? <ModsControl mods={availableMods} modFilter={modFilter} onCycle={cycleMod} /> : null}
          {/* Both of these are the same decision asked twice, and together they
              are the common setting, so they share one label and one track. Only
              the dan list has plays it turned away, so only it offers the second. */}
          <HideControl
            options={[
              {
                key: "ranked",
                label: t`ranked`,
                title: t`Hide plays on ranked, approved and qualified charts`,
                pressed: hideRanked,
                onChange: () => setHideRanked((current) => !current),
              },
              ...(view === "dan"
                ? [{
                  key: "uncounted",
                  label: t`not counted`,
                  title: t`Hide the plays the dan rules turned away`,
                  pressed: !showRejected,
                  onChange: () => setShowRejected((current) => !current),
                }]
                : []),
            ]}
          />
        </div>
      </div>
    </div>
  );

  return (
    <div className="space-y-3">
      {toolbar}
      {mode == null ? (
        <div className="py-8 text-center text-sm text-osu-f1">{t`No rated keymode yet.`}</div>
      ) : view === "msd" ? (
        <MsdPlaysList
          userId={userId}
          username={username}
          keyCount={mode.keyCount}
          axis={axis}
          axisMeta={activeAxis}
          sort={sort}
          hideRanked={hideRanked}
          maxPerChart={maxPerChart}
          modFilter={modFilter}
          refreshNonce={refreshNonce}
          onAvailableMods={handleAvailableMods}
          onSettled={onListSettled}
          onOpen={openDetail}
        />
      ) : (
        <DanPlaysList
          userId={userId}
          keyCount={mode.keyCount}
          side={side}
          sort={sort}
          hideRanked={hideRanked}
          maxPerChart={maxPerChart}
          showRejected={showRejected}
          modFilter={modFilter}
          refreshNonce={refreshNonce}
          onAvailableMods={handleAvailableMods}
          onSettled={onListSettled}
          onOpen={openDetail}
        />
      )}
      {detail ? (
        <MapDetailModal
          entry={detail.entry}
          status={detail.status}
          onClose={() => setDetail(null)}
          play={{
            beatmapId: detail.play.beatmapId,
            username,
            accuracy: detail.play.accuracy,
            pp: detail.play.pp,
            rateMod: rateModFor(detail.play.rate, detail.play.rateMod),
            playedAt: detail.play.playedAt,
            source: detail.play.source,
            rating: detail.play.rating,
            ratingLabel: detail.ratingLabel,
            ratingColor: detail.ratingColor,
          }}
        />
      ) : null}
    </div>
  );
}

// --- MSD list -------------------------------------------------------------

function MsdPlaysList({
  userId,
  username,
  keyCount,
  axis,
  axisMeta,
  sort,
  hideRanked,
  maxPerChart,
  modFilter,
  refreshNonce,
  onAvailableMods,
  onSettled,
  onOpen,
}: {
  userId: number;
  username: string;
  keyCount: number;
  axis: string;
  axisMeta: SkillAxisMeta;
  sort: "rating" | "recent";
  hideRanked: boolean;
  maxPerChart: number;
  modFilter: ModFilterState;
  /** Bumped by the toolbar's refresh; a change fetches past every cache. */
  refreshNonce: number;
  onAvailableMods: (mods: string[]) => void;
  onSettled?: (() => void) | undefined;
  onOpen: (play: LivePlayerSkillPlay, rating: { label: string; color: string }) => void;
}) {
  const { t, i18n } = useLingui();
  const cacheKey = msdCohortKey(userId, keyCount, axis, sort);
  const [cohort, setCohort] = useState<LivePlayerSkillPlay[]>(() =>
    peekCachedCohort(msdCohortCache, cacheKey) ?? []);
  const [visibleLimit, setVisibleLimit] = useState(PLAYS_REVEAL_STEP);
  const [loading, setLoading] = useState(() => peekCachedCohort(msdCohortCache, cacheKey) == null);
  const [error, setError] = useState<string | null>(null);

  /* Which list this is, as opposed to how it is arranged. Changing the sort
     swaps between two cached 200-play cohorts. Changing the keymode or skill
     is a genuinely different list, so showing the outgoing rows under its
     heading would be a lie and that clears. */
  const listIdentity = `${keyCount}:${axis}`;
  const shownIdentity = useRef(listIdentity);
  // A refresh keeps the rows on screen (busy, not skeleton) and reads past the
  // cohort cache and the browser's; the other ordering's cache is dropped too,
  // so flipping Best/Recent after it does not show the older list.
  const seenRefreshNonce = useRef(refreshNonce);

  useEffect(() => {
    let cancelled = false;
    const fresh = seenRefreshNonce.current !== refreshNonce;
    seenRefreshNonce.current = refreshNonce;
    if (shownIdentity.current !== listIdentity) {
      shownIdentity.current = listIdentity;
      setCohort([]);
    }
    if (fresh) msdCohortCache.delete(msdCohortKey(userId, keyCount, axis, oppositeSort(sort)));
    const cached = fresh ? undefined : peekCachedCohort(msdCohortCache, cacheKey);
    if (cached) setCohort(cached);
    setLoading(fresh || cached == null);
    setError(null);
    loadMsdCohort(userId, keyCount, axis, sort, { fresh })
      .then((items) => {
        if (cancelled) return;
        setCohort(items);
      })
      .catch((fetchError) => {
        if (cancelled) return;
        setError(fetchError instanceof Error ? fetchError.message : t`Could not load these plays.`);
      })
      .finally(() => {
        if (cancelled) return;
        setLoading(false);
        onSettled?.();
        // Best/Recent is then a cache swap rather than a click-time request.
        void loadMsdCohort(userId, keyCount, axis, oppositeSort(sort), { fresh }).catch(() => {});
      });
    return () => { cancelled = true; };
  }, [axis, cacheKey, keyCount, listIdentity, onSettled, refreshNonce, sort, userId]);

  const modKey = modFilterKey(modFilter);
  useEffect(() => setVisibleLimit(PLAYS_REVEAL_STEP), [cacheKey, hideRanked, maxPerChart, modKey]);

  // The chips on offer come from the whole cohort, not from what the other
  // filters left, so narrowing by mod never removes the chip that would undo it.
  const cohortMods = useMemo(
    () => relevantModFilterKeys(cohort.flatMap((play) => {
      const mods = playModAcronyms(play);
      return mods ? [mods] : [];
    })),
    [cohort],
  );
  useEffect(() => { onAvailableMods(cohortMods); }, [cohortMods, onAvailableMods]);

  const filtered = useMemo(() => {
    const seenPerChart = new Map<number, number>();
    return cohort.filter((play) => {
      if (hideRanked && isRankedStatus(play.beatmapStatus ?? null)) return false;
      if (!matchesPlayModFilter(play, modFilter)) return false;
      if (maxPerChart > 0) {
        const seen = seenPerChart.get(play.beatmapId) ?? 0;
        if (seen >= maxPerChart) return false;
        seenPerChart.set(play.beatmapId, seen + 1);
      }
      return true;
    });
  }, [cohort, hideRanked, maxPerChart, modFilter]);
  const items = filtered.slice(0, visibleLimit);

  const axisLabel = i18n._(axisMeta.labelMsg);
  return (
    <div className="space-y-3">
      <p className="sr-only">{t`${username}'s rated ${axisLabel} plays`}</p>
      <ListShell
        loading={loading && items.length === 0}
        busy={loading && items.length > 0}
        error={error}
        empty={items.length === 0}
        emptyTitle={t`No plays match these filters`}
        shown={items.length}
        total={filtered.length}
        hidden={cohort.length - filtered.length}
        onShowMore={items.length < filtered.length
          ? () => setVisibleLimit((current) => Math.min(filtered.length, current + PLAYS_REVEAL_STEP))
          : null}
        loadingMore={false}
      >
        {items.map((play, index) => (
          <PlayRow
            key={rowKey(play, index)}
            play={play}
            position={index + 1}
            onOpen={() => onOpen(play, { label: axisLabel, color: axisMeta.color })}
            onPrefetch={() => prefetchLiveMapSearchEntry(play.beatmapId)}
            trailing={(
              <div className="w-14 shrink-0 text-right sm:w-16">
                <div className="text-base font-black leading-none tabular-nums sm:text-lg" style={{ color: axisMeta.color }}>
                  {play.rating.toFixed(2)}
                </div>
                <div className="mt-1 truncate text-[8px] font-semibold uppercase tracking-wide text-osu-f1">{axisLabel}</div>
              </div>
            )}
          />
        ))}
      </ListShell>
    </div>
  );
}

// --- Dan list -------------------------------------------------------------

function DanPlaysList({
  userId,
  keyCount,
  side,
  sort,
  hideRanked,
  maxPerChart,
  showRejected,
  modFilter,
  refreshNonce,
  onAvailableMods,
  onSettled,
  onOpen,
}: {
  userId: number;
  keyCount: number;
  side: "rc" | "ln";
  sort: "rating" | "recent";
  hideRanked: boolean;
  maxPerChart: number;
  showRejected: boolean;
  modFilter: ModFilterState;
  /** Bumped by the toolbar's refresh; a change fetches past every cache. */
  refreshNonce: number;
  onAvailableMods: (mods: string[]) => void;
  onSettled?: (() => void) | undefined;
  onOpen: (play: LivePlayerSkillPlay, rating: { label: string; color: string }) => void;
}) {
  const { t, i18n } = useLingui();
  // A dan row's own number is the dan; the rating the detail card shows is the
  // play's Overall SSR, which is what the evidence payload rated it at.
  const overallLabel = i18n._(OVERALL_AXIS_META.labelMsg);
  const cacheKey = danCohortKey(userId, keyCount, side, sort);
  const [cohort, setCohort] = useState<DanRow[]>(() => peekCachedCohort(danCohortCache, cacheKey) ?? []);
  const [visibleLimit, setVisibleLimit] = useState(PLAYS_REVEAL_STEP);
  // Which turned-away row has its reason open, if any. One at a time: the
  // reasons are a sentence each and a list of them is the wall of text the
  // block mark exists to replace.
  const [openReason, setOpenReason] = useState<string | null>(null);
  const [loading, setLoading] = useState(() => peekCachedCohort(danCohortCache, cacheKey) == null);
  const [error, setError] = useState<string | null>(null);
  const listIdentity = `${keyCount}:${side}`;
  const shownIdentity = useRef(listIdentity);
  const seenRefreshNonce = useRef(refreshNonce);

  useEffect(() => {
    let cancelled = false;
    const fresh = seenRefreshNonce.current !== refreshNonce;
    seenRefreshNonce.current = refreshNonce;
    if (shownIdentity.current !== listIdentity) {
      shownIdentity.current = listIdentity;
      setCohort([]);
    }
    if (fresh) danCohortCache.delete(danCohortKey(userId, keyCount, side, oppositeSort(sort)));
    const cached = fresh ? undefined : peekCachedCohort(danCohortCache, cacheKey);
    if (cached) setCohort(cached);
    setOpenReason(null);
    setLoading(fresh || cached == null);
    setError(null);
    loadDanCohort(userId, keyCount, side, sort, { fresh })
      .then((rows) => {
        if (cancelled) return;
        setCohort(rows);
      })
      .catch((fetchError) => {
        if (cancelled) return;
        setError(fetchError instanceof Error ? fetchError.message : t`Could not load these plays.`);
      })
      .finally(() => {
        if (cancelled) return;
        setLoading(false);
        onSettled?.();
        void loadDanCohort(userId, keyCount, side, oppositeSort(sort), { fresh }).catch(() => {});
      });
    return () => { cancelled = true; };
  }, [cacheKey, keyCount, listIdentity, onSettled, refreshNonce, side, sort, userId]);

  const modKey = modFilterKey(modFilter);
  useEffect(() => setVisibleLimit(PLAYS_REVEAL_STEP), [cacheKey, hideRanked, maxPerChart, showRejected, modKey]);

  const cohortMods = useMemo(
    () => relevantModFilterKeys(cohort.flatMap((row) => {
      const mods = playModAcronyms(row.play);
      return mods ? [mods] : [];
    })),
    [cohort],
  );
  useEffect(() => { onAvailableMods(cohortMods); }, [cohortMods, onAvailableMods]);

  const { rows, hidden } = useMemo(() => {
    const seenPerChart = new Map<number, number>();
    const kept: DanRow[] = [];
    for (const row of cohort) {
      if (!showRejected && row.kind === "rejected") continue;
      if (hideRanked && isRankedStatus(row.play.beatmapStatus ?? null)) continue;
      if (!matchesPlayModFilter(row.play, modFilter)) continue;
      if (maxPerChart > 0) {
        const seen = seenPerChart.get(row.play.beatmapId) ?? 0;
        if (seen >= maxPerChart) continue;
        seenPerChart.set(row.play.beatmapId, seen + 1);
      }
      kept.push(row);
    }
    return { rows: kept, hidden: cohort.length - kept.length };
  }, [cohort, hideRanked, maxPerChart, showRejected, modFilter]);
  const visibleRows = rows.slice(0, visibleLimit);

  return (
    <div className="space-y-3">
      <ListShell
        loading={loading && cohort.length === 0}
        busy={loading && cohort.length > 0}
        error={error}
        empty={visibleRows.length === 0}
        emptyTitle={t`No plays match these filters`}
        shown={visibleRows.length}
        total={rows.length}
        hidden={hidden}
        onShowMore={visibleRows.length < rows.length
          ? () => setVisibleLimit((current) => Math.min(rows.length, current + PLAYS_REVEAL_STEP))
          : null}
        loadingMore={false}
      >
        {visibleRows.map((row, index) => {
          const key = `${row.kind}:${rowKey(row.play, index)}`;
          const open = () => onOpen(row.play, { label: overallLabel, color: OVERALL_AXIS_META.color });
          const prefetch = () => prefetchLiveMapSearchEntry(row.play.beatmapId);
          return row.kind === "rejected" ? (
            <DanRejectedRow
              key={key}
              rejected={row.rejected}
              keyCount={keyCount}
              position={index + 1}
              expanded={openReason === key}
              onToggle={() => setOpenReason((current) => (current === key ? null : key))}
              onOpen={open}
              onPrefetch={prefetch}
            />
          ) : (
            <PlayRow
              key={key}
              play={row.play}
              position={index + 1}
              onOpen={open}
              onPrefetch={prefetch}
              badge={<DanSkillsetBadge skillsets={row.clear.skillsets} />}
              trailing={<DanCreditCell clear={row.clear} keyCount={keyCount} side={side} />}
            />
          );
        })}
      </ListShell>
    </div>
  );
}

/**
 * Which dan skillset the play was read as.
 *
 * The tile is not a property of the chart, it is where the clear rules filed
 * THIS play: the same chart at a different rate can land elsewhere, and a
 * chart the rules deliberately share sits in two at once, which prints as
 * "Speed/Tech" rather than picking a winner. Without this a reader can see
 * their jack dan move and have no way to tell which plays moved it.
 */
function DanSkillsetBadge({ skillsets }: { skillsets: string[] | undefined }) {
  const { i18n } = useLingui();
  const known = (skillsets ?? []).map((id) => DAN_SKILLSET_META[id]).filter((meta) => meta != null);
  if (known.length === 0) return null;
  return (
    <span
      className="rounded bg-osu-b3/35 px-1 py-0.5 font-bold"
      // The first tile is the primary one, so it owns the color; the rest of
      // the name rides along in it rather than splitting the badge in two.
      style={{ color: known[0].color }}
    >
      {known.map((meta) => i18n._(meta.labelMsg)).join("/")}
    </span>
  );
}

/**
 * A dan level, as its course's own logo.
 *
 * The artwork IS the level everywhere else on the site (the maps badges, the
 * profile chips), so a list of clears that spelled "gamma-" in text would be
 * the one place a reader has to translate. The tier suffix rides top-right
 * like an exponent, colored by where inside the level the credit sits.
 *
 * No approximation marker, unlike DanLevelBadge: that badge shows an estimate
 * OF A PLAYER and says so with a "~", while this is one clear's exact credit
 * on one chart. Keymodes with no artwork fall back to the words.
 */
function DanMark({
  label,
  keyCount,
  side,
  dimmed = false,
}: {
  label: string;
  keyCount: number;
  side: "rc" | "ln" | null;
  dimmed?: boolean;
}) {
  const { t } = useLingui();
  // A numeric label reads as "7 dan"; a named one already reads as itself.
  const text = /^\d/.test(label) ? t`${label} dan` : label;
  const image = getDanImageSrc(danBareLabel(label), side === "ln" ? "ln" : undefined, keyCount);
  const suffix = danTierSuffix(label);
  if (!image) {
    return <span className={`text-sm font-black leading-none text-osu-l1 sm:text-base ${dimmed ? "opacity-50" : ""}`}>{text}</span>;
  }
  return (
    <span className={`flex items-start gap-[2px] leading-none ${dimmed ? "opacity-40" : ""}`}>
      <img src={image} alt={text} className="h-8 w-8 object-contain" />
      {suffix ? (
        <span className="mt-0.5 text-[12px] font-bold leading-none" style={{ color: danTierColor(suffix) ?? undefined }}>
          {suffix}
        </span>
      ) : null}
    </span>
  );
}

function DanCreditCell({
  clear,
  keyCount,
  side,
}: {
  clear: LivePlayerDanEvidencePlay;
  keyCount: number;
  side: "rc" | "ln";
}) {
  const { t } = useLingui();
  const chart = clear.chartDanLabel;
  const credit = clear.creditedDanLabel;
  // A reduced number can still sit in the chart's display tier.
  const reduced = clear.creditedDan < clear.chartDan;
  const title = reduced
    ? t`Below the full-clear requirement: reduced credit, even if the dan label stays the same`
    : credit === chart
    ? undefined
    : t`A ${chart} chart, credited as ${credit} at this accuracy`;
  return (
    <div className="flex w-20 shrink-0 flex-col items-end gap-1 sm:w-24" title={title}>
      <DanMark label={credit} keyCount={keyCount} side={side} />
      <span className="text-[8px] font-semibold uppercase tracking-wide tabular-nums text-osu-f1">
        {formatAccuracy(clear.clearAccuracy)}
      </span>
      {reduced ? <span className="text-[8px] text-osu-f1">{t`partial credit`}</span> : null}
    </div>
  );
}

/**
 * The tail of a turned-away play: the block icon the whole surface exists for.
 *
 * The reason lives in the title rather than in a line under the row, because a
 * list of thirty refusals with thirty sentences under them is unreadable and
 * the reason is the follow-up question, not the answer.
 */
/**
 * A rated play the dan rules turned away, with the rule reachable on a phone.
 *
 * Hover carries the reason on a pointer, but a touch device has no hover and
 * tapping the row opens the map card, so the reason was unreadable exactly
 * where the row is smallest. The tail is its own button: it expands the reason
 * under the row instead of opening the map, and the row keeps its own tap.
 */
function DanRejectedRow({
  rejected,
  keyCount,
  position,
  expanded,
  onToggle,
  onOpen,
  onPrefetch,
}: {
  rejected: LivePlayerDanRejectedPlay;
  keyCount: number;
  position: number;
  expanded: boolean;
  onToggle: () => void;
  onOpen: () => void;
  onPrefetch: () => void;
}) {
  const { t } = useLingui();
  // Written out here rather than in a helper taking `t`: the Lingui macro only
  // sees a `t` it can follow to a useLingui call in the same scope, and a `t`
  // handed in as an argument silently leaves its strings out of the catalog.
  const accuracy = rejected.clearAccuracy;
  const bar = rejected.bar;
  // The number this play actually missed is the credit window's floor, not the
  // pass bar: a clear under the bar still credits a decayed dan until it falls
  // out of the window, so naming only the bar reads as a rule the credited
  // rows below it are breaking.
  const minAccuracy = rejected.minAccuracy;
  const od = rejected.od;
  const reason = rejected.reason === "below_bar"
    ? (minAccuracy != null && bar != null && accuracy != null
      ? t`Minimum required for dan credit is ${formatAccuracy(minAccuracy)}. This play got ${formatAccuracyAgainst(accuracy, minAccuracy)}.`
      : bar != null && accuracy != null
        ? t`Minimum required for dan credit is ${formatAccuracy(bar)}. This play got ${formatAccuracyAgainst(accuracy, bar)}.`
        : t`This play is under the minimum accuracy required for dan credit.`)
    : rejected.reason === "low_od"
      ? (od != null
        ? t`This play was judged at OD ${od.toFixed(1)}. A dan clear has to be played at a higher OD than that.`
        : t`This play was judged at a lower OD than a dan clear has to be played at.`)
      : rejected.reason === "ez_windows"
        ? t`Easy widened every hit window, so this accuracy was not set against the windows a dan clear is judged on.`
        : rejected.reason === "chart_ineligible"
          ? t`This chart is not built in a way a dan level can be read off a clear of it.`
          : rejected.reason === "chart_unanalyzed"
            ? t`This chart has not been analyzed yet, so there is no dan level to credit. It can count later.`
            : rejected.reason === "no_chart_dan"
              ? t`This chart has no dan level at the rate it was played at.`
              : rejected.reason === "no_accuracy"
                ? t`The judgement counts for this play are gone, so there is no accuracy to check it against.`
                : t`This play counts for nothing on the dan estimate.`;
  // The level it was aiming at, dimmed, with the block mark over its corner:
  // the reader sees what the clear would have been worth and that it is not,
  // in the same column and the same shape the credited rows use.
  return (
    <PlayRow
      play={rejected.play}
      position={position}
      dimmed
      onOpen={onOpen}
      onPrefetch={onPrefetch}
      badge={<DanSkillsetBadge skillsets={rejected.skillsets} />}
      trailing={(
        <button
          type="button"
          onClick={onToggle}
          aria-expanded={expanded}
          title={reason}
          className="flex w-20 shrink-0 cursor-pointer flex-col items-end gap-1 sm:w-24"
        >
          <span className="relative inline-flex">
            {rejected.chartDanLabel ? (
              <DanMark label={rejected.chartDanLabel} keyCount={keyCount} side={rejected.side} dimmed />
            ) : (
              <span className="block h-8 w-8" />
            )}
            <Ban
              className="absolute -bottom-0.5 -right-0.5 h-4 w-4 rounded-full bg-osu-b5 text-osu-red-light"
              aria-hidden="true"
            />
          </span>
          <span className={`text-[8px] font-semibold uppercase tracking-wide ${expanded ? "text-osu-l2" : "text-osu-f1"}`}>
            <Trans>does not count</Trans>
          </span>
        </button>
      )}
      footer={expanded ? (
        <p className="border-t border-osu-b3/20 px-3 py-2 text-[11px] leading-relaxed text-osu-f1">{reason}</p>
      ) : null}
    />
  );
}

// --- shared pieces --------------------------------------------------------

function PlayRow({
  play,
  position,
  trailing,
  badge = null,
  footer = null,
  dimmed = false,
  onOpen,
  onPrefetch,
}: {
  play: LivePlayerSkillPlay;
  position: number;
  trailing: ReactNode;
  /** An extra badge on the meta line, beside the keymode and the status. */
  badge?: ReactNode;
  /** A full-width line under the row, for anything the tail cannot hold. */
  footer?: ReactNode;
  dimmed?: boolean;
  onOpen: () => void;
  // Warms the catalog entry ahead of the click, same as the skill plays modal.
  onPrefetch: () => void;
}) {
  const { t, i18n } = useLingui();
  const locale = useLocale();
  // osu!'s own status colors, from the same table the maps grid draws, so a
  // green chip means the same thing on both surfaces.
  const status = play.beatmapStatus ? beatmapStatusPill(play.beatmapStatus) : null;
  // The tail sits outside the button rather than inside it: a row whose tail
  // is itself a control (the dan list's "why not") cannot nest one button in
  // another, and the whole row would swallow the tap either way.
  return (
    <div
      className={`group w-full min-w-0 rounded-xl border border-transparent bg-osu-b4/55 transition-colors hover:border-osu-b3/30 hover:bg-osu-b4 ${
        dimmed ? "opacity-60" : ""
      }`}
    >
    <div className="flex min-w-0 items-center gap-2 px-2 py-2 sm:gap-3 sm:px-3">
    <button
      type="button"
      onClick={onOpen}
      onPointerEnter={onPrefetch}
      onFocus={onPrefetch}
      className="flex min-w-0 flex-1 cursor-pointer items-center gap-2 text-left sm:gap-3"
      title={t`View map details`}
    >
      <span className="w-6 shrink-0 text-right text-[11px] font-bold tabular-nums text-osu-f1 sm:w-7 sm:text-xs">{position}.</span>
      <div className="relative h-10 w-16 shrink-0 overflow-hidden rounded-md bg-osu-b3/35 sm:h-12 sm:w-20">
        {play.coverUrl ? (
          <img
            src={play.coverUrl}
            alt=""
            loading="lazy"
            className="h-full w-full object-cover"
            onError={(event) => { event.currentTarget.style.display = "none"; }}
          />
        ) : null}
        <div className="pointer-events-none absolute inset-0 ring-1 ring-inset ring-white/[0.06]" />
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 items-center gap-1.5">
          <span className="truncate text-xs font-semibold text-white sm:text-sm">{play.title}</span>
          <span className="hidden shrink-0 truncate text-[10px] text-osu-f1 md:inline">[{play.version}]</span>
        </div>
        <div className="mt-0.5 flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5 text-[9px] text-osu-f1 sm:text-[10px]">
          <span className="max-w-44 truncate">
            {play.artist}<span className="md:hidden"> · [{play.version}]</span>
          </span>
          <span className="rounded bg-osu-b3/35 px-1 py-0.5 font-bold text-osu-yellow">{play.keyCount}K</span>
          {badge}
          {status ? (
            <span className={`rounded px-1 py-0.5 font-bold ${status.className}`}>{i18n._(status.label)}</span>
          ) : null}
          <PlayModBadges play={play} />
          {play.playedAt ? (
            <span className="hidden sm:inline" title={formatTimeAgoTooltip(play.playedAt, locale)}>
              {formatTimeAgo(play.playedAt, locale)}
            </span>
          ) : null}
        </div>
      </div>
      <div className="hidden shrink-0 items-end gap-4 text-right sm:flex">
        {play.accuracy != null ? (
          <div>
            <div className="text-xs font-semibold tabular-nums text-osu-l2">{formatAccuracy(play.accuracy)}</div>
            <div className="mt-0.5 text-[8px] uppercase tracking-wide text-osu-f1">{t`accuracy`}</div>
          </div>
        ) : null}
        {play.pp != null ? (
          <div>
            <div className="text-xs font-bold tabular-nums text-osu-pink-light">{formatPP(play.pp)}</div>
            <div className="mt-0.5 text-[8px] uppercase tracking-wide text-osu-f1">pp</div>
          </div>
        ) : null}
      </div>
    </button>
    {trailing}
    </div>
    {footer}
    </div>
  );
}

function ListShell({
  loading,
  busy,
  error,
  empty,
  emptyTitle,
  shown,
  total,
  hidden,
  onShowMore,
  loadingMore,
  children,
}: {
  /** No rows to show yet: draw the skeleton. */
  loading: boolean;
  /** Rows on screen, a read in flight behind them. */
  busy: boolean;
  error: string | null;
  empty: boolean;
  emptyTitle: string;
  shown: number;
  total: number;
  hidden: number;
  onShowMore: (() => void) | null;
  loadingMore: boolean;
  children: ReactNode;
}) {
  const { t } = useLingui();
  /* The height the list stood at before it emptied. A keymode or a skill is a
     different list and has to clear, and seven skeleton rows in place of forty
     real ones takes the page out from under whoever was reading it. Holding
     the outgoing height means one correction when the rows land instead of a
     collapse and a re-expansion. */
  const listRef = useRef<HTMLDivElement | null>(null);
  const lastHeight = useRef<number | null>(null);
  useEffect(() => {
    if (loading || !listRef.current) return;
    const height = listRef.current.getBoundingClientRect().height;
    if (height > 0) lastHeight.current = height;
  });

  if (loading) {
    return (
      <div className="space-y-1.5" style={lastHeight.current != null ? { minHeight: lastHeight.current } : undefined}>
        {Array.from({ length: 7 }).map((_, index) => <PlayRowSkeleton key={index} />)}
      </div>
    );
  }
  if (empty) {
    return (
      <div ref={listRef} className="px-4 py-14 text-center">
        <div className="text-sm font-semibold text-osu-l2">{error ? t`Could not load these plays` : emptyTitle}</div>
        <div className="mt-1 text-xs text-osu-f1">
          {error ?? t`Try turning a filter off.`}
        </div>
      </div>
    );
  }
  return (
    <div ref={listRef} className="space-y-3">
      {/* Dimmed, not replaced: the rows are still the answer, just not yet
          the answer to the question that was asked half a second ago. */}
      <div aria-busy={busy} className={`space-y-1.5 transition-opacity ${busy ? "opacity-50" : ""}`}>{children}</div>
      {error ? (
        <div className="rounded-lg border border-osu-red-light/20 bg-osu-red-light/5 px-3 py-2 text-center text-[11px] text-osu-red-light">
          {error}
        </div>
      ) : null}
      {onShowMore ? (
        <div className="flex justify-center">
          <button
            type="button"
            onClick={onShowMore}
            disabled={loadingMore}
            className="rounded-lg border border-osu-b3/30 bg-osu-b4 px-5 py-2 text-xs font-semibold text-osu-l2 transition-colors hover:border-osu-pink/30 hover:bg-osu-b3/50 hover:text-white disabled:cursor-wait disabled:opacity-60"
          >
            {loadingMore ? t`Loading…` : t`Show more`}
          </button>
        </div>
      ) : null}
      <div className="text-center text-[10px] text-osu-f1">
        {hidden > 0
          ? t`Showing ${shown.toLocaleString("en-US")} of ${total.toLocaleString("en-US")}, ${hidden.toLocaleString("en-US")} hidden by filters`
          : t`Showing ${shown.toLocaleString("en-US")} of ${total.toLocaleString("en-US")}`}
      </div>
    </div>
  );
}

function PlayRowSkeleton() {
  return (
    <div className="flex items-center gap-3 rounded-xl bg-osu-b4/55 px-3 py-2">
      <Skeleton className="h-3 w-5" />
      <Skeleton className="h-12 w-20 rounded-md" />
      <div className="min-w-0 flex-1 space-y-2">
        <Skeleton className="h-3.5 w-2/3" />
        <Skeleton className="h-2.5 w-1/3" />
      </div>
      <Skeleton className="h-5 w-12" />
    </div>
  );
}

/**
 * A short, fixed set of mutually exclusive options, drawn as one track.
 *
 * Used where the options are few and the label would only repeat what they
 * already say: "7K 4K 6K" needs no heading reading "keymode". The track is
 * what groups them, which is why these can sit next to each other without a
 * caption between every pair.
 */
function Segmented<T extends string | number>({
  ariaLabel,
  value,
  options,
  onChange,
}: {
  ariaLabel: string;
  value: T;
  options: Array<{ value: T; label: string; onPrefetch?: () => void }>;
  onChange: (next: T) => void;
}) {
  return (
    // A profile with a mode for every keymode MinaCalc rates makes this wider
    // than a phone row. It scrolls inside its own pill rather than running off
    // the screen, so the controls beside it stay put.
    <div role="group" aria-label={ariaLabel} className={`inline-flex max-w-full items-center overflow-x-auto scrollbar-hide p-0.5 ${CONTROL_TRACK_CLASS}`}>
      {options.map((option) => {
        const active = option.value === value;
        return (
          <button
            key={String(option.value)}
            type="button"
            onClick={() => onChange(option.value)}
            onPointerEnter={option.onPrefetch}
            onFocus={option.onPrefetch}
            aria-pressed={active}
            className={`shrink-0 cursor-pointer rounded-full px-2.5 py-1 text-[11.5px] font-semibold transition-colors ${
              active ? "bg-osu-b3 text-white" : "text-osu-f1 hover:text-osu-l1"
            }`}
          >
            {option.label}
          </button>
        );
      })}
    </div>
  );
}

/**
 * The list's subject: which skill, or which side of the dan ladder.
 *
 * Loose pills rather than a track, because this set is long enough to wrap and
 * a wrapped track reads as a broken box. The active one takes its own color,
 * which is the same color the rating column is drawn in, so the choice and the
 * number it produces are visibly the same thing.
 */
function PillGroup<T extends string>({
  ariaLabel,
  value,
  options,
  onChange,
}: {
  ariaLabel: string;
  value: T;
  options: Array<{ value: T; label: string; color: string; onPrefetch?: () => void }>;
  onChange: (next: T) => void;
}) {
  return (
    <div role="group" aria-label={ariaLabel} className="flex flex-wrap items-center gap-1">
      {options.map((option) => {
        const active = option.value === value;
        return (
          <button
            key={option.value}
            type="button"
            onClick={() => onChange(option.value)}
            onPointerEnter={option.onPrefetch}
            onFocus={option.onPrefetch}
            aria-pressed={active}
            className={`cursor-pointer rounded-full px-2.5 py-1 text-[11.5px] font-semibold transition-colors ${
              active ? "bg-osu-b3/70" : "text-osu-f1 hover:bg-osu-b4 hover:text-osu-l1"
            }`}
            style={active ? { color: option.color } : undefined}
          >
            {option.label}
          </button>
        );
      })}
    </div>
  );
}

/**
 * The per-chart rate cap: how many plays of the same chart a list may repeat.
 *
 * The label is a cell of the track rather than a caption floating beside it,
 * so the control still reads as one object without asking anyone to work out
 * what it does. A mark alone was tried here and is wrong on touch: an icon
 * that only explains itself on hover explains itself to nobody on a phone.
 *
 * The whole track tints while a cap is on, because a filter that is quietly
 * thinning the list should be visible without reading the number.
 */
function RateCapControl({ value, onChange }: { value: number; onChange: (next: number) => void }) {
  const { t } = useLingui();
  const title = t`How many plays of the same chart the list may repeat`;
  const capped = value !== 0;
  return (
    <div
      role="group"
      aria-label={title}
      title={title}
      className={`inline-flex items-center gap-0.5 p-0.5 pl-2 transition-colors ${CONTROL_TRACK_CLASS} ${
        capped ? "bg-osu-pink/15" : ""
      }`}
    >
      <span className={`mr-1 shrink-0 text-[11px] ${capped ? "text-osu-pink-light" : "text-osu-f1"}`}>
        <Trans>Rates per chart</Trans>
      </span>
      {SKILL_PLAYS_RATE_CAPS.map((cap) => {
        const active = cap === value;
        return (
          <button
            key={cap}
            type="button"
            onClick={() => onChange(cap)}
            aria-pressed={active}
            aria-label={cap === 0 ? t`Every rate of a chart` : cap === 1 ? t`1 rate per chart` : t`${cap} rates per chart`}
            className={`min-w-6 cursor-pointer rounded-full px-2 py-1 text-[11.5px] font-semibold transition-colors ${
              active
                ? capped ? "bg-osu-pink/30 text-osu-pink-light" : "bg-osu-b3 text-white"
                : "text-osu-f1 hover:text-osu-l1"
            }`}
          >
            {cap === 0 ? t`All` : cap}
          </button>
        );
      })}
    </div>
  );
}

/**
 * The one control a phone gets for the three that narrow the list.
 *
 * It is not a menu: the same tracks a desktop shows inline open under it, in
 * the same order, so nobody has to learn a second arrangement. The count is
 * what makes a closed row honest - a list quietly thinned by a setting nobody
 * can see is the reason this is a disclosure and not a hidden default.
 */
function FiltersToggle({
  open,
  activeCount,
  onToggle,
}: {
  open: boolean;
  activeCount: number;
  onToggle: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-expanded={open}
      className={`inline-flex cursor-pointer items-center gap-1.5 px-2.5 py-1 text-[11.5px] font-semibold transition-colors sm:hidden ${CONTROL_TRACK_CLASS} ${
        activeCount > 0 ? "text-osu-pink-light" : "text-osu-f1"
      }`}
    >
      <SlidersHorizontal size={12} />
      <Trans>Filters</Trans>
      {activeCount > 0 ? <span className="tabular-nums">{activeCount}</span> : null}
      <ChevronDown size={12} className={`transition-transform ${open ? "rotate-180" : ""}`} />
    </button>
  );
}

/**
 * The mod filter, the same chip and the same cycle Best Performance uses:
 * click to require a mod, again to hide it, again to stop asking.
 *
 * It wears the toolbar's track rather than sitting loose beside it, because
 * the chips alone would read as badges on the row above rather than as a
 * control. Only the mods the visible cohort was played with get a chip, so an
 * empty answer is never on offer. The chips wrap inside the track: a player
 * with many mods on a phone would otherwise push the whole page sideways.
 */
function ModsControl({
  mods,
  modFilter,
  onCycle,
}: {
  mods: string[];
  modFilter: ModFilterState;
  onCycle: (mod: string, reverse: boolean) => void;
}) {
  const { t } = useLingui();
  const any = Object.keys(modFilter).length > 0;
  return (
    <div
      role="group"
      aria-label={t`Mods`}
      className={`inline-flex max-w-full flex-wrap items-center gap-1 p-1 pl-2 ${CONTROL_TRACK_CLASS}`}
    >
      <span className={`mr-0.5 shrink-0 text-[11px] ${any ? "text-osu-pink-light" : "text-osu-f1"}`}>
        <Trans>Mods</Trans>
      </span>
      {mods.map((mod) => (
        <ModFilterChip
          key={mod}
          mod={mod}
          mode={modFilter[mod]}
          onClick={() => onCycle(mod, false)}
          onContextMenu={() => onCycle(mod, true)}
        />
      ))}
    </div>
  );
}

/**
 * What the list leaves out, as one track rather than a pill per answer.
 *
 * Two independent toggles, so this is not a Segmented: any number of them can
 * be on at once. What they share is the verb, and spelling "Hide" into every
 * pill made two controls that are usually set together take a whole row. The
 * word is the track's first cell instead, which halves the copy and reads as
 * one sentence: "hide ranked, not counted".
 */
function HideControl({
  options,
}: {
  options: Array<{ key: string; label: string; title: string; pressed: boolean; onChange: () => void }>;
}) {
  const { t } = useLingui();
  const any = options.some((option) => option.pressed);
  return (
    <div role="group" aria-label={t`Hide`} className={`inline-flex items-center gap-0.5 p-0.5 pl-2 ${CONTROL_TRACK_CLASS}`}>
      <span className={`mr-1 shrink-0 text-[11px] ${any ? "text-osu-pink-light" : "text-osu-f1"}`}>
        <Trans>Hide</Trans>
      </span>
      {options.map((option) => (
        <button
          key={option.key}
          type="button"
          onClick={option.onChange}
          aria-pressed={option.pressed}
          title={option.title}
          className={`cursor-pointer rounded-full px-2 py-1 text-[11.5px] font-semibold transition-colors ${
            option.pressed ? "bg-osu-pink/25 text-osu-pink-light" : "text-osu-f1 hover:text-osu-l1"
          }`}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

/* The toolbar's arrangement controls all wear the same track: a filled pill
   with a hairline, so a label and its buttons read as one object. Without the
   hairline the track sits too close to the panel behind it and the row reads
   as loose words with a highlighted one among them. */
const CONTROL_TRACK_CLASS = "rounded-full bg-osu-b5 ring-1 ring-inset ring-osu-b3/45";

/* Every mod the score carried. A pre-full-mod retained play can still name its
   speed mod from the old projection; a 1.0x play with no `mods` field is
   unknown, not NoMod, because it may have carried MR/DA/etc. before the raw
   score aged out. */
function playModAcronyms(play: LivePlayerSkillPlay): string[] | null {
  if (Array.isArray(play.mods)) {
    return [...new Set(play.mods.filter((mod) => typeof mod === "string" && mod.length > 0))];
  }
  const rateMod = rateModFor(play.rate, play.rateMod);
  return rateMod ? [rateMod.acronym] : null;
}

function matchesPlayModFilter(play: LivePlayerSkillPlay, modFilter: ModFilterState): boolean {
  const acronyms = playModAcronyms(play);
  if (acronyms) return matchesModAcronymFilter(acronyms, modFilter);
  // Unknown historical mods cannot satisfy a required chip. They remain when
  // a chip is only being excluded because there is no evidence they used it.
  return !Object.values(modFilter).includes("include");
}

function formatDaOd(od: number): string {
  return Number.isInteger(od) ? String(od) : od.toFixed(1);
}

function PlayModBadges({ play, size = 0.8 }: { play: LivePlayerSkillPlay; size?: number }) {
  const acronyms = playModAcronyms(play);
  if (!acronyms || acronyms.length === 0) return null;
  const rateMod = rateModFor(play.rate, play.rateMod);
  return (
    <span className="inline-flex flex-wrap items-center gap-0.5">
      {acronyms.map((mod) => (
        <ModBadge
          key={mod}
          mod={mod}
          rate={rateMod?.acronym === mod ? rateMod.rate : undefined}
          detail={mod === "DA" && typeof play.daOd === "number" ? `OD ${formatDaOd(play.daOd)}` : undefined}
          size={size}
        />
      ))}
    </span>
  );
}

/** The filter state as a value the reset effects can depend on. */
function modFilterKey(modFilter: ModFilterState): string {
  return Object.entries(modFilter).sort(([left], [right]) => left.localeCompare(right)).map(([mod, mode]) => `${mod}:${mode}`).join(",");
}

// The two sides of the dan ladder, matching the dan modal's own accent. The
// color is decorative; the pill's text carries the identity.
const SIDE_COLOR: Record<"rc" | "ln", string> = { rc: "#e0b04c", ln: "#f07474" };

// The statuses that put a chart on the official leaderboards, matching the
// backend's own list (isRankedBeatmapStatus). Loved is not one of them.
const RANKED_STATUSES = new Set(["ranked", "approved", "qualified"]);

function isRankedStatus(status: string | null): boolean {
  return status != null && RANKED_STATUSES.has(status);
}

/** Rate is part of the identity: one chart can appear once per rate played. */
function rowKey(play: LivePlayerSkillPlay, index: number): string {
  return `${play.beatmapId}:${play.rate}:${play.scoreId ?? play.playedAt ?? index}`;
}

function axisKeyOf(meta: SkillAxisMeta): string {
  return "axis" in meta && typeof (meta as { axis?: unknown }).axis === "string"
    ? (meta as { axis: string }).axis
    : meta.key;
}
