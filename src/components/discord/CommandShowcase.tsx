import { useState, type ReactNode } from "react";
import { GradeImg } from "../ui/GradeImg";
import { ModBadge } from "../ui/ModBadge";
import { Avatar } from "../ui/Avatar";

// Authentic Discord palette so the previews read as real Discord messages.
const D = {
  msg: "#313338",
  embed: "#2b2d31",
  field: "#1e1f22",
  text: "#dbdee1",
  muted: "#949ba4",
  link: "#00a8fc",
  white: "#f2f3f5",
  btn: "#4e5058",
};
const BLURPLE = "#5865F2";
const PINK = "#ff66ab";
const GOLD = "#ffcc33";
const RED = "#ff4d6d";
const GREEN = "#3ba55d";

// Local header art stands in for beatmap cover banners.
const COVER_A = "/images/headers/generic.jpg";
const COVER_B = "/images/headers/rankings.jpg";

interface Command {
  id: string;
  label: string;
  invocation: string;
  group: string;
  blurb: string;
  accent: string;
  render: () => ReactNode;
}

// ---------------------------------------------------------------------------
// Discord chrome
// ---------------------------------------------------------------------------

function BotAvatar({ size = 40 }: { size?: number }) {
  return (
    <div
      className="flex shrink-0 items-center justify-center rounded-full font-black text-white"
      style={{ width: size, height: size, backgroundColor: PINK, fontSize: size * 0.5 }}
    >
      m
    </div>
  );
}

function FauxMessage({ invocation, children }: { invocation: string; children: ReactNode }) {
  return (
    <div className="rounded-lg p-3 sm:p-4" style={{ backgroundColor: D.msg }}>
      <div className="flex items-center gap-2">
        <BotAvatar size={40} />
        <span className="text-[15px] font-semibold" style={{ color: D.white }}>maniabot</span>
        <span className="rounded px-1 py-px text-[9px] font-bold uppercase text-white" style={{ backgroundColor: BLURPLE }}>App</span>
        <span className="truncate text-[12px]" style={{ color: D.muted }}>used <code style={{ color: D.link }}>{invocation}</code></span>
      </div>
      <div className="mt-1.5 pl-1 sm:pl-12">{children}</div>
    </div>
  );
}

function Embed({ accent, children }: { accent: string; children: ReactNode }) {
  return (
    <div className="max-w-[460px] overflow-hidden rounded" style={{ backgroundColor: D.embed, borderLeft: `4px solid ${accent}` }}>
      <div className="space-y-2 p-3">{children}</div>
    </div>
  );
}

function EmbedAuthor({ name, userId }: { name: string; userId?: number }) {
  return (
    <div className="flex items-center gap-2">
      {userId ? <Avatar userId={userId} size={24} /> : null}
      <span className="text-[13px] font-semibold" style={{ color: D.white }}>{name}</span>
    </div>
  );
}

function EmbedTitle({ children, accent }: { children: ReactNode; accent?: string }) {
  return <div className="text-[14px] font-bold" style={{ color: accent ?? D.white }}>{children}</div>;
}

function Lead({ children }: { children: ReactNode }) {
  return <div className="pt-0.5 text-[12px] font-semibold" style={{ color: D.white }}>{children}</div>;
}

function Fields({ items }: { items: Array<{ name: string; value: ReactNode }> }) {
  return (
    <div className="grid grid-cols-3 gap-y-2 gap-x-3">
      {items.map((f) => (
        <div key={f.name}>
          <div className="text-[10px] font-semibold uppercase tracking-wide" style={{ color: D.muted }}>{f.name}</div>
          <div className="text-[12px]" style={{ color: D.text }}>{f.value}</div>
        </div>
      ))}
    </div>
  );
}

function Footer({ text }: { text: string }) {
  return <div className="pt-1 text-[10px]" style={{ color: D.muted }}>{text}</div>;
}

function Cover({ src }: { src: string }) {
  return <img src={src} alt="" className="mt-1 h-28 w-full rounded object-cover" loading="lazy" />;
}

function Buttons({ items }: { items: string[] }) {
  return (
    <div className="flex flex-wrap gap-2 pt-1">
      {items.map((label) => (
        <span key={label} className="inline-flex items-center gap-1 rounded px-2.5 py-1 text-[11px] font-semibold" style={{ backgroundColor: D.btn, color: D.white }}>
          {label}
          <span style={{ color: D.muted }}>↗</span>
        </span>
      ))}
    </div>
  );
}

