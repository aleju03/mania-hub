import { Trans, useLingui } from "@lingui/react/macro";
import { useState } from "react";

import { setMyDisplayName, type DisplayNameResult } from "#/lib/display-name";
import { formatDate } from "#/lib/format";
import { useLocale } from "#/lib/locale-context";

/* The restricted player's own control for their profile name, in two pieces:
   the pill sits in the profile's meta row, and the form opens on a line of its
   own below it so nothing in the row moves. Only rendered on their own frozen
   profile; the backend enforces who and how often anyway. */

/** Null once the player may rename again, including when a cached profile's date has passed. */
export function pendingRenameDate(nextChangeAt: string | null | undefined): string | null {
  if (!nextChangeAt) return null;
  const at = Date.parse(nextChangeAt);
  return Number.isFinite(at) && at > Date.now() ? nextChangeAt : null;
}

export function DisplayNameButton({
  nextChangeAt,
  open,
  onOpen,
}: {
  nextChangeAt: string | null;
  open: boolean;
  onOpen: () => void;
}) {
  const locale = useLocale();
  if (nextChangeAt) {
    return (
      <span className="rounded-full bg-white/5 px-2 py-0.5 font-semibold text-white/40" suppressHydrationWarning>
        <Trans>Change name on {formatDate(nextChangeAt, "UTC", locale)}</Trans>
      </span>
    );
  }
  return (
    <button
      type="button"
      onClick={onOpen}
      disabled={open}
      className={`rounded-full px-2 py-0.5 font-semibold transition-colors ${
        open ? "bg-white/20 text-white" : "cursor-pointer bg-white/10 text-white/70 hover:bg-white/20 hover:text-white"
      }`}
    >
      <Trans>Change name</Trans>
    </button>
  );
}

export function DisplayNameForm({
  current,
  osuName,
  onSaved,
  onClose,
}: {
  current: string | null;
  osuName: string;
  onSaved: (displayName: string | null, nextChangeAt: string) => void;
  onClose: () => void;
}) {
  const { t } = useLingui();
  const locale = useLocale();
  const [value, setValue] = useState(current ?? "");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const describe = (result: Extract<DisplayNameResult, { ok: false }>): string => {
    switch (result.error) {
      case "too_soon":
        return result.nextChangeAt
          ? t`You can change your name again on ${formatDate(result.nextChangeAt, "UTC", locale)}.`
          : t`You can change your name once a week.`;
      case "name_taken":
        return t`Another player already goes by that name.`;
      case "invalid_name":
        return t`Use 3 to 15 letters, numbers, spaces, or - _ [ ].`;
      case "not_eligible":
        return t`Only restricted accounts can change their name here.`;
      default:
        return t`Couldn't save your name right now.`;
    }
  };

  const save = async (name: string) => {
    setSaving(true);
    setError(null);
    try {
      const result = await setMyDisplayName({ data: { displayName: name } });
      if (result.ok) {
        onSaved(result.displayName, result.nextChangeAt);
        onClose();
      } else {
        setError(describe(result));
      }
    } catch {
      setError(t`Couldn't save your name right now.`);
    } finally {
      setSaving(false);
    }
  };

  return (
    <form
      className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-2 text-[11px]"
      onSubmit={(event) => { event.preventDefault(); void save(value); }}
    >
      <input
        autoFocus
        value={value}
        maxLength={15}
        onChange={(event) => setValue(event.target.value)}
        onKeyDown={(event) => { if (event.key === "Escape") onClose(); }}
        placeholder={osuName}
        disabled={saving}
        className="w-44 rounded-md border border-white/20 bg-black/30 px-2.5 py-1 text-[13px] text-white outline-none focus:border-osu-pink/60"
      />
      <button type="submit" disabled={saving} className="cursor-pointer rounded-full bg-osu-pink/25 px-2.5 py-0.5 font-semibold text-osu-pink-light hover:bg-osu-pink/40 disabled:opacity-50">
        {saving ? <Trans>Saving...</Trans> : <Trans>Save</Trans>}
      </button>
      {current ? (
        <button type="button" disabled={saving} onClick={() => void save("")} className="cursor-pointer text-white/60 hover:text-white disabled:opacity-50">
          <Trans>Use my osu! name</Trans>
        </button>
      ) : null}
      <button type="button" disabled={saving} onClick={onClose} className="cursor-pointer text-white/60 hover:text-white disabled:opacity-50">
        <Trans>Cancel</Trans>
      </button>
      <span className={`basis-full ${error ? "text-osu-red-light" : "text-white/50"}`}>
        {error ?? <Trans>You can change it once a week. Your profile link keeps your osu! name.</Trans>}
      </span>
    </form>
  );
}
