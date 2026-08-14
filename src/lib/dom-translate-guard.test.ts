// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";

import { installDomTranslateGuard } from "./dom-translate-guard";

vi.mock("./analytics", () => ({ track: vi.fn() }));
const { track } = await import("./analytics");

describe("installDomTranslateGuard", () => {
  beforeEach(() => {
    vi.mocked(track).mockClear();
    installDomTranslateGuard();
  });

  it("leaves normal removeChild and insertBefore behavior intact", () => {
    const parent = document.createElement("div");
    const a = document.createElement("span");
    const b = document.createElement("span");
    parent.appendChild(b);
    parent.insertBefore(a, b);
    expect([...parent.childNodes]).toEqual([a, b]);
    parent.removeChild(a);
    expect([...parent.childNodes]).toEqual([b]);
    expect(track).not.toHaveBeenCalled();
  });

  it("turns removeChild of a foreign node into a no-op instead of throwing", () => {
    const parent = document.createElement("div");
    const stolen = document.createElement("span");
    document.body.appendChild(stolen);
    expect(parent.removeChild(stolen)).toBe(stolen);
    expect(stolen.parentNode).toBe(document.body);
    expect(track).toHaveBeenCalledWith(
      "dom_translate_conflict",
      expect.objectContaining({ op: "removeChild" }),
    );
  });

  it("appends instead of throwing when insertBefore's reference node was moved", () => {
    const parent = document.createElement("div");
    const existing = document.createElement("span");
    parent.appendChild(existing);
    const movedReference = document.createElement("font");
    document.body.appendChild(movedReference);
    const added = document.createElement("span");
    expect(parent.insertBefore(added, movedReference)).toBe(added);
    expect([...parent.childNodes]).toEqual([existing, added]);
    expect(track).toHaveBeenCalledWith(
      "dom_translate_conflict",
      expect.objectContaining({ op: "insertBefore" }),
    );
  });

  it("caps conflict reports per page load", () => {
    const parent = document.createElement("div");
    for (let i = 0; i < 10; i++) {
      const stray = document.createElement("span");
      document.body.appendChild(stray);
      parent.removeChild(stray);
    }
    expect(vi.mocked(track).mock.calls.length).toBeLessThanOrEqual(3);
  });
});
