import { createFileRoute, notFound, useNavigate } from "@tanstack/react-router";
import { useCallback, useEffect, useRef, useState } from "react";
import { Loader2, Trash2, Wand2, X } from "lucide-react";

import { SectionCard } from "../../components/admin/SectionCard";
import { Avatar, avatarImageSrc } from "../../components/ui/Avatar";
import { CountryFlag } from "../../components/ui/CountryFlag";
import { SearchInput } from "../../components/ui/SearchInput";
import { SegmentedControl } from "../../components/ui/SegmentedControl";
import { SelectMenu, type SelectMenuOption } from "../../components/ui/SelectMenu";
import {
  fetchAdminCollection,
  grantAdminCollectionCard,
  removeAdminCollectionCard,
  setAdminCollectionWallet,
  type AdminCollectionCard,
  type AdminCollectionOverview,
} from "../../lib/admin-collections";
import {
  buildCardGrant,
  emptyCardForm,
  formTier,
  numberOrUndefined,
  SKILL_FIELDS,
  TIER_ORDER,
  toLocalInput,
  type CardForm,
} from "../../lib/admin-collections-form";
import { canUseAdminFeatures } from "../../lib/auth-shared";
import { normalizeCardMotifUrl } from "../../lib/card-motif";
import { formatNumber } from "../../lib/format";
import { fetchLivePackCardSnapshotDirect } from "../../lib/live-backend";
import {
  computeManiaSkills,
  getManiaCardTier,
  HONORARY_TIER_USER_IDS,
  MANIA_TIER_STYLES,
} from "../../lib/maniacard";
import { fetchPackPlayerScores } from "../../lib/packs";
import { shardValueForTier } from "../../lib/pack-collection";
import { searchPlayers } from "../../lib/player-search";
import {
  COLLECTIONS_RECENT_KEY,
  readRecentPlayers,
  recordRecentPlayer,
  removeRecentPlayer,
  type RecentPlayer,
} from "../../lib/recent-players";

/* The grant desk for the pack economy: give anyone shards, mint them a card
   with every field on it chosen by hand, or take one back.
 *
 * The point of the page is that it is not the game. /packs deals cards by the
 * pool's odds and pays for them out of a wallet the server owns, and every
 * guard on that path exists because the other side of the wire is a stranger:
 * copies can only be added by a draw, GOAT is gated on the honorary roster
 * because it recycles for 500 shards, a card's face is first-write-wins so one
 * forged sync cannot repaint everybody's copy. None of that is a rule about the
 * owner, so this page writes what it is told and prints the consequences next
 * to the controls that carry them instead.
 *
 * Two things it deliberately cannot do. A granted card writes no pull event, so
 * it never appears in the community pull ticker as something that was pulled;
 * and it pays no arcade ledger row, so a grant never eats into anyone's daily
 * shard allowance.
 */

/* Who is on screen lives in the URL, so a refresh (or a reload after an edit
   to this file) comes back to the same collector instead of an empty picker,
   and a person can be linked to. Only the collector is canonical: the page and
   name filter ride along because they are what you were looking at, and the
   mode because losing your place in a form is the same annoyance. */
interface CollectionsSearch {
  user?: number;
  page?: number;
  q?: string;
  mode?: "advanced";
}

export const Route = createFileRoute("/admin/collections")({
  validateSearch: (search: Record<string, unknown>): CollectionsSearch => {
    const user = Math.floor(Number(search.user));
    const page = Math.floor(Number(search.page));
    const q = typeof search.q === "string" ? search.q.trim() : "";
    return {
      ...(Number.isInteger(user) && user > 0 ? { user } : {}),
      ...(Number.isInteger(page) && page > 0 ? { page } : {}),
      ...(q ? { q } : {}),
      ...(search.mode === "advanced" ? { mode: "advanced" as const } : {}),
    };
  },
  head: () => ({
    meta: [
      { title: "Collections - admin" },
      { name: "robots", content: "noindex, nofollow" },
    ],
  }),
  beforeLoad: ({ context }) => {
    if (!canUseAdminFeatures(context.auth)) {
      throw notFound();
    }
    return undefined as never;
  },
  component: CollectionsAdminPage,
});

const INPUT = "w-full px-2.5 py-1.5 rounded-md bg-osu-b4/60 border border-osu-b3/40 text-[13px] text-osu-c1 placeholder:text-osu-f1/70 focus:border-osu-h1/40 focus:outline-none transition-colors duration-[120ms]";
const BUTTON = "px-2.5 py-1.5 rounded-md bg-osu-b4/60 border border-osu-b3/30 text-[12px] text-osu-l2 hover:bg-osu-b3/60 hover:text-white transition-colors duration-[120ms] disabled:opacity-50 disabled:cursor-not-allowed cursor-pointer";
const PRIMARY = "px-3 py-1.5 rounded-md border border-osu-pink/50 bg-osu-pink/15 text-[12px] font-medium text-osu-pink-light hover:bg-osu-pink/25 transition-colors duration-[120ms] disabled:opacity-50 disabled:cursor-not-allowed cursor-pointer";
const LABEL = "block text-[10px] font-semibold uppercase tracking-[0.1em] text-osu-f1 mb-1";

const TIER_OPTIONS: SelectMenuOption<string>[] = [
  { value: "unrated", label: "Unrated" },
  ...TIER_ORDER.map((tier) => ({
    value: tier,
    label: `${MANIA_TIER_STYLES[tier].label} (${shardValueForTier(tier)} shards)`,
  })),
];

type PlayerRef = { id: number; username: string; avatarUrl: string; countryCode: string };

function errMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Something went wrong.";
}

