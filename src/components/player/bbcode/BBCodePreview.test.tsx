// @vitest-environment jsdom
import { I18nProvider } from "@lingui/react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeAll, describe, expect, it } from "vitest";

import { getI18n, loadLocaleCatalog } from "../../../lib/i18n";
import { BBCodePreview } from "./BBCodePreview";

/* A saved About page is drawn for every visitor, so no source may crash it. */
describe("BBCodePreview on hostile nesting", () => {
  beforeAll(async () => {
    await loadLocaleCatalog("en");
  });

  const draw = (source: string) => renderToStaticMarkup(
    <I18nProvider i18n={getI18n("en")}>
      <BBCodePreview source={source} />
    </I18nProvider>,
  );

  it("draws 1,500 nested quotes", () => {
    expect(draw("[quote]".repeat(1500) + "deep" + "[/quote]".repeat(1500))).toContain("deep");
  });

  it("draws boxes nested inside box titles", () => {
    let source = "inner";
    for (let i = 0; i < 400; i += 1) source = `[box=${source}]body[/box]`;
    expect(draw(source)).toContain("body");
  });
});
