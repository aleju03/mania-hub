import { Fragment, useMemo, useState, type ReactNode } from "react";
import { parseBBCode, type BBNode } from "../../../lib/bbcode";

// Renders the parsed BBCode tree with the same markup/classes osu! emits for
// profile pages, so the existing .bbcode-content styles apply 1:1 and the
// preview matches what the about card (and osu! itself) will show.

const BARE_URL_PATTERN = /https?:\/\/[^\s<>[\]]+/g;

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

function SpoilerBox({ title, children }: { title: string | null; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <div className={`js-spoilerbox bbcode-spoilerbox${open ? " is-open" : ""}`}>
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

function renderNode(node: BBNode, key: string): ReactNode {
  switch (node.type) {
    case "text":
      return <Fragment key={key}>{renderTextWithLinks(node.text, key)}</Fragment>;
    case "style": {
      const children = renderNodes(node.children, key);
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
      return <span key={key} style={{ color: node.color }}>{renderNodes(node.children, key)}</span>;
    case "size":
      return <span key={key} style={{ fontSize: `${node.size}%` }}>{renderNodes(node.children, key)}</span>;
    case "url":
      return (
        <a key={key} href={node.href} target="_blank" rel="noopener noreferrer nofollow" title={node.href}>
          {renderNodes(node.children, key)}
        </a>
      );
    case "email":
      return <a key={key} href={`mailto:${node.address}`}>{renderNodes(node.children, key)}</a>;
    case "profile": {
      const href = node.userId
        ? `https://osu.ppy.sh/users/${encodeURIComponent(node.userId)}`
        : `https://osu.ppy.sh/users/${encodeURIComponent(nodeText(node.children))}`;
      return (
        <a key={key} href={href} target="_blank" rel="noopener noreferrer nofollow">
          {renderNodes(node.children, key)}
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
      return <h2 key={key}>{renderNodes(node.children, key)}</h2>;
    case "notice":
      return <div key={key} className="well">{renderNodes(node.children, key)}</div>;
    case "centre":
      return <center key={key}>{renderNodes(node.children, key)}</center>;
    case "quote":
      return (
        <blockquote key={key}>
          {node.author ? <h4>{node.author} wrote:</h4> : null}
          {renderNodes(node.children, key)}
        </blockquote>
      );
    case "box":
      return <SpoilerBox key={key} title={node.title}>{renderNodes(node.children, key)}</SpoilerBox>;
    case "code":
      return node.inline
        ? <code key={key}>{node.code}</code>
        : <pre key={key}>{node.code}</pre>;
    case "list": {
      const items = node.items.map((item, index) => (
        <li key={`${key}-li-${index}`}>{renderNodes(item, `${key}-li-${index}`)}</li>
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

function renderNodes(nodes: BBNode[], keyPrefix: string): ReactNode[] {
  return nodes.map((node, index) => renderNode(node, `${keyPrefix}-${index}`));
}

export function BBCodePreview({ source }: { source: string }) {
  const nodes = useMemo(() => parseBBCode(source), [source]);
  if (nodes.length === 0) {
    return <div className="text-osu-f1 text-sm py-6 text-center">Nothing to preview yet.</div>;
  }
  return <>{renderNodes(nodes, "bb")}</>;
}
