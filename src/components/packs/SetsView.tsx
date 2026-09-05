import { Trans, useLingui } from "@lingui/react/macro";
import { useCallback, useEffect, useState } from "react";
import { Check, Search } from "lucide-react";
import { useAuth } from "#/lib/auth-context";
import { formatNumber } from "#/lib/format";
import { isLiveBackendConfigured, type LivePackBinder } from "#/lib/live-backend";
import {
  BINDER_MAX_CARDS,
  BINDER_MAX_PER_COLLECTOR,
  BINDER_NAME_MAX_CHARS,
  fetchOwnPackBinders,
  mutateOwnPackBinders,
} from "#/lib/pack-binders";
import { packCardKeyOf, type CollectedCard } from "#/lib/pack-collection";
import { ShowcaseCards } from "./collections/ShowcaseCards";
import { ShowcasePickerHost } from "./collections/ShowcasePicker";
import { PackDialog } from "./PackDialog";

/* Binders: groups of your own cards, under a name you gave them.
 *
 * The third way of reading your collection, beside Grid and Album. A binder
 * holds card keys and nothing else, so a card that leaves the collection
 * leaves the binder with it. Publishing a set puts its title, creator and ordered cards on Showcase
 * and on the owner's public collector page.
 *
 * Synced collections only: a browser-local wallet has no account to hang a
 * binder off. */

/* Anything that writes a binder tells the open view to read them back, so the
   context menu on the collection grid and this view never disagree. */
interface PackSetsChange {
  showcaseChanged: boolean;
}

const binderListeners = new Set<(change: PackSetsChange) => void>();

export function subscribePackSetsChanged(listener: (change: PackSetsChange) => void): () => void {
  binderListeners.add(listener);
  return () => { binderListeners.delete(listener); };
}

export function notifyPackBindersChanged(change: PackSetsChange = { showcaseChanged: true }): void {
  for (const listener of binderListeners) listener(change);
}

function showcasedSetsSignature(binders: LivePackBinder[]): string {
  return JSON.stringify(binders
    .filter((binder) => binder.showcased && binder.cards.length > 0 && binder.cards.length <= BINDER_MAX_CARDS)
    .map((binder) => [binder.id, binder.name, (binder.cards as CollectedCard[]).map(packCardKeyOf)]));
}

/* The collection grid's "Add to binder..." actions, self-contained so the
   panel only has to be handed one prop. A module constant rather than a hook
   so the memoized collection panel keeps the same object every render. */
export const packBinderActions = {
  list: async (): Promise<LivePackBinder[]> => (await fetchOwnPackBinders()) ?? [],
  addCards: async (binderId: number, cardKeys: string[]): Promise<void> => {
    const next = await mutateOwnPackBinders({ data: { action: "add_cards", binderId, cardKeys } });
    if (!next) throw new Error("Set unavailable");
    notifyPackBindersChanged({ showcaseChanged: next.some((binder) => binder.id === binderId && binder.showcased) });
  },
  create: async (name: string, cardKeys: string[]): Promise<void> => {
    if (new Set(cardKeys).size > BINDER_MAX_CARDS) throw new Error("binder_full");
    const binders = await mutateOwnPackBinders({ data: { action: "create", name } });
    if (!binders) throw new Error("Set unavailable");
    const created = binders[binders.length - 1];
    if (created && cardKeys.length > 0) {
      await mutateOwnPackBinders({ data: { action: "set_cards", binderId: created.id, cardKeys } });
    }
    notifyPackBindersChanged({ showcaseChanged: false });
  },
};

export type PackBinderActions = typeof packBinderActions;

const SET_PAGE_SIZE = 6;

export function SetsView({ syncStatus }: { syncStatus: "local" | "syncing" | "synced" }) {
  return <SetManager syncStatus={syncStatus} />;
}

export function SetsDialog({ onClose }: { onClose: () => void }) {
  return <SetManager syncStatus="synced" onClose={onClose} />;
}

