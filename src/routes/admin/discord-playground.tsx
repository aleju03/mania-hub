import { createFileRoute, Link, notFound } from "@tanstack/react-router";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { canUseAdminFeatures } from "../../lib/auth-shared";
import { runDiscordPlayground } from "../../lib/live-backend";
import {
  DiscordMessageBodyView,
  FLAG_EPHEMERAL,
  lintDiscordMessage,
  messageStats,
  type DiscordComponentJson,
  type DiscordMessageJson,
} from "../../components/discord/message/DiscordMessageView";
import { DISCORD } from "../../components/discord/message/discord-markdown";

export const Route = createFileRoute("/admin/discord-playground")({
  head: () => ({
    meta: [
      { title: "Bot playground - admin" },
      { name: "robots", content: "noindex, nofollow" },
    ],
  }),
  beforeLoad: ({ context }) => {
    if (!canUseAdminFeatures(context.auth)) {
      throw notFound();
    }
    return undefined as never;
  },
  component: DiscordPlaygroundPage,
});

// --- Backend shapes ----------------------------------------------------------

interface OptionDef {
  type: number;
  name: string;
  description: string;
  required?: boolean;
  autocomplete?: boolean;
  choices?: Array<{ name: string; value: string | number }>;
}

interface CommandDef {
  name: string;
  description: string;
  // 2 = user context menu, 3 = message context menu, else a slash command.
  type?: number;
  options?: OptionDef[];
}

interface PlaygroundLink {
  discordUserId: string;
  osuUserId: number;
  osuUsername: string;
}

interface PlaygroundInfo {
  bootId: string;
  siteOrigin: string;
  defaultCountry: string;
  playgroundUserId: string;
  commands: CommandDef[];
  links: PlaygroundLink[];
}

interface InteractionOption {
  name: string;
  type: number;
  value?: string | number | boolean;
  focused?: boolean;
}

interface InteractionRequest {
  type: number;
  data?: {
    name?: string;
    custom_id?: string;
    component_type?: number;
    type?: number;
    target_id?: string;
    resolved?: Record<string, unknown>;
    options?: InteractionOption[];
    components?: Array<{ type: number; components: Array<{ type: number; custom_id: string; value: string }> }>;
  };
  userId: string;
  username: string;
  inGuild: boolean;
  manageGuild: boolean;
  messageFlags?: number;
}

interface FeedRequest {
  feed: "top_play" | "dan_clear" | "goal" | "snipe" | "new_map" | "inflated_map" | "changelog";
  country: string;
}

interface InteractionResult {
  response: { type: number; data?: any };
  message: DiscordMessageJson | null;
  handlerError: string | null;
  elapsedMs: number;
}

interface ModalField {
  custom_id: string;
  label: string;
  placeholder?: string;
  required?: boolean;
  max_length?: number;
}

interface OpenModal {
  title: string;
  customId: string;
  fields: ModalField[];
  base: InteractionRequest;
}

type EntryRequest = { kind: "interaction"; request: InteractionRequest } | { kind: "feed"; request: FeedRequest };

interface Entry {
  id: string;
  label: string;
  actorName: string;
  actorAvatar: string | null;
  source: EntryRequest;
  message: DiscordMessageJson | null;
  pending: boolean;
  error: string | null;
  handlerError: string | null;
  elapsedMs: number | null;
  at: number;
}

const INTERACTION_COMMAND = 2;
const INTERACTION_COMPONENT = 3;
const INTERACTION_AUTOCOMPLETE = 4;
const INTERACTION_MODAL_SUBMIT = 5;
const RESPONSE_CHANNEL_MESSAGE = 4;
const RESPONSE_DEFERRED_MESSAGE = 5;
const RESPONSE_DEFERRED_UPDATE = 6;
const RESPONSE_AUTOCOMPLETE = 8;
const RESPONSE_MODAL = 9;

const OPT_INTEGER = 4;
const OPT_BOOLEAN = 5;
const OPT_NUMBER = 10;

const STORAGE_KEY = "mh-discord-playground-v1";
const MAX_ENTRIES = 40;
const BOOT_POLL_MS = 1500;
const RERUN_ON_RELOAD_LIMIT = 8;

const FEEDS: Array<{ feed: FeedRequest["feed"]; label: string }> = [
  { feed: "top_play", label: "Top play" },
  { feed: "snipe", label: "Snipe" },
  { feed: "new_map", label: "New farm map" },
  { feed: "dan_clear", label: "Dan clear" },
  { feed: "goal", label: "Goal" },
  { feed: "inflated_map", label: "Inflated map" },
  { feed: "changelog", label: "Site update" },
];

interface PersistedState {
  entries: Entry[];
  actorId: string;
  inGuild: boolean;
  manageGuild: boolean;
  command: string;
  values: Record<string, Record<string, string>>;
  feedCountry: string;
  autoRerun: boolean;
}

function readPersisted(): Partial<PersistedState> {
  if (typeof window === "undefined") return {};
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    return raw ? JSON.parse(raw) as Partial<PersistedState> : {};
  } catch {
    return {};
  }
}

function newId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function formatClock(at: number): string {
  return new Date(at).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
}

async function callInteraction(request: InteractionRequest): Promise<InteractionResult> {
  return await runDiscordPlayground({ data: { action: "interaction", body: request } }) as InteractionResult;
}

// What a routed interaction turned into, from the playground's point of view.
type Outcome =
  | { kind: "message"; message: DiscordMessageJson; handlerError: string | null; elapsedMs: number; update: boolean }
  | { kind: "modal"; modal: Omit<OpenModal, "base"> }
  | { kind: "none" };

