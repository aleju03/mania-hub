import postcss, { type AtRule, type ChildNode, type Container, type Declaration, type Plugin } from "postcss";
import { UI_SCALE_BREAKPOINTS } from "../src/lib/ui-scale-values";

/* The UI Scaling setting (src/lib/ui-scale.ts) multiplies the interface by
   --ui-scale. rem sizes follow the root font size, but most of the site is
   sized in px (text-[12px], h-[84px], hand-written CSS), so this rewrites
   every px length in the app's own stylesheets to `calc(Npx * var(--ui-scale))`.

   Page-level CSS zoom would scale everything for free, but it also scales
   100dvh past the window, moves anything placed at the pointer's clientX and
   draws canvases at a fraction of their shown size. Rewriting the stylesheet
   leaves those in real pixels: media queries (only declaration values are
   touched), inline styles and canvas drawing.

   Left alone: hairlines (1px and under), @property initial values (a
   registered property's initial value must not reference a variable),
   @font-face and @page descriptors, `content` strings and anything inside
   url().

   Breakpoints move with the scale, the way they do under browser zoom: every
   width or height media query is copied once per UI_SCALE_BREAKPOINTS step
   with its lengths multiplied, and each copy only applies under that
   `html[data-ui-scale]` (the page sets the step nearest the slider)
   (the original only without one). The guards sit in :where(), so no rule's
   specificity changes. Without this a 125% page on a 1280px screen would keep
   the desktop layout with a quarter more content in it. */
const SKIP_AT_RULES = new Set(["property", "font-face", "page"]);
const PX = /(^|[\s,(/*+])(-?\d*\.?\d+)px\b/g;

function insideSkippedAtRule(decl: Declaration): boolean {
  for (let node = decl.parent; node; node = node.parent as typeof node) {
    if (node.type === "atrule" && SKIP_AT_RULES.has((node as AtRule).name)) return true;
    if (node.type === "root") return false;
  }
  return false;
}

export function scalePxValue(value: string): string {
  if (!value.includes("px") || value.includes("url(")) return value;
  return value.replace(PX, (match, lead: string, number: string) => {
    if (Math.abs(Number(number)) <= 1) return match;
    return `${lead}calc(${number}px * var(--ui-scale, 1))`;
  });
}

const SCALED_STEPS = UI_SCALE_BREAKPOINTS.filter((value) => value !== 1);
const SIZE_QUERY = /(width|height)/;
const QUERY_LENGTH = /(\d*\.?\d+)(px|rem|em)\b/g;
const UNWRAPPABLE = new Set(["keyframes", "font-face", "property", "layer", "import", "charset", "page"]);

export function scaleMediaParams(params: string, scale: number): string {
  return params.replace(QUERY_LENGTH, (_match, number: string, unit: string) => `${Number((Number(number) * scale).toFixed(4))}${unit}`);
}

function hasRuleAncestor(node: ChildNode): boolean {
  for (let parent = node.parent; parent; parent = parent.parent as typeof parent) {
    if (parent.type === "rule") return true;
    if (parent.type === "root") return false;
  }
  return false;
}

/* Prefixes each rule under a top-level query with the guard; html and :root
   selectors take it on themselves rather than as an ancestor. */
function guardRules(container: Container, guard: string, rootGuard: string): void {
  container.each((child) => {
    if (child.type === "rule") {
      child.selectors = child.selectors.map((selector) => {
        const trimmed = selector.trim();
        if (/^(html|:root)\b/.test(trimmed)) return trimmed.replace(/^(html|:root)/, `$1${rootGuard}`);
        return `${guard} ${trimmed}`;
      });
    } else if (child.type === "atrule" && child.nodes) {
      guardRules(child, guard, rootGuard);
    }
  });
}

/* A query nested in a rule (Tailwind's dev output) holds declarations: they
   move into a nested `:where(guard) &` rule, which resolves to the same
   selector under that root. */
function guardQuery(query: AtRule, attribute: string, nested: boolean): void {
  const guard = `:where(html${attribute})`;
  if (!nested) {
    guardRules(query, guard, attribute);
    return;
  }
  const wrapper = postcss.rule({ selector: `${guard} &` });
  wrapper.append(query.nodes ?? []);
  query.removeAll();
  query.append(wrapper);
}

function scaleBreakpoints(root: Container): void {
  const handled = new WeakSet<ChildNode>();
  root.walkAtRules("media", (query) => {
    for (let parent = query.parent; parent; parent = parent.parent as typeof parent) {
      if (handled.has(parent as ChildNode)) return;
    }
    if (handled.has(query)) return;
    if (!SIZE_QUERY.test(query.params) || !QUERY_LENGTH.test(query.params)) return;
    QUERY_LENGTH.lastIndex = 0;
    if (query.some((child) => child.type === "atrule" && UNWRAPPABLE.has(child.name))) return;
    const nested = hasRuleAncestor(query);
    let anchor: ChildNode = query;
    for (const scale of SCALED_STEPS) {
      const copy = query.clone({ params: scaleMediaParams(query.params, scale) });
      guardQuery(copy, `[data-ui-scale="${scale}"]`, nested);
      handled.add(copy);
      anchor.after(copy);
      anchor = copy;
    }
    guardQuery(query, ":not([data-ui-scale])", nested);
    handled.add(query);
  });
}

export function uiScalePostcss(options: { include: (file: string) => boolean }): Plugin {
  return {
    postcssPlugin: "ui-scale-px",
    Once(root, { result }) {
      const file = result.opts.from ?? "";
      if (!options.include(file)) return;
      root.walkDecls((decl) => {
        if (decl.prop === "content" || decl.prop === "--ui-scale") return;
        if (insideSkippedAtRule(decl)) return;
        const next = scalePxValue(decl.value);
        if (next !== decl.value) decl.value = next;
      });
      scaleBreakpoints(root);
    },
  };
}