function SetManager({ syncStatus, onClose }: {
  syncStatus: "local" | "syncing" | "synced";
  onClose?: () => void;
}) {
  const { t } = useLingui();
  const auth = useAuth();
  const available = Boolean(auth.viewer) && isLiveBackendConfigured() && syncStatus !== "local";
  const [binders, setBinders] = useState<LivePackBinder[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [newName, setNewName] = useState("");
  const [picking, setPicking] = useState<LivePackBinder | null>(null);
  const [inspecting, setInspecting] = useState(false);
  const [renaming, setRenaming] = useState<number | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const [confirmDelete, setConfirmDelete] = useState<number | null>(null);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [page, setPage] = useState(0);
  const selected = binders?.find((binder) => binder.id === selectedId) ?? binders?.[0];
  const totalPages = Math.max(1, Math.ceil((selected?.cards.length ?? 0) / SET_PAGE_SIZE));
  const currentPage = Math.min(page, totalPages - 1);
  const atSetLimit = (binders?.length ?? 0) >= BINDER_MAX_PER_COLLECTOR;

  useEffect(() => {
    setPage(0);
    setRenaming(null);
    setConfirmDelete(null);
  }, [selected?.id]);

  const load = useCallback(() => {
    if (!available) return;
    fetchOwnPackBinders()
      .then((next) => setBinders(next ?? []))
      .catch(() => setBinders([]));
  }, [available]);

  useEffect(() => {
    load();
    binderListeners.add(load);
    return () => {
      binderListeners.delete(load);
    };
  }, [load]);

  const run = async (input: Parameters<typeof mutateOwnPackBinders>[0]["data"]) => {
    setBusy(true);
    setError(null);
    try {
      const next = await mutateOwnPackBinders({ data: input });
      if (!next) throw new Error("Set unavailable");
      setBinders(next);
      if (input.action === "create") setSelectedId(next[next.length - 1]?.id ?? null);
      notifyPackBindersChanged({ showcaseChanged: showcasedSetsSignature(binders ?? []) !== showcasedSetsSignature(next) });
      return true;
    } catch (cause) {
      const code = cause instanceof Error ? cause.message : "";
      setError(
        code === "binder_limit"
          ? t`You already have ${BINDER_MAX_PER_COLLECTOR} sets.`
          : code === "invalid_name"
            ? t`Give the set a name.`
            : code === "binder_full"
              ? t`A set can hold up to ${BINDER_MAX_CARDS} cards.`
            : t`That did not save. Try again.`,
      );
      return false;
    } finally {
      setBusy(false);
    }
  };

  if (!available) {
    const notice = (
      <div className="mx-auto w-full max-w-[820px] text-[12px] text-osu-f1">
        {t`Sets are kept with your account, so sign in to make one.`}
      </div>
    );
    return onClose ? <PackDialog title={t`Your sets`} onClose={onClose} width="lg" layer="below-cards">{notice}</PackDialog> : notice;
  }

  const content = (
    <div className="mx-auto w-full max-w-[820px]">
      <div className="flex flex-wrap items-center gap-2">
        <input
          value={newName}
          maxLength={BINDER_NAME_MAX_CHARS}
          disabled={busy || binders === null || atSetLimit}
          aria-label={t`Name a new set`}
          onChange={(event) => setNewName(event.target.value)}
          onKeyDown={(event) => {
            if (event.key !== "Enter" || !newName.trim() || busy || binders === null || atSetLimit) return;
            void run({ action: "create", name: newName }).then((saved) => { if (saved) setNewName(""); });
          }}
          placeholder={t`Name a new set`}
          className="min-w-[180px] flex-1 rounded-lg border border-osu-b3/40 bg-osu-b4/60 px-3 py-1.5 text-[12px] text-white outline-none transition-colors placeholder:text-osu-f1 focus:border-osu-pink/50 sm:max-w-[260px]"
        />
        <button
          type="button"
          disabled={busy || binders === null || !newName.trim() || atSetLimit}
          onClick={() => void run({ action: "create", name: newName }).then((saved) => { if (saved) setNewName(""); })}
          className="cursor-pointer rounded-lg px-3 py-1.5 text-[12px] font-semibold text-osu-f1 transition-colors hover:text-white disabled:cursor-default disabled:opacity-40"
        >
          {t`New set`}
        </button>
      </div>
      <p className="mt-2 text-[11px] text-osu-f1">
        <Trans>{binders?.length ?? 0} / {BINDER_MAX_PER_COLLECTOR} sets · Up to {BINDER_MAX_CARDS} cards per set</Trans>
      </p>
      {error && <div className="mt-2 text-[11px] text-osu-pink-light">{error}</div>}

      {binders === null ? null : binders.length === 0 ? (
        <div className="mt-6 text-[12px] text-osu-f1">
          {t`Friends, matching avatars, inside jokes. Put a few cards together.`}
        </div>
      ) : (
        <div className="mt-5 grid gap-5 sm:grid-cols-[180px_minmax(0,1fr)]">
          <nav aria-label={t`Your sets`} className="max-h-40 overflow-y-auto overscroll-contain sm:max-h-[440px]">
            {binders.map((binder) => (
              <button key={binder.id} type="button" aria-current={selected?.id === binder.id ? "true" : undefined}
                onClick={() => setSelectedId(binder.id)}
                className={`flex w-full cursor-pointer items-center gap-2 rounded-lg px-3 py-2.5 text-left transition-colors ${selected?.id === binder.id ? "bg-osu-pink/15 text-white" : "text-osu-f1 hover:bg-white/5 hover:text-white"}`}>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[12px] font-semibold">{binder.name}</span>
                  {binder.showcased && binder.cards.length <= BINDER_MAX_CARDS && <span className="block text-[10px] text-osu-pink-light">{t`On Showcase`}</span>}
                </span>
                <span className="text-[10px] tabular-nums">{binder.cards.length}/{BINDER_MAX_CARDS}</span>
              </button>
            ))}
          </nav>
          {selected && (
          <section key={selected.id} aria-label={selected.name} className="min-w-0">
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
              {renaming === selected.id ? (
                <input
                  value={renameValue}
                  autoFocus
                  maxLength={BINDER_NAME_MAX_CHARS}
                  onChange={(event) => setRenameValue(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Escape") {
                      event.stopPropagation();
                      setRenaming(null);
                    }
                    if (event.key !== "Enter") return;
                    void run({ action: "rename", binderId: selected.id, name: renameValue }).then(() => setRenaming(null));
                  }}
                  onBlur={() => setRenaming(null)}
                  className="rounded-lg border border-osu-b3/40 bg-osu-b4/60 px-2 py-1 text-[13px] font-bold text-white outline-none focus:border-osu-pink/50"
                />
              ) : (
                <h3 className="text-[13px] font-bold text-white">{selected.name}</h3>
              )}
              <span className="text-[11px] text-osu-f1 tabular-nums">
                {formatNumber(selected.cards.length)} / {BINDER_MAX_CARDS}
              </span>
              <div className="flex w-full flex-wrap items-center gap-x-3 gap-y-2 py-2 text-[11px]">
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => setPicking(selected)}
                  className="cursor-pointer font-semibold text-osu-f1 transition-colors hover:text-white disabled:cursor-default disabled:opacity-40"
                >
                  {t`Edit cards`}
                </button>
                <button
                  type="button"
                  disabled={busy || (!selected.showcased && (selected.cards.length === 0 || selected.cards.length > BINDER_MAX_CARDS))}
                  aria-pressed={selected.showcased}
                  onClick={() => void run({ action: "showcase", binderId: selected.id, showcased: !selected.showcased })}
                  className={`cursor-pointer font-semibold transition-colors disabled:cursor-default disabled:opacity-40 ${
                    selected.showcased ? "text-osu-pink-light" : "text-osu-f1 hover:text-white"
                  }`}
                >
                  {t`Show on Showcase`}
                </button>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => {
                    setRenameValue(selected.name);
                    setRenaming(selected.id);
                  }}
                  className="cursor-pointer font-semibold text-osu-f1 transition-colors hover:text-white disabled:cursor-default disabled:opacity-40"
                >
                  {t`Rename`}
                </button>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => {
                    if (confirmDelete !== selected.id) {
                      setConfirmDelete(selected.id);
                      return;
                    }
                    setConfirmDelete(null);
                    void run({ action: "delete", binderId: selected.id });
                  }}
                  className={`cursor-pointer font-semibold transition-colors disabled:cursor-default disabled:opacity-40 ${
                    confirmDelete === selected.id ? "text-osu-pink-light" : "text-osu-f1 hover:text-white"
                  }`}
                >
                  {confirmDelete === selected.id ? t`Sure?` : t`Delete`}
                </button>
              </div>
            </div>
            {selected.cards.length > BINDER_MAX_CARDS && <p className="mt-2 text-[11px] text-osu-pink-light">
              {t`Reduce this set to ${BINDER_MAX_CARDS} cards to show it on Showcase.`}
            </p>}
            <div className="mt-3">
              {selected.cards.length === 0 ? (
                <div className="text-[12px] text-osu-f1">
                  <Trans>Nothing in here yet.</Trans>
                </div>
              ) : (
                <ShowcaseCards cards={selected.cards.slice(currentPage * SET_PAGE_SIZE, (currentPage + 1) * SET_PAGE_SIZE)} ownerUserId={auth.viewer?.id ?? null}
                  onCardOpen={() => setInspecting(true)} onCardClose={() => setInspecting(false)} />
              )}
            </div>
            {totalPages > 1 && <div className="mt-4 flex items-center gap-3 text-[11px] text-osu-f1">
              <button type="button" disabled={currentPage === 0} onClick={() => setPage(currentPage - 1)} className="cursor-pointer py-1 hover:text-white disabled:cursor-default disabled:opacity-30">{t`Previous`}</button>
              <span className="tabular-nums">{currentPage + 1} / {totalPages}</span>
              <button type="button" disabled={currentPage >= totalPages - 1} onClick={() => setPage(currentPage + 1)} className="cursor-pointer py-1 hover:text-white disabled:cursor-default disabled:opacity-30">{t`Next`}</button>
            </div>}
          </section>
          )}
        </div>
      )}

      <ShowcasePickerHost
        open={picking !== null}
        userId={auth.viewer?.id ?? 0}
        initialKeys={picking ? (picking.cards as CollectedCard[]).map((card) => packCardKeyOf(card)) : []}
        maxCards={BINDER_MAX_CARDS}
        allowReorder
        initialCards={picking?.cards}
        title={picking ? t`Cards in ${picking.name}` : undefined}
        saveLabel={t`Save set`}
        onCancel={() => setPicking(null)}
        onSave={async (cardKeys) => {
          const binderId = picking?.id ?? 0;
          const saved = await run({ action: "set_cards", binderId, cardKeys });
          if (!saved) throw new Error("Could not save set");
          setPicking(null);
        }}
      />
    </div>
  );

  return onClose ? (
    <PackDialog title={t`Your sets`} onClose={onClose} busy={busy || picking !== null || inspecting} width="lg" layer="below-cards">
      {content}
    </PackDialog>
  ) : content;
}

