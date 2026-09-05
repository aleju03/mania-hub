// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "@lingui/react";
import { getI18n } from "../../lib/i18n";
import type { RevealedCard } from "./RevealStage";

vi.mock("@tanstack/react-router", () => ({
  Link: ({ children }: { children?: ReactNode }) => <a>{children}</a>,
}));

vi.mock("./CardSpotlight", () => ({
  CardSpotlight: () => null,
}));

vi.mock("./packSfx", () => ({
  playRecycleClink: vi.fn(),
}));

const { PackSummary } = await import("./PackSummary");

const card: RevealedCard = {
  player: {
    user: {
      id: 7,
      username: "player7",
      avatar_url: "https://a.ppy.sh/7",
      country_code: "CR",
      statistics: { global_rank: 7, pp: 12_000 },
    },
    globalRank: 7,
    pp: 12_000,
  },
  tier: "rare",
  tierLabel: "rare",
  glowColor: { r: 120, g: 80, b: 220, a: 1 },
  thumbnail: "data:image/webp;base64,front",
  skills: null,
  isNew: true,
};

afterEach(cleanup);

describe("PackSummary", () => {
  it("keeps the milestone card when recycling the rest of a pack", async () => {
    const milestone = {
      ...card,
      tier: "eternal" as const,
      player: { ...card.player, milestone: true, cardKey: "7:v1" },
    };
    const onRecycleCopies = vi.fn(() => 4);
    const { container } = render(
      <I18nProvider i18n={getI18n("en")}>
        <PackSummary cards={[card, milestone]} onOpenAnother={() => {}} onOpenNext={() => {}}
          canOpenNext={false} nextPackShardCost={null} serials={null}
          onRecycleCopies={onRecycleCopies} reducedMotion={true} />
      </I18nProvider>,
    );
    fireEvent.contextMenu(container.querySelector('[data-pull-index="1"]')!);
    expect(screen.getByText("Open profile")).toBeTruthy();
    expect(screen.queryByRole("menuitem", { name: /Recycle/ })).toBeNull();
    fireEvent.keyDown(window, { key: "Escape" });
    fireEvent.click(screen.getByRole("button", { name: "Recycle all +4" }));
    await waitFor(() => expect(onRecycleCopies).toHaveBeenCalledWith([{ cardKey: "7", copies: 1 }]));
    expect(container.querySelector('[data-pull-index="1"]')?.textContent).not.toContain("+250");
  });

  it("reserves pull-serial space before asynchronous mint details arrive", () => {
    // The summary uses <Trans>, which throws without a provider; en resolves
    // to the source strings, matching what this test asserts on.
    const { container, rerender } = render(
      <I18nProvider i18n={getI18n("en")}>
        <PackSummary
          cards={[card]}
          onOpenAnother={() => {}}
          onOpenNext={() => {}}
          canOpenNext={false}
          nextPackShardCost={null}
          serials={null}
          onRecycleCopies={() => 0}
          reducedMotion={true}
        />
      </I18nProvider>,
    );

    const emptySlot = container.querySelector('[data-pull-serial-slot="0"]');
    expect(emptySlot?.classList.contains("min-h-8")).toBe(true);
    expect(emptySlot?.textContent).toBe("");

    rerender(
      <I18nProvider i18n={getI18n("en")}>
        <PackSummary
          cards={[card]}
          onOpenAnother={() => {}}
          onOpenNext={() => {}}
          canOpenNext={false}
          nextPackShardCost={null}
          serials={new Map([["7", { serial: 3, mintedTotal: 8, isFirstGlobal: false }]])}
          onRecycleCopies={() => 0}
          reducedMotion={true}
        />
      </I18nProvider>,
    );

    const filledSlot = container.querySelector('[data-pull-serial-slot="0"]');
    expect(filledSlot?.classList.contains("min-h-8")).toBe(true);
    expect(filledSlot?.textContent).toBe("3rd of 8 to pull this");
  });

  it("lands cut cards at their recycled size before auto-recycling resolves", () => {
    const { container } = render(
      <I18nProvider i18n={getI18n("en")}>
        <PackSummary
          cards={[card]}
          onOpenAnother={() => {}}
          onOpenNext={() => {}}
          canOpenNext={false}
          nextPackShardCost={null}
          serials={null}
          onRecycleCopies={() => new Promise<number>(() => {})}
          damage={{ path: [0.45, 0.5, 0.55] }}
          reducedMotion={true}
        />
      </I18nProvider>,
    );

    const tile = container.querySelector('[data-pull-index="0"]');
    expect(tile?.classList.contains("scale-[0.94]")).toBe(true);
    expect((tile as HTMLElement | null)?.style.boxShadow).toBe("inset 0 0 0 1px rgba(148, 163, 184, 0.16)");
  });
});
