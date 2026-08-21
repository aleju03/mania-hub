import { Link } from "@tanstack/react-router";
import { Plural, Trans, useLingui } from "@lingui/react/macro";
import { Lock, Pencil, Users } from "lucide-react";
import { track } from "../../lib/analytics";
import { communityEventProperties, rememberCommunityName } from "../../lib/analytics-communities";
import { Avatar } from "../ui/Avatar";
import { CountryFlag } from "../ui/CountryFlag";
import { COMMUNITY_INTERNATIONAL, type CommunitySummary } from "../../lib/communities-shared";
import { useAccessScopeSummary } from "./AccessScopePicker";
import { useCommunityLanguageLabel } from "./field-options";
import { CommunityStatusNote } from "./CommunityStatusNote";

/* One Discord server on the directory. The banner and icon are Discord's own,
   either hotlinked from their CDN or, for a listing this viewer cannot join,
   served through /api/community-image so the guild id stays server-side. Either
   way these are plain <img> tags with no canvas involved, so none of the reasons
   /api/avatar exists apply here. */

export function CommunityCard({
  community,
  // The submit form renders this card as a preview. Join goes nowhere there,
  // because the listing does not exist yet.
  preview = false,
  // Set only on your own listings, which is what puts the pencil on the card.
  onEdit,
}: {
  community: CommunitySummary;
  preview?: boolean;
  onEdit?: () => void;
}) {
  const { t } = useLingui();
  const language = useCommunityLanguageLabel()(community.language);
  const showFlag = community.countryCode != null && community.countryCode !== COMMUNITY_INTERNATIONAL;
  const accessLabel = useAccessScopeSummary()(community.accessScopes);

  return (
    <div className="group relative flex flex-col overflow-hidden rounded-xl border border-osu-b3/20 bg-osu-b4 transition-colors hover:border-osu-b3/50">
      {/* The whole card opens the server's page, through a link laid over it
          rather than wrapped around it: an anchor cannot hold the Join anchor
          or the pencil, and those two stay on top of it. The preview inside the
          submit form has no page to open yet. */}
      {!preview && (
        <Link
          to="/communities/$id"
          params={{ id: community.id }}
          aria-label={community.name}
          // The detail pageview only sees a uuid, so the card hands the real
          // name forward for the activity feed.
          onClick={() => rememberCommunityName(community.id, community.name)}
          className="absolute inset-0 z-0"
        />
      )}

      {/* A banner is shown whole rather than dimmed under the name: it is the
          one picture the server chose for itself, and nothing needs to sit on
          top of it when the row below has its own darker band. */}
      {community.bannerUrl && (
        <img src={community.bannerUrl} alt="" loading="lazy" className="h-20 w-full object-cover" />
      )}

      {/* Who the server is sits in its own darker band rather than running into
          the description, so the eye finds the name and the counts first. */}
      <div className="flex items-center gap-2.5 border-b border-black/20 bg-osu-b5 p-3">
        {community.iconUrl ? (
          <img
            src={community.iconUrl}
            alt=""
            loading="lazy"
            width={40}
            height={40}
            className="h-10 w-10 shrink-0 rounded-2xl bg-osu-b3/40 object-cover"
          />
        ) : (
          <div
            className="flex h-10 w-10 shrink-0 items-center justify-center rounded-2xl bg-osu-b3/40 text-[15px] font-bold text-osu-l2"
            aria-hidden="true"
          >
            {community.name.slice(0, 1).toUpperCase()}
          </div>
        )}
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <h3 className="min-w-0 truncate text-[14px] font-bold text-white">{community.name}</h3>
            {showFlag && <CountryFlag code={community.countryCode} size="sm" />}
          </div>
          <div className="mt-0.5 flex items-center gap-3 text-[11px] text-osu-f1 tabular-nums">
            <span className="inline-flex items-center gap-1">
              <Users className="h-3 w-3" aria-hidden="true" />
              <Plural value={community.memberCount} one="# member" other="# members" />
            </span>
            {community.onlineCount > 0 && (
              <span className="inline-flex items-center gap-1.5">
                <span className="h-1.5 w-1.5 rounded-full bg-emerald-400" aria-hidden="true" />
                <Plural value={community.onlineCount} other="# online" />
              </span>
            )}
          </div>
        </div>
        {/* Yours to edit, said on the card itself rather than by a second copy
            of it in a panel above the grid. */}
        {onEdit && (
          <button
            type="button"
            onClick={onEdit}
            aria-label={t`Edit ${community.name}`}
            title={t`Edit your listing`}
            className="relative z-10 shrink-0 rounded-lg p-1.5 text-osu-f1 transition-colors cursor-pointer hover:bg-osu-b3/40 hover:text-white"
          >
            <Pencil className="h-3.5 w-3.5" aria-hidden="true" />
          </button>
        )}
      </div>

      <div className="flex flex-1 flex-col gap-2.5 p-3">
        {/* Always three lines at most, and no fold to open it here: the rest is
            on the server's own page, which the card is a link to. Unfolding in
            place made one long write-up decide how tall every card beside it
            was, which is what the clamp is for in the first place. Blank lines
            are closed up first, so a pitch written in paragraphs spends all
            three lines on words. */}
        <p className="line-clamp-3 whitespace-pre-line text-[12px] leading-relaxed text-osu-f1">
          {community.pitch.replace(/\n{2,}/g, "\n")}
        </p>

        {(language || community.tags.length > 0 || (accessLabel && community.inviteUrl)) && (
          <div className="flex flex-wrap gap-1.5">
            {/* Only for someone who can get in: for anyone else the Join button
                is already saying this, and saying it twice on one card is not
                twice as clear. */}
            {accessLabel && community.inviteUrl && (
              <span className="inline-flex items-center gap-1 rounded-full bg-osu-b3/45 px-2 py-0.5 text-[10.5px] font-semibold text-osu-l2">
                <Lock className="h-2.5 w-2.5" aria-hidden="true" />
                {accessLabel}
              </span>
            )}
            {language && (
              <span className="rounded-full bg-osu-b3/45 px-2 py-0.5 text-[10.5px] font-semibold text-osu-l2">
                {language}
              </span>
            )}
            {community.tags.map((tag) => (
              <span
                key={tag}
                className="rounded-full bg-osu-b3/45 px-2 py-0.5 text-[10.5px] font-semibold text-osu-l2"
              >
                {tag}
              </span>
            ))}
          </div>
        )}

        {/* Draws nothing unless this is your own copy of the listing, and
            nothing at all once it is approved and live. */}
        <CommunityStatusNote community={community} />

        <div className="mt-auto flex items-center gap-2.5 pt-0.5">
          {preview || !community.inviteUrl ? (
            /* No invite means this server is not for where you are, and the
               backend never sent one: there is nothing behind this to reveal by
               hovering it. What it says instead is who the server is for, so
               the card is still worth having read. */
            <span
              className="inline-flex items-center gap-1.5 rounded-full bg-osu-b3/45 px-4 py-1.5 text-[12.5px] font-bold text-osu-f1"
              title={preview ? undefined : t`Only people from here can join`}
            >
              {!preview && <Lock className="h-3 w-3" aria-hidden="true" />}
              {preview ? t`Join` : (accessLabel ?? t`Closed`)}
            </span>
          ) : (
            <a
              href={community.inviteUrl}
              target="_blank"
              rel="noreferrer"
              onClick={() => track("community_join", communityEventProperties(community))}
              className="relative z-10 inline-flex items-center justify-center rounded-full bg-osu-pink px-4 py-1.5 text-[12.5px] font-bold text-white transition cursor-pointer hover:brightness-110"
            >
              <Trans>Join</Trans>
            </a>
          )}
          {/* The osu! account that posted it, with the osu! avatar: the Discord
              account is only the proof of ownership and is never shown here. */}
          <span className="flex min-w-0 items-center gap-1.5 text-[11px] text-osu-f1/70">
            <Trans>posted by</Trans>
            <Avatar userId={community.ownerUserId} size={16} />
            <span className="min-w-0 truncate font-semibold text-osu-l2">{community.ownerUsername}</span>
          </span>
        </div>
      </div>
    </div>
  );
}
