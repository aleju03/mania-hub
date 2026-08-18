import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { AnimatePresence, motion } from "framer-motion";
import { ArrowLeft, Flag, Link2, Lock, Pencil } from "lucide-react";
import { useEffect, useState } from "react";
import { OsuTriangleBackdrop } from "../components/layout/OsuTriangleBackdrop";
import { PageHeader } from "../components/layout/PageHeader";
import { CommunityCard } from "../components/communities/CommunityCard";
import { CommunityEditModal } from "../components/communities/CommunityEditModal";
import { CommunityReportModal } from "../components/communities/CommunityReportModal";
import { CommunityStatusNote } from "../components/communities/CommunityStatusNote";
import { Avatar } from "../components/ui/Avatar";
import { CountryFlag } from "../components/ui/CountryFlag";
import { DiscordLogo, DISCORD_BLURPLE } from "../components/ui/DiscordLogo";
import { track } from "../lib/analytics";
import { communityEventProperties, rememberCommunityName } from "../lib/analytics-communities";
import { useAuth } from "../lib/auth-context";
import { getCountryName } from "../lib/country";
import { formatTimeAgo } from "../lib/format";
import {
  COMMUNITY_INTERNATIONAL,
  clearCommunitiesCache,
  communitiesListCacheKey,
  communityFeatureLabels,
  communityLanguageLabel,
  describeAccessScopes,
  discordSnowflakeDate,
  fetchCommunities,
  fetchCommunity,
  readCachedCommunities,
  writeCachedCommunities,
  type CommunitySummary,
} from "../lib/communities";
import { pageSeo } from "../lib/seo";

/*
 * One Discord server's own page.
 *
 * Everything on it is either what the server told Discord (name, icon, banner,
 * description, counts, boosts, badges) or what the person who posted it typed
 * (the pitch, the tags, the country and language). Nothing is asked of Discord
 * here: the invite refresh already stores all of it, and the creation date is
 * read out of the guild id, which is a snowflake with the time in it.
 *
 * Laid out like the skin page rather than like a bigger card: a header band the
 * width of the page, then the description beside a column of facts, then other
 * servers worth looking at. A two-member server with a one-line pitch should
 * still fill a screen, because most of what fills it is not the pitch.
 */

export const Route = createFileRoute("/communities_/$id")({
  loader: async ({ params }) => {
    try {
      return await fetchCommunity({ data: { id: params.id } });
    } catch {
      return null;
    }
  },
  head: ({ match }) => {
    const community = match.loaderData as CommunitySummary | null | undefined;
    return pageSeo({
      title: community?.name ?? "Discord server",
      description: community
        ? community.pitch.replace(/\s+/g, " ").slice(0, 160)
        : "An osu!mania Discord server.",
      path: `/communities/${match.params.id}`,
      origin: match.context.origin,
      // Nothing came back: a listing that was taken down, or one still waiting
      // for its first decision. The page says so rather than erroring, and this
      // keeps that answer out of a search index.
      noindex: community == null,
    });
  },
  component: CommunityDetailPage,
});

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="text-[22px] font-bold leading-tight text-white tabular-nums">{value}</div>
      <div className="text-[10.5px] font-semibold uppercase tracking-[0.08em] text-osu-f1/55">{label}</div>
    </div>
  );
}

function Fact({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <span className="shrink-0 text-[11px] font-semibold uppercase tracking-[0.08em] text-osu-f1/55">
        {label}
      </span>
      <span className="min-w-0 truncate text-right text-[12.5px] text-osu-l2">{children}</span>
    </div>
  );
}

// "March 2019" rather than a full date: nobody needs the day a Discord server
// was made, and the month is the part that says whether it is old or new.
function monthYear(date: Date): string {
  return date.toLocaleDateString("en-US", { month: "long", year: "numeric" });
}

