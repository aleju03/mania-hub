import { track } from "./analytics";

// Browser page translation (Chrome/Edge "Translate this page") rewraps text
// nodes in <font> tags behind React's back; React's next commit then throws
// NotFoundError from removeChild/insertBefore and the root error boundary
// takes the whole page down. Targeted translate="no" on churny subtrees never
// fully covered it (users on /packs still crashed after the 2026-08-10 pass),
// so this makes the two DOM ops tolerant instead: a removeChild of a node the
// translator already moved becomes a no-op, an insertBefore whose reference
// node was moved falls back to appendChild. Worst case a translated fragment
// renders out of order until the next full re-render — the page survives.
// The first conflict per page load is still reported to analytics so real
// bugs reaching this path stay visible.
const MAX_REPORTS_PER_PAGE = 3;
let reported = 0;

function reportConflict(op: "removeChild" | "insertBefore") {
  if (reported >= MAX_REPORTS_PER_PAGE) return;
  reported++;
  const html = document.documentElement;
  try {
    track("dom_translate_conflict", {
      op,
      doc_lang: html.lang || null,
      translated: /translated-(ltr|rtl)/.test(html.className),
      stack: new Error().stack?.slice(0, 1500) ?? null,
    });
  } catch {
    // Never let telemetry break the guard.
  }
}

let installed = false;

export function installDomTranslateGuard() {
  if (installed || typeof Node === "undefined" || !Node.prototype) return;
  installed = true;

  const originalRemoveChild = Node.prototype.removeChild;
  Node.prototype.removeChild = function removeChild<T extends Node>(this: Node, child: T): T {
    if (child.parentNode !== this) {
      reportConflict("removeChild");
      return child;
    }
    return originalRemoveChild.call(this, child) as T;
  };

  const originalInsertBefore = Node.prototype.insertBefore;
  Node.prototype.insertBefore = function insertBefore<T extends Node>(
    this: Node,
    newNode: T,
    reference: Node | null,
  ): T {
    if (reference && reference.parentNode !== this) {
      reportConflict("insertBefore");
      return originalInsertBefore.call(this, newNode, null) as T;
    }
    return originalInsertBefore.call(this, newNode, reference) as T;
  };
}