function CollectionsAdminPage() {
  const search = Route.useSearch();
  const navigate = useNavigate();
  const [lookup, setLookup] = useState("");
  const [target, setTarget] = useState<PlayerRef | null>(null);
  const [overview, setOverview] = useState<AdminCollectionOverview | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const page = search.page ?? 0;
  const filter = search.q ?? "";
  /* Two views of the same form. Simple is every control needed to do the thing
     the page exists for - give shards, give somebody a card - with the card
     minted the way a real pull would mint it. Everything else is the long tail
     of fields a holding can carry, which is worth having and is not worth
     reading past forty of them to grant one card. */
  const advanced = search.mode === "advanced";

  const setSearch = useCallback((next: CollectionsSearch, options: { replace?: boolean } = {}) => {
    void navigate({ to: "/admin/collections", search: next, replace: options.replace ?? true });
  }, [navigate]);

  /* What the URL currently asks for, so the effect below can tell a real change
     from a re-render and a lookup by name can hand its answer straight over
     without the effect fetching the same page again. */
  const loadedRef = useRef<string | null>(null);

  const [recents, setRecents] = useState<RecentPlayer[]>([]);
  useEffect(() => setRecents(readRecentPlayers(COLLECTIONS_RECENT_KEY)), []);

  const load = useCallback(async (spec: { userId?: number; username?: string }, nextPage: number, query: string) => {
    setLoading(true);
    setError(null);
    try {
      const result = await fetchAdminCollection({ data: { ...spec, page: nextPage, query } });
      loadedRef.current = `${result.user.userId}|${nextPage}|${query}`;
      setOverview(result);
      setTarget((current) => ({
        id: result.user.userId,
        username: result.user.username ?? current?.username ?? String(result.user.userId),
        avatarUrl: current?.id === result.user.userId ? current.avatarUrl : "",
        countryCode: result.user.countryCode ?? "",
      }));
      /* Recorded on the read rather than on the click, so the row only ever
         holds collectors that resolved to a real account, and a typed id lands
         in it under the name the backend answered with. The avatar is left for
         the id to resolve, which is what Avatar does with an empty url. */
      if (result.user.username) {
        recordRecentPlayer(COLLECTIONS_RECENT_KEY, {
          userId: result.user.userId,
          username: result.user.username,
          avatarUrl: "",
        });
        setRecents(readRecentPlayers(COLLECTIONS_RECENT_KEY));
      }
      return result;
    } catch (caught) {
      setError(errMessage(caught));
      setOverview(null);
      return null;
    } finally {
      setLoading(false);
    }
  }, []);

  // The URL is the only thing that starts a read, so a refresh, the back
  // button and a pasted link all land on the same collector.
  useEffect(() => {
    if (!search.user) {
      loadedRef.current = null;
      setOverview(null);
      return;
    }
    if (loadedRef.current === `${search.user}|${page}|${filter}`) return;
    void load({ userId: search.user }, page, filter);
  }, [filter, load, page, search.user]);

  const refresh = useCallback(async () => {
    if (!search.user) return;
    await load({ userId: search.user }, page, filter);
  }, [filter, load, page, search.user]);

  /* Switching collector clears the last grant's line: it named a player who is
     no longer the one on screen, and a stale success message next to somebody
     else's cards reads as something that just happened to them. Pushed rather
     than replaced, so back returns to whoever you were looking at before. */
  const pick = useCallback((player: PlayerRef) => {
    setTarget(player);
    setLookup("");
    setNotice(null);
    setSearch({ user: player.id, ...(advanced ? { mode: "advanced" as const } : {}) }, { replace: false });
  }, [advanced, setSearch]);

  const submitLookup = useCallback(async () => {
    const trimmed = lookup.trim();
    if (!trimmed) return;
    setNotice(null);
    const mode = advanced ? { mode: "advanced" as const } : {};
    const asId = Math.floor(Number(trimmed));
    if (Number.isInteger(asId) && asId > 0) {
      setSearch({ user: asId, ...mode }, { replace: false });
      return;
    }
    // A name is not an id, so it is resolved first and the URL then names the
    // player it found. The ref stamped by the load keeps the effect from
    // fetching the same page a second time when that lands.
    const result = await load({ username: trimmed }, 0, "");
    if (result) {
      setLookup("");
      setSearch({ user: result.user.userId, ...mode }, { replace: false });
    }
  }, [advanced, load, lookup, setSearch]);

  return (
    <div className="flex-1">
      <div className="bg-osu-d5 border-b border-osu-b3/40">
        <div className="max-w-[1100px] mx-auto px-4 sm:px-5 py-3 flex items-center gap-3">
          <div className="relative flex-shrink-0">
            <span className="block w-2.5 h-2.5 rounded-full bg-osu-yellow" />
            {loading ? <span className="absolute inset-0 rounded-full bg-osu-yellow animate-ping opacity-75" /> : null}
          </div>
          <h2 className="text-[13px] sm:text-[15px] font-medium text-osu-c2">Collections</h2>
          <div className="ml-auto flex items-center gap-2">
            <SegmentedControl
              id="collections-mode"
              value={advanced ? "advanced" : "simple"}
              options={[{ value: "simple", label: "Simple" }, { value: "advanced", label: "Everything" }]}
              onChange={(value) => setSearch({ ...search, mode: value === "advanced" ? "advanced" : undefined })}
            />
            {overview ? (
              <button onClick={() => void refresh()} disabled={loading} className={BUTTON}>
                Refresh
              </button>
            ) : null}
          </div>
        </div>
      </div>

      <div className="bg-osu-b5 min-h-[calc(100vh-60px)]">
        <div className="max-w-[1100px] mx-auto px-4 sm:px-5 py-5 space-y-4">
          {error ? (
            <div className="rounded-lg border border-osu-red/30 bg-osu-red/10 px-3 py-2 text-[12px] text-osu-red-light">
              {error}
            </div>
          ) : null}
          {notice ? (
            <div className="rounded-lg border border-osu-green/30 bg-osu-green/10 px-3 py-2 text-[12px] text-osu-green-light">
              {notice}
            </div>
          ) : null}

          <SectionCard title="Who gets it">
            <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
              <SearchInput
                className="sm:w-[300px]"
                placeholder="Search a player..."
                onSearch={(q) => searchPlayers(q)}
                onSelect={(user) => pick({
                  id: user.id,
                  username: user.username,
                  avatarUrl: user.avatar_url,
                  countryCode: user.country_code,
                })}
              />
              {/* An id rather than a name is the only handle that reaches a
                  restricted or deleted account, and those hold cards too. */}
              <div className="flex items-center gap-2">
                <input
                  value={lookup}
                  onChange={(event) => setLookup(event.target.value)}
                  onKeyDown={(event) => { if (event.key === "Enter") void submitLookup(); }}
                  placeholder="or an osu! id"
                  className={`${INPUT} sm:w-[180px]`}
                />
                <button onClick={() => void submitLookup()} disabled={loading || !lookup.trim()} className={BUTTON}>
                  Load
                </button>
              </div>
            </div>

            {recents.length > 0 ? (
              <div className="mt-3">
                <div className="mb-1.5 text-[10px] font-semibold uppercase tracking-[0.1em] text-osu-f1">recent</div>
                <div className="flex flex-wrap gap-1.5">
                  {recents.map((player) => (
                    <div
                      key={player.userId}
                      className={`flex items-center rounded-lg border pl-1.5 pr-1 transition-colors duration-150 ${
                        player.userId === overview?.user.userId
                          ? "border-osu-pink/50 bg-osu-pink/10"
                          : "border-osu-b3/30 bg-osu-b4 hover:border-osu-pink/40 hover:bg-osu-b3"
                      }`}
                    >
                      <button
                        type="button"
                        onClick={() => pick({ id: player.userId, username: player.username, avatarUrl: player.avatarUrl, countryCode: "" })}
                        className="flex items-center gap-2 py-1.5 pr-1 cursor-pointer"
                      >
                        <Avatar url={player.avatarUrl} userId={player.userId} size={24} />
                        <span className="max-w-[120px] truncate text-[13px] font-medium text-osu-c1">{player.username}</span>
                      </button>
                      <button
                        type="button"
                        onClick={() => {
                          removeRecentPlayer(COLLECTIONS_RECENT_KEY, player.userId);
                          setRecents(readRecentPlayers(COLLECTIONS_RECENT_KEY));
                        }}
                        aria-label={`Remove ${player.username} from recent`}
                        className="flex h-5 w-5 shrink-0 items-center justify-center text-osu-f1 transition-colors hover:text-osu-c1 cursor-pointer"
                      >
                        <X className="h-3 w-3" />
                      </button>
                    </div>
                  ))}
                </div>
              </div>
            ) : null}

            {overview ? <TargetSummary overview={overview} target={target} /> : null}
          </SectionCard>

          {overview ? (
            <WalletPanel
              overview={overview}
              advanced={advanced}
              onDone={(message) => { setNotice(message); setError(null); void refresh(); }}
              onError={(message) => { setNotice(null); setError(message); }}
            />
          ) : null}

          {overview ? (
            <GrantPanel
              ownerUserId={overview.user.userId}
              advanced={advanced}
              onDone={(message) => { setNotice(message); setError(null); void refresh(); }}
              onError={(message) => { setNotice(null); setError(message); }}
            />
          ) : null}

          {overview ? (
            <CollectionPanel
              overview={overview}
              filter={filter}
              page={page}
              busy={loading}
              onFilter={(next) => setSearch({ ...search, q: next || undefined, page: undefined })}
              onPage={(next) => setSearch({ ...search, page: next > 0 ? next : undefined })}
              onRemoved={(message) => { setNotice(message); setError(null); void refresh(); }}
              onError={(message) => { setNotice(null); setError(message); }}
            />
          ) : null}
        </div>
      </div>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="text-[10px] font-semibold uppercase tracking-[0.1em] text-osu-f1">{label}</div>
      <div className="text-[18px] font-semibold text-white tabular-nums leading-tight">{value}</div>
    </div>
  );
}

