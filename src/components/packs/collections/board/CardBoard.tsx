import { Plural, Trans, useLingui } from "@lingui/react/macro";
import { Brush, Expand, Flag, Grid3x3, Hand, Layers, Link2, LocateFixed, Minus, Plus, Redo2, RotateCcw, RotateCw, Shrink, SquareDashedMousePointer, Trash2, Undo2, X, ZoomOut } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useAuth } from "#/lib/auth-context";
import { DEFAULT_COUNTRY_CODE } from "#/lib/country";
import { formatNumber } from "#/lib/format";
import { useMediaQuery } from "#/lib/use-media-query";
import {
  fetchLivePackBoardOverview,
  fetchLivePackBoardOwner,
  fetchLivePackBoardPreviews,
  fetchLivePackBoardRegions,
  openLiveEventSource,
  type LivePackBoardOwner,
} from "#/lib/live-backend";
import { submitBugReport } from "#/lib/bug-reports";
import { MANIA_TIER_STYLES, type ManiaCardTier } from "#/lib/maniacard";
import { fetchPackBoardFriendOf, removePackBoardCards, sendPackBoardOps } from "#/lib/pack-wallet-sync";
import { BoardFaces } from "./boardFaces";
import { BoardMinimap, type BoardMinimapHandle } from "./BoardMinimap";
import { BoardEngine, TINTS, cardPaint, makeCard, regionOf, tierPaint, type BoardCard, type BoardCardFace, type BoardOp, type BoardTool } from "./boardEngine";

/* How many cards a supporter may lay down (backend features/pack-boards.ts, PACK_BOARD_SUPPORTER_CARD_CAP). */
const SUPPORTER_CARD_CAP = 6000;

/* The shared card board: one endless table every collector lays their cards
   on, moved, turned, resized, or dealt along a brush stroke to draw with.

   The engine (boardEngine.ts) holds the table and draws it; this feeds it
   regions as it asks for them, passes on the live stream's changes, keeps the
   tray of cards the viewer can still lay down, and sends the viewer's edits
   to the backend in small batches as they happen. */

type InventoryRow = LivePackBoardOwner["inventory"][number];

/* Highest first, the order the brush chips are listed in. */
const TIER_ORDER = ["eternal", "goat", "worldClass", "ascendant", "mythic", "legendary", "ultraRare", "superRare", "elite", "rare", "common"];
const SEND_DELAY_MS = 600;
const SEND_BATCH = 2000;
const REGION_BATCH = 48;
const OVERVIEW_REFRESH_MS = 60_000;
const TRAY_LIMIT = 150;

function tierLabel(tier: string | null): string {
  return tier && tier in MANIA_TIER_STYLES ? MANIA_TIER_STYLES[tier as ManiaCardTier].label : MANIA_TIER_STYLES.common.label;
}

function swatch(tier: string | null): string {
  const paint = tierPaint(tier);
  return `linear-gradient(150deg, ${paint.light}, ${paint.mid} 55%, ${paint.dark})`;
}

type SaveState = "saved" | "saving" | "retrying";

/* Board units per coordinate step: a card's width, so "120, -45" means 120
   cards right of the middle and 45 up. */
const COORD_UNIT = 64;

/* Reads a shared spot ("x,y" in card widths, optional zoom in percent). */
function parseAt(at: string | undefined): { x: number; y: number; z?: number } | null {
  const parts = at?.split(",").map(Number);
  if (!parts || parts.length < 2 || parts.some((part) => !Number.isFinite(part))) return null;
  return { x: parts[0] * COORD_UNIT, y: parts[1] * COORD_UNIT, z: parts[2] ? parts[2] / 100 : undefined };
}

