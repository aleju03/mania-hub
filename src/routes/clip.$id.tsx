import { createFileRoute, Link } from "@tanstack/react-router";
import { msg } from "@lingui/core/macro";
import { Trans, useLingui } from "@lingui/react/macro";

import { PageHeader } from "../components/layout/PageHeader";
import { UsernameText } from "../components/ui/UsernameText";
import { getI18n } from "../lib/i18n";
import { absoluteUrl, pageSeo } from "../lib/seo";
import { getSharedClip, sharedClipMediaPath, sharedClipPath, SHARED_CLIP_TTL_HOURS } from "../lib/shared-clips";

/* A supporter's shared replay clip (lib/shared-clips.ts). The page carries
   og:video tags, so a link pasted in Discord plays the clip inline; opened
   in a browser it plays here, with the way back to the replay. Clips last 24
   hours, after which the link says so. */

export const Route = createFileRoute("/clip/$id")({
  loader: ({ params }) => getSharedClip({ data: { id: params.id } }),
  head: ({ match, loaderData }) => {
    const i18n = getI18n(match.context.locale);
    const origin = match.context.origin;
    if (loaderData?.state !== "ready") {
      return {
        meta: [
          { title: loaderData?.state === "expired" ? i18n._(msg`This clip expired`) : i18n._(msg`Clip not found`) },
          { name: "robots", content: "noindex, nofollow" },
        ],
      };
    }
    const { clip } = loaderData;
    const videoUrl = absoluteUrl(sharedClipMediaPath(clip.id, "video"), origin);
    const seo = pageSeo({
      title: clip.title,
      description: i18n._(msg`Replay clip shared by ${clip.ownerUsername}`),
      path: sharedClipPath(clip.id),
      origin,
      image: clip.hasPoster ? sharedClipMediaPath(clip.id, "poster") : undefined,
      imageWidth: clip.hasPoster ? Math.min(1280, clip.width ?? 1280) : undefined,
      imageHeight: clip.hasPoster && clip.width && clip.height ? Math.round(Math.min(1280, clip.width) * (clip.height / clip.width)) : undefined,
      type: "video.other",
      noindex: true,
    });
    const size = clip.width && clip.height ? clip.width / clip.height : 16 / 9;
    const width = clip.width ?? 1280;
    return {
      meta: [
        ...seo.meta.filter((entry) => !("name" in entry && entry.name === "twitter:card")),
        { property: "og:video", content: videoUrl },
        { property: "og:video:url", content: videoUrl },
        { property: "og:video:secure_url", content: videoUrl },
        { property: "og:video:type", content: clip.contentType },
        { property: "og:video:width", content: String(width) },
        { property: "og:video:height", content: String(Math.round(width / size)) },
        { name: "twitter:card", content: "player" },
        { name: "theme-color", content: "#ff66aa" },
      ],
      links: seo.links,
    };
  },
  component: ClipPage,
});

function ClipPage() {
  const { t } = useLingui();
  const lookup = Route.useLoaderData();

  if (lookup.state !== "ready") {
    return (
      <div className="flex-1 bg-osu-b5">
        <PageHeader iconSrc="/images/icons/supporter-gem.svg" title={t`clip`} />
        <div className="mx-auto max-w-[720px] px-4 py-16 text-center">
          <h1 className="text-lg font-semibold text-white">
            {lookup.state === "expired" ? t`This clip expired` : t`Clip not found`}
          </h1>
          <p className="mt-2 text-sm text-osu-f1">
            {t`Shared clips stay up for ${SHARED_CLIP_TTL_HOURS} hours.`}
          </p>
        </div>
      </div>
    );
  }

  const { clip } = lookup;
  return (
    <div className="flex-1 bg-osu-b5">
      <PageHeader iconSrc="/images/icons/supporter-gem.svg" title={t`clip`} />
      <div className="mx-auto max-w-[1100px] px-4 py-5 sm:px-5">
        <div className="overflow-hidden rounded-lg bg-black">
          <video
            src={sharedClipMediaPath(clip.id, "video")}
            poster={clip.hasPoster ? sharedClipMediaPath(clip.id, "poster") : undefined}
            controls
            playsInline
            preload="metadata"
            className="block aspect-video w-full"
          />
        </div>
        <div className="mt-3 flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <h1 className="truncate text-base font-semibold text-white">{clip.title}</h1>
            <div className="mt-0.5 text-xs text-osu-f1">
              <Trans>
                Shared by{" "}
                <Link to="/player/$username" params={{ username: String(clip.ownerUserId) }} className="hover:underline">
                  <UsernameText username={clip.ownerUsername} userId={clip.ownerUserId} className="font-semibold" />
                </Link>
              </Trans>
            </div>
          </div>
          {clip.replayPath && (
            <a
              href={clip.replayPath}
              className="shrink-0 rounded-md border border-osu-pink/20 bg-osu-pink/15 px-3 py-1.5 text-xs font-semibold text-osu-pink-light transition-colors hover:bg-osu-pink/25"
            >
              {t`Watch the replay`}
            </a>
          )}
        </div>
      </div>
    </div>
  );
}