function TargetSummary({ overview, target }: { overview: AdminCollectionOverview; target: PlayerRef | null }) {
  const name = overview.user.username ?? target?.username ?? String(overview.user.userId);
  return (
    <div className="mt-3 pt-3 border-t border-osu-b3/20">
      <div className="flex items-center gap-2.5">
        <img
          src={avatarImageSrc(target?.avatarUrl ?? "", overview.user.userId)}
          alt=""
          className="w-9 h-9 rounded-full"
          loading="lazy"
        />
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <a
              href={`https://osu.ppy.sh/users/${overview.user.userId}`}
              target="_blank"
              rel="noreferrer noopener"
              className="text-[15px] font-semibold text-white hover:text-osu-pink-light"
            >
              {name}
            </a>
            {overview.user.countryCode ? <CountryFlag code={overview.user.countryCode} size="sm" /> : null}
          </div>
          <div className="text-[11px] text-osu-f1">
            #{overview.user.userId}
            {overview.user.tracked ? "" : " - not in the users projection, so the card carries whatever face you type"}
            {overview.hasWallet ? "" : " - no wallet yet"}
          </div>
        </div>
      </div>
      <div className="mt-3 grid grid-cols-2 sm:grid-cols-6 gap-3">
        <Stat label="Shards" value={formatNumber(overview.economy.shards)} />
        <Stat label="Charges" value={`${overview.economy.charges}/5`} />
        <Stat label="Cards" value={formatNumber(overview.distinctCards)} />
        <Stat label="Copies" value={formatNumber(overview.totalCopies)} />
        <Stat label="Packs opened" value={formatNumber(overview.economy.openedPacks)} />
        <Stat label="Shards spent" value={formatNumber(overview.economy.shardsSpent)} />
      </div>
    </div>
  );
}

