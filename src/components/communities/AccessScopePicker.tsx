import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Trans, useLingui } from "@lingui/react/macro";
import { Check, ChevronDown, Globe, Lock, Search } from "lucide-react";
import { COMMUNITY_MAX_ACCESS_SCOPES } from "../../lib/communities-shared";
import { COUNTRY_OPTIONS, displayCountryName } from "../../lib/country";
import { useLocale } from "../../lib/locale-context";
import { CONTINENT_OPTIONS, REGION_OPTIONS } from "../../lib/regions";
import { CountryFlag } from "../ui/CountryFlag";
import { RegionIcon } from "../ui/RegionIcon";

/*
 * Who a server is for, for the forms that post one and edit one.
 *
 * Empty is everyone, which is what almost every server is. Naming places is for
 * the France server that wants French players, and it can be said as a
 * continent, a subregion or a handful of countries, mixed freely.
 *
 * A popover rather than a panel that unfolds in the form, and for the same
 * reason the country field next to it is one: a list of 250 places opened
 * inline pushed Save off the screen, and the field is answered "everyone" by
 * nearly everyone. Open, it costs the form nothing; closed, it is one row that
 * says the answer.
 *
 * Worth saying plainly in the copy here, because someone will otherwise post a
 * private community on it: this filters, it does not enforce. The backend keeps
 * the invite out of everyone else's response, but the first person let in can
 * paste it anywhere. A real wall is Discord's own membership screening.
 */

interface ScopeEntry {
  code: string;
  label: string;
  leading: ReactNode;
  // What the filter box matches on: the name as drawn plus the English one, so
  // someone typing "France" still finds it on a page drawn in another language.
  search: string;
}

interface ScopeRow {
  code: string;
  name: string;
  leading: ReactNode;
}

const REGION_ROWS: ScopeRow[] = [...CONTINENT_OPTIONS, ...REGION_OPTIONS].map((region) => ({
  code: region.code,
  name: region.name,
  leading: <RegionIcon code={region.code} className="h-3.5 w-4 text-osu-f1" />,
}));

const COUNTRY_ROWS: ScopeRow[] = COUNTRY_OPTIONS.map((country) => ({
  code: country.code,
  name: country.name,
  leading: <CountryFlag code={country.code} size="sm" decorative />,
}));

/**
 * What the locked card says instead of Join, in the reader's language. The
 * English source of this lives in describeAccessScopes (communities-shared),
 * which the moderator queue still reads; keep the two saying the same thing.
 *
 * Two names fit on a pill; past that it counts, because "France, Belgium,
 * Switzerland and 4 more" is not a label.
 */
export function useAccessScopeSummary() {
  const { t } = useLingui();
  const locale = useLocale();
  return useMemo(
    () => (scopes: string[] | undefined) => {
      if (!scopes || scopes.length === 0) return null;
      const [first, second] = scopes;
      const firstName = displayCountryName(first, locale);
      if (scopes.length === 1) return t`${firstName} only`;
      if (scopes.length === 2) {
        const secondName = displayCountryName(second, locale);
        return t`${firstName} and ${secondName}`;
      }
      const others = scopes.length - 1;
      return t`${firstName} and ${others} more`;
    },
    [t, locale],
  );
}

// Roughly what the popover stands to be, for deciding whether it opens downward
// or up. Same trick as SelectMenu, which had the same problem in this modal.
const MENU_HEIGHT_PX = 330;