function toOutcome(result: InteractionResult): Outcome {
  const { response } = result;
  if (response.type === RESPONSE_MODAL) {
    const data = response.data ?? {};
    const fields: ModalField[] = (data.components ?? []).flatMap((row: DiscordComponentJson & { components?: any[] }) =>
      (row.components ?? []).map((field: any) => ({
        custom_id: String(field.custom_id),
        label: String(field.label ?? field.custom_id),
        placeholder: field.placeholder,
        required: field.required,
        max_length: field.max_length,
      })));
    return { kind: "modal", modal: { title: String(data.title ?? "Form"), customId: String(data.custom_id ?? ""), fields } };
  }
  if (response.type === RESPONSE_CHANNEL_MESSAGE && response.data) {
    return { kind: "message", message: response.data as DiscordMessageJson, handlerError: result.handlerError, elapsedMs: result.elapsedMs, update: false };
  }
  if ((response.type === RESPONSE_DEFERRED_MESSAGE || response.type === RESPONSE_DEFERRED_UPDATE) && result.message) {
    // Ephemerality is fixed by the deferral, so carry its flag onto the body.
    const deferFlags = Number(response.data?.flags ?? 0) & FLAG_EPHEMERAL;
    const message = deferFlags ? { ...result.message, flags: (result.message.flags ?? 0) | deferFlags } : result.message;
    return { kind: "message", message, handlerError: result.handlerError, elapsedMs: result.elapsedMs, update: response.type === RESPONSE_DEFERRED_UPDATE };
  }
  return { kind: "none" };
}

function optionsToInvocation(name: string, options: InteractionOption[]): string {
  return [`/${name}`, ...options.map((option) => `${option.name}:${String(option.value)}`)].join(" ");
}

function buildOptions(command: CommandDef, values: Record<string, string>): InteractionOption[] {
  const options: InteractionOption[] = [];
  for (const def of command.options ?? []) {
    const raw = (values[def.name] ?? "").trim();
    if (!raw) continue;
    if (def.type === OPT_BOOLEAN) {
      if (raw === "true" || raw === "false") options.push({ name: def.name, type: def.type, value: raw === "true" });
    } else if (def.type === OPT_INTEGER || def.type === OPT_NUMBER) {
      const num = Number(raw);
      if (Number.isFinite(num)) options.push({ name: def.name, type: def.type, value: def.type === OPT_INTEGER ? Math.trunc(num) : num });
    } else {
      options.push({ name: def.name, type: def.type, value: raw });
    }
  }
  return options;
}

// --- Page --------------------------------------------------------------------

