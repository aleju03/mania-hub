import { useState } from "react";
import { useLingui } from "@lingui/react/macro";

import { ImageLightbox } from "./ImageLightbox";
import { linkify } from "../../lib/linkify";
import { messageImageEmbeds } from "../../lib/message-embeds";

/*
 * The words of a bug report message, with its links clickable and its images
 * shown.
 *
 * A report is mostly links: the map it is about, the score that proves it, the
 * screenshot that shows it. Reading them as dead text and retyping them into
 * the address bar is the slow half of triage, so URLs become anchors and the
 * ones that name an image file also render under the message, opening in the
 * same lightbox the attached screenshots use.
 *
 * Images are third-party URLs a stranger wrote, so they load with no referrer,
 * no cookies and no size promise: they are capped here and a dead one removes
 * itself rather than leaving a broken tile.
 *
 * Everything it renders is inline-level, so it drops into the paragraph or
 * bubble a caller already has.
 */
export function MessageText({
  text,
  linkClassName = "font-semibold underline decoration-osu-pink/50 underline-offset-2 transition-colors duration-[120ms] hover:decoration-osu-pink",
  embedClassName = "mt-2",
}: {
  text: string;
  linkClassName?: string;
  embedClassName?: string;
}) {
  const { t } = useLingui();
  const [zoom, setZoom] = useState<number | null>(null);
  const [dead, setDead] = useState<string[]>([]);

  const embeds = messageImageEmbeds(text).filter((url) => !dead.includes(url));

  return (
    <>
      {linkify(text).map((segment, index) => (
        segment.kind === "link" ? (
          <a
            key={index}
            href={segment.href}
            target="_blank"
            rel="noopener noreferrer nofollow ugc"
            referrerPolicy="no-referrer"
            className={linkClassName}
          >
            {segment.text}
          </a>
        ) : (
          <span key={index}>{segment.text}</span>
        )
      ))}
      {embeds.length ? (
        <span className={`flex flex-wrap gap-2 ${embedClassName}`}>
          {embeds.map((url, index) => (
            <button
              key={url}
              type="button"
              onClick={() => setZoom(index)}
              aria-label={t`Open image`}
              className="cursor-zoom-in"
            >
              <img
                src={url}
                alt=""
                loading="lazy"
                decoding="async"
                referrerPolicy="no-referrer"
                onError={() => setDead((previous) => (previous.includes(url) ? previous : [...previous, url]))}
                className="max-h-56 max-w-[min(100%,18rem)] rounded-lg border border-osu-b3/30 object-contain transition-opacity duration-[120ms] hover:opacity-80"
              />
            </button>
          ))}
        </span>
      ) : null}
      {zoom != null && embeds.length ? (
        <ImageLightbox
          urls={embeds}
          index={Math.min(zoom, embeds.length - 1)}
          onIndex={setZoom}
          onClose={() => setZoom(null)}
        />
      ) : null}
    </>
  );
}
