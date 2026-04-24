import {
  computeManiaSkills,
  getManiaCardTier,
  MANIA_TIER_STYLES,
  type ManiaSkills,
  type ManiaCardTier,
} from "../../lib/maniacard";
import type { OsuScore, OsuUser } from "../../lib/types";
import { toBlob } from "html-to-image";
import { useCallback, useRef, useState, type PointerEvent, type ReactNode } from "react";

const STAR_PATH =
  "M12 2.5l2.92 5.92 6.54.95-4.73 4.61 1.12 6.52L12 17.51l-5.85 3 1.12-6.52L2.54 9.37l6.54-.95L12 2.5z";

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

function StarRow({ value, color, size = 24 }: { value: number; color: string; size?: number }) {
  const max = Math.min(10, Math.max(1, Math.ceil(value)));
  const stars: ("full" | "half" | "empty")[] = [];
  for (let i = 0; i < max; i++) {
    const remaining = value - i;
    if (remaining >= 1) stars.push("full");
    else if (remaining >= 0.5) stars.push("half");
    else stars.push("empty");
  }
  return (
    <div className="flex items-center gap-0.5 justify-center">
      {stars.map((kind, i) => (
        <svg
          key={i}
          width={size}
          height={size}
          viewBox="0 0 24 24"
          aria-hidden
          className={color}
          style={{ filter: "drop-shadow(0 2px 3px rgba(0,0,0,0.45))" }}
        >
          <defs>
            <linearGradient id={`mc-half-${i}`} x1="0" x2="1" y1="0" y2="0">
              <stop offset="50%" stopColor="currentColor" />
              <stop offset="50%" stopColor="currentColor" stopOpacity="0.22" />
            </linearGradient>
          </defs>
          <path
            d={STAR_PATH}
            fill={
              kind === "full"
                ? "currentColor"
                : kind === "half"
                  ? `url(#mc-half-${i})`
                  : "currentColor"
            }
            fillOpacity={kind === "empty" ? 0.22 : 1}
            stroke="rgba(0,0,0,0.3)"
            strokeWidth={0.75}
          />
        </svg>
      ))}
    </div>
  );
}

function TrianglePattern({ opacity, idSuffix }: { opacity: number; idSuffix: string }) {
  const patternId = `mc-triangles-${idSuffix}`;
  const layers = [
    { id: `${patternId}-slow`, opacity: 0.46, from: "0 0", to: "0 -78", dur: "15.5s" },
    { id: `${patternId}-mid`, opacity: 0.34, from: "34 18", to: "34 -60", dur: "10.75s" },
    { id: `${patternId}-fast`, opacity: 0.22, from: "-26 42", to: "-26 -36", dur: "7.8s" },
  ];

  return (
    <svg
      className="maniacard-triangle-pattern absolute inset-0 w-full h-full pointer-events-none"
      aria-hidden
      style={{ opacity }}
    >
      <defs>
        {layers.map((layer) => (
          <pattern key={layer.id} id={layer.id} width="90" height="78" patternUnits="userSpaceOnUse">
            <animateTransform
              attributeName="patternTransform"
              type="translate"
              from={layer.from}
              to={layer.to}
              dur={layer.dur}
              repeatCount="indefinite"
            />
            <polygon points="45,8 82,70 8,70" fill="rgba(255,255,255,0.08)" />
            <polygon points="10,36 32,74 -12,74" fill="rgba(255,255,255,0.05)" />
            <polygon points="80,36 102,74 58,74" fill="rgba(255,255,255,0.05)" />
            <polygon points="58,2 70,22 46,22" fill="rgba(255,255,255,0.04)" />
            <polygon points="20,0 32,18 8,18" fill="rgba(0,0,0,0.08)" />
          </pattern>
        ))}
      </defs>
      {layers.map((layer) => (
        <rect
          key={layer.id}
          width="100%"
          height="100%"
          fill={`url(#${layer.id})`}
          opacity={layer.opacity}
        />
      ))}
    </svg>
  );
}