function DiscordPlaygroundPage() {
  const persisted = useMemo(readPersisted, []);
  const [info, setInfo] = useState<PlaygroundInfo | null>(null);
  const [infoError, setInfoError] = useState<string | null>(null);
  const [entries, setEntries] = useState<Entry[]>(() => (persisted.entries ?? []).map((entry) => ({ ...entry, pending: false })));
  const [actorId, setActorId] = useState(persisted.actorId ?? "");
  const [inGuild, setInGuild] = useState(persisted.inGuild ?? true);
  const [manageGuild, setManageGuild] = useState(persisted.manageGuild ?? true);
  const [commandName, setCommandName] = useState(persisted.command ?? "help");
  const [values, setValues] = useState<Record<string, Record<string, string>>>(persisted.values ?? {});
  const [feedCountry, setFeedCountry] = useState(persisted.feedCountry ?? "");
  const [autoRerun, setAutoRerun] = useState(persisted.autoRerun ?? true);
  const [search, setSearch] = useState("");
  // An uploaded screenshot for the message menu, kept out of localStorage (it can be megabytes).
  const [messageImage, setMessageImage] = useState<string | null>(null);
  const [modal, setModal] = useState<OpenModal | null>(null);
  const [busyButton, setBusyButton] = useState<string | null>(null);
  const [jsonOpen, setJsonOpen] = useState<Record<string, boolean>>({});
  const [backendState, setBackendState] = useState<"up" | "down" | "reloaded">("up");
  const bootIdRef = useRef<string | null>(null);
  const entriesRef = useRef(entries);
  entriesRef.current = entries;
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const state: PersistedState = {
      entries: entries.filter((entry) => !entry.pending).slice(-MAX_ENTRIES),
      actorId, inGuild, manageGuild, command: commandName, values, feedCountry, autoRerun,
    };
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    } catch {
      // Storage full or blocked: the playground still works, it just forgets.
    }
  }, [entries, actorId, inGuild, manageGuild, commandName, values, feedCountry, autoRerun]);

  const loadInfo = useCallback(async () => {
    try {
      const next = await runDiscordPlayground({ data: { action: "info" } }) as PlaygroundInfo;
      setInfo(next);
      setInfoError(null);
      return next;
    } catch (err) {
      setInfoError(err instanceof Error ? err.message : String(err));
      return null;
    }
  }, []);

  useEffect(() => {
    void loadInfo().then((next) => {
      if (next) bootIdRef.current = next.bootId;
    });
  }, [loadInfo]);

  const actor = useMemo(() => {
    const link = info?.links.find((candidate) => candidate.discordUserId === actorId);
    if (link) return { id: link.discordUserId, name: link.osuUsername, avatar: `https://a.ppy.sh/${link.osuUserId}` };
    return { id: info?.playgroundUserId ?? "100000000000000001", name: "playground", avatar: null as string | null };
  }, [info, actorId]);

  const baseRequest = useCallback((): Omit<InteractionRequest, "type"> => ({
    userId: actor.id,
    username: actor.name,
    inGuild,
    manageGuild,
  }), [actor, inGuild, manageGuild]);

  const patchEntry = useCallback((id: string, patch: Partial<Entry>) => {
    setEntries((current) => current.map((entry) => entry.id === id ? { ...entry, ...patch } : entry));
  }, []);

  // Follow new output while the view is at the bottom, like a chat client.
  const stickRef = useRef(true);
  const scrollToEnd = useCallback(() => {
    stickRef.current = true;
  }, []);
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (el && stickRef.current) el.scrollTop = el.scrollHeight;
  }, [entries]);

  const appendEntry = useCallback((entry: Entry) => {
    setEntries((current) => [...current, entry].slice(-MAX_ENTRIES));
    scrollToEnd();
  }, [scrollToEnd]);

  // Runs an entry's stored request and writes the reply into it.
  const runEntry = useCallback(async (entry: Entry) => {
    patchEntry(entry.id, { pending: true, error: null });
    try {
      if (entry.source.kind === "feed") {
        const result = await runDiscordPlayground({ data: { action: "feed", body: entry.source.request } }) as { message: DiscordMessageJson | null };
        patchEntry(entry.id, {
          pending: false,
          message: result.message,
          error: result.message ? null : "No matching data in the local DB for this feed and country.",
          handlerError: null,
          elapsedMs: null,
        });
        return;
      }
      const outcome = toOutcome(await callInteraction(entry.source.request));
      if (outcome.kind === "message") {
        patchEntry(entry.id, { pending: false, message: outcome.message, handlerError: outcome.handlerError, elapsedMs: outcome.elapsedMs });
      } else if (outcome.kind === "modal") {
        patchEntry(entry.id, { pending: false });
        setModal({ ...outcome.modal, base: { ...entry.source.request } });
      } else {
        patchEntry(entry.id, { pending: false, error: "The bot sent no message for this interaction." });
      }
    } catch (err) {
      patchEntry(entry.id, { pending: false, error: err instanceof Error ? err.message : String(err) });
    }
  }, [patchEntry]);

  const startEntry = useCallback((label: string, source: EntryRequest, actorOverride?: { name: string; avatar: string | null }) => {
    const entry: Entry = {
      id: newId(),
      label,
      actorName: actorOverride?.name ?? actor.name,
      actorAvatar: actorOverride?.avatar ?? actor.avatar,
      source,
      message: null,
      pending: true,
      error: null,
      handlerError: null,
      elapsedMs: null,
      at: Date.now(),
    };
    appendEntry(entry);
    void runEntry(entry);
  }, [actor, appendEntry, runEntry]);

  const command = info?.commands.find((candidate) => candidate.name === commandName) ?? null;
  const commandValues = values[commandName] ?? {};

  const runCommand = useCallback(() => {
    if (!command) return;
    if (command.type === 3 || command.type === 2) {
      // Context menus carry the right-clicked message or user instead of options.
      const target = (values[command.name] ?? {}).target ?? "";
      const targetId = command.type === 3 ? "200000000000000001" : (target || actor.id);
      const resolved = command.type === 3
        ? { messages: { [targetId]: { id: targetId, content: target, embeds: [], attachments: messageImage ? [{ url: messageImage, content_type: messageImage.slice(5, messageImage.indexOf(";")) }] : [] } } }
        : { users: { [targetId]: { id: targetId, username: info?.links.find((l) => l.discordUserId === targetId)?.osuUsername ?? "someone" } } };
      const request: InteractionRequest = { ...baseRequest(), type: INTERACTION_COMMAND, data: { name: command.name, type: command.type, target_id: targetId, resolved } };
      startEntry(`Apps > ${command.name}`, { kind: "interaction", request });
      return;
    }
    const options = buildOptions(command, values[command.name] ?? {});
    const request: InteractionRequest = { ...baseRequest(), type: INTERACTION_COMMAND, data: { name: command.name, options } };
    startEntry(optionsToInvocation(command.name, options), { kind: "interaction", request });
  }, [actor, baseRequest, command, info, messageImage, startEntry, values]);

  const runFeed = useCallback((feed: FeedRequest["feed"], label: string) => {
    const country = (feedCountry || info?.defaultCountry || "GLOBAL").toUpperCase();
    startEntry(`${label} feed, ${country}`, { kind: "feed", request: { feed, country } }, { name: "feed", avatar: null });
  }, [feedCountry, info, startEntry]);

  const clickButton = useCallback(async (entry: Entry, component: DiscordComponentJson) => {
    if (!component.custom_id || entry.source.kind !== "interaction") return;
    const base = entry.source.request;
    const request: InteractionRequest = {
      ...base,
      type: INTERACTION_COMPONENT,
      data: { custom_id: component.custom_id, component_type: 2 },
      messageFlags: entry.message?.flags ?? 0,
    };
    setBusyButton(component.custom_id);
    try {
      const outcome = toOutcome(await callInteraction(request));
      if (outcome.kind === "message" && outcome.update) {
        // The button edits its own message; replaying this request reproduces it.
        patchEntry(entry.id, {
          message: outcome.message,
          handlerError: outcome.handlerError,
          elapsedMs: outcome.elapsedMs,
          error: null,
          source: { kind: "interaction", request },
        });
      } else if (outcome.kind === "message") {
        appendEntry({
          id: newId(), label: `clicked ${component.label ?? component.custom_id}`, actorName: entry.actorName, actorAvatar: entry.actorAvatar,
          source: { kind: "interaction", request }, message: outcome.message, pending: false, error: null,
          handlerError: outcome.handlerError, elapsedMs: outcome.elapsedMs, at: Date.now(),
        });
      } else if (outcome.kind === "modal") {
        setModal({ ...outcome.modal, base });
      }
    } catch (err) {
      patchEntry(entry.id, { error: err instanceof Error ? err.message : String(err) });
    } finally {
      setBusyButton(null);
    }
  }, [appendEntry, patchEntry]);

  const submitModal = useCallback((open: OpenModal, fieldValues: Record<string, string>) => {
    setModal(null);
    const request: InteractionRequest = {
      ...open.base,
      type: INTERACTION_MODAL_SUBMIT,
      messageFlags: undefined,
      data: {
        custom_id: open.customId,
        components: open.fields.map((field) => ({ type: 1, components: [{ type: 4, custom_id: field.custom_id, value: fieldValues[field.custom_id] ?? "" }] })),
      },
    };
    startEntry(`submitted "${open.title}"`, { kind: "interaction", request });
  }, [startEntry]);

  const rerunAll = useCallback(async (limit = MAX_ENTRIES) => {
    const targets = entriesRef.current.slice(-limit);
    for (const entry of targets) await runEntry(entry);
  }, [runEntry]);

  // Watch for backend restarts (node --watch after an edit) and replay the
  // transcript against the new code.
  useEffect(() => {
    if (!autoRerun) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const tick = async () => {
      if (document.visibilityState === "visible") {
        try {
          const next = await runDiscordPlayground({ data: { action: "info" } }) as PlaygroundInfo;
          if (cancelled) return;
          if (bootIdRef.current && next.bootId !== bootIdRef.current) {
            bootIdRef.current = next.bootId;
            setInfo(next);
            setBackendState("reloaded");
            await rerunAll(RERUN_ON_RELOAD_LIMIT);
            if (!cancelled) setTimeout(() => setBackendState("up"), 2500);
          } else {
            bootIdRef.current = next.bootId;
            setBackendState((state) => state === "down" ? "up" : state);
          }
        } catch {
          if (!cancelled) setBackendState("down");
        }
      }
      if (!cancelled) timer = setTimeout(() => void tick(), BOOT_POLL_MS);
    };
    timer = setTimeout(() => void tick(), BOOT_POLL_MS);
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [autoRerun, rerunAll]);

  const filteredCommands = useMemo(() => {
    const query = search.trim().replace(/^\//, "").toLowerCase();
    const list = info?.commands ?? [];
    return query ? list.filter((candidate) => candidate.name.includes(query) || candidate.description.toLowerCase().includes(query)) : list;
  }, [info, search]);

  return (
    <div className="flex min-h-[calc(100vh-60px)] flex-1 flex-col bg-osu-b5">
      <div className="border-b border-osu-b3/40 bg-osu-d5">
        <div className="flex flex-wrap items-center gap-3 px-4 py-3 sm:px-5">
          <h2 className="text-[13px] font-medium text-osu-c2 sm:text-[15px]">Bot playground</h2>
          <span className="rounded bg-osu-yellow/15 px-1.5 py-0.5 text-[11px] font-semibold uppercase tracking-wider text-osu-yellow">admin</span>
          <div className="ml-auto flex items-center gap-3">
            <BackendStatus state={backendState} autoRerun={autoRerun} />
            <Link to="/admin/discord" className="text-[12px] font-semibold text-osu-pink-light hover:text-white">Discord admin</Link>
          </div>
        </div>
      </div>

      {infoError && !info ? (
        <div className="m-4 rounded-lg border border-rose-500/30 bg-rose-500/10 px-3 py-2 text-[13px] text-rose-200">
          {infoError === "playground_is_local_only" ? "The playground only runs against a local backend." : infoError}
        </div>
      ) : null}

      <div className="grid min-h-0 flex-1 grid-cols-1 lg:grid-cols-[360px_minmax(0,1fr)]">
        {/* Composer */}
        <aside className="flex min-h-0 flex-col gap-4 overflow-y-auto border-r border-white/[0.07] p-4 lg:h-[calc(100vh-60px-49px)]">
          <section className="space-y-2">
            <Label>Act as</Label>
            <select
              value={actorId}
              onChange={(event) => setActorId(event.target.value)}
              className="w-full rounded-md border border-white/[0.07] bg-osu-b4 px-2 py-1.5 text-[13px] text-osu-l1 outline-none focus:border-osu-pink/60"
            >
              <option value="">Unlinked user</option>
              {(info?.links ?? []).map((link) => (
                <option key={link.discordUserId} value={link.discordUserId}>{link.osuUsername} (linked)</option>
              ))}
            </select>
            <div className="flex flex-wrap gap-x-4 gap-y-1 pt-1">
              <Toggle checked={inGuild} onChange={setInGuild} label="In a server" />
              <Toggle checked={manageGuild} onChange={setManageGuild} label="Manage Server" disabled={!inGuild} />
            </div>
          </section>

          <section className="space-y-2 border-t border-white/[0.07] pt-4">
            <Label>Command</Label>
            <input
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="Search commands"
              className="w-full rounded-md border border-white/[0.07] bg-osu-b4 px-2 py-1.5 text-[13px] text-osu-l1 outline-none placeholder:text-osu-f1 focus:border-osu-pink/60"
            />
            <div className="max-h-[220px] overflow-y-auto rounded-md border border-white/[0.07]">
              {filteredCommands.map((candidate) => (
                <button
                  key={candidate.name}
                  type="button"
                  onClick={() => setCommandName(candidate.name)}
                  title={candidate.description}
                  className={`block w-full truncate px-2.5 py-1.5 text-left transition-colors hover:bg-white/[0.04] ${candidate.name === commandName ? "bg-white/[0.07]" : ""}`}
                >
                  <span className="text-[13px] font-semibold text-osu-l1">{candidate.type === 2 || candidate.type === 3 ? candidate.name : `/${candidate.name}`}</span>
                  <span className="ml-2 text-[11px] text-osu-f1">{candidate.type === 3 ? "Message menu" : candidate.type === 2 ? "User menu" : candidate.description}</span>
                </button>
              ))}
            </div>
          </section>

          {command ? (
            <section className="space-y-2.5 border-t border-white/[0.07] pt-4">
              <div className="text-[15px] font-semibold text-white">{command.type === 2 || command.type === 3 ? `Apps > ${command.name}` : `/${command.name}`}</div>
              {command.type === 3 ? (
                <label className="block space-y-1">
                  <div className="text-[12px] font-semibold text-osu-l2">Message <span className="ml-2 font-normal text-osu-f1">Text of the right-clicked message, like a score or beatmap link</span></div>
                  <textarea
                    value={commandValues.target ?? ""}
                    onChange={(event) => setValues((current) => ({ ...current, [command.name]: { ...(current[command.name] ?? {}), target: event.target.value } }))}
                    rows={3}
                    placeholder="https://osu.ppy.sh/beatmapsets/2520599#mania/5563410 +DT"
                    className="w-full rounded-md border border-white/[0.07] bg-osu-b4 px-2 py-1.5 text-[13px] text-osu-l1 outline-none placeholder:text-osu-f1 focus:border-osu-pink/60"
                  />
                </label>
              ) : null}
              {command.type === 3 ? (
                <div className="space-y-1">
                  <div className="text-[12px] font-semibold text-osu-l2">Screenshot <span className="ml-2 font-normal text-osu-f1">An image attached to the message</span></div>
                  <input
                    type="file"
                    accept="image/png,image/jpeg,image/webp"
                    onChange={(event) => {
                      const file = event.target.files?.[0];
                      if (!file) return setMessageImage(null);
                      const reader = new FileReader();
                      reader.onload = () => setMessageImage(typeof reader.result === "string" ? reader.result : null);
                      reader.readAsDataURL(file);
                    }}
                    className="block w-full text-[12px] text-osu-f1 file:mr-2 file:rounded-md file:border-0 file:bg-osu-b4 file:px-2 file:py-1 file:text-[12px] file:text-osu-l1"
                  />
                  {messageImage ? (
                    <div className="flex items-center gap-2">
                      <img src={messageImage} alt="" className="h-12 rounded" />
                      <button type="button" onClick={() => setMessageImage(null)} className="text-[11px] text-osu-f1 hover:text-white">Remove</button>
                    </div>
                  ) : null}
                </div>
              ) : null}
              {command.type === 2 ? (
                <label className="block space-y-1">
                  <div className="text-[12px] font-semibold text-osu-l2">User <span className="ml-2 font-normal text-osu-f1">The right-clicked Discord user</span></div>
                  <select
                    value={commandValues.target ?? ""}
                    onChange={(event) => setValues((current) => ({ ...current, [command.name]: { ...(current[command.name] ?? {}), target: event.target.value } }))}
                    className="w-full rounded-md border border-white/[0.07] bg-osu-b4 px-2 py-1.5 text-[13px] text-osu-l1 outline-none"
                  >
                    <option value="">Yourself</option>
                    <option value="300000000000000009">Someone who never linked</option>
                    {(info?.links ?? []).map((l) => <option key={l.discordUserId} value={l.discordUserId}>{l.osuUsername}</option>)}
                  </select>
                </label>
              ) : null}
              {(command.options ?? []).map((def) => (
                <OptionField
                  key={`${command.name}-${def.name}`}
                  def={def}
                  value={commandValues[def.name] ?? ""}
                  onChange={(value) => setValues((current) => ({ ...current, [command.name]: { ...(current[command.name] ?? {}), [def.name]: value } }))}
                  onSubmit={runCommand}
                  autocomplete={def.autocomplete ? async (typed) => {
                    const options = buildOptions(command, { ...commandValues, [def.name]: "" });
                    const request: InteractionRequest = {
                      ...baseRequest(),
                      type: INTERACTION_AUTOCOMPLETE,
                      data: { name: command.name, options: [...options, { name: def.name, type: def.type, value: typed, focused: true }] },
                    };
                    const result = await callInteraction(request);
                    return result.response.type === RESPONSE_AUTOCOMPLETE ? (result.response.data?.choices ?? []) : [];
                  } : undefined}
                />
              ))}
              <div className="flex items-center gap-3 pt-1">
                <button
                  type="button"
                  onClick={runCommand}
                  className="rounded-md bg-osu-pink px-4 py-1.5 text-[13px] font-semibold text-white hover:brightness-110"
                >
                  Run
                </button>
                <span className="text-[11px] text-osu-f1">Enter in a field runs it</span>
              </div>
            </section>
          ) : null}

          <section className="space-y-2 border-t border-white/[0.07] pt-4">
            <Label>Feed posts</Label>
            <input
              value={feedCountry}
              onChange={(event) => setFeedCountry(event.target.value.toUpperCase())}
              placeholder={`Country (default ${info?.defaultCountry ?? "CR"}, or GLOBAL)`}
              className="w-full rounded-md border border-white/[0.07] bg-osu-b4 px-2 py-1.5 text-[13px] text-osu-l1 outline-none placeholder:text-osu-f1 focus:border-osu-pink/60"
            />
            <div className="flex flex-wrap gap-2">
              {FEEDS.map((feed) => (
                <button
                  key={feed.feed}
                  type="button"
                  onClick={() => runFeed(feed.feed, feed.label)}
                  className="rounded-md bg-osu-b4 px-3 py-1.5 text-[12px] font-semibold text-osu-l1 hover:brightness-110"
                >
                  {feed.label}
                </button>
              ))}
            </div>
            <p className="text-[11px] leading-relaxed text-osu-f1">Built from the newest local data, the way the channel feeds post it.</p>
          </section>
        </aside>

        {/* Channel */}
        <div className="flex min-h-[70vh] min-w-0 flex-col lg:h-[calc(100vh-60px-49px)]" style={{ backgroundColor: DISCORD.msg, fontFamily: DISCORD.font }}>
          <div className="flex h-12 shrink-0 items-center gap-2 px-4" style={{ boxShadow: "0 1px 0 rgba(0,0,0,0.25)" }}>
            <span className="text-[22px] leading-none" style={{ color: "#80848e" }}>#</span>
            <span className="text-[16px] font-semibold" style={{ color: DISCORD.white }}>{inGuild ? "bot-playground" : "maniabot"}</span>
            <div className="ml-auto flex items-center gap-3 text-[13px]" style={{ color: DISCORD.muted }}>
              <Toggle checked={autoRerun} onChange={setAutoRerun} label="Re-run on backend reload" tone="discord" />
              <ChannelButton onClick={() => void rerunAll()} disabled={!entries.length}>Re-run all</ChannelButton>
              <ChannelButton onClick={() => { setEntries([]); setJsonOpen({}); }} disabled={!entries.length}>Clear</ChannelButton>
            </div>
          </div>
          <div
            ref={scrollRef}
            onScroll={(event) => {
              const el = event.currentTarget;
              stickRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
            }}
            onLoadCapture={() => {
              // Images landing late grow the transcript; keep the bottom in view.
              const el = scrollRef.current;
              if (el && stickRef.current) el.scrollTop = el.scrollHeight;
            }}
            className="min-h-0 flex-1 overflow-y-auto pb-6 pt-4"
          >
            {entries.length === 0 ? (
              <div className="px-6 py-10 text-[15px]" style={{ color: DISCORD.muted }}>
                Run a command on the left. Edit anything under backend/src/discord and the messages here re-run when the backend restarts.
              </div>
            ) : entries.map((entry) => (
              <MessageEntry
                key={entry.id}
                entry={entry}
                jsonOpen={Boolean(jsonOpen[entry.id])}
                onToggleJson={() => setJsonOpen((current) => ({ ...current, [entry.id]: !current[entry.id] }))}
                onRerun={() => void runEntry(entry)}
                onDismiss={() => setEntries((current) => current.filter((candidate) => candidate.id !== entry.id))}
                onButton={(component) => void clickButton(entry, component)}
                busyCustomId={busyButton}
              />
            ))}
          </div>
        </div>
      </div>

      {modal ? <ModalView modal={modal} onClose={() => setModal(null)} onSubmit={(fieldValues) => submitModal(modal, fieldValues)} /> : null}
    </div>
  );
}

// --- Composer pieces ---------------------------------------------------------

function Label({ children }: { children: ReactNode }) {
  return <div className="text-[11px] font-semibold uppercase tracking-wider text-osu-f1">{children}</div>;
}

function Toggle({ checked, onChange, label, disabled, tone }: { checked: boolean; onChange: (value: boolean) => void; label: string; disabled?: boolean; tone?: "discord" }) {
  return (
    <label className={`inline-flex cursor-pointer items-center gap-1.5 text-[12px] ${disabled ? "cursor-not-allowed opacity-40" : ""} ${tone === "discord" ? "" : "text-osu-l2"}`}>
      <input type="checkbox" checked={checked} disabled={disabled} onChange={(event) => onChange(event.target.checked)} className="accent-[#ff66ab]" />
      {label}
    </label>
  );
}

function ChannelButton({ children, onClick, disabled }: { children: ReactNode; onClick: () => void; disabled?: boolean }) {
  return (
    <button type="button" onClick={onClick} disabled={disabled} className="rounded px-1.5 py-0.5 hover:text-[#dbdee1] disabled:opacity-40">
      {children}
    </button>
  );
}

function OptionField({ def, value, onChange, onSubmit, autocomplete }: {
  def: OptionDef;
  value: string;
  onChange: (value: string) => void;
  onSubmit: () => void;
  autocomplete?: (typed: string) => Promise<Array<{ name: string; value: string | number }>>;
}) {
  const [choices, setChoices] = useState<Array<{ name: string; value: string | number }>>([]);
  const [open, setOpen] = useState(false);
  const requestRef = useRef(0);
  const fieldClass = "w-full rounded-md border border-white/[0.07] bg-osu-b4 px-2 py-1.5 text-[13px] text-osu-l1 outline-none placeholder:text-osu-f1 focus:border-osu-pink/60";

  const fetchChoices = useCallback((typed: string) => {
    if (!autocomplete) return;
    const ticket = ++requestRef.current;
    void autocomplete(typed).then((next) => {
      if (ticket === requestRef.current) setChoices(next);
    }).catch(() => {
      if (ticket === requestRef.current) setChoices([]);
    });
  }, [autocomplete]);

  useEffect(() => {
    if (!open || !autocomplete) return;
    const timer = setTimeout(() => fetchChoices(value), 150);
    return () => clearTimeout(timer);
    // autocomplete is recreated each render; the typed value is what matters.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, value]);

  let control: ReactNode;
  if (def.choices?.length) {
    control = (
      <select value={value} onChange={(event) => onChange(event.target.value)} className={fieldClass}>
        <option value="">-</option>
        {def.choices.map((choice) => <option key={String(choice.value)} value={String(choice.value)}>{choice.name}</option>)}
      </select>
    );
  } else if (def.type === OPT_BOOLEAN) {
    control = (
      <select value={value} onChange={(event) => onChange(event.target.value)} className={fieldClass}>
        <option value="">-</option>
        <option value="true">True</option>
        <option value="false">False</option>
      </select>
    );
  } else {
    control = (
      <div className="relative">
        <input
          value={value}
          inputMode={def.type === OPT_INTEGER || def.type === OPT_NUMBER ? "decimal" : undefined}
          onChange={(event) => onChange(event.target.value)}
          onFocus={() => setOpen(true)}
          onBlur={() => setTimeout(() => setOpen(false), 120)}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              setOpen(false);
              onSubmit();
            }
          }}
          placeholder={def.description}
          className={fieldClass}
        />
        {open && autocomplete && choices.length > 0 ? (
          <div className="absolute left-0 right-0 top-full z-20 mt-1 max-h-[220px] overflow-y-auto rounded-md border border-white/[0.07] py-1 shadow-xl" style={{ backgroundColor: DISCORD.embed }}>
            {choices.map((choice) => (
              <button
                key={`${choice.name}-${String(choice.value)}`}
                type="button"
                onMouseDown={(event) => {
                  event.preventDefault();
                  onChange(String(choice.value));
                  setOpen(false);
                }}
                className="block w-full px-2.5 py-1 text-left text-[13px] hover:bg-white/[0.06]"
                style={{ color: DISCORD.text }}
              >
                {choice.name}
                {String(choice.value) !== choice.name ? <span className="ml-2 text-[11px]" style={{ color: DISCORD.muted }}>{String(choice.value)}</span> : null}
              </button>
            ))}
          </div>
        ) : null}
      </div>
    );
  }

  return (
    <div className="space-y-1">
      <div className="text-[12px] font-semibold text-osu-l2">
        {def.name}
        {def.required ? <span className="text-osu-pink"> *</span> : null}
        <span className="ml-2 font-normal text-osu-f1">{def.description}</span>
      </div>
      {control}
    </div>
  );
}

