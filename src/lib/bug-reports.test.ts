import { describe, expect, it } from "vitest";

import { bugReportSeenReceipt, bugReportThreadMessages } from "./bug-reports";

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
      // Both sides' screenshot shapes, so the synthetic row reads as either.
      screenshotKeys: [],
      screenshotCount: 0,
    }]);
  });
});

it("acknowledges only the reporter messages in the displayed snapshot", () => {
  const message = { body: "Text", createdAt: 123, editedAt: null, screenshotKeys: [] };
  expect(bugReportSeenReceipt({
    id: "report",
    messages: [
      { ...message, id: "m1", author: "reporter" },
      { ...message, id: "m2", author: "admin" },
      { ...message, id: "m3", author: "reporter" },
    ],
  })).toEqual({ id: "report", reporterMessageCount: 2 });
});