function NamePixelTrail() {
  const blocks = [
    "left-0 top-1 h-4 w-4 bg-black/26",
    "left-0 top-7 h-2.5 w-2.5 bg-black/34",
    "left-4 top-6 h-2 w-2 bg-white/14",
    "left-7 top-0 h-3 w-3 bg-black/18",
    "left-8 top-5 h-2.5 w-2.5 bg-black/30",
    "left-8 top-10 h-2 w-2 bg-white/12",
    "left-12 top-2 h-2.5 w-2.5 bg-black/22",
    "left-[52px] top-8 h-2 w-2 bg-black/30",
    "left-[68px] top-5 h-1.5 w-1.5 bg-white/10",
    "left-20 top-1 h-1.5 w-1.5 bg-black/18",
  ];

  return (
    <div
      className="absolute left-0 top-1/2 h-14 w-24 -translate-y-1/2 pointer-events-none"
      aria-hidden
    >
      {blocks.map((block, index) => (
        <span key={index} className={`absolute rounded-[1px] ${block}`} />
      ))}
    </div>
  );
}

// Official osu!mania glyph from osu-web's "extra" icon font
// (resources/fonts/extra/extra.svg, unicode U+E802). SVG font y-axis is
// inverted vs. SVG coordinates, hence the translate/scale matrix.
const MANIA_GLYPH_D =
  "M500 48q-21 0-35 15t-15 35v504q0 21 15 36t35 14 36-14 14-36v-504q0-21-14-35t-36-15z m-110 192v220q0 21-14 36t-36 14-35-14-15-36v-220q0-21 15-35t35-15 36 15 14 35z m320 0v220q0 21-14 36t-36 14-35-14-15-36v-220q0-21 15-35t35-15 36 15 14 35z m-210 500q-106 0-197-53-88-52-140-140-53-91-53-197t53-197q52-88 140-140 91-53 197-53t197 53q88 52 140 140 53 91 53 197t-53 197q-52 88-140 140-91 53-197 53z m0 80q97 0 182-36t150-102q64-62 101-148t37-184-36-182-102-150q-62-64-148-101t-184-37-182 36-150 102q-64 62-101 149t-37 183 37 182 101 150q62 64 149 101t183 37v0z";

function ManiaModeIcon({ tier }: { tier: ManiaCardTier }) {
  const tint = MANIA_TIER_STYLES[tier];
  const badgePatternId = `mc-badge-tris-${tier}`;

  return (
    <div className="relative h-[62px] w-[62px] sm:h-[68px] sm:w-[68px]">
      <div
        className="absolute -inset-2 rounded-[26px] pointer-events-none"
        style={{
          background: `radial-gradient(circle, ${tint.badgeHalo} 0%, transparent 70%)`,
          filter: "blur(6px)",
        }}
      />
      <div
        className="relative h-full w-full overflow-hidden rounded-[18px]"
        style={{ background: tint.badgeGradient }}
      >
        <svg
          className="absolute inset-0 h-full w-full pointer-events-none opacity-80"
          aria-hidden
        >
          <defs>
            <pattern
              id={badgePatternId}
              width="30"
              height="26"
              patternUnits="userSpaceOnUse"
            >
              <polygon
                points="15,3 28,22 2,22"
                fill="rgba(255,255,255,0.14)"
              />
              <polygon
                points="3,12 11,23 -5,23"
                fill="rgba(0,0,0,0.12)"
              />
              <polygon
                points="27,12 35,23 19,23"
                fill="rgba(255,255,255,0.08)"
              />
            </pattern>
          </defs>
          <rect width="100%" height="100%" fill={`url(#${badgePatternId})`} />
        </svg>
        <div className="absolute inset-x-0 top-0 h-1/2 bg-gradient-to-b from-white/22 to-transparent pointer-events-none" />
        <div className="absolute inset-x-0 bottom-0 h-2/5 bg-gradient-to-t from-black/25 to-transparent pointer-events-none" />
        <div className="absolute inset-0 rounded-[18px] ring-1 ring-white/35 pointer-events-none" />
        <div className="absolute inset-[2px] rounded-[16px] ring-1 ring-black/20 pointer-events-none" />
        <div className="relative grid h-full w-full place-items-center">
          <svg
            viewBox="0 0 1000 1000"
            className="h-[72%] w-[72%]"
            aria-hidden
            style={{ filter: `drop-shadow(0 2px 3px ${tint.badgeGlyphShadow})` }}
          >
            <g transform="translate(0 850) scale(1 -1)" fill="#ffffff">
              <path d={MANIA_GLYPH_D} />
            </g>
          </svg>
        </div>
      </div>
    </div>
  );
}

