import {
  cloneElement,
  Fragment,
  isValidElement,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type MouseEvent,
  type ReactElement,
  type ReactNode,
  type Ref,
} from "react";
import { clampBBSizePercent, findBBNodePathAtOffset, parseBBCode, type BBNode, type BBSourceSpan } from "../../../lib/bbcode";

// Renders the parsed BBCode tree with the same markup/classes osu! emits for
// profile pages, so the existing .bbcode-content styles apply 1:1 and the
// preview matches what the about card (and osu! itself) will show.

const BARE_URL_PATTERN = /https?:\/\/[^\s<>[\]]+/g;

const HIGHLIGHT_CLASS = "bbcode-live-highlight";

/** Maps the source caret to the rendered preview while editing raw BBCode. */
interface HighlightCtx {
  target: BBNode | null;
  targetRef: (el: HTMLElement | null) => void;
  onSelectSourceSpan?: (span: BBSourceSpan) => void;
}

function shortenUrlText(href: string): string {
  try {
    const url = new URL(href);
    const host = url.hostname.replace(/^www\./, "");
    const path = url.pathname === "/" ? "" : url.pathname;
    const truncated = path.length > 24 ? `${path.slice(0, 24)}...` : path;
    return host + truncated;
  } catch {
    return href.length > 48 ? `${href.slice(0, 48)}...` : href;
  }
}

function renderTextWithLinks(text: string, keyPrefix: string): ReactNode[] {
  const out: ReactNode[] = [];
  const lines = text.split("\n");
  lines.forEach((line, lineIndex) => {
    if (lineIndex > 0) out.push(<br key={`${keyPrefix}-br-${lineIndex}`} />);
    let cursor = 0;
    let match: RegExpExecArray | null;
    BARE_URL_PATTERN.lastIndex = 0;
    while ((match = BARE_URL_PATTERN.exec(line)) !== null) {
      if (match.index > cursor) out.push(line.slice(cursor, match.index));
      const href = match[0].replace(/[.,;:!?)]+$/, "");
      out.push(
        <a
          key={`${keyPrefix}-a-${lineIndex}-${match.index}`}
          href={href}
          title={href}
          target="_blank"
          rel="noopener noreferrer nofollow"
        >
          {shortenUrlText(href)}
        </a>,
      );
      cursor = match.index + href.length;
    }
    if (cursor < line.length) out.push(line.slice(cursor));
  });
  return out;
}

function SpoilerBox({
  title,
  children,
  highlighted,
  highlightRef,
}: {
  title: string | null;
  children: ReactNode;
  highlighted?: boolean;
  highlightRef?: Ref<HTMLDivElement>;
}) {
  const [open, setOpen] = useState(false);
  return (
    <div
      ref={highlighted ? highlightRef : undefined}
      className={`js-spoilerbox bbcode-spoilerbox${open ? " is-open" : ""}${highlighted ? ` ${HIGHLIGHT_CLASS}` : ""}`}
    >
      <button
        type="button"
        className="js-spoilerbox__link bbcode-spoilerbox__link"
        onClick={() => setOpen((value) => !value)}
      >
        <span className="bbcode-spoilerbox__link-icon" />
        {title ?? "SPOILER"}
      </button>
      <div className="js-spoilerbox__body bbcode-spoilerbox__body">{children}</div>
    </div>
  );
}

function renderNode(node: BBNode, key: string, ctx: HighlightCtx): ReactNode {
  const rendered = renderNodeContent(node, key, ctx);
  const selectProps = node.span && ctx.onSelectSourceSpan
    ? {
        onClick: (event: MouseEvent<HTMLElement>) => {
          event.preventDefault();
          event.stopPropagation();
          ctx.onSelectSourceSpan?.(node.span!);
        },
      }
    : null;
  // [box] handles its own highlight (SpoilerBox isn't a host element).
  if (node.type === "text") {
    const className = node === ctx.target ? HIGHLIGHT_CLASS : undefined;
    return (
      <span key={key} className={className} ref={node === ctx.target ? ctx.targetRef : undefined} {...selectProps}>
        {rendered}
      </span>
    );
  }
  if (!isValidElement(rendered)) return rendered;
  // [box] handles its own highlight (SpoilerBox isn't a host element).
  if (node.type === "box") return rendered;
  if (node !== ctx.target && !selectProps) return rendered;
  const element = rendered as ReactElement<{ className?: string; ref?: Ref<HTMLElement>; onClick?: (event: MouseEvent<HTMLElement>) => void }>;
  const className = [element.props.className, HIGHLIGHT_CLASS].filter(Boolean).join(" ");
  return cloneElement(element, {
    ...(selectProps ?? {}),
    className: node === ctx.target ? className : element.props.className,
    ref: node === ctx.target ? ctx.targetRef : element.props.ref,
  });
}

