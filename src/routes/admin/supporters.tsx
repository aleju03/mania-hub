import { Link, createFileRoute, notFound } from "@tanstack/react-router";
import { AnimatePresence, motion } from "framer-motion";
import { Plus, Undo2, Upload } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { avatarImageSrc } from "../../components/ui/Avatar";
import { SearchInput } from "../../components/ui/SearchInput";
import {
  grantAdminSupporterDays,
  importAdminKofiCsv,
  linkAdminDonation,
  loadAdminSupporters,
  unlinkAdminDonation,
  type AdminDonationRow,
  type AdminSupporterRow,
  type AdminSupportersView,
  type DonationLinkMethod,
} from "../../lib/admin-supporters";
import { canUseAdminFeatures } from "../../lib/auth-shared";
import { searchPlayers, searchPlayersOnOsu } from "../../lib/player-search";

/* Supporter status (backend features/supporters.ts). The wall is every
 * supporter, the ring around each avatar the time they have left ($3 buys 30
 * days; a full ring is 90 days or more). Click an avatar to add time. Below it,
 * donations the webhooks could not link wait in Needs linking: pick the player
 * and the card moves onto the wall. A Ko-fi CSV can be dropped anywhere on the
 * page.
 */

export const Route = createFileRoute("/admin/supporters")({
  head: () => ({
    meta: [
      { title: "Supporters - admin" },
      { name: "robots", content: "noindex, nofollow" },
    ],
  }),
  beforeLoad: ({ context }) => {
    if (!canUseAdminFeatures(context.auth)) {
      throw notFound();
    }
    return undefined as never;
  },
  component: AdminSupportersPage,
});

const DAY_MS = 24 * 60 * 60 * 1000;
const FULL_RING_DAYS = 90;

const METHOD_LABEL: Record<DonationLinkMethod, string> = {
  lava_link: "lava.top link",
  email_match: "same email",
  name_match: "name match",
  manual: "linked by hand",
  unlinked: "unlinked by hand",
};

const CHIP_CLASS =
  "inline-flex items-center gap-1 rounded-full bg-white/[0.07] px-3 py-1 text-[12px] font-medium text-osu-l2 transition hover:bg-white/[0.12] hover:text-white disabled:opacity-50 cursor-pointer disabled:cursor-default";

