import { useCallback, useEffect, useState } from "react";
import { formatNumber } from "../../../lib/format";
import { fetchAdminApiKeys, mutateAdminApiKey, type AdminApiKey, type AdminApiKeysReport } from "../../../lib/admin-api-keys";
import { SectionCard } from "../SectionCard";

/*
 * Every self-serve Mania Tracker API key (made on /developers): who owns it,
 * how much it is used, its rate override, and revoke. Request counts are
 * written in batches, so a key's last few seconds may not show yet.
 */

const REFRESH_MS = 60_000;

function formatAgo(atMs: number, now: number): string {
  const mins = Math.max(0, Math.round((now - atMs) / 60_000));
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 48) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

function KeyRow({
  apiKey,
  defaultRate,
  now,
  busy,
  onRevoke,
  onRate,
}: {
  apiKey: AdminApiKey;
  defaultRate: number;
  now: number;
  busy: boolean;
  onRevoke: () => void;
  onRate: (rate: number | null) => void;
}) {
  const revoked = apiKey.revokedAt != null;
  const [rate, setRate] = useState(apiKey.ratePerMinute == null ? "" : String(apiKey.ratePerMinute));
  useEffect(() => setRate(apiKey.ratePerMinute == null ? "" : String(apiKey.ratePerMinute)), [apiKey.ratePerMinute]);
  const changed = rate.trim() !== (apiKey.ratePerMinute == null ? "" : String(apiKey.ratePerMinute));
  return (
    <div className={`flex flex-wrap items-center gap-x-5 gap-y-2 border-t border-white/[0.07] py-2.5 first:border-t-0 ${revoked ? "opacity-50" : ""}`}>
      <div className="min-w-[11rem]">
        <a
          href={`/player/${apiKey.ownerUserId}`}
          className="text-[13px] font-semibold text-osu-l1 hover:text-white"
        >
          {apiKey.ownerUsername ?? `#${apiKey.ownerUserId}`}
        </a>
        <div className="font-mono text-[11px] text-osu-f1">
          {apiKey.prefix}… {apiKey.label ? <span className="font-sans">{apiKey.label}</span> : null}
        </div>
      </div>
      <div className="min-w-[8rem] text-[11px] text-osu-f1">
        <div>Created {formatAgo(apiKey.createdAt, now)}</div>
        <div>
          {revoked
            ? `Revoked ${formatAgo(apiKey.revokedAt ?? now, now)}`
            : apiKey.lastUsedAt ? `Last used ${formatAgo(apiKey.lastUsedAt, now)}` : "Never used"}
        </div>
      </div>
      <div>
        <div className="text-lg font-bold leading-none text-osu-l1 tabular-nums">{formatNumber(apiKey.requests)}</div>
        <div className="mt-1 text-[11px] text-osu-f1">Requests</div>
      </div>
      {revoked ? null : (
        <div className="ml-auto flex items-center gap-2">
          <input
            value={rate}
            onChange={(event) => setRate(event.target.value.replace(/[^0-9]/g, ""))}
            placeholder={String(defaultRate)}
            inputMode="numeric"
            className="h-7 w-16 rounded-md bg-osu-b4 px-2 text-right text-[12px] text-white tabular-nums outline-none placeholder:text-osu-f1/50"
            aria-label="Requests a minute"
          />
          <span className="text-[11px] text-osu-f1">/min</span>
          {changed ? (
            <button
              type="button"
              disabled={busy}
              onClick={() => onRate(rate.trim() === "" ? null : Number(rate))}
              className="h-7 cursor-pointer rounded-md bg-osu-b4 px-2 text-[11px] font-semibold text-osu-f1 hover:text-white disabled:opacity-40"
            >
              Save
            </button>
          ) : null}
          <button
            type="button"
            disabled={busy}
            onClick={onRevoke}
            className="h-7 cursor-pointer rounded-md bg-osu-b4 px-2 text-[11px] font-semibold text-rose-300 hover:bg-rose-500/20 disabled:opacity-40"
          >
            Revoke
          </button>
        </div>
      )}
    </div>
  );
}

export function ApiKeysCard() {
  const [report, setReport] = useState<AdminApiKeysReport | null>(null);
  const [unsupported, setUnsupported] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<number | null>(null);
  const [showRevoked, setShowRevoked] = useState(false);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const result = await fetchAdminApiKeys();
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

  const mutate = useCallback(async (data: { action: "revoke" | "set-rate"; id: number; ratePerMinute?: number | null }) => {
    setBusyId(data.id);
    try {
      const result = await mutateAdminApiKey({ data });
      if (result) setReport(result);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusyId(null);
    }
  }, []);

  const keys = report?.keys.filter((key) => showRevoked || key.revokedAt == null) ?? [];
  const revokedCount = report?.keys.filter((key) => key.revokedAt != null).length ?? 0;

  return (
    <SectionCard title="API keys">
      {unsupported ? (
        <div className="text-[11px] text-osu-f1">The live backend does not serve this report yet.</div>
      ) : (
        <>
          {error ? <div className="mb-2 text-[11px] text-osu-red">{error}</div> : null}
          {!report ? (
            <div className="text-[11px] text-osu-f1">Loading…</div>
          ) : (
            <div className="px-1">
              {keys.length === 0 ? (
                <div className="py-2 text-[11px] text-osu-f1">No keys yet.</div>
              ) : keys.map((key) => (
                <KeyRow
                  key={key.id}
                  apiKey={key}
                  defaultRate={report.ratePerMinute}
                  now={now}
                  busy={busyId === key.id}
                  onRevoke={() => {
                    if (window.confirm(`Revoke ${key.prefix}… for ${key.ownerUsername ?? key.ownerUserId}?`)) {
                      void mutate({ action: "revoke", id: key.id });
                    }
                  }}
                  onRate={(rate) => void mutate({ action: "set-rate", id: key.id, ratePerMinute: rate })}
                />
              ))}
              <div className="mt-1 flex flex-wrap items-center gap-x-3 text-[11px] text-osu-f1">
                <span>
                  {formatNumber(report.ratePerMinute)} a minute per key unless set, {formatNumber(report.globalRatePerMinute)} a minute for all keys together.
                </span>
                {revokedCount > 0 ? (
                  <button
                    type="button"
                    onClick={() => setShowRevoked((value) => !value)}
                    className="cursor-pointer font-semibold hover:text-white"
                  >
                    {showRevoked ? "Hide revoked" : `Show ${revokedCount} revoked`}
                  </button>
                ) : null}
              </div>
            </div>
          )}
        </>
      )}
    </SectionCard>
  );
}
