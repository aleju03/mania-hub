import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Trans, useLingui } from "@lingui/react/macro";
import { plural } from "@lingui/core/macro";
import { Check, ChevronDown } from "lucide-react";

import { useBodyScrollLock } from "../../lib/use-body-scroll-lock";
import { fetchLiveRosterPlayers, type LiveUserSearchEntry } from "../../lib/live-backend";
import { CONTINENT_OPTIONS, REGION_OPTIONS, findRegionByCountries, getRegionDef } from "../../lib/regions";
import { COUNTRY_OPTIONS, getCountryName } from "../../lib/country";
import type { BotFeedPlayer } from "../../lib/discord-bot";
import { CountryFlag } from "../ui/CountryFlag";
import { SelectMenu, type SelectMenuOption } from "../ui/SelectMenu";

const PAGE = 30;
// The view that lists the players of every country on the left at once.
const ALL_VIEW = "*";
const EVERYWHERE = "GLOBAL";

export type FeedPlayersMode = "only" | "mix";

export interface FeedPlayersChoice {
  players: BotFeedPlayer[];
  excluded: BotFeedPlayer[];
  mode: FeedPlayersMode;
  countries: string[];
}

interface Scope {
  /** Every country, for a Global feed with no countries of its own. */
  everywhere: boolean;
  /** Countries whose players all post, less the left-out ones. */
  whole: string[];
}

/** The countries a saved feed takes whole, read the way the backend reads them. */
export function savedScope(mode: FeedPlayersMode, players: BotFeedPlayer[], countries: string[], feedCountry: string | null): Scope {
  if (mode === "only" && players.length > 0) return { everywhere: false, whole: [] };
  if (countries.length) return { everywhere: false, whole: countries };
  return feedCountry ? { everywhere: false, whole: [feedCountry] } : { everywhere: true, whole: [] };
}

function scopeName(scope: Scope, t: ReturnType<typeof useLingui>["t"]): string {
  if (scope.everywhere) return t`every country`;
  return findRegionByCountries(scope.whole)?.name
    ?? (scope.whole.length <= 4 ? scope.whole.join(", ") : t`${scope.whole.length} countries`);
}

/** Who a feed posts, in one sentence. */
export function useFeedPlayersSummary() {
  const { t } = useLingui();
  return (scope: Scope, added: number, excluded: number): string => {
    const where = scopeName(scope, t);
    if (!scope.everywhere && scope.whole.length === 0) {
      return added ? t`Only the ${plural(added, { one: "# picked player", other: "# picked players" })}.` : t`Nobody yet.`;
    }
    if (excluded && added) {
      return t`Everyone in ${where} except ${plural(excluded, { one: "# player", other: "# players" })}, plus ${plural(added, { one: "# more player", other: "# more players" })}.`;
    }
    if (excluded) return t`Everyone in ${where} except ${plural(excluded, { one: "# player", other: "# players" })}.`;
    if (added) return t`Everyone in ${where}, plus ${plural(added, { one: "# more player", other: "# more players" })}.`;
    return t`Everyone in ${where}.`;
  };
}

/**
 * Who a feed posts. The left side lists countries, each taken whole (with
 * players left out) or not at all (with players picked from it). The right side
 * is the chosen country's tracked players, highest pp first, and a tick there
 * always means the player posts.
 */