/* The menu reads membership for labels; additions are append-only on the
   server, so another tab's edits cannot be overwritten by this snapshot. */
export function BinderMenuItems({
  cardKeys,
  cardCount = cardKeys.length,
  actions,
  onDone,
}: {
  cardKeys: string[];
  cardCount?: number;
  actions: PackBinderActions;
  onDone: () => void;
}) {
  const { t } = useLingui();
  const [open, setOpen] = useState(false);
  const [binders, setBinders] = useState<LivePackBinder[] | null>(null);
  const [naming, setNaming] = useState(false);
  const [name, setName] = useState("");
  const [query, setQuery] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [reload, setReload] = useState(0);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setError(null);
    actions.list().then((next) => {
      if (!cancelled) setBinders(next);
    }).catch(() => {
      if (!cancelled) setError(t`Could not load sets. Try again.`);
    });
    return () => { cancelled = true; };
  }, [open, actions, reload, t]);

  const run = async (action: () => Promise<void>) => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await action();
      onDone();
    } catch (cause) {
      const code = cause instanceof Error ? cause.message : "";
      setError(code === "binder_full"
        ? t`A set can hold up to ${BINDER_MAX_CARDS} cards.`
        : code === "binder_limit"
          ? t`You already have ${BINDER_MAX_PER_COLLECTOR} sets.`
          : t`That did not save. Try again.`);
    } finally {
      setBusy(false);
    }
  };
  const tooMany = cardCount > BINDER_MAX_CARDS;
  const itemClass =
    "flex w-full items-center gap-2 px-3 py-1.5 text-left text-[12px] text-osu-f1 transition-colors hover:bg-osu-b4/60 hover:text-white cursor-pointer disabled:cursor-default disabled:opacity-40";

  if (!open) {
    return <button type="button" role="menuitem" onClick={() => setOpen(true)} className={itemClass}>
      {cardCount > 1 ? t`Add ${cardCount} cards to set...` : t`Add to set...`}
    </button>;
  }

  const visible = (binders ?? []).filter((binder) => binder.name.toLowerCase().includes(query.trim().toLowerCase()));
  const atLimit = (binders?.length ?? 0) >= BINDER_MAX_PER_COLLECTOR;
  return (
    <>
      <div className="mx-3 mt-2 mb-1 flex items-center justify-between text-[10px] text-osu-f1">
        <span>{cardCount > 1 ? t`Add ${cardCount} cards` : t`Add to set`}</span>
        <span>{binders?.length ?? 0}/{BINDER_MAX_PER_COLLECTOR}</span>
      </div>
      {binders && binders.length > 5 && <label className="relative mx-3 my-2 flex items-center">
        <Search size={12} className="pointer-events-none absolute left-2 text-osu-f1" />
        <input value={query} onChange={(event) => setQuery(event.target.value)} aria-label={t`Find a set`}
          placeholder={t`Find a set`} className="w-full rounded border border-osu-b3/40 bg-osu-b4/60 py-1 pl-7 pr-2 text-[11px] text-white outline-none focus:border-osu-pink/50" />
      </label>}
      {tooMany && <p role="alert" className="px-3 py-2 text-[11px] text-osu-pink-light">{t`Select at most ${BINDER_MAX_CARDS} cards to add to a set.`}</p>}
      <div role="group" aria-label={t`Your sets`} className="max-h-40 overflow-y-auto overscroll-contain">
        {binders === null && !error && <p className="px-3 py-2 text-[11px] text-osu-f1">{t`Loading...`}</p>}
        {binders !== null && visible.length === 0 && <p className="px-3 py-2 text-[11px] text-osu-f1">{t`No sets found.`}</p>}
        {visible.map((binder) => {
          const existing = new Set((binder.cards as CollectedCard[]).map(packCardKeyOf));
          const additions = [...new Set(cardKeys)].filter((key) => !existing.has(key));
          const included = additions.length === 0;
          const full = binder.cards.length >= BINDER_MAX_CARDS;
          const fits = !tooMany && binder.cards.length + additions.length <= BINDER_MAX_CARDS;
          return <button key={binder.id} type="button" role="menuitem" disabled={busy || included || !fits}
            onClick={() => void run(() => actions.addCards(binder.id, cardKeys))} className={itemClass}>
            <span className="min-w-0 flex-1 truncate">{binder.name}</span>
            {included ? <Check size={12} aria-label={t`Already in set`} /> : <span className="shrink-0 text-[10px] tabular-nums">{full ? t`Full` : !fits ? t`Not enough room` : `${binder.cards.length}/${BINDER_MAX_CARDS}`}</span>}
          </button>;
        })}
      </div>
      {error && <p role="alert" className="px-3 py-2 text-[11px] text-osu-pink-light">{error}</p>}
      {binders === null && error && <button type="button" role="menuitem" onClick={() => setReload((value) => value + 1)} className={itemClass}>{t`Retry`}</button>}
      {naming ? (
        <form onSubmit={(event) => {
          event.preventDefault();
          if (name.trim() && !atLimit && !tooMany) void run(() => actions.create(name, cardKeys));
        }} className="mx-3 my-2 flex gap-1">
          <input value={name} autoFocus disabled={busy} maxLength={BINDER_NAME_MAX_CHARS}
            onChange={(event) => setName(event.target.value)} aria-label={t`Set name`} placeholder={t`Set name`}
            className="min-w-0 flex-1 rounded border border-osu-b3/40 bg-osu-b4/60 px-2 py-1 text-[12px] text-white outline-none focus:border-osu-pink/50" />
          <button type="submit" disabled={busy || !name.trim() || atLimit || tooMany} className="cursor-pointer rounded px-1 text-[11px] text-osu-f1 hover:text-white disabled:opacity-40">{t`Create`}</button>
        </form>
      ) : (
        <button type="button" role="menuitem" disabled={busy || binders === null || atLimit || tooMany} onClick={() => setNaming(true)} className={itemClass}>
          {atLimit ? t`Set limit reached` : t`New set`}
        </button>
      )}
    </>
  );
}
