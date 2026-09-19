import { createFileRoute, notFound } from "@tanstack/react-router";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AnimatePresence, motion, Reorder } from "framer-motion";
import {
  AlertTriangle,
  AlignLeft,
  Bug,
  Check,
  ChevronDown,
  Columns3,
  GripVertical,
  Lightbulb,
  ListChecks,
  ListOrdered,
  Loader2,
  Pause,
  Pencil,
  Play,
  Plus,
  RotateCcw,
  Search,
  Sparkles,
  Tag,
  Trash2,
  Wrench,
  X,
} from "lucide-react";
import { canUseAdminFeatures } from "../../lib/auth-shared";
import { SelectMenu, type SelectMenuOption } from "../../components/ui/SelectMenu";
import {
  assignAdminTodosToGroup,
  clearDoneAdminTodos,
  createAdminTodo,
  deleteAdminTodo,
  deleteAdminTodoGroup,
  listAdminTodos,
  saveAdminTodoGroup,
  updateAdminTodo,
  type AdminTodo,
  type AdminTodoGroup,
  type TodoCategory,
  type TodoGroupColor,
  type TodoPriority,
  type TodoStatus,
} from "../../lib/admin-todos";
import {
  playTodoDropTick,
  playTodoHit,
  playTodoMiss,
  playTodoPlace,
  playTodoReturn,
  preloadTodoSfx,
} from "../../lib/todo-sfx";

export const Route = createFileRoute("/admin/todos")({
  head: () => ({
    meta: [
      { title: "Todos - admin" },
      { name: "robots", content: "noindex, nofollow" },
    ],
  }),
  beforeLoad: ({ context }) => {
    if (!canUseAdminFeatures(context.auth)) {
      throw notFound();
    }
    return undefined as never;
  },
  component: TodosPage,
});

// ---------------------------------------------------------------------------
// Static metadata / helpers
// ---------------------------------------------------------------------------

// Each category is a lane on the playfield, like columns in 5K mania. `edge` is the note's
// top-edge accent (mania note colors); `edgeLeft` is the same accent turned side-on for the queue's
// rows. Both are spelled out in full because Tailwind only emits classes it can see literally in
// the source - deriving one from the other at runtime yields a class that was never generated.
// `text` colors the lane header and small icons.
const CATEGORY_META: Record<TodoCategory, { label: string; Icon: typeof Bug; text: string; edge: string; edgeLeft: string }> = {
  task: { label: "Task", Icon: ListChecks, text: "text-osu-l2", edge: "border-t-osu-l2/70", edgeLeft: "border-l-osu-l2/70" },
  bug: { label: "Bug", Icon: Bug, text: "text-osu-red-light", edge: "border-t-osu-red-light/80", edgeLeft: "border-l-osu-red-light/80" },
  feature: { label: "Feature", Icon: Sparkles, text: "text-osu-blue", edge: "border-t-osu-blue/80", edgeLeft: "border-l-osu-blue/80" },
  idea: { label: "Idea", Icon: Lightbulb, text: "text-osu-yellow", edge: "border-t-osu-yellow/80", edgeLeft: "border-l-osu-yellow/80" },
  chore: { label: "Chore", Icon: Wrench, text: "text-osu-purple", edge: "border-t-osu-purple/80", edgeLeft: "border-l-osu-purple/80" },
};
const CATEGORY_ORDER: TodoCategory[] = ["task", "bug", "feature", "idea", "chore"];
const CATEGORY_OPTIONS: SelectMenuOption<TodoCategory>[] = CATEGORY_ORDER.map((key) => ({
  value: key,
  label: CATEGORY_META[key].label,
  icon: CATEGORY_META[key].Icon,
  colorClass: CATEGORY_META[key].text,
}));

// Groups are the owner's own buckets ("LN work", "before the release") laid over the fixed
// categories: a task belongs to at most one, and the colour is what makes it readable at a glance.
// Spelled out in full for the same reason the lane accents are - Tailwind only emits classes it can
// see literally in the source.
const GROUP_COLOR_META: Record<TodoGroupColor, { label: string; dot: string; text: string; chip: string }> = {
  pink: { label: "Pink", dot: "bg-osu-pink", text: "text-osu-pink", chip: "border-osu-pink/50 bg-osu-pink/10 text-osu-pink" },
  blue: { label: "Blue", dot: "bg-osu-blue", text: "text-osu-blue", chip: "border-osu-blue/50 bg-osu-blue/10 text-osu-blue" },
  green: { label: "Green", dot: "bg-osu-green-light", text: "text-osu-green-light", chip: "border-osu-green-light/50 bg-osu-green-light/10 text-osu-green-light" },
  yellow: { label: "Yellow", dot: "bg-osu-yellow", text: "text-osu-yellow", chip: "border-osu-yellow/50 bg-osu-yellow/10 text-osu-yellow" },
  purple: { label: "Purple", dot: "bg-osu-purple-light", text: "text-osu-purple-light", chip: "border-osu-purple-light/50 bg-osu-purple-light/10 text-osu-purple-light" },
  red: { label: "Red", dot: "bg-osu-red-light", text: "text-osu-red-light", chip: "border-osu-red-light/50 bg-osu-red-light/10 text-osu-red-light" },
  orange: { label: "Orange", dot: "bg-osu-orange", text: "text-osu-orange", chip: "border-osu-orange/50 bg-osu-orange/10 text-osu-orange" },
};
const GROUP_COLOR_ORDER: TodoGroupColor[] = ["pink", "blue", "green", "yellow", "purple", "red", "orange"];

// The group picker is the category picker's twin, with "No group" as the empty value. The
// selection bar adds one more entry, which names a new group instead of picking an existing one.
const NO_GROUP = "";
const NEW_GROUP = "\u0000new";

/** First unused colour, so a board of groups reads as different colours without picking each one. */
export function nextGroupColor(used: readonly TodoGroupColor[]): TodoGroupColor {
  return GROUP_COLOR_ORDER.find((color) => !used.includes(color)) ?? GROUP_COLOR_ORDER[used.length % GROUP_COLOR_ORDER.length];
}

function groupOptions(groups: AdminTodoGroup[]): SelectMenuOption<string>[] {
  return [
    { value: NO_GROUP, label: "No group", icon: Tag },
    ...groups.map((group) => ({
      value: group.id,
      label: group.name,
      icon: Tag,
      colorClass: GROUP_COLOR_META[group.color].text,
    })),
  ];
}

const PRIORITY_META: Record<TodoPriority, { label: string; dot: string }> = {
  high: { label: "High", dot: "bg-osu-red-light" },
  normal: { label: "Normal", dot: "bg-osu-c2" },
  low: { label: "Low", dot: "bg-osu-f1/50" },
};
const PRIORITY_ORDER: TodoPriority[] = ["low", "normal", "high"];

// Matches the backend spacing so a drag can drop an item at the midpoint of its two new neighbours.
const POSITION_STEP = 1000;

// Two ways to look at the same open todos: the category playfield, or one flat do-next queue.
// `position` is global rather than per-lane, so the queue is just the same key read end to end.
type BoardView = "lanes" | "queue";
const BOARD_VIEW_KEY = "mania-hub-todos-view";

// Below this the five-lane playfield is a sideways scroll with no room to drag, so a phone opens
// in the single-column queue instead. Only ever a default: an explicit choice always wins.
const LANES_MIN_WIDTH = 680;

function readBoardViewPreference(): BoardView {
  if (typeof window === "undefined") return "lanes";
  try {
    const stored = window.localStorage.getItem(BOARD_VIEW_KEY);
    if (stored === "queue" || stored === "lanes") return stored;
  } catch {
    // No stored preference to honour; fall through to the viewport default.
  }
  return window.innerWidth < LANES_MIN_WIDTH ? "queue" : "lanes";
}

function writeBoardViewPreference(view: BoardView): void {
  try {
    window.localStorage.setItem(BOARD_VIEW_KEY, view);
  } catch {
    // Preference only; the board works either way.
  }
}

// A note dropped this far above/below a lane still counts as aimed at it, so a slightly wild throw
// lands instead of snapping back.
const LANE_DROP_Y_SLACK = 48;

type LaneElements = Partial<Record<TodoCategory, HTMLDivElement | null>>;

/** One note of a dragged selection and where it landed; `category` only when the lane changed. */
type BlockMove = { id: string; position: number; category?: TodoCategory };

/** The note under the pointer and the size of the selection it is carrying, while a drag is on. */
type BlockDrag = { leader: string; count: number } | null;

/** Which lane the pointer was over when the drag ended, or null if it was off the playfield. */
export function findLaneAtPoint(lanes: LaneElements, x: number, y: number): TodoCategory | null {
  for (const key of CATEGORY_ORDER) {
    const el = lanes[key];
    if (!el) continue;
    const rect = el.getBoundingClientRect();
    if (x < rect.left || x > rect.right) continue;
    if (y < rect.top - LANE_DROP_Y_SLACK || y > rect.bottom + LANE_DROP_Y_SLACK) return null;
    return key;
  }
  return null;
}

function nearestAbove(occupied: number[], bound: number): number | null {
  let best: number | null = null;
  for (const value of occupied) {
    if (value > bound && (best === null || value < best)) best = value;
  }
  return best;
}

function nearestBelow(occupied: number[], bound: number): number | null {
  let best: number | null = null;
  for (const value of occupied) {
    if (value < bound && (best === null || value > best)) best = value;
  }
  return best;
}

/** Midpoint, or null when the two are so close that floats can't fit a value between them. */
function midpoint(a: number, b: number): number | null {
  const mid = (a + b) / 2;
  return mid === a || mid === b ? null : mid;
}

/**
 * A free position strictly between `lo` and `hi` (null on either side = unbounded).
 *
 * `position` is one global key, but a lane only ever shows its own notes, so the plain midpoint of
 * two lane neighbours can land exactly on a todo sitting in a *different* lane - and new todos are
 * created on an exact 1000 grid, which makes that likely rather than rare. A tie is ambiguous
 * (both sortTodos implementations fall back to createdAt), and re-dropping into it is then a no-op,
 * so the slot becomes unreachable. Anchoring on the nearest globally occupied position instead of
 * the far bound keeps every result collision-free by construction.
 */
export function positionBetween(occupied: number[], lo: number | null, hi: number | null): number | null {
  if (lo === null && hi === null) return null;
  if (lo === null) {
    const nearest = nearestBelow(occupied, hi!);
    return nearest === null ? hi! - POSITION_STEP : midpoint(nearest, hi!);
  }
  if (hi === null) {
    const nearest = nearestAbove(occupied, lo);
    return nearest === null ? lo + POSITION_STEP : midpoint(lo, nearest);
  }
  const nearest = nearestAbove(occupied, lo);
  return midpoint(lo, nearest === null ? hi : Math.min(nearest, hi));
}

/**
 * Position for the note now sitting at `index` of a lane's visual order. Lanes render reversed
 * (largest position on top, next-up at the bottom touching the judgement line), so the neighbour
 * above holds the *larger* position. null = nothing to sit between, so leave the position alone.
 */
export function laneDropPosition(visualOrder: AdminTodo[], index: number, occupied: number[]): number | null {
  const above = visualOrder[index - 1];
  const below = visualOrder[index + 1];
  return positionBetween(occupied, below?.position ?? null, above?.position ?? null);
}

/** Same, for the queue: it reads top-down, so the row above holds the *smaller* position. */
export function queueDropPosition(order: AdminTodo[], index: number, occupied: number[]): number | null {
  const above = order[index - 1];
  const below = order[index + 1];
  return positionBetween(occupied, above?.position ?? null, below?.position ?? null);
}

/**
 * `count` free positions, ascending, all strictly between `lo` and `hi`: where a whole selection
 * lands when one of its notes is dragged. Each one is measured against the one before it, so the
 * block stays contiguous, in order, and off every position another row already owns. null when the
 * gap can't hold them (nothing to sit between, or floats out of room).
 */
export function blockPositions(occupied: number[], lo: number | null, hi: number | null, count: number): number[] | null {
  const taken = occupied.slice();
  const out: number[] = [];
  let low = lo;
  for (let i = 0; i < count; i++) {
    const position = positionBetween(taken, low, hi);
    if (position === null) return null;
    out.push(position);
    taken.push(position);
    low = position;
  }
  return out;
}

/** Where in a lane's visual (top-to-bottom) order a note released at `dropY` slots in. */
export function laneInsertionIndex(middles: number[], dropY: number): number {
  const index = middles.findIndex((middle) => dropY <= middle);
  return index === -1 ? middles.length : index;
}

/** A lane's notes top to bottom with their vertical centres, read off the DOM. */
function laneVisualOrder(
  laneEl: HTMLElement,
  laneItems: AdminTodo[],
  skip?: Set<string>,
): { visual: AdminTodo[]; middles: number[] } {
  const byId = new Map(laneItems.map((todo) => [todo.id, todo]));
  const visual: AdminTodo[] = [];
  const middles: number[] = [];
  // DOM order is the visual order, top to bottom.
  laneEl.querySelectorAll<HTMLElement>("[data-todo-id]").forEach((el) => {
    const todo = byId.get(el.dataset.todoId ?? "");
    if (!todo || skip?.has(todo.id)) return;
    const rect = el.getBoundingClientRect();
    visual.push(todo);
    middles.push(rect.top + rect.height / 2);
  });
  return { visual, middles };
}

