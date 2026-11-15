import { Flag, RefreshCw, X } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";

import { ProfileThemeBackdrop } from "../../supporter/ProfileThemeBackdrop";
import { ConfirmModal } from "../../ui/ConfirmModal";
import { Skeleton } from "../../ui/LoadingSkeleton";
import { hideBrokenImage } from "../../../lib/custom-themes";
import { formatTimeAgo } from "../../../lib/format";
import {
  blockAdminCustomThemeAuthor,
  loadAdminCustomThemes,
  markAdminCustomThemeSeen,
  restoreAdminCustomTheme,
  setAdminCustomThemesDisabled,
  takeDownAdminCustomTheme,
  unblockAdminCustomThemeAuthor,
  type AdminCustomTheme,
  type AdminCustomThemesView,
} from "../../../lib/admin-custom-themes";

/* The Themes tab of /admin/players (backend features/custom-themes.ts).
 * Supporters' own themes go live the moment they're saved, so this is where
 * they get looked at: everything new or changed since it was last marked
 * seen comes first, then themes hidden after crashes, then the gallery's.
 * Each shows its still (or plays live, one at a time), its code against the
 * revision before, who wears it and what was reported. Take down removes it
 * from every profile and remembers its code and images; Restore undoes that
 * or a crash auto-hide. Blocking an author stops their saves. The switch at
 * the top turns every custom theme into its still at once. */

const BUTTON_CLASS =
  "inline-flex items-center justify-center gap-1.5 rounded-md border px-2.5 py-1.5 text-[12px] sm:py-1 sm:text-[11px] transition-colors duration-[120ms] disabled:opacity-50 disabled:cursor-default cursor-pointer";
const ACTION_CLASS = `${BUTTON_CLASS} border-osu-b3/30 bg-osu-b4/60 text-osu-l2 hover:bg-osu-b3/60 hover:text-white`;
const DANGER_CLASS = `${BUTTON_CLASS} border-osu-red/40 bg-osu-red/10 text-osu-red-light hover:bg-osu-red/20`;
const CHIP_CLASS = "rounded px-1.5 py-[1px] text-[10px] font-semibold uppercase tracking-wide";

type Ask =
  | { kind: "takedown"; theme: AdminCustomTheme }
  | { kind: "restore"; theme: AdminCustomTheme }
  | { kind: "block"; theme: AdminCustomTheme; all: boolean }
  | { kind: "switch"; disabled: boolean };

type Filter = "all" | "new" | "reported";

