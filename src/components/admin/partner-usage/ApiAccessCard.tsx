import { useCallback, useEffect, useState } from "react";
import { formatNumber } from "../../../lib/format";
import {
  fetchAdminApiAccess,
  mutateAdminApiAccess,
  type AdminApiAccessEntry,
  type AdminApiAccessReport,
} from "../../../lib/admin-api-access";
import { SectionCard } from "../SectionCard";

/*
 * Who may use the Mania Tracker API (invite only for now): players who asked
 * on /developers, and everyone given access, with pause and revoke. Pausing
 * stops a player's keys and webhooks until resumed; revoking also revokes
 * their keys and deletes their webhooks.
 */

const REFRESH_MS = 60_000;

type Action = "grant" | "pause" | "revoke";

function formatAgo(atMs: number, now: number): string {
  const mins = Math.max(0, Math.round((now - atMs) / 60_000));
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 48) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

function RowButton({ label, tone, busy, onClick }: { label: string; tone: "plain" | "go" | "danger"; busy: boolean; onClick: () => void }) {
  const colors = tone === "go"
    ? "text-emerald-300 hover:bg-emerald-500/20"
    : tone === "danger" ? "text-rose-300 hover:bg-rose-500/20" : "text-osu-f1 hover:text-white";
  return (
    <button
      type="button"
      disabled={busy}
      onClick={onClick}
      className={`h-7 cursor-pointer rounded-md bg-osu-b4 px-2.5 text-[11px] font-semibold disabled:opacity-40 ${colors}`}
    >
      {label}
    </button>
  );
}

function PlayerName({ entry }: { entry: AdminApiAccessEntry }) {
  return (
    <a href={`/player/${entry.userId}`} className="text-[13px] font-semibold text-osu-l1 hover:text-white">
      {entry.username ?? `#${entry.userId}`}
    </a>
  );
}

function RequestRow({ entry, now, busy, onAction }: { entry: AdminApiAccessEntry; now: number; busy: boolean; onAction: (action: Action) => void }) {
  return (
    <div className="flex flex-wrap items-start gap-x-5 gap-y-2 border-t border-white/[0.07] py-2.5 first:border-t-0">
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline gap-2">
          <PlayerName entry={entry} />
          <span className="text-[11px] text-osu-f1">asked {entry.requestedAt ? formatAgo(entry.requestedAt, now) : ""}</span>
        </div>
        {entry.note ? <p className="mt-1 whitespace-pre-wrap break-words text-[13px] leading-snug text-osu-l2">{entry.note}</p> : null}
      </div>
      <div className="flex items-center gap-2">
        <RowButton label="Give access" tone="go" busy={busy} onClick={() => onAction("grant")} />
        <RowButton label="Turn down" tone="plain" busy={busy} onClick={() => onAction("revoke")} />
      </div>
    </div>
  );
}

function AccessRow({ entry, now, busy, onAction }: { entry: AdminApiAccessEntry; now: number; busy: boolean; onAction: (action: Action) => void }) {
  const paused = entry.status === "paused";
  return (
    <div className="flex flex-wrap items-center gap-x-5 gap-y-2 border-t border-white/[0.07] py-2.5 first:border-t-0">
      <div className="min-w-[11rem]">
        <PlayerName entry={entry} />
        <div className={`text-[11px] ${paused ? "text-osu-yellow" : "text-osu-f1"}`}>
          {paused
            ? `Paused ${entry.pausedAt ? formatAgo(entry.pausedAt, now) : ""}`
            : `Access since ${entry.grantedAt ? formatAgo(entry.grantedAt, now) : "?"}`}
        </div>
      </div>
      <div className="min-w-[8rem] text-[11px] text-osu-f1">
        <div>
          {entry.activeKeys === 1 ? "1 key" : `${entry.activeKeys} keys`}
          {entry.webhooks > 0 ? `, ${entry.webhooks === 1 ? "1 webhook" : `${entry.webhooks} webhooks`}` : ""}
        </div>
        <div>{entry.lastUsedAt ? `Last used ${formatAgo(entry.lastUsedAt, now)}` : "Never used"}</div>
      </div>
      <div>
        <div className="text-lg font-bold leading-none text-osu-l1 tabular-nums">{formatNumber(entry.requests)}</div>
        <div className="mt-1 text-[11px] text-osu-f1">Requests</div>
      </div>
      <div className="ml-auto flex items-center gap-2">
        {paused
          ? <RowButton label="Resume" tone="go" busy={busy} onClick={() => onAction("grant")} />
          : <RowButton label="Pause" tone="plain" busy={busy} onClick={() => onAction("pause")} />}
        <RowButton label="Revoke" tone="danger" busy={busy} onClick={() => onAction("revoke")} />
      </div>
    </div>
  );
}