const QUICK_SHARDS = [50, 100, 500, 1000, 5000];

function WalletPanel({
  overview,
  advanced,
  onDone,
  onError,
}: {
  overview: AdminCollectionOverview;
  advanced: boolean;
  onDone: (message: string) => void;
  onError: (message: string) => void;
}) {
  const [amount, setAmount] = useState("100");
  const [charges, setCharges] = useState(String(overview.economy.charges));
  const [openedPacks, setOpenedPacks] = useState(String(overview.economy.openedPacks));
  const [shardsSpent, setShardsSpent] = useState(String(overview.economy.shardsSpent));
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    setCharges(String(overview.economy.charges));
    setOpenedPacks(String(overview.economy.openedPacks));
    setShardsSpent(String(overview.economy.shardsSpent));
  }, [overview.economy.charges, overview.economy.openedPacks, overview.economy.shardsSpent]);

  const send = useCallback(async (patch: Record<string, number>, message: string) => {
    setBusy(true);
    try {
      await setAdminCollectionWallet({ data: { userId: overview.user.userId, ...patch } });
      onDone(message);
    } catch (caught) {
      onError(errMessage(caught));
    } finally {
      setBusy(false);
    }
  }, [onDone, onError, overview.user.userId]);

  const value = Math.floor(Number(amount) || 0);

  return (
    <SectionCard title="Shards">
      <div className="flex flex-wrap items-end gap-2">
        <div className="w-[130px]">
          <span className={LABEL}>Amount</span>
          <input
            type="number"
            value={amount}
            onChange={(event) => setAmount(event.target.value)}
            className={INPUT}
          />
        </div>
        <button
          disabled={busy || value === 0}
          onClick={() => void send({ shardsDelta: value }, `Gave ${formatNumber(value)} shards.`)}
          className={PRIMARY}
        >
          Give
        </button>
        {advanced ? (
          <>
            <button
              disabled={busy || value === 0}
              onClick={() => void send({ shardsDelta: -value }, `Took ${formatNumber(value)} shards back.`)}
              className={BUTTON}
            >
              Take
            </button>
            <button
              disabled={busy}
              onClick={() => void send({ shards: value }, `Balance set to ${formatNumber(value)}.`)}
              className={BUTTON}
            >
              Set balance
            </button>
          </>
        ) : null}
        <div className="flex items-center gap-1.5 ml-auto">
          {QUICK_SHARDS.map((quick) => (
            <button key={quick} onClick={() => setAmount(String(quick))} className={BUTTON}>
              {formatNumber(quick)}
            </button>
          ))}
        </div>
      </div>

      {advanced ? (
        <div className="mt-3 pt-3 border-t border-osu-b3/20 flex flex-wrap items-end gap-2">
          <div className="w-[110px]">
            <span className={LABEL}>Charges</span>
            <input type="number" min={0} max={5} value={charges} onChange={(event) => setCharges(event.target.value)} className={INPUT} />
          </div>
          <div className="w-[130px]">
            <span className={LABEL}>Packs opened</span>
            <input type="number" min={0} value={openedPacks} onChange={(event) => setOpenedPacks(event.target.value)} className={INPUT} />
          </div>
          <div className="w-[130px]">
            <span className={LABEL}>Shards spent</span>
            <input type="number" min={0} value={shardsSpent} onChange={(event) => setShardsSpent(event.target.value)} className={INPUT} />
          </div>
          <button
            disabled={busy}
            onClick={() => void send(
              {
                charges: Number(charges) || 0,
                openedPacks: Number(openedPacks) || 0,
                shardsSpent: Number(shardsSpent) || 0,
              },
              "Wallet counters written.",
            )}
            className={BUTTON}
          >
            Apply
          </button>
          <span className="text-[11px] text-osu-f1">
            Charges refill one every 20s, so a bar set below 5 starts filling from now.
          </span>
        </div>
      ) : null}
    </SectionCard>
  );
}