function renderNodeContent(node: BBNode, key: string, ctx: HighlightCtx): ReactNode {
  switch (node.type) {
    case "text":
      return <Fragment key={key}>{renderTextWithLinks(node.text, key)}</Fragment>;
    case "style": {
      const children = renderNodes(node.children, key, ctx);
      switch (node.tag) {
        case "b": return <strong key={key}>{children}</strong>;
        case "i": return <em key={key}>{children}</em>;
        case "u": return <u key={key}>{children}</u>;
        case "s": return <del key={key}>{children}</del>;
        case "spoiler": return <span key={key} className="spoiler">{children}</span>;
      }
      return null;
    }
    case "color":
      return <span key={key} style={{ color: node.color }}>{renderNodes(node.children, key, ctx)}</span>;
    case "size":
      return <span key={key} style={{ fontSize: `${clampBBSizePercent(node.size)}%` }}>{renderNodes(node.children, key, ctx)}</span>;
    case "url":
      return (
        <a key={key} href={node.href} target="_blank" rel="noopener noreferrer nofollow" title={node.href}>
          {renderNodes(node.children, key, ctx)}
        </a>
      );
    case "email":
      return <a key={key} href={`mailto:${node.address}`}>{renderNodes(node.children, key, ctx)}</a>;
    case "profile": {
      const href = node.userId
        ? `https://osu.ppy.sh/users/${encodeURIComponent(node.userId)}`
        : `https://osu.ppy.sh/users/${encodeURIComponent(nodeText(node.children))}`;
      return (
        <a key={key} href={href} target="_blank" rel="noopener noreferrer nofollow">
          {renderNodes(node.children, key, ctx)}
        </a>
      );
    }
    case "img":
      return <img key={key} src={node.src} alt="" loading="lazy" />;
    case "youtube":
      return (
        <div key={key} className="bbcode-video">
          <iframe
            src={`https://www.youtube-nocookie.com/embed/${node.videoId}`}
            title="YouTube video"
            allowFullScreen
            loading="lazy"
          />
        </div>
      );
    case "audio":
      return <audio key={key} controls preload="none" src={node.src} />;
    case "heading":
      return <h2 key={key}>{renderNodes(node.children, key, ctx)}</h2>;
    case "notice":
      return <div key={key} className="well">{renderNodes(node.children, key, ctx)}</div>;
    case "centre":
      return <center key={key}>{renderNodes(node.children, key, ctx)}</center>;
    case "quote":
      return (
        <blockquote key={key}>
          {node.author ? <h4>{node.author} wrote:</h4> : null}
          {renderNodes(node.children, key, ctx)}
        </blockquote>
      );
    case "box":
      return (
        <SpoilerBox key={key} title={node.title} highlighted={node === ctx.target} highlightRef={ctx.targetRef}>
          {renderNodes(node.children, key, ctx)}
        </SpoilerBox>
      );
    case "code":
      return node.inline
        ? <code key={key}>{node.code}</code>
        : <pre key={key}>{node.code}</pre>;
    case "list": {
      const items = node.items.map((item, index) => (
        <li key={`${key}-li-${index}`}>{renderNodes(item, `${key}-li-${index}`, ctx)}</li>
      ));
      return node.ordered ? <ol key={key}>{items}</ol> : <ul key={key}>{items}</ul>;
    }
    case "imagemap":
      return (
        <div key={key} className="imagemap">
          <img className="imagemap__image" src={node.src} alt="" loading="lazy" />
          {node.links.map((link, index) => {
            const style = {
              left: `${link.x}%`,
              top: `${link.y}%`,
              width: `${link.width}%`,
              height: `${link.height}%`,
            };
            return link.href ? (
              <a
                key={`${key}-area-${index}`}
                className="imagemap__link"
                href={link.href}
                title={link.title || undefined}
                style={style}
                target="_blank"
                rel="noopener noreferrer nofollow"
              />
            ) : (
              <span key={`${key}-area-${index}`} className="imagemap__link" title={link.title || undefined} style={style} />
            );
          })}
        </div>
      );
    default:
      return null;
  }
}

function nodeText(nodes: BBNode[]): string {
  return nodes.map((node) => (node.type === "text" ? node.text : "")).join("").trim();
}

function renderNodes(nodes: BBNode[], keyPrefix: string, ctx: HighlightCtx): ReactNode[] {
  return nodes.map((node, index) => renderNode(node, `${keyPrefix}-${index}`, ctx));
}

const HIGHLIGHT_BLOCK_TYPES = new Set<BBNode["type"]>([
  "heading", "notice", "centre", "quote", "box", "list", "imagemap", "youtube",
]);

/**
 * Picks what to highlight for a caret path: the innermost block keeps the
 * region readable (a single [color] span in a gradient run would be one
 * character), falling back to the top-level node for plain inline runs.
 */
function pickHighlightNode(path: BBNode[]): BBNode | null {
  for (let i = path.length - 1; i >= 0; i--) {
    const node = path[i];
    if (HIGHLIGHT_BLOCK_TYPES.has(node.type) || (node.type === "code" && !node.inline)) return node;
  }
  const top = path[0] ?? null;
  // A caret on the blank line between blocks lands in whitespace-only text;
  // highlighting it would just draw an empty sliver.
  if (top && top.type === "text" && top.text.trim() === "") return null;
  return top;
}

export function BBCodePreview({
  source,
  highlightOffset,
  onSelectSourceSpan,
}: {
  source: string;
  /** Caret offset into `source`; highlights the matching preview region. */
  highlightOffset?: number | null;
  onSelectSourceSpan?: (span: BBSourceSpan) => void;
}) {
  const nodes = useMemo(() => parseBBCode(source, { spans: true }), [source]);
  const target = useMemo(() => {
    if (highlightOffset == null) return null;
    return pickHighlightNode(findBBNodePathAtOffset(nodes, highlightOffset));
  }, [highlightOffset, nodes]);

  const targetEl = useRef<HTMLElement | null>(null);
  const targetRef = useCallback((el: HTMLElement | null) => {
    targetEl.current = el;
  }, []);
  useEffect(() => {
    if (target) targetEl.current?.scrollIntoView({ block: "nearest" });
  }, [target]);

  if (nodes.length === 0) {
    return <div className="text-osu-f1 text-sm py-6 text-center">Nothing to preview yet.</div>;
  }
  return <>{renderNodes(nodes, "bb", { target, targetRef, onSelectSourceSpan })}</>;
}