// Muted middot separator, matching the bot's inline list style.
function Dot() {
  return <span style={{ color: D.muted }}>•</span>;
}

function TextReply({ accent, children }: { accent: string; children: ReactNode }) {
  return (
    <div className="rounded px-3 py-2 text-[13px]" style={{ backgroundColor: D.embed, borderLeft: `3px solid ${accent}`, color: D.text }}>
      {children}
    </div>
  );
}

// One play, rendered with the real osu grade icon + mod badges.
function ScoreLine({ grade, title, version, mods, acc, pp, keys, gain }: {
  grade: string; title: string; version: string; mods: string[]; acc: string; pp: string; keys?: string; gain?: string;
}) {
  return (
    <div className="flex items-center gap-2 py-0.5">
      <GradeImg grade={grade} size={22} />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5">
          <span className="truncate text-[12px] font-medium" style={{ color: D.link }}>{title}</span>
          <span className="shrink-0 text-[10px]" style={{ color: D.muted }}>[{version}]</span>
          {keys ? <span className="shrink-0 rounded px-1 text-[8px] font-bold" style={{ backgroundColor: D.field, color: GOLD }}>{keys}</span> : null}
        </div>
        <div className="mt-0.5 flex items-center gap-1">
          {mods.length ? mods.map((m) => <ModBadge key={m} mod={m} size={0.5} />) : <span className="text-[9px]" style={{ color: D.muted }}>nomod</span>}
        </div>
      </div>
      <div className="shrink-0 text-right text-[12px] tabular-nums">
        <span style={{ color: D.muted }}>{acc}</span>{" "}
        <span className="font-bold" style={{ color: D.white }}>{pp}</span>
        {gain ? <span style={{ color: GOLD }}> {gain}</span> : null}
      </div>
    </div>
  );
}

function RankRow({ rank, name, userId, pp }: { rank: number; name: string; userId: number; pp: string }) {
  return (
    <div className="flex items-center gap-2 py-0.5 text-[12px]">
      <span className="w-7 shrink-0 rounded text-center text-[11px] font-bold tabular-nums" style={{ backgroundColor: D.field, color: D.muted }}>#{rank}</span>
      <Avatar userId={userId} size={20} />
      <span className="font-semibold" style={{ color: D.white }}>{name}</span>
      <span className="ml-auto font-bold tabular-nums" style={{ color: D.text }}>{pp}</span>
    </div>
  );
}

// osu! mania mode glyph, the same logo the in-app card stamps top-left. The
// path is authored y-up (canvas flips it), so flip it for svg's y-down space.
const MANIA_GLYPH_D =
  "M500 48q-21 0-35 15t-15 35v504q0 21 15 36t35 14 36-14 14-36v-504q0-21-14-35t-36-15z m-110 192v220q0 21-14 36t-36 14-35-14-15-36v-220q0-21 15-35t35-15 36 15 14 35z m320 0v220q0 21-14 36t-36 14-35-14-15-36v-220q0-21 15-35t35-15 36 15 14 35z m-210 500q-106 0-197-53-88-52-140-140-53-91-53-197t53-197q52-88 140-140 91-53 197-53t197 53q88 52 140 140 53 91 53 197t-53 197q-52 88-140 140-91 53-197 53z m0 80q97 0 182-36t150-102q64-62 101-148t37-184-36-182-102-150q-62-64-148-101t-184-37-182 36-150 102q-64 62-101 149t-37 183 37 182 101 150q62 64 149 101t183 37v0z";