function formatDate(ms: number): string {
  return new Date(ms).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

function formatShortDate(ms: number): string {
  return new Date(ms).toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

function formatMoney(amount: number, currency: string): string {
  return new Intl.NumberFormat("en-US", { style: "currency", currency, maximumFractionDigits: 2 }).format(amount);
}

function timeLeft(row: AdminSupporterRow, now: number): string {
  if (!row.active) return `lapsed ${formatShortDate(row.expiresAt)}`;
  const days = Math.ceil((row.expiresAt - now) / DAY_MS);
  if (days < 60) return days === 1 ? "1 day left" : `${days} days left`;
  return `${Math.floor(days / 30)} months left`;
}

function AdminSupportersPage() {
  const [view, setView] = useState<AdminSupportersView | null>(null);
  const [busy, setBusy] = useState(false);
  const [toast, setToast] = useState<{ text: string; error: boolean } | null>(null);
  const [openUser, setOpenUser] = useState<number | null>(null);
  const [adding, setAdding] = useState(false);
  const [dragging, setDragging] = useState(false);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const now = Date.now();

  const say = useCallback((text: string, error = false) => {
    setToast({ text, error });
    if (toastTimer.current) clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(null), error ? 8000 : 3500);
  }, []);

  const reload = useCallback(async () => {
    try {
      setView(await loadAdminSupporters());
    } catch (err) {
      say(err instanceof Error ? err.message : String(err), true);
    }
  }, [say]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const run = useCallback(async (action: () => Promise<string>) => {
    setBusy(true);
    try {
      const text = await action();
      await reload();
      say(text);
    } catch (err) {
      say(err instanceof Error ? err.message : String(err), true);
    } finally {
      setBusy(false);
    }
  }, [reload, say]);

  const grant = (query: string, days: number, label: string) => run(async () => {
    const result = await grantAdminSupporterDays({ data: { query, days, note: "" } });
    return `${days > 0 ? "Added" : "Took"} ${Math.abs(days)} days ${days > 0 ? "to" : "from"} ${result.username ?? label}.`;
  });

  const importFile = (file: File) => run(async () => {
    const result = await importAdminKofiCsv({ data: { csv: await file.text() } });
    return `Imported ${result.inserted} of ${result.rows} rows, ${result.linked} linked to a player.`;
  });

  const supporters = view?.supporters ?? [];
  const activeCount = supporters.filter((row) => row.active).length;
  const inbox = useMemo(() => (view?.donations ?? []).filter((row) => row.linkedUserId == null && row.amount > 0), [view]);
  const history = useMemo(() => (view?.donations ?? []).filter((row) => row.linkedUserId != null || row.amount < 0), [view]);

  return (
    <div
      className="relative"
      onDragOver={(event) => {
        if (!event.dataTransfer.types.includes("Files")) return;
        event.preventDefault();
        setDragging(true);
      }}
      onDragLeave={(event) => {
        if (event.currentTarget === event.target) setDragging(false);
      }}
      onDrop={(event) => {
        event.preventDefault();
        setDragging(false);
        const file = event.dataTransfer.files?.[0];
        if (file) void importFile(file);
      }}
    >
      <div className="bg-osu-b5 min-h-[calc(100vh-60px)]">
        <div className="max-w-[1000px] mx-auto px-3 sm:px-5 py-6 sm:py-8 space-y-10">
          <header className="flex flex-wrap items-end gap-x-8 gap-y-3">
            <div>
              <div className="text-[44px] font-semibold leading-none tabular-nums text-white">{view ? activeCount : "–"}</div>
              <div className="mt-1 text-[12px] text-osu-f1">supporting now</div>
            </div>
            <div>
              <div className={`text-[44px] font-semibold leading-none tabular-nums ${inbox.length > 0 ? "text-osu-pink" : "text-white/30"}`}>
                {view ? inbox.length : "–"}
              </div>
              <div className="mt-1 text-[12px] text-osu-f1">need linking</div>
            </div>
            <label className={`${CHIP_CLASS} ml-auto ${busy ? "pointer-events-none opacity-50" : ""}`}>
              <Upload size={13} />
              Import Ko-fi CSV
              <input
                type="file"
                accept=".csv,text/csv"
                className="hidden"
                onChange={(event) => {
                  const file = event.target.files?.[0];
                  event.target.value = "";
                  if (file) void importFile(file);
                }}
              />
            </label>
          </header>

          <section>
            <div className="grid grid-cols-[repeat(auto-fill,minmax(112px,1fr))] gap-x-3 gap-y-6">
              <AnimatePresence initial={false}>
                {supporters.map((row) => (
                  <SupporterTile
                    key={row.userId}
                    row={row}
                    now={now}
                    open={openUser === row.userId}
                    busy={busy}
                    onToggle={() => setOpenUser(openUser === row.userId ? null : row.userId)}
                    onGrant={(days) => grant(`#${row.userId}`, days, row.username ?? `#${row.userId}`)}
                  />
                ))}
              </AnimatePresence>
              <div className="flex flex-col items-center">
                <button
                  type="button"
                  onClick={() => setAdding(!adding)}
                  className="flex h-[76px] w-[76px] items-center justify-center rounded-full bg-white/[0.05] text-osu-f1 transition hover:bg-white/[0.1] hover:text-white cursor-pointer"
                  aria-label="Give someone supporter time"
                >
                  <Plus size={22} />
                </button>
                <div className="mt-2 text-[12px] text-osu-f1">give time</div>
              </div>
            </div>
            <AnimatePresence>
              {adding ? (
                <motion.div
                  initial={{ opacity: 0, y: -6 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, y: -6 }}
                  className="mt-5 flex flex-wrap items-center gap-2"
                >
                  <span className="text-[13px] text-osu-l2">Give 30 days to</span>
                  <SearchInput
                    className="w-full sm:w-72"
                    placeholder="find player..."
                    onSearch={(q) => searchPlayers(q)}
                    onSearchOsu={searchPlayersOnOsu}
                    onSelect={(user) => {
                      setAdding(false);
                      void grant(`#${user.id}`, 30, user.username);
                    }}
                  />
                </motion.div>
              ) : null}
            </AnimatePresence>
            {view && supporters.length === 0 ? (
              <p className="mt-4 text-[13px] text-osu-f1">No supporters yet. Linked donations show up here.</p>
            ) : null}
          </section>

          <section>
            <h3 className="mb-1 text-[15px] font-semibold text-white">Needs linking</h3>
            {view && inbox.length === 0 ? <p className="py-3 text-[13px] text-osu-f1">Every donation is linked.</p> : null}
            <AnimatePresence initial={false}>
              {inbox.map((row) => (
                <InboxCard key={`${row.provider}:${row.externalId}`} row={row} busy={busy} run={run} />
              ))}
            </AnimatePresence>
          </section>

          <section>
            <h3 className="mb-1 text-[15px] font-semibold text-white">History</h3>
            {view && history.length === 0 ? <p className="py-3 text-[13px] text-osu-f1">Nothing linked yet.</p> : null}
            {history.map((row) => (
              <HistoryRow key={`${row.provider}:${row.externalId}`} row={row} busy={busy} run={run} />
            ))}
          </section>
        </div>
      </div>

      <AnimatePresence>
        {dragging ? (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="pointer-events-none fixed inset-0 z-50 flex items-center justify-center bg-black/60"
          >
            <div className="text-[22px] font-semibold text-white">Drop the Ko-fi CSV to import it</div>
          </motion.div>
        ) : null}
      </AnimatePresence>

      <AnimatePresence>
        {toast ? (
          <motion.div
            initial={{ opacity: 0, y: 12 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 12 }}
            className={`fixed bottom-6 left-1/2 z-50 -translate-x-1/2 rounded-full px-5 py-2.5 text-[13px] font-medium ${
              toast.error ? "bg-osu-red text-white" : "bg-osu-b3 text-white"
            }`}
          >
            {toast.text}
          </motion.div>
        ) : null}
      </AnimatePresence>
    </div>
  );
}

function SupporterTile({
  row,
  now,
  open,
  busy,
  onToggle,
  onGrant,
}: {
  row: AdminSupporterRow;
  now: number;
  open: boolean;
  busy: boolean;
  onToggle: () => void;
  onGrant: (days: number) => void;
}) {
  const daysLeft = row.active ? (row.expiresAt - now) / DAY_MS : 0;
  const fill = Math.min(1, daysLeft / FULL_RING_DAYS);
  const radius = 36;
  const circumference = 2 * Math.PI * radius;
  const name = row.username ?? `#${row.userId}`;

  return (
    <motion.div
      layout
      initial={{ opacity: 0, scale: 0.6 }}
      animate={{ opacity: 1, scale: 1 }}
      exit={{ opacity: 0, scale: 0.6 }}
      transition={{ type: "spring", stiffness: 380, damping: 26 }}
      className="relative flex flex-col items-center"
    >
      <button type="button" onClick={onToggle} className="group relative h-[76px] w-[76px] cursor-pointer" aria-expanded={open}>
        <svg viewBox="0 0 80 80" className="absolute inset-0 h-full w-full -rotate-90">
          <circle cx="40" cy="40" r={radius} fill="none" stroke="rgba(255,255,255,0.07)" strokeWidth="4" />
          <motion.circle
            cx="40"
            cy="40"
            r={radius}
            fill="none"
            stroke="var(--color-osu-pink, #ff66ab)"
            strokeWidth="4"
            strokeLinecap="round"
            strokeDasharray={circumference}
            initial={{ strokeDashoffset: circumference }}
            animate={{ strokeDashoffset: circumference * (1 - fill) }}
            transition={{ duration: 0.8, ease: "easeOut" }}
          />
        </svg>
        <img
          src={avatarImageSrc(undefined, row.userId)}
          alt=""
          className={`absolute inset-[7px] h-[62px] w-[62px] rounded-full object-cover transition group-hover:brightness-110 ${row.active ? "" : "grayscale opacity-50"}`}
        />
      </button>
      <div className="mt-2 max-w-full truncate text-[13px] font-medium text-white">{name}</div>
      <div className={`text-[12px] ${row.active ? "text-osu-l2" : "text-osu-f1"}`}>{timeLeft(row, now)}</div>

      <AnimatePresence>
        {open ? (
          <motion.div
            initial={{ opacity: 0, y: -4, scale: 0.96 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: -4, scale: 0.96 }}
            transition={{ duration: 0.14 }}
            className="absolute top-full z-20 mt-2 w-[200px] rounded-xl bg-osu-b3 p-3 shadow-xl"
          >
            <div className="flex flex-wrap gap-1.5">
              <button type="button" disabled={busy} onClick={() => onGrant(30)} className={CHIP_CLASS}>+30 days</button>
              <button type="button" disabled={busy} onClick={() => onGrant(90)} className={CHIP_CLASS}>+90 days</button>
              {row.active ? (
                <button type="button" disabled={busy} onClick={() => onGrant(-30)} className={CHIP_CLASS}>-30 days</button>
              ) : null}
            </div>
            <div className="mt-2.5 space-y-0.5 text-[11px] text-osu-f1">
              <div>{row.active ? `Until ${formatDate(row.expiresAt)}` : `Lapsed ${formatDate(row.expiresAt)}`}</div>
              <div>Supporting since {formatDate(row.firstSupportedAt)}</div>
            </div>
            {row.username ? (
              <Link to="/player/$username" params={{ username: row.username }} className="mt-2 inline-block text-[12px] text-osu-pink-light hover:underline">
                Open profile
              </Link>
            ) : null}
          </motion.div>
        ) : null}
      </AnimatePresence>
    </motion.div>
  );
}

function InboxCard({ row, busy, run }: { row: AdminDonationRow; busy: boolean; run: (action: () => Promise<string>) => Promise<void> }) {
  return (
    <motion.div
      layout
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, x: 60, transition: { duration: 0.25 } }}
      className="flex flex-wrap items-center gap-x-5 gap-y-2 border-t border-white/[0.07] py-4"
    >
      <div className="w-[96px] shrink-0 text-[22px] font-semibold tabular-nums text-white">{formatMoney(row.amount, row.currency)}</div>
      <div className="min-w-0 flex-1">
        <div className="truncate text-[14px] text-white">{row.donorName ?? (row.provider === "lava" ? "lava.top buyer" : "No name given")}</div>
        <div className="text-[11px] text-osu-f1">
          {formatShortDate(row.occurredAt)} on {row.provider === "kofi" ? "Ko-fi" : "lava.top"}
          {row.imported ? ", imported" : ""}
          {row.linkMethod === "unlinked" ? ", unlinked by hand" : ""}
        </div>
        {row.message ? <div className="mt-1 text-[13px] text-osu-l2">"{row.message}"</div> : null}
      </div>
      <div className={busy ? "pointer-events-none opacity-50" : ""}>
        <SearchInput
          className="w-full sm:w-60"
          placeholder="who is this?"
          onSearch={(q) => searchPlayers(q)}
          onSearchOsu={searchPlayersOnOsu}
          onSelect={(user) => void run(async () => {
            await linkAdminDonation({ data: { provider: row.provider, externalId: row.externalId, query: `#${user.id}` } });
            return `Linked to ${user.username}.`;
          })}
        />
      </div>
    </motion.div>
  );
}

