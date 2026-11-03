import { describe, expect, it } from "vitest";

import { splitCode } from "./code-fences";

describe("splitCode", () => {
  it("leaves text without code alone", () => {
    expect(splitCode("just words")).toEqual([{ kind: "text", text: "just words" }]);
  });

  it("splits a fenced block with a language and drops the breaks around it", () => {
    expect(splitCode("Send this:\n```sh\ncurl -H \"x\" url\n```\nThanks")).toEqual([
      { kind: "text", text: "Send this:" },
      { kind: "block", code: "curl -H \"x\" url", lang: "sh" },
      { kind: "text", text: "Thanks" },
    ]);
  });

  it("keeps the first line when it is code, not a language", () => {
    expect(splitCode("```{ \"a\": 1 }\n{ \"b\": 2 }```")).toEqual([
      { kind: "block", code: "{ \"a\": 1 }\n{ \"b\": 2 }", lang: null },
    ]);
    expect(splitCode("```GET /x```")).toEqual([{ kind: "block", code: "GET /x", lang: null }]);
  });

  it("reads inline code outside blocks and leaves an unclosed fence as text", () => {
    expect(splitCode("use `userId` here")).toEqual([
      { kind: "text", text: "use " },
      { kind: "inline", code: "userId" },
      { kind: "text", text: " here" },
    ]);
    expect(splitCode("```\nunclosed")).toEqual([{ kind: "text", text: "```\nunclosed" }]);
  });
});
