import { describe, expect, it } from "vitest";
import { isStaleRouteModuleMessage } from "./stale-route-error";

describe("isStaleRouteModuleMessage", () => {
  // Verbatim messages from route_error analytics rows.
  it.each([
    "TypeError Cannot read properties of undefined (reading 'component')",
    "TypeError Cannot read properties of undefined (reading 'default')",
    'TypeError can\'t access property "component", d is undefined',
  ])("recognises %s", (message) => {
    expect(isStaleRouteModuleMessage(message)).toBe(true);
  });

  it.each([
    "TypeError: Cannot read property 'component' of undefined",
    'TypeError: can\'t access property "default", n is null',
    "TypeError: undefined is not an object (evaluating 'd.component')",
  ])("recognises the other engines' wording of %s", (message) => {
    expect(isStaleRouteModuleMessage(message)).toBe(true);
  });

  it.each([
    "TypeError Cannot read properties of undefined (reading 'bytes')",
    "NotFoundError Failed to execute 'insertBefore' on 'Node': The node before which the new node is to be inserted is not a child of this node.",
    "TypeError Cannot read properties of undefined (reading 'componentDidCatch')",
    "TypeError user.component is not a function",
  ])("leaves %s alone", (message) => {
    expect(isStaleRouteModuleMessage(message)).toBe(false);
  });
});