/** Where a note dropped at `dropY` belongs in a lane it didn't come from. */
function crossLaneDropPosition(
  laneEl: HTMLElement,
  laneItems: AdminTodo[],
  moved: AdminTodo,
  dropY: number,
  occupied: number[],
): number {
  const { visual, middles } = laneVisualOrder(laneEl, laneItems);
  const index = laneInsertionIndex(middles, dropY);
  visual.splice(index, 0, moved);
  // An empty target lane leaves the note where it already sat in the global order; only its
  // category changes.
  return laneDropPosition(visual, index, occupied) ?? moved.position;
}

/**
 * Positions for a whole selection dropped at `dropY` in `laneEl`, ascending. The block's own notes
 * are skipped when the gap is measured - they are the ones moving, so wherever they sit now must
 * not bound where they land. null = the lane has no pair of neighbours to sit between (it is
 * empty, or holds nothing but the block), so the caller keeps their positions and moves the lane.
 */
function laneBlockDropPositions(
  laneEl: HTMLElement,
  laneItems: AdminTodo[],
  blockIds: Set<string>,
  dropY: number,
  occupied: number[],
  count: number,
): number[] | null {
  const { visual, middles } = laneVisualOrder(laneEl, laneItems, blockIds);
  const index = laneInsertionIndex(middles, dropY);
  // Lanes render reversed: the note above the gap holds the larger position.
  return blockPositions(occupied, visual[index]?.position ?? null, visual[index - 1]?.position ?? null, count);
}

/** Viewport coords for a drag end, preferring the real event over framer's own point. */
function dropPoint(event: MouseEvent | TouchEvent | PointerEvent, info: { point: { x: number; y: number } }): { x: number; y: number } {
  if ("clientX" in event && typeof event.clientX === "number") return { x: event.clientX, y: event.clientY };
  const touch = "changedTouches" in event ? event.changedTouches[0] : undefined;
  if (touch) return { x: touch.clientX, y: touch.clientY };
  return info.point;
}

// ---------------------------------------------------------------------------
// Marquee selection (drag a box over the board, like picking files on a desktop)
// ---------------------------------------------------------------------------

