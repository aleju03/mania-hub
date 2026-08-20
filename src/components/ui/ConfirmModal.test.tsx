// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ConfirmModal } from "./ConfirmModal";
import { resetBodyScrollLockForTests } from "../../lib/use-body-scroll-lock";

/* This replaced window.confirm on actions that break something for real - a
   rotated signature token stops every image a player already pasted. So the
   two things worth pinning are that the action only ever fires on the confirm
   button, and that every way out of the dialog is a way out without it. */

afterEach(() => {
  cleanup();
  resetBodyScrollLockForTests();
});

function setup(overrides: Partial<Parameters<typeof ConfirmModal>[0]> = {}) {
  const onConfirm = vi.fn();
  const onClose = vi.fn();
  render(
    <ConfirmModal
      title="Make a new link?"
      body="Every image you have already pasted will stop working."
      confirmLabel="Make a new link"
      onConfirm={onConfirm}
      onClose={onClose}
      {...overrides}
    />,
  );
  return { onConfirm, onClose };
}

describe("ConfirmModal", () => {
  it("runs the action and closes on the confirm button", () => {
    const { onConfirm, onClose } = setup();
    fireEvent.click(screen.getByRole("button", { name: "Make a new link" }));
    expect(onConfirm).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("closes without acting on cancel, escape, or the backdrop", () => {
    for (const dismiss of [
      () => fireEvent.click(screen.getByRole("button", { name: "Cancel" })),
      () => fireEvent.keyDown(window, { key: "Escape" }),
      () => fireEvent.click(screen.getByRole("dialog")),
    ]) {
      const { onConfirm, onClose } = setup();
      dismiss();
      expect(onConfirm).not.toHaveBeenCalled();
      expect(onClose).toHaveBeenCalledTimes(1);
      cleanup();
    }
  });

  /* window.confirm puts the focus on OK, so a stray Enter is destructive. The
     whole point of replacing it is that the safe answer is the default one. */
  it("opens with the focus on cancel rather than on the action", () => {
    setup();
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Cancel" }));
  });

  it("says which button is the destructive one", () => {
    setup({ danger: true, confirmLabel: "Block" });
    expect(screen.getByRole("button", { name: "Block" }).className).toContain("osu-red-light");
  });
});
