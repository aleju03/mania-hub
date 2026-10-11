import { Link } from "@tanstack/react-router";
import { Pencil, Plus, Trash2, Video } from "lucide-react";
import { useCallback, useEffect, useState } from "react";

import { CountryFlag } from "../../ui/CountryFlag";
import { GradeImg } from "../../ui/GradeImg";
import { ModBadge } from "../../ui/ModBadge";
import { SearchInput } from "../../ui/SearchInput";
import { SegmentedControl } from "../../ui/SegmentedControl";
import { lookupAdminScoreRemoval, type AdminScoreRemovalView, type AdminScoreRow } from "../../../lib/admin-score-removal";
import { deleteAdminScoreVideo, listAdminScoreVideos, setAdminScoreVideo, type AdminScoreVideo } from "../../../lib/admin-score-videos";
import { formatAccuracy, formatTimeAgo } from "../../../lib/format";
import { searchPlayers, searchPlayersOnOsu } from "../../../lib/player-search";
import { reloadScoreVideos } from "../../../lib/score-videos";
import { VideoLinkForm } from "./VideoLinkForm";

/* The Add video tab of /admin/players: a proof video (a YouTube link) on one
 * of a player's official plays, picked from their stored top and recent plays
 * or named by a pasted score link. The play's rows and card link the video
 * (backend features/score-videos.ts).
 */

type PlayList = "top" | "recent";

const BUTTON_CLASS =
  "inline-flex items-center justify-center gap-1.5 rounded-md border px-2.5 py-1.5 text-[12px] transition-colors duration-[120ms] disabled:opacity-50 disabled:cursor-default cursor-pointer";
const ACTION_CLASS = `${BUTTON_CLASS} border-osu-b3/30 bg-osu-b4/60 text-osu-l2 hover:bg-osu-b3/60 hover:text-white`;
const DANGER_CLASS = `${BUTTON_CLASS} border-osu-red/40 bg-osu-red/10 text-osu-red-light hover:bg-osu-red/20`;
const INPUT_CLASS =
  "w-full rounded-md bg-osu-b4/60 border border-osu-b3/30 px-3 py-2 text-[14px] text-white placeholder:text-osu-f1 outline-none focus:border-osu-b3";

