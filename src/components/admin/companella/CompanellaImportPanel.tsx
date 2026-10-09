import { FolderOpen, Search, Upload } from "lucide-react";
import { useCallback, useEffect, useRef, useState, type DragEvent } from "react";

import {
  lookupReplayImport,
  uploadReplayImportBatch,
  type ReplayImportAccount,
  type ReplayImportFileResult,
  type ReplayImportProgress,
} from "../../../lib/companella-replay-import";
import { formatNumber } from "../../../lib/format";

const BUTTON_CLASS =
  "inline-flex items-center justify-center gap-1.5 rounded-md border px-2.5 py-1.5 text-[12px] sm:py-1 sm:text-[11px] transition-colors duration-[120ms] disabled:opacity-50 disabled:cursor-default cursor-pointer";
const ACTION_CLASS = `${BUTTON_CLASS} border-osu-b3/30 bg-osu-b4/60 text-osu-l2 hover:bg-osu-b3/60 hover:text-white`;
const PRIMARY_CLASS = `${BUTTON_CLASS} border-osu-pink/40 bg-osu-pink/15 text-white hover:brightness-110`;

/* A batch stays well under the backend's 12 MiB body once base64 grows it by a third. */
const BATCH_BYTES = 2 * 1024 * 1024;
const BATCH_FILES = 50;
const PARALLEL_BATCHES = 2;
const POLL_MS = 5_000;

const SKIP_LABELS: Record<string, string> = {
  chart_missing: "map file not on the site",
  not_mania: "not osu!mania",
  converted_map: "osu!standard map played as a convert",
  not_a_replay: "not a replay",
  too_large: "too large",
  refused: "refused",
};

interface UploadState {
  total: number;
  sent: number;
  staged: number;
  already: number;
  skipped: Array<{ name: string; reason: string }>;
  failed: number;
  running: boolean;
}

/* Every .osr under a dropped folder; readEntries hands a directory over in chunks until it returns none. */
async function filesFromDrop(items: DataTransferItemList): Promise<File[]> {
  const entries = Array.from(items).map((item) => item.webkitGetAsEntry()).filter((entry): entry is FileSystemEntry => entry != null);
  const files: File[] = [];
  const walk = async (entry: FileSystemEntry): Promise<void> => {
    if (entry.isFile) {
      files.push(await new Promise<File>((resolve, reject) => (entry as FileSystemFileEntry).file(resolve, reject)));
      return;
    }
    const reader = (entry as FileSystemDirectoryEntry).createReader();
    for (;;) {
      const chunk = await new Promise<FileSystemEntry[]>((resolve, reject) => reader.readEntries(resolve, reject));
      if (chunk.length === 0) break;
      for (const child of chunk) await walk(child);
    }
  };
  for (const entry of entries) await walk(entry);
  return files;
}

function onlyReplays(files: File[]): File[] {
  return files.filter((file) => file.name.toLowerCase().endsWith(".osr"));
}

async function toBase64(file: File): Promise<string> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  let binary = "";
  for (let index = 0; index < bytes.length; index += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
  }
  return btoa(binary);
}

function batchesOf(files: File[]): File[][] {
  const batches: File[][] = [];
  let current: File[] = [];
  let bytes = 0;
  for (const file of files) {
    if (current.length > 0 && (current.length >= BATCH_FILES || bytes + file.size > BATCH_BYTES)) {
      batches.push(current);
      current = [];
      bytes = 0;
    }
    current.push(file);
    bytes += file.size;
  }
  if (current.length > 0) batches.push(current);
  return batches;
}

