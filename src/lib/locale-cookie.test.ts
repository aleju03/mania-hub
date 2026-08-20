import { describe, expect, it } from "vitest";
import {
  parseLocaleCookieHeader,
  hasLocaleCookieHeader,
  resolveLocaleFromAcceptLanguage,
} from "./locale-cookie";
import { normalizeLocale } from "./locale";

describe("normalizeLocale", () => {
  it("maps every Chinese tag to the one Chinese catalog the site has", () => {
    expect(normalizeLocale("zh")).toBe("zh-CN");
    expect(normalizeLocale("zh-CN")).toBe("zh-CN");
    expect(normalizeLocale("zh-Hans")).toBe("zh-CN");
    expect(normalizeLocale("zh-Hant-TW")).toBe("zh-CN");
    expect(normalizeLocale("ZH-cn")).toBe("zh-CN");
  });

  it("maps English variants to en and everything else to null", () => {
    expect(normalizeLocale("en")).toBe("en");
    expect(normalizeLocale("en-GB")).toBe("en");
    expect(normalizeLocale("es")).toBeNull();
    expect(normalizeLocale("")).toBeNull();
    expect(normalizeLocale(null)).toBeNull();
    // "english" is not en: prefix matching stops at the subtag boundary.
    expect(normalizeLocale("english")).toBeNull();
  });
});

describe("parseLocaleCookieHeader", () => {
  it("finds the cookie among others and normalizes its value", () => {
    expect(parseLocaleCookieHeader("mania-hub-country=CR; mania-hub-locale=zh-CN")).toBe("zh-CN");
    expect(parseLocaleCookieHeader("mania-hub-locale=en")).toBe("en");
  });

  it("returns null for a missing cookie so detection can run", () => {
    expect(parseLocaleCookieHeader("mania-hub-country=CR")).toBeNull();
    expect(parseLocaleCookieHeader(null)).toBeNull();
  });

  it("returns null for unsupported or mangled values rather than guessing", () => {
    expect(parseLocaleCookieHeader("mania-hub-locale=fr")).toBeNull();
    expect(parseLocaleCookieHeader("mania-hub-locale=%")).toBeNull();
  });
});

describe("hasLocaleCookieHeader", () => {
  // The cache middleware keys on presence, not validity: a request carrying
  // any locale cookie was already given its Set-Cookie and is safe to cache.
  it("reports presence even when the value is junk", () => {
    expect(hasLocaleCookieHeader("mania-hub-locale=fr")).toBe(true);
    expect(hasLocaleCookieHeader("mania-hub-locale=zh-CN")).toBe(true);
    expect(hasLocaleCookieHeader("mania-hub-country=CR")).toBe(false);
    expect(hasLocaleCookieHeader(null)).toBe(false);
  });
});

describe("resolveLocaleFromAcceptLanguage", () => {
  it("picks the first supported tag in browser order", () => {
    expect(resolveLocaleFromAcceptLanguage("zh-CN,zh;q=0.9,en;q=0.8")).toBe("zh-CN");
    expect(resolveLocaleFromAcceptLanguage("en-US,en;q=0.9,zh;q=0.8")).toBe("en");
    expect(resolveLocaleFromAcceptLanguage("zh-TW,en;q=0.9")).toBe("zh-CN");
  });

  it("skips unsupported tags instead of defaulting on them", () => {
    expect(resolveLocaleFromAcceptLanguage("fr-FR,fr;q=0.9,zh;q=0.5")).toBe("zh-CN");
    expect(resolveLocaleFromAcceptLanguage("es-419,pt;q=0.9")).toBe("en");
  });

  it("defaults to en on empty, wildcard or missing headers", () => {
    expect(resolveLocaleFromAcceptLanguage(null)).toBe("en");
    expect(resolveLocaleFromAcceptLanguage("")).toBe("en");
    expect(resolveLocaleFromAcceptLanguage("*")).toBe("en");
  });
});
