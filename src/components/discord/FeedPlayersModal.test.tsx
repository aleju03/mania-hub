// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { I18nProvider } from "@lingui/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { getI18n, loadLocaleCatalog } from "../../lib/i18n";

const roster: Record<string, Array<{ id: number; username: string; countryCode: string; pp: number; avatarUrl: string }>> = {
  TW: [{ id: 1, username: "tw_one", countryCode: "TW", pp: 20000, avatarUrl: "" }, { id: 2, username: "tw_two", countryCode: "TW", pp: 19000, avatarUrl: "" }],
  CN: [{ id: 3, username: "cn_one", countryCode: "CN", pp: 25000, avatarUrl: "" }, { id: 4, username: "cn_two", countryCode: "CN", pp: 24000, avatarUrl: "" }],
};

vi.mock("../../lib/live-backend", () => ({
  fetchLiveRosterPlayers: vi.fn(async (countries: string[]) => {
    const users = countries.flatMap((code) => roster[code] ?? []);
    return { users, total: users.length };
  }),
}));

const { FeedPlayersModal } = await import("./FeedPlayersModal");

beforeAll(async () => { await loadLocaleCatalog("en"); });
afterEach(() => cleanup());

function open(props: Partial<Parameters<typeof FeedPlayersModal>[0]> = {}) {
  const onSave = vi.fn();
  render(
    <I18nProvider i18n={getI18n("en")}>
      <FeedPlayersModal title="Players" players={[]} excluded={[]} mode="only" countries={[]} max={200} feedCountry="TW" onSave={onSave} onClose={() => {}} {...props} />
    </I18nProvider>,
  );
  return onSave;
}

const flush = () => act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
const row = (name: string) => screen.getByRole("checkbox", { name: new RegExp(name) });

describe("feed players window", () => {
  it("takes a country whole and leaves a player out of it", async () => {
    const onSave = open();
    await flush();
    expect(row("Everyone in Taiwan").getAttribute("aria-checked")).toBe("true");
    expect(row("tw_one").getAttribute("aria-checked")).toBe("true");
    fireEvent.click(row("tw_two"));
    expect(screen.getByText("Everyone in TW except 1 player.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(onSave).toHaveBeenCalledWith(expect.objectContaining({ mode: "mix", countries: [], players: [], excluded: [expect.objectContaining({ id: 2 })] }));
  });

  it("keeps a whole country and adds picked players from another", async () => {
    const onSave = open({ players: [{ id: 3, username: "cn_one", avatarUrl: null, countryCode: "CN" }], mode: "mix" });
    await flush();
    fireEvent.click(screen.getByRole("button", { name: /China/ }));
    await flush();
    expect(row("Everyone in China").getAttribute("aria-checked")).toBe("false");
    expect(row("cn_one").getAttribute("aria-checked")).toBe("true");
    fireEvent.click(row("cn_two"));
    expect(screen.getByText("Everyone in TW, plus 2 more players.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(onSave).toHaveBeenCalledWith(expect.objectContaining({ mode: "mix", countries: [], players: [expect.objectContaining({ id: 3 }), expect.objectContaining({ id: 4 })], excluded: [] }));
  });

  it("saves only the picked players once no country is taken whole", async () => {
    const onSave = open({ players: [{ id: 3, username: "cn_one", avatarUrl: null, countryCode: "CN" }], mode: "mix" });
    await flush();
    fireEvent.click(row("Everyone in Taiwan"));
    expect(screen.getByText("Only the 1 picked player.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(onSave).toHaveBeenCalledWith(expect.objectContaining({ mode: "only", countries: [], players: [expect.objectContaining({ id: 3 })] }));
  });

  it("reads an older only-these list as picked players with no whole country", async () => {
    open({ players: [{ id: 3, username: "cn_one", avatarUrl: null, countryCode: "CN" }], mode: "only" });
    await flush();
    expect(screen.queryByRole("button", { name: /Taiwan/ })).toBeNull();
    expect(row("cn_one").getAttribute("aria-checked")).toBe("true");
    expect(row("Everyone in China").getAttribute("aria-checked")).toBe("false");
  });
});
