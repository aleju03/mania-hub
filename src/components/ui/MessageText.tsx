import { useState } from "react";
import { Check, Copy } from "lucide-react";
import { useLingui } from "@lingui/react/macro";

import { ImageLightbox } from "./ImageLightbox";
import { splitCode } from "../../lib/code-fences";
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
 * ```Fenced``` code renders as a block and `backticks` as inline code, both
 * left unlinked, so a request or a payload can be pasted and copied back out
 * exactly.
 *
 * Everything it renders is inline-level (a code block is a block-display
 * span), so it drops into the paragraph or bubble a caller already has.
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

  const parts = splitCode(text);
  const prose = parts.map((part) => (part.kind === "text" ? part.text : " ")).join("");
  const embeds = messageImageEmbeds(prose).filter((url) => !dead.includes(url));

  return (
    <>
      {parts.map((part, partIndex) => {
        if (part.kind === "block") return <CodeBlock key={partIndex} code={part.code} />;
        if (part.kind === "inline") {
          return (
            <code key={partIndex} className="rounded bg-black/25 px-1 py-px font-mono text-[0.9em]">
              {part.code}
            </code>
          );
        }
        return linkify(part.text).map((segment, index) => (
          segment.kind === "link" ? (
            <a
              key={`${partIndex}-${index}`}
              href={segment.href}
              target="_blank"
              rel="noopener noreferrer nofollow ugc"
              referrerPolicy="no-referrer"
              className={linkClassName}
            >
              {segment.text}
            </a>
          ) : (
            <span key={`${partIndex}-${index}`}>{segment.text}</span>
          )
        ));
      })}
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

function CodeBlock({ code }: { code: string }) {
  const { t } = useLingui();
  const [copied, setCopied] = useState(false);
  return (
    <span className="my-1.5 flex items-start rounded-lg bg-black/30">
      <code className="block min-w-0 flex-1 overflow-x-auto whitespace-pre py-2.5 pl-3 pr-1 font-mono text-[12px] leading-relaxed text-osu-l1">
        {code}
      </code>
      <button
        type="button"
        onClick={() => {
          void navigator.clipboard?.writeText(code).then(() => {
            setCopied(true);
            window.setTimeout(() => setCopied(false), 1200);
          });
        }}
        aria-label={t`Copy`}
        title={t`Copy`}
        className="m-1.5 flex-shrink-0 cursor-pointer rounded-md p-1 text-osu-f1 transition-colors duration-[120ms] hover:bg-white/10 hover:text-white"
      >
        {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
      </button>
    </span>
  );
}
