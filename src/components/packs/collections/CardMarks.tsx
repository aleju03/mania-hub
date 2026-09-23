import { useLingui } from "@lingui/react/macro";
import { useId } from "react";
import type { CollectedCard } from "#/lib/pack-collection";
import { teamImageProxyUrl } from "#/lib/team-image";

/* What makes one holding of a card different from every other holding of it,
   worn on the outside of the tile so a wall of cards does not read as one
   flat row of the same thing. Everything here is already on the row the wall
   reads: the mint serial and who is holding it.

   Two kinds of detail, both hanging off the bottom right edge like stickers
   on a sleeve, outside the art: a scalloped medal for a low serial (gold for
   the first pull, silver and bronze for the next two, a holo finish when this
   is the only copy that ever existed), and the player's own face again as a
   round badge when the collector pulled themselves. A team card pinned by a
   member of that team wears the team's flag again the same way. */

export type CardMark =
  /* Serial 1 and no second serial was ever minted. */
  | { kind: "only" }
  /* Serial 1 of several. */
  | { kind: "first" }
  /* Serial 2 or 3. */
  | { kind: "early"; serial: number }
  /* The collector holds their own card. */
  | { kind: "self" }
  /* A team card on the shelf of someone on that team. */
  | { kind: "team"; flagUrl: string };

const EARLY_SERIALS = 3;

/* The marks a holding earns, in the order they are worn. A card the desk
   handed out has a serial like any other but was never pulled, so its place in
   the mint order says nothing (grantedAt is what tells the two apart, same as
   the spotlight) and it wears no ordinal medal.

   1/1 is the exception, because it is a claim about the card rather than about
   the race for it: one serial ever minted means this copy is the only one that
   exists, which is just as true of a one-off the desk minted (an awarded
   Eternal, a variant nobody else holds) as of a card nobody else ever pulled. */
export function cardMarksFor(card: CollectedCard, collectorUserId: number | null | undefined): CardMark[] {
  const marks: CardMark[] = [];
  const pulled = !card.grantedAt;
  if (card.serial === 1 && card.mintedTotal === 1) marks.push({ kind: "only" });
  else if (pulled && card.serial === 1) marks.push({ kind: "first" });
  else if (pulled && card.serial && card.serial <= EARLY_SERIALS) marks.push({ kind: "early", serial: card.serial });
  if (collectorUserId != null && collectorUserId === card.userId) marks.push({ kind: "self" });
  const flagUrl = card.team && card.ownTeam ? teamImageProxyUrl(card.team.flagUrl) : null;
  if (flagUrl) marks.push({ kind: "team", flagUrl });
  return marks;
}

/* A 16-scallop seal outline on a 24 unit box, built once. */
const SEAL_PATH = (() => {
  const points = 16;
  const outer = 11.5;
  const inner = 10.2;
  const parts: string[] = [];
  for (let i = 0; i < points * 2; i++) {
    const angle = (Math.PI * i) / points;
    const radius = i % 2 === 0 ? outer : inner;
    parts.push(`${(12 + radius * Math.cos(angle)).toFixed(2)} ${(12 + radius * Math.sin(angle)).toFixed(2)}`);
  }
  return `M${parts.join("L")}Z`;
})();

export type Finish = "gold" | "silver" | "bronze" | "holo";
const FINISHES: Record<Finish, { stops: Array<[string, string]>; ink: string; rim: string }> = {
  gold: { stops: [["0%", "#fff1a8"], ["45%", "#f0c14b"], ["100%", "#a86f0c"]], ink: "#4a2f05", rim: "#fff7cf" },
  silver: { stops: [["0%", "#ffffff"], ["45%", "#d5d9e2"], ["100%", "#7c8494"]], ink: "#2b3140", rim: "#f4f6fa" },
  bronze: { stops: [["0%", "#ffd6b0"], ["45%", "#d08a4e"], ["100%", "#7a4418"]], ink: "#3a1e08", rim: "#ffe4c8" },
  holo: { stops: [["0%", "#ffd1ec"], ["25%", "#fff3b0"], ["50%", "#c8ffd8"], ["75%", "#c2e6ff"], ["100%", "#e3c8ff"]], ink: "#3b2a55", rim: "#ffffff" },
};