export function FeedPlayersModal({ title, players, excluded: initialExcluded, mode: initialMode, countries: initialCountries, max, feedCountry, onSave, onClose }: {
  title: string;
  players: BotFeedPlayer[];
  excluded: BotFeedPlayer[];
  mode: FeedPlayersMode;
  /** The feed's own set of countries; empty means it uses `feedCountry`. */
  countries: string[];
  max: number;
  /** The feed's one country, or null when it is Global. */
  feedCountry: string | null;
  onSave: (choice: FeedPlayersChoice) => void;
  onClose: () => void;
}) {
  const { t } = useLingui();
  useBodyScrollLock(true);
  const summarize = useFeedPlayersSummary();
  const start = useMemo(() => savedScope(initialMode, players, initialCountries, feedCountry), [initialMode, players, initialCountries, feedCountry]);
  const [everywhere, setEverywhere] = useState(start.everywhere);
  const [whole, setWhole] = useState<string[]>(start.whole);
  // Countries on the list with nothing picked yet.
  const [browsing, setBrowsing] = useState<string[]>([]);
  const [added, setAdded] = useState<BotFeedPlayer[]>(players);
  const [excluded, setExcluded] = useState<BotFeedPlayer[]>(initialExcluded);

  const listed = useMemo(() => {
    const codes = [...whole, ...browsing, ...added.map((p) => p.countryCode), ...excluded.map((p) => p.countryCode)];
    return [...new Set(codes.filter((code): code is string => Boolean(code && /^[A-Z]{2}$/.test(code))))];
  }, [whole, browsing, added, excluded]);
  // Regions added from the menu stay one row on the list while all their
  // countries are on it; a country sits under the first region that has it.
  const [groups, setGroups] = useState<string[]>(() => {
    const region = findRegionByCountries(start.whole);
    return region ? [region.code] : [];
  });
  const [expanded, setExpanded] = useState<string[]>([]);
  const groupRows = useMemo(() => {
    const taken = new Set<string>();
    const rows: Array<{ code: string; name: string; countries: string[] }> = [];
    for (const code of groups) {
      const region = getRegionDef(code);
      if (!region || !region.countries.every((c) => listed.includes(c))) continue;
      const countries = listed.filter((c) => region.countries.includes(c) && !taken.has(c));
      countries.forEach((c) => taken.add(c));
      if (countries.length) rows.push({ code, name: region.name, countries });
    }
    return { rows, loose: listed.filter((c) => !taken.has(c)) };
  }, [groups, listed]);
  const membersOf = (next: string): string[] =>
    next === ALL_VIEW ? listed : next === EVERYWHERE ? [] : groupRows.rows.find((g) => g.code === next)?.countries ?? [next];
  const firstView = everywhere ? EVERYWHERE : groupRows.rows[0]?.code ?? listed[0] ?? ALL_VIEW;
  const [view, setView] = useState(firstView);
  const viewCountries = membersOf(view);
  const isWhole = (code: string | null | undefined) => everywhere || Boolean(code && whole.includes(code));

  const addedIds = useMemo(() => new Set(added.map((p) => p.id)), [added]);
  const excludedIds = useMemo(() => new Set(excluded.map((p) => p.id)), [excluded]);
  const inView = (player: BotFeedPlayer) => Boolean(player.countryCode && viewCountries.includes(player.countryCode)) || view === ALL_VIEW;
  // The view's picked and left-out players open at the top of its list. The set
  // is read when the view opens, so ticking a row never moves it.
  const pinnedFor = (next: string) => {
    const codes = membersOf(next);
    return [...added, ...excluded].filter((p) => next === ALL_VIEW || (p.countryCode && codes.includes(p.countryCode))).map((p) => p.id);
  };
  const [pinned, setPinned] = useState<number[]>(() => pinnedFor(firstView));
  const openView = (next: string) => {
    setView(next);
    setPinned(pinnedFor(next));
    setQuery("");
  };

  const [query, setQuery] = useState("");
  const [list, setList] = useState<LiveUserSearchEntry[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(viewCountries.length > 0);
  const request = useRef(0);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const viewKey = viewCountries.join(",");
  useEffect(() => {
    const id = ++request.current;
    if (!viewCountries.length) {
      setList([]);
      setTotal(0);
      setLoading(false);
      return;
    }
    setLoading(true);
    const timer = setTimeout(() => {
      void fetchLiveRosterPlayers(viewCountries, { query, limit: PAGE })
        .then((page) => { if (request.current === id) { setList(page.users); setTotal(page.total); } })
        .catch(() => { if (request.current === id) { setList([]); setTotal(0); } })
        .finally(() => { if (request.current === id) setLoading(false); });
    }, query ? 200 : 0);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [viewKey, query]);

  const more = () => {
    const id = ++request.current;
    setLoading(true);
    void fetchLiveRosterPlayers(viewCountries, { query, limit: PAGE, offset: list.length })
      .then((page) => { if (request.current === id) { setList((current) => [...current, ...page.users]); setTotal(page.total); } })
      .catch(() => {})
      .finally(() => { if (request.current === id) setLoading(false); });
  };

  const addOptions = useMemo<SelectMenuOption<string>[]>(() => [
    { value: "", label: t`Add a country or region` },
    ...COUNTRY_OPTIONS.map((entry) => ({ value: entry.code, label: entry.name, leading: <CountryFlag code={entry.code} size="md" decorative /> })),
    ...REGION_OPTIONS.map((entry) => ({ value: entry.code, label: entry.name, leading: <CountryFlag code={entry.code} size="md" decorative /> })),
    ...CONTINENT_OPTIONS.map((entry) => ({ value: entry.code, label: entry.name, leading: <CountryFlag code={entry.code} size="md" decorative /> })),
  ], [t]);
  // A country opens with nobody picked; a region comes in whole.
  const addPlace = (code: string) => {
    if (/^[A-Z]{2}$/.test(code)) {
      if (!listed.includes(code)) setBrowsing((prev) => [...prev, code]);
      openView(code);
      return;
    }
    const region = getRegionDef(code);
    if (!region) return;
    const codes = region.countries.filter((c) => !whole.includes(c));
    setWhole((prev) => [...prev, ...codes]);
    setAdded((prev) => prev.filter((p) => !p.countryCode || !codes.includes(p.countryCode)));
    setGroups((prev) => (prev.includes(region.code) ? prev : [...prev, region.code]));
    setView(region.code);
    setPinned([]);
    setQuery("");
  };

  const setCountriesWhole = (codes: string[], on: boolean) => {
    const hit = (p: BotFeedPlayer) => Boolean(p.countryCode && codes.includes(p.countryCode));
    if (on) {
      setWhole((prev) => [...prev, ...codes.filter((c) => !prev.includes(c))]);
      setAdded((prev) => prev.filter((p) => !hit(p)));
    } else {
      setWhole((prev) => prev.filter((c) => !codes.includes(c)));
      setExcluded((prev) => prev.filter((p) => !hit(p)));
      setBrowsing((prev) => [...prev, ...codes.filter((c) => !prev.includes(c))]);
    }
  };
  const setEveryCountry = (on: boolean) => {
    setEverywhere(on);
    if (on) setAdded([]);
    else setExcluded((prev) => prev.filter((p) => p.countryCode && whole.includes(p.countryCode)));
  };
  const removeCountries = (codes: string[]) => {
    const hit = (p: BotFeedPlayer) => Boolean(p.countryCode && codes.includes(p.countryCode));
    setWhole((prev) => prev.filter((c) => !codes.includes(c)));
    setBrowsing((prev) => prev.filter((c) => !codes.includes(c)));
    setAdded((prev) => prev.filter((p) => !hit(p)));
    setExcluded((prev) => prev.filter((p) => !hit(p)));
    const rest = listed.filter((c) => !codes.includes(c));
    setView(everywhere ? EVERYWHERE : rest[0] ?? ALL_VIEW);
    setPinned([]);
    setQuery("");
  };

  const posts = (player: { id: number; countryCode?: string | null }) =>
    isWhole(player.countryCode) ? !excludedIds.has(player.id) : addedIds.has(player.id);
  // Whether ticking or unticking this player would go past the list's cap.
  const blocked = (player: { id: number; countryCode?: string | null }) =>
    isWhole(player.countryCode) ? posts(player) && excluded.length >= max : !posts(player) && added.length >= max;
  const setOn = (user: BotFeedPlayer, on: boolean) => {
    const entry: BotFeedPlayer = { id: user.id, username: user.username, avatarUrl: user.avatarUrl || null, countryCode: user.countryCode ?? null, pp: user.pp ?? null };
    if (isWhole(user.countryCode)) {
      setExcluded((prev) => {
        const has = prev.some((p) => p.id === user.id);
        if (!on && !has && prev.length < max) return [...prev, entry];
        if (on && has) return prev.filter((p) => p.id !== user.id);
        return prev;
      });
    } else {
      setAdded((prev) => {
        const has = prev.some((p) => p.id === user.id);
        if (on && !has && prev.length < max) return [...prev, entry];
        if (!on && has) return prev.filter((p) => p.id !== user.id);
        return prev;
      });
    }
  };

  // Holding the mouse on a row and moving over others gives them all the state
  // the first row took. The press itself toggles, so the click after it is skipped.
  const drag = useRef<{ on: boolean } | null>(null);
  const pressed = useRef(false);
  useEffect(() => {
    const end = () => {
      drag.current = null;
      setTimeout(() => { pressed.current = false; }, 0);
    };
    window.addEventListener("pointerup", end);
    window.addEventListener("pointercancel", end);
    return () => {
      window.removeEventListener("pointerup", end);
      window.removeEventListener("pointercancel", end);
    };
  }, []);

  const pinnedSet = new Set(pinned);
  const needle = query.trim().toLowerCase();
  const pinnedRows = [...added, ...excluded]
    .filter((p) => pinnedSet.has(p.id) && inView(p) && (!needle || p.username.toLowerCase().includes(needle)));
  const rosterRows = list.filter((user) => !pinnedSet.has(user.id));
  const rows: BotFeedPlayer[] = [...pinnedRows, ...rosterRows];

  // How a set of countries is taken, for its row on the left.
  const stateOf = (codes: string[]): { label: string; active: boolean } => {
    const inSet = (p: BotFeedPlayer) => Boolean(p.countryCode && codes.includes(p.countryCode));
    const out = excluded.filter(inSet).length;
    const picked = added.filter(inSet).length;
    const wholeCount = codes.filter((c) => isWhole(c)).length;
    if (codes.length && wholeCount === codes.length) return { label: out ? t`All but ${out}` : t`Everyone`, active: true };
    if (wholeCount > 0) return { label: t`Some`, active: true };
    return picked ? { label: t`${picked} picked`, active: true } : { label: t`None`, active: false };
  };

  const scope: Scope = { everywhere, whole };
  const nobody = !everywhere && whole.length === 0 && added.length === 0;
  const sameIds = (a: BotFeedPlayer[], b: BotFeedPlayer[]) => a.length === b.length && a.every((p, i) => p.id === b[i]?.id);
  const changed = everywhere !== start.everywhere
    || whole.join(",") !== start.whole.join(",")
    || !sameIds(added, players)
    || !sameIds(excluded, initialExcluded);
  const save = () => {
    if (!everywhere && whole.length === 0) {
      onSave({ mode: "only", players: added, excluded: [], countries: [] });
    } else {
      const own = everywhere || (feedCountry != null && whole.length === 1 && whole[0] === feedCountry);
      onSave({ mode: "mix", players: everywhere ? [] : added, excluded, countries: own ? [] : whole });
    }
    onClose();
  };

  const placeRow = (code: string, name: string, state: { label: string; active: boolean }, options: { indent?: boolean; open?: boolean } = {}) => (
    <div key={code} className={`flex shrink-0 items-center rounded-md sm:w-full ${view === code ? "bg-white/[0.1] text-white" : "text-osu-l1 hover:bg-white/[0.05]"}`}>
      <button
        type="button"
        onClick={() => openView(code)}
        aria-pressed={view === code}
        title={name}
        className={`flex min-w-0 flex-1 items-center gap-2 py-1.5 pr-2 text-left ${options.indent ? "pl-7" : "pl-2"}`}
      >
        {code === ALL_VIEW ? null : <CountryFlag code={code} size="sm" decorative />}
        <span className="min-w-0 truncate text-[13px] font-semibold">{name}</span>
        <span className={`ml-auto shrink-0 pl-2 text-[12px] ${state.active ? "text-osu-pink-light" : "text-osu-f1"}`}>{state.label}</span>
      </button>
      {options.open === undefined ? null : (
        <button
          type="button"
          aria-label={options.open ? t`Hide its countries` : t`Show its countries`}
          aria-expanded={options.open}
          onClick={() => setExpanded((prev) => (prev.includes(code) ? prev.filter((c) => c !== code) : [...prev, code]))}
          className="shrink-0 py-1.5 pr-2 text-osu-f1 hover:text-white"
        >
          <ChevronDown className={`h-3.5 w-3.5 transition-transform ${options.open ? "rotate-180" : ""}`} />
        </button>
      )}
    </div>
  );

  const topLevel = groupRows.rows.length + groupRows.loose.length;
  const viewName = view === ALL_VIEW
    ? t`All countries`
    : view === EVERYWHERE ? t`every country` : groupRows.rows.find((g) => g.code === view)?.name ?? getCountryName(view);
  const masterOn = view === EVERYWHERE ? everywhere : viewCountries.length > 0 && viewCountries.every((c) => isWhole(c));

  return createPortal(
    <div
      className="fixed inset-0 z-[140] flex items-center justify-center bg-black/70 py-3 pl-3 pr-[calc(0.75rem+var(--modal-scrollbar-compensation,0px))] sm:py-6 sm:pl-4 sm:pr-[calc(1rem+var(--modal-scrollbar-compensation,0px))]"
      role="dialog"
      aria-modal="true"
      aria-label={title}
      onClick={(event) => { if (event.target === event.currentTarget && !pressed.current) onClose(); }}
    >
      <div className="flex h-full max-h-full w-full max-w-[820px] flex-col rounded-xl bg-osu-b5 p-5 sm:h-[640px]">
        <h2 className="text-[16px] font-bold text-white">{title}</h2>

        <div className="mt-4 flex min-h-0 flex-1 flex-col gap-3 sm:grid sm:grid-cols-[240px_minmax(0,1fr)] sm:gap-5">
          <div className="flex min-h-0 min-w-0 flex-col gap-2">
            <SelectMenu
              value=""
              options={addOptions}
              searchable
              block
              ariaLabel={t`Add a country or region`}
              triggerLabel={t`Add a country or region`}
              onChange={(value) => { if (value) addPlace(value); }}
            />
            <div className="-mx-1 flex gap-1 overflow-x-auto px-1 pb-1 sm:mx-0 sm:min-h-0 sm:flex-1 sm:flex-col sm:gap-0.5 sm:overflow-y-auto sm:px-0">
              {feedCountry == null ? placeRow(EVERYWHERE, t`Every country`, everywhere ? { label: excluded.length ? t`All but ${excluded.length}` : t`Everyone`, active: true } : { label: t`None`, active: false }) : null}
              {topLevel > 1 ? placeRow(ALL_VIEW, t`All countries`, stateOf(listed)) : null}
              {groupRows.rows.map((group) => {
                const open = expanded.includes(group.code);
                return [
                  placeRow(group.code, group.name, stateOf(group.countries), { open }),
                  ...(open ? group.countries.map((code) => placeRow(code, getCountryName(code), stateOf([code]), { indent: true })) : []),
                ];
              })}
              {groupRows.loose.map((code) => placeRow(code, getCountryName(code), stateOf([code])))}
            </div>
          </div>

          <div className="flex min-h-0 min-w-0 flex-1 flex-col">
            {view === ALL_VIEW ? null : (
              <div className="flex items-center gap-3 border-b border-white/[0.07] pb-2">
                <button
                  type="button"
                  role="checkbox"
                  aria-checked={masterOn}
                  disabled={view !== EVERYWHERE && everywhere}
                  onClick={() => (view === EVERYWHERE ? setEveryCountry(!everywhere) : setCountriesWhole(viewCountries, !masterOn))}
                  className="flex min-w-0 items-center gap-2.5 px-1.5 py-1 text-left disabled:opacity-50"
                >
                  <span className={`flex h-[18px] w-[18px] shrink-0 items-center justify-center rounded-[5px] ${masterOn ? "bg-osu-pink" : "bg-white/[0.1]"}`}>
                    {masterOn ? <Check className="h-3 w-3 text-white" strokeWidth={3.5} /> : null}
                  </span>
                  <span className="truncate text-[14px] font-bold text-white"><Trans>Everyone in {viewName}</Trans></span>
                </button>
                {view === EVERYWHERE ? null : (
                  <button type="button" onClick={() => removeCountries(viewCountries)} className="ml-auto shrink-0 text-[12px] font-semibold text-osu-f1 hover:text-white">
                    <Trans>Remove</Trans>
                  </button>
                )}
              </div>
            )}

            {viewCountries.length ? (
              <input
                value={query}
                onChange={(event) => setQuery(event.target.value.slice(0, 30))}
                placeholder={t`Search a player`}
                aria-label={t`Search a player`}
                className="mt-2 w-full rounded-lg bg-white/[0.07] px-3 py-2 text-[13px] text-white outline-none placeholder:text-osu-l2 focus:ring-1 focus:ring-osu-pink/60"
              />
            ) : null}

            <div className="mt-1 min-h-[160px] flex-1 overflow-y-auto">
              {!viewCountries.length ? (
                <p className="px-1.5 py-6 text-[13px] text-osu-f1"><Trans>Add a country to pick or leave out its players.</Trans></p>
              ) : !rows.length ? (
                <p className="px-1.5 py-6 text-[13px] text-osu-f1">{loading ? <Trans>Loading</Trans> : <Trans>No tracked players here.</Trans>}</p>
              ) : (
                <>
                  {rows.map((user) => {
                    const on = posts(user);
                    const stuck = blocked(user);
                    return (
                      <button
                        key={user.id}
                        type="button"
                        role="checkbox"
                        aria-checked={on}
                        disabled={stuck}
                        onPointerDown={(event) => {
                          if (event.pointerType !== "mouse" || event.button !== 0 || stuck) return;
                          event.preventDefault();
                          pressed.current = true;
                          drag.current = { on: !on };
                          setOn(user, !on);
                        }}
                        onPointerEnter={() => { if (drag.current) setOn(user, drag.current.on); }}
                        onClick={() => {
                          if (pressed.current) pressed.current = false;
                          else setOn(user, !on);
                        }}
                        className="flex w-full select-none items-center gap-2.5 border-t border-white/[0.07] px-1.5 py-1.5 text-left first:border-t-0 hover:bg-white/[0.04] disabled:opacity-40"
                      >
                        <span className={`flex h-[18px] w-[18px] shrink-0 items-center justify-center rounded-[5px] ${on ? "bg-osu-pink" : "bg-white/[0.1]"}`}>
                          {on ? <Check className="h-3 w-3 text-white" strokeWidth={3.5} /> : null}
                        </span>
                        {user.avatarUrl ? <img src={user.avatarUrl} alt="" loading="lazy" className="h-6 w-6 shrink-0 rounded-full" /> : <span className="h-6 w-6 shrink-0 rounded-full bg-white/[0.1]" />}
                        <span className={`min-w-0 truncate text-[14px] font-semibold ${on ? "text-white" : "text-osu-l2"}`}>{user.username}</span>
                        {user.countryCode && viewCountries.length > 1 ? <span className="text-[11px] text-osu-f1">{user.countryCode}</span> : null}
                        {user.pp != null ? <span className="ml-auto shrink-0 text-[13px] text-osu-l2">{Math.round(user.pp).toLocaleString("en-US")}pp</span> : null}
                      </button>
                    );
                  })}
                  {list.length < total ? (
                    <div className="flex items-center gap-3 border-t border-white/[0.07] px-1.5 py-2 text-[12px] text-osu-f1">
                      <Trans>Showing {list.length} of {total}</Trans>
                      <button type="button" disabled={loading} onClick={more} className="ml-auto rounded-md bg-white/[0.07] px-2.5 py-1 text-[12px] font-semibold text-white hover:brightness-110 disabled:opacity-50">
                        <Trans>Show more</Trans>
                      </button>
                    </div>
                  ) : null}
                </>
              )}
            </div>
          </div>
        </div>

        <div className="mt-4 flex shrink-0 flex-wrap items-center justify-end gap-2 border-t border-white/[0.07] pt-3">
          <p className="mr-auto min-w-0 text-[13px] text-osu-l1">{summarize(scope, everywhere ? 0 : added.length, excluded.length)}</p>
          <button type="button" onClick={onClose} className="rounded-lg px-3.5 py-2 text-[13px] font-bold text-osu-l2 hover:bg-white/[0.07] hover:text-white">
            <Trans>Cancel</Trans>
          </button>
          <button
            type="button"
            disabled={!changed || nobody}
            onClick={save}
            className="rounded-lg bg-osu-pink px-4 py-2 text-[13px] font-bold text-white hover:brightness-110 disabled:opacity-40"
          >
            <Trans>Save</Trans>
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
