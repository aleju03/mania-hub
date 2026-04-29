import { describe, expect, it, vi } from "vitest";
import { withTimeout } from "./promise-timeout";

describe("withTimeout", () => {
  it("rejects when the promise does not settle before the timeout", async () => {
    vi.useFakeTimers();
    const pending = new Promise<string>(() => {});
    const timed = withTimeout(pending, 250, "renderer startup timed out");
    const assertion = expect(timed).rejects.toThrow("renderer startup timed out");

    await vi.advanceTimersByTimeAsync(250);

    await assertion;
    vi.useRealTimers();
  });
});
