import { createFileRoute, notFound } from "@tanstack/react-router";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AnimatePresence, motion, Reorder } from "framer-motion";
import {
  AlertTriangle,
  AlignLeft,
  Bug,
  Check,
  ChevronDown,
  Lightbulb,
  ListChecks,
  Loader2,
  Plus,
  RotateCcw,
  Search,
  Sparkles,
  Trash2,
  Wrench,
  X,
} from "lucide-react";
import { canUseAdminFeatures } from "../../lib/auth-shared";
import { SelectMenu, type SelectMenuOption } from "../../components/ui/SelectMenu";
import {
  clearDoneAdminTodos,
  createAdminTodo,
  deleteAdminTodo,
  listAdminTodos,
  updateAdminTodo,
  type AdminTodo,
  type TodoCategory,
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
// top-edge accent (mania note colors); `text` colors the lane header and small icons.
const CATEGORY_META: Record<TodoCategory, { label: string; Icon: typeof Bug; text: string; edge: string }> = {
  task: { label: "Task", Icon: ListChecks, text: "text-osu-l2", edge: "border-t-osu-l2/70" },
  bug: { label: "Bug", Icon: Bug, text: "text-osu-red-light", edge: "border-t-osu-red-light/80" },
  feature: { label: "Feature", Icon: Sparkles, text: "text-osu-blue", edge: "border-t-osu-blue/80" },
  idea: { label: "Idea", Icon: Lightbulb, text: "text-osu-yellow", edge: "border-t-osu-yellow/80" },
  chore: { label: "Chore", Icon: Wrench, text: "text-osu-purple", edge: "border-t-osu-purple/80" },
};
const CATEGORY_ORDER: TodoCategory[] = ["task", "bug", "feature", "idea", "chore"];
const CATEGORY_OPTIONS: SelectMenuOption<TodoCategory>[] = CATEGORY_ORDER.map((key) => ({
  value: key,
  label: CATEGORY_META[key].label,
  icon: CATEGORY_META[key].Icon,
  colorClass: CATEGORY_META[key].text,
}));

const PRIORITY_META: Record<TodoPriority, { label: string; dot: string }> = {
  high: { label: "High", dot: "bg-osu-red-light" },
  normal: { label: "Normal", dot: "bg-osu-c2" },
  low: { label: "Low", dot: "bg-osu-f1/50" },
};
const PRIORITY_ORDER: TodoPriority[] = ["low", "normal", "high"];

// Matches the backend spacing so a drag can drop an item at the midpoint of its two new neighbours.
const POSITION_STEP = 1000;

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
// open before done; open items follow the manual drag order (position asc), done items by most
// recently completed.
function sortTodos(list: AdminTodo[]): AdminTodo[] {
  return list.slice().sort((a, b) => {
    if (a.status !== b.status) return a.status === "open" ? -1 : 1;
    if (a.status === "done") return (b.doneAt ?? 0) - (a.doneAt ?? 0);
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
  return new Date(ms).toLocaleDateString(undefined, { month: "short", day: "numeric" });
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
}

function TodosPage() {
  const [todos, setTodos] = useState<AdminTodo[]>([]);
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
  const [showResults, setShowResults] = useState(false);
  const [clearing, setClearing] = useState(false);
  const [editing, setEditing] = useState<AdminTodo | null>(null);

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
    } catch {
      // the error that triggered the refetch already surfaces on the page.
    }
  }, []);

  useEffect(() => {
    // Decode the hitsound samples before the first hit so it lands on time.
    preloadTodoSfx();
    let alive = true;
    (async () => {
      try {
        const result = await listAdminTodos();
        if (alive) setTodos(sortTodos(result.todos));
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
    (t: AdminTodo) => !query || `${t.title} ${t.notes ?? ""}`.toLowerCase().includes(query),
    [query],
  );

  const openFiltered = useMemo(() => todos.filter((t) => t.status === "open" && matchesSearch(t)), [todos, matchesSearch]);
  const doneFiltered = useMemo(() => todos.filter((t) => t.status === "done" && matchesSearch(t)), [todos, matchesSearch]);

  // Lane contents: open todos split by category, position asc (first = next up, closest to the line).
  const lanes = useMemo(() => {
    const map = { task: [], bug: [], feature: [], idea: [], chore: [] } as Record<TodoCategory, AdminTodo[]>;
    for (const t of openFiltered) map[t.category].push(t);
    return map;
  }, [openFiltered]);

  const openCount = useMemo(() => todos.filter((t) => t.status === "open").length, [todos]);
  const doneAll = useMemo(() => todos.filter((t) => t.status === "done"), [todos]);
  const doneCount = doneAll.length;
  const acc = accuracyOf(doneAll);
  const grade = gradeOf(acc);

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
      // Dropping an open note off the field is a miss; deleting from results is just cleanup.
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

  return (
    <div className="flex-1 bg-osu-b5 min-h-[calc(100vh-60px)]">
      <div className="mx-auto max-w-[1000px] space-y-4 px-4 py-6 sm:px-5">
        {/* Header */}
        <div className="flex items-end justify-between gap-3">
          <div>
            <div className="flex items-center gap-2">
              <span className="h-4 w-1 rounded-full bg-osu-pink" />
              <h1 className="text-sm font-bold uppercase tracking-[0.14em] text-osu-l1">Todo</h1>
            </div>
            <p className="mt-1 text-[11px] text-osu-f1">
              {openCount} on the field{doneCount ? ` · ${doneCount} cleared` : ""} · private notes for the project
            </p>
          </div>
          <div className="relative w-[200px] sm:w-[240px]">
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
            <div className="overflow-x-auto">
              <div className="min-w-[680px]">
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
                    />
                  ))}
                  {openFiltered.length === 0 && (
                    <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
                      <p className="rounded-md bg-osu-b6/70 px-3 py-1.5 text-xs text-osu-f1">
                        {todos.length === 0
                          ? "No notes on the field. Add the first one above."
                          : query
                            ? "Nothing on the field matches this search."
                            : "All clear. Nothing left on the field."}
                      </p>
                    </div>
                  )}
                </div>
                {/* Judgement line */}
                <div className="h-0.5 w-full bg-osu-pink shadow-[0_0_10px_rgba(255,102,171,0.55)]" />
              </div>
            </div>

            {/* Score footer: accuracy + grade, combo, results toggle */}
            <div className="grid grid-cols-3 items-center border-t border-osu-b3/30 px-3 py-2">
              <div className="flex items-center gap-2">
                <span className={`text-sm font-black italic ${grade.text}`}>{grade.label}</span>
                <span className="text-sm font-bold tabular-nums text-osu-l1">{acc.toFixed(2)}%</span>
                <span className="text-[10px] uppercase tracking-wider text-osu-f1/50">acc</span>
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
                <span className="text-[10px] uppercase tracking-wider text-osu-f1/50">cleared</span>
              </div>
              <div className="flex justify-end">
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
            onClose={() => setEditing(null)}
            onSave={handleSave}
            onDelete={handleDelete}
          />
        )}
      </AnimatePresence>
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
}

