// @vitest-environment jsdom
/* The hint only ever decides how much space the shelf holds while it loads, so
   what matters is that it never holds the wrong shape: not another account's,
   and not more than a shelf can carry. */
import { beforeEach, expect, it } from "vitest";
import {
  PACK_SHOWCASE_SLOTS_COOKIE_NAME,
  parsePackShowcaseSlots,
  readPackShowcaseSlotsClient,
  writePackShowcaseSlotsClient,
} from "./pack-showcase";

beforeEach(() => {
  document.cookie = `${PACK_SHOWCASE_SLOTS_COOKIE_NAME}=; Path=/; Max-Age=0`;
});

it("reads back what it wrote for the same viewer", () => {
  writePackShowcaseSlotsClient(7095193, 3);
  expect(readPackShowcaseSlotsClient(7095193)).toBe(3);
});

it("reserves nothing for a viewer it has not seen", () => {
  writePackShowcaseSlotsClient(7095193, 3);
  expect(readPackShowcaseSlotsClient(14149970)).toBe(0);
});

it("reserves nothing before anything has been written", () => {
  expect(readPackShowcaseSlotsClient(7095193)).toBe(0);
});

it("holds a shelf's worth at most, and never a negative one", () => {
  writePackShowcaseSlotsClient(7095193, 900);
  expect(readPackShowcaseSlotsClient(7095193)).toBe(5);
  writePackShowcaseSlotsClient(7095193, -4);
  expect(readPackShowcaseSlotsClient(7095193)).toBe(0);
});

it("reads the same value out of a request's cookie header", () => {
  const header = `mania-hub-country=CR; ${PACK_SHOWCASE_SLOTS_COOKIE_NAME}=7095193.2; mania-hub-theme-v1=200`;
  expect(parsePackShowcaseSlots(header, 7095193)).toBe(2);
  expect(parsePackShowcaseSlots(header, 999)).toBe(0);
  expect(parsePackShowcaseSlots(null, 7095193)).toBe(0);
});

it("ignores a cookie that is not the shape it writes", () => {
  expect(parsePackShowcaseSlots(`${PACK_SHOWCASE_SLOTS_COOKIE_NAME}=oh-no`, 7095193)).toBe(0);
  expect(parsePackShowcaseSlots(`${PACK_SHOWCASE_SLOTS_COOKIE_NAME}=7095193`, 7095193)).toBe(0);
});

it("is not fooled by a cookie whose name ends with the same word", () => {
  const header = `not-mania-hub-showcase-slots=999.5; ${PACK_SHOWCASE_SLOTS_COOKIE_NAME}=7095193.1`;
  expect(parsePackShowcaseSlots(header, 7095193)).toBe(1);
  expect(parsePackShowcaseSlots("not-mania-hub-showcase-slots=7095193.5", 7095193)).toBe(0);
});