function BackendStatus({ state, autoRerun }: { state: "up" | "down" | "reloaded"; autoRerun: boolean }) {
  if (!autoRerun) return null;
  const tone = state === "down" ? "bg-rose-400" : state === "reloaded" ? "bg-osu-yellow" : "bg-emerald-400";
  const text = state === "down" ? "Backend restarting" : state === "reloaded" ? "Reloaded, re-running" : "Watching backend";
  return (
    <span className="inline-flex items-center gap-1.5 text-[11px] text-osu-f1">
      <span className={`h-1.5 w-1.5 rounded-full ${tone}`} />
      {text}
    </span>
  );
}

// --- Channel pieces ----------------------------------------------------------

function BotAvatar() {
  return <img src="/images/discord/bot-avatar.png" alt="" className="h-10 w-10 rounded-full object-cover" />;
}

function SmallAvatar({ src }: { src: string | null }) {
  if (src) return <img src={src} alt="" className="h-4 w-4 rounded-full object-cover" />;
  return <span className="inline-block h-4 w-4 rounded-full" style={{ backgroundColor: DISCORD.blurple }} />;
}

function EyeIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" aria-hidden>
      <path fill="currentColor" d="M12 5C5.6 5 2 12 2 12s3.6 7 10 7 10-7 10-7-3.6-7-10-7Zm0 11a4 4 0 1 1 0-8 4 4 0 0 1 0 8Zm0-2a2 2 0 1 0 0-4 2 2 0 0 0 0 4Z" />
    </svg>
  );
}

