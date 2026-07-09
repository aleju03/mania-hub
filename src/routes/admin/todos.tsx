import { createFileRoute, notFound } from "@tanstack/react-router";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AnimatePresence, motion, Reorder, useDragControls } from "framer-motion";
import {
  AlertTriangle,
  Bug,
  Check,
  ChevronDown,
  GripVertical,
  Inbox,
  Lightbulb,
  ListChecks,
  Loader2,
  Plus,
  Search,
  Sparkles,
  SquarePen,
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

const CATEGORY_META: Record<TodoCategory, { label: string; Icon: typeof Bug; text: string; pill: string }> = {
  bug: { label: "Bug", Icon: Bug, text: "text-osu-red-light", pill: "text-osu-red-light border-osu-red-light/40 bg-osu-red-light/10" },
  feature: { label: "Feature", Icon: Sparkles, text: "text-osu-blue", pill: "text-osu-blue border-osu-blue/40 bg-osu-blue/10" },
  idea: { label: "Idea", Icon: Lightbulb, text: "text-osu-yellow", pill: "text-osu-yellow border-osu-yellow/40 bg-osu-yellow/10" },
  chore: { label: "Chore", Icon: Wrench, text: "text-osu-purple", pill: "text-osu-purple border-osu-purple/40 bg-osu-purple/10" },
  task: { label: "Task", Icon: ListChecks, text: "text-osu-l2", pill: "text-osu-l2 border-osu-b3/60 bg-osu-b3/25" },
};
const CATEGORY_ORDER: TodoCategory[] = ["task", "bug", "feature", "idea", "chore"];
const CATEGORY_OPTIONS: SelectMenuOption<TodoCategory>[] = CATEGORY_ORDER.map((key) => ({
  value: key,
  label: CATEGORY_META[key].label,
  icon: CATEGORY_META[key].Icon,
  colorClass: CATEGORY_META[key].text,
}));

const PRIORITY_META: Record<TodoPriority, { label: string; bar: string | null; chip: string; dot: string }> = {
  high: { label: "High", bar: "bg-osu-red-light", chip: "text-osu-red-light", dot: "bg-osu-red-light" },
  normal: { label: "Normal", bar: "bg-osu-b3/70", chip: "text-osu-f1", dot: "bg-osu-c2" },
  low: { label: "Low", bar: null, chip: "text-osu-f1/60", dot: "bg-osu-f1/50" },
};
const PRIORITY_ORDER: TodoPriority[] = ["low", "normal", "high"];

// Matches the backend spacing so a drag can drop an item at the midpoint of its two new neighbours.
const POSITION_STEP = 1000;

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

type StatusFilter = "all" | "open" | "done";

function TodosPage() {
  const [todos, setTodos] = useState<AdminTodo[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  // Composer draft
  const [title, setTitle] = useState("");
  const [notes, setNotes] = useState("");
  const [category, setCategory] = useState<TodoCategory>("task");
  const [priority, setPriority] = useState<TodoPriority>("normal");
  const [showNotes, setShowNotes] = useState(false);
  const [adding, setAdding] = useState(false);
  const titleRef = useRef<HTMLInputElement | null>(null);

  // Filters
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("open");
  const [categoryFilter, setCategoryFilter] = useState<TodoCategory | "all">("all");
  const [priorityFilter, setPriorityFilter] = useState<TodoPriority | "all">("all");
  const [clearing, setClearing] = useState(false);

  useEffect(() => {
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

  const openCount = useMemo(() => todos.filter((t) => t.status === "open").length, [todos]);
  const doneCount = todos.length - openCount;

  const query = search.trim().toLowerCase();

  // Faceted matching: each filter control's counts reflect the *other* active filters, not its own
  // selection, so picking one facet never zeroes out the counts on the others.
  const matchesSearch = useCallback(
    (t: AdminTodo) => !query || `${t.title} ${t.notes ?? ""}`.toLowerCase().includes(query),
    [query],
  );
  const matchesStatus = useCallback(
    (t: AdminTodo) => statusFilter === "all" || t.status === statusFilter,
    [statusFilter],
  );
  const matchesPriority = useCallback(
    (t: AdminTodo) => priorityFilter === "all" || t.priority === priorityFilter,
    [priorityFilter],
  );

  const filtered = useMemo(
    () =>
      todos.filter(
        (t) =>
          matchesStatus(t) &&
          matchesPriority(t) &&
          matchesSearch(t) &&
          (categoryFilter === "all" || t.category === categoryFilter),
      ),
    [todos, matchesStatus, matchesPriority, matchesSearch, categoryFilter],
  );

  const statusCounts = useMemo(() => {
    const counts = { open: 0, done: 0, all: 0 };
    for (const t of todos) {
      if (!matchesPriority(t) || !matchesSearch(t)) continue;
      counts[t.status]++;
      counts.all++;
    }
    return counts;
  }, [todos, matchesPriority, matchesSearch]);

  const categoryCounts = useMemo(() => {
    const counts: Record<TodoCategory | "all", number> = { all: 0, task: 0, bug: 0, feature: 0, idea: 0, chore: 0 };
    for (const t of todos) {
      if (!matchesStatus(t) || !matchesPriority(t) || !matchesSearch(t)) continue;
      counts[t.category]++;
      counts.all++;
    }
    return counts;
  }, [todos, matchesStatus, matchesPriority, matchesSearch]);

  const priorityCounts = useMemo(() => {
    const counts: Record<TodoPriority | "all", number> = { all: 0, high: 0, normal: 0, low: 0 };
    for (const t of todos) {
      if (!matchesStatus(t) || !matchesSearch(t)) continue;
      if (categoryFilter !== "all" && t.category !== categoryFilter) continue;
      counts[t.priority]++;
      counts.all++;
    }
    return counts;
  }, [todos, matchesStatus, matchesSearch, categoryFilter]);

  // Open items are drag-reorderable; done items keep their most-recently-completed order. `order`
  // drives the Reorder.Group during a drag; it's resynced from the data whenever the visible open
  // set changes (add / remove / toggle / filter), which never happens mid-drag (a drag only touches
  // `order`), so the in-progress order is never clobbered.
  const openList = useMemo(() => filtered.filter((t) => t.status === "open"), [filtered]);
  const doneList = useMemo(() => filtered.filter((t) => t.status === "done"), [filtered]);

  const [order, setOrder] = useState<AdminTodo[]>(openList);
  useEffect(() => {
    setOrder(openList);
  }, [openList]);
  const orderRef = useRef(order);
  orderRef.current = order;
  // `openList` is the committed (server-synced) open order; `order` only diverges mid-drag. Compare
  // against it to tell a real reorder from a bare click on the grip handle.
  const openListRef = useRef(openList);
  openListRef.current = openList;

  // On drop, give the moved item a position between its two new visible neighbours (or a step past
  // the end when it lands first/last) and persist just that one row. Optimistic so the reorder
  // sticks instantly; a failed save refetches server truth.
  const handleReorderEnd = useCallback(async (id: string) => {
    const current = orderRef.current;
    const committed = openListRef.current;
    if (current.length === committed.length && current.every((t, i) => t.id === committed[i].id)) return; // no net move
    const index = current.findIndex((t) => t.id === id);
    if (index === -1) return;
    const moved = current[index];
    const prev = current[index - 1];
    const next = current[index + 1];
    let position: number;
    if (!prev && !next) return; // sole item, nothing to reorder
    else if (!prev) position = next.position - POSITION_STEP;
    else if (!next) position = prev.position + POSITION_STEP;
    else position = (prev.position + next.position) / 2;
    if (position === moved.position) return; // dropped back where it started

    setTodos((list) => upsertTodo(list, { ...moved, position }));
    setError(null);
    try {
      const result = await updateAdminTodo({ data: { id, position } });
      setTodos((list) => upsertTodo(list, result.todo));
    } catch (caught) {
      setError(errMessage(caught));
      try {
        const refreshed = await listAdminTodos();
        setTodos(sortTodos(refreshed.todos));
      } catch {
        // leave the optimistic order in place; the error above already surfaces on the page.
      }
    }
  }, []);

  const handleAdd = useCallback(async () => {
    const trimmed = title.trim();
    if (!trimmed || adding) return;
    setAdding(true);
    setError(null);
    try {
      const result = await createAdminTodo({ data: { title: trimmed, notes, category, priority } });
      setTodos((prev) => upsertTodo(prev, result.todo));
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

  const handleToggle = useCallback(async (todo: AdminTodo) => {
    setBusyId(todo.id);
    setError(null);
    try {
      const nextStatus: TodoStatus = todo.status === "open" ? "done" : "open";
      const result = await updateAdminTodo({ data: { id: todo.id, status: nextStatus } });
      setTodos((prev) => upsertTodo(prev, result.todo));
    } catch (caught) {
      setError(errMessage(caught));
    } finally {
      setBusyId(null);
    }
  }, []);

  const handleSave = useCallback(async (id: string, patch: EditPatch) => {
    setBusyId(id);
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
    } finally {
      setBusyId(null);
    }
  }, []);

  const handleDelete = useCallback(async (id: string) => {
    setBusyId(id);
    setError(null);
    try {
      await deleteAdminTodo({ data: { id } });
      setTodos((prev) => prev.filter((t) => t.id !== id));
    } catch (caught) {
      setError(errMessage(caught));
    } finally {
      setBusyId(null);
    }
  }, []);

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

  return (
    <div className="flex-1 bg-osu-b5 min-h-[calc(100vh-60px)]">
      <div className="mx-auto max-w-[860px] space-y-4 px-4 py-6 sm:px-5">
        {/* Header */}
        <div className="flex items-end justify-between gap-3">
          <div>
            <div className="flex items-center gap-2">
              <span className="h-4 w-1 rounded-full bg-osu-pink" />
              <h1 className="text-sm font-bold uppercase tracking-[0.14em] text-osu-l1">Todo</h1>
            </div>
            <p className="mt-1 text-[11px] text-osu-f1">
              {openCount} open{doneCount ? ` · ${doneCount} done` : ""} · private notes for the project
            </p>
          </div>
          {doneCount > 0 && <ClearDoneButton count={doneCount} busy={clearing} onClear={handleClearDone} />}
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
          <AnimatePresence initial={false}>
            {showNotes && (
              <motion.div
                initial={{ opacity: 0, height: 0 }}
                animate={{ opacity: 1, height: "auto" }}
                exit={{ opacity: 0, height: 0 }}
                transition={{ duration: 0.15 }}
                className="overflow-hidden"
              >
                <textarea
                  value={notes}
                  onChange={(event) => setNotes(event.target.value)}
                  maxLength={5000}
                  rows={2}
                  placeholder="Notes (optional) - context, links, repro steps..."
                  className={`mt-2 ${TEXTAREA_CLASS}`}
                />
              </motion.div>
            )}
          </AnimatePresence>
        </div>

        {/* Filter bar */}
        <div className="space-y-2">
          {/* Search + status */}
          <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
            <div className="relative min-w-[180px] flex-1">
              <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-osu-f1/60" />
              <input
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Escape") setSearch("");
                }}
                placeholder="Search title or notes..."
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
            <div className="inline-flex rounded-lg border border-osu-b3/40 bg-osu-b4/40 p-0.5">
              {(["open", "done", "all"] as StatusFilter[]).map((key) => {
                const active = key === statusFilter;
                return (
                  <button
                    key={key}
                    type="button"
                    onClick={() => setStatusFilter(key)}
                    className={`rounded-md px-3 py-1 text-[11px] font-semibold capitalize transition-colors cursor-pointer ${
                      active ? "bg-osu-b3/60 text-white" : "text-osu-f1 hover:text-osu-l2"
                    }`}
                  >
                    {key} <span className="text-osu-f1/70">{statusCounts[key]}</span>
                  </button>
                );
              })}
            </div>
          </div>
          {/* Category + priority */}
          <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
            <div className="flex flex-wrap items-center gap-1">
              <CategoryFilterChip
                label="All"
                count={categoryCounts.all}
                active={categoryFilter === "all"}
                onClick={() => setCategoryFilter("all")}
              />
              {CATEGORY_ORDER.map((key) => (
                <CategoryFilterChip
                  key={key}
                  label={CATEGORY_META[key].label}
                  Icon={CATEGORY_META[key].Icon}
                  colorClass={CATEGORY_META[key].text}
                  count={categoryCounts[key]}
                  active={categoryFilter === key}
                  onClick={() => setCategoryFilter(categoryFilter === key ? "all" : key)}
                />
              ))}
            </div>
            <div className="ml-auto">
              <PriorityFilter value={priorityFilter} counts={priorityCounts} onChange={setPriorityFilter} />
            </div>
          </div>
        </div>

        {error && (
          <div className="flex items-center gap-2 rounded-lg border border-osu-red/40 bg-osu-red/10 px-3 py-2 text-xs text-osu-red">
            <AlertTriangle className="h-4 w-4 shrink-0" />
            {error}
          </div>
        )}

        {/* List */}
        {loading ? (
          <div className="flex items-center justify-center gap-2 py-16 text-xs text-osu-f1">
            <Loader2 className="h-4 w-4 animate-spin" />
            Loading todos...
          </div>
        ) : filtered.length === 0 ? (
          <EmptyState hasAny={todos.length > 0} />
        ) : (
          <div className="flex flex-col gap-2">
            {/* Open items: drag the grip to reorder by hand. */}
            {order.length > 0 && (
              <Reorder.Group axis="y" values={order} onReorder={setOrder} className="flex flex-col gap-2">
                <AnimatePresence initial={false}>
                  {order.map((todo) => (
                    <TodoCard
                      key={todo.id}
                      todo={todo}
                      busy={busyId === todo.id}
                      reorderable
                      onToggle={handleToggle}
                      onSave={handleSave}
                      onDelete={handleDelete}
                      onReorderEnd={handleReorderEnd}
                    />
                  ))}
                </AnimatePresence>
              </Reorder.Group>
            )}
            {doneList.length > 0 && (
              <motion.ul layout className="flex flex-col gap-2">
                <AnimatePresence initial={false}>
                  {doneList.map((todo) => (
                    <TodoCard
                      key={todo.id}
                      todo={todo}
                      busy={busyId === todo.id}
                      onToggle={handleToggle}
                      onSave={handleSave}
                      onDelete={handleDelete}
                    />
                  ))}
                </AnimatePresence>
              </motion.ul>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Row
// ---------------------------------------------------------------------------

interface EditPatch {
  title: string;
  notes: string;
  category: TodoCategory;
  priority: TodoPriority;
}

interface TodoCardProps {
  todo: AdminTodo;
  busy: boolean;
  reorderable?: boolean;
  onToggle: (todo: AdminTodo) => void;
  onSave: (id: string, patch: EditPatch) => Promise<void>;
  onDelete: (id: string) => void;
  onReorderEnd?: (id: string) => void;
}

function TodoCard({ todo, busy, reorderable, onToggle, onSave, onDelete, onReorderEnd }: TodoCardProps) {
  const [editing, setEditing] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [draft, setDraft] = useState<EditPatch>(() => toEditPatch(todo));
  const dragControls = useDragControls();

  useEffect(() => {
    if (!confirmDelete) return;
    const id = window.setTimeout(() => setConfirmDelete(false), 4_000);
    return () => window.clearTimeout(id);
  }, [confirmDelete]);

  const done = todo.status === "done";
  const meta = CATEGORY_META[todo.category];
  const CategoryIcon = meta.Icon;
  const priorityBar = PRIORITY_META[todo.priority].bar;

  const beginEdit = () => {
    setDraft(toEditPatch(todo));
    setEditing(true);
  };

  const commit = async () => {
    if (!draft.title.trim()) return;
    try {
      await onSave(todo.id, draft);
      setEditing(false);
    } catch {
      // error surfaces on the page; keep the form open so edits aren't lost.
    }
  };

  const rootClassName = editing
    ? "relative z-20 rounded-lg border border-osu-c2/40 bg-osu-b4/40 p-3"
    : `group relative flex items-start gap-3 rounded-lg border border-osu-b3/40 p-3 transition-colors hover:border-osu-b3/60 ${done ? "bg-osu-b4/15" : "bg-osu-b4/30"}`;

  const content = (
    <>
      {editing ? (
        <>
          <input
            value={draft.title}
            onChange={(event) => setDraft((d) => ({ ...d, title: event.target.value }))}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.shiftKey) {
                event.preventDefault();
                void commit();
              }
              if (event.key === "Escape") setEditing(false);
            }}
            maxLength={500}
            autoFocus
            className="w-full rounded-md border border-osu-b3/50 bg-osu-b6/70 px-3 py-2 text-sm text-osu-l1 focus:border-osu-c2/60 focus:outline-none"
          />
          <textarea
            value={draft.notes}
            onChange={(event) => setDraft((d) => ({ ...d, notes: event.target.value }))}
            maxLength={5000}
            rows={2}
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
            <div className="ml-auto flex items-center gap-1.5">
              <button
                type="button"
                onClick={() => setEditing(false)}
                className="rounded-md border border-osu-b3/50 bg-osu-b4/60 px-2.5 py-1 text-[11px] font-semibold text-osu-l2 hover:bg-osu-b3/50 cursor-pointer"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={() => void commit()}
                disabled={!draft.title.trim() || busy}
                className="inline-flex items-center gap-1.5 rounded-md border border-osu-yellow/40 bg-osu-yellow/15 px-2.5 py-1 text-[11px] font-semibold text-osu-yellow hover:bg-osu-yellow/25 disabled:opacity-40 cursor-pointer"
              >
                {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Check className="h-3.5 w-3.5" />}
                Save
              </button>
            </div>
          </div>
        </>
      ) : (
        <>
          {/* Priority accent (skipped when done or low) */}
          {!done && priorityBar && <span className={`absolute bottom-2 left-0 top-2 w-0.5 rounded-full ${priorityBar}`} />}

          {/* Drag handle: press and hold to reorder by hand */}
          {reorderable && (
            <button
              type="button"
              aria-label="Drag to reorder"
              onPointerDown={(event) => dragControls.start(event)}
              className="-ml-1 mt-0.5 inline-flex h-5 w-4 shrink-0 touch-none items-center justify-center rounded text-osu-f1/30 transition-colors hover:text-osu-l2 cursor-grab active:cursor-grabbing"
            >
              <GripVertical className="h-4 w-4" />
            </button>
          )}

          <TodoCheckbox done={done} busy={busy} onToggle={() => onToggle(todo)} />

          {/* Body */}
          <div className="min-w-0 flex-1">
            <p className={`text-sm leading-snug ${done ? "text-osu-f1 line-through" : "text-osu-l1"}`}>{todo.title}</p>
            {todo.notes && (
              <p className={`mt-1 whitespace-pre-wrap text-xs leading-relaxed ${done ? "text-osu-f1/70" : "text-osu-l2/80"}`}>
                {todo.notes}
              </p>
            )}
            <div className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-[10px]">
              <span className={`inline-flex items-center gap-1 rounded border px-1.5 py-0.5 font-semibold uppercase tracking-wide ${meta.pill}`}>
                <CategoryIcon className="h-3 w-3" />
                {meta.label}
              </span>
              {!done && todo.priority !== "normal" && (
                <span className={`font-semibold uppercase tracking-wide ${PRIORITY_META[todo.priority].chip}`}>
                  {PRIORITY_META[todo.priority].label}
                </span>
              )}
              <span className="text-osu-f1/50">{formatShortDate(todo.createdAt)}</span>
            </div>
          </div>

          {/* Actions */}
          <div className="flex shrink-0 items-center gap-1">
            <button
              type="button"
              onClick={beginEdit}
              disabled={busy}
              aria-label="Edit"
              className="inline-flex h-7 w-7 items-center justify-center rounded-md text-osu-f1 opacity-0 transition hover:bg-osu-b3/50 hover:text-osu-l1 disabled:opacity-30 group-hover:opacity-100 cursor-pointer"
            >
              <SquarePen className="h-3.5 w-3.5" />
            </button>
            {confirmDelete ? (
              <button
                type="button"
                onClick={() => {
                  setConfirmDelete(false);
                  onDelete(todo.id);
                }}
                disabled={busy}
                className="inline-flex h-7 items-center gap-1 rounded-md border border-osu-red/60 bg-osu-red/25 px-2 text-[10px] font-semibold uppercase tracking-wider text-white hover:bg-osu-red/35 disabled:opacity-50 cursor-pointer"
              >
                <Trash2 className="h-3.5 w-3.5" />
                Sure?
              </button>
            ) : (
              <button
                type="button"
                onClick={() => setConfirmDelete(true)}
                disabled={busy}
                aria-label="Delete"
                className="inline-flex h-7 w-7 items-center justify-center rounded-md text-osu-f1 opacity-0 transition hover:bg-osu-red/15 hover:text-osu-red disabled:opacity-30 group-hover:opacity-100 cursor-pointer"
              >
                <Trash2 className="h-3.5 w-3.5" />
              </button>
            )}
          </div>
        </>
      )}
    </>
  );

  if (reorderable) {
    return (
      <Reorder.Item
        value={todo}
        dragListener={false}
        dragControls={dragControls}
        onDragEnd={() => onReorderEnd?.(todo.id)}
        layout
        initial={{ opacity: 0, y: -6 }}
        animate={{ opacity: 1, y: 0 }}
        exit={{ opacity: 0, x: -10, transition: { duration: 0.12 } }}
        transition={{ duration: 0.16, ease: "easeOut" }}
        className={rootClassName}
      >
        {content}
      </Reorder.Item>
    );
  }

  return (
    <motion.li
      layout
      initial={{ opacity: 0, y: -6 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, x: -10, transition: { duration: 0.12 } }}
      transition={{ duration: 0.16, ease: "easeOut" }}
      className={rootClassName}
    >
      {content}
    </motion.li>
  );
}

function TodoCheckbox({ done, busy, onToggle }: { done: boolean; busy: boolean; onToggle: () => void }) {
  return (
    <motion.button
      type="button"
      whileTap={{ scale: 0.82 }}
      onClick={onToggle}
      disabled={busy}
      aria-pressed={done}
      aria-label={done ? "Mark as not done" : "Mark as done"}
      className={`group/cb mt-0.5 inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-md border transition-colors cursor-pointer ${
        done ? "border-osu-green/60 bg-osu-green/25 text-osu-green" : "border-osu-b3/70 bg-osu-b6/40 hover:border-osu-green/60"
      }`}
    >
      {busy ? (
        <Loader2 className="h-3 w-3 animate-spin text-osu-f1" />
      ) : (
        <>
          <AnimatePresence initial={false}>
            {done && (
              <motion.span
                key="check"
                initial={{ scale: 0, rotate: -25 }}
                animate={{ scale: 1, rotate: 0 }}
                exit={{ scale: 0, opacity: 0 }}
                transition={{ type: "spring", stiffness: 520, damping: 22 }}
              >
                <Check className="h-3.5 w-3.5" />
              </motion.span>
            )}
          </AnimatePresence>
          {!done && <Check className="h-3.5 w-3.5 text-osu-green opacity-0 transition-opacity group-hover/cb:opacity-40" />}
        </>
      )}
    </motion.button>
  );
}

function toEditPatch(todo: AdminTodo): EditPatch {
  return {
    title: todo.title,
    notes: todo.notes ?? "",
    category: todo.category,
    priority: todo.priority,
  };
}

// ---------------------------------------------------------------------------
// Small pieces
// ---------------------------------------------------------------------------

function CategoryFilterChip({
  label,
  Icon,
  colorClass,
  count,
  active,
  onClick,
}: {
  label: string;
  Icon?: typeof Bug;
  colorClass?: string;
  count: number;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`inline-flex items-center gap-1 rounded-full border px-2.5 py-1 text-[10px] font-semibold uppercase tracking-wide transition-colors cursor-pointer ${
        active
          ? "border-osu-c2/50 bg-osu-c2/15 text-white"
          : "border-osu-b3/40 bg-osu-b4/30 text-osu-f1 hover:border-osu-b3/60 hover:text-osu-l2"
      }`}
    >
      {Icon && <Icon className={`h-3 w-3 ${active ? colorClass : ""}`} />}
      {label}
      <span
        className={`rounded-full px-1 text-[9px] tabular-nums ${
          active ? "bg-white/15 text-white" : count === 0 ? "text-osu-f1/40" : "bg-osu-b6/60 text-osu-f1/80"
        }`}
      >
        {count}
      </span>
    </button>
  );
}

function PriorityFilter({
  value,
  counts,
  onChange,
}: {
  value: TodoPriority | "all";
  counts: Record<TodoPriority | "all", number>;
  onChange: (value: TodoPriority | "all") => void;
}) {
  const options: (TodoPriority | "all")[] = ["all", "high", "normal", "low"];
  return (
    <div
      className="inline-flex rounded-lg border border-osu-b3/40 bg-osu-b4/40 p-0.5"
      role="group"
      aria-label="Filter by priority"
    >
      {options.map((key) => {
        const active = key === value;
        const dot = key === "all" ? null : PRIORITY_META[key].dot;
        return (
          <button
            key={key}
            type="button"
            onClick={() => onChange(key)}
            className={`inline-flex items-center gap-1.5 rounded-md px-2.5 py-1 text-[11px] font-semibold capitalize transition-colors cursor-pointer ${
              active ? "bg-osu-b3/60 text-white" : "text-osu-f1 hover:text-osu-l2"
            }`}
          >
            {dot && <span className={`h-1.5 w-1.5 rounded-full ${dot} ${active ? "" : "opacity-60"}`} />}
            {key}
            <span className="text-osu-f1/70 tabular-nums">{counts[key]}</span>
          </button>
        );
      })}
    </div>
  );
}

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
      {armed ? "Clear done?" : `Clear done (${count})`}
    </button>
  );
}

function EmptyState({ hasAny }: { hasAny: boolean }) {
  return (
    <div className="flex flex-col items-center justify-center gap-2 rounded-xl border border-dashed border-osu-b3/40 py-16 text-center">
      <Inbox className="h-6 w-6 text-osu-f1/50" />
      <p className="text-xs text-osu-f1">
        {hasAny ? "Nothing matches this filter." : "No todos yet. Add the first one above."}
      </p>
    </div>
  );
}