// Floating osu-style triangles: a jittered grid so positions never line up,
// varied sizes, up or down but never tilted, overlapping into soft facets.
const TRIANGLES = triBuilder();
function triBuilder() {
  const rand = (n: number) => {
    const v = Math.sin(n) * 43758.5453123;
    return v - Math.floor(v);
  };
  const poly = (pts: Array<[number, number]>, fill: string) =>
    `<path d="${pts.map(([x, y], i) => `${i === 0 ? "M" : "L"}${x.toFixed(1)} ${y.toFixed(1)}`).join(" ")} Z" fill="${fill}"/>`;
  // Coords are authored on a 1000x1400 grid then scaled to the card.
  return (w: number, h: number): string => {
    const sx = w / 1000;
    const sy = h / 1400;
    let paths = "";
    for (let row = 0; row < 6; row += 1) {
      for (let col = 0; col < 5; col += 1) {
        const i = row * 11 + col;
        if (rand(i * 19.17 + 4.2) < 0.4) continue;
        const cx = (col * 200 + 100 + (rand(i * 43.91 + 8.5) - 0.5) * 130) * sx;
        const cy = (row * 233 + 117 + (rand(i * 29.37 + 12.4) - 0.5) * 130) * sy;
        const side = (230 + rand(i * 13.81 + 2.7) * 300) * sx;
        const hgt = side * 0.866;
        const up = rand(i * 7.3 + 3.1) > 0.5;
        const pts: Array<[number, number]> = up
          ? [[cx, cy - (hgt * 2) / 3], [cx + side / 2, cy + hgt / 3], [cx - side / 2, cy + hgt / 3]]
          : [[cx, cy + (hgt * 2) / 3], [cx + side / 2, cy - hgt / 3], [cx - side / 2, cy - hgt / 3]];
        // Fewer, larger, low-contrast facets (subtle like the reference). Dark
        // ones stay extra faint since dark-on-light reads strongly; ~50/50
        // light/dark so the pale top and dark bottom each show some.
        const dark = rand(i * 3.11 + 6.9) > 0.5;
        const a = dark ? 0.035 + rand(i * 5.21 + 1.3) * 0.04 : 0.05 + rand(i * 5.21 + 1.3) * 0.06;
        paths += poly(pts, dark ? `rgba(0,0,0,${a.toFixed(3)})` : `rgba(255,255,255,${a.toFixed(3)})`);
      }
    }
    return `<svg xmlns='http://www.w3.org/2000/svg' width='${w}' height='${h}' viewBox='0 0 ${w} ${h}'>${paths}</svg>`;
  };
}
const TRI_BG = `url("data:image/svg+xml,${encodeURIComponent(TRIANGLES(300, 420))}")`;

function ManiaGlyph({ size }: { size: number }) {
  return (
    <svg width={size} height={size} viewBox="-40 -40 1080 1080" style={{ display: "block" }} aria-hidden>
      {/* The glyph baseline sits at 0.86 of its height (matches the in-app card). */}
      <g transform="matrix(1,0,0,-1,0,860)">
        <path d={MANIA_GLYPH_D} fill="#ffffff" />
      </g>
    </svg>
  );
}