export function CompanellaImportPanel() {
  const [query, setQuery] = useState("");
  const [looking, setLooking] = useState(false);
  const [lookupError, setLookupError] = useState<string | null>(null);
  const [account, setAccount] = useState<ReplayImportAccount | null>(null);
  const [progress, setProgress] = useState<ReplayImportProgress | null>(null);
  const [selected, setSelected] = useState<File[]>([]);
  const [dragging, setDragging] = useState(false);
  const [upload, setUpload] = useState<UploadState | null>(null);
  const folderInput = useRef<HTMLInputElement>(null);

  const refresh = useCallback(async (user: string) => {
    const found = await lookupReplayImport({ data: { user } });
    setAccount(found?.account ?? null);
    setProgress(found?.progress ?? null);
    return found;
  }, []);

  const find = () => {
    const user = query.trim();
    if (!user) return;
    setLooking(true);
    setLookupError(null);
    setUpload(null);
    void refresh(user)
      .then((found) => { if (!found) setLookupError("No player by that name or id on the site."); })
      .catch(() => setLookupError("Could not look that player up."))
      .finally(() => setLooking(false));
  };

  const pending = (progress?.waiting ?? 0) + (progress?.processing ?? 0);
  useEffect(() => {
    if (!account || (pending === 0 && !upload?.running)) return;
    const timer = window.setInterval(() => { void refresh(String(account.userId)).catch(() => {}); }, POLL_MS);
    return () => window.clearInterval(timer);
  }, [account, pending, upload?.running, refresh]);

  const onDrop = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    setDragging(false);
    if (upload?.running) return;
    void filesFromDrop(event.dataTransfer.items).then((files) => setSelected(onlyReplays(files)));
  };

  const start = async () => {
    if (!account || selected.length === 0) return;
    const batches = batchesOf(selected);
    const state: UploadState = { total: selected.length, sent: 0, staged: 0, already: 0, skipped: [], failed: 0, running: true };
    setUpload({ ...state });
    let next = 0;
    const worker = async () => {
      while (next < batches.length) {
        const batch = batches[next++]!;
        try {
          const files = await Promise.all(batch.map(async (file) => ({ name: file.webkitRelativePath || file.name, data: await toBase64(file) })));
          const results: ReplayImportFileResult[] = await uploadReplayImportBatch({ data: { userId: account.userId, files } });
          for (const result of results) {
            if (result.status === "staged") state.staged += 1;
            else if (result.status === "already_imported") state.already += 1;
            else if (result.status === "skipped") state.skipped.push({ name: result.name, reason: SKIP_LABELS[result.reason] ?? result.reason });
          }
        } catch {
          state.failed += batch.length;
        }
        state.sent += batch.length;
        setUpload({ ...state, skipped: [...state.skipped] });
      }
    };
    await Promise.all(Array.from({ length: Math.min(PARALLEL_BATCHES, batches.length) }, worker));
    state.running = false;
    setUpload({ ...state, skipped: [...state.skipped] });
    setSelected([]);
    void refresh(String(account.userId)).catch(() => {});
  };

  return (
    <div className="space-y-5">
      <form
        onSubmit={(event) => { event.preventDefault(); find(); }}
        className="flex items-center gap-2"
      >
        <div className="relative w-full max-w-[320px]">
          <Search size={13} className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-osu-f1" />
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Username or id"
            aria-label="Player to import replays for"
            className="w-full rounded-md border border-osu-b3/50 bg-osu-b6/70 py-1.5 pl-8 pr-3 text-xs text-osu-l1 outline-none transition-colors placeholder:text-osu-f1/60 focus:border-osu-pink/45"
          />
        </div>
        <button type="submit" disabled={looking || !query.trim()} className={ACTION_CLASS}>Find</button>
      </form>
      {lookupError ? <p className="text-[12px] text-osu-red-light">{lookupError}</p> : null}

      {account ? (
        <>
          <div className="flex items-center gap-3">
            {account.avatarUrl ? (
              <img src={account.avatarUrl} alt="" className="h-10 w-10 rounded-full object-cover" />
            ) : (
              <span className="block h-10 w-10 rounded-full bg-osu-b4" />
            )}
            <div className="min-w-0">
              <div className="truncate text-[15px] font-semibold text-white">{account.username}</div>
              <div className="font-mono text-[11px] text-osu-f1">#{account.userId}</div>
            </div>
          </div>

          {progress ? <ProgressLine progress={progress} /> : null}
        </>
      ) : null}

      <div
        onDragOver={(event) => { event.preventDefault(); if (!upload?.running) setDragging(true); }}
        onDragLeave={() => setDragging(false)}
        onDrop={onDrop}
        className={`flex flex-col items-center justify-center gap-3 rounded-md border border-dashed px-4 py-10 text-center transition-colors duration-[120ms] ${dragging ? "border-osu-pink/60 bg-osu-pink/[0.06]" : "border-osu-b3/40 bg-osu-b5/60"}`}
      >
        {selected.length > 0 && !upload?.running ? (
          <>
            <div className="text-[15px] font-semibold text-white">{formatNumber(selected.length)} replays</div>
            <div className="flex items-center gap-2">
              <button onClick={() => void start()} disabled={!account} className={PRIMARY_CLASS}>
                <Upload size={13} /> {account ? `Import for ${account.username}` : "Find a player first"}
              </button>
              <button onClick={() => setSelected([])} className={ACTION_CLASS}>Clear</button>
            </div>
          </>
        ) : upload?.running ? (
          <div className="text-[15px] font-semibold text-white">
            Uploading {formatNumber(upload.sent)} / {formatNumber(upload.total)}
          </div>
        ) : (
          <>
            <div className="text-[14px] text-osu-l2">Drop a folder of .osr files here</div>
            <button onClick={() => folderInput.current?.click()} className={ACTION_CLASS}>
              <FolderOpen size={13} /> Choose folder
            </button>
          </>
        )}
        <input
          ref={folderInput}
          type="file"
          multiple
          // @ts-expect-error webkitdirectory is not in React's input attributes
          webkitdirectory=""
          className="hidden"
          onChange={(event) => {
            setSelected(onlyReplays(Array.from(event.target.files ?? [])));
            event.target.value = "";
          }}
        />
      </div>

      {upload ? <UploadSummary upload={upload} /> : null}
    </div>
  );
}

