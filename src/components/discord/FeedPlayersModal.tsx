import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Trans, useLingui } from "@lingui/react/macro";
import { Check, X } from "lucide-react";

import { useBodyScrollLock } from "../../lib/use-body-scroll-lock";
import { fetchLiveRosterPlayers, type LiveUserSearchEntry } from "../../lib/live-backend";
import { CONTINENT_OPTIONS, REGION_OPTIONS, getRegionDef } from "../../lib/regions";
import { getCountryName } from "../../lib/country";
import type { BotFeedPlayer } from "../../lib/discord-bot";
import { CountryFlag } from "../ui/CountryFlag";
import { SelectMenu, type SelectMenuOption } from "../ui/SelectMenu";

const PAGE = 30;
const SCOPE_KEY = "mania-hub-feed-picker-countries";
// Past this many countries the chips stop helping; the region's name stands in.
const MAX_CHIPS = 14;

function readScope(): string[] {
  try {
    const stored = JSON.parse(window.localStorage.getItem(SCOPE_KEY) ?? "[]") as unknown;
    return Array.isArray(stored) ? stored.filter((code): code is string => typeof code === "string" && /^[A-Z]{2}$/.test(code)) : [];
  } catch {
    return [];
  }
}

/**
 * The players a top-play feed posts for. The left side browses the tracked
 * players of the chosen countries, highest pp first; the right side is who is
 * picked. Nothing is picked by choosing a country: a feed only ever takes the
 * players ticked here.
 */
