import { describe, expect, it } from "vitest";

import { ACCOUNT_DRAFTS_MAX, deleteAccountDraft, isFramePictureUrl, listAccountDrafts, loadAccountDraft, saveAccountDraft, type DraftStore } from "./frame-drafts-server";

function memoryStore(): DraftStore & { files: Map<string, Buffer> } {
  const files = new Map<string, Buffer>();
  return {
    files,
    get: async (user, file) => files.get(`${user}/${file}`) ?? null,
    put: async (user, file, body) => {
      files.set(`${user}/${file}`, body);
      return true;
    },
    remove: async (user, file) => {
      files.delete(`${user}/${file}`);
    },
  };
}

const draft = (id: string, updatedAt: number, body = "{}") => ({ id, name: `draft ${id}`, updatedAt, thumb: null, submitted: null, body });

describe("account frame drafts", () => {
  it("saves, lists newest first, loads and deletes a player's drafts", async () => {
    const store = memoryStore();
    expect(await saveAccountDraft(7, draft("dabcde1", 10, "one"), store)).toEqual({ ok: true });
    expect(await saveAccountDraft(7, { ...draft("dabcde2", 20, "two"), submitted: "u12" }, store)).toEqual({ ok: true });
    expect((await listAccountDrafts(7, store)).map((entry) => [entry.id, entry.submitted])).toEqual([["dabcde2", "u12"], ["dabcde1", null]]);
    expect(await loadAccountDraft(7, "dabcde1", store)).toBe("one");
    // another player sees none of them
    expect(await listAccountDrafts(8, store)).toEqual([]);
    expect(await loadAccountDraft(8, "dabcde1", store)).toBeNull();
    await deleteAccountDraft(7, "dabcde1", store);
    expect((await listAccountDrafts(7, store)).map((entry) => entry.id)).toEqual(["dabcde2"]);
    expect(await loadAccountDraft(7, "dabcde1", store)).toBeNull();
  });

  it("keeps the newer copy, caps the count and refuses bad ids", async () => {
    const store = memoryStore();
    await saveAccountDraft(7, draft("dabcde1", 50, "new"), store);
    expect(await saveAccountDraft(7, draft("dabcde1", 40, "old"), store)).toEqual({ ok: false, error: "stale" });
    expect(await loadAccountDraft(7, "dabcde1", store)).toBe("new");
    for (let i = 2; i <= ACCOUNT_DRAFTS_MAX; i++) await saveAccountDraft(7, draft(`dabcde${i}`, i), store);
    expect(await saveAccountDraft(7, draft("dzzzzzz", 99), store)).toEqual({ ok: false, error: "full" });
    // an existing one still saves at the cap
    expect(await saveAccountDraft(7, draft("dabcde2", 100), store)).toEqual({ ok: true });
    expect(await saveAccountDraft(7, draft("../index", 1), store)).toEqual({ ok: false, error: "invalid" });
    expect(await loadAccountDraft(7, "../../x", store)).toBeNull();
  });

  it("only fetches the workshop's own frame pictures", () => {
    expect(isFramePictureUrl(`https://cdn.mania-tracker.com/frames/${"a".repeat(64)}.png`)).toBe(true);
    expect(isFramePictureUrl("https://example.com/frames/a.png")).toBe(false);
    expect(isFramePictureUrl(`http://cdn.mania-tracker.com/frames/${"a".repeat(64)}.png`)).toBe(false);
  });
});