function GrantPanel({
  ownerUserId,
  advanced,
  onDone,
  onError,
}: {
  ownerUserId: number;
  advanced: boolean;
  onDone: (message: string) => void;
  onError: (message: string) => void;
}) {
  const [card, setCard] = useState<PlayerRef | null>(null);
  const [rawId, setRawId] = useState("");
  const [form, setForm] = useState<CardForm>(emptyCardForm);
  const [busy, setBusy] = useState(false);
  const [filling, setFilling] = useState(false);

  const patch = useCallback((next: Partial<CardForm>) => setForm((current) => ({ ...current, ...next })), []);
  // Only https URLs are stored, so the preview refuses the same ones the grant
  // would, rather than showing a picture that will never reach a card.
  const motifPreviewUrl = normalizeCardMotifUrl(form.motifUrl);
  const [motifBroken, setMotifBroken] = useState<string | null>(null);
  const setSkill = useCallback((key: string, value: string) => {
    setForm((current) => ({ ...current, skillsMode: "set", skills: { ...current.skills, [key]: value } }));
  }, []);

  const cardUserId = card?.id ?? (Number.isInteger(Number(rawId)) ? Math.floor(Number(rawId)) : 0);
  const tier = formTier(form);
  const honorary = cardUserId > 0 && HONORARY_TIER_USER_IDS.has(cardUserId);

  /* Mints the same numbers a real pull would freeze: the player's stored best
     scores through the very rating pass the reveal runs, so a hand-granted card
     reads exactly like a dealt one unless it is then edited. Takes the id
     rather than reading it off state, because picking a player runs this in the
     same tick and would otherwise rate whoever was picked before. */
  const fillFromPlays = useCallback(async (userId: number, options: { keepTier?: boolean } = {}) => {
    if (userId <= 0) return;
    setFilling(true);
    try {
      const snapshot = await fetchLivePackCardSnapshotDirect(String(userId)).catch(() => null);
      const scores = snapshot?.bestScores?.length ? snapshot.bestScores : await fetchPackPlayerScores(userId);
      const skills = computeManiaSkills(scores, { globalPp: snapshot?.user.statistics?.pp });
      if (!skills) {
        onError("No ranked plays with full beatmap data, so there is nothing to rate.");
        return;
      }
      const filled: Record<string, string> = {};
      for (const field of SKILL_FIELDS) {
        const value = skills[field.key];
        if (typeof value === "number" && Number.isFinite(value)) filled[field.key] = String(Number(value.toFixed(2)));
      }
      setForm((current) => ({
        ...current,
        skillsMode: "set",
        skills: filled,
        archetype: skills.archetype ?? "",
        pp: snapshot?.user.statistics?.pp != null ? String(Math.round(snapshot.user.statistics.pp)) : current.pp,
        globalRank: snapshot?.user.statistics?.global_rank != null
          ? String(snapshot.user.statistics.global_rank)
          : current.globalRank,
        // The tier a pull would have dealt them. Rating on demand keeps a tier
        // chosen by hand (asking for GOAT and then for the numbers should not
        // undo the GOAT); choosing a different player replaces it, since it is
        // the previous player's tier by then.
        tier: options.keepTier && current.tier !== "unrated"
          ? current.tier
          : (HONORARY_TIER_USER_IDS.has(userId) ? "goat" : getManiaCardTier(skills.cardPower)),
      }));
      if (snapshot?.user) {
        setCard({
          id: userId,
          username: snapshot.user.username,
          avatarUrl: snapshot.user.avatar_url,
          countryCode: snapshot.user.country_code,
        });
      }
    } catch (caught) {
      onError(errMessage(caught));
    } finally {
      setFilling(false);
    }
  }, [onError]);

  /* Naming a different player means a different card, so the form starts over
     rather than carrying the last one's pp, rank and stat bars onto a face
     they do not belong to. */
  const chooseCardPlayer = useCallback((player: PlayerRef | null, userId: number) => {
    setForm(emptyCardForm());
    setCard(player);
    if (player) setRawId("");
    void fillFromPlays(userId);
  }, [fillFromPlays]);

  /* The typed-id twin of picking from the dropdown, fired on Enter and on
     leaving the box. Guarded on the id having changed, so tabbing through an
     already rated player does not re-fetch and wipe hand-edited numbers. */
  const ratedIdRef = useRef(0);
  const rateTypedId = useCallback(() => {
    const typed = Math.floor(Number(rawId));
    if (!Number.isInteger(typed) || typed <= 0 || ratedIdRef.current === typed) return;
    ratedIdRef.current = typed;
    chooseCardPlayer(null, typed);
    setRawId(String(typed));
  }, [chooseCardPlayer, rawId]);

  const submit = useCallback(async () => {
    if (cardUserId <= 0) {
      onError("Pick the player whose card this is.");
      return;
    }
    setBusy(true);
    try {
      const grant = buildCardGrant(form, {
        cardUserId,
        username: card?.username,
        avatarUrl: card?.avatarUrl,
        countryCode: card?.countryCode,
      });
      const result = await grantAdminCollectionCard({ data: { userId: ownerUserId, card: grant } });
      const held = result.card?.copies ?? 0;
      onDone(
        `${result.created ? "Minted" : "Updated"} ${result.card?.username || cardUserId} `
        + `(${tier ? MANIA_TIER_STYLES[tier].label : "unrated"}), now ${held} ${held === 1 ? "copy" : "copies"}`
        + `${result.card?.serial ? ` at #${result.card.serial}` : ""}.`,
      );
    } catch (caught) {
      onError(errMessage(caught));
    } finally {
      setBusy(false);
    }
  }, [card, cardUserId, form, onDone, onError, ownerUserId, tier]);

  const cardPower = numberOrUndefined(form.skills.cardPower ?? "");

  return (
    <SectionCard title="Give a card">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
        <SearchInput
          className="sm:w-[300px]"
          placeholder="Whose card is it..."
          onSearch={(q) => searchPlayers(q)}
          // Picking somebody is enough to know what their card should say, so
          // the ordinary case is two clicks: pick them, grant it.
          onSelect={(user) => chooseCardPlayer(
            { id: user.id, username: user.username, avatarUrl: user.avatar_url, countryCode: user.country_code },
            user.id,
          )}
        />
        <input
          value={card ? String(card.id) : rawId}
          onChange={(event) => { setRawId(event.target.value); setCard(null); }}
          // Rating on blur as well as on Enter, so a typed id gets the same
          // treatment as one picked from the dropdown and the button stays
          // what it says it is: the redo.
          onKeyDown={(event) => { if (event.key === "Enter") rateTypedId(); }}
          onBlur={rateTypedId}
          placeholder="or an osu! id"
          className={`${INPUT} sm:w-[180px]`}
        />
        {card ? (
          <div className="flex items-center gap-2 text-[13px] text-white">
            <img src={avatarImageSrc(card.avatarUrl, card.id)} alt="" className="w-6 h-6 rounded-full" loading="lazy" />
            {card.username}
            {card.countryCode ? <CountryFlag code={card.countryCode} size="sm" /> : null}
          </div>
        ) : null}
        <button
          disabled={cardUserId <= 0 || filling}
          onClick={() => void fillFromPlays(cardUserId, { keepTier: true })}
          className={`${BUTTON} sm:ml-auto inline-flex items-center gap-1.5`}
        >
          {filling ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Wand2 className="w-3.5 h-3.5" />}
          Re-rate from their plays
        </button>
      </div>

      <div className="mt-3 pt-3 border-t border-osu-b3/20 grid grid-cols-2 sm:grid-cols-4 gap-2.5">
        <div>
          <span className={LABEL}>Tier</span>
          <SelectMenu block value={form.tier} options={TIER_OPTIONS} onChange={(value) => patch({ tier: value })} />
        </div>
        {/* Its own name for this one copy: a GOAT card that reads "manolo"
            rather than GOAT. Nobody else's copy of the card changes. */}
        <div>
          <span className={LABEL}>Tier label</span>
          <input
            value={form.tierLabel}
            onChange={(event) => patch({ tierLabel: event.target.value })}
            placeholder={tier ? MANIA_TIER_STYLES[tier].label : "none"}
            className={INPUT}
          />
        </div>
        <div>
          <span className={LABEL}>Copies</span>
          <div className="flex gap-1.5">
            <input
              type="number"
              value={form.copies}
              onChange={(event) => patch({ copies: event.target.value })}
              className={INPUT}
            />
            {advanced ? (
              <SelectMenu
                className="flex-shrink-0"
                value={form.copiesMode}
                options={[{ value: "add", label: "Add" }, { value: "set", label: "Set" }]}
                onChange={(value) => patch({ copiesMode: value as "add" | "set" })}
              />
            ) : null}
          </div>
        </div>
        {!advanced ? (
          /* The one readout simple mode needs: what the card is about to say,
             so granting is not a leap of faith. */
          <div className="self-end text-[12px] text-osu-f1">
            {filling
              ? "Rating their plays..."
              : form.skillsMode === "set"
                ? `Card power ${cardPower ?? 0}, ${formatNumber(Number(form.pp) || 0)}pp, rank #${formatNumber(Number(form.globalRank) || 0)}`
                : "Pick a player and their card gets rated off their real plays."}
          </div>
        ) : null}
        {advanced ? (
        <>
        <div>
          <span className={LABEL}>Recycled copies</span>
          <input
            type="number"
            value={form.recycledCopies}
            onChange={(event) => patch({ recycledCopies: event.target.value })}
            placeholder="keep"
            className={INPUT}
          />
        </div>
        <div>
          <span className={LABEL}>pp on the card</span>
          <input type="number" value={form.pp} onChange={(event) => patch({ pp: event.target.value })} placeholder="keep" className={INPUT} />
        </div>
        <div>
          <span className={LABEL}>Global rank</span>
          <input
            type="number"
            value={form.globalRank}
            onChange={(event) => patch({ globalRank: event.target.value })}
            placeholder="keep"
            className={INPUT}
          />
        </div>
        <div>
          <span className={LABEL}>First pulled</span>
          <input
            type="datetime-local"
            value={form.firstPulledAt}
            onChange={(event) => patch({ firstPulledAt: event.target.value })}
            className={INPUT}
          />
        </div>
        <div>
          <span className={LABEL}>Last pulled</span>
          <div className="flex gap-1.5">
            <input
              type="datetime-local"
              value={form.lastPulledAt}
              onChange={(event) => patch({ lastPulledAt: event.target.value })}
              className={INPUT}
            />
            <button
              onClick={() => patch({ firstPulledAt: toLocalInput(Date.now()), lastPulledAt: toLocalInput(Date.now()) })}
              className={BUTTON}
            >
              Now
            </button>
          </div>
        </div>
        </>
        ) : null}
      </div>
      {advanced ? (
        <p className="mt-1.5 text-[11px] text-osu-f1">
          Blank keeps the stamps a card already carries, and stamps a new one at the moment it lands.
        </p>
      ) : null}

      {form.tier === "goat" && !honorary ? (
        <p className="mt-2 text-[11px] text-osu-yellow">
          Not on the honorary roster, so this GOAT exists only in this collection and recycles for 500 shards.
        </p>
      ) : null}

      {advanced ? (
      <>
      <div className="mt-3 pt-3 border-t border-osu-b3/20">
        <div className="flex items-center gap-3">
          <span className="text-[11px] font-semibold uppercase tracking-[0.1em] text-osu-f1">Skills snapshot</span>
          <SelectMenu
            value={form.skillsMode}
            options={[
              { value: "keep", label: "Leave alone" },
              { value: "set", label: "Write these numbers" },
              { value: "clear", label: "No snapshot" },
            ]}
            onChange={(value) => patch({ skillsMode: value as CardForm["skillsMode"] })}
          />
          <span className="text-[11px] text-osu-f1">Without one the card front draws no stat bars.</span>
        </div>
        <div className={`mt-2 grid grid-cols-3 sm:grid-cols-6 gap-2 ${form.skillsMode === "set" ? "" : "opacity-40"}`}>
          {SKILL_FIELDS.map((field) => (
            <div key={field.key}>
              <span className={LABEL}>{field.label}</span>
              <input
                type="number"
                step={field.step ?? "1"}
                value={form.skills[field.key] ?? ""}
                onChange={(event) => setSkill(field.key, event.target.value)}
                placeholder="0"
                className={INPUT}
              />
            </div>
          ))}
          <div className="col-span-3 sm:col-span-2">
            <span className={LABEL}>Archetype</span>
            <input
              value={form.archetype}
              onChange={(event) => patch({ archetype: event.target.value, skillsMode: "set" })}
              placeholder="Allrounder"
              className={INPUT}
            />
          </div>
        </div>
      </div>

      {/* What the card floats behind everything else. Every tier already drifts
          something (triangle flecks, or a starfield on the cosmic tiers); this
          swaps that layer for one image on this collector's copy alone. */}
      <div className="mt-3 pt-3 border-t border-osu-b3/20">
        <div className="flex items-center gap-3">
          <span className="text-[11px] font-semibold uppercase tracking-[0.1em] text-osu-f1">Background art</span>
          <SelectMenu
            value={form.motifMode}
            options={[
              { value: "keep", label: "Leave alone" },
              { value: "set", label: "Float this image" },
              { value: "clear", label: "Back to the tier's own" },
            ]}
            onChange={(value) => patch({ motifMode: value as CardForm["motifMode"] })}
          />
          <span className="text-[11px] text-osu-f1">Drifts in place of this tier's triangles or stars, on this copy only.</span>
        </div>
        <div className={`mt-2 grid grid-cols-2 sm:grid-cols-4 gap-2.5 ${form.motifMode === "set" ? "" : "opacity-40"}`}>
          <div className="col-span-2">
            <span className={LABEL}>Image URL</span>
            <input
              value={form.motifUrl}
              onChange={(event) => patch({ motifUrl: event.target.value, motifMode: "set" })}
              placeholder="https://"
              className={INPUT}
            />
          </div>
          <div>
            <span className={LABEL}>Scale</span>
            <input
              type="number"
              step="0.05"
              min={0.25}
              max={4}
              value={form.motifScale}
              onChange={(event) => patch({ motifScale: event.target.value, motifMode: "set" })}
              className={INPUT}
            />
          </div>
          <div>
            <span className={LABEL}>Opacity</span>
            <input
              type="number"
              step="0.05"
              min={0.05}
              max={1}
              value={form.motifOpacity}
              onChange={(event) => patch({ motifOpacity: event.target.value, motifMode: "set" })}
              className={INPUT}
            />
          </div>
        </div>
        {/* Straight off the source, not through /api/card-motif: the proxy only
            serves images that are already on a card, so nothing would load here
            until after the grant lands. */}
        {form.motifMode === "set" && motifPreviewUrl ? (
          <div className="mt-2 flex items-center gap-2">
            <img
              src={motifPreviewUrl}
              alt=""
              className="w-10 h-10 object-contain"
              style={{ opacity: Number(form.motifOpacity) || 1 }}
              onError={() => setMotifBroken(motifPreviewUrl)}
            />
            <span className="text-[11px] text-osu-f1">
              {motifBroken === motifPreviewUrl ? "That URL did not load." : "Transparent PNGs read best."}
            </span>
          </div>
        ) : null}
      </div>

      <div className="mt-3 pt-3 border-t border-osu-b3/20 grid grid-cols-2 sm:grid-cols-4 gap-2.5">
        <div>
          <span className={LABEL}>Serial</span>
          <SelectMenu
            block
            value={form.serialMode}
            options={[
              { value: "keep", label: "Leave alone" },
              { value: "mint", label: "Mint the next one" },
              { value: "set", label: "Exact number" },
            ]}
            onChange={(value) => patch({ serialMode: value as CardForm["serialMode"] })}
          />
        </div>
        {form.serialMode === "set" ? (
          <div>
            <span className={LABEL}>Serial number</span>
            <input type="number" min={1} value={form.serial} onChange={(event) => patch({ serial: event.target.value })} className={INPUT} />
          </div>
        ) : null}
      </div>

      <div className="mt-3 pt-3 border-t border-osu-b3/20">
        <div className="flex items-center justify-between">
          <span className="text-[11px] font-semibold uppercase tracking-[0.1em] text-osu-f1">Card face</span>
          <label className="flex items-center gap-1.5 text-[11px] text-osu-l2 cursor-pointer">
            <input
              type="checkbox"
              checked={form.overwriteIdentity}
              onChange={(event) => patch({ overwriteIdentity: event.target.checked })}
              className="accent-osu-pink"
            />
            Repaint it for everyone
          </label>
        </div>
        <p className="mt-1 text-[11px] text-osu-f1">
          One face per player per tier, shared by everyone holding it, so these only reach a card nobody has yet.
          A tracked player takes their name and avatar from the users row either way. Repainting also writes the
          tier label above, on every copy of this card.
        </p>
        <div className="mt-2 grid grid-cols-2 sm:grid-cols-4 gap-2.5">
          <div>
            <span className={LABEL}>Username</span>
            <input
              value={form.username}
              onChange={(event) => patch({ username: event.target.value })}
              placeholder={card?.username ?? ""}
              className={INPUT}
            />
          </div>
          <div className="sm:col-span-2">
            <span className={LABEL}>Avatar URL</span>
            <input
              value={form.avatarUrl}
              onChange={(event) => patch({ avatarUrl: event.target.value })}
              placeholder="https://a.ppy.sh/..."
              className={INPUT}
            />
          </div>
          <div>
            <span className={LABEL}>Country</span>
            <input
              value={form.countryCode}
              onChange={(event) => patch({ countryCode: event.target.value.toUpperCase().slice(0, 2) })}
              placeholder={card?.countryCode ?? "CR"}
              className={INPUT}
            />
          </div>
        </div>
      </div>
      </>
      ) : null}

      <div className="mt-3 pt-3 border-t border-osu-b3/20 flex items-center gap-2">
        <button disabled={busy || cardUserId <= 0} onClick={() => void submit()} className={PRIMARY}>
          {busy ? "Granting..." : "Grant card"}
        </button>
        <button onClick={() => { setForm(emptyCardForm()); setCard(null); setRawId(""); }} className={BUTTON}>
          Reset form
        </button>
        {advanced ? (
          <span className="text-[11px] text-osu-f1">
            Nothing here writes a pull event, so a granted card never shows up in the community pull feed.
          </span>
        ) : null}
      </div>
    </SectionCard>
  );
}