export function FeedPlayersModal({ title, players, max, fallbackCountry, onSave, onClose }: {
  title: string;
  players: BotFeedPlayer[];
  max: number;
  /** Shown first when this browser has no countries remembered. */
  fallbackCountry: string | null;
  onSave: (players: BotFeedPlayer[]) => void;
  onClose: () => void;
}) {
  const { t } = useLingui();
  useBodyScrollLock(true);
  const [picked, setPicked] = useState(players);
  const [countries, setCountries] = useState<string[]>(() => {
    const stored = readScope();
    if (stored.length) return stored;
    return fallbackCountry && /^[A-Z]{2}$/.test(fallbackCountry) ? [fallbackCountry] : [];
  });
  const [region, setRegion] = useState("");
  const [codeDraft, setCodeDraft] = useState("");
  const [query, setQuery] = useState("");
  const [list, setList] = useState<LiveUserSearchEntry[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  const request = useRef(0);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  useEffect(() => {
    try { window.localStorage.setItem(SCOPE_KEY, JSON.stringify(countries)); } catch { /* private mode */ }
  }, [countries]);

  const scopeKey = countries.join(",");
  useEffect(() => {
    const id = ++request.current;
    if (!countries.length) {
      setList([]);
      setTotal(0);
      return;
    }
    setLoading(true);
    const timer = setTimeout(() => {
      void fetchLiveRosterPlayers(countries, { query, limit: PAGE })
        .then((page) => { if (request.current === id) { setList(page.users); setTotal(page.total); } })
        .catch(() => { if (request.current === id) { setList([]); setTotal(0); } })
        .finally(() => { if (request.current === id) setLoading(false); });
    }, query ? 200 : 0);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scopeKey, query]);

  const more = () => {
    const id = ++request.current;
    setLoading(true);
    void fetchLiveRosterPlayers(countries, { query, limit: PAGE, offset: list.length })
      .then((page) => { if (request.current === id) { setList((current) => [...current, ...page.users]); setTotal(page.total); } })
      .catch(() => {})
      .finally(() => { if (request.current === id) setLoading(false); });
  };

  const regionOptions = useMemo<SelectMenuOption<string>[]>(() => [
    { value: "", label: t`Pick a region` },
    ...REGION_OPTIONS.map((entry) => ({ value: entry.code, label: entry.name, leading: <CountryFlag code={entry.code} size="md" decorative /> })),
    ...CONTINENT_OPTIONS.map((entry) => ({ value: entry.code, label: entry.name, leading: <CountryFlag code={entry.code} size="md" decorative /> })),
  ], [t]);

  const pickedIds = useMemo(() => new Set(picked.map((player) => player.id)), [picked]);
  const full = picked.length >= max;
  const toggle = (user: LiveUserSearchEntry) => {
    if (pickedIds.has(user.id)) setPicked(picked.filter((player) => player.id !== user.id));
    else if (!full) setPicked([...picked, { id: user.id, username: user.username, avatarUrl: user.avatarUrl || null }]);
  };
  const addCountry = () => {
    const code = codeDraft.trim().toUpperCase();
    if (/^[A-Z]{2}$/.test(code) && !countries.includes(code)) {
      setCountries([...countries, code]);
      setRegion("");
    }
    setCodeDraft("");
  };
  const changed = picked.length !== players.length || picked.some((player, index) => player.id !== players[index]?.id);
  const regionName = region ? getRegionDef(region)?.name : null;

  return createPortal(
    <div
      className="fixed inset-0 z-[140] flex items-center justify-center bg-black/70 py-3 pl-3 pr-[calc(0.75rem+var(--modal-scrollbar-compensation,0px))] sm:py-6 sm:pl-4 sm:pr-[calc(1rem+var(--modal-scrollbar-compensation,0px))]"
      role="dialog"
      aria-modal="true"
      aria-label={title}
      onClick={(event) => { if (event.target === event.currentTarget) onClose(); }}
    >
      <div className="flex max-h-full w-full max-w-[820px] flex-col rounded-xl bg-osu-b5 p-5">
        <h2 className="text-[16px] font-bold text-white">{title}</h2>

        <div className="mt-4 flex min-h-0 flex-1 flex-col gap-4 sm:grid sm:grid-cols-[minmax(0,1fr)_240px] sm:gap-6">
          <div className="flex min-h-0 min-w-0 flex-1 flex-col">
            <div className="flex flex-wrap items-center gap-1.5">
              <SelectMenu
                value={region}
                options={regionOptions}
                searchable
                ariaLabel={t`Region`}
                onChange={(value) => {
                  setRegion(value);
                  const members = getRegionDef(value)?.countries;
                  if (members) setCountries([...members]);
                }}
              />
              <input
                value={codeDraft}
                onChange={(event) => setCodeDraft(event.target.value.replace(/[^a-zA-Z]/g, "").slice(0, 2).toUpperCase())}
                onKeyDown={(event) => { if (event.key === "Enter") addCountry(); }}
                onBlur={addCountry}
                placeholder={t`Add a country code`}
                aria-label={t`Add a country code`}
                className="w-40 rounded-md bg-white/[0.07] px-2.5 py-1.5 text-[13px] text-white outline-none placeholder:text-osu-l2 focus:ring-1 focus:ring-osu-pink/60"
              />
            </div>
            {countries.length ? (
              <div className="mt-2 flex flex-wrap items-center gap-1.5">
                {countries.length > MAX_CHIPS ? (
                  <span className="text-[12px] text-osu-f1">
                    {regionName ? `${regionName}, ` : ""}<Trans>{countries.length} countries</Trans>
                  </span>
                ) : countries.map((code) => (
                  <button
                    key={code}
                    type="button"
                    title={getCountryName(code)}
                    aria-label={t`Remove ${getCountryName(code)}`}
                    onClick={() => { setCountries(countries.filter((entry) => entry !== code)); setRegion(""); }}
                    className="inline-flex items-center gap-1.5 rounded-md bg-osu-pink px-2 py-0.5 text-[12px] font-bold text-white hover:brightness-110"
                  >
                    <CountryFlag code={code} size="sm" decorative />
                    {code}
                    <X className="h-3 w-3 opacity-80" />
                  </button>
                ))}
                <button type="button" onClick={() => { setCountries([]); setRegion(""); }} className="px-1 text-[12px] font-semibold text-osu-f1 hover:text-white">
                  <Trans>Clear</Trans>
                </button>
              </div>
            ) : null}

            <input
              value={query}
              onChange={(event) => setQuery(event.target.value.slice(0, 30))}
              placeholder={t`Search a player`}
              aria-label={t`Search a player`}
              disabled={!countries.length}
              className="mt-3 w-full rounded-lg bg-white/[0.07] px-3 py-2 text-[13px] text-white outline-none placeholder:text-osu-l2 focus:ring-1 focus:ring-osu-pink/60 disabled:opacity-50"
            />

            <div className="mt-2 min-h-[120px] flex-1 overflow-y-auto sm:min-h-[260px]">
              {!countries.length ? (
                <p className="px-1 py-6 text-[13px] text-osu-f1"><Trans>Pick a region or add a country to see its players.</Trans></p>
              ) : !list.length ? (
                <p className="px-1 py-6 text-[13px] text-osu-f1">{loading ? <Trans>Loading</Trans> : <Trans>No tracked players here.</Trans>}</p>
              ) : (
                <>
                  {list.map((user) => {
                    const on = pickedIds.has(user.id);
                    return (
                      <button
                        key={user.id}
                        type="button"
                        role="checkbox"
                        aria-checked={on}
                        disabled={!on && full}
                        onClick={() => toggle(user)}
                        className="flex w-full items-center gap-2.5 border-t border-white/[0.07] px-1.5 py-1.5 text-left hover:bg-white/[0.04] disabled:opacity-40"
                      >
                        <span className={`flex h-[18px] w-[18px] shrink-0 items-center justify-center rounded-[5px] ${on ? "bg-osu-pink" : "bg-white/[0.1]"}`}>
                          {on ? <Check className="h-3 w-3 text-white" strokeWidth={3.5} /> : null}
                        </span>
                        {user.avatarUrl ? <img src={user.avatarUrl} alt="" loading="lazy" className="h-6 w-6 shrink-0 rounded-full" /> : <span className="h-6 w-6 shrink-0 rounded-full bg-white/[0.1]" />}
                        <span className="min-w-0 truncate text-[14px] font-semibold text-white">{user.username}</span>
                        {user.countryCode ? <span className="text-[11px] text-osu-f1">{user.countryCode}</span> : null}
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

          <div className="flex min-h-0 min-w-0 shrink-0 flex-col sm:shrink">
            <div className="flex items-center text-[12px] text-osu-f1">
              <Trans>Picked {picked.length} of {max}</Trans>
              {picked.length ? (
                <button type="button" onClick={() => setPicked([])} className="ml-auto font-semibold hover:text-white"><Trans>Clear</Trans></button>
              ) : null}
            </div>
            <div className="mt-2 flex max-h-[84px] flex-wrap content-start gap-1.5 overflow-y-auto sm:max-h-none sm:min-h-0 sm:flex-1">
              {picked.length === 0 ? <p className="text-[13px] text-osu-l2"><Trans>Nobody yet.</Trans></p> : null}
              {picked.map((player) => (
                <span key={player.id} className="inline-flex max-w-full items-center gap-1.5 rounded-md bg-white/[0.07] py-1 pl-1.5 pr-1 text-[13px] font-semibold text-white">
                  {player.avatarUrl ? <img src={player.avatarUrl} alt="" className="h-4 w-4 shrink-0 rounded-full" /> : null}
                  <span className="truncate">{player.username}</span>
                  <button type="button" aria-label={t`Remove ${player.username}`} onClick={() => setPicked(picked.filter((entry) => entry.id !== player.id))} className="shrink-0 p-0.5 text-osu-f1 hover:text-white">
                    <X className="h-3 w-3" />
                  </button>
                </span>
              ))}
            </div>
          </div>
        </div>

        <div className="mt-4 flex shrink-0 items-center justify-end gap-2">
          <button type="button" onClick={onClose} className="rounded-lg px-3.5 py-2 text-[13px] font-bold text-osu-l2 hover:bg-white/[0.07] hover:text-white">
            <Trans>Cancel</Trans>
          </button>
          <button
            type="button"
            disabled={!changed}
            onClick={() => { onSave(picked); onClose(); }}
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