export function CardBoard({ at }: { at?: string }) {
  const { t } = useLingui();
  const auth = useAuth();
  const me = auth.viewer?.id ?? null;
  const admin = auth.isAdmin;

  const [inventory, setInventory] = useState<InventoryRow[] | null>(null);
  const [cap, setCap] = useState(0);
  const [count, setCount] = useState(0);
  const [used, setUsed] = useState<Map<string, number>>(new Map());
  const [stats, setStats] = useState<{ total: number; owners: number } | null>(null);
  const [tool, setTool] = useState<BoardTool>("move");
  const [brushTier, setBrushTier] = useState<string | null>(null);
  const [brushScale, setBrushScale] = useState(0.7);
  const [follow, setFollow] = useState(false);
  const [grid, setGrid] = useState(false);
  /* The cards under a spot (Alt-click, or a long press), listed top first,
     and the view they were listed in: moving the view closes the list. */
  const [stack, setStack] = useState<{ cards: BoardCard[]; x: number; y: number; reach: number; w: number; h: number } | null>(null);
  const stackCam = useRef<string | null>(null);
  /* Cards this viewer reported this visit, by owner:number. */
  const [reported, setReported] = useState<Set<string>>(new Set());
  const [selection, setSelection] = useState<BoardCard[]>([]);
  const [history, setHistory] = useState({ undo: false, redo: false });
  const [saveState, setSaveState] = useState<SaveState>("saved");
  const [notice, setNotice] = useState<string | null>(null);
  const [far, setFar] = useState(false);
  /* The colour cards are laid down in (TINTS, 1-based), 0 for their tier's. */
  const [tint, setTint] = useState(0);
  const [picking, setPicking] = useState(false);
  /* The selection's size slider, as a power of two (0 is as it was). */
  const [scaleStep, setScaleStep] = useState(0);
  const [query, setQuery] = useState("");
  const [trayTier, setTrayTier] = useState<string | null>(null);
  /* Phones get the toolbar on two rows, the view buttons over the board and
     the tray as a sheet; anything below lg gets the sheet, since the tray only
     fits beside the board on a wide screen. */
  const narrow = useMediaQuery("(max-width: 767px)") === true;
  const sheetTray = useMediaQuery("(max-width: 1023px)") === true;
  const touch = useMediaQuery("(pointer: coarse)") === true;
  /* The board over the whole page: on a phone the page can't be scrolled
     with a finger on the board, so this is the comfortable way to use it. */
  const [full, setFull] = useState(false);
  const [trayOpen, setTrayOpen] = useState(false);
  const tip = useRef<HTMLDivElement>(null);
  const coords = useRef<HTMLSpanElement>(null);
  const pointerOn = useRef(false);
  const showCoords = (x: number, y: number) => {
    if (coords.current) coords.current.textContent = `${Math.round(x / COORD_UNIT)}, ${Math.round(y / COORD_UNIT)}`;
  };
  const start = useRef(parseAt(at));

  /* The viewer's side of the table, kept out of state: a stroke takes cards
     many times a second and must see its own takes straight away. */
  const mine = useRef({
    keys: new Map<number, string>(),
    regions: new Map<number, number>(),
    used: new Map<string, number>(),
    cap: 0,
    tier: null as string | null,
    inventory: [] as InventoryRow[],
  });
  mine.current.tier = brushTier;
  mine.current.cap = cap;
  mine.current.inventory = inventory ?? [];

  /* The minimap: which regions have cards (from the overview), redrawn at
     most once a frame. */
  const minimap = useRef<BoardMinimapHandle>(null);
  const mapRegions = useRef<[number, number][]>([]);
  const mapQueued = useRef(false);
  const redrawMap = useCallback(() => {
    if (mapQueued.current) return;
    mapQueued.current = true;
    requestAnimationFrame(() => {
      mapQueued.current = false;
      minimap.current?.draw();
    });
  }, []);
  const takeOverview = useCallback((read: { total: number; owners: number; regions: [number, number, number][] }) => {
    setStats({ total: read.total, owners: read.owners });
    mapRegions.current = read.regions.map(([id, count]) => [id, count]);
    redrawMap();
  }, [redrawMap]);
  const getMapRegions = useCallback(() => mapRegions.current, []);
  const getMineRegions = useCallback(() => mine.current.regions.values(), []);

  /* The count under the board, read again a moment after anything changes. */
  const statsTimer = useRef(0);
  const refreshStats = useCallback(() => {
    if (statsTimer.current) return;
    statsTimer.current = window.setTimeout(() => {
      statsTimer.current = 0;
      fetchLivePackBoardOverview().then(takeOverview).catch(() => {});
    }, 3000);
  }, [takeOverview]);

  const outbox = useRef<BoardOp[]>([]);
  const pending = useRef(new Map<number, number>());
  const sendTimer = useRef(0);
  const sending = useRef(false);
  const engineRef = useRef<BoardEngine | null>(null);

  const publishUsage = useCallback(() => {
    setUsed(new Map(mine.current.used));
    setCount(mine.current.keys.size);
  }, []);

  /* Bookkeeping for one of the viewer's cards coming onto or off the table. */
  const track = useCallback((n: number, key: string | null, x?: number, y?: number) => {
    const state = mine.current;
    const held = state.keys.get(n);
    if (held !== undefined) {
      state.used.set(held, Math.max(0, (state.used.get(held) ?? 1) - 1));
      state.keys.delete(n);
      state.regions.delete(n);
    }
    if (key !== null) {
      state.keys.set(n, key);
      state.used.set(key, (state.used.get(key) ?? 0) + 1);
      if (x !== undefined && y !== undefined) state.regions.set(n, regionOf(x, y));
    }
  }, []);

  const send = useCallback(async () => {
    window.clearTimeout(sendTimer.current);
    if (sending.current || outbox.current.length === 0) return;
    sending.current = true;
    const batch = outbox.current.splice(0, SEND_BATCH);
    setSaveState("saving");
    try {
      const result = await sendPackBoardOps({ data: { ops: batch } });
      if (!result) throw new Error("signed out");
      const engine = engineRef.current;
      let refused = 0;
      let reload = false;
      batch.forEach((op, i) => {
        const n = op[1];
        const left = (pending.current.get(n) ?? 1) - 1;
        if (left > 0) pending.current.set(n, left);
        else pending.current.delete(n);
        const z = result.z[i];
        if (z === null && op[0] === "a") {
          refused++;
          track(n, null);
          engine?.dropOwn(n);
        } else if (z === null) {
          // a move the server would not take: read back where the card is
          reload = true;
        } else if (z) {
          engine?.ack(n, z);
        }
      });
      if (reload) engine?.reloadLoaded();
      for (const n of result.removed) {
        track(n, null);
        engine?.dropOwn(n);
      }
      for (const [region, version] of result.regions) engine?.noteVersion(region, version, true);
      refreshStats();
      setCap(result.cap);
      publishUsage();
      if (result.forbidden) setNotice(t`That shape isn't allowed on the board.`);
      else if (result.full) setNotice(t`This part of the board is full. Try further out.`);
      else if (result.protected) setNotice(t`Drawings are protected from other players for their first day.`);
      else if (result.slow) setNotice(t`Slow down a little.`);
      else if (refused) setNotice(t`Some cards could not be laid down.`);
      setSaveState(outbox.current.length ? "saving" : "saved");
      sending.current = false;
      if (outbox.current.length) sendTimer.current = window.setTimeout(() => void send(), SEND_DELAY_MS);
    } catch {
      // put back in front, in order, and try again shortly
      outbox.current.unshift(...batch);
      sending.current = false;
      setSaveState("retrying");
      sendTimer.current = window.setTimeout(() => void send(), 3000);
    }
  }, [publishUsage, refreshStats, t, track]);

  const onOps = useCallback((ops: BoardOp[]) => {
    for (const op of ops) {
      pending.current.set(op[1], (pending.current.get(op[1]) ?? 0) + 1);
      if (op[0] === "a") track(op[1], op[2], op[3], op[4]);
      else if (op[0] === "d") track(op[1], null);
      else mine.current.regions.set(op[1], regionOf(op[2], op[3]));
    }
    outbox.current.push(...ops);
    publishUsage();
    redrawMap();
    setSaveState("saving");
    window.clearTimeout(sendTimer.current);
    sendTimer.current = window.setTimeout(() => void send(), outbox.current.length >= 400 ? 0 : SEND_DELAY_MS);
  }, [publishUsage, redrawMap, send, track]);

  // below the supporter cap, the notice says supporters can lay down more
  const fullNotice = useCallback((ownCap: number) => ownCap < SUPPORTER_CARD_CAP
    ? t`You have laid down as many cards as you can. Supporters get 3x the cards on the board.`
    : t`You have laid down as many cards as you can.`, [t]);
  const takeCard = useCallback((): BoardCardFace | null => {
    const state = mine.current;
    if (state.keys.size >= state.cap) {
      setNotice(fullNotice(state.cap));
      return null;
    }
    for (const [key, tier, copies, name] of state.inventory) {
      if (state.tier && (tier ?? "common") !== state.tier) continue;
      if ((state.used.get(key) ?? 0) >= copies) continue;
      // counted here so the next take in the same stroke sees it; onOps
      // records it for real a moment later
      state.used.set(key, (state.used.get(key) ?? 0) + 1);
      state.keys.set(-state.keys.size - 1, key);
      return { key, tier, name };
    }
    setNotice(state.tier ? t`No ${tierLabel(state.tier)} cards left to lay down.` : t`No cards left to lay down.`);
    return null;
  }, [t, fullNotice]);

  /* takeCard's provisional counts are replaced by onOps' real ones. */
  const onOpsFromEngine = useCallback((ops: BoardOp[]) => {
    const state = mine.current;
    for (const [n, key] of [...state.keys]) {
      if (n < 0) {
        state.keys.delete(n);
        state.used.set(key, Math.max(0, (state.used.get(key) ?? 1) - 1));
      }
    }
    onOps(ops);
  }, [onOps]);

  const loadQueue = useRef<number[]>([]);
  const loading = useRef(0);
  const pump = useCallback(() => {
    while (loading.current < 2 && loadQueue.current.length) {
      const ids = loadQueue.current.splice(0, REGION_BATCH);
      loading.current++;
      fetchLivePackBoardRegions(ids)
        .then((read) => {
          const engine = engineRef.current;
          if (!engine) return;
          for (const [owner, , laidSince] of read.owners) engine.noteLaid(owner, laidSince ?? Infinity);
          for (const region of read.regions) {
            const cards: BoardCard[] = [];
            const flat = region.cards;
            for (let i = 0; i + 8 < flat.length; i += 9) {
              const [key, tier, name] = read.faces[flat[i + 3]] ?? ["0", null, ""];
              const [owner, ownerName] = read.owners[flat[i + 1]] ?? [0, ""];
              cards.push(makeCard({ key, tier, name, owner, ownerName, n: flat[i + 2], z: flat[i], x: flat[i + 4], y: flat[i + 5], r: flat[i + 6], s: flat[i + 7], tint: flat[i + 8] }));
            }
            engine.setRegion(region.id, region.version, cards);
          }
        })
        .catch(() => engineRef.current?.forgetRequests(ids))
        .finally(() => {
          loading.current--;
          pump();
        });
    }
  }, []);
  const loadPreviews = useCallback((ids: number[]) => {
    for (let i = 0; i < ids.length; i += 256) {
      const batch = ids.slice(i, i + 256);
      fetchLivePackBoardPreviews(batch)
        .then((previews) => {
          for (const [id, version, cells] of previews) engineRef.current?.setPreview(id, version, cells);
        })
        .catch(() => engineRef.current?.forgetRequests(batch));
    }
  }, []);
  const loadRegions = useCallback((ids: number[]) => {
    loadQueue.current.push(...ids.filter((id) => !loadQueue.current.includes(id)));
    pump();
  }, [pump]);

  const [engine, setEngine] = useState<BoardEngine | null>(null);
  const handlers = useRef({ onOpsFromEngine, takeCard, loadRegions, loadPreviews, redrawMap });
  handlers.current = { onOpsFromEngine, takeCard, loadRegions, loadPreviews, redrawMap };
  const canvasRef = useCallback((canvas: HTMLCanvasElement | null) => {
    if (!canvas) return;
    let engine: BoardEngine | null = null;
    // repaints coalesce: a page of faces landing together is one repaint
    let wakeQueued = false;
    const faces = new BoardFaces(() => {
      if (wakeQueued) return;
      wakeQueued = true;
      requestAnimationFrame(() => {
        wakeQueued = false;
        engine?.repaint();
      });
    });
    const made = new BoardEngine(canvas, {
      me,
      face: (card) => faces.get(card.owner, card.key),
      onView: () => {
        handlers.current.redrawMap();
        if (stackCam.current && engine && stackCam.current !== `${engine.cam.x},${engine.cam.y},${engine.cam.z}`) {
          stackCam.current = null;
          engine.peekCard(null);
          setStack(null);
        }
        // with the pointer off the board, the label follows the view's middle
        if (!pointerOn.current && engine) showCoords(engine.cam.x, engine.cam.y);
      },
      onRefused: (why) => setNotice(why === "full" ? t`This part of the board is full. Try further out.` : why === "share" ? t`You have as many cards in this part of the board as one player can. Try somewhere else.` : why === "protected" ? t`Drawings are protected from other players for their first day.` : t`Slow down a little.`),
      // written straight to the label: this fires on every mouse move
      onPointerAt: (point) => {
        pointerOn.current = point !== null;
        const [x, y] = point ?? [engine?.cam.x ?? 0, engine?.cam.y ?? 0];
        showCoords(x, y);
      },
      canModerate: admin,
      takeCard: () => handlers.current.takeCard(),
      loadRegions: (ids) => handlers.current.loadRegions(ids),
      loadPreviews: (ids) => handlers.current.loadPreviews(ids),
      onFarChange: setFar,
      onOps: (ops) => handlers.current.onOpsFromEngine(ops),
      isPending: (n) => pending.current.has(n),
      onSelect: setSelection,
      onHistory: (undo, redo) => setHistory({ undo, redo }),
      onStack: (cards, x, y) => {
        const box = tip.current?.parentElement?.getBoundingClientRect();
        if (!box || !engine) return;
        const cam = `${engine.cam.x},${engine.cam.y},${engine.cam.z}`;
        stackCam.current = cards.length ? cam : null;
        // how far the pile reaches from the spot on screen, so the list opens
        // beside it rather than over the card being looked at
        const [wx, wy] = engine.toWorld(x, y);
        const reach = Math.max(...cards.map((card) => Math.hypot(card.x - wx, card.y - wy) + 55 * card.sc)) * engine.cam.z;
        setStack(cards.length ? { cards, x: x - box.left, y: y - box.top, reach, w: box.width, h: box.height } : null);
      },
      onHover: (card, x, y) => {
        const node = tip.current;
        if (!node) return;
        if (!card) {
          node.style.display = "none";
          return;
        }
        const box = node.parentElement!.getBoundingClientRect();
        node.style.display = "block";
        node.style.transform = `translate(${x - box.left + 14}px, ${y - box.top + 14}px)`;
        node.firstElementChild!.textContent = card.name || card.key;
        node.lastElementChild!.textContent = card.owner === me ? t`Yours` : card.ownerName ? t`Laid down by ${card.ownerName}` : "";
      },
    });
    engine = made;
    engineRef.current = made;
    setEngine(made);
    return () => {
      made.dispose();
      faces.dispose();
      engineRef.current = null;
      setEngine(null);
    };
    // the engine is made once per viewer
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [me, admin]);

  // the table: the overview, then the viewer's own cards and tray
  useEffect(() => {
    if (!engine) return;
    let live = true;
    const overview = fetchLivePackBoardOverview().then((read) => {
      if (!live) return;
      takeOverview(read);
      engine.setFreshFrom(read.freshFrom);
      engine.setOverview(read.regions.map(([id, , version]) => [id, version]));
    });
    if (me == null) {
      overview.then(() => {
        if (!live) return;
        if (start.current) engine.goTo(start.current.x, start.current.y, start.current.z);
        else engine.fit();
      }).catch(() => {});
    } else {
      Promise.all([overview, fetchLivePackBoardOwner(me)])
        .then(([, owner]) => {
          if (!live) return;
          const state = mine.current;
          state.keys.clear();
          state.used.clear();
          state.regions.clear();
          for (const [n, region, key] of owner.cards) {
            state.keys.set(n, key);
            state.used.set(key, (state.used.get(key) ?? 0) + 1);
            state.regions.set(n, region);
          }
          engine.setNextN(owner.cards.reduce((max, [n]) => Math.max(max, n), 0) + 1);
          // whose fresh drawings this viewer may add to (their osu! friends' lists)
          void fetchPackBoardFriendOf().then((owners) => live && engine.setFriendOf(owners)).catch(() => {});
          setCap(owner.cap);
          setInventory(owner.inventory);
          publishUsage();
          // open on the viewer's own cards when they have some down
          // a shared link opens on its spot, else the viewer's own cards
          if (start.current) engine.goTo(start.current.x, start.current.y, start.current.z);
          else engine.fit(owner.cards.length ? [...new Set(owner.cards.map(([, region]) => region))] : undefined);
        })
        .catch(() => live && setNotice(t`The board could not be loaded.`));
    }
    const refresh = window.setInterval(() => {
      if (document.visibilityState !== "visible") return;
      fetchLivePackBoardOverview()
        .then((read) => {
          takeOverview(read);
          engine.setFreshFrom(read.freshFrom);
          for (const [id, , version] of read.regions) engine.noteVersion(id, version);
        })
        .catch(() => {});
    }, OVERVIEW_REFRESH_MS);
    return () => {
      live = false;
      window.clearInterval(refresh);
    };
  }, [engine, me, publishUsage, t]);

  // other people's edits, as they happen
  useEffect(() => {
    if (!engine) return;
    const source = openLiveEventSource(DEFAULT_COUNTRY_CODE, { observe: true });
    const onChange = (event: MessageEvent) => {
      try {
        const change = JSON.parse(event.data) as { regions?: [number, number][] };
        for (const [id, version] of change.regions ?? []) engine.noteVersion(id, version);
        refreshStats();
      } catch {
        // a malformed frame; the overview refresh catches it up
      }
    };
    source?.addEventListener("pack_board", onChange);
    return () => {
      source?.removeEventListener("pack_board", onChange);
      source?.close();
    };
  }, [engine, refreshStats]);

  useEffect(() => {
    if (!engine) return;
    engine.tool = tool;
    engine.brush.scale = brushScale;
    engine.brush.follow = follow;
    engine.brush.tint = tint;
    engine.brush.grid = grid;
    engine.repaint();
  }, [engine, tool, brushScale, follow, tint, grid]);

  // whatever is still unsent goes out when the page is left
  useEffect(() => {
    const leave = () => void send();
    window.addEventListener("pagehide", leave);
    return () => {
      window.removeEventListener("pagehide", leave);
      leave();
    };
  }, [send]);

  useEffect(() => {
    if (!notice) return;
    const timer = window.setTimeout(() => setNotice(null), 2600);
    return () => window.clearTimeout(timer);
  }, [notice]);

  const remainingByTier = useMemo(() => {
    const totals = new Map<string, number>();
    for (const [key, tier, copies] of inventory ?? []) {
      const name = tier ?? "common";
      totals.set(name, (totals.get(name) ?? 0) + Math.max(0, copies - (used.get(key) ?? 0)));
    }
    return TIER_ORDER.filter((tier) => totals.has(tier)).map((tier) => [tier, totals.get(tier)!] as const);
  }, [inventory, used]);

  const tray = useMemo(() => {
    if (!inventory) return [];
    const needle = query.trim().toLowerCase();
    const rows: InventoryRow[] = [];
    for (const row of inventory) {
      if (trayTier && (row[1] ?? "common") !== trayTier) continue;
      if (needle && !row[3].toLowerCase().includes(needle)) continue;
      if (row[2] - (used.get(row[0]) ?? 0) <= 0) continue;
      rows.push(row);
      if (rows.length >= TRAY_LIMIT) break;
    }
    return rows;
  }, [inventory, query, trayTier, used]);

  const place = (row: InventoryRow, x?: number, y?: number) => {
    // the sheet covers the board: close it so the new card (or why it could
    // not go down) can be seen
    setTrayOpen(false);
    if (!engine) return;
    if (engine.isFar) {
      setNotice(t`Zoom in to lay cards down.`);
      return;
    }
    if (count >= cap) {
      setNotice(fullNotice(cap));
      return;
    }
    engine.addCard({ key: row[0], tier: row[1], name: row[3] }, x, y);
  };

  /* Each press goes to the next place the viewer has cards, the busiest
     first, fitted close enough to see them. Places are regions: fitting all of
     them at once would zoom out to the whole board when they are spread. */
  const nextPlace = useRef(0);
  const goToMine = () => {
    if (!engine) return;
    const counts = new Map<number, number>();
    for (const region of mine.current.regions.values()) counts.set(region, (counts.get(region) ?? 0) + 1);
    const places = [...counts].sort((a, b) => b[1] - a[1]).map(([region]) => region);
    if (places.length === 0) return;
    const region = places[nextPlace.current % places.length];
    nextPlace.current++;
    engine.fit([region]);
    if (places.length > 1) setNotice(t`Your cards: place ${(nextPlace.current - 1) % places.length + 1} of ${places.length}. Press again for the next.`);
  };

  /* A link that opens the board on the middle of the view, at this zoom. */
  const copySpot = async () => {
    if (!engine) return;
    const spot = `${Math.round(engine.cam.x / COORD_UNIT)},${Math.round(engine.cam.y / COORD_UNIT)},${Math.round(engine.cam.z * 100)}`;
    const url = `${window.location.origin}/packs/collections?tab=board&at=${spot}`;
    const ok = await navigator.clipboard?.writeText(url).then(() => true, () => false);
    setNotice(ok ? t`Link copied.` : url);
  };

  const moderate = async (all: boolean) => {
    const selected = selection[0];
    if (!selected) return;
    const ok = await removePackBoardCards({ data: { ownerUserId: selected.owner, n: all ? null : selected.n } }).catch(() => false);
    setNotice(ok ? t`Taken off the board.` : t`That did not go through.`);
  };

  const editing = me != null;
  /* Sends another player's card to the admins, the same way as a bug report:
     the board spot, the card and who laid it. */
  const report = async (card: BoardCard) => {
    const id = `${card.owner}:${card.n}`;
    if (reported.has(id)) return;
    setReported((was) => new Set(was).add(id));
    const at = `${Math.round(card.x / COORD_UNIT)},${Math.round(card.y / COORD_UNIT)},120`;
    const result = await submitBugReport({
      data: {
        kind: "bug",
        body: `Board report: "${card.name || card.key}" laid down by ${card.ownerName || "?"} (osu! id ${card.owner}), card ${card.n}, at ${at}.`,
        pagePath: `/packs/collections?tab=board&at=${at}`,
        context: { boardOwner: card.owner, boardCard: card.n, boardKey: card.key, boardX: card.x, boardY: card.y },
      },
    }).catch(() => ({ ok: false as const }));
    if (result.ok) {
      setNotice(t`Reported. An admin will take a look.`);
    } else {
      setReported((was) => {
        const next = new Set(was);
        next.delete(id);
        return next;
      });
      setNotice(t`The report could not be sent. Try again in a bit.`);
    }
  };

  // full screen: the page under it holds still, and Escape leaves
  useEffect(() => {
    if (!full) return;
    const root = document.documentElement;
    const was = root.style.overflow;
    root.style.overflow = "hidden";
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape") setFull(false);
    };
    window.addEventListener("keydown", key);
    return () => {
      root.style.overflow = was;
      window.removeEventListener("keydown", key);
    };
  }, [full]);

  // the select tool is only offered on touch
  useEffect(() => {
    if (!touch && tool === "select") setTool("move");
  }, [touch, tool]);

  const ownSelection = selection.filter((card) => card.owner === me);
  const otherSelected = selection.length === 1 && selection[0].owner !== me ? selection[0] : null;

  /* What the current tool or selection offers, or how to use the board. */
  const context = !editing ? (
    <span className="whitespace-normal text-xs leading-snug text-osu-f1 max-md:w-full">
      <Trans>
        <a href="/api/auth/osu" className="font-semibold text-osu-pink-light hover:text-white">Log in with osu!</a> to lay your own cards down.
      </Trans>
    </span>
  ) : tool === "brush" ? (
    <>
      <div className="flex items-center gap-1">
        <TierChip active={brushTier === null} onClick={() => setBrushTier(null)} title={t`Any card`}>
          <span className="px-1 text-[11px] font-semibold">{t`Any`}</span>
        </TierChip>
        {remainingByTier.map(([tier, left]) => (
          <TierChip key={tier} active={brushTier === tier} onClick={() => setBrushTier(tier)} title={`${tierLabel(tier)}: ${formatNumber(left)}`}>
            <span className="h-4 w-3 rounded-[3px] border border-white/30" style={{ background: swatch(tier) }} />
            <span className="text-[11px] tabular-nums text-osu-f1">{formatNumber(left)}</span>
          </TierChip>
        ))}
      </div>
      <label className="flex items-center gap-2 text-xs text-osu-f1">
        <Trans>Size</Trans>
        <input type="range" min={0.3} max={2} step={0.05} value={brushScale} onChange={(e) => setBrushScale(Number(e.target.value))} className="w-24 accent-osu-h1" />
      </label>
      <label className="flex items-center gap-1.5 text-xs text-osu-f1">
        <input type="checkbox" checked={follow} onChange={(e) => setFollow(e.target.checked)} className="accent-osu-h1" />
        <Trans>Turn with the stroke</Trans>
      </label>
    </>
  ) : ownSelection.length ? (
    <div className="flex items-center gap-1">
      <IconButton label={t`Turn left`} onClick={() => engine?.nudgeSelected(-8, 0)}><RotateCcw size={15} /></IconButton>
      <IconButton label={t`Turn right`} onClick={() => engine?.nudgeSelected(8, 0)}><RotateCw size={15} /></IconButton>
      <label className="flex items-center gap-2 px-1 text-xs text-osu-f1" title={t`Size`}>
        <Minus size={13} aria-hidden />
        <input
          type="range"
          min={-2}
          max={2}
          step={0.01}
          value={scaleStep}
          aria-label={t`Size`}
          onPointerDown={() => engine?.beginScale()}
          onKeyDown={() => engine?.beginScale()}
          onChange={(e) => {
            const step = Number(e.target.value);
            engine?.beginScale();
            engine?.previewScale(2 ** step);
            setScaleStep(step);
          }}
          onPointerUp={() => {
            engine?.endScale();
            setScaleStep(0);
          }}
          onKeyUp={() => {
            engine?.endScale();
            setScaleStep(0);
          }}
          onBlur={() => {
            engine?.endScale();
            setScaleStep(0);
          }}
          className="w-24 accent-osu-h1 md:w-28"
        />
        <Plus size={13} aria-hidden />
        <span className="w-9 tabular-nums">×{(2 ** scaleStep).toFixed(2)}</span>
      </label>
      <IconButton label={ownSelection.length > 1 ? t`Pick them back up` : t`Pick it back up`} onClick={() => engine?.removeSelected()}><Trash2 size={15} /></IconButton>
      <span className="ml-1 max-w-40 truncate text-xs text-osu-f1">
        {ownSelection.length > 1 ? <Plural value={ownSelection.length} one="# card selected" other="# cards selected" /> : ownSelection[0].name}
      </span>
    </div>
  ) : otherSelected && admin ? (
    <div className="flex items-center gap-2 text-xs">
      <span className="max-w-48 truncate text-osu-f1">{otherSelected.ownerName}</span>
      <button type="button" onClick={() => void moderate(false)} className="rounded-md bg-red-500/15 px-2 py-1 font-semibold text-red-200 hover:bg-red-500/25">{t`Take this card off`}</button>
      <button type="button" onClick={() => void moderate(true)} className="rounded-md bg-red-500/15 px-2 py-1 font-semibold text-red-200 hover:bg-red-500/25">{t`Take all their cards off`}</button>
    </div>
  ) : (
    <span className="line-clamp-2 whitespace-normal text-xs leading-snug text-osu-f1 max-md:w-full">
      {tool === "select"
        ? t`Drag a box round your cards or tap them one by one, then drag one to move them all.`
        : touch && sheetTray
          ? t`Tap Cards to lay one down, tap one of yours to edit it, and hold a pile to see every card in it.`
          : touch
            ? t`Tap a card in the tray to lay it down, tap one of yours to edit it, and hold a pile to see every card in it.`
            : t`Drag cards out of the tray. Drag across the board to select your cards, right-drag to move around. Alt-click a pile to see every card in it.`}
    </span>
  );

  const viewButtons = (
    <>
      {editing ? <IconButton float={narrow} label={t`Go to your cards`} disabled={count === 0} onClick={goToMine}><LocateFixed size={15} /></IconButton> : null}
      <IconButton float={narrow} label={t`See the whole board`} onClick={() => engine?.fit()}><ZoomOut size={15} /></IconButton>
      <IconButton float={narrow} label={t`Copy a link to this spot`} onClick={() => void copySpot()}><Link2 size={15} /></IconButton>
      <IconButton float={narrow} label={full ? t`Leave full screen` : t`Full screen`} onClick={() => setFull((on) => !on)}>{full ? <Shrink size={15} /> : <Expand size={15} />}</IconButton>
    </>
  );

  const trayList = (
    <>
      <div className="space-y-2 p-2">
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={t`Find a player`}
          className="w-full rounded-lg border border-osu-b3/30 bg-black/20 px-2.5 py-1.5 text-sm text-white placeholder:text-osu-f1/60 focus:border-osu-h1/60 focus:outline-none max-lg:py-2 max-lg:text-base"
        />
        <div className="scrollbar-hide flex gap-1 max-lg:overflow-x-auto lg:flex-wrap [&>*]:shrink-0">
          <TierChip active={trayTier === null} onClick={() => setTrayTier(null)} title={t`Every tier`}>
            <span className="px-1 text-[11px] font-semibold">{t`All`}</span>
          </TierChip>
          {remainingByTier.map(([tier]) => (
            <TierChip key={tier} active={trayTier === tier} onClick={() => setTrayTier(tier)} title={tierLabel(tier)}>
              <span className="h-4 w-3 rounded-[3px] border border-white/30" style={{ background: swatch(tier) }} />
            </TierChip>
          ))}
        </div>
      </div>
      <ul className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-1 pb-2">
        {tray.map((row) => (
          <li key={row[0]}>
            <button
              type="button"
              draggable={!touch}
              onDragStart={(e) => e.dataTransfer.setData("text/x-board-card", row[0])}
              onClick={() => place(row)}
              className="flex w-full items-center gap-2 rounded-md px-2 py-1 text-left text-sm text-white hover:bg-white/[0.06] max-lg:py-2"
            >
              <span className="h-5 w-3.5 shrink-0 rounded-[3px] border border-white/30" style={{ background: swatch(row[1]) }} />
              <span className="min-w-0 flex-1 truncate">{row[3] || row[0]}</span>
              <span className="text-[11px] tabular-nums text-osu-f1">×{row[2] - (used.get(row[0]) ?? 0)}</span>
            </button>
          </li>
        ))}
        {inventory === null ? (
          <li className="px-2 py-3 text-xs text-osu-f1"><Trans>Loading your cards</Trans></li>
        ) : tray.length === 0 ? (
          <li className="px-2 py-3 text-xs text-osu-f1"><Trans>No cards left here.</Trans></li>
        ) : null}
      </ul>
    </>
  );

  return (
    <div
      className={full
        ? "fixed inset-x-0 top-0 z-[100] flex h-[100dvh] flex-col overflow-hidden bg-osu-b5 pt-[env(safe-area-inset-top)]"
        : "overflow-hidden rounded-xl border border-osu-b3/20 bg-white/[0.03] max-md:-mx-1"}
    >
      {/* One row that never wraps, so switching tools never moves the board
          under the pointer: the tool's own controls scroll sideways when they
          run long, and the view buttons stay pinned at the right. On a phone
          the tool's controls get a second row of their own, also fixed in
          height, and the view buttons move onto the board. */}
      <div className="flex h-11 shrink-0 items-center border-b border-osu-b3/20">
        <div className="scrollbar-hide flex min-w-0 flex-1 items-center gap-2 overflow-x-auto whitespace-nowrap px-3 max-md:px-2 [&>*]:shrink-0">
          {editing ? (
            <div className="flex rounded-lg bg-black/20 p-0.5">
              <ToolButton compact={narrow} active={tool === "move"} onClick={() => setTool("move")} label={t`Move`}><Hand size={15} /></ToolButton>
              {touch ? <ToolButton compact={narrow} active={tool === "select"} onClick={() => setTool("select")} label={t`Select`}><SquareDashedMousePointer size={15} /></ToolButton> : null}
              <ToolButton compact={narrow} active={tool === "brush"} onClick={() => setTool("brush")} label={t`Brush`}><Brush size={15} /></ToolButton>
            </div>
          ) : null}
          {editing ? (
            <div className="flex rounded-lg bg-black/20 p-0.5">
              <ToolButton compact active={grid} onClick={() => setGrid((on) => !on)} label={t`Snap to grid`}><Grid3x3 size={15} /></ToolButton>
            </div>
          ) : null}
          {editing ? (
            <button
              type="button"
              onClick={() => setPicking((open) => !open)}
              aria-expanded={picking}
              aria-label={t`Colour`}
              title={t`Colour`}
              className={`flex h-7 items-center gap-1.5 rounded-md px-2 text-xs font-semibold transition-colors max-md:h-8 ${picking ? "bg-white/15 text-white" : "bg-black/20 text-osu-f1 hover:text-white"}`}
            >
              <span
                className="h-4 w-4 rounded-full border border-white/40"
                style={{ background: tint ? TINTS[tint - 1] : "conic-gradient(#0ea5e9, #7c3aed, #ff3d8a, #fbbf24, #22c55e, #0ea5e9)" }}
              />
              {narrow ? null : t`Colour`}
            </button>
          ) : null}
          {narrow ? null : context}
        </div>
        <div className="flex shrink-0 items-center gap-1 border-l border-osu-b3/20 px-3 max-md:px-2">
          {editing ? (
            <>
              <IconButton label={t`Undo`} disabled={!history.undo} onClick={() => engine?.undo()}><Undo2 size={15} /></IconButton>
              <IconButton label={t`Redo`} disabled={!history.redo} onClick={() => engine?.redo()}><Redo2 size={15} /></IconButton>
            </>
          ) : null}
          {narrow ? null : viewButtons}
        </div>
      </div>
      {narrow ? (
        <div className="scrollbar-hide flex h-11 shrink-0 items-center gap-2 overflow-x-auto whitespace-nowrap border-b border-osu-b3/20 px-2 [&>*]:shrink-0">
          {context}
        </div>
      ) : null}
      <div className={`flex ${full ? "min-h-0 flex-1" : ""} flex-col lg:flex-row`}>
        <div
          className={`relative flex-1 bg-black/25 ${full ? "min-h-0" : "h-[66vh] min-h-[380px] max-md:h-[calc(100dvh-10rem)] max-md:min-h-[420px]"}`}
          onDragOver={(e) => e.preventDefault()}
          onDrop={(e) => {
            e.preventDefault();
            const key = e.dataTransfer.getData("text/x-board-card");
            const row = inventory?.find((item) => item[0] === key);
            if (row) place(row, e.clientX, e.clientY);
          }}
        >
          <canvas ref={canvasRef} tabIndex={0} className="absolute inset-0 h-full w-full touch-none outline-none" aria-label={t`Card board`} />
          <BoardMinimap ref={minimap} engine={engine} regions={getMapRegions} mine={getMineRegions} className={narrow ? "bottom-3 right-2" : "bottom-7 right-3"} />
          {narrow ? <div className="absolute right-2 top-2 z-10 flex flex-col gap-1.5">{viewButtons}</div> : null}
          {editing && picking ? (
            <TintPalette
              value={tint}
              onPick={(next) => {
                setTint(next);
                // with cards selected, the colour goes on them too
                engine?.tintSelected(next);
              }}
              onClose={() => setPicking(false)}
            />
          ) : null}
          {stack ? (
            <StackList
              stack={stack}
              me={me}
              reported={reported}
              onReport={(card) => void report(card)}
              onPeek={(card) => engine?.peekCard(card)}
              onPick={(card) => {
                engine?.peekCard(null);
                engine?.pickCard(card);
                stackCam.current = null;
                setStack(null);
              }}
              onClose={() => {
                engine?.peekCard(null);
                stackCam.current = null;
                setStack(null);
              }}
            />
          ) : null}
          <div ref={tip} className="pointer-events-none absolute left-0 top-0 hidden rounded-md bg-black/85 px-2 py-1 text-xs text-white">
            <div className="font-semibold" />
            <div className="text-[11px] text-osu-f1" />
          </div>
          <span
            ref={coords}
            aria-label={t`Coordinates`}
            className="pointer-events-none absolute left-1/2 top-2 -translate-x-1/2 rounded-md bg-black/50 px-2 py-0.5 text-[11px] font-semibold tabular-nums text-white/85"
          >
            0, 0
          </span>
          {editing && sheetTray ? (
            <div className="absolute bottom-3 left-2 z-10 flex flex-col items-start gap-1.5">
              <span className="pointer-events-none flex items-center gap-2 rounded-md bg-black/50 px-2 py-0.5 text-[11px] tabular-nums text-white/85">
                {formatNumber(count)} / {formatNumber(cap)}
                <span className="h-3 w-px bg-white/20" />
                {saveState === "saved" ? t`Saved` : saveState === "retrying" ? t`Retrying` : t`Saving`}
              </span>
              <button
                type="button"
                onClick={() => setTrayOpen(true)}
                className="flex h-10 items-center gap-2 rounded-full bg-osu-h1 px-4 text-sm font-semibold text-white shadow-lg shadow-black/40 active:scale-95"
              >
                <Layers size={16} aria-hidden />
                {t`Cards`}
              </button>
            </div>
          ) : (
            <div className="pointer-events-none absolute inset-x-3 bottom-2 flex flex-wrap items-center justify-between gap-x-3 text-[11px] tabular-nums text-osu-f1/80">
              <span>
                {stats ? (
                  <>
                    <Trans>{formatNumber(stats.total)} cards</Trans>{" "}
                    <Plural value={stats.owners} one="from # collector" other="from # collectors" />
                  </>
                ) : null}
              </span>
              {editing ? (
                <span className="flex items-center gap-2">
                  <Trans>{formatNumber(count)} of {formatNumber(cap)} yours</Trans>
                  <span className="h-3 w-px bg-white/15" />
                  {saveState === "saved" ? t`Saved` : saveState === "retrying" ? t`Retrying` : t`Saving`}
                </span>
              ) : null}
            </div>
          )}
          {far && editing && !notice ? (
            <div className="pointer-events-none absolute left-1/2 top-9 max-w-[70%] -translate-x-1/2 rounded-lg bg-black/70 px-3 py-1.5 text-center text-xs text-white">{t`Zoom in to lay cards down.`}</div>
          ) : null}
          {notice ? (
            <div className={`pointer-events-none absolute left-1/2 z-20 max-w-[80%] -translate-x-1/2 rounded-lg bg-black/80 px-3 py-1.5 text-center text-xs text-white ${sheetTray ? "top-9" : "bottom-3"}`}>{notice}</div>
          ) : null}
          {editing && sheetTray && trayOpen ? (
            <>
              <button type="button" aria-label={t`Close`} onClick={() => setTrayOpen(false)} className="absolute inset-0 z-20 cursor-default bg-black/30" />
              <div className="absolute inset-x-0 bottom-0 z-30 flex h-[62%] flex-col rounded-t-2xl border-t border-white/15 bg-osu-b5/95 shadow-2xl backdrop-blur">
                <div className="flex shrink-0 items-center justify-between px-3 pt-2.5">
                  <span className="text-sm font-semibold text-white">
                    {t`Your cards`}
                    <span className="ml-2 text-xs font-normal tabular-nums text-osu-f1">
                      <Trans>{formatNumber(count)} of {formatNumber(cap)} laid down</Trans>
                    </span>
                  </span>
                  <button type="button" onClick={() => setTrayOpen(false)} aria-label={t`Close`} className="flex h-8 w-8 items-center justify-center rounded-full text-osu-f1 hover:bg-white/10 hover:text-white">
                    <X size={18} />
                  </button>
                </div>
                {trayList}
              </div>
            </>
          ) : null}
        </div>
        {editing && !sheetTray ? (
          <div className={`flex min-h-0 w-64 flex-col border-l border-osu-b3/20 ${full ? "" : "max-h-[66vh]"}`}>
            {trayList}
          </div>
        ) : null}
      </div>
    </div>
  );
}

