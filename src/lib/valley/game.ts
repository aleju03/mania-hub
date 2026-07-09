// Game orchestrator: owns the canvas, the sim, the renderer and the audio,
// translates clicks into Deltarune-style dialogs and status payloads into
// world changes. The route component only feeds it data.

import { clamp, ctx2d, VIEW_W, VIEW_H, type Ctx, type Sprite } from "./core";
import { textWidth } from "./font";
import { buildMap, type ValleyMap } from "./map";
import { buildSprites, type ValleySprites } from "./sprites";
import { ValleySim } from "./sim";
import { ValleyRenderer, type DialogState } from "./render";
import { ValleyAudio } from "./audio";
import { parseValleyStatus, type ValleyStatus, type ValleyVisitors } from "./types";
import { C } from "./core";

const SOUND_PREF_KEY = "mania-valley-sound";
const TEXT_SPEED = 55; // chars/sec
const DIALOG_TEXT_W = 560;

function timeAgo(iso: string | null): string {
  if (!iso) return "NEVER";
  const ms = Date.now() - new Date(iso).getTime();
  if (!Number.isFinite(ms) || ms < 0) return "JUST NOW";
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}S AGO`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}M AGO`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h}H ${m % 60}M AGO`;
  return `${Math.floor(h / 24)}D AGO`;
}

function fmtBytes(bytes: number): string {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
  if (bytes >= 1024 ** 2) return `${Math.round(bytes / 1024 ** 2)} MB`;
  return `${Math.round(bytes / 1024)} KB`;
}

function wrap(text: string, maxW: number): string[] {
  const words = text.split(" ");
  const lines: string[] = [];
  let line = "";
  for (const word of words) {
    const next = line ? `${line} ${word}` : word;
    if (textWidth(next) > maxW && line) {
      lines.push(line);
      line = word;
    } else {
      line = next;
    }
  }
  if (line) lines.push(line);
  return lines;
}

export class ValleyGame {
  private canvas: HTMLCanvasElement;
  private ctx: Ctx;
  private map: ValleyMap;
  private sprites: ValleySprites;
  private sim: ValleySim;
  private renderer: ValleyRenderer;
  private audio = new ValleyAudio();
  private raf = 0;
  private lastT = 0;
  private mouse: { x: number; y: number } | null = null; // screen space
  private hover: { id: string; label: string } | null = null;
  private dialog: DialogState | null = null;
  private zoom = 2; // 2 = follow player, 1 = whole map
  private keys = new Set<string>();
  private blipAt = 0;
  private cluckAt = 0;
  private lastPlace = "world";
  private destroyed = false;
  private disposers: Array<() => void> = [];

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    canvas.width = VIEW_W;
    canvas.height = VIEW_H;
    this.ctx = ctx2d(canvas);
    this.resize();
    this.map = buildMap();
    this.sprites = buildSprites();
    this.sim = new ValleySim(this.map);
    this.renderer = new ValleyRenderer(this.map, this.sprites);
    try {
      this.audio.setMuted(window.localStorage.getItem(SOUND_PREF_KEY) === "off");
    } catch {
      // ignore
    }
    this.bindInput();
  }

  // ------------------------------------------------------------------ data

  updateStatus(raw: unknown): void {
    this.sim.setStatus(parseValleyStatus(raw));
  }

  updateVisitors(v: ValleyVisitors): void {
    this.sim.setVisitors(v);
  }

  markConnectionLost(): void {
    this.sim.setConnectionLost();
  }

  // Match the internal resolution to the on-screen box: landscape keeps the
  // classic 768x432, portrait narrows to 384 wide so the world stays chunky
  // and the UI can draw at 2x for touch.
  private resize(): void {
    const rect = this.canvas.getBoundingClientRect();
    if (rect.width < 10 || rect.height < 10) return;
    const aspect = rect.width / rect.height;
    let iw = VIEW_W;
    let ih = VIEW_H;
    if (aspect < 1.3) {
      iw = 384;
      ih = clamp(Math.round(384 / aspect / 2) * 2, 432, 688);
    }
    if (this.canvas.width !== iw || this.canvas.height !== ih) {
      this.canvas.width = iw;
      this.canvas.height = ih;
      this.ctx.imageSmoothingEnabled = false; // canvas resize resets ctx state
    }
  }

  get muted(): boolean {
    return this.audio.muted;
  }

  toggleSound(): boolean {
    this.audio.unlock();
    const next = !this.audio.muted;
    this.audio.setMuted(next);
    try {
      window.localStorage.setItem(SOUND_PREF_KEY, next ? "off" : "on");
    } catch {
      // ignore
    }
    return next;
  }

  // ------------------------------------------------------------------ loop

  start(): void {
    this.lastT = performance.now();
    const frame = (now: number) => {
      if (this.destroyed) return;
      const dt = clamp((now - this.lastT) / 1000, 0, 0.1);
      this.lastT = now;
      const d = new Date();
      const hour = d.getHours() + d.getMinutes() / 60 + d.getSeconds() / 3600;

      // keyboard movement
      const k = this.keys;
      this.sim.moveInput.x = (k.has("d") || k.has("arrowright") ? 1 : 0) - (k.has("a") || k.has("arrowleft") ? 1 : 0);
      this.sim.moveInput.y = (k.has("s") || k.has("arrowdown") ? 1 : 0) - (k.has("w") || k.has("arrowup") ? 1 : 0);
      this.sim.sprint = k.has("shift");

      this.sim.update(dt, hour);
      if (this.sim.place !== this.lastPlace) {
        // walked through a door: stale hover/dialog belong to the old scene
        this.lastPlace = this.sim.place;
        this.dialog = null;
        this.hover = null;
      }
      this.pumpSounds();
      this.audio.tick(dt, hour, this.sim.weather === "storm");
      this.audio.setRain((this.sim.weather === "rain" || this.sim.weather === "storm") && this.sim.weatherBlend > 0.4);

      if (this.dialog) {
        const total = this.dialog.lines.reduce((a, l) => a + l.length, 0);
        if (this.dialog.revealed < total) {
          this.dialog.revealed = Math.min(total, this.dialog.revealed + dt * TEXT_SPEED);
          if (this.sim.t > this.blipAt) {
            this.blipAt = this.sim.t + 0.06;
            this.audio.play("blip");
          }
        }
      }

      this.renderer.render(this.ctx, this.sim, {
        hour,
        dt,
        zoom: this.zoom,
        muted: this.audio.muted,
        audioUnlocked: this.audio.unlocked,
        mouse: this.mouse,
        hover: this.hover,
        dialog: this.dialog,
      });
      this.raf = requestAnimationFrame(frame);
    };
    this.raf = requestAnimationFrame(frame);
  }

  destroy(): void {
    this.destroyed = true;
    cancelAnimationFrame(this.raf);
    for (const dispose of this.disposers) dispose();
    this.audio.destroy();
  }

  private pumpSounds(): void {
    for (const ev of this.sim.drainSounds()) {
      if (ev === "thunder") {
        this.renderer.flashLightning(this.sim.t);
        this.audio.play("thunder");
      } else if (ev === "cluck") {
        if (this.sim.t > this.cluckAt) {
          this.cluckAt = this.sim.t + 1.2;
          this.audio.play("cluck");
        }
      } else {
        this.audio.play(ev);
      }
    }
  }

  // ------------------------------------------------------------------ input

  private bindInput(): void {
    const toScreen = (e: MouseEvent): { x: number; y: number } => {
      const rect = this.canvas.getBoundingClientRect();
      return {
        x: ((e.clientX - rect.left) / rect.width) * this.canvas.width,
        y: ((e.clientY - rect.top) / rect.height) * this.canvas.height,
      };
    };
    const toWorld = (screen: { x: number; y: number }): { x: number; y: number } =>
      this.renderer.toWorld(screen);
    const inRect = (p: { x: number; y: number }, r: { x: number; y: number; w: number; h: number }) =>
      p.x >= r.x && p.x <= r.x + r.w && p.y >= r.y && p.y <= r.y + r.h;

    const onMove = (e: MouseEvent) => {
      this.mouse = toScreen(e);
      const world = toWorld(this.mouse);
      const btns = this.renderer.uiButtons();
      const ui = inRect(this.mouse, btns.sound) || inRect(this.mouse, btns.zoom);
      this.hover = ui ? null : this.hitTest(world.x, world.y);
      this.canvas.style.cursor = ui || this.hover ? "pointer" : "default";
    };
    const onLeave = () => {
      this.mouse = null;
      this.hover = null;
    };
    const onClick = (e: MouseEvent) => {
      this.audio.unlock();
      const screen = toScreen(e);
      const btns = this.renderer.uiButtons();
      if (inRect(screen, btns.sound)) {
        this.toggleSound();
        return;
      }
      if (inRect(screen, btns.zoom)) {
        this.zoom = this.zoom === 2 ? 1 : 2;
        this.audio.play("open");
        return;
      }
      const pos = toWorld(screen);
      const hit = this.hitTest(pos.x, pos.y);
      if (hit && hit.id.startsWith("door-")) {
        this.dialog = null;
        this.sim.requestEnter(hit.id.slice(5));
        return;
      }
      if (hit && hit.id === "exit") {
        this.dialog = null;
        const int = this.sim.interiors[this.sim.place];
        if (int) this.sim.setMoveTarget(int.exit.x + int.exit.w / 2, int.exit.y + int.exit.h - 1);
        return;
      }
      if (this.dialog) {
        const total = this.dialog.lines.reduce((a, l) => a + l.length, 0);
        if (this.dialog.revealed < total) {
          this.dialog.revealed = total;
        } else if (hit && hit.id !== this.dialog.id) {
          this.openDialog(hit.id);
        } else {
          this.dialog = null;
          this.audio.play("close");
        }
        return;
      }
      if (hit) {
        this.openDialog(hit.id);
      } else {
        // tap-to-move
        this.sim.setMoveTarget(pos.x, pos.y);
      }
    };
    const onKeyDown = (e: KeyboardEvent) => {
      const key = e.key.toLowerCase();
      if (key === "escape" && this.dialog) {
        this.dialog = null;
        this.audio.play("close");
        return;
      }
      if (key === "m") {
        this.toggleSound();
        return;
      }
      if (key === "z") {
        this.zoom = this.zoom === 2 ? 1 : 2;
        return;
      }
      if (key === "shift") {
        this.keys.add(key);
        return;
      }
      if (["w", "a", "s", "d", "arrowup", "arrowdown", "arrowleft", "arrowright"].includes(key)) {
        if (key.startsWith("arrow")) e.preventDefault();
        this.keys.add(key);
        this.audio.unlock();
      }
    };
    const onKeyUp = (e: KeyboardEvent) => {
      this.keys.delete(e.key.toLowerCase());
    };
    const onBlur = () => this.keys.clear();
    const onResize = () => this.resize();

    this.canvas.addEventListener("mousemove", onMove);
    this.canvas.addEventListener("mouseleave", onLeave);
    this.canvas.addEventListener("click", onClick);
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    window.addEventListener("blur", onBlur);
    window.addEventListener("resize", onResize);
    let ro: ResizeObserver | null = null;
    if (typeof ResizeObserver !== "undefined") {
      ro = new ResizeObserver(onResize);
      ro.observe(this.canvas);
    }
    this.disposers.push(() => {
      this.canvas.removeEventListener("mousemove", onMove);
      this.canvas.removeEventListener("mouseleave", onLeave);
      this.canvas.removeEventListener("click", onClick);
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
      window.removeEventListener("blur", onBlur);
      window.removeEventListener("resize", onResize);
      ro?.disconnect();
    });
  }

  private hitTest(x: number, y: number): { id: string; label: string } | null {
    // characters first
    const pl = this.sim.player;
    if (Math.abs(x - pl.x) <= 8 && y >= pl.y - 19 && y <= pl.y + 3) {
      return { id: "player", label: "YOU" };
    }
    if (this.sim.place !== "world") {
      const int = this.sim.interiors[this.sim.place];
      if (!int) return null;
      const e = int.exit;
      if (x >= e.x - 2 && x <= e.x + e.w + 2 && y >= e.y - 3 && y <= e.y + e.h + 6) {
        return { id: "exit", label: "LEAVE" };
      }
      const spots = int.dynamicHotspots ? [...int.dynamicHotspots(this.sim), ...int.hotspots] : int.hotspots;
      for (const h of spots) {
        if (x >= h.rect.x && x <= h.rect.x + h.rect.w && y >= h.rect.y && y <= h.rect.y + h.rect.h) {
          return { id: h.id, label: h.label };
        }
      }
      return null;
    }
    for (const n of this.sim.npcs) {
      if (Math.abs(x - n.x) <= 8 && y >= n.y - 19 && y <= n.y + 3) {
        return n.kind === "farmer"
          ? { id: `farmer-${n.id}`, label: "FARMHAND" }
          : { id: `villager-${n.id}`, label: "VISITOR" };
      }
    }
    for (let i = 0; i < this.sim.chickens.length; i++) {
      const ch = this.sim.chickens[i];
      if (Math.abs(x - ch.x) <= 7 && Math.abs(y - ch.y) <= 8) {
        return { id: `chicken-${i}`, label: "CHICKEN" };
      }
    }
    if (this.sim.scarecrow) {
      const sx = this.map.fieldRect.x + this.map.fieldRect.w - 30;
      const sy = this.map.fieldRect.y + 26;
      if (x >= sx - 2 && x <= sx + 18 && y >= sy - 2 && y <= sy + 24) {
        return { id: "scarecrow", label: "SCARECROW" };
      }
    }
    // doors win over the building hotspots that contain them
    for (const d of this.sim.doors) {
      if (x >= d.rect.x && x <= d.rect.x + d.rect.w && y >= d.rect.y && y <= d.rect.y + d.rect.h) {
        return { id: `door-${d.id}`, label: "GO INSIDE" };
      }
    }
    for (const h of this.map.hotspots) {
      if (x >= h.rect.x && x <= h.rect.x + h.rect.w && y >= h.rect.y && y <= h.rect.y + h.rect.h) {
        return { id: h.id, label: h.label };
      }
    }
    return null;
  }

  // ------------------------------------------------------------------ dialogs

  private openDialog(id: string): void {
    const built = this.buildDialog(id);
    if (!built) return;
    this.dialog = built;
    this.audio.play("open");
  }

  private buildDialog(id: string): DialogState | null {
    const s = this.sim.status;
    // portrait screens draw dialog text at 2x in a narrower box
    const maxW = this.canvas.width < 520 ? 138 : DIALOG_TEXT_W;
    const make = (title: string, text: string[], portrait: Sprite | null, accent: string = C.uiYellow): DialogState => ({
      id,
      title,
      lines: text.flatMap((t) => wrap(t, maxW)),
      revealed: 0,
      portrait,
      accent,
    });
    const sp = this.sprites;

    if (id.startsWith("villager-")) {
      const n = this.sim.npcs.find((v) => `villager-${v.id}` === id);
      const count = this.sim.visitors?.activeVisitors ?? 0;
      const lines = [
        count > 0
          ? `ONE OF ${count} VISITOR${count === 1 ? "" : "S"} BROWSING THE SITE IN THE LAST 5 MINUTES.`
          : "A VISITOR FROM THE ANALYTICS FEED.",
      ];
      if (n?.bubble) lines.push(`CURRENTLY LOOKING AT: ${n.bubble.text}.`);
      lines.push("SPEECH BUBBLES ARE REAL PAGEVIEWS AS THEY HAPPEN.");
      return make("VISITOR", lines, sp.villagers[(n?.palette ?? 0) % sp.villagers.length].front[0], C.uiPink);
    }
    if (id === "player") {
      return make(
        "YOU",
        [
          "THE KEEPER OF MANIA VALLEY. THIS FARM IS YOUR LIVE BACKEND.",
          "WASD OR TAP THE GROUND TO WALK, HOLD SHIFT TO RUN. WALK INTO A DOORWAY TO GO INSIDE.",
        ],
        sp.player.front[0],
        C.uiPink,
      );
    }
    if (id.startsWith("resident-")) {
      const idx = Number(id.slice(9));
      const c = this.sim.housesRanked[idx] ?? null;
      if (!c) {
        return make("EMPTY HOUSE", ["DUST AND COBWEBS. NO COUNTRY HAS SETTLED THIS HOUSE YET."], null, C.uiDim);
      }
      return make(
        `RESIDENT · ${c.country}`,
        [
          `KEEPS THE ${c.country} HOUSE: STATUS ${c.status.toUpperCase()}, TIER ${c.featureTier.toUpperCase()}${c.pinned ? ", PINNED" : ""}.`,
          `${c.activeUsers} ACTIVE USER${c.activeUsers === 1 ? "" : "S"}, LAST ACTIVITY ${timeAgo(c.lastActiveAt)}.`,
          c.isWarm ? "THE HEARTH IS WARM: THIS COUNTRY IS ACTIVE." : "DOZING. THE COUNTRY IS COLD UNTIL SOMEONE VISITS.",
        ],
        sp.villagers[idx % sp.villagers.length].front[0],
        C.uiBlue,
      );
    }
    if (id.startsWith("farmer-")) {
      const lanes = s?.lanes ?? [];
      const busy = lanes.filter((l) => l.active > 0);
      const lines = [
        s?.workerPaused
          ? "ZZZ... THE WORKERS ARE PAUSED FROM THE ADMIN PANEL."
          : busy.length
            ? `WORKING ${busy.length}/${lanes.length} LANES: ${busy
                .slice(0, 3)
                .map((l) => l.name)
                .join(", ")
                .toUpperCase()}.`
            : "ALL LANES IDLE. WAITING FOR JOBS TO RIPEN.",
        "FARMHANDS ARE THE JOB QUEUE WORKER LANES.",
      ];
      return make("FARMHAND", lines, sp.farmer.front[0], C.uiGreen);
    }
    if (id.startsWith("chicken-")) {
      const total = s?.sseTotal ?? 0;
      const ips = s?.sseIps ?? 0;
      return make(
        "CHICKEN",
        [
          "BAWK.",
          `EACH CHICKEN IS A LIVE SSE STREAM. ${total} STREAM${total === 1 ? "" : "S"} FROM ${ips} IP${ips === 1 ? "" : "S"} CONNECTED RIGHT NOW.`,
        ],
        sp.chicken[0],
        C.uiPink,
      );
    }
    if (id.startsWith("house-")) {
      const idx = Number(id.slice(6));
      const houses = this.houseAssignments();
      const c = houses[idx];
      if (!c) {
        return make("EMPTY HOUSE", ["NOBODY HAS SETTLED HERE YET."], sp.houses[idx % sp.houses.length]);
      }
      return make(
        `VILLAGE HOUSE · ${c.country}`,
        [
          `STATUS ${c.status.toUpperCase()} · TIER ${c.featureTier.toUpperCase()}${c.pinned ? " · PINNED" : ""}.`,
          `${c.activeUsers} ACTIVE USER${c.activeUsers === 1 ? "" : "S"}, LAST ACTIVITY ${timeAgo(c.lastActiveAt)}.`,
          c.isWarm ? "THE LIGHTS ARE ON: THIS COUNTRY IS WARM." : "COLD AND DARK UNTIL SOMEONE VISITS.",
        ],
        sp.houses[idx % sp.houses.length],
        C.uiBlue,
      );
    }

    switch (id) {
      case "farmhouse": {
        const ok = s ? s.ok && s.db : false;
        return make(
          "FARMHOUSE · SERVER",
          [
            this.sim.connectionLost
              ? "NOBODY ANSWERS THE DOOR. THE MONITOR CANNOT REACH THE BACKEND."
              : ok
                ? "THE LIVE BACKEND LIVES HERE. SERVER OK, DATABASE CONNECTED."
                : "SOMETHING IS WRONG INSIDE. THE SERVER REPORTS PROBLEMS.",
            `LAST SCORE EVENT: ${timeAgo(s?.lastEventAt ?? null)}.`,
            "SMOKE FROM THE CHIMNEY MEANS THE SERVER IS HEALTHY.",
          ],
          sp.farmhouse,
        );
      }
      case "windmill": {
        const r = s?.rate;
        const lines = r
          ? [
              `GRINDING ${r.usedLastMinute} OSU! API CALLS THIS MINUTE. TARGET ${r.targetPerMinute}, HARD CAP ${r.hardPerMinute}.`,
              r.byCaller.length
                ? `TOP CALLER: ${r.byCaller[0].caller.toUpperCase()} (${r.byCaller[0].count}).`
                : "NO CALLS IN THE LAST MINUTE.",
              r.usedLastMinute > r.targetPerMinute
                ? "THE BLADES ARE RUNNING HOT: OVER TARGET BUDGET!"
                : "THE FASTER THE BLADES SPIN, THE MORE API BUDGET IS IN USE.",
            ]
          : ["NO RATE DATA YET."];
        return make("WINDMILL · OSU! API", lines, sp.windmill);
      }
      case "barn": {
        const st = s?.storage;
        const lines = st
          ? [
              `THE DATABASE BARN HOLDS ${fmtBytes(st.bytes)} OF ${fmtBytes(st.maxBytes)} (${Math.round((st.bytes / st.maxBytes) * 100)}%).`,
              `WAL HAYSTACK OUTSIDE: ${fmtBytes(st.walBytes)}. ${s!.sqliteBusyExhausted > 0 ? `SQLITE WAS BUSY ${s!.sqliteBusyExhausted}X, LAST ${timeAgo(s!.sqliteBusyLastAt)}.` : "SQLITE HAS NOT CHOKED RECENTLY."}`,
            ]
          : ["NO STORAGE DATA YET."];
        return make("BARN · SQLITE", lines, sp.barn);
      }
      case "silo": {
        const st = s?.storage;
        return make(
          "SILO · STORAGE",
          st
            ? [
                `${Math.round((st.bytes / st.maxBytes) * 100)}% FULL (${fmtBytes(st.bytes)} / ${fmtBytes(st.maxBytes)}).`,
                st.overLimit ? "OVER THE LIMIT! COMPACTION NEEDED." : "COMFORTABLY UNDER THE LIMIT.",
              ]
            : ["NO STORAGE DATA YET."],
          sp.silo,
        );
      }
      case "well": {
        const fb = s?.scoresFallback;
        return make(
          "WELL · SCORES FALLBACK",
          fb
            ? [
                fb.enabled
                  ? "WHEN THE RIVER RUNS DRY, SCORES GET PULLED UP FROM THIS WELL (OSU! API CURSOR SCAN)."
                  : "THE FALLBACK SCANNER IS DISABLED.",
                `LAST SCAN: ${fb.fetched} FETCHED, ${fb.inserted} INSERTED, ${timeAgo(fb.updatedAt)}.`,
              ]
            : ["NO FALLBACK DATA YET."],
          sp.well,
        );
      }
      case "field": {
        const summary = (s?.queueSummary ?? [])
          .filter((q) => q.count > 0)
          .sort((a, b) => b.count - a.count)
          .slice(0, 2);
        return make(
          "CROP FIELD · JOB QUEUE",
          [
            `${s?.queueDepth ?? 0} JOBS IN THE QUEUE. EVERY CROP IS A QUEUED JOB; HARVESTS ARE COMPLETIONS.`,
            summary.length
              ? `BIGGEST BATCHES: ${summary.map((q) => `${q.type.toUpperCase()} ×${q.count}`).join(", ")}.`
              : "THE FIELD IS QUIET.",
            s?.shedding ? "THE SCARECROW IS UP: QUEUE PRESSURE IS SHEDDING LOAD." : "PRESSURE IS NORMAL.",
          ],
          null,
          C.uiGreen,
        );
      }
      case "seedbed": {
        return make(
          "SEEDBED · DEFERRED JOBS",
          [
            `${s?.deferred ?? 0} JOBS WAIT HERE, DEFERRED BY QUEUE PRESSURE OR TYPE CAPS.`,
            "THEY GET PLANTED IN THE BIG FIELD WHEN A LANE FREES UP.",
          ],
          sp.seedling,
          C.uiGreen,
        );
      }
      case "coop":
      case "pen": {
        const total = s?.sseTotal ?? 0;
        return make(
          "COOP · LIVE STREAMS",
          [
            `${total} SSE STREAM${total === 1 ? "" : "S"} CONNECTED FROM ${s?.sseIps ?? 0} IP${(s?.sseIps ?? 0) === 1 ? "" : "S"}.`,
            "EVERY CHICKEN IS A BROWSER WATCHING LIVE UPDATES.",
          ],
          sp.coop,
          C.uiPink,
        );
      }
      case "river": {
        const osc = s?.osc;
        const lines: string[] = [];
        if (!osc || this.sim.connectionLost) lines.push("THE RIVER CARRIES SCORES FROM THE OSC FEED INTO THE VALLEY.");
        else if (!osc.connected) {
          lines.push("THE RIVER RAN DRY: THE OSC SOCKET IS DISCONNECTED.");
          lines.push(`${osc.restarts} RESTARTS SO FAR. ${osc.lastError ? osc.lastError.toUpperCase().slice(0, 80) : ""}`);
        } else if (osc.stale) {
          lines.push(`THE RIVER RUNS MURKY: CONNECTED BUT NO SCORES SINCE ${timeAgo(osc.staleSinceAt)}.`);
          if (osc.nextReconnectAt) lines.push(`NEXT RECONNECT ATTEMPT ${timeAgo(osc.nextReconnectAt).replace(" AGO", "")}.`);
        } else {
          lines.push("SCORES FLOW DOWN THIS RIVER FROM KAYLA'S OSC FEED. SPLASHES ARE FRESH SCORES.");
          lines.push(`LAST EVENT ${timeAgo(s?.lastEventAt ?? null)}. ${osc.restarts} RECONNECTS THIS LIFETIME.`);
        }
        return make("RIVER · OSC SCORE FEED", lines, sp.boat, C.uiBlue);
      }
      case "signpost": {
        const countries = s?.countries ?? [];
        const warm = countries.filter((c) => c.isWarm).length;
        const active = countries.reduce((a, c) => a + c.activeUsers, 0);
        return make(
          "VILLAGE SIGN · COUNTRIES",
          [
            `${countries.length} COUNTRIES SETTLED IN THE VALLEY. ${warm} WARM, ${active} ACTIVE USER${active === 1 ? "" : "S"} RIGHT NOW.`,
            "THE SIX HOUSES SHOW THE TOP COUNTRIES: LIT WINDOWS MEAN WARM.",
          ],
          sp.signpost,
          C.uiBlue,
        );
      }
      case "scarecrow": {
        return make(
          "SCARECROW · LOAD SHEDDING",
          [
            "THE QUEUE IS OVER ITS SOFT DEPTH, SO NEW BACKGROUND JOBS GET SHOOED AWAY.",
            `DEPTH ${s?.queueDepth ?? 0}, DEFERRED ${s?.deferred ?? 0}.`,
          ],
          sp.scarecrow,
          C.uiRed,
        );
      }

      // ---- interior hotspots ----
      case "int-journal": {
        const lines = s
          ? [
              `SERVER ${s.ok && s.db ? "OK" : "NOT OK"} · QUEUE ${s.queueDepth} · DEFERRED ${s.deferred}.`,
              s.rate
                ? `API ${s.rate.usedLastMinute}/${s.rate.targetPerMinute} THIS MINUTE · ${s.apiErrors15m} ERROR${s.apiErrors15m === 1 ? "" : "S"} IN 15M.`
                : `${s.apiErrors15m} API ERRORS IN THE LAST 15 MINUTES.`,
              `LAST SCORE EVENT ${timeAgo(s.lastEventAt)}.`,
            ]
          : ["THE PAGES ARE BLANK. NO STATUS DATA YET."];
        return make("FARM JOURNAL", lines, null);
      }
      case "int-hearth": {
        return make(
          "HEARTH",
          [
            this.sim.serverOk
              ? "THE FIRE BURNS AS LONG AS THE SERVER IS HEALTHY."
              : "COLD ASHES. THE SERVER REPORTS PROBLEMS.",
            "SAME SIGNAL AS THE CHIMNEY SMOKE OUTSIDE.",
          ],
          null,
          this.sim.serverOk ? C.uiYellow : C.uiRed,
        );
      }
      case "int-bed": {
        return make(
          "BED",
          [
            "YOUR BED. NO TIME TO SLEEP: THE QUEUE NEVER SLEEPS EITHER.",
            s?.workerPaused
              ? "THE FARMHANDS ARE NAPPING THOUGH. WORKERS ARE PAUSED."
              : "THE FARMHANDS ARE OUT WORKING THE FIELD.",
          ],
          null,
          C.uiPink,
        );
      }
      case "int-cat": {
        return make("CAT", ["MROW.", "THE CAT MONITORS NOTHING. IT IS SIMPLY A CAT."], null, C.uiPink);
      }
      case "cottage-bed": {
        return make("GUEST BED", ["A NEATLY MADE GUEST BED. VISITORS REST HERE BETWEEN PAGEVIEWS."], null, C.uiPink);
      }
      case "int-crates": {
        const summary = (s?.queueSummary ?? [])
          .filter((q) => q.count > 0)
          .sort((a, b) => b.count - a.count)
          .slice(0, 2);
        return make(
          "STOREROOM CRATES",
          [
            `${s?.queueDepth ?? 0} JOBS IN THE QUEUE, ${s?.deferred ?? 0} DEFERRED. EACH CRATE IS ROUGHLY FOUR JOBS.`,
            summary.length
              ? `BIGGEST BATCHES: ${summary.map((q) => `${q.type.toUpperCase()} ×${q.count}`).join(", ")}.`
              : "THE SHELF IS EMPTY. THE QUEUE IS QUIET.",
          ],
          null,
          C.uiGreen,
        );
      }
      case "int-board": {
        const lanes = s?.lanes ?? [];
        return make(
          "CHALKBOARD",
          [
            lanes.length
              ? `LANES: ${lanes
                  .slice(0, 4)
                  .map((l) => `${l.name.toUpperCase()} ${l.active}`)
                  .join(" · ")}.`
              : "NO LANE DATA YET.",
            `TALLIES: QUEUE ${s?.queueDepth ?? 0}, DEFERRED ${s?.deferred ?? 0}.`,
          ],
          null,
          C.uiGreen,
        );
      }
      case "int-hay": {
        const st = s?.storage;
        return make(
          "HAY PILE · WAL",
          st
            ? [
                `THE WRITE-AHEAD LOG WEIGHS ${fmtBytes(st.walBytes)} RIGHT NOW.`,
                s!.sqliteBusyExhausted > 0
                  ? `SQLITE WAS BUSY ${s!.sqliteBusyExhausted}X, LAST ${timeAgo(s!.sqliteBusyLastAt)}.`
                  : "SQLITE HAS NOT CHOKED RECENTLY.",
              ]
            : ["NO STORAGE DATA YET."],
          null,
          C.uiYellow,
        );
      }
      case "int-mill": {
        const r = s?.rate;
        const lines = r
          ? [
              `THE STONE GRINDS ${r.usedLastMinute} API CALLS THIS MINUTE (TARGET ${r.targetPerMinute}, CAP ${r.hardPerMinute}).`,
              r.byCaller.length
                ? `BUSIEST CALLERS: ${r.byCaller
                    .slice(0, 3)
                    .map((c) => `${c.caller.toUpperCase()} ${c.count}`)
                    .join(", ")}.`
                : "NOTHING TO GRIND THIS MINUTE.",
            ]
          : ["NO RATE DATA YET."];
        return make("MILLSTONE", lines, null, C.uiYellow);
      }
      case "int-sacks": {
        const r = s?.rate;
        return make(
          "FLOUR SACKS",
          r
            ? [
                `EACH SACK ON THE PALLET IS ABOUT A SIXTH OF THE PER-MINUTE API BUDGET.`,
                `CURRENTLY ${r.usedLastMinute}/${r.targetPerMinute} CALLS USED.`,
              ]
            : ["NO RATE DATA YET."],
          null,
          C.uiYellow,
        );
      }
      case "int-roost": {
        const total = s?.sseTotal ?? 0;
        return make(
          "ROOST",
          [
            `${total} SSE STREAM${total === 1 ? "" : "S"} ROOSTING RIGHT NOW.`,
            "EVERY BIRD ON THE PERCH IS A BROWSER WATCHING LIVE UPDATES.",
          ],
          sp.chicken[0],
          C.uiPink,
        );
      }
      case "int-nest": {
        const ips = s?.sseIps ?? 0;
        return make(
          "NEST BOXES",
          [
            `${Math.min(ips, 6)} EGG${Math.min(ips, 6) === 1 ? "" : "S"} FOR ${ips} DISTINCT IP${ips === 1 ? "" : "S"}.`,
            "MULTIPLE TABS FROM THE SAME IP SHARE A NEST.",
          ],
          null,
          C.uiPink,
        );
      }
      default:
        return null;
    }
  }

  private houseAssignments(): Array<ValleyStatus["countries"][number] | null> {
    return this.sim.housesRanked;
  }
}