interface ManiaCardPanelProps {
  user: Pick<OsuUser, "id" | "username" | "avatar_url" | "country_code"> & {
    statistics?: { global_rank: number | null };
  };
  scores: OsuScore[];
  loading: boolean;
}

// Tier-specific visual knobs layered on top of the base tier style.
const TIER_VISUALS: Record<ManiaCardTier, { triangleOpacity: number; extras?: ReactNode }> = {
  common: { triangleOpacity: 0.35 },
  rare: { triangleOpacity: 0.55 },
  elite: { triangleOpacity: 0.7 },
  superRare: { triangleOpacity: 0.85 },
  ultraRare: {
    triangleOpacity: 0.9,
    extras: (
      <div
        className="absolute inset-0 pointer-events-none mix-blend-overlay"
        style={{
          background:
            "linear-gradient(120deg, transparent 35%, rgba(255,255,255,0.32) 50%, transparent 65%)",
        }}
      />
    ),
  },
  master: {
    triangleOpacity: 1,
    extras: (
      <div
        className="absolute inset-0 pointer-events-none mix-blend-overlay opacity-70"
        style={{
          background:
            "conic-gradient(from 210deg at 50% 50%, rgba(255,0,128,0.35), rgba(255,200,0,0.35), rgba(0,220,255,0.3), rgba(255,0,128,0.35))",
        }}
      />
    ),
  },
};

type CopyState = "idle" | "copying" | "copied" | "error";