/** The score id in a pasted osu! score link or a bare id. */
function parseScoreId(text: string): number | null {
  const match = /(\d+)\/?$/.exec(text.trim());
  const id = match ? Number(match[1]) : NaN;
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

function chartLabel(row: { artist: string | null; title: string | null; version: string | null; beatmapId: number | null }): string {
  if (!row.title) return row.beatmapId ? `Beatmap ${row.beatmapId}` : "Unknown beatmap";
  return `${row.artist ? `${row.artist} - ` : ""}${row.title}${row.version ? ` [${row.version}]` : ""}`;
}

export function AddVideoPanel() {
  const [view, setView] = useState<AdminScoreRemovalView | null>(null);
  const [videos, setVideos] = useState<AdminScoreVideo[]>([]);
  const [list, setList] = useState<PlayList>("top");
  const [selected, setSelected] = useState<number | null>(null);
  const [pasted, setPasted] = useState("");
  const [playQuery, setPlayQuery] = useState("");
  const [videoUrl, setVideoUrl] = useState("");
  const [editing, setEditing] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  const load = useCallback(async (lookup: string) => {
    setBusy(true);
    setError(null);
    try {
      const next = await lookupAdminScoreRemoval({ data: { query: lookup } });
      setView(next);
      setVideos(await listAdminScoreVideos({ data: { userId: next.user.userId } }));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  }, []);

  const lookup = (value: string) => {
    setMessage(null);
    void load(value);
  };

  useEffect(() => {
    setSelected(null);
    setPasted("");
  }, [view?.user.userId]);

  const withVideo = new Set(videos.flatMap((video) => [video.scoreId, video.legacyScoreId ?? 0]));
  const needle = playQuery.trim().toLowerCase();
  const rows = (view ? (list === "top" ? view.topPlays : view.recentPlays) : [])
    .filter((row) => !needle || chartLabel(row).toLowerCase().includes(needle));
  const scoreId = parseScoreId(pasted) ?? selected;

  const run = async (action: () => Promise<string>) => {
    if (!view) return;
    setBusy(true);
    setError(null);
    try {
      const done = await action();
      setVideos(await listAdminScoreVideos({ data: { userId: view.user.userId } }));
      reloadScoreVideos();
      setMessage(done);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };

  const add = () => {
    if (!view || scoreId == null || !videoUrl.trim()) return;
    const userId = view.user.userId;
    void run(async () => {
      await setAdminScoreVideo({ data: { userId, scoreId, videoUrl: videoUrl.trim() } });
      setVideoUrl("");
      setSelected(null);
      setPasted("");
      return "Added the video.";
    });
  };

  const change = (video: AdminScoreVideo, next: string) => {
    if (!view) return;
    const userId = view.user.userId;
    void run(async () => {
      await setAdminScoreVideo({ data: { userId, scoreId: video.scoreId, videoUrl: next } });
      setEditing(null);
      return "Changed the video.";
    });
  };

  const remove = (video: AdminScoreVideo) => {
    void run(async () => {
      await deleteAdminScoreVideo({ data: { scoreId: video.scoreId } });
      return "Removed the video.";
    });
  };

  return (
    <div className="space-y-4">
      <SearchInput
        className="w-full"
        placeholder="find player..."
        onSearch={(q) => searchPlayers(q)}
        onSearchOsu={searchPlayersOnOsu}
        onSelect={(user) => lookup(`#${user.id}`)}
        onSubmit={(q) => lookup(q)}
      />

      {error ? <p className="text-[13px] text-osu-red-light">{error}</p> : null}
      {message ? <p className="text-[13px] text-osu-l2">{message}</p> : null}

      {view ? (
        <>
          <div className="flex items-center gap-3">
            {view.user.avatarUrl ? <img src={view.user.avatarUrl} alt="" className="h-10 w-10 rounded-full" /> : null}
            <Link to="/player/$username" params={{ username: view.user.username }} className="text-[17px] font-medium text-white hover:underline">
              {view.user.username}
            </Link>
            {view.user.countryCode ? <CountryFlag code={view.user.countryCode} size="xs" decorative /> : null}
            <span className="text-[12px] text-osu-f1">#{view.user.userId}</span>
          </div>

          <form
            className="flex flex-wrap items-center gap-2"
            onSubmit={(event) => {
              event.preventDefault();
              add();
            }}
          >
            <input
              value={videoUrl}
              onChange={(event) => setVideoUrl(event.target.value)}
              placeholder="https://www.youtube.com/watch?v=..."
              className={`${INPUT_CLASS} flex-1 min-w-[260px]`}
            />
            <button type="submit" disabled={busy || scoreId == null || !videoUrl.trim()} className={`${ACTION_CLASS} px-4 py-2 text-[13px]`}>
              <Plus size={14} />
              Add video
            </button>
          </form>

          <input
            value={playQuery}
            onChange={(event) => setPlayQuery(event.target.value)}
            placeholder="search their plays by map..."
            className={INPUT_CLASS}
          />

          <div className="flex flex-wrap items-center gap-2">
            <SegmentedControl
              id="admin-video-list"
              value={list}
              options={[
                { value: "top", label: `Top plays (${view.topPlays.length})` },
                { value: "recent", label: `Recent tracked (${view.recentPlays.length})` },
              ]}
              onChange={setList}
            />
            <input
              value={pasted}
              onChange={(event) => setPasted(event.target.value)}
              placeholder="Or paste a score link or id"
              className="flex-1 min-w-[220px] rounded-md bg-osu-b4/60 border border-osu-b3/30 px-3 py-1.5 text-[13px] text-white placeholder:text-osu-f1 outline-none focus:border-osu-b3"
            />
          </div>

          <div>
            {rows.length === 0 ? (
              <p className="py-6 text-center text-[13px] text-osu-f1">{needle ? "No plays match." : "No osu! plays stored for this player."}</p>
            ) : rows.map((row) => (
              <ScoreRow
                key={row.scoreId}
                row={row}
                checked={parseScoreId(pasted) == null && selected === row.scoreId}
                hasVideo={withVideo.has(row.scoreId) || (row.legacyScoreId != null && withVideo.has(row.legacyScoreId))}
                onPick={() => {
                  setPasted("");
                  setSelected((current) => (current === row.scoreId ? null : row.scoreId));
                }}
              />
            ))}
          </div>

          {videos.length > 0 ? (
            <section className="space-y-1">
              <h3 className="text-[13px] font-medium text-osu-c2">Videos</h3>
              {videos.map((video) => (
                <div key={video.scoreId} className="flex items-center gap-3 py-2 border-t border-white/[0.07]">
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-[14px] text-white">{chartLabel(video)}</div>
                    <div className="flex items-center gap-2 text-[11px] text-osu-f1">
                      <a href={`https://osu.ppy.sh/scores/${video.scoreId}`} target="_blank" rel="noreferrer" className="hover:text-white hover:underline">
                        {video.scoreId}
                      </a>
                      <a href={video.videoUrl} target="_blank" rel="noreferrer" className="truncate hover:text-white hover:underline">
                        {video.videoUrl}
                      </a>
                    </div>
                    {editing === video.scoreId ? (
                      <VideoLinkForm
                        initial={video.videoUrl}
                        allowEmpty={false}
                        busy={busy}
                        onSave={(next) => change(video, next)}
                        onCancel={() => setEditing(null)}
                      />
                    ) : null}
                  </div>
                  {editing !== video.scoreId ? (
                    <button disabled={busy} onClick={() => setEditing(video.scoreId)} className={ACTION_CLASS}>
                      <Pencil size={13} />
                      Edit
                    </button>
                  ) : null}
                  <button disabled={busy} onClick={() => remove(video)} className={DANGER_CLASS}>
                    <Trash2 size={13} />
                    Remove
                  </button>
                </div>
              ))}
            </section>
          ) : null}
        </>
      ) : null}
    </div>
  );
}

function ScoreRow({ row, checked, hasVideo, onPick }: { row: AdminScoreRow; checked: boolean; hasVideo: boolean; onPick: () => void }) {
  return (
    <label className={`flex items-center gap-3 py-2 border-t border-white/[0.07] cursor-pointer ${checked ? "bg-white/[0.06]" : "hover:bg-white/[0.03]"}`}>
      <input type="radio" name="admin-video-play" checked={checked} onChange={onPick} onClick={checked ? onPick : undefined} className="ml-1 h-4 w-4 accent-[#ff66aa]" />
      {row.rank ? <GradeImg grade={row.rank} size={20} /> : null}
      <div className="min-w-0 flex-1">
        <div className="truncate text-[14px] text-white">{chartLabel(row)}</div>
        <div className="flex items-center gap-2 text-[11px] text-osu-f1">
          {row.mods.map((mod) => <ModBadge key={mod} mod={mod} size={0.6} />)}
          {row.accuracy != null ? <span>{formatAccuracy(row.accuracy)}</span> : null}
          {row.endedAt ? <span>{formatTimeAgo(row.endedAt)}</span> : null}
          <a
            href={`https://osu.ppy.sh/scores/${row.scoreId}`}
            target="_blank"
            rel="noreferrer"
            onClick={(event) => event.stopPropagation()}
            className="hover:text-white hover:underline"
          >
            {row.scoreId}
          </a>
        </div>
      </div>
      {hasVideo ? <Video size={16} className="text-osu-f1" aria-label="Has a video" /> : null}
      <span className="pr-2 text-[15px] font-medium tabular-nums text-osu-l2">
        {row.pp != null ? `${Math.round(row.pp)}pp` : ""}
      </span>
    </label>
  );
}