/*
 * The same icon at the size the modal draws it.
 *
 * Listings carry a 128px icon, which is right for a card and half of what a
 * blown-up copy wants. Discord's CDN serves any power of two off the same path,
 * so the big one is that URL with a bigger size on it. A locked server's icon
 * comes through our own proxy instead, which has no size to ask for and stays
 * exactly as it is.
 */
function largeIconUrl(url: string): string {
  return url.startsWith("https://cdn.discordapp.com/") ? url.replace(/([?&]size=)\d+/, "$1512") : url;
}

/*
 * Two other servers, from the same country when there are any and from the
 * whole list when there are not. The page of a small server is mostly empty
 * without this, and "here is somewhere else to look" is a better use of that
 * space than a wider description column.
 *
 * It sits in the left column rather than under the whole page, because that
 * column is the one that runs out first: a one-line pitch left a third of a
 * screen of nothing beside a full column of facts. Two of them, side by side,
 * is about what it takes to reach the bottom of that column - a second row
 * would overshoot it by as much as the hole it was filling.
 *
 * It is a cell of that grid instead of a child of the left column so that the
 * one-column stack can put it after the facts, which is where somewhere else
 * to look belongs: on a phone the left column is the whole width, and reading
 * it as written meant this shelf came between the pitch and the counts.
 */
function OtherServers({ community, className }: { community: CommunitySummary; className?: string }) {
  const [rows, setRows] = useState<CommunitySummary[] | null>(null);
  const [scoped, setScoped] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const take = (result: { communities: CommunitySummary[] }) =>
      result.communities.filter((row) => row.id !== community.id).slice(0, 2);
    const country = community.countryCode ?? "";
    // The same pages the directory keeps: a shelf drawn from one it already has
    // is on screen with the rest of the page instead of a moment after it.
    const load = (query: { country?: string }) => {
      const cacheKey = communitiesListCacheKey(query);
      const cached = readCachedCommunities(cacheKey);
      if (cached) return Promise.resolve(cached);
      return fetchCommunities({ data: query }).then((result) => {
        writeCachedCommunities(cacheKey, result);
        return result;
      });
    };
    load({ country })
      .then((result) => {
        if (cancelled) return;
        const near = take(result);
        if (near.length > 0 || !country) {
          setScoped(near.length > 0 && Boolean(country));
          setRows(near);
          return;
        }
        // Nothing else from that country yet, so widen rather than print an
        // empty shelf.
        return load({}).then((all) => {
          if (cancelled) return;
          setScoped(false);
          setRows(take(all));
        });
      })
      .catch(() => {
        if (!cancelled) setRows([]);
      });
    return () => {
      cancelled = true;
    };
  }, [community.id, community.countryCode]);

  if (!rows || rows.length === 0) return null;
  const country = community.countryCode;
  const where = scoped && country
    ? country === COMMUNITY_INTERNATIONAL
      ? "More international servers"
      : `More servers from ${getCountryName(country)}`
    : "More servers";

  return (
    <div className={`pt-1 ${className ?? ""}`}>
      <div className="mb-2 flex items-baseline justify-between gap-3">
        <h2 className="text-[13px] font-bold text-white">{where}</h2>
        <Link
          to="/communities"
          className="text-[12px] font-semibold text-osu-f1 transition-colors cursor-pointer hover:text-white"
        >
          browse all
        </Link>
      </div>
      {/* Two wide, not three: this grid lives in a column the facts have taken
          300px out of, and a third of what is left is too narrow for a card
          whose header carries an icon, a name and two counts on one line. */}
      <div className="grid grid-cols-1 items-start gap-3 sm:grid-cols-2">
        {rows.map((row) => (
          <CommunityCard key={row.id} community={row} />
        ))}
      </div>
    </div>
  );
}

