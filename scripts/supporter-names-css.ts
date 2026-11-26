import postcss, { type AtRule, type ChildNode, type Container, type Rule } from "postcss";

/* The standalone stylesheet for supporter names in lists, served at
   /supporter-names.css for apps that draw them outside the site (Hashi's
   leaderboard). It is cut from src/styles.css at build time, so it follows
   every style and font the site adds: `.name-tag`, each `.name-tag--<id>`,
   each `.name-font--<id>` with its @font-face, `.name-outline`, the keyframes
   they run and the reduced-motion hold. Left out: what only the site's own big
   names and pickers use (the live shader, its pending and waiting states, the
   hero's extra room, picker tiles) and the site's paused-window rule. Font URLs
   are root-relative here, prefixed with ORIGIN_PLACEHOLDER; the route swaps in
   the site's absolute origin. */

export const ORIGIN_PLACEHOLDER = "__SUPPORTER_NAMES_ORIGIN__";

const NAME_SELECTOR = /\.name-tag\b|\.name-font--|\.name-outline\b|\[class\*="name-font--"\]/;
const SITE_ONLY_SELECTOR = /\.name-tag--(hero|live|pending|waiting)\b|\.name-tag-shader\b|\.name-tag-grid\b|:root\[/;
const KEPT_AT_RULES = new Set(["media", "layer", "supports"]);

function keepRule(rule: Rule): boolean {
  const selectors = rule.selectors.filter((selector) => NAME_SELECTOR.test(selector) && !SITE_ONLY_SELECTOR.test(selector));
  if (selectors.length === 0) return false;
  rule.selectors = selectors;
  return true;
}

function animationNames(value: string): string[] {
  return value.split(",").flatMap((part) => part.trim().split(/\s+/)).filter((word) => /^name-tag-[a-z0-9-]+$/.test(word));
}

/* Keeps the name rules of a container in place, recursing into @media and
   @layer blocks; drops everything else. */
function prune(container: Container, used: Set<string>): void {
  container.each((node: ChildNode) => {
    if (node.type === "comment") {
      node.remove();
    } else if (node.type === "rule") {
      if (!keepRule(node)) node.remove();
      else node.walkDecls(/^animation(-name)?$/, (decl) => animationNames(decl.value).forEach((name) => used.add(name)));
    } else if (node.type === "atrule") {
      const at = node as AtRule;
      if (at.name === "font-face") {
        const family = at.nodes?.find((child) => child.type === "decl" && child.prop === "font-family");
        if (!family || family.type !== "decl" || !/^["']Name /.test(family.value)) at.remove();
      } else if (at.name === "keyframes") {
        // kept for now; unreferenced ones go once every rule has been seen
      } else if (KEPT_AT_RULES.has(at.name) && at.nodes) {
        prune(at, used);
        if (at.nodes.length === 0) at.remove();
      } else {
        at.remove();
      }
    } else {
      node.remove();
    }
  });
}

export function buildSupporterNamesCss(source: string): string {
  const root = postcss.parse(source);
  const used = new Set<string>();
  prune(root, used);
  root.walkAtRules("keyframes", (at) => {
    if (!used.has(at.params.trim())) at.remove();
  });
  root.walkDecls((decl) => {
    decl.value = decl.value.replace(/url\((["']?)\/(?!\/)/g, `url($1${ORIGIN_PLACEHOLDER}/`);
  });
  root.walkAtRules("font-face", (at) => {
    // Every name font is served with Access-Control-Allow-Origin: *. The query
    // gives them URLs no cache holds from before that header was sent.
    at.walkDecls("src", (decl) => {
      decl.value = decl.value.replace(/url\((["']?)([^"')]+)\1\)/g, (_, quote: string, url: string) => `url(${quote}${url}${url.includes("?") ? "&" : "?"}cors=1${quote})`);
    });
  });
  root.raws.after = "\n";
  const body = root.toString().replace(/\n{3,}/g, "\n\n").trim();
  return `/* Supporter name styles and fonts from mania-tracker.com, for names in lists.
   Classes: name-tag plus name-tag--<style> (name-tag--solid with an inline
   color for a solid colour, name-tag--terminal name-tag--bare without the
   cursor), name-font--<font>, and name-outline with --name-outline and
   --name-outline-width set inline. Fonts fall back to var(--font-sans, sans-serif). */
${body}
`;
}
