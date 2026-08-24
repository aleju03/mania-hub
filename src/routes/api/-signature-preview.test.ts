import { describe, expect, it } from "vitest";

import { resolveSignaturePreviewTarget } from "./signature-preview";

const viewer = { id: 1, username: "viewer" };

describe("signature preview target", () => {
  it("keeps ordinary previews on the signed-in viewer", () => {
    expect(resolveSignaturePreviewTarget(viewer, false, {})).toEqual({
      userId: 1,
      username: "viewer",
    });
  });

  it("refuses another player for a non-admin", () => {
    expect(resolveSignaturePreviewTarget(viewer, false, {
      targetUserId: 2,
      targetUsername: "other",
    })).toEqual({ status: 403 });
  });

  it("allows a valid admin target and trims its display name", () => {
    expect(resolveSignaturePreviewTarget(viewer, true, {
      targetUserId: 2,
      targetUsername: "  other  ",
    })).toEqual({ userId: 2, username: "other" });
  });

  it("rejects incomplete or invalid admin targets", () => {
    expect(resolveSignaturePreviewTarget(viewer, true, { targetUserId: 2 })).toEqual({ status: 400 });
    expect(resolveSignaturePreviewTarget(viewer, true, {
      targetUserId: 0,
      targetUsername: "other",
    })).toEqual({ status: 400 });
  });
});