/** Viewport-space box. Marquee and note rects are both read from getBoundingClientRect. */
export interface SelectRect {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

/** A press this small is a click on the board, not a box drawn over it. */
const MARQUEE_MIN_DRAG_PX = 4;

/** The box between where the drag started and where the pointer is now, either direction. */
export function marqueeRect(ax: number, ay: number, bx: number, by: number): SelectRect {
  return {
    left: Math.min(ax, bx),
    top: Math.min(ay, by),
    right: Math.max(ax, bx),
    bottom: Math.max(ay, by),
  };
}

export function rectsOverlap(a: SelectRect, b: SelectRect): boolean {
  return a.left <= b.right && a.right >= b.left && a.top <= b.bottom && a.bottom >= b.top;
}

/** Notes the box touches. Grazing one is enough to take it, the way a file manager does it. */
export function idsInMarquee(notes: { id: string; rect: SelectRect }[], box: SelectRect): string[] {
  return notes.filter((note) => rectsOverlap(note.rect, box)).map((note) => note.id);
}

/**
 * What the selection becomes as a box is dragged. A plain drag replaces the selection; holding a
 * modifier adds to whatever was already picked (`base` is the selection as it stood when the drag
 * started, so shrinking the box back gives those notes up again rather than keeping them).
 */
export function mergeSelection(base: readonly string[], hits: readonly string[], additive: boolean): string[] {
  if (!additive) return [...hits];
  const merged = [...base];
  for (const id of hits) {
    if (!merged.includes(id)) merged.push(id);
  }
  return merged;
}

// Completing a todo scores it like a mania hit: the judgement is how long the note sat on the
// field before it was cleared. Weights follow mania accuracy (x/300).
type Judgement = "MAX" | "300" | "200" | "100" | "50";
type PopupJudgement = Judgement | "MISS";

const JUDGEMENT_META: Record<PopupJudgement, { weight: number; text: string; glow: string }> = {
  MAX: { weight: 300, text: "text-white", glow: "0 0 14px rgba(255,102,171,0.95), 0 2px 8px rgba(0,0,0,0.6)" },
  "300": { weight: 300, text: "text-osu-yellow", glow: "0 2px 8px rgba(0,0,0,0.6)" },
  "200": { weight: 200, text: "text-osu-green", glow: "0 2px 8px rgba(0,0,0,0.6)" },
  "100": { weight: 100, text: "text-osu-blue", glow: "0 2px 8px rgba(0,0,0,0.6)" },
  "50": { weight: 50, text: "text-osu-f1", glow: "0 2px 8px rgba(0,0,0,0.6)" },
  MISS: { weight: 0, text: "text-osu-red", glow: "0 2px 8px rgba(0,0,0,0.6)" },
};

const DAY_MS = 86_400_000;

function judgeTodo(createdAt: number, doneAt: number): Judgement {
  const days = (doneAt - createdAt) / DAY_MS;
  if (days < 1) return "MAX";
  if (days < 3) return "300";
  if (days < 7) return "200";
  if (days < 14) return "100";
  return "50";
}

// Mania-style accuracy over everything cleared so far; an empty results screen starts at 100%.
function accuracyOf(done: AdminTodo[]): number {
  if (done.length === 0) return 100;
  const sum = done.reduce((acc, t) => acc + JUDGEMENT_META[judgeTodo(t.createdAt, t.doneAt ?? t.updatedAt)].weight, 0);
  return (sum / (done.length * 300)) * 100;
}

function gradeOf(acc: number): { label: string; text: string } {
  if (acc >= 100) return { label: "SS", text: "text-osu-yellow" };
  if (acc >= 95) return { label: "S", text: "text-osu-yellow" };
  if (acc >= 90) return { label: "A", text: "text-osu-green" };
  if (acc >= 80) return { label: "B", text: "text-osu-blue" };
  if (acc >= 70) return { label: "C", text: "text-osu-purple" };
  return { label: "D", text: "text-osu-red" };
}

// Mirrors the backend board order so optimistic local updates land where a refetch would put them:
// open, then held, then done; open items follow the manual drag order (position asc), held items by
// most recently parked, done items by most recently completed.
const STATUS_ORDER: Record<TodoStatus, number> = { open: 0, hold: 1, done: 2 };

function sortTodos(list: AdminTodo[]): AdminTodo[] {
  return list.slice().sort((a, b) => {
    if (a.status !== b.status) return STATUS_ORDER[a.status] - STATUS_ORDER[b.status];
    if (a.status === "done") return (b.doneAt ?? 0) - (a.doneAt ?? 0);
    if (a.status === "hold") return b.updatedAt - a.updatedAt;
    if (a.position !== b.position) return a.position - b.position;
    return b.createdAt - a.createdAt;
  });
}

function upsertTodo(list: AdminTodo[], todo: AdminTodo): AdminTodo[] {
  return sortTodos([...list.filter((t) => t.id !== todo.id), todo]);
}

function errMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function formatShortDate(ms: number): string {
  return new Date(ms).toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

const TEXTAREA_CLASS =
  "w-full resize-y rounded-md border border-osu-b3/50 bg-osu-b6/60 px-3 py-2 text-xs text-osu-l1 placeholder:text-osu-f1/60 focus:border-osu-c2/60 focus:outline-none";

// ---------------------------------------------------------------------------
// Priority control (custom segmented buttons with a color dot)
// ---------------------------------------------------------------------------

function PrioritySegmented({ value, onChange }: { value: TodoPriority; onChange: (value: TodoPriority) => void }) {
  return (
    <div className="inline-flex rounded-md border border-osu-b3/50 bg-osu-b4/60 p-0.5" role="group" aria-label="Priority">
      {PRIORITY_ORDER.map((key) => {
        const active = key === value;
        return (
          <button
            key={key}
            type="button"
            onClick={() => onChange(key)}
            className={`inline-flex items-center gap-1.5 rounded px-2 py-1 text-[11px] font-semibold capitalize transition-colors cursor-pointer ${
              active ? "bg-osu-b3/50 text-white" : "text-osu-f1 hover:text-osu-l2"
            }`}
          >
            <span className={`h-1.5 w-1.5 rounded-full ${PRIORITY_META[key].dot} ${active ? "" : "opacity-60"}`} />
            {key}
          </button>
        );
      })}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Task id chip
// ---------------------------------------------------------------------------

/** The handle you quote to name a task ("do #7"). Hidden on rows predating the backend's seq column. */
function TodoSeq({ seq, className = "" }: { seq: number; className?: string }) {
  if (!seq) return null;
  return (
    <span className={`shrink-0 font-mono tabular-nums text-osu-f1/70 ${className}`} title={`Task #${seq}`}>
      #{seq}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

interface LanePopup {
  key: number;
  judgement: PopupJudgement;
}

interface EditPatch {
  title: string;
  notes: string;
  category: TodoCategory;
  priority: TodoPriority;
  groupId: string | null;
}

function TodosPage() {
  const [todos, setTodos] = useState<AdminTodo[]>([]);
  const [groups, setGroups] = useState<AdminTodoGroup[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Composer draft
  const [title, setTitle] = useState("");
  const [notes, setNotes] = useState("");
  const [category, setCategory] = useState<TodoCategory>("task");
  const [priority, setPriority] = useState<TodoPriority>("normal");
  const [showNotes, setShowNotes] = useState(false);
  const [adding, setAdding] = useState(false);
  const titleRef = useRef<HTMLInputElement | null>(null);

  const [search, setSearch] = useState("");
  const [view, setViewState] = useState<BoardView>("lanes");
  const laneRefs = useRef<LaneElements>({});
  // Lane a note is currently hovering over mid-drag, so the drop target is obvious before release.
  const [hoveredLane, setHoveredLane] = useState<TodoCategory | null>(null);
  const [showResults, setShowResults] = useState(false);
  const [showHold, setShowHold] = useState(false);
  const [clearing, setClearing] = useState(false);
  const [editing, setEditing] = useState<AdminTodo | null>(null);
  // Chip row filter: show only one group's tasks. null = everything.
  const [groupFilter, setGroupFilter] = useState<string | null>(null);
  const [groupsOpen, setGroupsOpen] = useState(false);

  // Marquee selection: drag a box across the board to take several notes at once, then act on the
  // lot of them (group them, clear them, park them, drop them). Mouse only - a finger dragging over
  // the board is scrolling it.
  const boardRef = useRef<HTMLDivElement | null>(null);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [marquee, setMarquee] = useState<SelectRect | null>(null);
  const marqueeRef = useRef<{ x: number; y: number; additive: boolean; base: string[]; moved: boolean } | null>(null);
  // Holding ctrl/cmd/shift puts the board in selection mode: notes stop being draggable, so a press
  // picks one instead of picking it up.
  const [selectMode, setSelectMode] = useState(false);
  // The note being dragged while it carries the rest of the selection with it, and how many are
  // coming along. The board holds this rather than the lane, because they can sit in any lane.
  const [blockDrag, setBlockDrag] = useState<{ leader: string; count: number } | null>(null);
  const selectedIdsRef = useRef(selectedIds);
  selectedIdsRef.current = selectedIds;
  const todosRef = useRef(todos);
  todosRef.current = todos;

  // Per-lane judgement popups; keyed so a fresh hit replaces the previous popup and an older
  // clear timer can't wipe a newer popup.
  const popupKey = useRef(0);
  const [popups, setPopups] = useState<Partial<Record<TodoCategory, LanePopup>>>({});
  const punch = useCallback((lane: TodoCategory, judgement: PopupJudgement) => {
    const key = ++popupKey.current;
    setPopups((prev) => ({ ...prev, [lane]: { key, judgement } }));
    window.setTimeout(() => {
      setPopups((prev) => (prev[lane]?.key === key ? { ...prev, [lane]: undefined } : prev));
    }, 900);
  }, []);

  const refetch = useCallback(async () => {
    try {
      const result = await listAdminTodos();
      setTodos(sortTodos(result.todos));
      setGroups(result.groups);
    } catch {
      // the error that triggered the refetch already surfaces on the page.
    }
  }, []);

  // Read after mount: SSR has no localStorage, and a first paint in the wrong view would flash.
  useEffect(() => {
    setViewState(readBoardViewPreference());
  }, []);

  const setView = useCallback((next: BoardView) => {
    setViewState(next);
    writeBoardViewPreference(next);
  }, []);

  useEffect(() => {
    // Decode the hitsound samples before the first hit so it lands on time.
    preloadTodoSfx();
    let alive = true;
    (async () => {
      try {
        const result = await listAdminTodos();
        if (alive) {
          setTodos(sortTodos(result.todos));
          setGroups(result.groups);
        }
      } catch (caught) {
        if (alive) setError(errMessage(caught));
      } finally {
        if (alive) setLoading(false);
      }
    })();
    return () => {
      alive = false;
    };
  }, []);

  const query = search.trim().toLowerCase();
  const matchesSearch = useCallback(
    // "#7" (or plain "7") pulls up a single task, so an id quoted in conversation is findable.
    (t: AdminTodo) => !query || `#${t.seq} ${t.title} ${t.notes ?? ""}`.toLowerCase().includes(query),
    [query],
  );

  // The chip row narrows the board to one group; it filters the shelf and the results screen too,
  // so a filtered board never contradicts what is listed under it.
  const matchesFilters = useCallback(
    (t: AdminTodo) => matchesSearch(t) && (groupFilter === null || t.groupId === groupFilter),
    [groupFilter, matchesSearch],
  );

  const openFiltered = useMemo(() => todos.filter((t) => t.status === "open" && matchesFilters(t)), [todos, matchesFilters]);
  const doneFiltered = useMemo(() => todos.filter((t) => t.status === "done" && matchesFilters(t)), [todos, matchesFilters]);
  const holdFiltered = useMemo(() => todos.filter((t) => t.status === "hold" && matchesFilters(t)), [todos, matchesFilters]);

  const groupById = useMemo(() => new Map(groups.map((group) => [group.id, group])), [groups]);
  // Chip counts are the live list: tasks still to do, parked ones included, cleared ones not.
  const groupCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const t of todos) {
      if (t.status === "done" || !t.groupId) continue;
      counts.set(t.groupId, (counts.get(t.groupId) ?? 0) + 1);
    }
    return counts;
  }, [todos]);
  const selectedSet = useMemo(() => new Set(selectedIds), [selectedIds]);

  // Lane contents: open todos split by category, position asc (first = next up, closest to the line).
  const lanes = useMemo(() => {
    const map = { task: [], bug: [], feature: [], idea: [], chore: [] } as Record<TodoCategory, AdminTodo[]>;
    for (const t of openFiltered) map[t.category].push(t);
    return map;
  }, [openFiltered]);

  // Queue view: the same open todos as one do-next list, position asc (first = do it first).
  const queue = useMemo(() => openFiltered.slice().sort((a, b) => a.position - b.position), [openFiltered]);

  // Unfiltered, unlike `openFiltered`: drops need every occupied position, including rows the
  // current search is hiding and held rows, which keep their position while parked so resuming one
  // puts it back where it was.
  const positionPeers = useMemo(() => todos.filter((t) => t.status !== "done"), [todos]);
  const openCount = useMemo(() => todos.filter((t) => t.status === "open").length, [todos]);
  const doneAll = useMemo(() => todos.filter((t) => t.status === "done"), [todos]);
  const doneCount = doneAll.length;
  const holdCount = useMemo(() => todos.filter((t) => t.status === "hold").length, [todos]);
  const acc = accuracyOf(doneAll);
  const grade = gradeOf(acc);

  // A selected note that got cleared, parked or deleted (here or in another tab) leaves the
  // selection rather than sitting in it invisibly.
  useEffect(() => {
    setSelectedIds((prev) => {
      const alive = prev.filter((id) => todos.some((t) => t.id === id && t.status === "open"));
      return alive.length === prev.length ? prev : alive;
    });
  }, [todos]);

  useEffect(() => {
    const sync = (event: KeyboardEvent) => setSelectMode(event.ctrlKey || event.metaKey || event.shiftKey);
    // A modifier released while the window was in the background never fires keyup here, and the
    // board would stay undraggable.
    const reset = () => setSelectMode(false);
    window.addEventListener("keydown", sync);
    window.addEventListener("keyup", sync);
    window.addEventListener("blur", reset);
    return () => {
      window.removeEventListener("keydown", sync);
      window.removeEventListener("keyup", sync);
      window.removeEventListener("blur", reset);
    };
  }, []);

  useEffect(() => {
    if (selectedIds.length === 0) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setSelectedIds([]);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [selectedIds.length]);

  /** Every note currently on the board, with where it is on screen. Read fresh on each move. */
  const collectNoteRects = useCallback((): { id: string; rect: SelectRect }[] => {
    const board = boardRef.current;
    if (!board) return [];
    return Array.from(board.querySelectorAll<HTMLElement>("[data-todo-id]"))
      .map((el) => {
        const rect = el.getBoundingClientRect();
        return { id: el.dataset.todoId ?? "", rect: { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom } };
      })
      .filter((note) => note.id);
  }, []);

  const handleBoardPointerDown = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    if (event.pointerType !== "mouse" || event.button !== 0) return;
    const target = event.target as HTMLElement;
    // The tick button and the search box own their own presses, and so does anything floating over
    // the page (the selection bar, a modal).
    if (target.closest("button, a, input, textarea, [data-no-marquee]")) return;
    const additive = event.ctrlKey || event.metaKey || event.shiftKey;
    const row = target.closest("[data-todo-id]") as HTMLElement | null;
    if (row) {
      // A plain press on a note drags it or opens it; only a modifier press picks it.
      if (!additive) return;
      const id = row.dataset.todoId ?? "";
      if (!id) return;
      event.preventDefault();
      setSelectedIds((prev) => (prev.includes(id) ? prev.filter((other) => other !== id) : [...prev, id]));
      return;
    }
    marqueeRef.current = {
      x: event.clientX,
      y: event.clientY,
      additive,
      base: additive ? selectedIdsRef.current : [],
      moved: false,
    };
  }, []);

  useEffect(() => {
    const onMove = (event: PointerEvent) => {
      const start = marqueeRef.current;
      if (!start) return;
      if (
        !start.moved
        && Math.abs(event.clientX - start.x) < MARQUEE_MIN_DRAG_PX
        && Math.abs(event.clientY - start.y) < MARQUEE_MIN_DRAG_PX
      ) {
        return;
      }
      start.moved = true;
      const box = marqueeRect(start.x, start.y, event.clientX, event.clientY);
      setMarquee(box);
      setSelectedIds(mergeSelection(start.base, idsInMarquee(collectNoteRects(), box), start.additive));
    };
    const onUp = () => {
      const start = marqueeRef.current;
      marqueeRef.current = null;
      setMarquee(null);
      // A press on bare board that never became a box is a click on nothing: drop the selection.
      if (start && !start.moved && !start.additive) setSelectedIds([]);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
    };
  }, [collectNoteRects]);

  const handleAdd = useCallback(async () => {
    const trimmed = title.trim();
    if (!trimmed || adding) return;
    setAdding(true);
    setError(null);
    try {
      const result = await createAdminTodo({ data: { title: trimmed, notes, category, priority } });
      setTodos((prev) => upsertTodo(prev, result.todo));
      playTodoPlace(); // synced with the note dropping onto the field
      // Keep category/priority so batches of the same kind stay fast; clear the rest.
      setTitle("");
      setNotes("");
      titleRef.current?.focus();
    } catch (caught) {
      setError(errMessage(caught));
    } finally {
      setAdding(false);
    }
  }, [title, notes, category, priority, adding]);

  // Completing is optimistic so the hit lands instantly: the note bursts, the lane shows the
  // judgement, then the server response reconciles (or a refetch restores truth on failure).
  const handleToggle = useCallback(
    async (todo: AdminTodo) => {
      const nextStatus: TodoStatus = todo.status === "open" ? "done" : "open";
      const now = Date.now();
      setTodos((prev) => upsertTodo(prev, { ...todo, status: nextStatus, doneAt: nextStatus === "done" ? now : null }));
      if (nextStatus === "done") {
        const judgement = judgeTodo(todo.createdAt, now);
        punch(todo.category, judgement);
        playTodoHit(judgement);
      } else {
        playTodoReturn();
      }
      setError(null);
      try {
        const result = await updateAdminTodo({ data: { id: todo.id, status: nextStatus } });
        setTodos((prev) => upsertTodo(prev, result.todo));
      } catch (caught) {
        setError(errMessage(caught));
        void refetch();
      }
    },
    [punch, refetch],
  );

  // Parking a task takes it off the field without scoring it, and resuming drops it back at the
  // position it kept while parked.
  const handleHold = useCallback(
    async (todo: AdminTodo) => {
      const nextStatus: TodoStatus = todo.status === "hold" ? "open" : "hold";
      setTodos((prev) => upsertTodo(prev, { ...todo, status: nextStatus, doneAt: null, updatedAt: Date.now() }));
      if (nextStatus === "hold") {
        // Open the shelf so the task is visibly somewhere rather than just gone from the field.
        setShowHold(true);
        playTodoDropTick();
      } else {
        playTodoReturn();
      }
      setError(null);
      try {
        const result = await updateAdminTodo({ data: { id: todo.id, status: nextStatus } });
        setTodos((prev) => upsertTodo(prev, result.todo));
      } catch (caught) {
        setError(errMessage(caught));
        void refetch();
      }
    },
    [refetch],
  );

  const handleSave = useCallback(async (id: string, patch: EditPatch) => {
    setError(null);
    try {
      const result = await updateAdminTodo({
        data: {
          id,
          title: patch.title,
          notes: patch.notes,
          category: patch.category,
          priority: patch.priority,
          groupId: patch.groupId,
        },
      });
      setTodos((prev) => upsertTodo(prev, result.todo));
    } catch (caught) {
      setError(errMessage(caught));
      throw caught;
    }
  }, []);

  const handleDelete = useCallback(
    async (todo: AdminTodo) => {
      setTodos((prev) => prev.filter((t) => t.id !== todo.id));
      // Dropping an open note off the field is a miss; deleting a held or cleared row is cleanup.
      if (todo.status === "open") {
        punch(todo.category, "MISS");
        playTodoMiss();
      }
      setError(null);
      try {
        await deleteAdminTodo({ data: { id: todo.id } });
      } catch (caught) {
        setError(errMessage(caught));
        void refetch();
      }
    },
    [punch, refetch],
  );

  const handleClearDone = useCallback(async () => {
    setClearing(true);
    setError(null);
    try {
      await clearDoneAdminTodos();
      setTodos((prev) => prev.filter((t) => t.status !== "done"));
    } catch (caught) {
      setError(errMessage(caught));
    } finally {
      setClearing(false);
    }
  }, []);

  // On drop, the moved note gets a position between its two new lane neighbours (computed in the
  // lane, since visual order is reversed there) and persists just that one row.
  const handleReorderEnd = useCallback(
    async (id: string, position: number) => {
      setTodos((prev) => {
        const current = prev.find((t) => t.id === id);
        return current ? upsertTodo(prev, { ...current, position }) : prev;
      });
      playTodoDropTick();
      setError(null);
      try {
        const result = await updateAdminTodo({ data: { id, position } });
        setTodos((prev) => upsertTodo(prev, result.todo));
      } catch (caught) {
        setError(errMessage(caught));
        void refetch();
      }
    },
    [refetch],
  );

  // Dragging a note sideways onto another lane retypes it: the lane a task sits in *is* its
  // category, so dropping "recent plays rework" on the bug lane makes it a bug.
  const handleMoveToLane = useCallback(
    async (id: string, category: TodoCategory, position: number) => {
      setTodos((prev) => {
        const current = prev.find((t) => t.id === id);
        return current ? upsertTodo(prev, { ...current, category, position }) : prev;
      });
      playTodoDropTick();
      setError(null);
      try {
        const result = await updateAdminTodo({ data: { id, category, position } });
        setTodos((prev) => upsertTodo(prev, result.todo));
      } catch (caught) {
        setError(errMessage(caught));
        void refetch();
      }
    },
    [refetch],
  );

  // ---------------------------------------------------------------------
  // Bulk actions on a marquee selection
  // ---------------------------------------------------------------------

  const applyTodos = useCallback((updated: AdminTodo[]) => {
    setTodos((prev) => updated.reduce((acc, todo) => upsertTodo(acc, todo), prev));
  }, []);

  // Dragging one note of a selection carries the whole selection: every picked note lands as one
  // block at the drop point, in the order it already had, and (in the lanes view) takes the lane it
  // was dropped on. One write per note, since position is per-row.
  const handleBlockMove = useCallback(
    async (moves: BlockMove[]) => {
      if (moves.length === 0) return;
      setTodos((prev) =>
        moves.reduce((acc, move) => {
          const current = acc.find((t) => t.id === move.id);
          return current ? upsertTodo(acc, { ...current, position: move.position, category: move.category ?? current.category }) : acc;
        }, prev),
      );
      playTodoDropTick();
      setError(null);
      try {
        const results = await Promise.all(
          moves.map((move) =>
            updateAdminTodo({
              data: move.category
                ? { id: move.id, position: move.position, category: move.category }
                : { id: move.id, position: move.position },
            }),
          ),
        );
        applyTodos(results.map((result) => result.todo));
      } catch (caught) {
        setError(errMessage(caught));
        void refetch();
      }
    },
    [applyTodos, refetch],
  );

  const handleBulkGroup = useCallback(
    async (groupId: string | null) => {
      const ids = selectedIdsRef.current;
      if (ids.length === 0) return;
      setTodos((prev) => prev.map((t) => (ids.includes(t.id) ? { ...t, groupId } : t)));
      playTodoDropTick();
      setError(null);
      try {
        // One request for the whole selection rather than one per note.
        const result = await assignAdminTodosToGroup({ data: { ids, groupId } });
        applyTodos(result.todos);
      } catch (caught) {
        setError(errMessage(caught));
        void refetch();
      }
    },
    [applyTodos, refetch],
  );

  const handleBulkStatus = useCallback(
    async (next: "done" | "hold") => {
      const ids = selectedIdsRef.current;
      const picked = todosRef.current.filter((t) => ids.includes(t.id) && t.status === "open");
      if (picked.length === 0) return;
      const now = Date.now();
      setTodos((prev) =>
        picked.reduce(
          (acc, todo) => upsertTodo(acc, { ...todo, status: next, doneAt: next === "done" ? now : null, updatedAt: now }),
          prev,
        ),
      );
      setSelectedIds([]);
      if (next === "done") {
        // One judgement for the batch, taken from the note that sat on the field longest: clearing
        // a stack of old tasks at once should not read as a MAX.
        const oldest = Math.min(...picked.map((t) => t.createdAt));
        const judgement = judgeTodo(oldest, now);
        punch(picked[0].category, judgement);
        playTodoHit(judgement);
      } else {
        setShowHold(true);
        playTodoDropTick();
      }
      setError(null);
      try {
        const results = await Promise.all(picked.map((todo) => updateAdminTodo({ data: { id: todo.id, status: next } })));
        applyTodos(results.map((result) => result.todo));
      } catch (caught) {
        setError(errMessage(caught));
        void refetch();
      }
    },
    [applyTodos, punch, refetch],
  );

  const handleBulkDelete = useCallback(async () => {
    const ids = selectedIdsRef.current;
    const picked = todosRef.current.filter((t) => ids.includes(t.id));
    if (picked.length === 0) return;
    setTodos((prev) => prev.filter((t) => !ids.includes(t.id)));
    setSelectedIds([]);
    punch(picked[0].category, "MISS");
    playTodoMiss();
    setError(null);
    try {
      await Promise.all(picked.map((todo) => deleteAdminTodo({ data: { id: todo.id } })));
    } catch (caught) {
      setError(errMessage(caught));
      void refetch();
    }
  }, [punch, refetch]);

  // ---------------------------------------------------------------------
  // Groups
  // ---------------------------------------------------------------------

  const handleSaveGroup = useCallback(async (input: { id?: string; name: string; color: TodoGroupColor }) => {
    setError(null);
    try {
      const result = await saveAdminTodoGroup({ data: input });
      setGroups((prev) =>
        prev
          .filter((group) => group.id !== result.group.id)
          .concat(result.group)
          .sort((a, b) => a.position - b.position || a.createdAt - b.createdAt),
      );
      return result.group;
    } catch (caught) {
      setError(errMessage(caught));
      return null;
    }
  }, []);

  // Naming a group in the selection bar creates it and puts the selection in it in one go.
  const handleCreateGroupForSelection = useCallback(
    async (name: string) => {
      const group = await handleSaveGroup({ name, color: nextGroupColor(groups.map((g) => g.color)) });
      if (group) await handleBulkGroup(group.id);
    },
    [groups, handleBulkGroup, handleSaveGroup],
  );

  const handleDeleteGroup = useCallback(async (id: string) => {
    // Deleting a group ungroups its tasks; it never takes them with it.
    setGroups((prev) => prev.filter((group) => group.id !== id));
    setTodos((prev) => prev.map((t) => (t.groupId === id ? { ...t, groupId: null } : t)));
    setGroupFilter((current) => (current === id ? null : current));
    setError(null);
    try {
      await deleteAdminTodoGroup({ data: { id } });
    } catch (caught) {
      setError(errMessage(caught));
      void refetch();
    }
  }, [refetch]);

  return (
    <div
      ref={boardRef}
      onPointerDown={handleBoardPointerDown}
      className={`flex-1 bg-osu-b5 min-h-[calc(100vh-60px)] ${marquee ? "select-none" : ""} ${
        selectMode ? "cursor-crosshair" : ""
      }`}
    >
      <div className="mx-auto max-w-[1000px] space-y-4 px-4 py-6 sm:px-5">
        {/* Header */}
        <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <span className="h-4 w-1 rounded-full bg-osu-pink" />
              <h1 className="text-sm font-bold uppercase tracking-[0.14em] text-osu-l1">Todo</h1>
            </div>
            <p className="mt-1 text-[11px] text-osu-f1">
              {openCount} on the field{holdCount ? ` · ${holdCount} on hold` : ""}{doneCount ? ` · ${doneCount} cleared` : ""}
              <span className="hidden sm:inline"> · private notes for the project</span>
            </p>
          </div>
          <div className="flex items-center gap-2">
            <div className="inline-flex shrink-0 rounded-md border border-osu-b3/50 bg-osu-b4/60 p-0.5" role="group" aria-label="Board view">
              {([
                { key: "lanes" as const, label: "Lanes", Icon: Columns3 },
                { key: "queue" as const, label: "Queue", Icon: ListOrdered },
              ]).map(({ key, label, Icon }) => (
                <button
                  key={key}
                  type="button"
                  onClick={() => setView(key)}
                  aria-pressed={view === key}
                  aria-label={label}
                  title={label}
                  className={`inline-flex items-center gap-1.5 rounded px-2 py-1.5 text-[11px] font-semibold transition-colors cursor-pointer sm:py-1 ${
                    view === key ? "bg-osu-b3/50 text-white" : "text-osu-f1 hover:text-osu-l2"
                  }`}
                >
                  <Icon className="h-3.5 w-3.5" />
                  {label}
                </button>
              ))}
            </div>
            <div className="relative min-w-0 flex-1 sm:w-[240px] sm:flex-none">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-osu-f1/60" />
            <input
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Escape") setSearch("");
              }}
              placeholder="Search notes..."
              className="w-full rounded-md border border-osu-b3/50 bg-osu-b6/70 py-1.5 pl-8 pr-8 text-xs text-osu-l1 placeholder:text-osu-f1/60 focus:border-osu-c2/60 focus:outline-none"
            />
            {search && (
              <button
                type="button"
                onClick={() => setSearch("")}
                aria-label="Clear search"
                className="absolute right-1.5 top-1/2 inline-flex h-5 w-5 -translate-y-1/2 items-center justify-center rounded text-osu-f1 transition-colors hover:bg-osu-b3/50 hover:text-osu-l1 cursor-pointer"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            )}
            </div>
          </div>
        </div>

        {/* Composer */}
        <div className="rounded-xl border border-osu-b3/40 bg-osu-b4/30 p-3">
          <div className="flex items-center gap-2">
            <input
              ref={titleRef}
              value={title}
              onChange={(event) => setTitle(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter" && !event.shiftKey) {
                  event.preventDefault();
                  void handleAdd();
                }
              }}
              maxLength={500}
              placeholder="Add a task, reminder, or bug you found..."
              className="min-w-0 flex-1 rounded-md border border-osu-b3/50 bg-osu-b6/70 px-3 py-2 text-sm text-osu-l1 placeholder:text-osu-f1/60 focus:border-osu-c2/60 focus:outline-none"
            />
            <button
              type="button"
              onClick={() => void handleAdd()}
              disabled={!title.trim() || adding}
              className="inline-flex h-9 shrink-0 items-center gap-1.5 rounded-md border border-osu-yellow/40 bg-osu-yellow/15 px-3 text-xs font-semibold text-osu-yellow transition-colors hover:bg-osu-yellow/25 disabled:cursor-not-allowed disabled:opacity-40 cursor-pointer"
            >
              {adding ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />}
              Add
            </button>
          </div>
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <SelectMenu value={category} options={CATEGORY_OPTIONS} onChange={setCategory} ariaLabel="Category" />
            <PrioritySegmented value={priority} onChange={setPriority} />
            <button
              type="button"
              onClick={() => setShowNotes((open) => !open)}
              className={`inline-flex items-center gap-1 rounded-md px-2 py-1 text-[11px] font-medium transition-colors cursor-pointer ${
                showNotes || notes ? "text-osu-l2" : "text-osu-f1 hover:text-osu-l2"
              }`}
            >
              <ChevronDown className={`h-3.5 w-3.5 transition-transform ${showNotes ? "rotate-180" : ""}`} />
              Notes
              {!showNotes && notes ? <span className="text-osu-c2">·</span> : null}
            </button>
          </div>
          {showNotes && (
            <textarea
              value={notes}
              onChange={(event) => setNotes(event.target.value)}
              maxLength={5000}
              rows={2}
              placeholder="Notes (optional) - context, links, repro steps..."
              className={`mt-2 ${TEXTAREA_CLASS}`}
            />
          )}
        </div>

        {/* Groups: the owner's own buckets over the board. A chip filters to one of them. */}
        {!loading && (
          <div className="flex flex-wrap items-center gap-1.5">
            {groups.map((group) => {
              const meta = GROUP_COLOR_META[group.color];
              const active = groupFilter === group.id;
              return (
                <button
                  key={group.id}
                  type="button"
                  onClick={() => setGroupFilter(active ? null : group.id)}
                  aria-pressed={active}
                  className={`inline-flex items-center gap-1.5 rounded-md border px-2 py-1 text-[11px] font-semibold transition-colors cursor-pointer ${
                    active ? meta.chip : "border-osu-b3/40 bg-osu-b4/30 text-osu-f1 hover:text-osu-l2"
                  }`}
                >
                  <span className={`h-1.5 w-1.5 rounded-full ${meta.dot}`} />
                  {group.name}
                  <span className="tabular-nums text-osu-f1/60">{groupCounts.get(group.id) ?? 0}</span>
                </button>
              );
            })}
            <button
              type="button"
              onClick={() => setGroupsOpen(true)}
              className="inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-[11px] font-semibold text-osu-f1 transition-colors hover:text-osu-l2 cursor-pointer"
            >
              <Pencil className="h-3.5 w-3.5" />
              {groups.length ? "Edit groups" : "New group"}
            </button>
          </div>
        )}

        {error && (
          <div className="flex items-center gap-2 rounded-lg border border-osu-red/40 bg-osu-red/10 px-3 py-2 text-xs text-osu-red">
            <AlertTriangle className="h-4 w-4 shrink-0" />
            {error}
          </div>
        )}

        {/* Playfield */}
        {loading ? (
          <div className="flex items-center justify-center gap-2 py-16 text-xs text-osu-f1">
            <Loader2 className="h-4 w-4 animate-spin" />
            Loading todos...
          </div>
        ) : (
          <div className="overflow-hidden rounded-xl border border-osu-b3/40 bg-osu-b6/20">
            {view === "lanes" ? (
              <div className="snap-x overflow-x-auto">
                {/* Wider than the desktop minimum on purpose: on a phone this scrolls sideways
                    either way, so give each lane enough room to read rather than cramming five
                    into the viewport. */}
                <div className="min-w-[760px] sm:min-w-[680px]">
                  <div className="relative flex">
                    {CATEGORY_ORDER.map((key) => (
                      <Lane
                        key={key}
                        category={key}
                        items={lanes[key]}
                        popup={popups[key]}
                        onHit={handleToggle}
                        onOpen={setEditing}
                        onReorderEnd={handleReorderEnd}
                        laneRefs={laneRefs}
                        lanes={lanes}
                        positionPeers={positionPeers}
                        onMoveToLane={handleMoveToLane}
                        onDragHoverLane={setHoveredLane}
                        hovered={hoveredLane === key}
                        groupById={groupById}
                        selectedIds={selectedSet}
                        selectMode={selectMode}
                        onBlockMove={handleBlockMove}
                        blockDrag={blockDrag}
                        onBlockDrag={setBlockDrag}
                      />
                    ))}
                    {openFiltered.length === 0 && (
                      <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
                        <p className="rounded-md bg-osu-b6/70 px-3 py-1.5 text-xs text-osu-f1">
                          {todos.length === 0
                            ? "No notes on the field. Add the first one above."
                            : query || groupFilter
                              ? "Nothing on the field matches this filter."
                              : "All clear. Nothing left on the field."}
                        </p>
                      </div>
                    )}
                  </div>
                  {/* Judgement line */}
                  <div className="h-0.5 w-full bg-osu-pink shadow-[0_0_10px_rgba(255,102,171,0.55)]" />
                </div>
              </div>
            ) : (
              <div className="min-h-[260px]">
                {queue.length === 0 ? (
                  <p className="py-20 text-center text-xs text-osu-f1">
                    {todos.length === 0
                      ? "Nothing queued. Add the first task above."
                      : query || groupFilter
                        ? "Nothing queued matches this filter."
                        : "All clear. Nothing left to do."}
                  </p>
                ) : (
                  <Queue
                    items={queue}
                    positionPeers={positionPeers}
                    onHit={handleToggle}
                    onOpen={setEditing}
                    onReorderEnd={handleReorderEnd}
                    groupById={groupById}
                    selectedIds={selectedSet}
                    selectMode={selectMode}
                    onBlockMove={handleBlockMove}
                    blockDrag={blockDrag}
                    onBlockDrag={setBlockDrag}
                  />
                )}
              </div>
            )}

            {/* Score footer: accuracy + grade, combo, results toggle */}
            <div className="grid grid-cols-3 items-center gap-2 border-t border-osu-b3/30 px-2 py-2 sm:px-3">
              <div className="flex items-center gap-1.5 sm:gap-2">
                <span className={`text-sm font-black italic ${grade.text}`}>{grade.label}</span>
                <span className="text-sm font-bold tabular-nums text-osu-l1">{acc.toFixed(2)}%</span>
                {/* Labels are decoration; the grade letter and the % carry the meaning on their own. */}
                <span className="hidden text-[10px] uppercase tracking-wider text-osu-f1/50 sm:inline">acc</span>
              </div>
              <div className="flex items-baseline justify-center gap-1.5">
                <AnimatePresence initial={false} mode="popLayout">
                  <motion.span
                    key={doneCount}
                    initial={{ scale: 1.4 }}
                    animate={{ scale: 1 }}
                    exit={{ opacity: 0, transition: { duration: 0 } }}
                    transition={{ type: "spring", stiffness: 500, damping: 24 }}
                    className="text-base font-black italic text-osu-l1"
                  >
                    {doneCount}x
                  </motion.span>
                </AnimatePresence>
                <span className="hidden text-[10px] uppercase tracking-wider text-osu-f1/50 sm:inline">cleared</span>
              </div>
              <div className="flex items-center justify-end gap-1">
                {holdCount > 0 && (
                  <button
                    type="button"
                    onClick={() => setShowHold((open) => !open)}
                    className={`inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-[11px] font-semibold transition-colors cursor-pointer ${
                      showHold ? "text-osu-l1" : "text-osu-f1 hover:text-osu-l2"
                    }`}
                  >
                    <ChevronDown className={`h-3.5 w-3.5 transition-transform ${showHold ? "rotate-180" : ""}`} />
                    Hold
                    <span className="tabular-nums text-osu-f1/60">{holdCount}</span>
                  </button>
                )}
                <button
                  type="button"
                  onClick={() => setShowResults((open) => !open)}
                  className={`inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-[11px] font-semibold transition-colors cursor-pointer ${
                    showResults ? "text-osu-l1" : "text-osu-f1 hover:text-osu-l2"
                  }`}
                >
                  <ChevronDown className={`h-3.5 w-3.5 transition-transform ${showResults ? "rotate-180" : ""}`} />
                  Results
                  <span className="tabular-nums text-osu-f1/60">{doneCount}</span>
                </button>
              </div>
            </div>
          </div>
        )}

        {/* Shelf: parked tasks, off the field and unscored until they are resumed */}
        {!loading && showHold && holdCount > 0 && (
          <div className="rounded-xl border border-osu-b3/40 bg-osu-b4/20 p-3">
            <p className="text-[10px] text-osu-f1/60">On hold. These sit out of the board and out of the score until you resume them.</p>
            <div className="mt-2 flex flex-col gap-1.5">
              {holdFiltered.length === 0 ? (
                <p className="py-4 text-center text-xs text-osu-f1">Nothing on hold matches this search.</p>
              ) : (
                holdFiltered.map((todo) => (
                  <HoldRow key={todo.id} todo={todo} onResume={handleHold} onOpen={setEditing} onDelete={handleDelete} />
                ))
              )}
            </div>
          </div>
        )}

        {/* Results screen: everything cleared, scored by how long it sat on the field */}
        {!loading && showResults && (
          <div className="rounded-xl border border-osu-b3/40 bg-osu-b4/20 p-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <p className="text-[10px] text-osu-f1/60">
                Judgement is time on the field: MAX under a day · 300 under 3 days · 200 under a week · 100 under two
                weeks · 50 after that.
              </p>
              {doneCount > 0 && <ClearDoneButton count={doneCount} busy={clearing} onClear={handleClearDone} />}
            </div>
            <div className="mt-2 flex flex-col gap-1.5">
              {doneFiltered.length === 0 ? (
                <p className="py-4 text-center text-xs text-osu-f1">
                  {doneCount === 0 ? "Nothing cleared yet." : "Nothing cleared matches this search."}
                </p>
              ) : (
                doneFiltered.map((todo) => (
                  <DoneRow key={todo.id} todo={todo} onUndo={handleToggle} onDelete={handleDelete} />
                ))
              )}
            </div>
          </div>
        )}
      </div>

      <AnimatePresence>
        {editing && (
          <NoteModal
            todo={editing}
            groups={groups}
            onClose={() => setEditing(null)}
            onSave={handleSave}
            onDelete={handleDelete}
            onHold={handleHold}
          />
        )}
      </AnimatePresence>

      <AnimatePresence>
        {selectedIds.length > 0 && (
          <SelectionBar
            count={selectedIds.length}
            groups={groups}
            onGroup={(groupId) => void handleBulkGroup(groupId)}
            onCreateGroup={(name) => void handleCreateGroupForSelection(name)}
            onDone={() => void handleBulkStatus("done")}
            onHold={() => void handleBulkStatus("hold")}
            onDelete={() => void handleBulkDelete()}
            onClear={() => setSelectedIds([])}
          />
        )}
      </AnimatePresence>

      <AnimatePresence>
        {groupsOpen && (
          <GroupsModal
            groups={groups}
            counts={groupCounts}
            onClose={() => setGroupsOpen(false)}
            onSave={handleSaveGroup}
            onDelete={handleDeleteGroup}
          />
        )}
      </AnimatePresence>

      {/* The box itself, in viewport coordinates so no scroll offset has to be tracked. */}
      {marquee && (
        <div
          className="pointer-events-none fixed z-[80] rounded-[2px] border border-osu-blue/80 bg-osu-blue/20"
          style={{
            left: marquee.left,
            top: marquee.top,
            width: marquee.right - marquee.left,
            height: marquee.bottom - marquee.top,
          }}
        />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Lane (one category column of the playfield)
// ---------------------------------------------------------------------------

interface LaneProps {
  category: TodoCategory;
  // Open todos in this lane, position asc: first = next up, rendered closest to the judgement line.
  items: AdminTodo[];
  popup: LanePopup | undefined;
  onHit: (todo: AdminTodo) => void;
  onOpen: (todo: AdminTodo) => void;
  onReorderEnd: (id: string, position: number) => void;
  // Shared across every lane so a drop can be hit-tested against all of them, plus the lane
  // contents needed to work out where in the target lane the note landed.
  laneRefs: React.RefObject<LaneElements>;
  lanes: Record<TodoCategory, AdminTodo[]>;
  // Every todo that still owns a position (open plus held), search filter included, since
  // `position` is global: a drop has to dodge positions held by notes that aren't on screen.
  positionPeers: AdminTodo[];
  onMoveToLane: (id: string, category: TodoCategory, position: number) => void;
  onDragHoverLane: (category: TodoCategory | null) => void;
  hovered: boolean;
  groupById: Map<string, AdminTodoGroup>;
  // Ids currently picked by the marquee, and whether a modifier is down (which suspends dragging so
  // a press picks a note rather than lifting it).
  selectedIds: Set<string>;
  selectMode: boolean;
  // Dragging a picked note drags every picked note. The board owns the leader's id so the notes
  // riding along in other lanes can show it too.
  onBlockMove: (moves: BlockMove[]) => void;
  blockDrag: BlockDrag;
  onBlockDrag: (drag: BlockDrag) => void;
}

function Lane({ category, items, popup, onHit, onOpen, onReorderEnd, laneRefs, lanes, positionPeers, onMoveToLane, onDragHoverLane, hovered, groupById, selectedIds, selectMode, onBlockMove, blockDrag, onBlockDrag }: LaneProps) {
  const meta = CATEGORY_META[category];
  const Icon = meta.Icon;

  // Downscroll: the lane renders reversed (last position on top, next-up at the bottom touching
  // the judgement line). `order` drives the Reorder.Group during a drag and is resynced from the
  // data whenever the lane's contents change.
  const [order, setOrder] = useState<AdminTodo[]>(() => [...items].reverse());
  const dragging = useRef(false);
  useEffect(() => {
    // Any todo change hands every lane a new array, so a response landing mid-drag (a cross-lane
    // move, a completed note, the previous drag's own write) would yank the note out from under the
    // pointer and the drop would then read as "no net move". Catch up when the drag ends instead.
    if (dragging.current) return;
    setOrder([...items].reverse());
  }, [items]);
  const orderRef = useRef(order);
  orderRef.current = order;
  const itemsRef = useRef(items);
  itemsRef.current = items;

  const lanesRef = useRef(lanes);
  lanesRef.current = lanes;
  const positionPeersRef = useRef(positionPeers);
  positionPeersRef.current = positionPeers;
  const selectedIdsRef = useRef(selectedIds);
  selectedIdsRef.current = selectedIds;
  // The notes travelling with the one under the pointer, fixed at the start of the drag so a
  // selection change mid-flight can't split the block.
  const block = useRef<{ leader: string; members: AdminTodo[] } | null>(null);

  const handleDragStart = useCallback(
    (id: string) => {
      dragging.current = true;
      // Position asc, across every lane: the selection keeps the order it already reads in.
      const members = CATEGORY_ORDER.flatMap((key) => lanesRef.current[key])
        .filter((t) => selectedIdsRef.current.has(t.id))
        .sort((a, b) => a.position - b.position);
      block.current = selectedIdsRef.current.has(id) && members.length > 1 ? { leader: id, members } : null;
      onBlockDrag(block.current ? { leader: id, count: members.length } : null);
    },
    [onBlockDrag],
  );

  const handleDrag = useCallback(
    (point: { x: number; y: number }) => {
      const target = findLaneAtPoint(laneRefs.current, point.x, point.y);
      onDragHoverLane(target === category ? null : target);
    },
    [category, laneRefs, onDragHoverLane],
  );

  const handleDragEnd = useCallback(
    (id: string, point: { x: number; y: number }) => {
      dragging.current = false;
      onDragHoverLane(null);
      const carried = block.current;
      block.current = null;
      onBlockDrag(null);
      const occupied = positionPeersRef.current.filter((t) => t.id !== id).map((t) => t.position);
      // Whatever happens next, the local order must stop diverging from the data.
      const resync = () => setOrder([...itemsRef.current].reverse());

      // A dragged selection lands whole, in the lane it was released over: the block is gathered
      // together at the drop point even if it started spread across lanes.
      if (carried && carried.leader === id) {
        const target = findLaneAtPoint(laneRefs.current, point.x, point.y) ?? category;
        const targetEl = laneRefs.current[target];
        if (!targetEl) {
          resync();
          return;
        }
        const blockIds = new Set(carried.members.map((t) => t.id));
        const free = positionPeersRef.current.filter((t) => !blockIds.has(t.id)).map((t) => t.position);
        const positions = laneBlockDropPositions(targetEl, lanesRef.current[target], blockIds, point.y, free, carried.members.length);
        const moves = carried.members.map((todo, i) => ({
          id: todo.id,
          position: positions?.[i] ?? todo.position,
          ...(todo.category === target ? {} : { category: target }),
        }));
        // An empty lane with nothing to sit between, dropped on by notes already in it: nothing to
        // write, so put the local order back rather than waiting on data that will not change.
        if (moves.every((move, i) => move.position === carried.members[i].position && move.category === undefined)) {
          resync();
          return;
        }
        onBlockMove(moves);
        return;
      }

      // A sideways drop retypes the note; only a drop that stayed home is a plain reorder.
      const target = findLaneAtPoint(laneRefs.current, point.x, point.y);
      if (target && target !== category) {
        const moved = itemsRef.current.find((t) => t.id === id);
        const targetEl = laneRefs.current[target];
        if (moved && targetEl) {
          onMoveToLane(id, target, crossLaneDropPosition(targetEl, lanesRef.current[target], moved, point.y, occupied));
          return;
        }
      }

      const current = orderRef.current;
      const committed = itemsRef.current;
      // In the reversed view, index i sits between a visually-higher neighbour (larger position)
      // and a visually-lower one (smaller position); the drop lands at their midpoint.
      if (current.length === committed.length && current.every((t, i) => t.id === committed[committed.length - 1 - i].id)) {
        resync();
        return; // no net move
      }
      const index = current.findIndex((t) => t.id === id);
      if (index === -1) {
        resync();
        return;
      }
      const position = laneDropPosition(current, index, occupied);
      // null = sole note with nothing to sit between; unchanged = dropped back where it started.
      if (position === null || position === current[index].position) {
        resync();
        return;
      }
      onReorderEnd(id, position);
    },
    [category, laneRefs, onBlockDrag, onBlockMove, onDragHoverLane, onMoveToLane, onReorderEnd],
  );

  // The notes riding along leave the lane for the length of the drag (they animate out, the lane
  // closes up), so the note in hand visibly carries the whole selection instead of moving alone.
  // They are not part of the drop maths either way: it reads the lane under the pointer.
  const shown = blockDrag ? order.filter((t) => t.id === blockDrag.leader || !selectedIds.has(t.id)) : order;

  const popupMeta = popup ? JUDGEMENT_META[popup.judgement] : null;

  return (
    <div
      ref={(node) => {
        laneRefs.current[category] = node;
      }}
      className={`relative flex min-w-0 flex-1 snap-start flex-col border-r border-osu-b3/25 transition-colors last:border-r-0 ${
        hovered ? "bg-osu-b3/25" : ""
      }`}
    >
      <div className={`flex items-center justify-center gap-1.5 border-b border-osu-b3/25 py-2 text-[10px] font-semibold uppercase tracking-wider ${meta.text}`}>
        <Icon className="h-3.5 w-3.5" />
        {meta.label}
        <span className="tabular-nums text-osu-f1/60">{items.length}</span>
      </div>
      <Reorder.Group
        axis="y"
        values={shown}
        onReorder={setOrder}
        className="flex min-h-[260px] flex-1 flex-col justify-end gap-1.5 px-1.5 py-2"
      >
        <AnimatePresence initial={false}>
          {shown.map((todo) => (
            <LaneNote
              key={todo.id}
              todo={todo}
              group={todo.groupId ? groupById.get(todo.groupId) ?? null : null}
              selected={selectedIds.has(todo.id)}
              selectMode={selectMode}
              carrying={blockDrag?.leader === todo.id ? blockDrag.count - 1 : 0}
              onHit={onHit}
              onOpen={onOpen}
              onDragStart={handleDragStart}
              onDrag={handleDrag}
              onDragEnd={handleDragEnd}
            />
          ))}
        </AnimatePresence>
      </Reorder.Group>
      {/* Judgement popup, sat on the line like in-game */}
      <AnimatePresence>
        {popup && popupMeta && (
          <motion.div
            key={popup.key}
            initial={{ scale: 1.7, opacity: 0 }}
            animate={{ scale: 1, opacity: 1 }}
            exit={{ scale: 0.8, opacity: 0, transition: { duration: 0.15 } }}
            transition={{ type: "spring", stiffness: 520, damping: 22 }}
            className="pointer-events-none absolute inset-x-0 bottom-1.5 z-10 text-center"
          >
            <span className={`text-xl font-black italic tracking-wide ${popupMeta.text}`} style={{ textShadow: popupMeta.glow }}>
              {popup.judgement}
            </span>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Note (one open todo on the field)
// ---------------------------------------------------------------------------

function LaneNote({
  todo,
  group,
  selected,
  selectMode,
  carrying,
  onHit,
  onOpen,
  onDragStart,
  onDrag,
  onDragEnd,
}: {
  todo: AdminTodo;
  group: AdminTodoGroup | null;
  selected: boolean;
  selectMode: boolean;
  // How many other notes this one is carrying, when it is the one in hand.
  carrying: number;
  onHit: (todo: AdminTodo) => void;
  onOpen: (todo: AdminTodo) => void;
  onDragStart: (id: string) => void;
  onDrag: (point: { x: number; y: number }) => void;
  onDragEnd: (id: string, point: { x: number; y: number }) => void;
}) {
  const meta = CATEGORY_META[todo.category];
  // Distinguish a drag-drop from a plain click so dropping a note never opens the editor.
  const dragging = useRef(false);

  return (
    <Reorder.Item
      value={todo}
      layout
      data-todo-id={todo.id}
      // Overrides Reorder's y-axis lock (its own `drag` prop is set before ours), so a note can be
      // thrown sideways onto another lane. Reorder.Item forces dragSnapToOrigin, so it springs back
      // and re-renders from the committed data either way.
      drag
      // With a modifier down the press belongs to the selection, not to a drag.
      dragListener={!selectMode}
      onDragStart={() => {
        dragging.current = true;
        onDragStart(todo.id);
      }}
      onDrag={(event, info) => onDrag(dropPoint(event, info))}
      onDragEnd={(event, info) => {
        onDragEnd(todo.id, dropPoint(event, info));
        requestAnimationFrame(() => {
          dragging.current = false;
        });
      }}
      onClick={() => {
        if (!dragging.current) onOpen(todo);
      }}
      whileDrag={{ scale: 1.04, zIndex: 20 }}
      initial={{ opacity: 0, y: -18 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: 12, scale: 0.9, transition: { duration: 0.14 } }}
      transition={{ duration: 0.18, ease: "easeOut" }}
      style={{ touchAction: "pan-y" }}
      className={`group relative select-none rounded-md border border-osu-b3/50 border-t-2 bg-osu-b4/60 transition-colors hover:border-osu-b3 ${
        selectMode ? "cursor-crosshair" : "cursor-grab active:cursor-grabbing"
      } ${meta.edge} ${selected ? "ring-1 ring-osu-blue/80" : ""} ${todo.priority === "low" ? "opacity-70" : ""}`}
    >
      <div className="flex items-start gap-1.5 p-1.5 pl-2">
        <div className="min-w-0 flex-1">
          <p className="break-words text-[11px] leading-snug text-osu-l1 line-clamp-2">{todo.title}</p>
          <div className="mt-1 flex items-center gap-1.5 text-[9px] text-osu-f1/60">
            <TodoSeq seq={todo.seq} />
            {todo.priority === "high" && (
              <span className="inline-flex items-center gap-1 font-semibold uppercase tracking-wide text-osu-red-light">
                <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-osu-red-light" />
                high
              </span>
            )}
            {todo.notes && <AlignLeft className="h-2.5 w-2.5" />}
            <span>{formatShortDate(todo.createdAt)}</span>
            {carrying > 0 && <span className="font-semibold text-osu-blue">+{carrying}</span>}
            {group && (
              <span className={`inline-flex min-w-0 items-center gap-1 ${GROUP_COLOR_META[group.color].text}`}>
                <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${GROUP_COLOR_META[group.color].dot}`} />
                <span className="truncate">{group.name}</span>
              </span>
            )}
          </div>
        </div>
        {/* Hover reveals the tick on desktop; touch has no hover, so it stays visible there. */}
        <button
          type="button"
          aria-label="Hit (mark as done)"
          onPointerDown={(event) => event.stopPropagation()}
          onClick={(event) => {
            event.stopPropagation();
            onHit(todo);
          }}
          className="mt-0.5 inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-full border border-osu-b3/60 bg-osu-b6/40 text-osu-f1/40 transition-colors hover:border-osu-green hover:text-osu-green cursor-pointer sm:h-5 sm:w-5 sm:text-transparent"
        >
          <Check className="h-3 w-3" />
        </button>
      </div>
    </Reorder.Item>
  );
}

// ---------------------------------------------------------------------------
// Queue (every open todo as one do-next list, regardless of category)
// ---------------------------------------------------------------------------

function Queue({
  items,
  positionPeers,
  onHit,
  onOpen,
  onReorderEnd,
  groupById,
  selectedIds,
  selectMode,
  onBlockMove,
  blockDrag,
  onBlockDrag,
}: {
  // Position asc: first row is the next thing to do.
  items: AdminTodo[];
  // Every todo that still owns a position (open plus held) - `position` is global, so a drop has to
  // dodge positions held by rows that aren't in this list.
  positionPeers: AdminTodo[];
  onHit: (todo: AdminTodo) => void;
  onOpen: (todo: AdminTodo) => void;
  onReorderEnd: (id: string, position: number) => void;
  groupById: Map<string, AdminTodoGroup>;
  selectedIds: Set<string>;
  selectMode: boolean;
  // Dragging a picked row drags every picked row; the board owns which one is leading.
  onBlockMove: (moves: BlockMove[]) => void;
  blockDrag: BlockDrag;
  onBlockDrag: (drag: BlockDrag) => void;
}) {
  const [order, setOrder] = useState<AdminTodo[]>(items);
  const dragging = useRef(false);
  useEffect(() => {
    // `items` gets a fresh identity on every todo change, so a response landing mid-drag would
    // reset the row under the pointer and the drop would then read as "no net move".
    if (dragging.current) return;
    setOrder(items);
  }, [items]);
  const orderRef = useRef(order);
  orderRef.current = order;
  const itemsRef = useRef(items);
  itemsRef.current = items;
  const positionPeersRef = useRef(positionPeers);
  positionPeersRef.current = positionPeers;
  const selectedIdsRef = useRef(selectedIds);
  selectedIdsRef.current = selectedIds;
  // The rows travelling with the one under the pointer, fixed at the start of the drag so a
  // selection change mid-flight can't split the block.
  const block = useRef<{ leader: string; ids: Set<string> } | null>(null);

  const handleDragStart = useCallback(
    (id: string) => {
      dragging.current = true;
      const picked = itemsRef.current.filter((t) => selectedIdsRef.current.has(t.id));
      block.current = selectedIdsRef.current.has(id) && picked.length > 1
        ? { leader: id, ids: new Set(picked.map((t) => t.id)) }
        : null;
      onBlockDrag(block.current ? { leader: id, count: picked.length } : null);
    },
    [onBlockDrag],
  );

  const handleDragEnd = useCallback(
    (id: string) => {
      dragging.current = false;
      const carried = block.current;
      block.current = null;
      onBlockDrag(null);
      const current = orderRef.current;
      const committed = itemsRef.current;
      const resync = () => setOrder(itemsRef.current);

      // A dragged selection lands whole: the rows it left behind close up, and the block slots in
      // where the dragged row was dropped, keeping the order it already read in.
      if (carried && carried.leader === id) {
        const members = committed.filter((t) => carried.ids.has(t.id));
        // The dragged row keeps its live slot; the rest of the block is lifted out of the list, so
        // the gap it drops into is measured against the rows that are actually staying put.
        const rest = current.filter((t) => t.id === id || !carried.ids.has(t.id));
        const index = rest.findIndex((t) => t.id === id);
        if (members.length < 2 || index === -1) {
          resync();
          return;
        }
        const landed = [...rest.slice(0, index), ...members, ...rest.slice(index + 1)];
        if (landed.length === committed.length && landed.every((t, i) => t.id === committed[i].id)) {
          resync();
          return; // no net move
        }
        const free = positionPeersRef.current.filter((t) => !carried.ids.has(t.id)).map((t) => t.position);
        const positions = blockPositions(free, rest[index - 1]?.position ?? null, rest[index + 1]?.position ?? null, members.length);
        if (!positions) {
          resync();
          return;
        }
        onBlockMove(members.map((todo, i) => ({ id: todo.id, position: positions[i] })));
        return;
      }

      if (current.length === committed.length && current.every((t, i) => t.id === committed[i].id)) {
        resync();
        return; // no net move
      }
      const index = current.findIndex((t) => t.id === id);
      if (index === -1) {
        resync();
        return;
      }
      const occupied = positionPeersRef.current.filter((t) => t.id !== id).map((t) => t.position);
      const position = queueDropPosition(current, index, occupied);
      // null = sole row with nothing to sit between; unchanged = dropped back where it started.
      if (position === null || position === current[index].position) {
        resync();
        return;
      }
      onReorderEnd(id, position);
    },
    [onBlockDrag, onBlockMove, onReorderEnd],
  );

  // The rows riding along leave the list for the length of the drag (they animate out, the queue
  // closes up), so the row in hand visibly carries the whole selection instead of moving alone.
  // Dropping them from `order` is safe: the drop reads the rows that stayed, and the block is
  // rebuilt from the committed data.
  const shown = blockDrag ? order.filter((t) => t.id === blockDrag.leader || !selectedIds.has(t.id)) : order;

  return (
    <Reorder.Group axis="y" values={shown} onReorder={setOrder} className="flex flex-col gap-1 p-2">
      <AnimatePresence initial={false}>
        {shown.map((todo, index) => (
          <QueueRow
            key={todo.id}
            todo={todo}
            rank={index + 1}
            group={todo.groupId ? groupById.get(todo.groupId) ?? null : null}
            selected={selectedIds.has(todo.id)}
            selectMode={selectMode}
            carrying={blockDrag?.leader === todo.id ? blockDrag.count - 1 : 0}
            onHit={onHit}
            onOpen={onOpen}
            onDragStart={handleDragStart}
            onDragEnd={handleDragEnd}
          />
        ))}
      </AnimatePresence>
    </Reorder.Group>
  );
}

function QueueRow({
  todo,
  rank,
  group,
  selected,
  selectMode,
  carrying,
  onHit,
  onOpen,
  onDragStart,
  onDragEnd,
}: {
  todo: AdminTodo;
  rank: number;
  group: AdminTodoGroup | null;
  selected: boolean;
  selectMode: boolean;
  // How many other rows this one is carrying, when it is the one in hand.
  carrying: number;
  onHit: (todo: AdminTodo) => void;
  onOpen: (todo: AdminTodo) => void;
  onDragStart: (id: string) => void;
  onDragEnd: (id: string) => void;
}) {
  const meta = CATEGORY_META[todo.category];
  const CategoryIcon = meta.Icon;
  const dragging = useRef(false);

  return (
    <Reorder.Item
      value={todo}
      layout
      data-todo-id={todo.id}
      dragListener={!selectMode}
      onDragStart={() => {
        dragging.current = true;
        onDragStart(todo.id);
      }}
      onDragEnd={() => {
        onDragEnd(todo.id);
        requestAnimationFrame(() => {
          dragging.current = false;
        });
      }}
      onClick={() => {
        if (!dragging.current) onOpen(todo);
      }}
      whileDrag={{ scale: 1.01, zIndex: 20 }}
      initial={{ opacity: 0, y: -8 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: 8, scale: 0.98, transition: { duration: 0.14 } }}
      transition={{ duration: 0.16, ease: "easeOut" }}
      style={{ touchAction: "pan-y" }}
      className={`group flex select-none items-center gap-2 rounded-md border border-osu-b3/40 border-l-2 bg-osu-b4/40 px-2 py-2 transition-colors hover:border-osu-b3 sm:py-1.5 ${
        selectMode ? "cursor-crosshair" : "cursor-grab active:cursor-grabbing"
      } ${meta.edgeLeft} ${selected ? "ring-1 ring-osu-blue/80" : ""} ${todo.priority === "low" ? "opacity-70" : ""}`}
    >
      {/* The whole row is the drag handle, so the grip is decoration - drop it before the title. */}
      <GripVertical className="hidden h-3.5 w-3.5 shrink-0 text-osu-f1/30 group-hover:text-osu-f1/60 sm:block" />
      <span className="w-5 shrink-0 text-right text-[10px] font-bold tabular-nums text-osu-f1/50">
        {carrying > 0 ? <span className="text-osu-blue">+{carrying}</span> : rank}
      </span>
      <TodoSeq seq={todo.seq} className="shrink-0 text-[10px] sm:w-8" />
      <CategoryIcon className={`h-3 w-3 shrink-0 ${meta.text}`} />
      <span className="min-w-0 flex-1 truncate text-xs text-osu-l1">{todo.title}</span>
      {group && (
        <span className={`hidden max-w-[120px] shrink-0 items-center gap-1 text-[10px] font-semibold sm:inline-flex ${GROUP_COLOR_META[group.color].text}`}>
          <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${GROUP_COLOR_META[group.color].dot}`} />
          <span className="truncate">{group.name}</span>
        </span>
      )}
      {todo.priority === "high" && (
        <span className="h-1.5 w-1.5 shrink-0 animate-pulse rounded-full bg-osu-red-light" title="High priority" />
      )}
      {todo.notes && <AlignLeft className="h-2.5 w-2.5 shrink-0 text-osu-f1/60" />}
      <span className="hidden shrink-0 text-[10px] tabular-nums text-osu-f1/50 sm:inline">{formatShortDate(todo.createdAt)}</span>
      <button
        type="button"
        aria-label="Hit (mark as done)"
        onPointerDown={(event) => event.stopPropagation()}
        onClick={(event) => {
          event.stopPropagation();
          onHit(todo);
        }}
        className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-full border border-osu-b3/60 bg-osu-b6/40 text-osu-f1/40 transition-colors hover:border-osu-green hover:text-osu-green cursor-pointer sm:h-5 sm:w-5 sm:text-transparent"
      >
        <Check className="h-3 w-3" />
      </button>
    </Reorder.Item>
  );
}

// ---------------------------------------------------------------------------
// Hold row (a parked todo, waiting to be resumed)
// ---------------------------------------------------------------------------

function HoldRow({
  todo,
  onResume,
  onOpen,
  onDelete,
}: {
  todo: AdminTodo;
  onResume: (todo: AdminTodo) => void;
  onOpen: (todo: AdminTodo) => void;
  onDelete: (todo: AdminTodo) => void;
}) {
  const [confirmDelete, setConfirmDelete] = useState(false);
  useEffect(() => {
    if (!confirmDelete) return;
    const id = window.setTimeout(() => setConfirmDelete(false), 4_000);
    return () => window.clearTimeout(id);
  }, [confirmDelete]);

  const meta = CATEGORY_META[todo.category];
  const CategoryIcon = meta.Icon;

  return (
    <div className="group flex items-center gap-2 rounded-lg border border-osu-b3/30 bg-osu-b4/20 px-2.5 py-1.5">
      <Pause className="h-3 w-3 shrink-0 text-osu-f1/50" />
      <CategoryIcon className={`h-3 w-3 shrink-0 ${meta.text}`} />
      <TodoSeq seq={todo.seq} className="text-[10px]" />
      <button
        type="button"
        onClick={() => onOpen(todo)}
        className="min-w-0 flex-1 truncate text-left text-xs text-osu-f1 hover:text-osu-l1 cursor-pointer"
      >
        {todo.title}
      </button>
      {todo.notes && <AlignLeft className="h-2.5 w-2.5 shrink-0 text-osu-f1/60" />}
      <span className="hidden shrink-0 text-[10px] tabular-nums text-osu-f1/50 sm:inline">{formatShortDate(todo.updatedAt)}</span>
      {/* Same reveal-on-hover caveat as the results rows: always shown on touch. */}
      <button
        type="button"
        onClick={() => onResume(todo)}
        aria-label="Put back on the field"
        className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-osu-f1 opacity-100 transition hover:bg-osu-b3/50 hover:text-osu-l1 cursor-pointer sm:h-6 sm:w-6 sm:opacity-0 sm:group-hover:opacity-100"
      >
        <Play className="h-3 w-3" />
      </button>
      {confirmDelete ? (
        <button
          type="button"
          onClick={() => {
            setConfirmDelete(false);
            onDelete(todo);
          }}
          className="inline-flex h-8 shrink-0 items-center gap-1 rounded-md border border-osu-red/60 bg-osu-red/25 px-1.5 text-[10px] font-semibold uppercase tracking-wider text-white hover:bg-osu-red/35 cursor-pointer sm:h-6"
        >
          <Trash2 className="h-3 w-3" />
          Sure?
        </button>
      ) : (
        <button
          type="button"
          onClick={() => setConfirmDelete(true)}
          aria-label="Delete"
          className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-osu-f1 opacity-100 transition hover:bg-osu-red/15 hover:text-osu-red cursor-pointer sm:h-6 sm:w-6 sm:opacity-0 sm:group-hover:opacity-100"
        >
          <Trash2 className="h-3 w-3" />
        </button>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Results row (cleared todo with its judgement)
// ---------------------------------------------------------------------------

function DoneRow({
  todo,
  onUndo,
  onDelete,
}: {
  todo: AdminTodo;
  onUndo: (todo: AdminTodo) => void;
  onDelete: (todo: AdminTodo) => void;
}) {
  const [confirmDelete, setConfirmDelete] = useState(false);
  useEffect(() => {
    if (!confirmDelete) return;
    const id = window.setTimeout(() => setConfirmDelete(false), 4_000);
    return () => window.clearTimeout(id);
  }, [confirmDelete]);

  const meta = CATEGORY_META[todo.category];
  const CategoryIcon = meta.Icon;
  const judgement = judgeTodo(todo.createdAt, todo.doneAt ?? todo.updatedAt);
  const jm = JUDGEMENT_META[judgement];

  return (
    <div className="group flex items-center gap-2 rounded-lg border border-osu-b3/30 bg-osu-b4/20 px-2.5 py-1.5">
      <span className={`w-9 shrink-0 text-center text-[10px] font-black italic ${jm.text}`}>{judgement}</span>
      <CategoryIcon className={`h-3 w-3 shrink-0 ${meta.text}`} />
      <TodoSeq seq={todo.seq} className="text-[10px]" />
      <span className="min-w-0 flex-1 truncate text-xs text-osu-f1 line-through">{todo.title}</span>
      <span className="hidden shrink-0 text-[10px] tabular-nums text-osu-f1/50 sm:inline">
        {formatShortDate(todo.doneAt ?? todo.updatedAt)}
      </span>
      {/* Reveal-on-hover only works with a real pointer: the group-hover variant maps to :active on
          touch, so these would vanish the moment a finger lifted to reach them. Always shown on
          small screens instead. */}
      <button
        type="button"
        onClick={() => onUndo(todo)}
        aria-label="Send back to the field"
        className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-osu-f1 opacity-100 transition hover:bg-osu-b3/50 hover:text-osu-l1 cursor-pointer sm:h-6 sm:w-6 sm:opacity-0 sm:group-hover:opacity-100"
      >
        <RotateCcw className="h-3 w-3" />
      </button>
      {confirmDelete ? (
        <button
          type="button"
          onClick={() => {
            setConfirmDelete(false);
            onDelete(todo);
          }}
          className="inline-flex h-8 shrink-0 items-center gap-1 rounded-md border border-osu-red/60 bg-osu-red/25 px-1.5 text-[10px] font-semibold uppercase tracking-wider text-white hover:bg-osu-red/35 cursor-pointer sm:h-6"
        >
          <Trash2 className="h-3 w-3" />
          Sure?
        </button>
      ) : (
        <button
          type="button"
          onClick={() => setConfirmDelete(true)}
          aria-label="Delete"
          className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-osu-f1 opacity-100 transition hover:bg-osu-red/15 hover:text-osu-red cursor-pointer sm:h-6 sm:w-6 sm:opacity-0 sm:group-hover:opacity-100"
        >
          <Trash2 className="h-3 w-3" />
        </button>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Edit modal (lanes are too narrow for inline editing)
// ---------------------------------------------------------------------------

function NoteModal({
  todo,
  groups,
  onClose,
  onSave,
  onDelete,
  onHold,
}: {
  todo: AdminTodo;
  groups: AdminTodoGroup[];
  onClose: () => void;
  onSave: (id: string, patch: EditPatch) => Promise<void>;
  onDelete: (todo: AdminTodo) => void;
  onHold: (todo: AdminTodo) => void;
}) {
  const [draft, setDraft] = useState<EditPatch>({
    title: todo.title,
    notes: todo.notes ?? "",
    category: todo.category,
    priority: todo.priority,
    groupId: todo.groupId,
  });
  const [saving, setSaving] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  useEffect(() => {
    if (!confirmDelete) return;
    const id = window.setTimeout(() => setConfirmDelete(false), 4_000);
    return () => window.clearTimeout(id);
  }, [confirmDelete]);

  const commit = async () => {
    if (!draft.title.trim() || saving) return;
    setSaving(true);
    try {
      await onSave(todo.id, draft);
      onClose();
    } catch {
      // error surfaces on the page; keep the form open so edits aren't lost.
    } finally {
      setSaving(false);
    }
  };

  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0, transition: { duration: 0.1 } }}
      transition={{ duration: 0.12 }}
      onClick={onClose}
      data-no-marquee
      className="fixed inset-0 z-[90] flex items-center justify-center bg-black/60 p-4"
    >
      <motion.div
        initial={{ scale: 0.96, y: 8 }}
        animate={{ scale: 1, y: 0 }}
        exit={{ scale: 0.96, y: 8 }}
        transition={{ duration: 0.12 }}
        onClick={(event) => event.stopPropagation()}
        className="w-full max-w-md rounded-xl border border-osu-b3/50 bg-osu-b5 p-4 shadow-[0_12px_28px_rgba(0,0,0,0.55)]"
      >
        <div className="mb-3 flex items-center justify-between">
          <p className="flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wider text-osu-f1">
            <TodoSeq seq={todo.seq} className="text-osu-l2" />
            Edit note · added {formatShortDate(todo.createdAt)}
          </p>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="inline-flex h-6 w-6 items-center justify-center rounded-md text-osu-f1 transition-colors hover:bg-osu-b3/50 hover:text-osu-l1 cursor-pointer"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
        <input
          value={draft.title}
          onChange={(event) => setDraft((d) => ({ ...d, title: event.target.value }))}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey) {
              event.preventDefault();
              void commit();
            }
          }}
          maxLength={500}
          autoFocus
          className="w-full rounded-md border border-osu-b3/50 bg-osu-b6/70 px-3 py-2 text-sm text-osu-l1 focus:border-osu-c2/60 focus:outline-none"
        />
        <textarea
          value={draft.notes}
          onChange={(event) => setDraft((d) => ({ ...d, notes: event.target.value }))}
          maxLength={5000}
          rows={3}
          placeholder="Notes (optional)"
          className={`mt-2 ${TEXTAREA_CLASS}`}
        />
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <SelectMenu
            value={draft.category}
            options={CATEGORY_OPTIONS}
            onChange={(category) => setDraft((d) => ({ ...d, category }))}
            ariaLabel="Category"
          />
          <PrioritySegmented value={draft.priority} onChange={(priority) => setDraft((d) => ({ ...d, priority }))} />
          {groups.length > 0 && (
            <SelectMenu
              value={draft.groupId ?? NO_GROUP}
              options={groupOptions(groups)}
              onChange={(groupId) => setDraft((d) => ({ ...d, groupId: groupId === NO_GROUP ? null : groupId }))}
              ariaLabel="Group"
            />
          )}
        </div>
        <div className="mt-3 flex items-center gap-1.5">
          {confirmDelete ? (
            <button
              type="button"
              onClick={() => {
                setConfirmDelete(false);
                onDelete(todo);
                onClose();
              }}
              className="inline-flex h-7 items-center gap-1 rounded-md border border-osu-red/60 bg-osu-red/25 px-2 text-[10px] font-semibold uppercase tracking-wider text-white hover:bg-osu-red/35 cursor-pointer"
            >
              <Trash2 className="h-3.5 w-3.5" />
              Sure?
            </button>
          ) : (
            <button
              type="button"
              onClick={() => setConfirmDelete(true)}
              className="inline-flex h-7 items-center gap-1 rounded-md px-2 text-[11px] font-semibold text-osu-f1 transition-colors hover:bg-osu-red/15 hover:text-osu-red cursor-pointer"
            >
              <Trash2 className="h-3.5 w-3.5" />
              Delete
            </button>
          )}
          {todo.status !== "done" && (
            <button
              type="button"
              onClick={() => {
                onHold(todo);
                onClose();
              }}
              className="inline-flex h-7 items-center gap-1 rounded-md px-2 text-[11px] font-semibold text-osu-f1 transition-colors hover:bg-osu-b3/50 hover:text-osu-l1 cursor-pointer"
            >
              {todo.status === "hold" ? <Play className="h-3.5 w-3.5" /> : <Pause className="h-3.5 w-3.5" />}
              {todo.status === "hold" ? "Resume" : "Hold"}
            </button>
          )}
          <div className="ml-auto flex items-center gap-1.5">
            <button
              type="button"
              onClick={onClose}
              className="rounded-md border border-osu-b3/50 bg-osu-b4/60 px-2.5 py-1 text-[11px] font-semibold text-osu-l2 hover:bg-osu-b3/50 cursor-pointer"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={() => void commit()}
              disabled={!draft.title.trim() || saving}
              className="inline-flex items-center gap-1.5 rounded-md border border-osu-yellow/40 bg-osu-yellow/15 px-2.5 py-1 text-[11px] font-semibold text-osu-yellow hover:bg-osu-yellow/25 disabled:opacity-40 cursor-pointer"
            >
              {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Check className="h-3.5 w-3.5" />}
              Save
            </button>
          </div>
        </div>
      </motion.div>
    </motion.div>
  );
}

// ---------------------------------------------------------------------------
// Selection bar (what a marquee selection can be done to)
// ---------------------------------------------------------------------------

function SelectionBar({
  count,
  groups,
  onGroup,
  onCreateGroup,
  onDone,
  onHold,
  onDelete,
  onClear,
}: {
  count: number;
  groups: AdminTodoGroup[];
  onGroup: (groupId: string | null) => void;
  onCreateGroup: (name: string) => void;
  onDone: () => void;
  onHold: () => void;
  onDelete: () => void;
  onClear: () => void;
}) {
  const [armed, setArmed] = useState(false);
  useEffect(() => {
    if (!armed) return;
    const id = window.setTimeout(() => setArmed(false), 4_000);
    return () => window.clearTimeout(id);
  }, [armed]);
  // A picker whose value is the action: it never shows the selection's current group, because a
  // selection can span several. Reset to "No group" after each pick so the label reads the same.
  const [picker, setPicker] = useState<string>(NO_GROUP);
  // Naming a new group happens in the bar itself: the selection is already made, and sending it to
  // the groups modal would mean picking the same notes again afterwards.
  const [naming, setNaming] = useState(false);
  const [draftName, setDraftName] = useState("");
  const commitNewGroup = () => {
    const name = draftName.trim();
    if (!name) return;
    setNaming(false);
    setDraftName("");
    onCreateGroup(name);
  };

  return (
    <motion.div
      data-no-marquee
      initial={{ opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: 12, transition: { duration: 0.1 } }}
      transition={{ duration: 0.14, ease: "easeOut" }}
      className="fixed inset-x-0 bottom-4 z-[70] mx-auto flex w-fit max-w-[calc(100vw-2rem)] flex-wrap items-center gap-2 rounded-lg border border-osu-blue/40 bg-osu-b5/95 px-2.5 py-2 shadow-[0_8px_24px_rgba(0,0,0,0.5)]"
    >
      <span className="text-[11px] font-semibold text-osu-blue">
        {count} selected
      </span>
      {naming ? (
        <div className="flex items-center gap-1.5">
          <input
            value={draftName}
            onChange={(event) => setDraftName(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                commitNewGroup();
              }
              if (event.key === "Escape") {
                event.preventDefault();
                // Stop here rather than letting Escape reach the page and drop the selection.
                event.stopPropagation();
                setNaming(false);
                setDraftName("");
              }
            }}
            maxLength={60}
            autoFocus
            placeholder="Group name..."
            className="w-[150px] rounded-md border border-osu-b3/50 bg-osu-b6/70 px-2 py-1 text-xs text-osu-l1 placeholder:text-osu-f1/60 focus:border-osu-c2/60 focus:outline-none"
          />
          <button
            type="button"
            onClick={commitNewGroup}
            disabled={!draftName.trim()}
            aria-label="Create the group and put the selection in it"
            className="inline-flex h-7 w-7 items-center justify-center rounded-md text-osu-f1 transition-colors hover:bg-osu-b3/50 hover:text-osu-green disabled:opacity-40 cursor-pointer"
          >
            <Check className="h-3.5 w-3.5" />
          </button>
          <button
            type="button"
            onClick={() => {
              setNaming(false);
              setDraftName("");
            }}
            aria-label="Cancel"
            className="inline-flex h-7 w-7 items-center justify-center rounded-md text-osu-f1 transition-colors hover:bg-osu-b3/50 hover:text-osu-l1 cursor-pointer"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
      ) : (
        <SelectMenu
          value={picker}
          options={[...groupOptions(groups), { value: NEW_GROUP, label: "New group...", icon: Plus }]}
          onChange={(groupId) => {
            setPicker(NO_GROUP);
            if (groupId === NEW_GROUP) {
              setNaming(true);
              return;
            }
            onGroup(groupId === NO_GROUP ? null : groupId);
          }}
          ariaLabel="Put the selection in a group"
        />
      )}
      <button
        type="button"
        onClick={onDone}
        className="inline-flex h-7 items-center gap-1.5 rounded-md px-2 text-[11px] font-semibold text-osu-f1 transition-colors hover:text-osu-green cursor-pointer"
      >
        <Check className="h-3.5 w-3.5" />
        Hit
      </button>
      <button
        type="button"
        onClick={onHold}
        className="inline-flex h-7 items-center gap-1.5 rounded-md px-2 text-[11px] font-semibold text-osu-f1 transition-colors hover:text-osu-l1 cursor-pointer"
      >
        <Pause className="h-3.5 w-3.5" />
        Hold
      </button>
      {armed ? (
        <button
          type="button"
          onClick={() => {
            setArmed(false);
            onDelete();
          }}
          className="inline-flex h-7 items-center gap-1 rounded-md border border-osu-red/60 bg-osu-red/25 px-2 text-[10px] font-semibold uppercase tracking-wider text-white hover:bg-osu-red/35 cursor-pointer"
        >
          <Trash2 className="h-3.5 w-3.5" />
          Delete {count}?
        </button>
      ) : (
        <button
          type="button"
          onClick={() => setArmed(true)}
          className="inline-flex h-7 items-center gap-1.5 rounded-md px-2 text-[11px] font-semibold text-osu-f1 transition-colors hover:text-osu-red cursor-pointer"
        >
          <Trash2 className="h-3.5 w-3.5" />
          Delete
        </button>
      )}
      <button
        type="button"
        onClick={onClear}
        className="inline-flex h-7 items-center gap-1.5 rounded-md px-2 text-[11px] font-semibold text-osu-f1 transition-colors hover:text-osu-l1 cursor-pointer"
      >
        <X className="h-3.5 w-3.5" />
        Clear
      </button>
    </motion.div>
  );
}

// ---------------------------------------------------------------------------
// Groups modal (name them, colour them, delete them)
// ---------------------------------------------------------------------------

function GroupsModal({
  groups,
  counts,
  onClose,
  onSave,
  onDelete,
}: {
  groups: AdminTodoGroup[];
  counts: Map<string, number>;
  onClose: () => void;
  onSave: (input: { id?: string; name: string; color: TodoGroupColor }) => Promise<AdminTodoGroup | null>;
  onDelete: (id: string) => void;
}) {
  const [draftName, setDraftName] = useState("");
  const [draftColor, setDraftColor] = useState<TodoGroupColor>(() => nextGroupColor(groups.map((group) => group.color)));
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  const addGroup = async () => {
    const name = draftName.trim();
    if (!name || saving) return;
    setSaving(true);
    await onSave({ name, color: draftColor });
    setSaving(false);
    setDraftName("");
    // The next one offers the next unused colour, so a board of groups reads as different colours
    // without anyone picking them one at a time.
    setDraftColor(nextGroupColor([...groups.map((group) => group.color), draftColor]));
  };

  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0, transition: { duration: 0.1 } }}
      transition={{ duration: 0.12 }}
      onClick={onClose}
      data-no-marquee
      className="fixed inset-0 z-[90] flex items-center justify-center bg-black/60 p-4"
    >
      <motion.div
        initial={{ scale: 0.96, y: 8 }}
        animate={{ scale: 1, y: 0 }}
        exit={{ scale: 0.96, y: 8 }}
        transition={{ duration: 0.12 }}
        onClick={(event) => event.stopPropagation()}
        className="w-full max-w-md rounded-xl border border-osu-b3/50 bg-osu-b5 p-4 shadow-[0_12px_28px_rgba(0,0,0,0.55)]"
      >
        <div className="mb-3 flex items-center justify-between">
          <p className="text-[10px] font-semibold uppercase tracking-wider text-osu-f1">Groups</p>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="inline-flex h-6 w-6 items-center justify-center rounded-md text-osu-f1 transition-colors hover:bg-osu-b3/50 hover:text-osu-l1 cursor-pointer"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>

        <div className="flex flex-col gap-1.5">
          {groups.map((group) => (
            <GroupEditRow
              key={group.id}
              group={group}
              count={counts.get(group.id) ?? 0}
              onSave={onSave}
              onDelete={onDelete}
            />
          ))}
          {groups.length === 0 && (
            <p className="py-3 text-center text-xs text-osu-f1">No groups yet. Name the first one below.</p>
          )}
        </div>

        <div className="mt-3 flex items-center gap-2">
          <ColorDots value={draftColor} onChange={setDraftColor} />
          <input
            value={draftName}
            onChange={(event) => setDraftName(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                void addGroup();
              }
            }}
            maxLength={60}
            placeholder="New group..."
            className="min-w-0 flex-1 rounded-md border border-osu-b3/50 bg-osu-b6/70 px-2.5 py-1.5 text-xs text-osu-l1 placeholder:text-osu-f1/60 focus:border-osu-c2/60 focus:outline-none"
          />
          <button
            type="button"
            onClick={() => void addGroup()}
            disabled={!draftName.trim() || saving}
            className="inline-flex h-8 shrink-0 items-center gap-1.5 rounded-md border border-osu-yellow/40 bg-osu-yellow/15 px-2.5 text-[11px] font-semibold text-osu-yellow transition-colors hover:bg-osu-yellow/25 disabled:cursor-not-allowed disabled:opacity-40 cursor-pointer"
          >
            {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Plus className="h-3.5 w-3.5" />}
            Add
          </button>
        </div>
      </motion.div>
    </motion.div>
  );
}

function GroupEditRow({
  group,
  count,
  onSave,
  onDelete,
}: {
  group: AdminTodoGroup;
  count: number;
  onSave: (input: { id?: string; name: string; color: TodoGroupColor }) => Promise<AdminTodoGroup | null>;
  onDelete: (id: string) => void;
}) {
  const [name, setName] = useState(group.name);
  const [confirmDelete, setConfirmDelete] = useState(false);
  useEffect(() => {
    if (!confirmDelete) return;
    const id = window.setTimeout(() => setConfirmDelete(false), 4_000);
    return () => window.clearTimeout(id);
  }, [confirmDelete]);
  // The row saves as you leave it rather than behind a per-row save button.
  const commitName = () => {
    const trimmed = name.trim();
    if (!trimmed || trimmed === group.name) {
      setName(group.name);
      return;
    }
    void onSave({ id: group.id, name: trimmed, color: group.color });
  };

  return (
    <div className="flex items-center gap-2 rounded-lg border border-osu-b3/30 bg-osu-b4/20 px-2 py-1.5">
      <ColorDots value={group.color} onChange={(color) => void onSave({ id: group.id, name: group.name, color })} />
      <input
        value={name}
        onChange={(event) => setName(event.target.value)}
        onBlur={commitName}
        onKeyDown={(event) => {
          if (event.key === "Enter") event.currentTarget.blur();
          if (event.key === "Escape") setName(group.name);
        }}
        maxLength={60}
        className="min-w-0 flex-1 rounded-md border border-transparent bg-transparent px-1.5 py-1 text-xs text-osu-l1 focus:border-osu-b3/50 focus:bg-osu-b6/60 focus:outline-none"
      />
      <span className="shrink-0 text-[10px] tabular-nums text-osu-f1/60">{count}</span>
      {confirmDelete ? (
        <button
          type="button"
          onClick={() => {
            setConfirmDelete(false);
            onDelete(group.id);
          }}
          className="inline-flex h-6 shrink-0 items-center gap-1 rounded-md border border-osu-red/60 bg-osu-red/25 px-1.5 text-[10px] font-semibold uppercase tracking-wider text-white hover:bg-osu-red/35 cursor-pointer"
          title="The tasks stay; they just lose the group"
        >
          <Trash2 className="h-3 w-3" />
          Sure?
        </button>
      ) : (
        <button
          type="button"
          onClick={() => setConfirmDelete(true)}
          aria-label={`Delete group ${group.name}`}
          className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-osu-f1 transition hover:bg-osu-red/15 hover:text-osu-red cursor-pointer"
        >
          <Trash2 className="h-3 w-3" />
        </button>
      )}
    </div>
  );
}

/** The palette, as dots. Seven colours is the whole set, so they fit on one row. */
function ColorDots({ value, onChange }: { value: TodoGroupColor; onChange: (color: TodoGroupColor) => void }) {
  return (
    <div className="flex shrink-0 items-center gap-1" role="group" aria-label="Group color">
      {GROUP_COLOR_ORDER.map((color) => (
        <button
          key={color}
          type="button"
          onClick={() => onChange(color)}
          aria-label={GROUP_COLOR_META[color].label}
          aria-pressed={color === value}
          className={`h-3 w-3 rounded-full transition-transform cursor-pointer ${GROUP_COLOR_META[color].dot} ${
            color === value ? "scale-125 ring-1 ring-osu-c1/70" : "opacity-50 hover:opacity-100"
          }`}
        />
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Small pieces
// ---------------------------------------------------------------------------

function ClearDoneButton({ count, busy, onClear }: { count: number; busy: boolean; onClear: () => void }) {
  const [armed, setArmed] = useState(false);
  useEffect(() => {
    if (!armed) return;
    const id = window.setTimeout(() => setArmed(false), 4_000);
    return () => window.clearTimeout(id);
  }, [armed]);
  return (
    <button
      type="button"
      disabled={busy}
      onClick={() => {
        if (armed) {
          setArmed(false);
          onClear();
        } else {
          setArmed(true);
        }
      }}
      className={`inline-flex h-7 items-center gap-1.5 rounded-md border px-2.5 text-[11px] font-semibold transition-colors disabled:opacity-50 cursor-pointer ${
        armed
          ? "border-osu-red/60 bg-osu-red/25 text-white hover:bg-osu-red/35"
          : "border-osu-b3/50 bg-osu-b4/40 text-osu-f1 hover:text-osu-l2"
      }`}
    >
      {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Trash2 className="h-3.5 w-3.5" />}
      {armed ? "Clear results?" : `Clear results (${count})`}
    </button>
  );
}