function ProgressLine({ progress }: { progress: ReplayImportProgress }) {
  const total = progress.waiting + progress.processing + progress.imported + progress.rejected + progress.expired;
  if (total === 0) return <p className="text-[12px] text-osu-f1">No replays imported for this player yet.</p>;
  return (
    <div className="space-y-1.5">
      <div className="flex flex-wrap gap-x-5 gap-y-1 text-[13px]">
        <Stat label="imported" value={progress.imported} className="text-white" />
        <Stat label="waiting" value={progress.waiting} className="text-osu-l2" />
        <Stat label="processing" value={progress.processing} className="text-osu-l2" />
        <Stat label="rejected" value={progress.rejected} className={progress.rejected > 0 ? "text-osu-red-light" : "text-osu-l2"} />
        {progress.expired > 0 ? <Stat label="expired" value={progress.expired} className="text-osu-l2" /> : null}
      </div>
      {progress.rejections.length > 0 ? (
        <div className="flex flex-wrap gap-x-4 gap-y-0.5 font-mono text-[11px] text-osu-f1">
          {progress.rejections.map((rejection) => (
            <span key={rejection.code}>{rejection.code} {formatNumber(rejection.count)}</span>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function Stat({ label, value, className }: { label: string; value: number; className: string }) {
  return (
    <span className={className}>
      <span className="font-semibold tabular-nums">{formatNumber(value)}</span> <span className="text-osu-f1">{label}</span>
    </span>
  );
}

function UploadSummary({ upload }: { upload: UploadState }) {
  return (
    <div className="space-y-2 border-t border-white/[0.07] pt-4">
      <div className="flex flex-wrap gap-x-5 gap-y-1 text-[13px]">
        <Stat label="queued" value={upload.staged} className="text-white" />
        <Stat label="already imported" value={upload.already} className="text-osu-l2" />
        <Stat label="skipped" value={upload.skipped.length} className={upload.skipped.length > 0 ? "text-amber-300" : "text-osu-l2"} />
        {upload.failed > 0 ? <Stat label="failed to upload" value={upload.failed} className="text-osu-red-light" /> : null}
      </div>
      {upload.skipped.length > 0 ? (
        <div className="max-h-[320px] overflow-y-auto">
          {upload.skipped.map((file) => (
            <div key={file.name} className="flex items-baseline justify-between gap-4 py-0.5 text-[11px]">
              <span className="min-w-0 truncate font-mono text-osu-l2">{file.name}</span>
              <span className="flex-shrink-0 text-osu-f1">{file.reason}</span>
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}
