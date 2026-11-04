import { packCompletionCounts } from "#/lib/pack-completion";
import { Link } from "@tanstack/react-router";
import { useLingui } from "@lingui/react/macro";
import { formatNumber, formatTimeAgo } from "#/lib/format";
import { useLocale } from "#/lib/locale-context";
import { honoraryAvatarUrl } from "#/lib/honorary-players";
import {
  packCollectorParam,
  type LivePackCollector,
  type LivePackCollectorBoard,
  type LivePackCollectorCompletion,
  type LivePackCollectorStanding,
  type LivePackCommunityCard,
  type LivePackCommunityStats,
} from "#/lib/live-backend";
import { CountryFlag } from "../../ui/CountryFlag";
import { BoardSkeleton, Section, SectionHeading } from "./chrome";
import { UsernameText } from "../../ui/UsernameText";

/* The record boards. Every collector row is a link into their shelf, which is
   the whole point of the page: a board is a list of people to go and look at,
   not a scoreboard to admire.

   Each board prints one number, the one it sorts on. A row carrying four
   numbers reads as a table nobody scans; the shelf behind the name has the
   rest. */

/* The tab rides along so the shelf's back link returns to the board you
   opened it from rather than dropping you on the default tab. These boards
   only ever render on the stats tab. */
function boardHref(collector: LivePackCollector) {
  return { collector: packCollectorParam(collector), tab: "stats" as const };
}

type CollectorRowValues = {
  value: string;
  note?: string | null;
  /* A word after the number, for a board whose number is not self-evident. */
  unit?: string;
  title?: string;
};

function CollectorRow({
  collector,
  rank,
  isViewer = false,
  value,
  note,
  unit,
  title,
}: {
  collector: LivePackCollector;
  rank: number;
  isViewer?: boolean;
  value: string;
  note?: string | null;
  /* A word after the number, for a board whose number is not self-evident. */
  unit?: string;
  title?: string;
}) {
  return (
    <Link
      to="/packs/collections"
      search={boardHref(collector)}
      preload="intent"
      title={title}
      className="flex items-center gap-2.5 rounded-lg px-2 py-2 transition-colors hover:bg-osu-b3/40"
    >
      <span translate="no" className={`min-w-4 shrink-0 text-right text-[11px] tabular-nums ${isViewer ? "text-white" : "text-osu-f1"}`}>
        {rank}
      </span>
      <img
        src={collector.avatarUrl}
        alt=""
        width={22}
        height={22}
        loading="lazy"
        className="h-[22px] w-[22px] shrink-0 rounded-full object-cover"
        draggable={false}
      />
      {collector.countryCode ? (
        <CountryFlag code={collector.countryCode} size="xs" decorative className="shrink-0" />
      ) : null}
      <UsernameText
        username={collector.username}
        userId={collector.userId}
        className={`min-w-0 flex-1 truncate text-[13px] ${isViewer ? "font-bold text-osu-pink-light" : "font-medium text-osu-l2"}`}
      />
      {note ? <span className="shrink-0 text-[11px] text-osu-f1">{note}</span> : null}
      <span translate="no" className="shrink-0 text-[15px] font-bold text-white tabular-nums">
        {value}
      </span>
      {unit ? <span className="-ml-1.5 shrink-0 text-[11px] text-osu-f1">{unit}</span> : null}
    </Link>
  );
}

function CardRow({ card, index, value, note }: { card: LivePackCommunityCard; index: number; value: string; note?: string | null }) {
  return (
    <Link
      to="/player/$username"
      params={{ username: card.username }}
      preload="intent"
      className="flex items-center gap-2.5 rounded-lg px-2 py-2 transition-colors hover:bg-osu-b3/40"
    >
      <span translate="no" className="w-4 shrink-0 text-right text-[11px] text-osu-f1 tabular-nums">
        {index + 1}
      </span>
      <img
        src={honoraryAvatarUrl(card.userId) ?? card.avatarUrl}
        alt=""
        width={22}
        height={22}
        loading="lazy"
        className="h-[22px] w-[22px] shrink-0 rounded-full object-cover"
        draggable={false}
      />
      {card.countryCode ? <CountryFlag code={card.countryCode} size="xs" decorative className="shrink-0" /> : null}
      <UsernameText username={card.username} userId={card.userId} className="min-w-0 flex-1 truncate text-[13px] font-medium text-osu-l2" />
      {note ? <span className="shrink-0 text-[11px] text-osu-f1">{note}</span> : null}
      <span translate="no" className="shrink-0 text-[15px] font-bold text-white tabular-nums">
        {value}
      </span>
    </Link>
  );
}

function Board({ title, children, centered = false }: { title: string; children: React.ReactNode; centered?: boolean }) {
  return (
    <Section className={centered ? "md:col-span-2 md:mx-auto md:w-[calc((100%-2.5rem)/2)]" : undefined}>
      <SectionHeading>{title}</SectionHeading>
      {/* No dividers and no box: the heading opens the board and the hover
          fill is what separates one row from the next. */}
      <div className="mt-1.5 -mx-2">{children}</div>
    </Section>
  );
}