export function AccessScopePicker({
  scopes,
  hidden,
  onChange,
}: {
  scopes: string[];
  hidden: boolean;
  onChange: (next: { scopes: string[]; hidden: boolean }) => void;
}) {
  const { t } = useLingui();
  const locale = useLocale();
  const summarize = useAccessScopeSummary();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [dropUp, setDropUp] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const restricted = scopes.length > 0;
  const full = scopes.length >= COMMUNITY_MAX_ACCESS_SCOPES;

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: MouseEvent) => {
      if (!ref.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      // Stopped here rather than left to bubble, or Escape would close the whole
      // modal from inside an open menu.
      if (event.key !== "Escape") return;
      event.stopPropagation();
      setOpen(false);
    };
    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKeyDown, true);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown, true);
    };
  }, [open]);

  const search = query.trim().toLowerCase();
  const [regions, countries] = useMemo(() => {
    const build = (rows: ScopeRow[]): ScopeEntry[] =>
      rows.map((row) => {
        const label = displayCountryName(row.code, locale);
        return { code: row.code, label, leading: row.leading, search: `${label} ${row.name}`.toLowerCase() };
      });
    const match = (entry: ScopeEntry) =>
      search === "" || entry.search.includes(search) || entry.code.toLowerCase().includes(search);
    return [build(REGION_ROWS).filter(match), build(COUNTRY_ROWS).filter(match)];
  }, [search, locale]);

  const toggle = (code: string) => {
    const next = scopes.includes(code) ? scopes.filter((scope) => scope !== code) : [...scopes, code];
    if (next.length > COMMUNITY_MAX_ACCESS_SCOPES) return;
    // Nothing named is a server for everyone, and a server for everyone cannot
    // be hidden from anyone.
    onChange({ scopes: next, hidden: next.length === 0 ? false : hidden });
  };

  const summary = summarize(scopes) ?? t`Everyone`;

  return (
    <div className="relative" ref={ref}>
      <button
        type="button"
        onClick={() => {
          const rect = ref.current?.getBoundingClientRect();
          if (rect) setDropUp(window.innerHeight - rect.bottom < MENU_HEIGHT_PX && rect.top > MENU_HEIGHT_PX);
          setOpen((value) => !value);
          setQuery("");
        }}
        aria-label={t`Who can join`}
        className="flex w-full items-center justify-between gap-2 rounded-lg border border-osu-b3/30 bg-osu-b4 px-3 py-2 text-[12.5px] text-osu-l1 transition-colors cursor-pointer hover:border-osu-b3/60"
      >
        <span className="flex min-w-0 items-center gap-2 truncate">
          {restricted ? (
            <Lock className="h-3.5 w-3.5 shrink-0 text-osu-f1" aria-hidden="true" />
          ) : (
            <Globe className="h-3.5 w-3.5 shrink-0 text-osu-f1" aria-hidden="true" />
          )}
          <span className="truncate">
            {summary}
            {restricted && hidden && (
              <span className="text-osu-f1">
                <Trans>, hidden from everyone else</Trans>
              </span>
            )}
          </span>
        </span>
        <ChevronDown className={`h-3.5 w-3.5 shrink-0 text-osu-f1 transition-transform ${open ? "rotate-180" : ""}`} />
      </button>

      {open && (
        <div
          className={`absolute z-30 w-full overflow-hidden rounded-lg border border-osu-b3/40 bg-osu-b5 shadow-xl shadow-black/40 ${
            dropUp ? "bottom-full mb-1" : "top-full mt-1"
          }`}
        >
          <div className="flex items-center gap-2 border-b border-osu-b3/25 px-2.5 py-1.5">
            <Search className="h-3.5 w-3.5 shrink-0 text-osu-f1" aria-hidden="true" />
            <input
              type="text"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder={t`Europe, Central America, France`}
              aria-label={t`Search places`}
              autoFocus
              className="min-w-0 flex-1 bg-transparent text-[12.5px] text-white outline-none placeholder:text-osu-f1/60"
            />
          </div>

          <div className="max-h-56 overflow-y-auto">
            {/* The way back to the common answer, kept at the top rather than as
                a second control beside the field. */}
            {search === "" && (
              <Row
                label={t`Everyone`}
                leading={<Globe className="h-3.5 w-3.5 text-osu-f1" aria-hidden="true" />}
                picked={!restricted}
                onClick={() => onChange({ scopes: [], hidden: false })}
              />
            )}
            <ScopeGroup title={t`Regions`} entries={regions} scopes={scopes} full={full} onToggle={toggle} />
            <ScopeGroup title={t`Countries`} entries={countries} scopes={scopes} full={full} onToggle={toggle} />
            {regions.length === 0 && countries.length === 0 && (
              <p className="px-3 py-4 text-center text-[11.5px] text-osu-f1">
                <Trans>Nothing by that name.</Trans>
              </p>
            )}
          </div>

          <div className="border-t border-osu-b3/25 bg-osu-b4/60 px-3 py-2">
            {restricted && (
              <label className="flex cursor-pointer items-center gap-2 text-[11.5px] text-osu-l2">
                <input
                  type="checkbox"
                  checked={hidden}
                  onChange={(event) => onChange({ scopes, hidden: event.target.checked })}
                  className="h-3.5 w-3.5 shrink-0 cursor-pointer accent-osu-pink"
                />
                <Trans>Hide it from everyone else, instead of showing it with no way in</Trans>
              </label>
            )}
            {/* The one thing worth saying that the controls do not: this says
                who a server is for, it does not hold a door shut. */}
            <p className={`text-[11px] leading-relaxed text-osu-f1/70 ${restricted ? "mt-1.5" : ""}`}>
              <Trans>
                Goes by the country on someone's osu! account, and anyone already in can still share the
                invite.
              </Trans>
            </p>
          </div>
        </div>
      )}
    </div>
  );
}

function ScopeGroup({
  title,
  entries,
  scopes,
  full,
  onToggle,
}: {
  title: string;
  entries: ScopeEntry[];
  scopes: string[];
  full: boolean;
  onToggle: (code: string) => void;
}) {
  if (entries.length === 0) return null;
  return (
    <div>
      <p className="sticky top-0 bg-osu-b5 px-3 py-1.5 text-[10px] font-bold uppercase tracking-[0.08em] text-osu-f1/55">
        {title}
      </p>
      {entries.map((entry) => (
        <Row
          key={entry.code}
          label={entry.label}
          leading={entry.leading}
          picked={scopes.includes(entry.code)}
          // A full list still lets you take one back off, just not add another.
          disabled={full && !scopes.includes(entry.code)}
          onClick={() => onToggle(entry.code)}
        />
      ))}
    </div>
  );
}

function Row({
  label,
  leading,
  picked,
  disabled = false,
  onClick,
}: {
  label: string;
  leading: ReactNode;
  picked: boolean;
  disabled?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={`flex w-full items-center gap-2 px-3 py-1.5 text-left text-[12.5px] transition-colors cursor-pointer hover:bg-osu-b3/40 disabled:cursor-default disabled:opacity-40 ${
        picked ? "text-white" : "text-osu-l2"
      }`}
    >
      <span className="flex h-4 w-4 shrink-0 items-center justify-center">{leading}</span>
      <span className="min-w-0 flex-1 truncate">{label}</span>
      {picked && <Check className="h-3.5 w-3.5 shrink-0 text-osu-pink" aria-hidden="true" />}
    </button>
  );
}
