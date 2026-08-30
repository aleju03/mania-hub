import { describe, expect, it } from "vitest";

import { bugReportThreadMessages } from "./bug-reports";

describe("bug report thread compatibility", () => {
  it("uses the append-only messages when the backend supplies them", () => {
    const messages = [{ id: "m1", author: "reporter" as const, body: "More detail", createdAt: 2, editedAt: null }];
    expect(bugReportThreadMessages({
      messages,
      reply: "Old compatibility value",
      repliedAt: 1,
    })).toBe(messages);
  });

  it("turns an old single admin reply into a temporary thread message", () => {
    expect(bugReportThreadMessages({
      messages: [],
      reply: "Please try again now.",
      repliedAt: 123,
    })).toEqual([{
      id: "legacy-admin-reply",
      author: "admin",
      body: "Please try again now.",
      createdAt: 123,
      editedAt: null,
    }]);
  });
});