export function ManiaCardPanel({ user, scores, loading }: ManiaCardPanelProps) {
  const cardRef = useRef<HTMLDivElement | null>(null);
  const [copyState, setCopyState] = useState<CopyState>("idle");
  const copyResetTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const dragRef = useRef({
    active: false,
    pointerId: -1,
    startX: 0,
    startY: 0,
    rotateX: 0,
    rotateY: 0,
    baseRotateX: 0,
    baseRotateY: 0,
  });

  const copyCardImage = useCallback(async () => {
    const stage = cardRef.current;
    if (!stage || copyState === "copying") return;

    setCopyState("copying");
    if (copyResetTimer.current) clearTimeout(copyResetTimer.current);

    stage.dataset.capturing = "true";

    await new Promise<void>((resolve) =>
      requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
    );

    try {
      const blob = await toBlob(stage, {
        pixelRatio: 2,
        cacheBust: true,
        backgroundColor: "rgba(0,0,0,0)",
      });
      if (!blob) throw new Error("Failed to render card image");
      await navigator.clipboard.write([
        new ClipboardItem({ "image/png": blob }),
      ]);
      setCopyState("copied");
      copyResetTimer.current = setTimeout(() => setCopyState("idle"), 1800);
    } catch (err) {
      console.error("[maniacard] copy failed", err);
      setCopyState("error");
      copyResetTimer.current = setTimeout(() => setCopyState("idle"), 2200);
    } finally {
      delete stage.dataset.capturing;
    }
  }, [copyState]);

  const applyTilt = useCallback((rotateX: number, rotateY: number, glareOpacity: number) => {
    const card = cardRef.current;
    if (!card) return;

    const normalizedY = ((rotateY % 360) + 360) % 360;
    const lightX = clamp(50 - Math.sin((rotateY * Math.PI) / 180) * 42, 8, 92);
    const lightY = clamp(48 + Math.sin((rotateX * Math.PI) / 180) * 42, 10, 90);

    card.style.setProperty("--mc-rotate-x", `${rotateX.toFixed(2)}deg`);
    card.style.setProperty("--mc-rotate-y", `${rotateY.toFixed(2)}deg`);
    card.style.setProperty("--mc-glare-x", `${lightX.toFixed(1)}%`);
    card.style.setProperty("--mc-glare-y", `${lightY.toFixed(1)}%`);
    card.style.setProperty("--mc-glare-opacity", `${glareOpacity.toFixed(2)}`);
  }, []);

  const startDrag = useCallback((event: PointerEvent<HTMLDivElement>) => {
    if (event.pointerType === "mouse" && event.button !== 0) return;
    event.preventDefault();

    const card = cardRef.current;
    if (!card) return;

    dragRef.current.active = true;
    dragRef.current.pointerId = event.pointerId;
    dragRef.current.startX = event.clientX;
    dragRef.current.startY = event.clientY;
    dragRef.current.baseRotateX = dragRef.current.rotateX;
    dragRef.current.baseRotateY = dragRef.current.rotateY;

    card.setPointerCapture(event.pointerId);
    card.dataset.dragging = "true";
    applyTilt(dragRef.current.rotateX, dragRef.current.rotateY, 0.42);
  }, [applyTilt]);

  const updateTilt = useCallback((event: PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag.active || event.pointerId !== drag.pointerId) return;

    const deltaX = event.clientX - drag.startX;
    const deltaY = event.clientY - drag.startY;
    const nextRotateY = clamp(drag.baseRotateY + deltaX * 0.58, -185, 185);
    const nextRotateX = clamp(drag.baseRotateX - deltaY * 0.22, -24, 24);
    const intensity = clamp(
      0.28 + (Math.abs(nextRotateX) / 24) * 0.2 + (Math.abs(nextRotateY - drag.baseRotateY) / 180) * 0.42,
      0.28,
      0.9,
    );

    drag.rotateX = nextRotateX;
    drag.rotateY = nextRotateY;
    applyTilt(nextRotateX, nextRotateY, intensity);
  }, [applyTilt]);

  const stopDrag = useCallback((event: PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag.active || event.pointerId !== drag.pointerId) return;

    drag.active = false;
    drag.pointerId = -1;
    const card = cardRef.current;
    if (!card) return;
    if (card.hasPointerCapture(event.pointerId)) card.releasePointerCapture(event.pointerId);
    delete card.dataset.dragging;
    applyTilt(drag.rotateX, drag.rotateY, 0.18);
  }, [applyTilt]);

  const cancelDrag = useCallback((event: PointerEvent<HTMLDivElement>) => {
    stopDrag(event);
  }, [stopDrag]);

  if (loading) return <ManiaCardLoading />;

  const skills = computeManiaSkills(scores);
  if (!skills) {
    return (
      <div className="max-w-[640px] mx-auto py-12 text-center text-sm text-osu-f1">
        Need at least one ranked play with full beatmap data to mint a card.
      </div>
    );
  }

  const tier = getManiaCardTier(skills.accuracy);
  const style = MANIA_TIER_STYLES[tier];
  const visuals = TIER_VISUALS[tier];

  return (
    <div className="py-4 sm:py-6">
      <div className="max-w-[440px] mx-auto px-2">
        <div
          ref={cardRef}
          className="maniacard-stage relative rounded-[24px]"
          style={{ aspectRatio: "5 / 7" }}
          onPointerDown={startDrag}
          onPointerMove={updateTilt}
          onPointerUp={stopDrag}
          onPointerCancel={cancelDrag}
          onDragStart={(event) => event.preventDefault()}
          onContextMenu={(event) => event.preventDefault()}
        >
          <div
            className={`maniacard-tilt relative h-full w-full rounded-[24px] ${style.glow}`}
          >
            <div className={`maniacard-face maniacard-front bg-gradient-to-br ${style.background}`}>
              <div className={`maniacard-tier-flow maniacard-tier-${tier}`} aria-hidden />
              <TrianglePattern opacity={visuals.triangleOpacity} idSuffix={`${tier}-front`} />
              <div className="maniacard-foil" aria-hidden />
              <div className="maniacard-glare" aria-hidden />
              <div className="absolute inset-0 bg-[radial-gradient(circle_at_28%_18%,rgba(255,255,255,0.18),transparent_45%)] pointer-events-none" />
              <div className="absolute inset-x-0 top-0 h-1/2 bg-gradient-to-b from-white/8 to-transparent pointer-events-none" />
              <div className="absolute inset-x-0 bottom-0 h-2/5 bg-gradient-to-t from-black/38 to-transparent pointer-events-none" />
              {visuals.extras}

              <div className="maniacard-content relative h-full flex flex-col p-4 sm:p-5 gap-2.5">
                <div className="relative grid grid-cols-[auto_1fr] gap-2.5 pt-0.5">
                  <div className="row-span-2 relative z-10 -ml-1 -mt-1">
                    <ManiaModeIcon tier={tier} />
                  </div>
                  <div className="relative min-w-0 self-end overflow-hidden rounded-xl bg-black/34 px-4 py-2 shadow-[0_8px_18px_rgba(0,0,0,0.26),inset_0_1px_0_rgba(255,255,255,0.14)] backdrop-blur-[2px]">
                    <NamePixelTrail />
                    <div
                      className="relative truncate text-center text-white text-lg sm:text-xl leading-tight"
                      style={{
                        fontFamily: "Torus, sans-serif",
                        fontWeight: 900,
                        textShadow: "0 2px 4px rgba(0,0,0,0.5)",
                      }}
                    >
                      {user.username}
                    </div>
                  </div>
                  <div
                    className={`min-w-0 self-start truncate pr-1 text-right text-lg sm:text-xl italic font-black ${style.badgeColor}`}
                    style={{
                      fontFamily: "Torus, sans-serif",
                      textShadow: "0 2px 4px rgba(0,0,0,0.5)",
                    }}
                  >
                    {style.label}
                  </div>
                </div>

                <div className="relative mx-auto w-full max-w-[310px] rounded-xl bg-black/75 p-1.5 shadow-[0_10px_24px_rgba(0,0,0,0.28)]">
                  <img
                    src={`/api/avatar?u=${user.id}`}
                    alt=""
                    className="aspect-square w-full rounded-lg object-cover object-center"
                    loading="eager"
                    crossOrigin="anonymous"
                    referrerPolicy="no-referrer"
                    draggable={false}
                  />
                </div>

                <div
                  className="rounded-2xl border border-white/16 bg-black/30 px-3.5 py-2 text-white shadow-[inset_0_1px_0_rgba(255,255,255,0.08)] backdrop-blur-[2px]"
                  style={{ fontFamily: "Torus, sans-serif", textShadow: "0 2px 3px rgba(0,0,0,0.6)" }}
                >
                  <StatLine label="Finger Control" value={skills.fingerControl} />
                  <StatLine label="Speed" value={skills.speed} />
                  <StatLine label="Accuracy" value={skills.accuracy} />
                </div>

                <div className="pb-3">
                  <StarRow value={skills.starAvg} color={style.starColor} size={23} />
                  <div className="mt-0.5 text-center text-[9px] uppercase tracking-[0.2em] text-white/58 font-semibold">
                    {skills.starAvg.toFixed(2)}★
                  </div>
                </div>
              </div>
            </div>

            <div className={`maniacard-face maniacard-back bg-gradient-to-br ${style.background}`}>
              <div className={`maniacard-tier-flow maniacard-tier-${tier}`} aria-hidden />
              <TrianglePattern opacity={visuals.triangleOpacity * 0.72} idSuffix={`${tier}-back`} />
              <div className="maniacard-foil" aria-hidden />
              <div className="maniacard-glare" aria-hidden />
              <div className="absolute inset-0 bg-[radial-gradient(circle_at_50%_24%,rgba(255,255,255,0.18),transparent_42%)] pointer-events-none" />
              <div className="absolute inset-x-0 bottom-0 h-1/2 bg-gradient-to-t from-black/44 to-transparent pointer-events-none" />

              <div
                className="maniacard-content relative h-full p-4 sm:p-5 text-white"
                style={{ fontFamily: "Torus, sans-serif" }}
              >
                <div className="flex h-full flex-col rounded-[18px] border border-white/18 bg-black/32 p-4 shadow-[inset_0_1px_0_rgba(255,255,255,0.1)] backdrop-blur-[2px]">
                  <div className="flex items-center justify-between gap-3">
                    <div className="min-w-0">
                      <div className="text-[9px] uppercase tracking-[0.2em] text-white/55 font-bold">
                        How it's minted
                      </div>
                      <div className="text-lg sm:text-xl font-black leading-tight">
                        Skill breakdown
                      </div>
                    </div>
                    <div className="shrink-0 scale-[0.78] origin-right">
                      <ManiaModeIcon tier={tier} />
                    </div>
                  </div>

                  <div className="mt-3 flex flex-col gap-2">
                    <StatExplainer
                      accent="#ff7eb3"
                      label="Finger Control"
                      drivers="Star × BPM"
                      blurb="Rewards raw difficulty scaled by how fast notes arrive."
                    />
                    <StatExplainer
                      accent="#fbbf24"
                      label="Speed"
                      drivers="Star × BPM × notes × OD · HP · CS"
                      blurb="Dense, fast, punishing maps weigh the most."
                    />
                    <StatExplainer
                      accent="#7dd3fc"
                      label="Accuracy"
                      drivers="Star^(acc³) × OD · HP"
                      blurb="Clean hits on hard maps, nonlinear near 100%."
                    />
                    <StatExplainer
                      accent="#f0abfc"
                      label="Stars"
                      drivers="Mean of play star ratings"
                      blurb="Straight average across the sampled plays."
                    />
                  </div>

                  <div className="mt-auto pt-3 text-center">
                    <div className="text-[9px] uppercase tracking-[0.22em] text-white/55 font-bold">
                      Sample
                    </div>
                    <div className="text-[13px] font-bold text-white/88">
                      Top{" "}
                      <span className="text-white tabular-nums">
                        {skills.sampleSize}
                      </span>{" "}
                      best plays · avg{" "}
                      <span className="text-white tabular-nums">
                        {skills.starAvg.toFixed(2)}★
                      </span>
                    </div>
                  </div>
                </div>
              </div>
            </div>

            <div className={`maniacard-edge maniacard-edge-right bg-gradient-to-b ${style.background}`} aria-hidden />
            <div className={`maniacard-edge maniacard-edge-left bg-gradient-to-b ${style.background}`} aria-hidden />
            <div className={`maniacard-edge maniacard-edge-top bg-gradient-to-r ${style.background}`} aria-hidden />
            <div className={`maniacard-edge maniacard-edge-bottom bg-gradient-to-r ${style.background}`} aria-hidden />
          </div>
        </div>

        <div className="mt-4 flex justify-center">
          <button
            type="button"
            onClick={copyCardImage}
            disabled={copyState === "copying"}
            className="px-4 py-2 rounded-lg bg-osu-b4 text-[12px] font-semibold text-osu-l2 border border-osu-b3/30 hover:bg-osu-b3 transition-colors cursor-pointer disabled:cursor-default disabled:opacity-60"
          >
            {copyState === "copying"
              ? "Copying..."
              : copyState === "copied"
                ? "Copied to clipboard"
                : copyState === "error"
                  ? "Copy failed"
                  : "Copy card as image"}
          </button>
        </div>
      </div>
    </div>
  );
}

