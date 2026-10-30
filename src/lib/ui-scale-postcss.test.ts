import postcss from "postcss";
import { describe, expect, it } from "vitest";
import { scaleMediaParams, scalePxValue, uiScalePostcss } from "../../scripts/ui-scale-postcss";

const run = (css: string) =>
  postcss([uiScalePostcss({ include: () => true })]).process(css, { from: "/app/src/styles.css" }).css.replace(/\s+/g, " ").trim();

describe("UI scaling stylesheet pass", () => {
  it("scales px lengths and leaves hairlines, urls and rem alone", () => {
    expect(scalePxValue("12px")).toBe("calc(12px * var(--ui-scale, 1))");
    expect(scalePxValue("0 0 0 1px #fff")).toBe("0 0 0 1px #fff");
    expect(scalePxValue("translate(-4px, 2.5px)")).toBe("translate(calc(-4px * var(--ui-scale, 1)), calc(2.5px * var(--ui-scale, 1)))");
    expect(scalePxValue("calc(100% - 20px)")).toBe("calc(100% - calc(20px * var(--ui-scale, 1)))");
    expect(scalePxValue('url("a-12px.png")')).toBe('url("a-12px.png")');
    expect(scalePxValue("1.5rem")).toBe("1.5rem");
  });

  it("never touches @property initial values", () => {
    expect(run("@property --x { syntax: '<length>'; inherits: false; initial-value: 4px; }")).toContain("initial-value: 4px");
  });

  it("copies each width query per scale, guarded by the root attribute", () => {
    const out = run("@media (width >= 40rem) { .sm-flex { display: flex; } }");
    expect(out).toContain("@media (width >= 40rem) { :where(html:not([data-ui-scale])) .sm-flex");
    expect(out).toContain('@media (width >= 50rem) { :where(html[data-ui-scale="1.25"]) .sm-flex');
    expect(out).toContain('@media (width >= 56rem) { :where(html[data-ui-scale="1.4"]) .sm-flex');
    expect(out).toContain('@media (width >= 32rem) { :where(html[data-ui-scale="0.8"]) .sm-flex');
    expect(scaleMediaParams("(max-width: 767px)", 1.1)).toBe("(max-width: 843.7px)");
  });

  it("wraps a query nested in a rule, the way Tailwind's dev output nests them", () => {
    const out = run(".md-hidden { @media (width >= 48rem) { display: none; } }");
    expect(out).toContain("@media (width >= 48rem) { :where(html:not([data-ui-scale])) & { display: none } }");
    expect(out).toContain('@media (width >= 60rem) { :where(html[data-ui-scale="1.25"]) & { display: none } }');
  });

  it("leaves queries that are not about size alone", () => {
    expect(run("@media (hover: hover) { .a:hover { color: red; } }")).toBe("@media (hover: hover) { .a:hover { color: red; } }");
  });
});
