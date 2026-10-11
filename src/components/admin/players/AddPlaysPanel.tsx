import { Link } from "@tanstack/react-router";
import { Loader2, Pencil, Plus, Search, Trash2, Video, X } from "lucide-react";
import { useCallback, useEffect, useState, type ReactNode } from "react";

import { mapCoverUrl } from "../../maps/SearchCard";
import { entryDiffs, searchPickerMaps } from "../../maps/UserCollectionEditor";
import { ConfirmModal } from "../../ui/ConfirmModal";
import { ModBadge } from "../../ui/ModBadge";
import { SearchInput } from "../../ui/SearchInput";
import { StarRatingBadge } from "../../ui/StarRating";
import {
  addManualScore,
  deleteManualScore,
  lookupManualScores,
  setManualScoreVideo,
  type ManualScoreAccount,
  type ManualScoreEntry,
  type ManualScoreInput,
} from "../../../lib/admin-manual-scores";
import { formatAccuracy, formatNumber } from "../../../lib/format";
import type { LiveMapSearchEntry } from "../../../lib/live-backend";
import { searchPlayers, searchPlayersOnOsu } from "../../../lib/player-search";
import { VideoLinkForm } from "./VideoLinkForm";

/* The Add plays tab of /admin/players: plays that cannot be imported (old or
 * offline ones that only survive as a video) entered by hand under the
 * player's account. Date and accuracy are required, the rest is optional, and
 * no mods means NoMod. Each entry is rated and listed like an import (backend
 * integrations/companella/manual-scores.ts).
 */

const BUTTON_CLASS =
  "inline-flex items-center justify-center gap-1.5 rounded-md border px-2.5 py-1.5 text-[12px] transition-colors duration-[120ms] disabled:opacity-50 disabled:cursor-default cursor-pointer";
const ACTION_CLASS = `${BUTTON_CLASS} border-osu-b3/30 bg-osu-b4/60 text-osu-l2 hover:bg-osu-b3/60 hover:text-white`;
const DANGER_CLASS = `${BUTTON_CLASS} border-osu-red/40 bg-osu-red/10 text-osu-red-light hover:bg-osu-red/20`;
const INPUT_CLASS =
  "w-full rounded-md bg-osu-b4/60 border border-osu-b3/30 px-3 py-2 text-[14px] text-white placeholder:text-osu-f1 outline-none focus:border-osu-b3 tabular-nums";

/* Mods that cannot be played together share a group, so picking one drops the other. */
const MOD_GROUPS: string[][] = [["HT", "DT", "NC"], ["EZ", "HR"], ["NF", "SD", "PF"], ["HD", "FI"], ["FL"], ["MR"], ["V2"]];

const JUDGEMENTS = [
  { key: "count_geki", label: "MAX" },
  { key: "count_300", label: "300" },
  { key: "count_katu", label: "200" },
  { key: "count_100", label: "100" },
  { key: "count_50", label: "50" },
  { key: "count_miss", label: "Miss" },
] as const;

type JudgementKey = (typeof JUDGEMENTS)[number]["key"];

const IN_FLIGHT = new Set(["queued", "validating", "analyzing", "deferred"]);

const REJECTIONS: Record<string, string> = {
  chart_missing: "The map's file went missing",
  chart_parse_failed: "The map's file could not be read",
  contradictory_mods: "Those mods cannot be played together",
  processing_failed: "Rating kept failing",
};

function optionalNumber(text: string): number | null {
  if (!text.trim()) return null;
  const number = Number(text.replace(/,/g, ""));
  return Number.isFinite(number) ? number : NaN;
}

function chartLabel(beatmap: ManualScoreEntry["beatmap"], beatmapId: number): string {
  if (!beatmap.title) return `Beatmap ${beatmapId}`;
  return `${beatmap.artist ? `${beatmap.artist} - ` : ""}${beatmap.title}${beatmap.version ? ` [${beatmap.version}]` : ""}`;
}

