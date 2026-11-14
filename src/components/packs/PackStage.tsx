import { motion } from "framer-motion";
import type { SupporterBladeId, SupporterWrapperId } from "#/lib/supporter-pack-style";
import { useEffect, useRef, useState, type ReactNode, type Ref } from "react";
import { createPortal } from "react-dom";
import { Trans } from "@lingui/react/macro";
import { packDamageFromCut, type PackDamage } from "#/lib/pack-damage";
import type { PackTypeDef } from "#/lib/packs";
import { useWindowActive } from "#/lib/window-activity";
import { useWrapperArtVersion } from "./wrapperArt";
import {
  createPackBackCanvas,
  DEFAULT_PACK_ART_STYLE,
  getCachedPackFrontCanvas,
  packArtStyleFor,
  paintPackBackCanvas,
  PACK_ART_HEIGHT,
  PACK_ART_WIDTH,
  PACK_ASPECT,
  PACK_MAX_RIP_STRIP_FRACTION,
  PACK_RIP_STRIP_FRACTION,
  PACK_TEAR_FRACTION,
  type PackArtStyle,
} from "./packArt";
import { createPackScene, type PackScene } from "./packScene";
import { BladeFx, preloadSprites } from "./bladeFx";
import { bladeLook, bladeTrailLife, cutPath, emberBurn, frostFreeze } from "./packBlades";
import { createSpellField, type SpellField } from "./packSpellField";
import type { PackSpell } from "#/lib/pack-pending";
import { createBladeRenderer, type BladeRenderer } from "./bladeGl";
import { moveBladeLoop, playBladeCut, playBladeRip, playBladeTick, playCardSlice, setPackBurnSound, stopBladeLoop, stopPackBurnSound, warmBladeSounds, warmPackBurnSound } from "./packSfx";

// The cut is tracked in vertical columns; each cut column remembers the y
// (as a fraction of pack height) where the blade crossed it, so the tear
// follows the cursor's actual path instead of a fixed line.
const BIN_COUNT = 48;
// Rendering samples the cut at a finer resolution than the recorded bins so
// the tear reads as a smooth curve instead of stair steps.
const SLICES_PER_BIN = 2;
const TEAR_COMPLETE_COVERAGE = 0.7;
/* How far a held finger slides sideways, in screen px, before the blade's cut sounds. */
const CUT_SOUND_TRAVEL_PX = 10;
/* Ember's and Frost's easter egg (burnRef): how long the blade rests on the
   pack before it catches (or starts to freeze), how long the fire or ice
   takes to cover it, and how far the pointer may drift while it still
   counts as resting. */
const EMBER_IGNITE_MS = 4000;
const EMBER_SPREAD_MS = 4000;
const EMBER_STILL_PX = 12;
const SPELL_REDRAW_MS = 30;
/* The stroke kept for a rip to follow (cutOnScreenRef): a point at least
   this far from the last, and at most this many before it is thinned. */
const CUT_POINT_SPACING_PX = 4;
const CUT_POINTS_MAX = 96;
// Vertical band (fractions of pack height) where a drag counts as a slash
// instead of a tilt. Kept tight around the perforation line (at 0.16) so the
// pack can only be cut where the dotted line says.
const TEAR_BAND_TOP = 0.08;
const TEAR_BAND_BOTTOM = 0.25;
// The recorded cut path is clamped to this range so the tear stays near the
// perforation even if the cursor wanders.
const CUT_MIN_Y = 0.09;
const CUT_MAX_Y = 0.24;
/* The other way to open a pack: straight through the middle. Nothing stops a
   blade from going through the pack's body, and nothing stops it going
   through the cards stacked inside either - they come out in halves. The band
   starts well clear of the perforation, so a slash aimed at the dotted line
   can never fall into it by accident. */
const DEEP_BAND_TOP = 0.34;
const DEEP_BAND_BOTTOM = 0.86;
/* Where a stroke that started in that band is allowed to travel. Wider than
   the band on both sides, because the cut the cards get drawn with is fitted
   to this path: clamping a steep slash to the band would flatten it, and the
   cards would come out cut at an angle nobody made. */
const DEEP_CUT_MIN_Y = 0.26;
const DEEP_CUT_MAX_Y = 0.93;
// Columns of foil the blade has to cross below the seam before the cards
// inside count as cut. A tap, or a hand that slipped, is not a butchering.
const DEEP_DAMAGE_MIN_COLUMNS = 6;
// Breathing room under the cut so the flying piece carries its own torn edge
// rather than ending exactly on it.
const DEEP_STRIP_MARGIN = 0.05;
// How far the foil's freshly cut edge gapes away from the body, as a
// fraction of pack height. The foil is stiff: it eases to this and holds.
// Kept small: the opening reads through the real hole in the front shell,
// not through a huge flap.
const MAX_LIFT_FRACTION = 0.02;
// Blade trail: how many points are kept (how long each lives is the blade's,
// packBlades.ts). Short lifetimes make the streak chase the cursor instead of
// trailing a rope.
const TRAIL_MAX_POINTS = 36;
// A fixed full-viewport canvas at native mobile/retina DPR can exceed 30m
// pixels. The blade is a soft, short-lived effect, so keep its backing store
// within a small GPU budget and let CSS upscale it when necessary.
const TRAIL_PIXEL_BUDGET = 2_500_000;
const TRAIL_MAX_SCALE = 1.5;
const TRAIL_MIN_SCALE = 0.5;
/* A press that lets go this close to where it landed, this soon, is a tap
   (tapToOpen). */
const TAP_SLOP_PX = 10;
const TAP_MAX_MS = 600;
// How long an asked-for opening (openTick) waits for the 3D pack to be up.
const OPEN_WAIT_MS = 1500;

interface PackStageProps {
  /* The viewer's own wrapper (a supporter's pick): the pack is printed on it. */
  wrapper?: SupporterWrapperId | null;
  /* The viewer's own blade (a supporter's pick): its streak, sparks and sounds. */
  blade?: SupporterBladeId | null;
  /* Damage is non-null when the blade went through the pack's middle: the
     cards inside were cut, and the page has to deal a ruined hand. */
  onOpened: (damage: PackDamage | null, spell?: PackSpell | null) => void;
  /* Fires the instant the slash commits and the rip starts, ~900ms before
     onOpened. The page starts the signed-in server deal off this signal, so
     the rip choreography hides the round trip instead of preceding it. */
  onCut?: () => void;
  /* Fires on the first touch of the pack (any pointerdown on the stage that
     could start the slash). The page deals the hand off this signal, so the
     drag plus the rip animation hide the draw's network time. */
  onGrab?: () => void;
  reducedMotion: boolean;
  /* Tints the foil art and subtitle; omitted = the standard pack look. */
  packType?: PackTypeDef;
  /* Drawn in the gap between the pack and the hint (the 4K | 7K toggle), so
     showing it never moves the shelf. Taps on it never start the blade. */
  controls?: ReactNode;
  /* The game table's pack (Overjoy). The wrapper printed on it, in place of a
     pack type's. */
  artStyle?: PackArtStyle;
  /* Only the pack, filling its positioned parent and centred in it: no ground
     shadow, controls or caption, and a press anywhere in that parent starts
     the blade. */
  bare?: boolean;
  /* The pack's width in px (the page's own size when omitted). */
  width?: number;
  /* The blade only cuts at the perforation: a stroke through the body does
     nothing, so the cards inside are never damaged. */
  seamOnly?: boolean;
  /* A tap on the pack opens it along the perforation. */
  tapToOpen?: boolean;
  /* Raised to open the pack without a cut (a pack that opens by itself, the
     keyboard). It waits for the 3D pack to be on screen. */
  openTick?: number;
  /* False when the host plays its own opening sound. */
  ripSound?: boolean;
  /* The rip-to-onOpened delay, when the host wants its cards out sooner. */
  openedAfterMs?: number;
  /* The pack's own element, for a host that measures it. */
  hostRef?: Ref<HTMLDivElement>;
  /* WebGL is not available, so no pack will ever show. */
  onUnavailable?: () => void;
}

