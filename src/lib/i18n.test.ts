import { describe, expect, it } from "vitest";
import { msg } from "@lingui/core/macro";
import { getI18n } from "./i18n";

// This file doubles as the macro canary for plain .ts (no JSX): the `msg`
// macro below only works if the babel pass in vitest.config.ts (and by the
// same plugin-react include filter, vite.config.ts) transforms .ts files.
// If this file fails to parse or `descriptor.id` is undefined, the macro
// wiring broke.
const descriptor = msg`i18n canary message`;
const requestedUiCopy = {
  settings: msg`Settings`,
  qualified: msg`Qualified`,
  loved: msg`Loved`,
  graveyard: msg`Graveyard`,
  tournament: msg`Tournament`,
  other: msg`Other`,
  skills: msg`Skills`,
  randomPickFrom: msg`random pick from`,
  drawInstruction: msg`Tap the stack or drag the top card to draw`,
};

describe("lingui macro on plain .ts", () => {
  it("compiles msg descriptors outside JSX", () => {
    expect(descriptor.id).toBeTruthy();
    expect(descriptor.message).toBe("i18n canary message");
  });

  it("resolves through per-locale instances with source-string fallback", () => {
    const en = getI18n("en");
    expect(en._(descriptor)).toBe("i18n canary message");
    // New translated locales have no translation for the canary; the source string must come
    // back rather than an id or an empty string.
    const zh = getI18n("zh-CN");
    const es = getI18n("es");
    expect(zh._(descriptor)).toBe("i18n canary message");
    expect(es._(descriptor)).toBe("i18n canary message");
  });

  it("returns the same shared instance per locale", () => {
    expect(getI18n("en")).toBe(getI18n("en"));
    expect(getI18n("zh-CN")).not.toBe(getI18n("en"));
    expect(getI18n("es")).not.toBe(getI18n("en"));
  });

  it("ships the requested maps, packs, navigation, and profile copy in both catalogs", () => {
    const es = getI18n("es");
    const zh = getI18n("zh-CN");

    expect(Object.fromEntries(Object.entries(requestedUiCopy).map(([key, value]) => [key, es._(value)]))).toEqual({
      settings: "Ajustes",
      qualified: "Calificado",
      loved: "Amado",
      graveyard: "Abandonado",
      tournament: "Torneo",
      other: "Otro",
      skills: "Skills",
      randomPickFrom: "Pick de",
      drawInstruction: "Toca las cartas o arrastra la de arriba para sacar una",
    });
    expect(Object.fromEntries(Object.entries(requestedUiCopy).map(([key, value]) => [key, zh._(value)]))).toEqual({
      settings: "设置",
      qualified: "过审",
      loved: "社区喜爱",
      graveyard: "坟场",
      tournament: "比赛",
      other: "其他",
      skills: "技能",
      randomPickFrom: "随机抽取自",
      drawInstruction: "点击卡堆，或拖走最上面的卡片来抽卡",
    });
  });
});
