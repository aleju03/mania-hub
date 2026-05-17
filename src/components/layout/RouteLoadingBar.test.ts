import { describe, expect, it } from "vitest";

import { shouldShowRouteLoadingBar } from "./RouteLoadingBar";

const location = (href: string) => {
  const url = new URL(href, "https://mania.local");
  return {
    pathname: url.pathname,
    searchStr: url.search,
  };
};

describe("route loading bar visibility", () => {
  it("suppresses replay tab-only navigations", () => {
    expect(shouldShowRouteLoadingBar(
      true,
      location("/replay?tab=beatmap"),
      location("/replay"),
    )).toBe(false);
  });

  it("still shows when opening a replay score", () => {
    expect(shouldShowRouteLoadingBar(
      true,
      location("/replay?scoreId=123"),
      location("/replay"),
    )).toBe(true);
  });

  it("suppresses maps filter navigations in the same country", () => {
    expect(shouldShowRouteLoadingBar(
      true,
      location("/maps?country=CR&tab=random&rKey=4k"),
      location("/maps?country=CR&tab=random"),
    )).toBe(false);
  });

  it("still shows when changing maps country", () => {
    expect(shouldShowRouteLoadingBar(
      true,
      location("/maps?country=JP"),
      location("/maps?country=CR"),
    )).toBe(true);
  });

  it("suppresses tracker filter and page reset navigations in the same country", () => {
    expect(shouldShowRouteLoadingBar(
      true,
      location("/tracker?country=CR"),
      location("/tracker?country=CR&page=2"),
    )).toBe(false);
  });

  it("still shows when changing tracker country", () => {
    expect(shouldShowRouteLoadingBar(
      true,
      location("/tracker?country=JP"),
      location("/tracker?country=CR"),
    )).toBe(true);
  });

  it("suppresses top plays range navigations in the same country", () => {
    expect(shouldShowRouteLoadingBar(
      true,
      location("/top-plays?country=CR&range=3d"),
      location("/top-plays?country=CR&range=24h"),
    )).toBe(false);
  });

  it("still shows when changing top plays country", () => {
    expect(shouldShowRouteLoadingBar(
      true,
      location("/top-plays?country=JP&range=3d"),
      location("/top-plays?country=CR&range=3d"),
    )).toBe(true);
  });

  it("still shows for real page changes", () => {
    expect(shouldShowRouteLoadingBar(
      true,
      location("/maps"),
      location("/replay"),
    )).toBe(true);
  });
});