// Faithful miniature of the in-app maniacard front: a tier-gradient body (the
// tier colour IS the card's identity, not decoration), the mania glyph badge,
// username plate, italic tier label, big avatar, the three skill values as
// plain stats and the star-rating row. No invented bars or gradients.
function ManiacardArt() {
  const shadow = "0 1px 3px rgba(0,0,0,0.55)";
  // The real Legendary tier fill (#fff7ad -> #fbbf24 -> #92400e on the diagonal).
  const tierBg = "linear-gradient(142deg, #fff7ad 0%, #fbbf24 42%, #92400e 100%)";
  const stats: Array<[string, string]> = [["Control", "1180"], ["Speed", "1240"], ["Precision", "1310"]];
  // starAvg 6.20 -> ceil = 7 stars, 6 full + 1 empty (see buildStarSegments).
  const stars = [true, true, true, true, true, true, false];
  return (
    <div className="relative mx-auto overflow-hidden" style={{ width: 300, height: 420, borderRadius: 18, background: tierBg }}>
      {/* osu triangle texture over the tier gradient */}
      <div className="pointer-events-none absolute inset-0" style={{ backgroundImage: TRI_BG, backgroundSize: "100% 100%", backgroundRepeat: "no-repeat" }} />
      {/* mode badge */}
      <div className="absolute flex items-center justify-center" style={{ left: 12, top: 12, width: 40, height: 40, borderRadius: 9, background: "rgba(0,0,0,0.20)", border: "1px solid rgba(255,255,255,0.35)" }}>
        <ManiaGlyph size={26} />
      </div>
      {/* username plate */}
      <div className="absolute flex items-center justify-center" style={{ left: 73, top: 22, width: 180, height: 32, borderRadius: 8, background: "rgba(0,0,0,0.34)" }}>
        <span className="truncate px-2 text-[15px] font-black text-white" style={{ textShadow: shadow }}>Cookiezi</span>
      </div>
      {/* tier label */}
      <div className="absolute" style={{ right: 18, top: 56, fontStyle: "italic" }}>
        <span className="text-[17px] font-black uppercase tracking-wide text-white" style={{ textShadow: "0 0 14px rgba(251,191,36,0.75), 0 2px 4px rgba(0,0,0,0.6)" }}>Legendary</span>
      </div>
      {/* avatar */}
      <div className="absolute overflow-hidden" style={{ left: 55, top: 84, width: 189, height: 189, borderRadius: 12, border: "3px solid rgba(255,255,255,0.18)" }}>
        <img src="/api/avatar?u=124493" alt="" className="h-full w-full object-cover" loading="lazy" />
      </div>
      {/* stats */}
      <div className="absolute flex flex-col justify-center gap-1.5 px-4" style={{ left: 61, top: 282, width: 178, height: 74, borderRadius: 12, background: "rgba(0,0,0,0.30)" }}>
        {stats.map(([label, value]) => (
          <div key={label} className="flex items-baseline justify-between">
            <span className="text-[12px] font-bold text-white/85" style={{ textShadow: shadow }}>{label}</span>
            <span className="text-[15px] font-black tabular-nums text-white" style={{ textShadow: shadow }}>{value}</span>
          </div>
        ))}
      </div>
      {/* stars */}
      <div className="absolute flex w-full flex-col items-center" style={{ left: 0, top: 368 }}>
        <div className="flex gap-0.5 text-[15px] leading-none" style={{ textShadow: shadow }}>
          {stars.map((full, i) => (
            <span key={i} style={{ color: full ? "#fcd34d" : "rgba(252,211,77,0.28)" }}>★</span>
          ))}
        </div>
        <span className="mt-1 text-[12px] font-bold text-white/80" style={{ textShadow: shadow }}>6.20★</span>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Command previews
// ---------------------------------------------------------------------------

const COMMANDS: Command[] = [
  {
    id: "player", label: "/player", invocation: "/player cookiezi", group: "Profiles", accent: PINK,
    blurb: "Full profile card with ranks, pp and recent top plays.",
    render: () => (
      <Embed accent={PINK}>
        <EmbedAuthor name="Cookiezi" userId={124493} />
        <Fields items={[
          { name: "Global", value: "#42" },
          { name: "Country (KR)", value: "#3" },
          { name: "pp", value: <b style={{ color: D.white }}>13,204pp</b> },
          { name: "Accuracy", value: "99.41%" },
          { name: "Play count", value: "92,140" },
          { name: "Level", value: "103" },
        ]} />
        <Lead>Top plays</Lead>
        <ScoreLine grade="X" title="Blue Zenith" version="4K Black Another" keys="4K" mods={["HD", "DT"]} acc="100%" pp="921pp" />
        <ScoreLine grade="S" title="FREEDOM DiVE" version="4K Another" keys="4K" mods={["DT"]} acc="99.2%" pp="848pp" />
        <ScoreLine grade="S" title="Everything Will Freeze" version="[7K] SHD" keys="7K" mods={[]} acc="98.7%" pp="792pp" />
        <Footer text="maniabot" />
        <Buttons items={["Mania Hub", "osu! profile"]} />
      </Embed>
    ),
  },
  {
    id: "maniacard", label: "/maniacard", invocation: "/maniacard cookiezi", group: "Profiles", accent: GOLD,
    blurb: "A shareable skill-tier card: control, speed and precision under a tier badge, with star rating.",
    render: () => (
      <Embed accent={GOLD}>
        <EmbedAuthor name="Cookiezi" userId={124493} />
        <ManiacardArt />
        <Footer text="maniabot" />
        <Buttons items={["View card", "osu! profile"]} />
      </Embed>
    ),
  },
  {
    id: "recent", label: "/recent", invocation: "/recent cookiezi", group: "Profiles", accent: PINK,
    blurb: "A player's latest plays, pass or fail.",
    render: () => (
      <Embed accent={PINK}>
        <EmbedAuthor name="Cookiezi" />
        <Lead>Recent plays</Lead>
        <ScoreLine grade="A" title="Yomi yori" version="4K Master" keys="4K" mods={["HD"]} acc="97.1%" pp="-" />
        <ScoreLine grade="S" title="Aleph-0" version="4K Ultra" keys="4K" mods={[]} acc="98.9%" pp="612pp" />
        <ScoreLine grade="F" title="Cyber Induction" version="4K SHD" keys="4K" mods={["DT"]} acc="91.0%" pp="-" />
        <Footer text="maniabot" />
        <Buttons items={["Mania Hub"]} />
      </Embed>
    ),
  },
  {
    id: "compare", label: "/compare", invocation: "/compare cookiezi rrtyui", group: "Profiles", accent: PINK,
    blurb: "Two players head to head, winner bolded per stat.",
    render: () => (
      <Embed accent={PINK}>
        <EmbedTitle>Cookiezi vs rrtyui</EmbedTitle>
        <div className="space-y-1 text-[12px]" style={{ color: D.text }}>
          <div>pp: <b style={{ color: D.white }}>13,204pp</b> vs 9,120pp</div>
          <div>Global rank: <b style={{ color: D.white }}>#42</b> vs #210</div>
          <div>Country rank: <b style={{ color: D.white }}>#3</b> vs #18</div>
          <div>Accuracy: 99.41% vs <b style={{ color: D.white }}>99.55%</b></div>
        </div>
        <Footer text="maniabot" />
        <Buttons items={["Cookiezi", "rrtyui"]} />
      </Embed>
    ),
  },
  {
    id: "rankings", label: "/rankings", invocation: "/rankings CR", group: "Leaderboards", accent: PINK,
    blurb: "Country (or global) leaderboard, top players by pp.",
    render: () => (
      <Embed accent={PINK}>
        <EmbedTitle>CR mania rankings</EmbedTitle>
        <div className="pt-1">
          <RankRow rank={1} name="player_one" userId={124493} pp="12,043pp" />
          <RankRow rank={2} name="kawaiisenpai" userId={2927048} pp="10,887pp" />
          <RankRow rank={3} name="mochaccino" userId={4979580} pp="9,540pp" />
          <RankRow rank={4} name="tristan" userId={7562902} pp="8,991pp" />
        </div>
        <Footer text="maniabot" />
        <Buttons items={["Full rankings"]} />
      </Embed>
    ),
  },
  {
    id: "top", label: "/top", invocation: "/top CR", group: "Leaderboards", accent: GOLD,
    blurb: "Recent notable top plays across a country.",
    render: () => (
      <Embed accent={GOLD}>
        <EmbedTitle>Recent top plays</EmbedTitle>
        <div className="space-y-1 pt-1 text-[12px]" style={{ color: D.text }}>
          <div className="flex flex-wrap items-center gap-1.5"><b style={{ color: D.white }}>player_one</b> <Dot /> <span style={{ color: D.link }}>Blue Zenith</span> <ModBadge mod="DT" size={0.45} /> <Dot /> <b style={{ color: D.white }}>848pp</b> <span style={{ color: GOLD }}>(+35)</span></div>
          <div className="flex flex-wrap items-center gap-1.5"><b style={{ color: D.white }}>mochaccino</b> <Dot /> <span style={{ color: D.link }}>Aleph-0</span> <ModBadge mod="HD" size={0.45} /> <Dot /> <b style={{ color: D.white }}>770pp</b></div>
          <div className="flex flex-wrap items-center gap-1.5"><b style={{ color: D.white }}>tristan</b> <Dot /> <span style={{ color: D.link }}>Cytus II</span> <Dot /> <b style={{ color: D.white }}>702pp</b></div>
        </div>
        <Footer text="CR • maniabot" />
        <Buttons items={["Top plays"]} />
      </Embed>
    ),
  },
  {
    id: "snipes", label: "/snipes", invocation: "/snipes CR", group: "Leaderboards", accent: RED,
    blurb: "Who just stole #1 from whom, on a country's boards.",
    render: () => (
      <Embed accent={RED}>
        <EmbedTitle>Recent snipes</EmbedTitle>
        <div className="space-y-1 pt-1 text-[12px]" style={{ color: D.text }}>
          <div className="flex flex-wrap items-center gap-1.5"><b style={{ color: D.white }}>player_one</b> <span style={{ color: D.muted }}>sniped</span> kawaiisenpai <Dot /> <span style={{ color: D.link }}>Blue Zenith [4K BA]</span> <Dot /> 99.1%</div>
          <div className="flex flex-wrap items-center gap-1.5"><b style={{ color: D.white }}>mochaccino</b> <span style={{ color: D.muted }}>sniped</span> tristan <Dot /> <span style={{ color: D.link }}>FREEDOM DiVE</span> <Dot /> 98.8%</div>
        </div>
        <Footer text="CR • maniabot" />
        <Buttons items={["Snipes"]} />
      </Embed>
    ),
  },
  {
    id: "farm", label: "/farm", invocation: "/farm cookiezi 4k", group: "Leaderboards", accent: PINK,
    blurb: "PP-gain map recommendations tuned to a player.",
    render: () => (
      <Embed accent={PINK}>
        <EmbedAuthor name="Cookiezi" />
        <Lead>Farm picks</Lead>
        <div className="space-y-1 pt-0.5 text-[12px]" style={{ color: D.text }}>
          <div className="flex flex-wrap items-center gap-1.5"><span style={{ color: D.muted }}>1.</span> <span style={{ color: D.link }}>Output</span> <ModBadge mod="DT" size={0.45} /> <Dot /> <b style={{ color: D.white }}>+42pp</b></div>
          <div className="flex flex-wrap items-center gap-1.5"><span style={{ color: D.muted }}>2.</span> <span style={{ color: D.link }}>The Sun The Moon The Star</span> <Dot /> <b style={{ color: D.white }}>+37pp</b></div>
          <div className="flex flex-wrap items-center gap-1.5"><span style={{ color: D.muted }}>3.</span> <span style={{ color: D.link }}>Singularity</span> <ModBadge mod="HD" size={0.45} /> <Dot /> <b style={{ color: D.white }}>+31pp</b></div>
        </div>
        <Footer text="4K • maniabot" />
        <Buttons items={["Farm Helper"]} />
      </Embed>
    ),
  },
  {
    id: "dan", label: "/dan", invocation: "/dan 1234567", group: "Tools", accent: PINK,
    blurb: "Estimate a chart's dan level, with its dan emblem.",
    render: () => (
      <Embed accent={PINK}>
        <div className="flex items-start justify-between gap-3">
          <div>
            <EmbedTitle>Dan estimate</EmbedTitle>
            <div className="mt-1 space-y-0.5 text-[12px]" style={{ color: D.text }}>
              <div className="text-[15px] font-bold" style={{ color: D.white }}>10th Dan</div>
              <div>Family: Jack</div>
              <div>Confidence: 82%</div>
            </div>
          </div>
          {/* Real dan emblem, shown as the embed thumbnail. */}
          <img src="/images/dans/reform/10.svg" alt="" className="h-14 w-14 shrink-0 object-contain" loading="lazy" />
        </div>
        <Footer text="maniabot" />
        <Buttons items={["Beatmap"]} />
      </Embed>
    ),
  },
  {
    id: "help", label: "/help", invocation: "/help", group: "Tools", accent: PINK,
    blurb: "Everything the bot can do, in one card.",
    render: () => (
      <Embed accent={PINK}>
        <EmbedTitle>maniabot</EmbedTitle>
        <div className="space-y-0.5 text-[12px]" style={{ color: D.text }}>
          <div className="font-semibold" style={{ color: D.white }}>Lookups</div>
          <div><code style={{ color: D.link }}>/player</code> · <code style={{ color: D.link }}>/maniacard</code> · <code style={{ color: D.link }}>/recent</code> · <code style={{ color: D.link }}>/compare</code></div>
          <div><code style={{ color: D.link }}>/rankings</code> · <code style={{ color: D.link }}>/top</code> · <code style={{ color: D.link }}>/snipes</code> · <code style={{ color: D.link }}>/farm</code> · <code style={{ color: D.link }}>/dan</code></div>
          <div className="pt-1 font-semibold" style={{ color: D.white }}>Live feeds (Manage Server)</div>
          <div><code style={{ color: D.link }}>/subscribe</code> · <code style={{ color: D.link }}>/unsubscribe</code> · <code style={{ color: D.link }}>/subscriptions</code></div>
        </div>
        <Footer text="maniabot" />
        <Buttons items={["Open Mania Hub"]} />
      </Embed>
    ),
  },
  {
    id: "feed-top", label: "Top-play feed", invocation: "auto-posted", group: "Live feeds", accent: GOLD,
    blurb: "When someone lands a new top play, it drops in your channel automatically.",
    render: () => (
      <Embed accent={GOLD}>
        <EmbedAuthor name="player_one" userId={124493} />
        <EmbedTitle>New top play</EmbedTitle>
        <div className="text-[12px]" style={{ color: D.text }}>
          <span style={{ color: D.link }}>UNDEAD CORPORATION - Everything Will Freeze [4K Black Another]</span>
        </div>
        <div className="flex items-center gap-2 text-[12px]">
          <GradeImg grade="X" size={20} />
          <ModBadge mod="HD" size={0.5} /><ModBadge mod="DT" size={0.5} />
          <span style={{ color: D.muted }}>99.21%</span>
          <b style={{ color: D.white }}>848pp</b>
          <span style={{ color: GOLD }}>(+35pp)</span>
        </div>
        <Cover src={COVER_A} />
        <Footer text="CR • maniabot" />
        <Buttons items={["Beatmap", "player_one"]} />
      </Embed>
    ),
  },
  {
    id: "feed-snipe", label: "Snipe feed", invocation: "auto-posted", group: "Live feeds", accent: RED,
    blurb: "Every time someone gets sniped off #1, the channel hears about it.",
    render: () => (
      <Embed accent={RED}>
        <EmbedAuthor name="player_one sniped kawaiisenpai from #1" userId={124493} />
        <EmbedTitle accent={D.link}>Camellia - GHOST [4K Another]</EmbedTitle>
        <div className="flex items-center gap-2 text-[12px]">
          <GradeImg grade="SH" size={20} />
          <ModBadge mod="DT" size={0.5} />
          <span style={{ color: D.muted }}>99.12%</span>
          <b style={{ color: D.white }}>700pp</b>
        </div>
        <div className="text-[12px]" style={{ color: D.text }}>Score <b style={{ color: D.white }}>1,000,000</b> vs 999,000</div>
        <Cover src={COVER_B} />
        <Footer text="CR • maniabot" />
        <Buttons items={["Beatmap", "Snipes"]} />
      </Embed>
    ),
  },
  {
    id: "subscribe", label: "/subscribe", invocation: "/subscribe feed:Top plays country:CR min_pp:600", group: "Live feeds", accent: GREEN,
    blurb: "Turn a feed on for the current channel (needs Manage Server).",
    render: () => (
      <TextReply accent={GREEN}>
        This channel will now receive <b style={{ color: D.white }}>Top plays</b> for CR (600pp and up). Make sure the bot can send messages here.
      </TextReply>
    ),
  },
];

const GROUPS = ["Profiles", "Leaderboards", "Tools", "Live feeds"];

export function CommandShowcase() {
  const [selectedId, setSelectedId] = useState(COMMANDS[0].id);
  const selected = COMMANDS.find((c) => c.id === selectedId) ?? COMMANDS[0];

  return (
    <section className="rounded-2xl border border-osu-b3/30 bg-osu-b4 p-4 sm:p-5">
      <div className="mb-1 flex flex-wrap items-baseline gap-x-2">
        <h2 className="text-[14px] font-bold text-white">See every command</h2>
        <span className="text-[11px] text-osu-l3">tap one to preview its reply</span>
      </div>

      <div className="grid gap-4 lg:grid-cols-[220px_1fr]">
        {/* Command picker: horizontal scroll on mobile, sidebar on desktop */}
        <div className="-mx-1 flex gap-1.5 overflow-x-auto px-1 pb-1 lg:mx-0 lg:flex-col lg:overflow-visible lg:px-0">
          {GROUPS.map((group) => (
            <div key={group} className="contents lg:block">
              <div className="hidden px-1 pt-2 text-[9px] font-semibold uppercase tracking-wider text-osu-f1 lg:block">{group}</div>
              {COMMANDS.filter((c) => c.group === group).map((cmd) => {
                const active = cmd.id === selectedId;
                return (
                  <button
                    key={cmd.id}
                    type="button"
                    onClick={() => setSelectedId(cmd.id)}
                    className={`flex shrink-0 items-center gap-2 whitespace-nowrap rounded-lg px-2.5 py-1.5 text-left text-[12px] font-semibold transition-colors ${
                      active ? "bg-osu-pink/15 text-white" : "text-osu-l2 hover:bg-osu-b3/50 hover:text-white"
                    }`}
                  >
                    <span className="h-2 w-2 shrink-0 rounded-full" style={{ backgroundColor: cmd.accent }} />
                    {cmd.label}
                  </button>
                );
              })}
            </div>
          ))}
        </div>

        {/* Preview */}
        <div className="min-w-0">
          <FauxMessage invocation={selected.invocation}>{selected.render()}</FauxMessage>
          <p className="mt-2 text-[12px] text-osu-l3">{selected.blurb}</p>
        </div>
      </div>
    </section>
  );
}