function random01(value: number) {
  const x = Math.sin(value) * 43758.5453123;
  return x - Math.floor(x);
}

function clampNumber(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

export function PackStage({
  onOpened,
  onCut,
  onGrab,
  reducedMotion,
  packType,
  controls,
  wrapper = null,
  blade = null,
  artStyle,
  bare = false,
  width,
  seamOnly = false,
  tapToOpen = false,
  openTick = 0,
  ripSound = true,
  openedAfterMs,
  hostRef,
  onUnavailable,
}: PackStageProps) {
  const stageRef = useRef<HTMLDivElement | null>(null);
  const controlsRef = useRef<HTMLDivElement | null>(null);
  // The blade effect below subscribes once ([] deps), so it reads the latest
  // callbacks through refs instead of resubscribing per render. onOpened
  // matters as much as onGrab: the page charges the selected pack type in it,
  // and the stage stays mounted while the shelf switches types under it.
  const onGrabRef = useRef(onGrab);
  const onCutRef = useRef(onCut);
  const onOpenedRef = useRef(onOpened);
  const onUnavailableRef = useRef(onUnavailable);
  useEffect(() => {
    onGrabRef.current = onGrab;
    onCutRef.current = onCut;
    onOpenedRef.current = onOpened;
    onUnavailableRef.current = onUnavailable;
  }, [onGrab, onCut, onOpened, onUnavailable]);
  // Read by the pointer handlers, which subscribe once.
  const optionsRef = useRef({ seamOnly, tapToOpen, ripSound, openedAfterMs });
  optionsRef.current = { seamOnly, tapToOpen, ripSound, openedAfterMs };
  /* Where and when the held press landed, and whether on the pack (tapToOpen). */
  const tapRef = useRef<{ x: number; y: number; t: number } | null>(null);
  // The trail canvas of a bare stage is portalled to the body (see the render).
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  const packRef = useRef<HTMLDivElement | null>(null);
  // Offscreen 2D canvas the cut renders into; the 3D scene shows it as the
  // front texture of the pack mesh.
  const liveCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const artCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const backCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const ripStripCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const sceneRef = useRef<PackScene | null>(null);
  const [artReady, setArtReady] = useState(false);
  // Flips when the async scene creation lands, so effects that push state
  // into the scene (window activity, reduced motion) re-sync to it.
  const [sceneReady, setSceneReady] = useState(false);
  // Bumped after a WebGL context loss to re-run the scene effect: the old
  // scene is disposed and acquireCore builds a fresh core, so the stage
  // recovers instead of showing a dead canvas until a reload.
  const [sceneEpoch, setSceneEpoch] = useState(0);
  const sceneLostRef = useRef(false);
  const [ripping, setRipping] = useState(false);
  // The blade is below the seam and the cards are taking it; the caption says
  // so while there is still time to stop.
  const [slicing, setSlicing] = useState(false);
  // Read by handlers that subscribe once.
  const bladeRef = useRef(blade);
  bladeRef.current = blade;
  /* The blade's sparks, flames and bursts, drawn on the trail canvas. */
  const fxRef = useRef<BladeFx | null>(null);
  fxRef.current ??= new BladeFx();
  // Travel since the stroke last threw something off (packBlades trailEvery).
  const trailTravelRef = useRef(0);
  /* Draws the trail canvas: WebGL with bloom, or canvas 2D without it (bladeGl.ts). */
  const bladeRendererRef = useRef<{ canvas: HTMLCanvasElement; renderer: BladeRenderer } | null>(null);
  useEffect(() => () => {
    bladeRendererRef.current?.renderer.dispose();
    bladeRendererRef.current = null;
  }, []);
  useEffect(() => {
    const look = bladeLook(blade);
    preloadSprites(look.sprites);
    warmBladeSounds(look.sound);
    if (blade === "ember") warmPackBurnSound();
  }, [blade]);
  useEffect(() => () => stopPackBurnSound(), []);

  const slashRef = useRef<{
    lastX: number;
    lastYFrac: number;
    lastSparkX: number;
    /* Where this stroke entered the pack decides what it cuts for its whole
       length: the seam, or the cards. */
    deep: boolean;
    /* Where the finger came down, on screen, until the blade's cut has
       sounded: a touch that stays put or moves up and down is silent, so
       tapping the pack or scrolling beside it doesn't play the cut. Null
       once it has. */
    quietFrom: [number, number] | null;
  } | null>(null);
  const bladeHeldRef = useRef<{ pointerId: number } | null>(null);
  const rippingRef = useRef(false);
  /* Ember's easter egg: the blade held still on the pack for EMBER_IGNITE_MS
     sets it alight where it rests, and the fire then spreads over the pack on
     its own (packBlades emberBurn) while the foil chars. The hand it deals
     comes out burnt (onOpened's `spell`; looks only). Frost does the same in
     ice (frostFreeze) and the hand comes out frozen. */
  /* The char or ice is painted into the pack's own texture (packSpellField,
     `layer`), so it tilts with the pack and goes with the torn strip.
     `done` once the front has passed the whole pack: the layer stops
     changing. */
  const burnRef = useRef<{
    still: { x: number; y: number } | null;
    stillSince: number;
    startedAt: number | null;
    spell: PackSpell | null;
    origin: { u: number; v: number } | null;
    field: SpellField | null;
    layer: HTMLCanvasElement | null;
    layerVersion: number;
    done: boolean;
    drawnAt: number;
    glow: number;
    composite: { canvas: HTMLCanvasElement; base: HTMLCanvasElement; version: number } | null;
    crackleAt: number;
  }>({
    still: null,
    stillSince: 0,
    startedAt: null,
    spell: null,
    origin: null,
    field: null,
    layer: null,
    layerVersion: 0,
    done: false,
    drawnAt: 0,
    glow: 0,
    composite: null,
    crackleAt: 0,
  });
  /* The rip-to-onOpened delay. Cleared on unmount: the deal now starts at the
     cut, so a refused server deal can reset the stage while the rip is still
     playing, and a stray onOpened after that would re-fire the freshly armed
     deal trigger and force the page back to the reveal. */
  const openedTimerRef = useRef<number | null>(null);
  useEffect(() => () => {
    if (openedTimerRef.current !== null) window.clearTimeout(openedTimerRef.current);
  }, []);
  // Cut y per column as a height fraction; NaN = column not cut yet.
  const binsRef = useRef<Float32Array>(new Float32Array(BIN_COUNT).fill(Number.NaN));
  // Display-smoothed cut y per column.
  const smoothYRef = useRef<Float32Array>(new Float32Array(BIN_COUNT).fill(Number.NaN));
  const liftTargetRef = useRef<Float32Array>(new Float32Array(BIN_COUNT));
  const liftCurrentRef = useRef<Float32Array>(new Float32Array(BIN_COUNT));
  const settlingRef = useRef(false);
  const cutCountRef = useRef(0);
  // Columns the blade crossed below the seam, and how many: the cards inside
  // are cut where these are, and only if there are enough of them.
  const deepBinsRef = useRef<Uint8Array>(new Uint8Array(BIN_COUNT));
  const deepCountRef = useRef(0);
  /* The pointer handlers below subscribe once, so the "cards are being cut"
     announcement is latched on a ref rather than on the state it sets. */
  const slicingRef = useRef(false);
  const rafRef = useRef<number | null>(null);
  const trailCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const trailPointsRef = useRef<Array<{ x: number; y: number; t: number }>>([]);
  const trailHeldRef = useRef(false);
  const trailCursorRef = useRef<{ x: number; y: number } | null>(null);
  const trailRafRef = useRef<number | null>(null);
  const reducedMotionRef = useRef(reducedMotion);
  reducedMotionRef.current = reducedMotion;
  const windowActive = useWindowActive();
  const windowActiveRef = useRef(windowActive);
  const stageVisibleRef = useRef(true);
  windowActiveRef.current = windowActive;

  const recomputeCutFields = () => {
    const bins = binsRef.current;
    const maxLift = PACK_ART_HEIGHT * MAX_LIFT_FRACTION;

    // Smoothed display curve: weighted average of nearby cut columns.
    const smooth = smoothYRef.current;
    const weights = [1, 2.2, 3, 2.2, 1];
    for (let i = 0; i < BIN_COUNT; i += 1) {
      if (!Number.isFinite(bins[i])) {
        smooth[i] = Number.NaN;
        continue;
      }
      let sum = 0;
      let total = 0;
      for (let offset = -2; offset <= 2; offset += 1) {
        const j = i + offset;
        if (j < 0 || j >= BIN_COUNT || !Number.isFinite(bins[j])) continue;
        const weight = weights[offset + 2];
        sum += bins[j] * weight;
        total += weight;
      }
      smooth[i] = sum / total;
    }

    // Lift target: full gape inside the cut, tapering to zero at the uncut
    // frontier so the stiff foil bends instead of stepping.
    let mask = new Float32Array(BIN_COUNT);
    for (let i = 0; i < BIN_COUNT; i += 1) mask[i] = Number.isFinite(bins[i]) ? 1 : 0;
    for (let pass = 0; pass < 2; pass += 1) {
      const out = new Float32Array(BIN_COUNT);
      for (let i = 0; i < BIN_COUNT; i += 1) {
        let sum = 0;
        let count = 0;
        for (let j = i - 2; j <= i + 2; j += 1) {
          if (j < 0 || j >= BIN_COUNT) continue;
          sum += mask[j];
          count += 1;
        }
        out[i] = sum / count;
      }
      mask = out;
    }
    const targets = liftTargetRef.current;
    for (let i = 0; i < BIN_COUNT; i += 1) {
      targets[i] = Number.isFinite(bins[i]) ? mask[i] * maxLift : 0;
    }
  };

  /* The pack's front art, with Ember's char or Frost's ice on it (burnRef). */
  const faceArt = () => {
    const art = artCanvasRef.current;
    const burn = burnRef.current;
    if (!art || !burn.layer) return art;
    if (burn.composite?.base !== art || burn.composite.version !== burn.layerVersion) {
      const canvas = burn.composite?.canvas ?? document.createElement("canvas");
      if (canvas.width !== PACK_ART_WIDTH) canvas.width = PACK_ART_WIDTH;
      if (canvas.height !== PACK_ART_HEIGHT) canvas.height = PACK_ART_HEIGHT;
      const ctx = canvas.getContext("2d");
      if (!ctx) return art;
      ctx.globalCompositeOperation = "source-over";
      ctx.clearRect(0, 0, PACK_ART_WIDTH, PACK_ART_HEIGHT);
      ctx.drawImage(art, 0, 0, PACK_ART_WIDTH, PACK_ART_HEIGHT);
      // on the foil only, never past its edges
      ctx.globalCompositeOperation = "source-atop";
      ctx.drawImage(burn.layer, 0, 0, PACK_ART_WIDTH, PACK_ART_HEIGHT);
      // Ember's cracks, glowing as they breathe (burn.glow, set in tendBurn)
      const cracks = burn.field?.cracks;
      if (cracks && burn.glow > 0) {
        ctx.globalCompositeOperation = "lighter";
        ctx.globalAlpha = burn.glow;
        ctx.drawImage(cracks, 0, 0, PACK_ART_WIDTH, PACK_ART_HEIGHT);
        ctx.globalAlpha = 1;
      }
      ctx.globalCompositeOperation = "source-over";
      burn.composite = { canvas, base: art, version: burn.layerVersion };
    }
    return burn.composite.canvas;
  };

  const drawFrame = () => {
    const canvas = liveCanvasRef.current;
    const art = faceArt();
    if (!canvas || !art) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const w = PACK_ART_WIDTH;
    const h = PACK_ART_HEIGHT;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, w, h);

    // Ease the gape toward its target; the foil settles rigidly, no flutter.
    const targets = liftTargetRef.current;
    const lifts = liftCurrentRef.current;
    let maxDelta = 0;
    for (let i = 0; i < BIN_COUNT; i += 1) {
      const delta = targets[i] - lifts[i];
      if (reducedMotionRef.current) lifts[i] = targets[i];
      else lifts[i] += delta * 0.16;
      maxDelta = Math.max(maxDelta, Math.abs(delta));
    }
    settlingRef.current = !reducedMotionRef.current && maxDelta > 0.15;

    if (cutCountRef.current === 0) {
      ctx.drawImage(art, 0, 0, w, h);
      sceneRef.current?.markArtDirty();
      return;
    }

    const bins = binsRef.current;
    const smooth = smoothYRef.current;
    const sliceCount = BIN_COUNT * SLICES_PER_BIN;
    const sliceW = w / sliceCount;

    // Sample the smoothed cut curve and gape per slice.
    const cut = new Array<boolean>(sliceCount).fill(false);
    const bodyY = new Float32Array(sliceCount);
    const edgeY = new Float32Array(sliceCount);
    for (let s = 0; s < sliceCount; s += 1) {
      const xc = (s + 0.5) * sliceW;
      const bin = Math.min(BIN_COUNT - 1, Math.floor((xc / w) * BIN_COUNT));
      if (!Number.isFinite(bins[bin])) continue;
      const b = (xc / w) * BIN_COUNT - 0.5;
      const i0 = clampNumber(Math.floor(b), 0, BIN_COUNT - 1);
      const i1 = Math.min(BIN_COUNT - 1, i0 + 1);
      const t = clampNumber(b - i0, 0, 1);
      const y0 = Number.isFinite(smooth[i0]) ? smooth[i0] : smooth[i1];
      const y1 = Number.isFinite(smooth[i1]) ? smooth[i1] : smooth[i0];
      const lift = lifts[i0] + (lifts[i1] - lifts[i0]) * t;
      cut[s] = true;
      bodyY[s] = (y0 + (y1 - y0) * t) * h;
      edgeY[s] = bodyY[s] - lift;
    }

    // Pass 1: pack body (and untouched columns).
    for (let s = 0; s < sliceCount; s += 1) {
      const x0 = s * sliceW;
      const dw = sliceW + 0.6;
      const sx = (x0 / w) * PACK_ART_WIDTH;
      const sw = (dw / w) * PACK_ART_WIDTH;
      if (!cut[s]) {
        ctx.drawImage(art, sx, 0, sw, PACK_ART_HEIGHT, x0, 0, dw, h);
      } else {
        const sy = (bodyY[s] / h) * PACK_ART_HEIGHT;
        ctx.drawImage(art, sx, sy, sw, PACK_ART_HEIGHT - sy, x0, bodyY[s], dw, h - bodyY[s]);
      }
    }

    // The gap between the lifted foil edge and the body stays TRANSPARENT:
    // the front shell gets a real hole (the material alpha-tests it away)
    // and the pack's dark inside shows through with true parallax, instead
    // of a painted-on dark band.

    // Pass 2: foil above the cut. Top edge stays sealed at the crimp, the
    // cut edge gapes by the lift, so each column squashes slightly.
    for (let s = 0; s < sliceCount; s += 1) {
      if (!cut[s]) continue;
      const x0 = s * sliceW;
      const dw = sliceW + 0.6;
      const sx = (x0 / w) * PACK_ART_WIDTH;
      const sw = (dw / w) * PACK_ART_WIDTH;
      const sy = (bodyY[s] / h) * PACK_ART_HEIGHT;
      ctx.drawImage(art, sx, 0, sw, sy, x0, 0, dw, Math.max(2, edgeY[s]));
    }

    // Pass 3: a thin sliver of light along the freshly cut foil edge - just
    // enough to say "cut edge", no glow (a glow reads as painted-on).
    const strokeRun = (from: number, to: number) => {
      ctx.beginPath();
      ctx.moveTo(from * sliceW, edgeY[from]);
      for (let s = from; s <= to; s += 1) ctx.lineTo((s + 0.5) * sliceW, edgeY[s]);
      ctx.lineTo((to + 1) * sliceW, edgeY[to]);
      ctx.stroke();
    };
    ctx.save();
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.lineWidth = 1.4;
    ctx.strokeStyle = "rgba(255, 255, 255, 0.55)";
    let runStart = -1;
    for (let s = 0; s < sliceCount; s += 1) {
      if (cut[s] && runStart === -1) runStart = s;
      if ((!cut[s] || s === sliceCount - 1) && runStart !== -1) {
        strokeRun(runStart, cut[s] ? s : s - 1);
        runStart = -1;
      }
    }
    ctx.restore();
    sceneRef.current?.markArtDirty();
  };

  const ensureLoop = () => {
    if (rafRef.current !== null || rippingRef.current) return;
    const step = () => {
      rafRef.current = null;
      drawFrame();
      const active = slashRef.current !== null || settlingRef.current;
      if (active && !rippingRef.current) rafRef.current = requestAnimationFrame(step);
    };
    rafRef.current = requestAnimationFrame(step);
  };

  useEffect(() => {
    return () => {
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    };
  }, []);

  // 3D pack: a bulged foil pouch mesh textured with the live cut canvas.
  // Declared before the art effect so the texture canvas exists by the time
  // the first art draw runs.
  useEffect(() => {
    const host = packRef.current;
    if (!host) return;
    const live = document.createElement("canvas");
    live.width = PACK_ART_WIDTH;
    live.height = PACK_ART_HEIGHT;
    liveCanvasRef.current = live;
    const back = createPackBackCanvas();
    backCanvasRef.current = back;
    const strip = document.createElement("canvas");
    strip.width = PACK_ART_WIDTH;
    strip.height = Math.ceil(PACK_ART_HEIGHT * PACK_RIP_STRIP_FRACTION);
    ripStripCanvasRef.current = strip;
    // Async: the shared renderer/environment/shaders build staged across
    // frames on the first ever mount (and resolve instantly afterwards), so
    // the route transition never pays the whole WebGL setup in one frame.
    let cancelled = false;
    void createPackScene({
      host,
      textureCanvas: live,
      backCanvas: back,
      reducedMotion: reducedMotionRef.current,
      onContextLost: () => {
        // Mobile browsers kill WebGL contexts under memory pressure or when
        // a page hits the per-page context cap. Flag the loss and drop
        // sceneReady; the window-activity effect below decides when to
        // actually rebuild.
        sceneLostRef.current = true;
        setSceneReady(false);
      },
    }).then((scene) => {
      if (cancelled) {
        scene.dispose();
        return;
      }
      sceneRef.current = scene;
      setSceneReady(true);
    }).catch(() => {
      // WebGL unavailable; the placeholder stays, unless the host has a stand-in.
      if (!cancelled) onUnavailableRef.current?.();
    });
    const onResize = () => sceneRef.current?.resize();
    window.addEventListener("resize", onResize);
    return () => {
      cancelled = true;
      window.removeEventListener("resize", onResize);
      sceneRef.current?.dispose();
      sceneRef.current = null;
      liveCanvasRef.current = null;
      ripStripCanvasRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sceneEpoch]);

  useEffect(() => {
    if (windowActive && sceneLostRef.current) {
      // Rebuild only while the tab is active: a context created in a hidden
      // tab is the first thing the browser purges next, which would loop
      // loss -> rebuild -> loss in the background. A loss in a hidden tab
      // waits here until the user comes back.
      sceneLostRef.current = false;
      setSceneEpoch((epoch) => epoch + 1);
      return;
    }
    sceneRef.current?.setWindowActive(windowActive && stageVisibleRef.current);
  }, [windowActive, sceneReady]);

  useEffect(() => {
    const host = packRef.current;
    if (!host || typeof IntersectionObserver !== "function") return;
    const observer = new IntersectionObserver(
      (entries) => {
        const visible = entries.some((entry) => entry.isIntersecting);
        stageVisibleRef.current = visible;
        sceneRef.current?.setWindowActive(windowActiveRef.current && visible);
      },
      { rootMargin: "120px" },
    );
    observer.observe(host);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    sceneRef.current?.setReducedMotion(reducedMotion);
  }, [reducedMotion, sceneReady]);

  // a wrapper's renders arrive after the first paint: the pack is printed again then
  const wrapperArtVersion = useWrapperArtVersion();
  useEffect(() => {
    const nextStyle = { ...(artStyle ?? (packType ? packArtStyleFor(packType) : DEFAULT_PACK_ART_STYLE)), wrapper };
    const next = getCachedPackFrontCanvas(nextStyle);
    setArtReady(true);
    // A per-frame blend redraws and uploads a 600x1000 texture for the whole
    // duration. Swapping the cached source in one frame keeps selection input
    // responsive and avoids a competing animation while the pack floats.
    artCanvasRef.current = next;
    drawFrame();
    // The back foil is stock too, so it takes the same tint; repainting in
    // place keeps the scene's existing back texture valid.
    const back = backCanvasRef.current;
    if (back) {
      paintPackBackCanvas(back, nextStyle.accent, wrapper);
      sceneRef.current?.markBackArtDirty();
    }
  }, [artStyle, packType, sceneReady, wrapper, wrapperArtVersion]);

  // Blade trail: while the pointer is held down anywhere on the stage, a
  // fading streak chases the cursor (on and off the pack), so the slash
  // reads as a blade before it ever touches the foil.
  /* One frame of Ember's burn or Frost's freeze (burnRef): starts it once
     the blade has rested long enough on the pack, then spreads it. True
     while it runs. */
  const tendBurn = (now: number): boolean => {
    const burn = burnRef.current;
    const blade = bladeRef.current;
    if (reducedMotionRef.current || !fxRef.current) return false;
    if (burn.startedAt === null ? blade !== "ember" && blade !== "frost" : !burn.spell) return false;
    const pack = packRef.current;
    const rect = pack?.getBoundingClientRect();
    if (!pack || !rect || rect.width < 2) return false;
    if (burn.startedAt === null) {
      if (!trailHeldRef.current || !burn.still || now - burn.stillSince < EMBER_IGNITE_MS) return false;
      const { x, y } = burn.still;
      if (x < rect.left || x > rect.right || y < rect.top || y > rect.bottom) return false;
      burn.startedAt = now;
      burn.spell = blade === "frost" ? "frozen" : "burnt";
      // kept relative to the pack, so it stays put when the page scrolls
      burn.origin = { u: (x - rect.left) / rect.width, v: (y - rect.top) / rect.height };
      void createSpellField(burn.spell === "frozen" ? "freeze" : "burn", burn.origin, rect.width).then((field) => {
        burn.field = field;
      });
    }
    // a few frames while its noise is drawn
    if (!burn.field) return !rippingRef.current && burn.origin !== null;
    if (rippingRef.current || !burn.origin) return false;
    const progress = Math.min(1, (now - burn.startedAt) / EMBER_SPREAD_MS);
    // slow to catch, then running: the front speeds up as it goes
    const eased = progress * progress * (3 - 2 * progress);
    const origin = { x: rect.left + burn.origin.u * rect.width, y: rect.top + burn.origin.v * rect.height };
    const farthest = Math.max(
      Math.hypot(burn.origin.u * rect.width, burn.origin.v * rect.height),
      Math.hypot((1 - burn.origin.u) * rect.width, burn.origin.v * rect.height),
      Math.hypot(burn.origin.u * rect.width, (1 - burn.origin.v) * rect.height),
      Math.hypot((1 - burn.origin.u) * rect.width, (1 - burn.origin.v) * rect.height),
    );
    const radius = 10 + eased * (farthest / 0.8) * 1.15;
    const front = burn.field.frontAt(radius);
    // ~30 redraws a second: a few ms each, and the front moves slowly
    if (!burn.done && (now - burn.drawnAt >= SPELL_REDRAW_MS || progress >= 1)) {
      burn.drawnAt = now;
      burn.layer = burn.field.draw(radius);
      burn.layerVersion += 1;
      // past every corner, with the spikes' reach to spare
      burn.done = progress >= 1;
      drawFrame();
    } else if (burn.done && burn.field.cracks && now - burn.drawnAt >= SPELL_REDRAW_MS * 2) {
      // burnt through: only the cracks change, breathing slowly
      burn.drawnAt = now;
      burn.layerVersion += 1;
      drawFrame();
    }
    if (burn.field.cracks) {
      const t = (now - burn.startedAt) / 1000;
      // two slow waves out of step, so it never settles into a plain pulse
      const breath = 0.5 + 0.3 * Math.sin(t * 1.7) + 0.2 * Math.sin(t * 3.1 + 1.3);
      // the cracks come up as the front passes, then breathe
      burn.glow = Math.min(1, progress * 1.5) * (0.35 + 0.65 * breath);
    }
    const spread = burn.spell === "frozen" ? frostFreeze : emberBurn;
    spread(fxRef.current, { left: rect.left, top: rect.top, width: rect.width, height: rect.height }, origin, front > farthest ? null : front, 1);
    if (burn.spell === "burnt" && now - burn.crackleAt > 200) {
      burn.crackleAt = now;
      // the flame swells as the front runs, then smoulders
      setPackBurnSound(burn.done ? 0.12 : 0.16 + 0.3 * eased);
    }
    return true;
  };

  const ensureTrailLoop = () => {
    if (trailRafRef.current !== null) return;
    const step = () => {
      trailRafRef.current = null;
      const canvas = trailCanvasRef.current;
      if (!canvas) return;
      const vw = window.innerWidth;
      const vh = window.innerHeight;
      const areaScale = Math.sqrt(TRAIL_PIXEL_BUDGET / Math.max(1, vw * vh));
      const renderScale = clampNumber(
        Math.min(window.devicePixelRatio || 1, areaScale),
        TRAIL_MIN_SCALE,
        TRAIL_MAX_SCALE,
      );
      if (canvas.width !== Math.round(vw * renderScale) || canvas.height !== Math.round(vh * renderScale)) {
        canvas.width = Math.round(vw * renderScale);
        canvas.height = Math.round(vh * renderScale);
      }
      if (bladeRendererRef.current?.canvas !== canvas) {
        bladeRendererRef.current?.renderer.dispose();
        bladeRendererRef.current = { canvas, renderer: createBladeRenderer(canvas) };
      }

      const now = performance.now();
      const look = bladeLook(bladeRef.current);
      const life = bladeTrailLife(look);
      let points = trailPointsRef.current.filter((point) => now - point.t < life);
      if (points.length > TRAIL_MAX_POINTS) points = points.slice(-TRAIL_MAX_POINTS);
      trailPointsRef.current = points;
      const fx = fxRef.current;
      // The tip shows while holding, so the blade exists even when the hand pauses.
      bladeRendererRef.current.renderer.draw({
        look,
        points,
        now,
        tip: trailHeldRef.current ? trailCursorRef.current : null,
        fx,
        width: vw,
        height: vh,
        pixelRatio: renderScale,
      });

      const burning = tendBurn(now);
      if (trailHeldRef.current || trailPointsRef.current.length > 0 || fx?.alive || burning) {
        trailRafRef.current = requestAnimationFrame(step);
      }
    };
    trailRafRef.current = requestAnimationFrame(step);
  };

  useEffect(() => {
    if (reducedMotion) return;
    const onDown = (event: PointerEvent) => {
      if (rippingRef.current) return;
      if (event.pointerType === "mouse" && event.button !== 0) return;
      const stage = stageRef.current;
      if (!stage || !(event.target instanceof Node) || !stage.contains(event.target)) return;
      if (controlsRef.current?.contains(event.target)) return;
      trailHeldRef.current = true;
      trailCursorRef.current = { x: event.clientX, y: event.clientY };
      burnRef.current.still = { x: event.clientX, y: event.clientY };
      burnRef.current.stillSince = performance.now();
      trailPointsRef.current.push({ x: event.clientX, y: event.clientY, t: performance.now() });
      ensureTrailLoop();
    };
    const onMove = (event: PointerEvent) => {
      if (!trailHeldRef.current) return;
      const burn = burnRef.current;
      if (!burn.still || Math.hypot(event.clientX - burn.still.x, event.clientY - burn.still.y) > EMBER_STILL_PX) {
        burn.still = { x: event.clientX, y: event.clientY };
        burn.stillSince = performance.now();
      }
      const before = trailCursorRef.current;
      trailCursorRef.current = { x: event.clientX, y: event.clientY };
      trailPointsRef.current.push({ x: event.clientX, y: event.clientY, t: performance.now() });
      const look = bladeLook(bladeRef.current);
      if (look.trail && look.trailEvery && before && fxRef.current) {
        const dx = event.clientX - before.x;
        const dy = event.clientY - before.y;
        trailTravelRef.current += Math.hypot(dx, dy);
        while (trailTravelRef.current >= look.trailEvery) {
          trailTravelRef.current -= look.trailEvery;
          look.trail(fxRef.current, event.clientX, event.clientY, dx, dy, 1);
        }
      }
    };
    const onUp = () => {
      trailHeldRef.current = false;
      trailCursorRef.current = null;
      burnRef.current.still = null;
    };
    // The blade's layer is fixed to the viewport: when the page scrolls, what
    // it threw off the pack (sparks, fire, the fading streak) moves with the page.
    let scrollX = window.scrollX;
    let scrollY = window.scrollY;
    const onScroll = () => {
      const dx = scrollX - window.scrollX;
      const dy = scrollY - window.scrollY;
      scrollX = window.scrollX;
      scrollY = window.scrollY;
      if (!dx && !dy) return;
      fxRef.current?.shift(dx, dy);
      for (const point of trailPointsRef.current) {
        point.x += dx;
        point.y += dy;
      }
      ensureTrailLoop();
    };
    document.addEventListener("pointerdown", onDown);
    document.addEventListener("pointermove", onMove);
    document.addEventListener("pointerup", onUp);
    document.addEventListener("pointercancel", onUp);
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      document.removeEventListener("pointerdown", onDown);
      document.removeEventListener("pointermove", onMove);
      document.removeEventListener("pointerup", onUp);
      document.removeEventListener("pointercancel", onUp);
      window.removeEventListener("scroll", onScroll);
      if (trailRafRef.current !== null) cancelAnimationFrame(trailRafRef.current);
      trailRafRef.current = null;
      trailHeldRef.current = false;
      trailPointsRef.current = [];
    };
  }, [reducedMotion]);


  const fillUncutBins = () => {
    const bins = binsRef.current;
    let previous = Number.NaN;
    for (let i = 0; i < BIN_COUNT; i += 1) {
      if (Number.isFinite(bins[i])) previous = bins[i];
      else if (Number.isFinite(previous)) bins[i] = previous;
    }
    let next = Number.NaN;
    for (let i = BIN_COUNT - 1; i >= 0; i -= 1) {
      if (Number.isFinite(bins[i])) next = bins[i];
      else bins[i] = Number.isFinite(next) ? next : PACK_TEAR_FRACTION;
    }
  };

  /* Splits the pack along the recorded cut into transparent canvases: the
     torn-off strip and remaining body of the front print, plus the back
     foil's remaining body - a real slash goes through both layers, so the
     back shell has to lose its top too. The 3D scene maps them onto the
     pouch geometry for the rip animation. */
  const buildRipStrip = (
    art: HTMLCanvasElement,
    back: HTMLCanvasElement,
    body: HTMLCanvasElement,
    strip: HTMLCanvasElement,
  ) => {
    const width = PACK_ART_WIDTH;
    const height = PACK_ART_HEIGHT;
    const bins = binsRef.current;
    const points: Array<[number, number]> = [];
    for (let i = 0; i <= BIN_COUNT; i += 1) {
      const a = bins[Math.max(0, i - 1)];
      const b = bins[Math.min(BIN_COUNT - 1, i)];
      const x = (i / BIN_COUNT) * width;
      const y = ((a + b) / 2 + (random01(i * 17.31 + 3.7) - 0.5) * 0.011) * height;
      points.push([x, y]);
    }
    const stripPath = new Path2D();
    stripPath.moveTo(0, 0);
    stripPath.lineTo(width, 0);
    for (let i = points.length - 1; i >= 0; i -= 1) stripPath.lineTo(points[i][0], points[i][1]);
    stripPath.closePath();
    const bodyPath = new Path2D();
    bodyPath.moveTo(points[0][0], points[0][1]);
    for (let i = 1; i < points.length; i += 1) bodyPath.lineTo(points[i][0], points[i][1]);
    bodyPath.lineTo(width, height);
    bodyPath.lineTo(0, height);
    bodyPath.closePath();
    const stripContext = strip.getContext("2d");
    const bodyContext = body.getContext("2d");
    const backContext = back.getContext("2d");
    if (!stripContext || !bodyContext || !backContext) return null;

    stripContext.clearRect(0, 0, strip.width, strip.height);
    stripContext.save();
    stripContext.clip(stripPath);
    stripContext.drawImage(art, 0, 0);
    stripContext.restore();

    bodyContext.clearRect(0, 0, width, height);
    bodyContext.save();
    bodyContext.clip(bodyPath);
    bodyContext.drawImage(art, 0, 0);
    bodyContext.restore();

    // The back texture already points at this canvas. Punching its top away
    // in place avoids allocating, uploading, and later disposing another
    // full-size body texture at the exact moment the rip starts.
    backContext.save();
    backContext.globalCompositeOperation = "destination-out";
    backContext.fillStyle = "#000";
    backContext.fill(stripPath);
    backContext.restore();
    return strip;
  };

  /* What the blade did to the cards, read off the columns it crossed below
     the seam. Null when it stayed at the perforation, or barely dipped. */
  const readDamage = (): PackDamage | null => {
    if (deepCountRef.current < DEEP_DAMAGE_MIN_COLUMNS) return null;
    const bins = binsRef.current;
    const deep = deepBinsRef.current;
    const points: Array<{ x: number; y: number }> = [];
    for (let i = 0; i < BIN_COUNT; i += 1) {
      if (!deep[i] || !Number.isFinite(bins[i])) continue;
      points.push({ x: (i + 0.5) / BIN_COUNT, y: bins[i] });
    }
    return packDamageFromCut(points);
  };

  /* Everything above the deepest point of the cut leaves with the tear-off
     piece, so a slash through the middle takes most of the pack with it. */
  const ripStripFraction = () => {
    const bins = binsRef.current;
    let deepest = 0;
    for (let i = 0; i < BIN_COUNT; i += 1) {
      if (Number.isFinite(bins[i])) deepest = Math.max(deepest, bins[i]);
    }
    return clampNumber(
      deepest + DEEP_STRIP_MARGIN,
      PACK_RIP_STRIP_FRACTION,
      PACK_MAX_RIP_STRIP_FRACTION,
    );
  };

  const triggerRip = () => {
    if (rippingRef.current) return;
    rippingRef.current = true;
    const damage = readDamage();
    onCutRef.current?.();
    if (damage) playCardSlice();
    else if (optionsRef.current.ripSound) playBladeRip(bladeRef.current, bladeLook(bladeRef.current).sound);
    spawnBurst(damage ? 0.55 : 0.16);
    slashRef.current = null;
    if (rafRef.current !== null) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }
    fillUncutBins();
    const art = faceArt();
    const back = backCanvasRef.current;
    const body = liveCanvasRef.current;
    const strip = ripStripCanvasRef.current;
    if (art && back && body && strip) {
      const fraction = ripStripFraction();
      // Resizing clears the canvas, which buildRipStrip redraws anyway.
      const stripHeight = Math.ceil(PACK_ART_HEIGHT * fraction);
      if (strip.height !== stripHeight) strip.height = stripHeight;
      const builtStrip = buildRipStrip(art, back, body, strip);
      if (builtStrip) {
        sceneRef.current?.setRipStripFraction(fraction);
        sceneRef.current?.beginRip(builtStrip);
      }
    }
    setRipping(true);
    stopPackBurnSound();
    // Held in a ref and cleared on unmount: a server deal refused mid-rip
    // resets the stage, and this callback firing after that would revive the
    // dead pack (see openedTimerRef).
    openedTimerRef.current = window.setTimeout(
      () => onOpenedRef.current(damage, burnRef.current.spell),
      reducedMotionRef.current ? 220 : (optionsRef.current.openedAfterMs ?? 880),
    );
  };

  /* An opening the host asked for (openTick). It waits for the pack to be on
     screen, so the rip is seen, but not forever. */
  const openedTickRef = useRef(0);
  useEffect(() => {
    if (openTick <= openedTickRef.current) {
      openedTickRef.current = openTick;
      return;
    }
    const open = () => {
      openedTickRef.current = openTick;
      triggerRip();
    };
    if (sceneReady && artReady) {
      open();
      return;
    }
    const timer = window.setTimeout(open, OPEN_WAIT_MS);
    return () => window.clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [openTick, sceneReady, artReady]);

  const setCutSpan = (xa: number, yaFrac: number, xb: number, ybFrac: number, deep: boolean) => {
    const binA = clampNumber(Math.floor((xa / PACK_ART_WIDTH) * BIN_COUNT), 0, BIN_COUNT - 1);
    const binB = clampNumber(Math.floor((xb / PACK_ART_WIDTH) * BIN_COUNT), 0, BIN_COUNT - 1);
    const low = Math.min(binA, binB);
    const high = Math.max(binA, binB);
    const bins = binsRef.current;
    let changed = false;
    for (let i = low; i <= high; i += 1) {
      // A column already cut keeps its original y; foil only tears once.
      if (Number.isFinite(bins[i])) continue;
      const t = binA === binB ? 0 : (i - binA) / (binB - binA);
      bins[i] = yaFrac + (ybFrac - yaFrac) * t;
      cutCountRef.current += 1;
      if (deep) {
        deepBinsRef.current[i] = 1;
        deepCountRef.current += 1;
      }
      changed = true;
    }
    if (changed) {
      recomputeCutFields();
      playBladeTick(bladeRef.current, cutCountRef.current / BIN_COUNT, bladeLook(bladeRef.current).sound);
      /* The moment enough of the blade is through the body to have reached
         the cards. Said out loud once, while the pack could still be dropped
         and the rest of the cut abandoned. */
      if (deep && !slicingRef.current && deepCountRef.current >= DEEP_DAMAGE_MIN_COLUMNS) {
        slicingRef.current = true;
        setSlicing(true);
        playCardSlice(0.4);
      }
    }
  };

  const spawnSparks = (x: number, y: number) => {
    if (reducedMotion || !fxRef.current) return;
    bladeLook(bladeRef.current).cut(fxRef.current, x, y, 1);
    ensureTrailLoop();
  };

  /* Where the stroke went on screen while it cut: across which span and at
     what height, so the burst lands on the cut the player made. */
  const cutOnScreenRef = useRef<{ minX: number; maxX: number; sumY: number; count: number; points: { x: number; y: number }[] } | null>(null);
  const noteCutOnScreen = (clientX: number, clientY: number) => {
    const cut = cutOnScreenRef.current;
    if (!cut || !slashRef.current) return;
    cut.minX = Math.min(cut.minX, clientX);
    cut.maxX = Math.max(cut.maxX, clientX);
    cut.sumY += clientY;
    cut.count += 1;
    // the whole stroke, however slow: a point every few px, and when the list
    // fills up, every other one is dropped so it still spans end to end
    const last = cut.points[cut.points.length - 1];
    if (!last || Math.hypot(clientX - last.x, clientY - last.y) >= CUT_POINT_SPACING_PX) {
      cut.points.push({ x: clientX, y: clientY });
      if (cut.points.length > CUT_POINTS_MAX) cut.points = cut.points.filter((_, i) => i % 2 === 0 || i === cut.points.length - 1);
    }
  };

  /* A stroke carried on, in its own direction at each end, to the pack's left
     and right edges (y kept on the pack). */
  const acrossPack = (points: readonly { x: number; y: number }[], rect: DOMRect) => {
    const first = points[0];
    const last = points[points.length - 1];
    const rightward = last.x >= first.x;
    const extend = (from: { x: number; y: number }, toward: { x: number; y: number }, edgeX: number) => {
      const dx = from.x - toward.x;
      const slope = Math.abs(dx) > 1 ? (from.y - toward.y) / dx : 0;
      // a steep end would fly off the pack: keep the extension gentle
      const gentle = Math.max(-0.6, Math.min(0.6, slope));
      const y = from.y + gentle * (edgeX - from.x);
      return { x: edgeX, y: Math.max(rect.top, Math.min(rect.bottom, y)) };
    };
    const head = points[Math.min(points.length - 1, 4)];
    const tail = points[Math.max(0, points.length - 5)];
    const start = extend(first, head, rightward ? rect.left : rect.right);
    const end = extend(last, tail, rightward ? rect.right : rect.left);
    return [start, ...points, end];
  };

  /* The pack giving: the blade's own burst along the cut, and a shake. The
     standard blade gives with the rip alone. */
  const spawnBurst = (cutY: number) => {
    const look = bladeLook(bladeRef.current);
    if (reducedMotionRef.current || !look.rip || !fxRef.current) return;
    const pack = packRef.current;
    const rect = pack?.getBoundingClientRect();
    if (!pack || !rect) return;
    // On the stroke itself when it was seen, carried on to both edges of the
    // pack: it tears all the way across once enough is cut, while the stroke
    // may have crossed only part of it. The pack's own band otherwise.
    const cut = cutOnScreenRef.current;
    const box = { left: rect.left, width: rect.width, top: rect.top, height: rect.height };
    const over = cut?.points.filter((point) => point.x >= rect.left && point.x <= rect.right) ?? [];
    const path = over.length > 1 ? acrossPack(over, rect) : null;
    const y = path ? path.reduce((sum, point) => sum + point.y, 0) / path.length : rect.top + rect.height * cutY;
    look.rip(fxRef.current, box, y, 1, cutPath(box, y, path ?? undefined));
    bladeRendererRef.current?.renderer.impact(box.left + box.width / 2, y);
    ensureTrailLoop();
    if (look.shake) {
      const k = look.shake;
      pack.animate(
        [0, 1, 2, 3, 4, 5].map((i) => ({ translate: i === 5 ? "0 0" : `${(Math.random() - 0.5) * 2 * k * (1 - i / 5)}px ${(Math.random() - 0.5) * 2 * k * (1 - i / 5)}px` })),
        { duration: 260, easing: "ease-out" },
      );
    }
  };

  const onPointerMoveTilt = (event: React.PointerEvent<HTMLDivElement>) => {
    if (slashRef.current || rippingRef.current) return;
    const rect = packRef.current?.getBoundingClientRect();
    if (!rect) return;
    const nx = (event.clientX - rect.left) / rect.width - 0.5;
    const ny = (event.clientY - rect.top) / rect.height - 0.5;
    sceneRef.current?.setTiltTarget(ny * -12, nx * 16);
  };

  const onPointerLeaveTilt = () => {
    if (slashRef.current || rippingRef.current) return;
    sceneRef.current?.setTiltTarget(0, 0);
  };

  /* Advances the blade gesture at a viewport point: starts a slash when the
     blade enters the tear band (or the body below it), extends the cut while
     slashing. The point is mapped onto the tilted pack's plane by the 3D
     scene; x is tracked in texture pixels. */
  const cutAtPoint = (clientX: number, clientY: number) => {
    if (rippingRef.current) return;
    noteCutOnScreen(clientX, clientY);
    const point = sceneRef.current?.pointerToPack(clientX, clientY);
    if (!point) return;
    const ny = point.v;
    const slash = slashRef.current;
    if (!slash) {
      const seam = ny >= TEAR_BAND_TOP && ny <= TEAR_BAND_BOTTOM;
      const deep = !optionsRef.current.seamOnly && ny >= DEEP_BAND_TOP && ny <= DEEP_BAND_BOTTOM;
      if (!seam && !deep) return;
      // Horizontal slack so a swipe that starts off the pack still bites.
      if (point.u < -0.2 || point.u > 1.2) return;
      const x = clampNumber(point.u, 0, 1) * PACK_ART_WIDTH;
      const yFrac = deep
        ? clampNumber(ny, DEEP_CUT_MIN_Y, DEEP_CUT_MAX_Y)
        : clampNumber(ny, CUT_MIN_Y, CUT_MAX_Y);
      slashRef.current = { lastX: x, lastYFrac: yFrac, lastSparkX: x, deep, quietFrom: [clientX, clientY] };
      cutOnScreenRef.current = { minX: clientX, maxX: clientX, sumY: clientY, count: 1, points: [{ x: clientX, y: clientY }] };
      setCutSpan(x, yFrac, x, yFrac, deep);
      ensureLoop();
      return;
    }
    const x = clampNumber(point.u, 0, 1) * PACK_ART_WIDTH;
    const yFrac = slash.deep
      ? clampNumber(ny, DEEP_CUT_MIN_Y, DEEP_CUT_MAX_Y)
      : clampNumber(ny, CUT_MIN_Y, CUT_MAX_Y);
    if (slash.quietFrom) {
      // sideways, along the line: a finger scrolling the page beside the pack
      // (the stroke's horizontal slack lets it start there) moves up or down
      const dx = Math.abs(clientX - slash.quietFrom[0]);
      const dy = Math.abs(clientY - slash.quietFrom[1]);
      if (dx >= CUT_SOUND_TRAVEL_PX && dx > dy) {
        slash.quietFrom = null;
        playBladeCut(bladeLook(bladeRef.current).sound);
      }
    }
    setCutSpan(slash.lastX, slash.lastYFrac, x, yFrac, slash.deep);
    slash.lastX = x;
    slash.lastYFrac = yFrac;
    if (Math.abs(x - slash.lastSparkX) > 35) {
      slash.lastSparkX = x;
      spawnSparks(clientX, clientY);
    }
    if (cutCountRef.current / BIN_COUNT >= TEAR_COMPLETE_COVERAGE) triggerRip();
  };

  /* The blade is driven from document-level pointer events: touch pointers
     are implicitly captured by whatever element the finger lands on, so
     element-bound handlers never see a swipe that starts off the pack (the
     reason cutting was impossible on mobile). Tracking the held pointer
     ourselves also sidesteps iOS Safari's unreliable PointerEvent.buttons. */
  useEffect(() => {
    const onDown = (event: PointerEvent) => {
      if (rippingRef.current || bladeHeldRef.current) return;
      if (event.pointerType === "mouse" && event.button !== 0) return;
      const stage = stageRef.current;
      if (!stage || !(event.target instanceof Node) || !stage.contains(event.target)) return;
      if (controlsRef.current?.contains(event.target)) return;
      onGrabRef.current?.();
      bladeHeldRef.current = { pointerId: event.pointerId };
      const rect = packRef.current?.getBoundingClientRect();
      const onPack = rect && event.clientX >= rect.left && event.clientX <= rect.right && event.clientY >= rect.top && event.clientY <= rect.bottom;
      tapRef.current = onPack ? { x: event.clientX, y: event.clientY, t: event.timeStamp } : null;
      cutAtPoint(event.clientX, event.clientY);
    };
    // the blade's speed, for a sound that follows it (ink's brush)
    let lastMove: { x: number; y: number; t: number } | null = null;
    const onMove = (event: PointerEvent) => {
      const held = bladeHeldRef.current;
      if (!held || held.pointerId !== event.pointerId) return;
      const t = event.timeStamp;
      if (lastMove && t > lastMove.t) {
        const speed = (Math.hypot(event.clientX - lastMove.x, event.clientY - lastMove.y) / (t - lastMove.t)) * 1000;
        moveBladeLoop(bladeLook(bladeRef.current).sound, speed);
      }
      lastMove = { x: event.clientX, y: event.clientY, t };
      cutAtPoint(event.clientX, event.clientY);
    };
    const onUp = (event: PointerEvent) => {
      if (bladeHeldRef.current?.pointerId !== event.pointerId) return;
      lastMove = null;
      stopBladeLoop();
      bladeHeldRef.current = null;
      slashRef.current = null;
      const tap = tapRef.current;
      tapRef.current = null;
      if (
        optionsRef.current.tapToOpen &&
        tap &&
        event.type === "pointerup" &&
        event.timeStamp - tap.t <= TAP_MAX_MS &&
        Math.hypot(event.clientX - tap.x, event.clientY - tap.y) <= TAP_SLOP_PX
      ) {
        triggerRip();
        return;
      }
      ensureLoop();
    };
    document.addEventListener("pointerdown", onDown);
    document.addEventListener("pointermove", onMove);
    document.addEventListener("pointerup", onUp);
    document.addEventListener("pointercancel", onUp);
    return () => {
      document.removeEventListener("pointerdown", onDown);
      document.removeEventListener("pointermove", onMove);
      document.removeEventListener("pointerup", onUp);
      document.removeEventListener("pointercancel", onUp);
      bladeHeldRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    // pan-y: vertical swipes still scroll the page on touch, horizontal
    // swipes are the blade and never turn into a scroll.
    <div
      ref={stageRef}
      className={bare ? "absolute inset-0 flex flex-col items-center justify-center" : "flex flex-col items-center"}
      style={{ touchAction: "pan-y" }}
    >
      {/* Blade trail overlay, viewport-sized so the streak runs off the pack.
          A bare stage sits inside a table that moves (transforms make their
          own frame for fixed children), so its overlay goes to the body. */}
      {!reducedMotion &&
        (bare ? (
          mounted &&
          createPortal(
            <canvas ref={trailCanvasRef} className="pointer-events-none fixed inset-0 z-[200] h-full w-full" aria-hidden="true" />,
            document.body,
          )
        ) : (
          <canvas
            ref={trailCanvasRef}
            className="pointer-events-none fixed inset-0 z-30 h-full w-full"
            aria-hidden="true"
          />
        ))}
      {/* Host for the 3D pack; the scene's canvas overflows it on purpose so
          the tilted pack and the torn strip never clip */}
      <div
        ref={(element) => {
          packRef.current = element;
          if (typeof hostRef === "function") hostRef(element);
          else if (hostRef) hostRef.current = element;
        }}
        className="relative select-none"
        style={{
          // Narrower than the old squat pack: the 0.6 aspect makes it taller,
          // so this keeps roughly the same on-screen height.
          width: width ?? "min(270px, 66vw)",
          aspectRatio: `${PACK_ASPECT}`,
          touchAction: "none",
        }}
        onPointerMove={onPointerMoveTilt}
        onPointerLeave={onPointerLeaveTilt}
      >
        {!(artReady && sceneReady) && <div className="absolute inset-0 rounded-xl bg-osu-b4/50 animate-pulse" />}
      </div>
      {!bare && (
        <>
      {/* The gap under the floating pack: its ground shadow, and the controls
          laid over it, so the stage is the same height with or without them */}
      <div className="relative flex h-14 w-full flex-col items-center">
        <motion.div
          aria-hidden="true"
          className="pointer-events-none mt-2 h-5 w-[min(210px,52vw)] rounded-[50%] bg-black/55 blur-lg"
          animate={ripping ? { opacity: 0 } : undefined}
          transition={{ duration: 0.5 }}
        />
        {controls && (
          <motion.div
            ref={controlsRef}
            className="absolute inset-0 flex items-center justify-center"
            animate={ripping ? { opacity: 0 } : { opacity: 1 }}
            transition={{ duration: 0.3 }}
          >
            {controls}
          </motion.div>
        )}
      </div>

      {/* One line: the old second line only restated the first one in other
          words, and the gesture is the whole instruction. The blade below the
          seam gets its own warning, because by then the line is no longer an
          instruction but the news. */}
      <div className="h-5 select-none text-center" aria-live="polite">
        <div className={`text-sm font-semibold ${slicing && !ripping ? "text-osu-pink-light" : "text-white"}`}>
          {ripping
            ? slicing
              ? <Trans>Opening what is left...</Trans>
              : <Trans>Opening...</Trans>
            : slicing
              ? <Trans>You are cutting through the cards</Trans>
              : <Trans>Hold and drag across the dotted line</Trans>}
        </div>
      </div>
        </>
      )}
    </div>
  );
}