function MessageEntry({ entry, jsonOpen, onToggleJson, onRerun, onDismiss, onButton, busyCustomId }: {
  entry: Entry;
  jsonOpen: boolean;
  onToggleJson: () => void;
  onRerun: () => void;
  onDismiss: () => void;
  onButton: (component: DiscordComponentJson) => void;
  busyCustomId: string | null;
}) {
  const ephemeral = ((entry.message?.flags ?? 0) & FLAG_EPHEMERAL) !== 0;
  const problems = entry.message ? lintDiscordMessage(entry.message) : [];
  const stats = entry.message ? messageStats(entry.message) : null;
  const isFeed = entry.source.kind === "feed";
  return (
    <div className="group relative mt-4 px-4 py-0.5 hover:bg-[#2e3035]" style={ephemeral ? { backgroundColor: "rgba(88,101,242,0.05)" } : undefined}>
      {/* Hover actions, where Discord puts its message toolbar. */}
      <div className="absolute -top-3 right-4 z-10 hidden items-center gap-px overflow-hidden rounded-md text-[12px] shadow group-hover:flex" style={{ backgroundColor: DISCORD.msg, border: `1px solid ${DISCORD.deep}`, color: DISCORD.muted }}>
        {stats ? <span className="px-2 py-1">{stats.components}/40 parts, {stats.textChars.toLocaleString("en-US")}/4,000 chars</span> : null}
        {entry.elapsedMs != null ? <span className="px-2 py-1">{entry.elapsedMs} ms</span> : null}
        <button type="button" onClick={onRerun} className="px-2 py-1 hover:bg-white/[0.06] hover:text-[#dbdee1]">Re-run</button>
        <button type="button" onClick={onToggleJson} className="px-2 py-1 hover:bg-white/[0.06] hover:text-[#dbdee1]">{jsonOpen ? "Hide JSON" : "JSON"}</button>
        <button type="button" onClick={onDismiss} className="px-2 py-1 hover:bg-white/[0.06] hover:text-[#dbdee1]">Remove</button>
      </div>

      {!isFeed ? (
        <div className="relative mb-1 flex items-center gap-1 pl-[56px] text-[14px]" style={{ color: DISCORD.muted }}>
          <span className="absolute left-[36px] top-[9px] h-[12px] w-[18px] rounded-tl-md border-l-2 border-t-2" style={{ borderColor: "#4e5058" }} />
          <SmallAvatar src={entry.actorAvatar} />
          <span className="font-medium" style={{ color: DISCORD.text }}>{entry.actorName}</span>
          <span>used</span>
          <span className="truncate" style={{ color: DISCORD.link }}>{entry.label}</span>
        </div>
      ) : null}

      <div className="flex gap-4">
        <div className="shrink-0 pt-0.5"><BotAvatar /></div>
        <div className="min-w-0 flex-1">
          <div className="flex items-baseline gap-1.5">
            <span className="text-[16px] font-medium" style={{ color: DISCORD.white }}>maniabot</span>
            <span className="relative -top-px rounded-[3px] px-1 text-[10px] font-semibold leading-[15px] text-white" style={{ backgroundColor: DISCORD.blurple }}>APP</span>
            <span className="text-[12px]" style={{ color: DISCORD.muted }}>Today at {formatClock(entry.at)}</span>
            {isFeed ? <span className="text-[12px]" style={{ color: DISCORD.muted }}>{entry.label}</span> : null}
          </div>

          <div className="mt-0.5">
            {entry.pending && !entry.message ? (
              <div className="text-[15px] italic" style={{ color: DISCORD.muted }}>
                maniabot is thinking<span className="inline-block animate-pulse">...</span>
              </div>
            ) : null}
            {entry.message ? (
              <div className={entry.pending ? "opacity-60 transition-opacity" : "transition-opacity"}>
                <DiscordMessageBodyView body={entry.message} handlers={{ onButton, busyCustomId }} />
              </div>
            ) : null}
            {entry.error ? <div className="mt-1 text-[14px]" style={{ color: "#f23f43" }}>{entry.error}</div> : null}
            {entry.handlerError ? (
              <pre className="mt-2 max-h-[240px] overflow-auto whitespace-pre-wrap rounded-md p-2 text-[12px]" style={{ backgroundColor: "rgba(242,63,67,0.08)", color: "#fca5a5", fontFamily: DISCORD.mono }}>
                {entry.handlerError}
              </pre>
            ) : null}
            {problems.length ? (
              <div className="mt-2 space-y-0.5 border-t border-white/[0.07] pt-1.5 text-[13px]" style={{ color: "#f0b232" }}>
                <div className="font-semibold">Discord would reject this message:</div>
                {problems.map((problem, index) => <div key={index}>{problem}</div>)}
              </div>
            ) : null}
            {ephemeral ? (
              <div className="mt-1 flex items-center gap-1 text-[12px]" style={{ color: DISCORD.muted }}>
                <EyeIcon />
                <span>Only you can see this</span>
                <span className="mx-1 h-3 w-px" style={{ backgroundColor: "#4e5058" }} />
                <button type="button" onClick={onDismiss} className="hover:underline" style={{ color: DISCORD.link }}>Dismiss message</button>
              </div>
            ) : null}
            {jsonOpen && entry.message ? (
              <pre className="mt-2 max-h-[420px] overflow-auto rounded-md p-3 text-[12px] leading-[1.4]" style={{ backgroundColor: DISCORD.deep, color: "#b5bac1", fontFamily: DISCORD.mono }}>
                {JSON.stringify(entry.message, null, 2)}
              </pre>
            ) : null}
          </div>
        </div>
      </div>
    </div>
  );
}