/* ---------- bits ---------- */

/* The colours cards can be laid down in, over the canvas's top-left corner
   (the toolbar scrolls sideways, so a popover inside it would be cut off).
   The first swatch is the card's own tier colour. */
function TintPalette({ value, onPick, onClose }: { value: number; onPick: (tint: number) => void; onClose: () => void }) {
  const { t } = useLingui();
  return (
    <div className="absolute left-2 top-2 z-10 w-56 rounded-xl border border-osu-b3/30 bg-osu-b5/95 p-2 shadow-xl backdrop-blur">
      <div className="mb-1.5 flex items-center justify-between px-0.5 text-[11px] text-osu-f1">
        <span>{value ? t`Cards are laid down in this colour` : t`Cards keep their tier colour`}</span>
        <button type="button" onClick={onClose} className="rounded px-1 text-osu-f1 hover:text-white" aria-label={t`Close`}>×</button>
      </div>
      <div className="grid grid-cols-8 gap-1">
        <button
          type="button"
          title={t`Tier colour`}
          aria-label={t`Tier colour`}
          aria-pressed={value === 0}
          onClick={() => onPick(0)}
          className={`aspect-square rounded-md border ${value === 0 ? "border-white ring-1 ring-white" : "border-white/25"}`}
          style={{ background: `linear-gradient(135deg, ${cardPaint({ tier: "rare", tint: 0 }).mid} 50%, ${cardPaint({ tier: "legendary", tint: 0 }).mid} 50%)` }}
        />
        {TINTS.map((hex, i) => (
          <button
            key={hex}
            type="button"
            title={hex}
            aria-label={hex}
            aria-pressed={value === i + 1}
            onClick={() => onPick(i + 1)}
            className={`aspect-square rounded-md border ${value === i + 1 ? "border-white ring-1 ring-white" : "border-white/15"}`}
            style={{ background: hex }}
          />
        ))}
      </div>
    </div>
  );
}