function CommunityDetailPage() {
  const community = Route.useLoaderData() as CommunitySummary | null;
  const navigate = useNavigate();
  const auth = useAuth();
  const [row, setRow] = useState<CommunitySummary | null>(community);
  const [editing, setEditing] = useState(false);
  const [reporting, setReporting] = useState(false);
  const [justReported, setJustReported] = useState(false);
  // The icon, blown up, the way a profile page shows an avatar.
  const [iconOpen, setIconOpen] = useState(false);

  // A card stashes the name on its way here, but a shared link arrives with
  // nothing stashed and the pageview would only have the uuid to go on. This
  // effect runs before the root provider's pageview effect (children commit
  // first), so the name is there in time either way.
  useEffect(() => {
    if (row) rememberCommunityName(row.id, row.name);
  }, [row]);

  useEffect(() => {
    if (!iconOpen) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setIconOpen(false);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [iconOpen]);

  const isOwner = row != null && row.ownerUserId === auth.viewer?.id;
  // The backend says whether this person already has one open, so the state
  // survives a reload rather than living only in this tab.
  const reported = justReported || row?.viewerReported === true;
  const language = row ? communityLanguageLabel(row.language) : null;
  const showFlag = row?.countryCode != null && row.countryCode !== COMMUNITY_INTERNATIONAL;
  // The backend reads this out of the guild id, because the guild id itself is
  // not sent to someone the server is not for. The snowflake path stays as the
  // fallback for a payload that predates the field.
  const created = row?.guildCreatedAt
    ? new Date(row.guildCreatedAt)
    : discordSnowflakeDate(row?.guildId);
  const badges = communityFeatureLabels(row?.features);
  const inviteCode = row?.inviteUrl?.split("/").filter(Boolean).pop() ?? "";
  // Null when this server is not for where you are. There is no invite in the
  // response at all in that case, so the page has nothing to hide, only
  // something to say in its place.
  const accessLabel = describeAccessScopes(row?.accessScopes);

  return (
    <div className="relative flex min-h-screen flex-col">
      <div className="relative z-10 flex flex-1 flex-col overflow-clip bg-osu-b5">
        <OsuTriangleBackdrop />
        <div className="relative z-10 flex flex-1 flex-col">
          <PageHeader
            iconSrc="/images/icons/chat.svg"
            title={
              <Link to="/communities" className="transition-colors hover:text-white">
                osu!mania Discord servers
              </Link>
            }
            right={
              <Link
                to="/communities"
                className="inline-flex items-center gap-1.5 rounded-lg bg-osu-b4 px-2.5 py-1.5 text-[11px] font-semibold text-osu-l2 transition-colors cursor-pointer hover:bg-osu-b3 hover:text-white"
              >
                <ArrowLeft className="h-3.5 w-3.5" aria-hidden="true" />
                <span>back to servers</span>
              </Link>
            }
          />

          <div className="mx-auto w-full max-w-[1100px] flex-1 px-4 py-6 sm:px-5">
            {!row ? (
              <div className="mx-auto max-w-md px-4 py-20 text-center">
                <div className="text-sm font-bold text-white">That server is not listed</div>
                <p className="mt-2 text-[12px] leading-relaxed text-osu-f1">
                  It may have been taken down, or it is still waiting for approval.
                </p>
                <Link
                  to="/communities"
                  className="mt-4 inline-block rounded-full bg-osu-pink px-5 py-1.5 text-[12.5px] font-bold text-white transition cursor-pointer hover:brightness-110"
                >
                  All Discord servers
                </Link>
              </div>
            ) : (
              <>
                <div className="overflow-hidden rounded-xl border border-osu-b3/20 bg-osu-b4">
                  {row.bannerUrl && (
                    <img src={row.bannerUrl} alt="" className="h-36 w-full object-cover sm:h-56" />
                  )}

                  <div className="flex flex-wrap items-center gap-4 p-4 sm:p-5">
                    {/* The name keeps a basis wide enough that the buttons wrap
                        under it on a phone instead of squeezing it to an
                        ellipsis. With a banner the icon rides up over its edge,
                        which is where a Discord server's own icon sits. */}
                    <div className="flex min-w-0 flex-1 basis-72 items-center gap-4">
                      {row.iconUrl ? (
                        <button
                          type="button"
                          onClick={() => setIconOpen(true)}
                          aria-label={`View ${row.name}'s icon`}
                          className={`h-20 w-20 shrink-0 overflow-hidden rounded-3xl bg-osu-b3/40 transition duration-150 cursor-pointer hover:ring-osu-pink/70 ${
                            row.bannerUrl ? "-mt-12 ring-4 ring-osu-b4" : "ring-2 ring-transparent"
                          }`}
                        >
                          <img
                            src={row.iconUrl}
                            alt=""
                            width={80}
                            height={80}
                            className="h-full w-full object-cover"
                          />
                        </button>
                      ) : (
                        <div
                          className={`flex h-20 w-20 shrink-0 items-center justify-center rounded-3xl bg-osu-b3/40 text-[28px] font-bold text-osu-l2 ${
                            row.bannerUrl ? "-mt-12 ring-4 ring-osu-b4" : ""
                          }`}
                          aria-hidden="true"
                        >
                          {row.name.slice(0, 1).toUpperCase()}
                        </div>
                      )}
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2">
                          <h1 className="min-w-0 break-words text-[22px] font-bold leading-tight text-white [overflow-wrap:anywhere]">
                            {row.name}
                          </h1>
                          {showFlag && row.countryCode && <CountryFlag code={row.countryCode} size="sm" />}
                        </div>
                        {/* Discord's own line about itself, which is not the
                            pitch and reads better up here than mixed into it. */}
                        {row.guildDescription && (
                          <p className="mt-1 text-[12.5px] leading-relaxed text-osu-f1">
                            {row.guildDescription}
                          </p>
                        )}
                      </div>
                    </div>
                    <div className="flex shrink-0 items-center gap-2">
                      {isOwner && (
                        <button
                          type="button"
                          onClick={() => setEditing(true)}
                          className="inline-flex items-center gap-1.5 rounded-full bg-osu-b5 px-3.5 py-2 text-[12.5px] font-semibold text-osu-l2 transition-colors cursor-pointer hover:bg-osu-b3"
                        >
                          <Pencil className="h-3.5 w-3.5" aria-hidden="true" />
                          Edit
                        </button>
                      )}
                      {row.inviteUrl ? (
                        <a
                          href={row.inviteUrl}
                          target="_blank"
                          rel="noreferrer"
                          onClick={() => track("community_join", communityEventProperties(row))}
                          className="inline-flex items-center gap-2 rounded-full px-5 py-2 text-[13px] font-bold text-white transition cursor-pointer hover:brightness-110"
                          style={{ backgroundColor: DISCORD_BLURPLE }}
                        >
                          <DiscordLogo className="h-4 w-4" aria-hidden="true" />
                          Join server
                        </a>
                      ) : (
                        <span className="inline-flex items-center gap-2 rounded-full bg-osu-b5 px-5 py-2 text-[13px] font-bold text-osu-f1">
                          <Lock className="h-3.5 w-3.5" aria-hidden="true" />
                          {accessLabel ?? "Closed"}
                        </span>
                      )}
                    </div>
                  </div>
                </div>

                <div className="mt-4 grid grid-cols-1 items-start gap-4 lg:grid-cols-[minmax(0,1fr)_300px]">
                  <div className="flex min-w-0 flex-col gap-4 lg:col-start-1 lg:row-start-1">
                    <CommunityStatusNote community={row} />

                    <div className="rounded-xl border border-osu-b3/20 bg-osu-b4 p-4 sm:p-5">
                      <h2 className="text-[11px] font-bold uppercase tracking-[0.08em] text-osu-f1/55">
                        What it is for
                      </h2>
                      <p className="mt-2 whitespace-pre-line break-words text-[13.5px] leading-relaxed text-osu-l2 [overflow-wrap:anywhere]">
                        {row.pitch}
                      </p>

                      {/* Every chip is the filter it stands for, so a page is a
                          way back into the list rather than a dead end. */}
                      <div className="mt-4 flex flex-wrap gap-1.5">
                        {row.countryCode && (
                          <Link
                            to="/communities"
                            search={{ country: row.countryCode }}
                            className="inline-flex items-center gap-1.5 rounded-full bg-osu-b3/45 px-2.5 py-1 text-[11.5px] font-semibold text-osu-l2 transition-colors cursor-pointer hover:bg-osu-b3/70"
                          >
                            {showFlag && <CountryFlag code={row.countryCode} size="sm" decorative />}
                            {row.countryCode === COMMUNITY_INTERNATIONAL
                              ? "international"
                              : getCountryName(row.countryCode)}
                          </Link>
                        )}
                        {language && (
                          <Link
                            to="/communities"
                            search={{ lang: row.language ?? "" }}
                            className="rounded-full bg-osu-b3/45 px-2.5 py-1 text-[11.5px] font-semibold text-osu-l2 transition-colors cursor-pointer hover:bg-osu-b3/70"
                          >
                            {language}
                          </Link>
                        )}
                        {row.tags.map((tag) => (
                          <Link
                            key={tag}
                            to="/communities"
                            search={{ tag }}
                            className="rounded-full bg-osu-b3/45 px-2.5 py-1 text-[11.5px] font-semibold text-osu-l2 transition-colors cursor-pointer hover:bg-osu-b3/70"
                          >
                            {tag}
                          </Link>
                        ))}
                      </div>
                    </div>

                  </div>

                  <div className="rounded-xl border border-osu-b3/20 bg-osu-b4 p-4 sm:p-5 lg:col-start-2 lg:row-start-1">
                    {/* Counts are Discord's own approximations, refreshed with
                        the invite every few hours. */}
                    <div className="grid grid-cols-2 gap-4">
                      <Stat label="members" value={row.memberCount.toLocaleString("en-US")} />
                      <Stat label="online" value={row.onlineCount.toLocaleString("en-US")} />
                      {typeof row.boostCount === "number" && row.boostCount > 0 && (
                        <Stat label="boosts" value={row.boostCount.toLocaleString("en-US")} />
                      )}
                    </div>

                    <div className="mt-4 space-y-2 border-t border-osu-b3/20 pt-4">
                      {/* A month and a year rather than a number, so it reads as
                          a line here instead of wrapping across a stat. */}
                      {created && <Fact label="server made">{monthYear(created)}</Fact>}
                      <Fact label="posted by">
                        <Link
                          to="/player/$username"
                          params={{ username: row.ownerUsername }}
                          className="inline-flex items-center gap-1.5 font-semibold text-osu-l2 transition-colors cursor-pointer hover:text-white"
                        >
                          <Avatar userId={row.ownerUserId} size={16} />
                          {row.ownerUsername}
                        </Link>
                      </Fact>
                      <Fact label="listed">
                        <span suppressHydrationWarning>{formatTimeAgo(row.createdAt)}</span>
                      </Fact>
                      {accessLabel && (
                        <Fact label="open to">
                          <span className="inline-flex items-center gap-1.5">
                            <Lock className="h-3.5 w-3.5 shrink-0 text-osu-f1" aria-hidden="true" />
                            {accessLabel}
                          </span>
                        </Fact>
                      )}
                      {/* Nothing to print when the invite was withheld, which is
                          the point: the link is not on the page in any form. */}
                      {row.inviteUrl && (
                        <Fact label="invite">
                          <a
                            href={row.inviteUrl}
                            target="_blank"
                            rel="noreferrer"
                            onClick={() => track("community_join", communityEventProperties(row))}
                            className="inline-flex items-center gap-1.5 transition-colors cursor-pointer hover:text-white"
                          >
                            <Link2 className="h-3.5 w-3.5 shrink-0 text-osu-f1" aria-hidden="true" />
                            discord.gg/{inviteCode}
                          </a>
                        </Fact>
                      )}
                    </div>

                    {badges.length > 0 && (
                      <div className="mt-4 flex flex-wrap gap-1.5 border-t border-osu-b3/20 pt-4">
                        {badges.map((badge) => (
                          <span
                            key={badge}
                            className="rounded-full bg-osu-b3/25 px-2.5 py-1 text-[11px] font-semibold text-osu-f1"
                          >
                            {badge}
                          </span>
                        ))}
                      </div>
                    )}

                    {/* Anyone signed in can flag the listing. A directory of
                        servers people post about themselves is only as honest
                        as the people reading it, and after approval nobody is
                        watching a listing except them. Quiet, at the bottom,
                        because it is the last thing a page is for. A report is
                        one per account, so a signed-out reader is offered
                        nothing rather than a button that would refuse. */}
                    {!isOwner && auth.viewer && (
                      /* Right-aligned, where every value in this column sits.
                         On the left it read as another label with nothing
                         against it. */
                      <div className="mt-4 flex justify-end border-t border-osu-b3/20 pt-3">
                        {reported ? (
                          <p className="text-[11.5px] text-osu-f1/70">Report sent</p>
                        ) : (
                          <button
                            type="button"
                            onClick={() => setReporting(true)}
                            className="inline-flex items-center gap-1.5 text-[11.5px] font-semibold text-osu-f1 transition-colors cursor-pointer hover:text-osu-red-light"
                          >
                            <Flag className="h-3 w-3" aria-hidden="true" />
                            report this server
                          </button>
                        )}
                      </div>
                    )}
                  </div>

                  {/* Under the pitch on a wide screen, where the room beside
                      the facts runs out first, and under the facts when there
                      is only one column to stack into. */}
                  <OtherServers community={row} className="lg:col-start-1 lg:row-start-2" />
                </div>
              </>
            )}
          </div>
        </div>
      </div>

      <AnimatePresence>
        {iconOpen && row?.iconUrl && (
          <motion.div
            className="fixed inset-0 z-50 flex flex-col items-center justify-center bg-black/75 backdrop-blur-sm cursor-pointer"
            onClick={() => setIconOpen(false)}
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.2 }}
          >
            <motion.img
              src={largeIconUrl(row.iconUrl)}
              alt={`${row.name} icon`}
              className="h-[300px] w-[300px] rounded-3xl object-cover shadow-[0_12px_60px_rgba(0,0,0,0.7)]"
              onClick={(event) => event.stopPropagation()}
              initial={{ scale: 0.85, opacity: 0 }}
              animate={{ scale: 1, opacity: 1 }}
              exit={{ scale: 0.85, opacity: 0 }}
              transition={{ type: "spring", damping: 30, stiffness: 500 }}
            />
            <motion.span
              className="mt-4 max-w-[320px] break-words px-4 text-center text-lg font-bold text-white [overflow-wrap:anywhere]"
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: 8 }}
              transition={{ duration: 0.15, delay: 0.05 }}
              onClick={(event) => event.stopPropagation()}
            >
              {row.name}
            </motion.span>
          </motion.div>
        )}
      </AnimatePresence>

      {reporting && row && (
        <CommunityReportModal
          community={row}
          onSent={() => setJustReported(true)}
          onClose={() => setReporting(false)}
        />
      )}

      {editing && row && (
        <CommunityEditModal
          community={row}
          onChanged={(updated) => {
            // The directory holds pages of its own, and this row is in some of
            // them; dropping them means the grid is not showing the old copy.
            clearCommunitiesCache();
            setRow(updated);
          }}
          onRemoved={() => {
            clearCommunitiesCache();
            void navigate({ to: "/communities" });
          }}
          onClose={() => setEditing(false)}
        />
      )}
    </div>
  );
}