function Lane({ category, items, popup, onHit, onOpen, onReorderEnd }: LaneProps) {
  const meta = CATEGORY_META[category];
  const Icon = meta.Icon;

  // Downscroll: the lane renders reversed (last position on top, next-up at the bottom touching
  // the judgement line). `order` drives the Reorder.Group during a drag and is resynced from the
  // data whenever the lane's contents change, which never happens mid-drag.
  const [order, setOrder] = useState<AdminTodo[]>(() => [...items].reverse());
  useEffect(() => {
    setOrder([...items].reverse());
  }, [items]);
  const orderRef = useRef(order);
  orderRef.current = order;
  const itemsRef = useRef(items);
  itemsRef.current = items;

  const handleDragEnd = useCallback(
    (id: string) => {
      const current = orderRef.current;
      const committed = itemsRef.current;
      // In the reversed view, index i sits between a visually-higher neighbour (larger position)
      // and a visually-lower one (smaller position); the drop lands at their midpoint.
      if (current.length === committed.length && current.every((t, i) => t.id === committed[committed.length - 1 - i].id)) {
        return; // no net move
      }
      const index = current.findIndex((t) => t.id === id);
      if (index === -1) return;
      const moved = current[index];
      const above = current[index - 1];
      const below = current[index + 1];
      let position: number;
      if (!above && !below) return; // sole note, nothing to reorder
      else if (!above) position = below.position + POSITION_STEP;
      else if (!below) position = above.position - POSITION_STEP;
      else position = (above.position + below.position) / 2;
      if (position === moved.position) return; // dropped back where it started
      onReorderEnd(id, position);
    },
    [onReorderEnd],
  );

  const popupMeta = popup ? JUDGEMENT_META[popup.judgement] : null;

  return (
    <div className="relative flex min-w-0 flex-1 flex-col border-r border-osu-b3/25 last:border-r-0">
      <div className={`flex items-center justify-center gap-1.5 border-b border-osu-b3/25 py-2 text-[10px] font-semibold uppercase tracking-wider ${meta.text}`}>
        <Icon className="h-3.5 w-3.5" />
        {meta.label}
        <span className="tabular-nums text-osu-f1/60">{items.length}</span>
      </div>
      <Reorder.Group
        axis="y"
        values={order}
        onReorder={setOrder}
        className="flex min-h-[260px] flex-1 flex-col justify-end gap-1.5 px-1.5 py-2"
      >
        <AnimatePresence initial={false}>
          {order.map((todo) => (
            <LaneNote key={todo.id} todo={todo} onHit={onHit} onOpen={onOpen} onDragEnd={handleDragEnd} />
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
  onHit,
  onOpen,
  onDragEnd,
}: {
  todo: AdminTodo;
  onHit: (todo: AdminTodo) => void;
  onOpen: (todo: AdminTodo) => void;
  onDragEnd: (id: string) => void;
}) {
  const meta = CATEGORY_META[todo.category];
  // Distinguish a drag-drop from a plain click so dropping a note never opens the editor.
  const dragging = useRef(false);

  return (
    <Reorder.Item
      value={todo}
      layout
      onDragStart={() => {
        dragging.current = true;
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
      whileDrag={{ scale: 1.04, zIndex: 20 }}
      initial={{ opacity: 0, y: -18 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: 12, scale: 0.9, transition: { duration: 0.14 } }}
      transition={{ duration: 0.18, ease: "easeOut" }}
      style={{ touchAction: "pan-y" }}
      className={`group relative cursor-grab select-none rounded-md border border-osu-b3/50 border-t-2 bg-osu-b4/60 transition-colors hover:border-osu-b3 active:cursor-grabbing ${meta.edge} ${
        todo.priority === "low" ? "opacity-70" : ""
      }`}
    >
      <div className="flex items-start gap-1.5 p-1.5 pl-2">
        <div className="min-w-0 flex-1">
          <p className="break-words text-[11px] leading-snug text-osu-l1 line-clamp-2">{todo.title}</p>
          <div className="mt-1 flex items-center gap-1.5 text-[9px] text-osu-f1/60">
            {todo.priority === "high" && (
              <span className="inline-flex items-center gap-1 font-semibold uppercase tracking-wide text-osu-red-light">
                <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-osu-red-light" />
                high
              </span>
            )}
            {todo.notes && <AlignLeft className="h-2.5 w-2.5" />}
            <span>{formatShortDate(todo.createdAt)}</span>
          </div>
        </div>
        <button
          type="button"
          aria-label="Hit (mark as done)"
          onPointerDown={(event) => event.stopPropagation()}
          onClick={(event) => {
            event.stopPropagation();
            onHit(todo);
          }}
          className="mt-0.5 inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-full border border-osu-b3/60 bg-osu-b6/40 text-transparent transition-colors hover:border-osu-green hover:text-osu-green cursor-pointer"
        >
          <Check className="h-3 w-3" />
        </button>
      </div>
    </Reorder.Item>
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
      <span className="min-w-0 flex-1 truncate text-xs text-osu-f1 line-through">{todo.title}</span>
      <span className="shrink-0 text-[10px] tabular-nums text-osu-f1/50">
        {formatShortDate(todo.doneAt ?? todo.updatedAt)}
      </span>
      <button
        type="button"
        onClick={() => onUndo(todo)}
        aria-label="Send back to the field"
        className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-osu-f1 opacity-0 transition hover:bg-osu-b3/50 hover:text-osu-l1 group-hover:opacity-100 cursor-pointer"
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
          className="inline-flex h-6 shrink-0 items-center gap-1 rounded-md border border-osu-red/60 bg-osu-red/25 px-1.5 text-[10px] font-semibold uppercase tracking-wider text-white hover:bg-osu-red/35 cursor-pointer"
        >
          <Trash2 className="h-3 w-3" />
          Sure?
        </button>
      ) : (
        <button
          type="button"
          onClick={() => setConfirmDelete(true)}
          aria-label="Delete"
          className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-osu-f1 opacity-0 transition hover:bg-osu-red/15 hover:text-osu-red group-hover:opacity-100 cursor-pointer"
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
  onClose,
  onSave,
  onDelete,
}: {
  todo: AdminTodo;
  onClose: () => void;
  onSave: (id: string, patch: EditPatch) => Promise<void>;
  onDelete: (todo: AdminTodo) => void;
}) {
  const [draft, setDraft] = useState<EditPatch>({
    title: todo.title,
    notes: todo.notes ?? "",
    category: todo.category,
    priority: todo.priority,
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
          <p className="text-[10px] font-semibold uppercase tracking-wider text-osu-f1">
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