/* `float` is the round, finger-sized look the view buttons take over the
   board on a phone. */
function IconButton({ label, onClick, disabled, float, children }: { label: string; onClick: () => void; disabled?: boolean; float?: boolean; children: ReactNode }) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      disabled={disabled}
      onClick={onClick}
      className={float
        ? "flex h-9 w-9 items-center justify-center rounded-full bg-black/60 text-white/90 shadow-md shadow-black/30 backdrop-blur transition-colors active:bg-white/20 disabled:opacity-40"
        : "flex h-7 w-7 items-center justify-center rounded-md bg-black/30 text-osu-f1 transition-colors hover:bg-white/10 hover:text-white disabled:opacity-35 disabled:hover:bg-black/30 max-md:h-8 max-md:w-8"}
    >
      {children}
    </button>
  );
}

/* `compact` shows the icon alone, with the label kept for screen readers and
   as a tooltip. */
function ToolButton({ active, label, onClick, compact, children }: { active: boolean; label: string; onClick: () => void; compact?: boolean; children: ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      aria-label={compact ? label : undefined}
      title={compact ? label : undefined}
      className={`flex items-center gap-1.5 rounded-md text-xs font-semibold transition-colors ${compact ? "h-7 px-2 max-md:h-8 max-md:px-2.5" : "px-2.5 py-1"} ${active ? "bg-osu-h1/25 text-white" : "text-osu-f1 hover:text-white"}`}
    >
      {children}
      {compact ? null : label}
    </button>
  );
}

