import { setupI18n, type I18n, type Messages } from "@lingui/core";
import { type AppLocale, DEFAULT_LOCALE } from "./locale";

// One immutable I18n instance per locale, shared by every render that wants
// that locale. This is what makes SSR safe without per-request instances: the
// global `i18n` singleton from @lingui/core is mutable (activate() mid-render
// of a concurrent request would leak its locale into another request's tree),
// so nothing in src may import it - a guard test enforces that - and these
// instances are never activate()d or loaded into after creation.
const instances = new Map<AppLocale, I18n>();

const registry = new Map<AppLocale, Messages>();

// The client only ever needs the visitor's one locale, so catalogs load
// through dynamic imports and stay out of the main bundle. The server
// registers every catalog eagerly below - bundle size is irrelevant there and
// concurrent requests need all locales at once.
const loaders: Record<AppLocale, () => Promise<{ messages: Messages }>> = {
  en: () => import("../locales/en/messages"),
  "zh-CN": () => import("../locales/zh-CN/messages"),
};

if (import.meta.env.SSR) {
  const { messages: en } = await import("../locales/en/messages");
  const { messages: zhCN } = await import("../locales/zh-CN/messages");
  registry.set("en", en);
  registry.set("zh-CN", zhCN);
}

export async function loadLocaleCatalog(locale: AppLocale): Promise<void> {
  if (registry.has(locale)) return;
  const { messages } = await loaders[locale]();
  registry.set(locale, messages);
}

// Returns the shared instance for a locale whose catalog has been registered
// (always true on the server; on the client, client.tsx loads the visitor's
// catalog before hydration and the settings picker loads before switching).
// A miss is a programming error, but falling back to an empty catalog keeps
// the page up in English source strings rather than crashing.
export function getI18n(locale: AppLocale): I18n {
  let instance = instances.get(locale);
  if (!instance) {
    const messages = registry.get(locale) ?? {};
    instance = setupI18n({ locale, messages: { [locale]: messages } });
    instances.set(locale, instance);
    if (!registry.has(locale) && locale !== DEFAULT_LOCALE) {
      console.warn(`[i18n] catalog for ${locale} not loaded; falling back to source strings`);
    }
  }
  return instance;
}