/* A collector board: its top ten, then the viewer's own row under a
   divider when they are on the board but not in the ten, the way a map's
   scoreboard keeps your score below it. */
function CollectorBoard<T extends LivePackCollector>({
  title,
  rows,
  board,
  standing,
  viewerId,
  values,
  centered,
}: {
  title: string;
  rows: T[];
  board: LivePackCollectorBoard;
  standing: LivePackCollectorStanding | null;
  viewerId: number | null;
  values: (collector: T) => CollectorRowValues;
  centered?: boolean;
}) {
  const mine = standing?.boards[board];
  const below = mine && !rows.some((collector) => collector.userId === mine.collector.userId) ? mine : null;
  return (
    <Board title={title} centered={centered}>
      {rows.map((collector, index) => (
        <CollectorRow key={collector.userId} collector={collector} rank={index + 1} isViewer={collector.userId === viewerId} {...values(collector)} />
      ))}
      {below ? (
        <div className="mx-2 mt-1 border-t border-white/[0.07] pt-1">
          <div className="-mx-2">
            <CollectorRow collector={below.collector} rank={below.rank} isViewer {...values(below.collector as T)} />
          </div>
        </div>
      ) : null}
    </Board>
  );
}

/* Eight boards, ten rows each. Completion and mastery lead the grid. */
const BOARD_COUNT = 8;
const BOARD_ROWS = 10;

export function RecordBoardsSkeleton() {
  return (
    <div className="grid gap-x-10 gap-y-10 md:grid-cols-2">
      {Array.from({ length: BOARD_COUNT }, (_, index) => (
        <div key={index}>
          <BoardSkeleton rows={BOARD_ROWS} />
        </div>
      ))}
    </div>
  );
}

/* Floored, not rounded: one card short of the whole pool is 99.99%, and
   rounding it to 100% claims a completion nobody has managed. */
function completionNote(completion: LivePackCollectorCompletion): string | null {
  if (completion.poolTotal <= 0) return null;
  const { owned, total } = packCompletionCounts(completion);
  return `${Math.floor((owned / total) * 100)}%`;
}

export function RecordBoards({
  stats,
  viewerId = null,
  standing = null,
}: {
  stats: LivePackCommunityStats;
  viewerId?: number | null;
  standing?: LivePackCollectorStanding | null;
}) {
  const { t } = useLingui();
  const locale = useLocale();
  const { boards, totals } = stats;
  const goatRoster = totals.goatRosterSize;
  const own = { standing, viewerId };

  return (
    <div className="grid gap-x-10 gap-y-10 md:grid-cols-2">
      {boards.completion.length > 0 && (
        <CollectorBoard
          {...own}
          title={t`most complete collections`}
          board="completion"
          rows={boards.completion}
          values={(collector) => ({
            note: completionNote(collector.completion),
            value: formatNumber(packCompletionCounts(collector.completion).owned),
          })}
        />
      )}

      {(boards.mastery?.length ?? 0) > 0 && (
        <CollectorBoard
          {...own}
          title={t`most card levels`}
          board="mastery"
          rows={boards.mastery!}
          values={(collector) => ({
            value: formatNumber(collector.mastery),
            unit: collector.mastery === 1 ? t`level` : t`levels`,
            title: t`Card levels added up over every card ${collector.username} has held. A card gains a level each time the copies held of it double, recycled copies included.`,
          })}
        />
      )}

      <CollectorBoard
        {...own}
        title={t`most packs opened`}
        board="packsOpened"
        rows={boards.packsOpened}
        values={(collector) => ({ value: formatNumber(collector.packsOpened ?? 0) })}
      />

      <CollectorBoard
        {...own}
        title={t`most unique cards`}
        board="biggestCollections"
        rows={boards.biggestCollections}
        values={(collector) => ({ value: formatNumber(collector.cards) })}
      />

      <CollectorBoard
        {...own}
        title={t`GOAT roster, ${goatRoster} to find`}
        board="goatHolders"
        rows={boards.goatHolders}
        values={(collector) => ({
          // The whole roster is the thing worth calling out; a partial run is
          // just the number.
          note: collector.goats >= goatRoster ? t`all of them` : null,
          value: `${collector.goats}/${goatRoster}`,
        })}
      />

      <CollectorBoard
        {...own}
        title={t`first to find a card`}
        board="firstFinds"
        rows={boards.firstFinds}
        values={(collector) => ({ value: formatNumber(collector.firstFinds) })}
      />

      <CollectorBoard
        {...own}
        title={t`collecting the longest`}
        board="longestStanding"
        rows={boards.longestStanding}
        values={(collector) => ({
          value: collector.joinedAt > 0 ? formatTimeAgo(new Date(collector.joinedAt).toISOString(), locale) : t`unknown`,
        })}
      />

      {/* Centered when an odd board count leaves it alone on its row. */}
      <Board title={t`most collected cards`} centered={!boards.mastery?.length}>
        {boards.mostOwnedCards.map((card, index) => (
          <CardRow
            key={card.userId}
            card={card}
            index={index}
            value={t`${formatNumber(card.owners)} collections`}
          />
        ))}
      </Board>
    </div>
  );
}
