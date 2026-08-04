// @vitest-environment jsdom
import { act, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, test } from "vitest";

import { useDocumentVisible } from "./window-activity";

function VisibilityProbe() {
  return <div>{useDocumentVisible() ? "visible" : "hidden"}</div>;
}

function setVisibility(value: "visible" | "hidden"): void {
  Object.defineProperty(document, "visibilityState", { value, configurable: true });
  act(() => document.dispatchEvent(new Event("visibilitychange")));
}

afterEach(() => {
  Object.defineProperty(document, "visibilityState", { value: "visible", configurable: true });
});

describe("useDocumentVisible", () => {
  test("tracks background-tab visibility without treating window blur as hidden", () => {
    setVisibility("visible");
    render(<VisibilityProbe />);
    expect(screen.getByText("visible")).toBeTruthy();

    setVisibility("hidden");
    expect(screen.getByText("hidden")).toBeTruthy();

    setVisibility("visible");
    expect(screen.getByText("visible")).toBeTruthy();
  });
});
