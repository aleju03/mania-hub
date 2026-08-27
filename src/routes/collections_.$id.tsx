import { createFileRoute, Link } from "@tanstack/react-router";
import { Trans } from "@lingui/react/macro";
import { msg } from "@lingui/core/macro";
import { getI18n } from "../lib/i18n";
import { PageHeader } from "../components/layout/PageHeader";
import { UserCollectionDetailView } from "../components/maps/UserCollectionDetail";
import { pageSeo } from "../lib/seo";
import { fetchUserMapCollection, type UserMapCollectionDetail } from "../lib/user-map-collections";

/* A posted map collection on its own page.
 *
 * Its own route rather than a search param on /maps, because this is the link
 * players hand each other: `/collections/ln-coordination` instead of a tab, a
 * country, a keymode and a uuid. Loaded on the server so a scraper gets the
 * title, the blurb and a card image rather than an empty shell. */

export const Route = createFileRoute("/collections_/$id")({
  loader: async ({ params }) => {
    try {
      return await fetchUserMapCollection({ data: { id: params.id } });
    } catch {
      return null;
    }
  },
  head: ({ match }) => {
    const collection = match.loaderData as UserMapCollectionDetail | null | undefined;
    const i18n = getI18n(match.context.locale);
    if (!collection) {
      return pageSeo({
        title: i18n._(msg`Map collection`),
        description: i18n._(msg`Map collections built by osu!mania players.`),
        path: `/collections/${match.params.id}`,
        origin: match.context.origin,
        imageKind: "maps-collections",
        noindex: true,
      });
    }
    const maps = collection.memberCount;
    return pageSeo({
      title: collection.title,
      description: collection.description?.replace(/\s+/g, " ").slice(0, 160)
        || i18n._(msg`${maps} osu!mania maps picked by ${collection.owner.username}.`),
      path: `/collections/${collection.slug || collection.id}`,
      origin: match.context.origin,
      // The card is drawn per collection (cover collage, title, owner, counts),
      // so it keys on the id rather than on the title like the static kinds.
      image: `/api/og?kind=collection&id=${encodeURIComponent(collection.id)}`,
      imageKind: "collection",
    });
  },
  component: CollectionPage,
});

function CollectionPage() {
  const collection = Route.useLoaderData() as UserMapCollectionDetail | null;

  if (!collection) {
    return (
      <div className="bg-osu-b5 min-h-[60vh]">
        <PageHeader iconSrc="/images/icons/beatmappacks.svg" title={<Trans>Collection</Trans>} />
        <div className="max-w-[1200px] mx-auto px-4 py-16 text-center sm:px-5">
          <p className="text-[13px] text-osu-f1"><Trans>This collection is gone, or the link is wrong.</Trans></p>
          <Link
            to="/maps"
            search={{ tab: "collections", cSrc: "community" } as never}
            className="mt-3 inline-flex rounded-lg bg-osu-b4 px-3 py-1.5 text-[12px] font-semibold text-osu-l2 transition-colors hover:bg-osu-b3 hover:text-white"
          >
            <Trans>Browse collections</Trans>
          </Link>
        </div>
      </div>
    );
  }

  return <UserCollectionDetailView collection={collection} />;
}