function formatDay(iso: string): string {
  return new Date(iso).toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric", timeZone: "UTC" });
}

const EMPTY_FORM = {
  map: null as LiveMapSearchEntry | null,
  date: "",
  accuracy: "",
  mods: [] as string[],
  judgements: {} as Partial<Record<JudgementKey, string>>,
  combo: "",
  score: "",
  video: "",
};

export function AddPlaysPanel() {
  const [account, setAccount] = useState<ManualScoreAccount | null>(null);
  const [entries, setEntries] = useState<ManualScoreEntry[]>([]);
  const [form, setForm] = useState(EMPTY_FORM);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [ask, setAsk] = useState<ManualScoreEntry | null>(null);
  const [editing, setEditing] = useState<string | null>(null);

  const load = useCallback(async (query: string) => {
    setError(null);
    try {
      const found = await lookupManualScores({ data: { user: query } });
      if (!found) {
        setError("The site does not know this player.");
        return;
      }
      setAccount(found.account);
      setEntries(found.entries);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }, []);

  const lookup = (query: string) => {
    setMessage(null);
    setAccount(null);
    setEntries([]);
    void load(query);
  };

  // New entries are rated on the backend's import lane; follow them until they settle.
  const pending = entries.some((entry) => IN_FLIGHT.has(entry.state));
  useEffect(() => {
    if (!pending || !account) return;
    const timer = setTimeout(() => void load(String(account.userId)), 3000);
    return () => clearTimeout(timer);
  }, [pending, account, entries, load]);

  const set = <K extends keyof typeof EMPTY_FORM>(key: K, value: (typeof EMPTY_FORM)[K]) => setForm((current) => ({ ...current, [key]: value }));

  const toggleMod = (mod: string) => {
    setForm((current) => {
      if (current.mods.includes(mod)) return { ...current, mods: current.mods.filter((entry) => entry !== mod) };
      const group = MOD_GROUPS.find((members) => members.includes(mod)) ?? [mod];
      return { ...current, mods: [...current.mods.filter((entry) => !group.includes(entry)), mod] };
    });
  };

  const beatmapId = form.map?.beatmapId ?? null;
  const accuracy = Number(form.accuracy);
  const ready = account != null && beatmapId != null && form.date !== "" && form.accuracy.trim() !== ""
    && Number.isFinite(accuracy) && accuracy > 0 && accuracy <= 100;

  const submit = async () => {
    if (!account || beatmapId == null || !ready) return;
    const judgements = Object.fromEntries(JUDGEMENTS.flatMap(({ key }) => {
      const value = optionalNumber(form.judgements[key] ?? "");
      return value == null ? [] : [[key, value]];
    })) as ManualScoreInput["judgements"];
    const input: ManualScoreInput = {
      userId: account.userId,
      beatmapId,
      playedAt: form.date,
      accuracy,
      mods: form.mods,
      judgements: judgements && Object.keys(judgements).length > 0 ? judgements : null,
      maxCombo: optionalNumber(form.combo),
      totalScore: optionalNumber(form.score),
      videoUrl: form.video.trim(),
    };
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      await addManualScore({ data: input });
      setForm(EMPTY_FORM);
      setMessage(`Added to ${account.username}.`);
      await load(String(account.userId));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };

  const saveVideo = async (entry: ManualScoreEntry, videoUrl: string) => {
    if (!account) return;
    setBusy(true);
    setError(null);
    try {
      await setManualScoreVideo({ data: { userId: account.userId, submissionId: entry.submissionId, videoUrl } });
      setEditing(null);
      setMessage(videoUrl ? "Changed the video." : "Removed the video.");
      await load(String(account.userId));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };

  const remove = async (entry: ManualScoreEntry) => {
    if (!account) return;
    setAsk(null);
    setBusy(true);
    setError(null);
    try {
      await deleteManualScore({ data: { userId: account.userId, submissionId: entry.submissionId } });
      setMessage("Deleted.");
      await load(String(account.userId));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-4">
      <SearchInput
        className="w-full"
        placeholder="find player..."
        onSearch={(q) => searchPlayers(q)}
        onSearchOsu={searchPlayersOnOsu}
        onSelect={(user) => lookup(String(user.id))}
        onSubmit={(q) => lookup(q)}
      />

      {error ? <p className="text-[13px] text-osu-red-light">{error}</p> : null}
      {message ? <p className="text-[13px] text-osu-l2">{message}</p> : null}

      {account ? (
        <>
          <div className="flex items-center gap-3">
            {account.avatarUrl ? <img src={account.avatarUrl} alt="" className="h-10 w-10 rounded-full" /> : null}
            <Link to="/player/$username" params={{ username: account.username }} className="text-[17px] font-medium text-white hover:underline">
              {account.username}
            </Link>
            <span className="text-[12px] text-osu-f1">#{account.userId}</span>
          </div>

          <form
            className="space-y-4"
            onSubmit={(event) => {
              event.preventDefault();
              void submit();
            }}
          >
            <Field label="Beatmap">
              <MapPicker value={form.map} onChange={(map) => set("map", map)} />
            </Field>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-[170px_130px]">
              <Field label="Date">
                <input
                  type="date"
                  value={form.date}
                  min="2007-09-16"
                  onChange={(event) => set("date", event.target.value)}
                  className={`${INPUT_CLASS} [color-scheme:dark]`}
                />
              </Field>
              <Field label="Accuracy">
                <div className="relative">
                  <input
                    value={form.accuracy}
                    onChange={(event) => set("accuracy", event.target.value)}
                    inputMode="decimal"
                    placeholder="98.52"
                    className={`${INPUT_CLASS} pr-7`}
                  />
                  <span className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-[13px] text-osu-f1">%</span>
                </div>
              </Field>
            </div>

            <Field label="Mods">
              <div className="flex flex-wrap gap-1.5">
                {MOD_GROUPS.flat().map((mod) => {
                  const on = form.mods.includes(mod);
                  return (
                    <button
                      key={mod}
                      type="button"
                      onClick={() => toggleMod(mod)}
                      aria-pressed={on}
                      title={mod}
                      className={`cursor-pointer rounded-md p-1 transition ${on ? "bg-white/[0.1]" : "opacity-35 hover:opacity-70"}`}
                    >
                      <ModBadge mod={mod === "V2" ? "SV2" : mod} size={0.8} />
                    </button>
                  );
                })}
              </div>
            </Field>

            <div className="space-y-3 border-t border-white/[0.07] pt-4">
              <Field label="Judgements">
                <div className="grid grid-cols-3 gap-2 sm:grid-cols-6">
                  {JUDGEMENTS.map(({ key, label }) => (
                    <label key={key} className="block">
                      <span className="mb-1 block text-[11px] text-osu-f1">{label}</span>
                      <input
                        value={form.judgements[key] ?? ""}
                        onChange={(event) => set("judgements", { ...form.judgements, [key]: event.target.value })}
                        inputMode="numeric"
                        className={INPUT_CLASS}
                      />
                    </label>
                  ))}
                </div>
              </Field>
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-[130px_170px_1fr]">
                <Field label="Combo">
                  <input value={form.combo} onChange={(event) => set("combo", event.target.value)} inputMode="numeric" className={INPUT_CLASS} />
                </Field>
                <Field label="Score">
                  <input value={form.score} onChange={(event) => set("score", event.target.value)} inputMode="numeric" className={INPUT_CLASS} />
                </Field>
                <Field label="Video">
                  <input
                    value={form.video}
                    onChange={(event) => set("video", event.target.value)}
                    placeholder="https://www.youtube.com/watch?v=..."
                    className={INPUT_CLASS}
                  />
                </Field>
              </div>
            </div>

            <button type="submit" disabled={busy || !ready} className={`${ACTION_CLASS} px-4 py-2 text-[13px]`}>
              <Plus size={14} />
              Add play
            </button>
          </form>

          {entries.length > 0 ? (
            <section className="space-y-1 pt-2">
              <h3 className="text-[13px] font-medium text-osu-c2">Added by hand</h3>
              {entries.map((entry) => (
                <EntryRow
                  key={entry.submissionId}
                  entry={entry}
                  busy={busy}
                  editing={editing === entry.submissionId}
                  onEdit={() => setEditing(entry.submissionId)}
                  onSaveVideo={(videoUrl) => void saveVideo(entry, videoUrl)}
                  onCancelEdit={() => setEditing(null)}
                  onDelete={() => setAsk(entry)}
                />
              ))}
            </section>
          ) : null}
        </>
      ) : null}

      {ask ? (
        <ConfirmModal
          title="Delete this play?"
          body="It leaves the profile, the map's scores and the skill ratings."
          confirmLabel="Delete"
          danger
          onConfirm={() => void remove(ask)}
          onClose={() => setAsk(null)}
        />
      ) : null}
    </div>
  );
}

/* The map search the collection editor uses (text, an id or an osu! link,
 * looked up on osu! when the site lacks it): a set's cover banner with its
 * difficulties as pills, and the chosen difficulty shown in place of the
 * search until it is cleared. */
function MapPicker({ value, onChange }: { value: LiveMapSearchEntry | null; onChange: (map: LiveMapSearchEntry | null) => void }) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<LiveMapSearchEntry[] | null>(null);
  const [searching, setSearching] = useState(false);
  const trimmed = query.trim();

  useEffect(() => {
    if (value || trimmed.length < 2) {
      setResults(null);
      setSearching(false);
      return;
    }
    let cancelled = false;
    setSearching(true);
    const timer = setTimeout(() => {
      searchPickerMaps(trimmed)
        .then((items) => { if (!cancelled) setResults(items); })
        .catch(() => { if (!cancelled) setResults([]); })
        .finally(() => { if (!cancelled) setSearching(false); });
    }, 300);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [value, trimmed]);

  if (value) {
    return (
      <div className="flex items-center gap-3 overflow-hidden rounded-md bg-osu-b4/60 pr-2">
        <div className="h-12 w-20 shrink-0 bg-osu-b3/60 bg-cover bg-center" style={{ backgroundImage: `url(${mapCoverUrl(value)})` }} />
        <div className="min-w-0 flex-1">
          <div className="truncate text-[14px] font-medium text-white">{value.artist} - {value.title}</div>
          <div className="flex items-center gap-2 text-[12px] text-osu-f1">
            <StarRatingBadge stars={value.stars} label={`${value.keyCount}K ${value.stars.toFixed(2)}`} size={1.1} />
            <span className="truncate">{value.version}</span>
          </div>
        </div>
        <button
          type="button"
          onClick={() => onChange(null)}
          aria-label="Change map"
          className="grid h-7 w-7 shrink-0 cursor-pointer place-items-center rounded text-osu-f1 hover:bg-osu-b3/60 hover:text-white"
        >
          <X size={14} />
        </button>
      </div>
    );
  }

  return (
    <div className="space-y-2">
      <div className="relative">
        <Search className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-osu-f1" aria-hidden="true" />
        <input
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="song, artist, mapper, id or osu! link"
          className={`${INPUT_CLASS} pl-8`}
        />
        {searching ? <Loader2 className="absolute right-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 animate-spin text-osu-f1" aria-hidden="true" /> : null}
      </div>
      {results?.length === 0 && !searching ? <p className="text-[12px] text-osu-f1">Nothing matched that.</p> : null}
      {results && results.length > 0 ? (
        <div className="flex max-h-[320px] flex-col gap-2 overflow-y-auto pr-1">
          {results.map((entry) => (
            <div key={entry.beatmapsetId || entry.beatmapId} className="shrink-0 overflow-hidden rounded-lg bg-osu-b4/80">
              <div className="relative h-[44px]">
                <div className="absolute inset-0 bg-cover bg-center" style={{ backgroundImage: `url(${mapCoverUrl(entry)})` }} aria-hidden="true" />
                <div className="absolute inset-0 bg-gradient-to-r from-black/90 via-black/70 to-black/40" aria-hidden="true" />
                <div className="relative flex h-full flex-col justify-center px-2.5">
                  <div className="truncate text-[13px] font-bold text-white">{entry.title}</div>
                  <div className="truncate text-[11px] text-white/70">{entry.artist} | {entry.creator}</div>
                </div>
              </div>
              <div className="flex flex-wrap gap-1 p-2">
                {entryDiffs(entry).map((diff) => (
                  <button
                    key={diff.beatmapId}
                    type="button"
                    onClick={() => {
                      onChange(diff);
                      setQuery("");
                    }}
                    className="inline-flex max-w-full cursor-pointer items-center gap-1.5 rounded-full bg-osu-b3/80 py-1 pl-1 pr-2 text-[11px] font-bold text-osu-l1 hover:brightness-110"
                  >
                    <StarRatingBadge stars={diff.stars} label={`${diff.keyCount}K ${diff.stars.toFixed(2)}`} size={1.1} className="shrink-0" />
                    <span className="truncate opacity-80">{diff.version}</span>
                  </button>
                ))}
              </div>
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div>
      <div className="mb-1 text-[12px] text-osu-f1">{label}</div>
      {children}
    </div>
  );
}

function EntryRow({
  entry,
  busy,
  editing,
  onEdit,
  onSaveVideo,
  onCancelEdit,
  onDelete,
}: {
  entry: ManualScoreEntry;
  busy: boolean;
  editing: boolean;
  onEdit: () => void;
  onSaveVideo: (videoUrl: string) => void;
  onCancelEdit: () => void;
  onDelete: () => void;
}) {
  const { entry: play } = entry;
  const rating = IN_FLIGHT.has(entry.state);
  const rejected = entry.state === "rejected";
  return (
    <div className="flex items-center gap-3 py-2 border-t border-white/[0.07]">
      <div className="min-w-0 flex-1">
        <div className="truncate text-[14px] text-white">{chartLabel(entry.beatmap, play.beatmapId)}</div>
        <div className="flex flex-wrap items-center gap-2 text-[12px] text-osu-f1">
          {play.mods.map((mod) => <ModBadge key={mod} mod={mod === "V2" ? "SV2" : mod} size={0.6} />)}
          <span>{formatDay(play.playedAt)}</span>
          {play.maxCombo != null ? <span>{formatNumber(play.maxCombo)}x</span> : null}
          {play.totalScore != null ? <span>{formatNumber(play.totalScore)}</span> : null}
          {rating ? <span className="text-osu-l2">Rating...</span> : null}
          {rejected ? <span className="text-osu-red-light">{REJECTIONS[entry.errorCode ?? ""] ?? entry.errorCode ?? "Rejected"}</span> : null}
        </div>
        {editing ? <VideoLinkForm initial={play.videoUrl ?? ""} allowEmpty busy={busy} onSave={onSaveVideo} onCancel={onCancelEdit} /> : null}
      </div>
      {play.videoUrl ? (
        <a href={play.videoUrl} target="_blank" rel="noreferrer" aria-label="Video" className="text-osu-f1 hover:text-white">
          <Video size={16} />
        </a>
      ) : null}
      {!editing ? (
        <button onClick={onEdit} aria-label={play.videoUrl ? "Change video" : "Add video"} title={play.videoUrl ? "Change video" : "Add video"} className="cursor-pointer text-osu-f1 hover:text-white">
          <Pencil size={14} />
        </button>
      ) : null}
      <span className="text-[16px] font-medium tabular-nums text-white">{formatAccuracy(play.accuracy)}</span>
      <button disabled={busy || rating} onClick={onDelete} className={DANGER_CLASS} aria-label="Delete">
        <Trash2 size={13} />
      </button>
    </div>
  );
}
