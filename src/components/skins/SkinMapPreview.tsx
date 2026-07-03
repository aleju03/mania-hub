import { Loader2, Search } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { importReplaySkinFromOsk } from "../../lib/replay-skin-import";
import type { ReplaySkinSettings } from "../../lib/replay-skin";
import { fetchSkinPreviewMaps, skinOskFileUrl, type SkinPreviewMap, type SkinSummary } from "../../lib/skins";
import type { MapsFavouriteBeatmapset } from "../../lib/types";
import { formatDuration } from "../../lib/format";
import { ChartPreviewPanel } from "../maps/ChartPreviewPanel";

// "Try it on a map": pick a chart from the backend's fully-cached pool (.osu
// text and audio both already stored, so playback is instant) and watch the
// uploaded skin autoplay it through the replay renderer. The .osk is fetched
// once; its settings import is cached per keymode because block-level values
// (HitPosition, UpsideDown) come from the matching [Mania] section.

export function SkinMapPreview({ skin }: { skin: SkinSummary }) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [keymode, setKeymode] = useState<number | null>(() => (skin.keymodes.includes(4) ? 4 : skin.keymodes[0] ?? null));
  const [maps, setMaps] = useState<SkinPreviewMap[] | null>(null);
  const [mapsLoading, setMapsLoading] = useState(false);
  const [mapsError, setMapsError] = useState(false);
  const [selected, setSelected] = useState<SkinPreviewMap | null>(null);
  const [skinSettings, setSkinSettings] = useState<ReplaySkinSettings | null>(null);
  const [skinLoading, setSkinLoading] = useState(false);
  const [skinError, setSkinError] = useState<string | null>(null);

  const oskBytesRef = useRef<Promise<ArrayBuffer> | null>(null);
  const importedByKeymodeRef = useRef<Map<number, ReplaySkinSettings>>(new Map());
  const oskUrl = skinOskFileUrl(skin);

  // Debounced map search, scoped to the picked keymode.
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    const controller = new AbortController();
    setMapsLoading(true);
    setMapsError(false);
    const timer = setTimeout(() => {
      fetchSkinPreviewMaps(query, keymode, { signal: controller.signal })
        .then((result) => {
          if (cancelled) return;
          setMaps(result);
          setMapsLoading(false);
        })
        .catch(() => {
          if (cancelled || controller.signal.aborted) return;
          setMapsError(true);
          setMapsLoading(false);
        });
    }, query ? 350 : 0);
    return () => {
      cancelled = true;
      controller.abort();
      clearTimeout(timer);
    };
  }, [open, query, keymode]);

  const loadSkinForKeymode = useCallback(async (keys: number): Promise<ReplaySkinSettings | null> => {
    const cached = importedByKeymodeRef.current.get(keys);
    if (cached) return cached;
    if (!oskUrl) return null;
    if (!oskBytesRef.current) {
      oskBytesRef.current = fetch(oskUrl, { credentials: "omit" }).then((response) => {
        if (!response.ok) throw new Error(`Server ${response.status}`);
        return response.arrayBuffer();
      });
      oskBytesRef.current.catch(() => {
        oskBytesRef.current = null;
      });
    }
    const bytes = await oskBytesRef.current;
    const file = new File([bytes], `${skin.name || "skin"}.osk`);
    const imported = await importReplaySkinFromOsk(file, { targetKeyCount: keys });
    // Show the skin's own judgement art when it ships any; the import keeps
    // the viewer's default judgement set otherwise.
    const profile = imported.settings.keymodeProfiles[String(keys)];
    const settings = profile && Object.keys(profile.assets.judgements).length > 0
      ? { ...imported.settings, judgementSet: "skin" as const }
      : imported.settings;
    importedByKeymodeRef.current.set(keys, settings);
    return settings;
  }, [oskUrl, skin.name]);

  const pickMap = useCallback((map: SkinPreviewMap) => {
    setSelected(map);
    setSkinError(null);
    setSkinLoading(true);
    setSkinSettings(null);
    void loadSkinForKeymode(map.keys)
      .then((settings) => {
        setSkinSettings(settings);
        if (!settings) setSkinError("The skin could not be read.");
      })
      .catch(() => setSkinError("The skin could not be read."))
      .finally(() => setSkinLoading(false));
  }, [loadSkinForKeymode]);

  const beatmapset = useMemo<MapsFavouriteBeatmapset | null>(() => {
    if (!selected) return null;
    const coversBase = `https://assets.ppy.sh/beatmaps/${selected.beatmapsetId}/covers`;
    return {
      id: selected.beatmapsetId,
      title: selected.title,
      artist: selected.artist,
      creator: selected.creator ?? "",
      covers: {
        cover: `${coversBase}/cover.jpg`,
        "cover@2x": `${coversBase}/cover@2x.jpg`,
        card: `${coversBase}/card.jpg`,
        "card@2x": `${coversBase}/card@2x.jpg`,
        list: `${coversBase}/list.jpg`,
        "list@2x": `${coversBase}/list@2x.jpg`,
        slimcover: `${coversBase}/slimcover.jpg`,
        "slimcover@2x": `${coversBase}/slimcover@2x.jpg`,
      },
      status: "",
      globalPlayCount: 0,
      globalFavouriteCount: 0,
      // No set preview: the full audio file is the asset the backend
      // guarantees is cached, so the player always uses it.
      previewUrl: "",
      maniaKeys: [selected.keys],
      maniaBeatmaps: [{
        id: selected.beatmapId,
        beatmapsetId: selected.beatmapsetId,
        version: selected.version,
        difficultyRating: selected.difficultyRating,
        totalLength: selected.totalLength,
        cs: selected.keys,
      }],
      starMin: selected.difficultyRating,
      starMax: selected.difficultyRating,
      bpm: 0,
      patterns: [],
    };
  }, [selected]);

  if (!oskUrl) return null;

  return (
    <section className="mt-4 rounded-xl border border-osu-b3/20 bg-osu-b4">
      <div className="flex flex-wrap items-center gap-3 px-4 py-3">
        <h2 className="text-[11px] font-bold uppercase tracking-[0.08em] text-osu-f1/55">Try it on a map</h2>
        {!open && (
          <button
            type="button"
            onClick={() => setOpen(true)}
            className="ml-auto rounded-full border border-osu-b3/60 px-3.5 py-1.5 text-[12px] font-semibold text-osu-l2 transition-colors cursor-pointer hover:border-osu-pink/45 hover:text-white"
          >
            Pick a map
          </button>
        )}
      </div>
      {open && (
        <div className="border-t border-osu-b3/25 px-4 py-3">
          <div className="flex flex-wrap items-center gap-2">
            <label className="relative flex-1 basis-[220px]">
              <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-osu-f1/60" aria-hidden="true" />
              <input
                type="search"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="Search title, artist, or mapper"
                className="w-full rounded-lg border border-osu-b3/30 bg-osu-b5 py-1.5 pl-8 pr-3 text-[12.5px] text-osu-l1 transition-colors placeholder:text-osu-f1/45 focus:border-osu-pink/50 focus:outline-none"
              />
            </label>
            {skin.keymodes.length > 1 && (
              <div className="flex items-center gap-1">
                {skin.keymodes.map((keys) => (
                  <button
                    key={keys}
                    type="button"
                    onClick={() => setKeymode(keys)}
                    aria-pressed={keymode === keys}
                    className={`rounded px-2 py-1 text-[11px] font-bold tabular-nums transition-colors cursor-pointer ${
                      keymode === keys ? "bg-osu-pink text-white" : "bg-osu-b5 text-osu-l2 hover:text-white"
                    }`}
                  >
                    {keys}K
                  </button>
                ))}
              </div>
            )}
          </div>

          <div className="mt-2.5">
            {mapsError ? (
              <p className="py-2 text-[12px] font-semibold text-osu-red-light">The map list could not be loaded.</p>
            ) : mapsLoading && !maps ? (
              <p className="flex items-center gap-2 py-2 text-[12px] text-osu-f1">
                <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
                Looking for cached maps...
              </p>
            ) : maps && maps.length === 0 ? (
              <p className="py-2 text-[12px] text-osu-f1">
                No fully cached {keymode ? `${keymode}K ` : ""}maps match. Only charts whose file and audio are already on the server can be picked.
              </p>
            ) : maps ? (
              <ul className={`flex flex-col ${mapsLoading ? "opacity-60" : ""}`}>
                {maps.map((map) => {
                  const isSelected = selected?.beatmapId === map.beatmapId;
                  return (
                    <li key={map.beatmapId}>
                      <button
                        type="button"
                        onClick={() => pickMap(map)}
                        aria-pressed={isSelected}
                        className={`flex w-full items-baseline gap-2 rounded-md px-2 py-1.5 text-left text-[12.5px] transition-colors cursor-pointer ${
                          isSelected ? "bg-osu-pink/20 text-white" : "text-osu-l2 hover:bg-osu-b5 hover:text-white"
                        }`}
                      >
                        <span className="min-w-0 truncate">
                          <span className="font-semibold">{map.title}</span>
                          <span className="text-osu-f1"> by {map.artist}</span>
                          <span className="text-osu-f1/80"> [{map.version}]</span>
                        </span>
                        <span className="ml-auto shrink-0 tabular-nums text-[11px] text-osu-f1">
                          {map.keys}K · ★{map.difficultyRating.toFixed(2)}{map.totalLength > 0 ? ` · ${formatDuration(map.totalLength)}` : ""}
                        </span>
                      </button>
                    </li>
                  );
                })}
              </ul>
            ) : null}
          </div>

          {selected && (
            <div className="mt-3">
              {skinLoading && (
                <p className="flex items-center gap-2 py-2 text-[12px] text-osu-f1">
                  <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
                  Reading the skin from the .osk...
                </p>
              )}
              {skinError && <p className="py-2 text-[12px] font-semibold text-osu-red-light">{skinError}</p>}
              {skinSettings && beatmapset && (
                <ChartPreviewPanel
                  key={selected.beatmapId}
                  beatmapset={beatmapset}
                  selectedBeatmapId={selected.beatmapId}
                  skinSettingsOverride={skinSettings}
                />
              )}
            </div>
          )}
        </div>
      )}
    </section>
  );
}