export function Seal({ finish, label, title, size = 22 }: { finish: Finish; label: string; title: string; size?: number }) {
  const id = useId();
  const { stops, ink, rim } = FINISHES[finish];
  const fontSize = label.length > 1 ? 7 : 10;
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} role="img" aria-label={title} className="drop-shadow-[0_1px_1px_rgba(0,0,0,0.6)]">
      <title>{title}</title>
      <defs>
        <linearGradient id={id} x1="0" y1="0" x2="1" y2="1">
          {stops.map(([offset, color]) => <stop key={offset} offset={offset} stopColor={color} />)}
        </linearGradient>
      </defs>
      <path d={SEAL_PATH} fill={`url(#${id})`} />
      <circle cx="12" cy="12" r="8.4" fill="none" stroke={rim} strokeOpacity="0.7" strokeWidth="0.8" />
      {/* Centred on the numeral's own cap height rather than on the font's
          baseline box. dominant-baseline splits the em box, and the site font
          carries far more space above the caps than below them, which drops
          the digit visibly low inside a circle this small. */}
      <text x="12" y={12 + fontSize * 0.36} textAnchor="middle" fontSize={fontSize} fontWeight="800" fill={ink} fontFamily="inherit">{label}</text>
    </svg>
  );
}

export function CardMarks({ card, collectorUserId }: {
  card: CollectedCard;
  /* Whose shelf the card sits on. Null when the surface does not know, which
     only costs it the self mark. */
  collectorUserId: number | null | undefined;
}) {
  const { t } = useLingui();
  const marks = cardMarksFor(card, collectorUserId);
  if (marks.length === 0) return null;
  return (
    <span className="pointer-events-none absolute -bottom-2 right-1 flex items-center gap-0.5" data-card-marks="">
      {marks.map((mark) => {
        switch (mark.kind) {
          case "only": {
            /* The same seal either way, but a card the desk minted was never
               pulled, so it gets the claim the mark actually makes. */
            const title = card.grantedAt ? t`Only one` : t`The only one ever pulled`;
            return <span key={mark.kind} className="pointer-events-auto" title={title}><Seal finish="holo" label="1/1" title={title} /></span>;
          }
          case "first":
            return <span key={mark.kind} className="pointer-events-auto" title={t`First to pull this card`}><Seal finish="gold" label="1" title={t`First to pull this card`} /></span>;
          case "early": {
            const title = mark.serial === 2 ? t`Second to pull this card` : t`Third to pull this card`;
            return <span key={mark.kind} className="pointer-events-auto" title={title}><Seal finish={mark.serial === 2 ? "silver" : "bronze"} label={String(mark.serial)} title={title} /></span>;
          }
          case "self": {
            const title = t`${card.username} pulled their own card`;
            /* The face on the card, once more, peeking off its edge. */
            return (
              <span key={mark.kind} className="pointer-events-auto" title={title}>
                <img
                  src={card.avatarUrl}
                  alt={title}
                  width={22}
                  height={22}
                  loading="lazy"
                  draggable={false}
                  className="size-[22px] rounded-full object-cover ring-2 ring-osu-pink drop-shadow-[0_1px_1px_rgba(0,0,0,0.6)]"
                />
              </span>
            );
          }
          case "team": {
            const title = t`Own team`;
            return (
              <span key={mark.kind} className="pointer-events-auto" title={title}>
                <img
                  src={mark.flagUrl}
                  alt={title}
                  width={30}
                  height={15}
                  loading="lazy"
                  draggable={false}
                  className="h-[15px] w-[30px] rounded-[3px] object-cover ring-2 ring-osu-pink drop-shadow-[0_1px_1px_rgba(0,0,0,0.6)]"
                />
              </span>
            );
          }
        }
      })}
    </span>
  );
}