function StatExplainer({
  accent,
  label,
  drivers,
  blurb,
}: {
  accent: string;
  label: string;
  drivers: string;
  blurb: string;
}) {
  return (
    <div className="rounded-xl border border-white/12 bg-white/6 pl-3 pr-3 py-2 flex gap-3 items-start">
      <span
        className="mt-1 h-full min-h-[34px] w-[3px] shrink-0 rounded-full"
        style={{ backgroundColor: accent, boxShadow: `0 0 8px ${accent}66` }}
        aria-hidden
      />
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline justify-between gap-2">
          <div className="text-[13px] sm:text-sm font-black leading-tight">
            {label}
          </div>
          <div
            className="text-[10px] sm:text-[11px] font-bold tracking-tight tabular-nums"
            style={{ color: accent }}
          >
            {drivers}
          </div>
        </div>
        <div className="text-[11px] sm:text-[11.5px] leading-snug text-white/78">
          {blurb}
        </div>
      </div>
    </div>
  );
}

function StatLine({ label, value }: { label: string; value: number }) {
  return (
    <div className="grid grid-cols-[minmax(0,1fr)_auto] items-baseline gap-x-3 py-0.5">
      <span className="text-left text-sm sm:text-[15px] font-semibold text-white/84">
        {label}:
      </span>
      <span className="text-xl sm:text-2xl font-black tabular-nums text-white min-w-[3ch] text-right leading-none">
        {value}
      </span>
    </div>
  );
}

function ManiaCardLoading() {
  return (
    <div className="py-4 sm:py-6">
      <div className="max-w-[440px] mx-auto px-2">
        <div
          className="relative rounded-[22px] border-2 border-osu-b3/30 bg-osu-b4/40"
          style={{ aspectRatio: "5 / 7" }}
        >
          <div className="absolute inset-0 rounded-[22px] animate-pulse" />
        </div>
        <div className="mt-4 text-center text-[11px] text-osu-f1">Calculating skills...</div>
      </div>
    </div>
  );
}

export type { ManiaSkills, ManiaCardTier };