export function CustomThemesPanel() {
  const [view, setView] = useState<AdminCustomThemesView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [ask, setAsk] = useState<Ask | null>(null);
  const [filter, setFilter] = useState<Filter>("all");
  /* Themes taken down and deleted by their author are done with: nothing on
     the site shows them and there's nothing left to decide. Kept (the
     takedown's record, and Restore), but out of the list until asked for. */
  const [showClosed, setShowClosed] = useState(false);
  /* The one theme playing live; the rest show their stills. */
  const [playing, setPlaying] = useState<number | null>(null);
  const [codeOpen, setCodeOpen] = useState<number | null>(null);

  const refresh = useCallback(async () => {
    try {
      setView(await loadAdminCustomThemes());
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      setView((current) => current ?? { themes: [], disabled: false });
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const run = async (action: () => Promise<string>) => {
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      setMessage(await action());
      await refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };

  const allThemes = view?.themes ?? [];
  const closed = allThemes.filter((theme) => theme.deleted && theme.state === "taken_down").length;
  const themes = showClosed ? allThemes : allThemes.filter((theme) => !(theme.deleted && theme.state === "taken_down"));
  const unseen = themes.filter((theme) => !theme.seen).length;
  const reported = themes.filter((theme) => theme.reports.some((report) => report.kind !== "crash") || theme.state === "auto_hidden").length;
  const shown = themes.filter((theme) => filter === "all" || (filter === "new" ? !theme.seen : theme.reports.some((report) => report.kind !== "crash") || theme.state === "auto_hidden"));

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center gap-2">
        {(["all", "new", "reported"] as const).map((id) => (
          <button
            key={id}
            onClick={() => setFilter(id)}
            className={`${BUTTON_CLASS} ${filter === id ? "border-osu-pink/50 bg-osu-pink/15 text-white" : "border-osu-b3/30 bg-osu-b4/60 text-osu-l2 hover:text-white"}`}
          >
            {id === "all" ? "All" : id === "new" ? "New" : "Reported"}
            {id === "new" && unseen > 0 ? <span className="tabular-nums text-osu-pink">{unseen}</span> : null}
            {id === "reported" && reported > 0 ? <span className="tabular-nums text-osu-yellow">{reported}</span> : null}
          </button>
        ))}
        {closed > 0 ? (
          <button
            onClick={() => setShowClosed((value) => !value)}
            className={`${BUTTON_CLASS} ${showClosed ? "border-osu-pink/50 bg-osu-pink/15 text-white" : "border-osu-b3/30 bg-osu-b4/60 text-osu-l2 hover:text-white"}`}
            title="Themes taken down that their author also deleted"
            aria-pressed={showClosed}
          >
            Taken down and deleted
            <span className="tabular-nums text-osu-f1">{closed}</span>
          </button>
        ) : null}
        <div className="ml-auto flex items-center gap-2">
          {view ? (
            <button
              disabled={busy}
              onClick={() => setAsk({ kind: "switch", disabled: !view.disabled })}
              className={view.disabled ? ACTION_CLASS : DANGER_CLASS}
            >
              {view.disabled ? "Turn custom themes back on" : "Turn all custom themes off"}
            </button>
          ) : null}
          <button onClick={() => void refresh()} className={ACTION_CLASS} aria-label="Refresh">
            <RefreshCw size={13} />
            <span className="hidden sm:inline">Refresh</span>
          </button>
        </div>
      </div>

      {view?.disabled ? (
        <div className="rounded-md border border-osu-yellow/30 bg-osu-yellow/10 px-3 py-2 text-[12px] text-osu-yellow">
          Every custom theme shows only its still, and supporters can't save themes, until you turn them back on.
        </div>
      ) : null}
      {error ? <Notice text={error} tone="error" onDismiss={() => setError(null)} /> : null}
      {message ? <Notice text={message} onDismiss={() => setMessage(null)} /> : null}

      {view === null ? (
        <Skeleton className="h-[120px] w-full rounded-md" />
      ) : shown.length === 0 ? (
        <div className="py-8 text-center text-[12px] text-osu-f1">
          {filter === "new" ? "Nothing new since you last looked." : filter === "reported" ? "No theme is reported." : closed > 0 && !showClosed ? "Every theme left is taken down and deleted." : "No supporter has made a theme yet."}
        </div>
      ) : (
        <div className="space-y-3">
          {shown.map((theme) => (
            <ThemeCard
              key={theme.id}
              theme={theme}
              busy={busy}
              playing={playing === theme.id}
              codeOpen={codeOpen === theme.id}
              onPlay={() => setPlaying((current) => (current === theme.id ? null : theme.id))}
              onCode={() => setCodeOpen((current) => (current === theme.id ? null : theme.id))}
              onSeen={() => void run(async () => {
                await markAdminCustomThemeSeen({ data: { themeId: theme.id } });
                return "";
              })}
              onAsk={setAsk}
              onUnblock={() => void run(async () => {
                await unblockAdminCustomThemeAuthor({ data: { userId: theme.author.id } });
                return `${theme.author.username} can save themes again.`;
              })}
            />
          ))}
        </div>
      )}

      {ask?.kind === "takedown" ? (
        <ConfirmModal
          title={`Take down ${ask.theme.name}?`}
          body={`Comes off ${ask.theme.wearers === 1 ? "the 1 profile" : `all ${ask.theme.wearers} profiles`} wearing it and out of the gallery. Its code and images can't be saved again, by ${ask.theme.author.username} or anyone. Restore puts it back for its author, not on the other profiles.`}
          confirmLabel="Take down"
          danger
          onConfirm={() => {
            const target = ask.theme;
            setAsk(null);
            void run(async () => {
              await takeDownAdminCustomTheme({ data: { themeId: target.id } });
              return `Took down ${target.name}.`;
            });
          }}
          onClose={() => setAsk(null)}
        />
      ) : ask?.kind === "restore" ? (
        <ConfirmModal
          title={`Restore ${ask.theme.name}?`}
          body={ask.theme.state === "auto_hidden"
            ? "It plays again on every profile wearing it. It was hidden after visitors' browsers crashed on it; look at it live first."
            : "It plays again for its author and can go back in the gallery. Profiles it was taken off don't get it back."}
          confirmLabel="Restore"
          onConfirm={() => {
            const target = ask.theme;
            setAsk(null);
            void run(async () => {
              await restoreAdminCustomTheme({ data: { themeId: target.id } });
              return `Restored ${target.name}.`;
            });
          }}
          onClose={() => setAsk(null)}
        />
      ) : ask?.kind === "block" ? (
        <ConfirmModal
          title={ask.all ? `Block ${ask.theme.author.username} and take down their themes?` : `Block ${ask.theme.author.username}?`}
          body={ask.all
            ? "They can't save or publish themes, and every theme of theirs comes off every profile and out of the gallery. Their other supporter perks stay."
            : "They can't save or publish themes, and theirs leave the gallery. Whoever wears one keeps it, and their other supporter perks stay."}
          confirmLabel={ask.all ? "Block and take down" : "Block"}
          danger
          onConfirm={() => {
            const target = ask;
            setAsk(null);
            void run(async () => {
              await blockAdminCustomThemeAuthor({ data: { userId: target.theme.author.id, takeDownAll: target.all } });
              return `Blocked ${target.theme.author.username}${target.all ? " and took down their themes" : ""}.`;
            });
          }}
          onClose={() => setAsk(null)}
        />
      ) : ask?.kind === "switch" ? (
        <ConfirmModal
          title={ask.disabled ? "Turn every custom theme off?" : "Turn custom themes back on?"}
          body={ask.disabled
            ? "Every profile wearing one shows its still instead, and supporters can't save themes until you turn them back on."
            : "Custom themes play again on every profile wearing one, and supporters can save again."}
          confirmLabel={ask.disabled ? "Turn off" : "Turn on"}
          danger={ask.disabled}
          onConfirm={() => {
            const next = ask.disabled;
            setAsk(null);
            void run(async () => {
              await setAdminCustomThemesDisabled({ data: { disabled: next } });
              return next ? "Every custom theme now shows its still." : "Custom themes are back on.";
            });
          }}
          onClose={() => setAsk(null)}
        />
      ) : null}
    </div>
  );
}

function ThemeCard({
  theme,
  busy,
  playing,
  codeOpen,
  onPlay,
  onCode,
  onSeen,
  onAsk,
  onUnblock,
}: {
  theme: AdminCustomTheme;
  busy: boolean;
  playing: boolean;
  codeOpen: boolean;
  onPlay: () => void;
  onCode: () => void;
  onSeen: () => void;
  onAsk: (ask: Ask) => void;
  onUnblock: () => void;
}) {
  const counts = { crash: 0, content: 0, rights: 0 };
  for (const report of theme.reports) counts[report.kind] += 1;
  const notes = theme.reports.filter((report) => report.note);
  const base = theme.revision?.look.base ?? "#0b0a10";

  return (
    <section className={`rounded-md border p-3 ${theme.seen ? "border-osu-b3/20 bg-osu-b4/20" : "border-osu-pink/30 bg-osu-b4/40"}`}>
      <div className="flex flex-col gap-3 sm:flex-row">
        <div className="relative aspect-video w-full shrink-0 overflow-hidden rounded bg-osu-b6 sm:w-[240px]" style={{ backgroundColor: base }}>
          {playing && theme.revision ? (
            <ProfileThemeBackdrop theme={theme.revision} maxPixels={240_000} className="absolute inset-0" />
          ) : theme.stillUrl ? (
            <img src={theme.stillUrl} alt="" className="absolute inset-0 h-full w-full object-cover" onError={hideBrokenImage} />
          ) : null}
        </div>

        <div className="min-w-0 flex-1 space-y-1.5">
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="text-[14px] font-semibold text-white">{theme.name}</span>
            {!theme.seen ? <span className={`${CHIP_CLASS} bg-osu-pink/20 text-osu-pink`}>New</span> : null}
            <span className={`${CHIP_CLASS} ${theme.visibility === "gallery" ? "bg-osu-blue/20 text-osu-blue" : "bg-white/[0.06] text-osu-f1"}`}>
              {theme.visibility === "gallery" ? "Gallery" : "Private"}
            </span>
            {theme.state === "auto_hidden" ? <span className={`${CHIP_CLASS} bg-osu-yellow/20 text-osu-yellow`}>Hidden after crashes</span> : null}
            {theme.state === "taken_down" ? <span className={`${CHIP_CLASS} bg-osu-red/20 text-osu-red-light`}>Taken down</span> : null}
            {theme.deleted ? <span className={`${CHIP_CLASS} bg-white/[0.06] text-osu-f1`}>Deleted by author</span> : null}
          </div>
          <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1 text-[12px] text-osu-f1">
            <a href={`/player/${encodeURIComponent(theme.author.username || String(theme.author.id))}`} className="text-osu-l2 hover:text-white">
              {theme.author.username || `#${theme.author.id}`}
            </a>
            {theme.authorBlocked ? <span className="text-osu-red-light">blocked</span> : null}
            <Hairline />
            <span>{theme.wearers === 1 ? "1 wearing it" : `${theme.wearers} wearing it`}</span>
            <Hairline />
            <span>{theme.liveRevision ? `save ${theme.liveRevision}` : "no save"}</span>
            <Hairline />
            <span title={new Date(theme.updatedAt).toISOString()}>{formatTimeAgo(new Date(theme.updatedAt).toISOString())}</span>
            {theme.costRatio !== null ? (
              <>
                <Hairline />
                <span title="Measured in the author's browser against the heaviest built-in theme">cost {theme.costRatio.toFixed(2)}×</span>
              </>
            ) : null}
            {theme.revision?.format === "shadertoy" ? (
              <>
                <Hairline />
                <span>Shadertoy</span>
              </>
            ) : null}
          </div>
          {theme.credits ? <div className="text-[12px] text-osu-l2">Credits: {theme.credits}</div> : null}
          {counts.crash + counts.content + counts.rights > 0 ? (
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[12px]">
              <Flag size={12} className="text-osu-yellow" />
              {counts.content ? <span className="text-osu-yellow">{counts.content} about its content</span> : null}
              {counts.rights ? <span className="text-osu-yellow">{counts.rights} about rights</span> : null}
              {counts.crash ? <span className="text-osu-f1">{counts.crash} {counts.crash === 1 ? "crash" : "crashes"}</span> : null}
            </div>
          ) : null}
          {notes.length ? (
            <ul className="space-y-0.5 text-[12px] text-osu-l2">
              {notes.slice(0, 4).map((report, index) => (
                <li key={index} className="truncate">“{report.note}”</li>
              ))}
            </ul>
          ) : null}

          <div className="flex flex-wrap gap-2 pt-1">
            <button disabled={!theme.revision} onClick={onPlay} className={ACTION_CLASS}>{playing ? "Stop" : "Play live"}</button>
            <button disabled={!theme.source} onClick={onCode} className={ACTION_CLASS}>{codeOpen ? "Hide code" : theme.previousSource ? "Code and changes" : "Code"}</button>
            {!theme.seen ? <button disabled={busy} onClick={onSeen} className={ACTION_CLASS}>Mark seen</button> : null}
            <span className="flex-1" />
            {theme.state === "live" ? (
              <button disabled={busy} onClick={() => onAsk({ kind: "takedown", theme })} className={DANGER_CLASS}>Take down</button>
            ) : (
              <button disabled={busy} onClick={() => onAsk({ kind: "restore", theme })} className={ACTION_CLASS}>Restore</button>
            )}
            {theme.authorBlocked ? (
              <button disabled={busy} onClick={onUnblock} className={ACTION_CLASS}>Unblock author</button>
            ) : (
              <>
                <button disabled={busy} onClick={() => onAsk({ kind: "block", theme, all: false })} className={DANGER_CLASS}>Block author</button>
                <button disabled={busy} onClick={() => onAsk({ kind: "block", theme, all: true })} className={DANGER_CLASS}>Block and take all down</button>
              </>
            )}
          </div>
        </div>
      </div>

      {codeOpen && theme.source ? <CodeView source={theme.source} previous={theme.previousSource} /> : null}
    </section>
  );
}

/* The source, with what changed since the save before marked line by line. */
function CodeView({ source, previous }: { source: string; previous: string | null }) {
  const lines = useMemo(() => (previous === null ? source.split("\n").map((text) => ({ text, change: "same" as const })) : diffLines(previous, source)), [source, previous]);
  return (
    <pre className="mt-3 max-h-[420px] overflow-auto rounded bg-black/40 p-2 text-[11px] leading-[1.45] text-osu-l2">
      {lines.map((line, index) => (
        <div
          key={index}
          className={line.change === "added" ? "bg-osu-green/15 text-osu-green-light" : line.change === "removed" ? "bg-osu-red/15 text-osu-red-light line-through decoration-osu-red/40" : undefined}
        >
          <span className="inline-block w-4 select-none text-osu-f1">{line.change === "added" ? "+" : line.change === "removed" ? "-" : " "}</span>
          {line.text || " "}
        </div>
      ))}
    </pre>
  );
}

/* A plain longest-common-subsequence diff by line; sources are a few hundred lines at most. */
function diffLines(before: string, after: string): { text: string; change: "same" | "added" | "removed" }[] {
  const a = before.split("\n");
  const b = after.split("\n");
  const lengths: number[][] = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0));
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      lengths[i][j] = a[i] === b[j] ? lengths[i + 1][j + 1] + 1 : Math.max(lengths[i + 1][j], lengths[i][j + 1]);
    }
  }
  const out: { text: string; change: "same" | "added" | "removed" }[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      out.push({ text: b[j], change: "same" });
      i += 1;
      j += 1;
    } else if (lengths[i + 1][j] >= lengths[i][j + 1]) {
      out.push({ text: a[i], change: "removed" });
      i += 1;
    } else {
      out.push({ text: b[j], change: "added" });
      j += 1;
    }
  }
  while (i < a.length) out.push({ text: a[i++], change: "removed" });
  while (j < b.length) out.push({ text: b[j++], change: "added" });
  return out;
}

function Hairline() {
  return <span aria-hidden className="h-3 w-px bg-white/15" />;
}

function Notice({ text, tone, onDismiss }: { text: string; tone?: "error"; onDismiss: () => void }) {
  if (!text) return null;
  return (
    <div className={`flex items-start gap-2 text-[12px] ${tone === "error" ? "text-osu-red-light" : "text-osu-l2"}`}>
      <p className="min-w-0 flex-1 pt-0.5">{text}</p>
      <button onClick={onDismiss} aria-label="Dismiss" className="grid h-6 w-6 flex-shrink-0 cursor-pointer place-items-center rounded text-osu-f1 hover:bg-osu-b4/60 hover:text-white">
        <X size={13} />
      </button>
    </div>
  );
}
