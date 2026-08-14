import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { formatPpGain } from "../../lib/format";
import type { LiveTopPlaysPpGain } from "../../lib/live-backend";
import { Avatar } from "../ui/Avatar";

const DESKTOP_COLUMNS = 3;
const DESKTOP_ROW_HEIGHT = 52;
const MOBILE_ITEM_WIDTH = 46;
const MOBILE_ITEM_GAP = 12;

type RailFade = { top: boolean; bottom: boolean };

export const PpGainsRail = memo(function PpGainsRail({
  players,
  selectedPlayerIds,
  onTogglePlayer,
}: {
  players: LiveTopPlaysPpGain[];
  selectedPlayerIds: number[];
  onTogglePlayer: (playerId: number) => void;
}) {
  const selectedPlayerIdSet = useMemo(() => new Set(selectedPlayerIds), [selectedPlayerIds]);
  const desktopScrollRef = useRef<HTMLDivElement | null>(null);
  const mobileScrollRef = useRef<HTMLDivElement | null>(null);
  const [fade, setFade] = useState<RailFade>({ top: false, bottom: false });

  const desktopVirtualizer = useVirtualizer({
    count: Math.ceil(players.length / DESKTOP_COLUMNS),
    getScrollElement: () => desktopScrollRef.current,
    estimateSize: () => DESKTOP_ROW_HEIGHT,
    overscan: 3,
    initialRect: { width: 128, height: 600 },
    getItemKey: (index) => players[index * DESKTOP_COLUMNS]?.id ?? index,
  });
  const mobileVirtualizer = useVirtualizer({
    horizontal: true,
    count: players.length,
    getScrollElement: () => mobileScrollRef.current,
    estimateSize: () => MOBILE_ITEM_WIDTH,
    gap: MOBILE_ITEM_GAP,
    overscan: 5,
    initialRect: { width: 960, height: DESKTOP_ROW_HEIGHT },
    getItemKey: (index) => players[index]?.id ?? index,
  });

  const updateFade = useCallback(() => {
    const element = desktopScrollRef.current;
    if (!element) return;
    const top = element.scrollTop > 4;
    const bottom = element.scrollTop + element.clientHeight < element.scrollHeight - 4;
    setFade((current) => current.top === top && current.bottom === bottom ? current : { top, bottom });
  }, []);

  useEffect(() => {
    updateFade();
    window.addEventListener("resize", updateFade);
    return () => window.removeEventListener("resize", updateFade);
  }, [players.length, updateFade]);

  const maskClass = fade.top && fade.bottom
    ? "tracker-rail--tb"
    : fade.top
      ? "tracker-rail--t"
      : fade.bottom
        ? "tracker-rail--b"
        : "";

  return (
    <>
      <div className="lg:hidden flex items-start gap-3 py-1 min-h-[54px]">
        <span className="text-[9px] uppercase tracking-wider text-osu-f1 font-semibold flex-shrink-0 pt-2">
          PP Gained
        </span>
        <div
          ref={mobileScrollRef}
          className="min-w-0 flex-1 overflow-x-auto overscroll-contain scrollbar-hide"
        >
          <div
            className="relative h-[48px]"
            style={{ width: mobileVirtualizer.getTotalSize() }}
          >
            {mobileVirtualizer.getVirtualItems().map((item) => {
              const player = players[item.index];
              return (
                <div
                  key={player.id}
                  className="absolute left-0 top-0"
                  style={{
                    width: item.size,
                    transform: `translateX(${item.start}px)`,
                  }}
                >
                  <PpGainPlayerButton
                    player={player}
                    selected={selectedPlayerIdSet.has(player.id)}
                    onToggle={onTogglePlayer}
                    insetRing
                  />
                </div>
              );
            })}
          </div>
        </div>
      </div>

      <div className="hidden lg:flex sticky top-[76px] max-h-[calc(100svh_-_196px)] self-start flex-col flex-shrink-0 min-w-[128px]">
        <div className="flex items-baseline justify-between gap-2 mb-2 px-0.5">
          <span className="text-[9px] uppercase tracking-wider text-osu-f1 font-semibold">PP Gained</span>
          <span className="text-[9px] tabular-nums text-osu-f1/70 font-semibold">{players.length}</span>
        </div>
        <div
          ref={desktopScrollRef}
          onScroll={updateFade}
          className={`min-h-0 overflow-y-auto overscroll-contain scrollbar-hide ${maskClass}`}
        >
          <div
            className="relative w-full px-0.5 py-1"
            style={{ height: desktopVirtualizer.getTotalSize() }}
          >
            {desktopVirtualizer.getVirtualItems().map((item) => {
              const firstPlayerIndex = item.index * DESKTOP_COLUMNS;
              const rowPlayers = players.slice(firstPlayerIndex, firstPlayerIndex + DESKTOP_COLUMNS);
              return (
                <div
                  key={item.key}
                  className="absolute left-0 top-0 grid w-full grid-cols-3 place-items-start gap-x-2 px-0.5"
                  style={{
                    height: item.size,
                    transform: `translateY(${item.start}px)`,
                  }}
                >
                  {rowPlayers.map((player) => (
                    <PpGainPlayerButton
                      key={player.id}
                      player={player}
                      selected={selectedPlayerIdSet.has(player.id)}
                      onToggle={onTogglePlayer}
                    />
                  ))}
                </div>
              );
            })}
          </div>
        </div>
      </div>
    </>
  );
});

const PpGainPlayerButton = memo(function PpGainPlayerButton({
  player,
  selected,
  onToggle,
  insetRing = false,
}: {
  player: LiveTopPlaysPpGain;
  selected: boolean;
  onToggle: (playerId: number) => void;
  insetRing?: boolean;
}) {
  return (
    <button
      onClick={() => onToggle(player.id)}
      onContextMenu={(event) => event.preventDefault()}
      aria-pressed={selected}
      className="cursor-pointer group relative flex w-full shrink-0 flex-col items-center gap-0.5"
      title={`${player.username}: +${formatPpGain(player.totalGain)}pp - click to filter`}
    >
      <div className={`${insetRing ? "ring-inset " : ""}ring-2 rounded-full transition-all ${
        selected
          ? "ring-osu-pink shadow-[0_0_0_3px_rgba(255,102,171,0.18)]"
          : "ring-osu-pink/40 group-hover:ring-osu-pink"
      }`}>
        <Avatar url={player.avatar_url} size={32} />
      </div>
      <span className="text-[9px] font-semibold text-osu-green">
        +{formatPpGain(player.totalGain)}
      </span>
    </button>
  );
});