function ModalView({ modal, onClose, onSubmit }: { modal: OpenModal; onClose: () => void; onSubmit: (values: Record<string, string>) => void }) {
  const [fieldValues, setFieldValues] = useState<Record<string, string>>({});
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4" onClick={onClose} style={{ fontFamily: DISCORD.font }}>
      <form
        className="w-full max-w-[440px] overflow-hidden rounded-lg"
        style={{ backgroundColor: DISCORD.msg }}
        onClick={(event) => event.stopPropagation()}
        onSubmit={(event) => {
          event.preventDefault();
          onSubmit(fieldValues);
        }}
      >
        <div className="flex items-center gap-2 px-4 pb-2 pt-4">
          <img src="/images/discord/bot-avatar.png" alt="" className="h-6 w-6 rounded-full" />
          <div className="text-[20px] font-semibold" style={{ color: DISCORD.white }}>{modal.title}</div>
        </div>
        <div className="space-y-4 px-4 py-3">
          {modal.fields.map((field, index) => (
            <label key={field.custom_id} className="block">
              <div className="mb-2 text-[12px] font-bold uppercase" style={{ color: "#b5bac1" }}>
                {field.label}
                {field.required ? <span style={{ color: "#f23f43" }}> *</span> : null}
              </div>
              <input
                autoFocus={index === 0}
                required={field.required}
                maxLength={field.max_length}
                placeholder={field.placeholder}
                value={fieldValues[field.custom_id] ?? ""}
                onChange={(event) => setFieldValues((current) => ({ ...current, [field.custom_id]: event.target.value }))}
                className="w-full rounded-[3px] px-2.5 py-2.5 text-[16px] outline-none"
                style={{ backgroundColor: DISCORD.deep, color: DISCORD.text }}
              />
            </label>
          ))}
        </div>
        <div className="flex justify-end gap-2 px-4 py-4" style={{ backgroundColor: DISCORD.embed }}>
          <button type="button" onClick={onClose} className="px-4 py-2 text-[14px] font-medium hover:underline" style={{ color: DISCORD.white }}>Cancel</button>
          <button type="submit" className="rounded-[3px] px-4 py-2 text-[14px] font-medium text-white hover:brightness-110" style={{ backgroundColor: DISCORD.blurple }}>Submit</button>
        </div>
      </form>
    </div>
  );
}
