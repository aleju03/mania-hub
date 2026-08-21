import { Link } from "@tanstack/react-router";
import { useLingui } from "@lingui/react/macro";
import { formatNumber, formatTimeAgo } from "#/lib/format";
import { honoraryAvatarUrl } from "#/lib/honorary-players";
import {
  packCollectorParam,
  type LivePackCollector,
  type LivePackCollectorCompletion,
  type LivePackCommunityCard,
  type LivePackCommunityStats,
} from "#/lib/live-backend";
import { CountryFlag } from "../../ui/CountryFlag";
import { BoardSkeleton, Section, SectionHeading } from "./chrome";

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

function CollectorRow({
  collector,
  index,
  value,
  note,
}: {
  collector: LivePackCollector;
  index: number;
  value: string;
  note?: string | null;
}) {
  return (
    <Link
      to="/packs/collections"
      search={boardHref(collector)}
      preload="intent"
      className="flex items-center gap-2.5 rounded-lg px-2 py-2 transition-colors hover:bg-osu-b3/40"
    >
      <span translate="no" className="w-4 shrink-0 text-right text-[11px] text-osu-f1 tabular-nums">
        {index + 1}
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
      <span className="min-w-0 flex-1 truncate text-[13px] font-medium text-osu-l2">{collector.username}</span>
      {note ? <span className="shrink-0 text-[11px] text-osu-f1">{note}</span> : null}
      <span translate="no" className="shrink-0 text-[15px] font-bold text-white tabular-nums">
        {value}
      </span>
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
      <span className="min-w-0 flex-1 truncate text-[13px] font-medium text-osu-l2">{card.username}</span>
      {note ? <span className="shrink-0 text-[11px] text-osu-f1">{note}</span> : null}
      <span translate="no" className="shrink-0 text-[15px] font-bold text-white tabular-nums">
        {value}
      </span>
    </Link>
  );
}

function Board({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <Section>
      <SectionHeading>{title}</SectionHeading>
      {/* No dividers and no box: the heading opens the board and the hover
          fill is what separates one row from the next. */}
      <div className="mt-1.5 -mx-2">{children}</div>
    </Section>
  );
}

/* What the boards below come back as: eight of them, ten rows each
   (PACK_COMMUNITY_BOARD_SIZE on the backend). The skeleton draws that shape
   exactly, so the page under it is already the height it will be. */
const BOARD_COUNT = 8;
const BOARD_ROWS = 10;

export function RecordBoardsSkeleton() {
  return (
    <div className="grid gap-x-10 gap-y-10 md:grid-cols-2">
      {Array.from({ length: BOARD_COUNT }, (_, index) => (
        <BoardSkeleton key={index} rows={BOARD_ROWS} />
      ))}
    </div>
  );
}

/* Floored, not rounded: one card short of the whole pool is 99.99%, and
   rounding it to 100% claims a completion nobody has managed. */
function completionNote(completion: LivePackCollectorCompletion): string | null {
  if (completion.poolTotal <= 0) return null;
  return `${Math.floor((completion.poolOwnedCount / completion.poolTotal) * 100)}%`;
}

export function RecordBoards({ stats }: { stats: LivePackCommunityStats }) {
  const { t } = useLingui();
  const { boards, totals } = stats;
  const goatRoster = totals.goatRosterSize;

  return (
    <div className="grid gap-x-10 gap-y-10 md:grid-cols-2">
      <Board title={t`biggest collections`}>
        {boards.biggestCollections.map((collector, index) => (
          <CollectorRow
            key={collector.userId}
            collector={collector}
            index={index}
            value={formatNumber(collector.cards)}
          />
        ))}
      </Board>

      <Board title={t`most packs opened`}>
        {boards.packsOpened.map((collector, index) => (
          <CollectorRow
            key={collector.userId}
            collector={collector}
            index={index}
            value={formatNumber(collector.packsOpened ?? 0)}
          />
        ))}
      </Board>

      {boards.completion.length > 0 && (
        <Board title={t`closest to every pullable player`}>
          {boards.completion.map((collector, index) => (
            <CollectorRow
              key={collector.userId}
              collector={collector}
              index={index}
              note={completionNote(collector.completion)}
              value={formatNumber(collector.completion.poolOwnedCount)}
            />
          ))}
        </Board>
      )}

      <Board title={t`GOAT roster, ${goatRoster} to find`}>
        {boards.goatHolders.map((collector, index) => (
          <CollectorRow
            key={collector.userId}
            collector={collector}
            index={index}
            // The whole roster is the thing worth calling out; a partial run is
            // just the number.
            note={collector.goats >= goatRoster ? t`all of them` : null}
            value={`${collector.goats}/${goatRoster}`}
          />
        ))}
      </Board>

      <Board title={t`first to find a card`}>
        {boards.firstFinds.map((collector, index) => (
          <CollectorRow
            key={collector.userId}
            collector={collector}
            index={index}
            value={formatNumber(collector.firstFinds)}
          />
        ))}
      </Board>

      <Board title={t`collecting the longest`}>
        {boards.longestStanding.map((collector, index) => (
          <CollectorRow
            key={collector.userId}
            collector={collector}
            index={index}
            value={collector.joinedAt > 0 ? formatTimeAgo(new Date(collector.joinedAt).toISOString()) : t`unknown`}
          />
        ))}
      </Board>

      {/* Counted in how many collectors have ever pulled the card rather than
          in how many hold it now: a serial is never given back, so recycling
          cannot make a common card look rare. */}
      <Board title={t`hardest cards to find`}>
        {boards.rarestCards.map((card, index) => (
          <CardRow
            key={card.userId}
            card={card}
            index={index}
            note={card.mintedTotal > 0 && card.mintedTotal !== card.owners ? t`${formatNumber(card.owners)} still held` : null}
            value={card.mintedTotal > 0 ? t`found ${formatNumber(card.mintedTotal)}x` : t`${formatNumber(card.owners)} held`}
          />
        ))}
      </Board>

      <Board title={t`most collected cards`}>
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
