// @vitest-environment jsdom
import { render } from "@testing-library/react";
import { afterEach, describe, expect, test } from "vitest";

import { acquireBodyScrollLock, resetBodyScrollLockForTests, useBodyScrollLock } from "./use-body-scroll-lock";

function Modal({ open }: { open: boolean }) {
  useBodyScrollLock(open);
  return null;
}

afterEach(() => {
  resetBodyScrollLockForTests();
  document.body.style.overflow = "";
  document.body.style.paddingRight = "";
});

describe("useBodyScrollLock", () => {
  test("locks while active and restores the page styles on release", () => {
    const view = render(<Modal open />);
    expect(document.body.style.overflow).toBe("hidden");
    view.rerender(<Modal open={false} />);
    expect(document.body.style.overflow).toBe("");
  });

  test("a handoff between two modals leaves the page scrollable", () => {
    // The skins settings modal closes and opens the preview editor in one tick,
    // so the editor's lock is taken while the settings lock still holds. The
    // page has to come back when the last of them lets go, not the first.
    const settings = render(<Modal open />);
    const editor = render(<Modal open />);
    settings.rerender(<Modal open={false} />);
    expect(document.body.style.overflow).toBe("hidden");
    editor.rerender(<Modal open={false} />);
    expect(document.body.style.overflow).toBe("");
  });

  test("unmounting a locked modal releases its lock", () => {
    const view = render(<Modal open />);
    view.unmount();
    expect(document.body.style.overflow).toBe("");
  });

  test("preserves an overflow the page itself set", () => {
    document.body.style.overflow = "clip";
    const view = render(<Modal open />);
    expect(document.body.style.overflow).toBe("hidden");
    view.rerender(<Modal open={false} />);
    expect(document.body.style.overflow).toBe("clip");
  });

  test("releasing the same lock twice cannot unbalance the count", () => {
    const releaseFirst = acquireBodyScrollLock();
    const releaseSecond = acquireBodyScrollLock();
    releaseFirst();
    releaseFirst();
    expect(document.body.style.overflow).toBe("hidden");
    releaseSecond();
    expect(document.body.style.overflow).toBe("");
  });
});