export function ApiAccessCard() {
  const [report, setReport] = useState<AdminApiAccessReport | null>(null);
  const [unsupported, setUnsupported] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [input, setInput] = useState("");
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const result = await fetchAdminApiAccess();
        if (cancelled) return;
        if (result === null) setUnsupported(true);
        else setReport(result);
        setError(null);
        setNow(Date.now());
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      }
    };
    void load();
    const id = window.setInterval(() => void load(), REFRESH_MS);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, []);

  const mutate = useCallback(async (action: Action, user: string): Promise<boolean> => {
    setBusy(user);
    try {
      const result = await mutateAdminApiAccess({ data: { action, user } });
      if (result) setReport(result);
      setError(null);
      setNow(Date.now());
      return true;
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      return false;
    } finally {
      setBusy(null);
    }
  }, []);

  const onAction = (entry: AdminApiAccessEntry, action: Action) => {
    const name = entry.username ?? `#${entry.userId}`;
    if (action === "revoke" && entry.status !== "requested"
      && !window.confirm(`Revoke API access for ${name}? Their keys are revoked and their webhooks deleted too.`)) return;
    void mutate(action, String(entry.userId));
  };

  const requests = report?.entries.filter((entry) => entry.status === "requested") ?? [];
  const granted = report?.entries.filter((entry) => entry.status !== "requested") ?? [];

  return (
    <SectionCard title="API access">
      {unsupported ? (
        <div className="text-[11px] text-osu-f1">The live backend does not serve this report yet.</div>
      ) : (
        <div className="px-1">
          <form
            className="flex flex-wrap items-center gap-2"
            onSubmit={(event) => {
              event.preventDefault();
              const user = input.trim();
              if (!user) return;
              void mutate("grant", user).then((ok) => {
                if (ok) setInput("");
              });
            }}
          >
            <input
              value={input}
              onChange={(event) => setInput(event.target.value)}
              placeholder="osu! id or @username"
              aria-label="Player to give access"
              className="h-8 w-56 rounded-md bg-osu-b4 px-2.5 text-[13px] text-white outline-none placeholder:text-osu-f1/50"
            />
            <button
              type="submit"
              disabled={!input.trim() || busy != null}
              className="h-8 cursor-pointer rounded-md bg-osu-pink px-3 text-[12px] font-bold text-white transition hover:brightness-110 disabled:cursor-default disabled:opacity-40 disabled:hover:brightness-100"
            >
              Give access
            </button>
          </form>
          {error ? <div className="mt-2 text-[11px] text-osu-red">{error}</div> : null}

          {!report ? (
            <div className="mt-3 text-[11px] text-osu-f1">Loading…</div>
          ) : (
            <>
              {requests.length > 0 ? (
                <div className="mt-4">
                  <div className="mb-1 text-[11px] font-semibold text-osu-f1">Asking for access</div>
                  {requests.map((entry) => (
                    <RequestRow
                      key={entry.userId}
                      entry={entry}
                      now={now}
                      busy={busy === String(entry.userId)}
                      onAction={(action) => onAction(entry, action)}
                    />
                  ))}
                </div>
              ) : null}
              <div className="mt-4">
                <div className="mb-1 text-[11px] font-semibold text-osu-f1">With access</div>
                {granted.length === 0 ? (
                  <div className="py-2 text-[11px] text-osu-f1">Nobody yet.</div>
                ) : granted.map((entry) => (
                  <AccessRow
                    key={entry.userId}
                    entry={entry}
                    now={now}
                    busy={busy === String(entry.userId)}
                    onAction={(action) => onAction(entry, action)}
                  />
                ))}
              </div>
            </>
          )}
        </div>
      )}
    </SectionCard>
  );
}