const PAGE_SIZE = 24;

function CollectionPanel({
  overview,
  filter,
  page,
  busy,
  onFilter,
  onPage,
  onRemoved,
  onError,
}: {
  overview: AdminCollectionOverview;
  filter: string;
  page: number;
  busy: boolean;
  onFilter: (value: string) => void;
  onPage: (page: number) => void;
  onRemoved: (message: string) => void;
  onError: (message: string) => void;
}) {
  const [query, setQuery] = useState(filter);
  const [armed, setArmed] = useState<string | null>(null);
  const [removing, setRemoving] = useState<string | null>(null);
  const [dropSerial, setDropSerial] = useState(false);
  const { cards, total } = overview.collection;
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  useEffect(() => { setQuery(filter); }, [filter]);

  const remove = useCallback(async (card: AdminCollectionCard) => {
    const cardKey = card.cardKey ?? String(card.userId);
    setRemoving(cardKey);
    try {
      const result = await removeAdminCollectionCard({
        data: { userId: overview.user.userId, cardKey, dropSerial },
      });
      onRemoved(result.removed ? `Removed ${card.username || cardKey}.` : "That card was already gone.");
    } catch (caught) {
      onError(errMessage(caught));
    } finally {
      setRemoving(null);
      setArmed(null);
    }
  }, [dropSerial, onError, onRemoved, overview.user.userId]);

  return (
    <SectionCard
      title={`Their collection (${formatNumber(total)})`}
      actions={
        <input
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={(event) => { if (event.key === "Enter") onFilter(query.trim()); }}
          onBlur={() => { if (query.trim() !== filter) onFilter(query.trim()); }}
          placeholder="Filter by name"
          className={`${INPUT} sm:w-[200px]`}
        />
      }
    >
      {cards.length === 0 ? (
        <div className="px-3 py-6 text-center text-[12px] text-osu-f1">
          {filter ? "No card of theirs matches that." : "They hold no cards."}
        </div>
      ) : (
        <>
        {/* Off by default: an orphaned serial is invisible (only a held card
            reads one) and a re-grant picks the same number back up, while
            deleting the card's highest serial lowers the "of N" every other
            collector of it sees. */}
        <label className="mb-2 flex items-center gap-1.5 text-[11px] text-osu-l2 cursor-pointer">
          <input
            type="checkbox"
            checked={dropSerial}
            onChange={(event) => setDropSerial(event.target.checked)}
            className="accent-osu-pink"
          />
          Removing also drops the mint serial
        </label>
        <div className="divide-y divide-osu-b3/20">
          {cards.map((card) => {
            const cardKey = card.cardKey ?? String(card.userId);
            const style = card.tier ? MANIA_TIER_STYLES[card.tier] : null;
            return (
              <div key={cardKey} className="flex flex-wrap items-center gap-x-3 gap-y-1 py-2">
                <img src={avatarImageSrc(card.avatarUrl, card.userId)} alt="" className="w-7 h-7 rounded-full" loading="lazy" />
                <span className="text-[13px] font-medium text-white">{card.username || card.userId}</span>
                {/* The badge as the card prints it: a holding given its own
                    text shows that, with the tier it is still worth beside. */}
                <span className={`text-[11px] font-semibold ${style?.badgeColor ?? "text-osu-f1"}`}>
                  {card.customLabel || style?.label || "Unrated"}
                </span>
                {card.customLabel ? (
                  <span className="text-[11px] text-osu-f1">{style?.label ?? "Unrated"}</span>
                ) : null}
                <span className="text-[12px] text-osu-l2 tabular-nums">x{card.copies}</span>
                {card.serial ? (
                  <span className="text-[11px] text-osu-f1 tabular-nums">#{card.serial} of {card.mintedTotal || card.serial}</span>
                ) : null}
                <span className="text-[11px] text-osu-f1 tabular-nums">{formatNumber(Math.round(card.pp))}pp</span>
                {card.skills ? null : <span className="text-[11px] text-osu-f1">no snapshot</span>}
                {card.motif ? <span className="text-[11px] text-osu-f1">floats art</span> : null}

                <button
                  disabled={removing === cardKey || busy}
                  onClick={() => (armed === cardKey ? void remove(card) : setArmed(cardKey))}
                  onBlur={() => setArmed((current) => (current === cardKey ? null : current))}
                  className={`ml-auto px-2 py-1 rounded-md border text-[11px] transition-colors duration-[120ms] disabled:opacity-50 cursor-pointer ${
                    armed === cardKey
                      ? "border-osu-red/50 bg-osu-red/20 text-osu-red-light"
                      : "border-osu-b3/30 bg-osu-b4/60 text-osu-l2 hover:bg-osu-b3/60 hover:text-white"
                  }`}
                >
                  {armed === cardKey ? "Really remove" : <Trash2 className="w-3.5 h-3.5" />}
                </button>
              </div>
            );
          })}
        </div>
        </>
      )}

      {pages > 1 ? (
        <div className="mt-3 pt-3 border-t border-osu-b3/20 flex items-center gap-2">
          <button disabled={busy || page <= 0} onClick={() => onPage(page - 1)} className={BUTTON}>
            Previous
          </button>
          <span className="text-[11px] text-osu-f1 tabular-nums">Page {page + 1} of {pages}</span>
          <button disabled={busy || page >= pages - 1} onClick={() => onPage(page + 1)} className={BUTTON}>
            Next
          </button>
        </div>
      ) : null}
    </SectionCard>
  );
}
