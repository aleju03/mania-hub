// @vitest-environment jsdom
import type { ReactNode } from "react";
import { fireEvent, render, waitFor } from "@testing-library/react";
import { I18nProvider } from "@lingui/react";
import { describe, expect, it, vi } from "vitest";

import { getI18n } from "../../lib/i18n";
import { SkillsUntrackedNotice } from "./SkillsUntrackedNotice";

vi.mock("../me/TrackingToasts", () => ({ showTrackingStartedToast: vi.fn() }));

function withI18n(node: ReactNode) {
  return <I18nProvider i18n={getI18n("en")}>{node}</I18nProvider>;
}

describe("SkillsUntrackedNotice", () => {
  it("only offers the tracking action to the profile owner", () => {
    const view = render(withI18n(<SkillsUntrackedNotice username="OtherPlayer" isOwner={false} />));

    expect(view.getByText(/OtherPlayer isn't tracked/)).toBeTruthy();
    expect(view.queryByRole("button", { name: "Track my plays" })).toBeNull();
  });

  it("lets the owner turn tracking on from the Skills tab", async () => {
    const performAction = vi.fn(async () => ({ ok: true, status: "added" as const, country: "CR" }));
    const onTracked = vi.fn();
    const view = render(withI18n(
      <SkillsUntrackedNotice
        username="Owner"
        isOwner
        performAction={performAction}
        onTracked={onTracked}
      />,
    ));

    expect(view.getByText(/Signing in does not start tracking/)).toBeTruthy();
    fireEvent.click(view.getByRole("button", { name: "Track my plays" }));

    await waitFor(() => expect(onTracked).toHaveBeenCalledOnce());
    expect(performAction).toHaveBeenCalledOnce();
    expect(view.getByText(/Tracking is on/)).toBeTruthy();
    expect(view.queryByRole("button", { name: "Track my plays" })).toBeNull();
  });
});