function HistoryRow({ row, busy, run }: { row: AdminDonationRow; busy: boolean; run: (action: () => Promise<string>) => Promise<void> }) {
  return (
    <div className="flex items-center gap-3 border-t border-white/[0.07] py-2.5">
      {row.linkedUserId != null ? (
        <img src={avatarImageSrc(undefined, row.linkedUserId)} alt="" className="h-8 w-8 shrink-0 rounded-full object-cover" />
      ) : (
        <div className="h-8 w-8 shrink-0 rounded-full bg-white/[0.05]" />
      )}
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-baseline gap-x-2">
          {row.linkedUsername ? (
            <Link to="/player/$username" params={{ username: row.linkedUsername }} className="text-[14px] font-medium text-white hover:underline">
              {row.linkedUsername}
            </Link>
          ) : (
            <span className="text-[14px] font-medium text-white">{row.linkedUserId != null ? `#${row.linkedUserId}` : "Refund"}</span>
          )}
          <span className={`text-[14px] tabular-nums ${row.amount < 0 ? "text-osu-red-light" : "text-osu-l2"}`}>
            {formatMoney(row.amount, row.currency)}
          </span>
        </div>
        <div className="truncate text-[11px] text-osu-f1">
          {formatShortDate(row.occurredAt)} on {row.provider === "kofi" ? "Ko-fi" : "lava.top"}
          {row.donorName && row.donorName !== row.linkedUsername ? `, as ${row.donorName}` : ""}
          {row.linkMethod ? `, ${METHOD_LABEL[row.linkMethod]}` : ""}
          {row.message ? `, "${row.message}"` : ""}
        </div>
      </div>
      {row.linkedUserId != null ? (
        <button
          type="button"
          disabled={busy}
          onClick={() => void run(async () => {
            await unlinkAdminDonation({ data: { provider: row.provider, externalId: row.externalId } });
            return "Moved back to Needs linking.";
          })}
          className={CHIP_CLASS}
        >
          <Undo2 size={12} />
          Unlink
        </button>
      ) : null}
    </div>
  );
}
