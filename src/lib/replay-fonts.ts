import type { ReplayComboFontStyle } from "./replay-skin";

export const REPLAY_FONT_STYLESHEET = "https://fonts.googleapis.com/css2?family=Baloo+2:wght@800&family=Comic+Neue:ital,wght@1,700&family=Fredoka:wght@700&family=Knewave&family=Lato:wght@600;700&family=Noto+Sans:ital,wght@0,600;1,800&family=Nunito:wght@800&family=Open+Sans:ital,wght@1,800&family=PT+Sans:wght@400&family=Roboto+Condensed:wght@300&family=Roboto:wght@300;700&family=Source+Sans+3:wght@400&display=swap";
export const MAP_PLACEHOLDER_FONT_STYLESHEET = "https://fonts.googleapis.com/css2?family=Comic+Neue:ital,wght@1,700&display=swap";

const stylesheetRequests = new Map<string, Promise<void>>();
const fontRequests = new Map<string, Promise<void>>();

function loadFontStylesheet(href: string): Promise<void> {
  if (typeof document === "undefined") return Promise.resolve();
  const existing = stylesheetRequests.get(href);
  if (existing) return existing;
  const request = new Promise<void>((resolve, reject) => {
    const link = document.createElement("link");
    link.rel = "stylesheet";
    link.href = href;
    link.onload = () => resolve();
    link.onerror = () => {
      link.remove();
      reject(new Error("Could not load replay fonts."));
    };
    document.head.appendChild(link);
  }).catch((error) => {
    stylesheetRequests.delete(href);
    throw error;
  });
  stylesheetRequests.set(href, request);
  return request;
}

export function ensureReplayFontStylesheet(): Promise<void> {
  return loadFontStylesheet(REPLAY_FONT_STYLESHEET);
}

export function ensureMapPlaceholderFont(): void {
  // The full replay sheet already contains Comic Neue.
  if (stylesheetRequests.has(REPLAY_FONT_STYLESHEET)) return;
  void loadFontStylesheet(MAP_PLACEHOLDER_FONT_STYLESHEET).catch(() => {});
}

export function ensureReplayFontStyle(font: ReplayComboFontStyle): Promise<void> {
  if (typeof document === "undefined" || !document.fonts?.load) return Promise.resolve();
  const descriptor = `${font.style ?? "normal"} ${font.weight} 32px ${font.family}`;
  const existing = fontRequests.get(descriptor);
  if (existing) return existing;
  const external = /Fredoka|Baloo|Roboto|Knewave|PT Sans|Source Sans|Lato|Nunito|Open Sans|Noto Sans|Comic Neue/.test(font.family);
  // Canvas text doesn't trigger a web-font request. Wait for the stylesheet
  // registration before explicitly loading the face used by its combo counter.
  const request = (external ? ensureReplayFontStylesheet() : Promise.resolve())
    .then(() => document.fonts.load(descriptor, "0123456789x"))
    .then(() => undefined)
    .catch((error) => {
      fontRequests.delete(descriptor);
      throw error;
    });
  fontRequests.set(descriptor, request);
  return request;
}
