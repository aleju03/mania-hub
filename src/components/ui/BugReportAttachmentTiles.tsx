import { Download, FileIcon } from "lucide-react";
import { useLingui } from "@lingui/react/macro";

import type { BugReportAttachmentLink } from "../../lib/bug-report-attachments";

/*
 * A bug report's attachments as they sit under its words: images as
 * thumbnails that open the lightbox, videos playing in place, and anything
 * else (a replay, a log) as its file name, which downloads it.
 */
export function BugReportAttachmentTiles({
  links,
  imageClassName,
  className = "",
  onOpenImage,
}: {
  links: BugReportAttachmentLink[];
  imageClassName: string;
  className?: string;
  /** Image urls only, and the index among them. */
  onOpenImage: (urls: string[], index: number) => void;
}) {
  const { t } = useLingui();
  const imageUrls = links.filter((link) => link.kind === "image").map((link) => link.url);
  return (
    <div className={`flex flex-wrap items-start gap-2 ${className}`}>
      {links.map((link) => {
        if (link.kind === "image") {
          return (
            <button
              key={link.url}
              type="button"
              onClick={() => onOpenImage(imageUrls, imageUrls.indexOf(link.url))}
              aria-label={t`Open image`}
              className="cursor-zoom-in"
            >
              <img
                src={link.url}
                alt=""
                loading="lazy"
                className={`${imageClassName} rounded-lg border border-osu-b3/30 object-cover transition-opacity duration-[120ms] hover:opacity-80`}
              />
            </button>
          );
        }
        if (link.kind === "video") {
          return (
            <div key={link.url} className="flex flex-col gap-1">
              <video
                src={link.url}
                controls
                preload="metadata"
                className="max-h-56 max-w-[min(100%,24rem)] rounded-lg border border-osu-b3/30 bg-black"
              />
              <FileLink link={link} />
            </div>
          );
        }
        return <FileLink key={link.url} link={link} />;
      })}
    </div>
  );
}

function FileLink({ link }: { link: BugReportAttachmentLink }) {
  return (
    <a
      href={link.url}
      download={link.name}
      rel="noopener noreferrer"
      className="group inline-flex max-w-full items-center gap-2 rounded-lg bg-osu-b4/60 px-2.5 py-1.5 text-[12px] text-osu-l1 transition-[filter] duration-[120ms] hover:brightness-110"
    >
      <FileIcon className="h-3.5 w-3.5 flex-shrink-0 text-osu-f1" />
      <span className="min-w-0 truncate font-mono">{link.name}</span>
      <Download className="h-3.5 w-3.5 flex-shrink-0 text-osu-f1 transition-colors duration-[120ms] group-hover:text-white" />
    </a>
  );
}

/** A picked file that is not an image, before it is sent. */
export function PendingFileTile({ name, className = "" }: { name: string; className?: string }) {
  return (
    <div className={`flex flex-col items-center justify-center gap-1 rounded-md border border-osu-b3/30 bg-osu-b4/60 px-1.5 text-osu-f1 ${className}`}>
      <FileIcon className="h-4 w-4 flex-shrink-0" />
      <span className="w-full truncate text-center font-mono text-[11px] text-osu-l2" title={name}>{name}</span>
    </div>
  );
}
