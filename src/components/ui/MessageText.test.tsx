// @vitest-environment jsdom
import { cleanup, render } from "@testing-library/react";
import type { ReactNode } from "react";
import { I18nProvider } from "@lingui/react";
import { afterEach, describe, expect, it } from "vitest";

import { getI18n } from "../../lib/i18n";
import { MessageText } from "./MessageText";

const wrapper = ({ children }: { children: ReactNode }) => (
  <I18nProvider i18n={getI18n("en")}>{children}</I18nProvider>
);

afterEach(cleanup);

describe("MessageText code", () => {
  it("renders fenced and inline code verbatim, without links or embeds", () => {
    const text = "Request:\n```sh\ncurl https://example.com/a.png\n```\nUse `userId` and see https://example.com";
    const { container } = render(<p><MessageText text={text} /></p>, { wrapper });
    const codes = [...container.querySelectorAll("code")].map((node) => node.textContent);
    expect(codes).toEqual(["curl https://example.com/a.png", "userId"]);
    const links = [...container.querySelectorAll("a")].map((node) => node.getAttribute("href"));
    expect(links).toEqual(["https://example.com"]);
    expect(container.querySelector("img")).toBeNull();
    expect(container.querySelector("p pre, p div")).toBeNull();
  });
});