function TierChip({ active, onClick, title, children }: { active: boolean; onClick: () => void; title: string; children: ReactNode }) {
  return (
    <button
      type="button"
      title={title}
      aria-label={title}
      aria-pressed={active}
      onClick={onClick}
      className={`flex h-7 items-center gap-1 rounded-md px-1.5 transition-colors ${active ? "bg-white/15 ring-1 ring-white/40" : "bg-black/20 hover:bg-white/10"}`}
    >
      {children}
    </button>
  );
}

const STACK_ROW = 34;

/* The cards under one spot, top first, with who laid each. Hovering a row
   lifts that card above the pile on the board; clicking picks it. */
function StackList({
  stack,
  me,
  reported,
  onReport,
  onPeek,
  onPick,
  onClose,
}: {
  stack: { cards: BoardCard[]; x: number; y: number; reach: number; w: number; h: number };
  me: number | null;
  reported: ReadonlySet<string>;
  onReport: (card: BoardCard) => void;
  onPeek: (card: BoardCard | null) => void;
  onPick: (card: BoardCard) => void;
  onClose: () => void;
}) {
  const { t } = useLingui();
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const down = (e: PointerEvent) => {
      if (!ref.current?.contains(e.target as Node)) onClose();
    };
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("pointerdown", down, true);
    window.addEventListener("keydown", key);
    return () => {
      window.removeEventListener("pointerdown", down, true);
      window.removeEventListener("keydown", key);
    };
  }, [onClose]);
  const width = 240;
  // on a narrow board there is no room beside the pile: the list is a sheet
  // along the bottom, with taller rows for a finger
  const sheet = stack.w < 520;
  const row = sheet ? 44 : STACK_ROW;
  const height = Math.min(stack.h - 16, sheet ? stack.h * 0.55 : 340, 34 + stack.cards.length * row);
  // right of the pile, or left of it when there is no room
  const gap = Math.min(stack.reach, 260) + 10;
  const right = stack.x + gap;
  const left = right + width <= stack.w - 8 ? right : Math.max(8, stack.x - gap - width);
  const top = Math.max(8, Math.min(stack.y - height / 2, stack.h - height - 8));
  const count = stack.cards.length;
  return (
    <div
      ref={ref}
      className="absolute z-20 flex flex-col overflow-hidden rounded-lg border border-white/15 bg-[#121116]/95 shadow-xl backdrop-blur"
      style={sheet ? { left: 8, right: 8, bottom: 8, maxHeight: height } : { left, top, width, maxHeight: height }}
      onMouseLeave={() => onPeek(null)}
    >
      <div className="flex shrink-0 items-center justify-between px-3 pb-1 pt-2 text-[11px] font-semibold uppercase tracking-wide text-osu-f1">
        <Plural value={count} one="# card here" other="# cards here" />
        <button type="button" onClick={onClose} className={`rounded leading-none text-osu-f1 hover:text-white ${sheet ? "-my-1 px-2 py-1 text-lg" : "px-1 text-sm"}`} aria-label={t`Close`}>×</button>
      </div>
      <div className="scroll-slim overscroll-contain min-h-0 overflow-y-auto px-1 pb-1">
        {stack.cards.map((card) => {
          const paint = cardPaint(card);
          const id = `${card.owner}:${card.n}`;
          // anyone signed in can send someone else's card to the admins
          const reportable = me != null && card.owner !== me;
          return (
            <div key={id} className="group flex items-center rounded-md hover:bg-white/[0.07]" onMouseEnter={() => onPeek(card)} style={{ height: row }}>
              <button
                type="button"
                onFocus={() => onPeek(card)}
                onClick={() => onPick(card)}
                className="flex h-full min-w-0 flex-1 items-center gap-2.5 rounded-md px-2 text-left focus-visible:bg-white/[0.07] focus-visible:outline-none"
              >
                <span className="h-5 w-3.5 shrink-0 rounded-[3px] border border-white/30" style={{ background: `linear-gradient(150deg, ${paint.light}, ${paint.mid} 55%, ${paint.dark})` }} />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-xs font-semibold text-white">{card.name || card.key}</span>
                  <span className="block truncate text-[11px] text-osu-f1">{card.owner === me ? t`Yours` : card.ownerName}</span>
                </span>
              </button>
              {reportable ? (
                reported.has(id) ? (
                  <span className="shrink-0 px-2 text-[11px] text-osu-f1">{t`Reported`}</span>
                ) : (
                  <button
                    type="button"
                    onClick={() => onReport(card)}
                    onFocus={() => onPeek(card)}
                    title={t`Report this card to the admins`}
                    aria-label={t`Report this card to the admins`}
                    className="mr-1 flex h-6 shrink-0 items-center gap-1 rounded px-1.5 text-[11px] text-osu-f1 opacity-60 transition-opacity hover:bg-white/10 hover:text-white focus-visible:opacity-100 group-hover:opacity-100"
                  >
                    <Flag size={12} aria-hidden />
                    {t`Report`}
                  </button>
                )
              ) : null}
            </div>
          );
        })}
      </div>
    </div>
  );
}
