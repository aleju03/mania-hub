import { useMemo } from "react";
import { msg } from "@lingui/core/macro";
import { useLingui } from "@lingui/react/macro";
import type { MessageDescriptor } from "@lingui/core";
import {
  COMMUNITY_INTERNATIONAL,
  COMMUNITY_LANGUAGES,
  COMMUNITY_MAX_PER_USER,
  type CommunityLanguage,
  type CommunityReportReason,
} from "../../lib/communities-shared";
import { COUNTRY_OPTIONS, displayCountryName } from "../../lib/country";
import { useLocale } from "../../lib/locale-context";
import { CountryFlag } from "../ui/CountryFlag";

/* The country and language pickers, shared by the form that posts a server and
   the one that edits it, so the two can never drift into offering different
   answers for the same field.

   It also carries the translated copy those forms share: the language names and
   the backend's refusals live in src/lib/communities-shared.ts as English source
   strings, which double as the values the backend and the moderator page read,
   so the translatable versions sit here as parallel descriptor maps the way the
   nav does it. Keep the two in step when either list changes. */

const countryOption = (code: string, name: string) => ({
  value: code,
  label: name,
  leading: <CountryFlag code={code} size="sm" decorative />,
});

/* Your own country sits directly under "international" rather than wherever the
   alphabet put it, because it is the answer far more often than Afghanistan is.
   Lifted out of the run rather than repeated in it, so there is one row per
   country and searching still finds it. */
export function useCountrySelectOptions(viewerCountry: string | null) {
  const { t } = useLingui();
  const locale = useLocale();
  return useMemo(() => {
    const own = viewerCountry ? COUNTRY_OPTIONS.find((country) => country.code === viewerCountry) : undefined;
    const named = (code: string) => countryOption(code, displayCountryName(code, locale));
    return [
      { value: "", label: t`not set` },
      { value: COMMUNITY_INTERNATIONAL, label: t`international` },
      ...(own ? [named(own.code)] : []),
      ...COUNTRY_OPTIONS.filter((country) => country.code !== own?.code).map((country) => named(country.code)),
    ];
  }, [viewerCountry, locale, t]);
}

const COMMUNITY_LANGUAGE_MSGS: Record<CommunityLanguage, MessageDescriptor> = {
  multi: msg`any language`,
  ar: msg`Arabic`,
  bg: msg`Bulgarian`,
  zh: msg`Chinese`,
  hr: msg`Croatian`,
  cs: msg`Czech`,
  da: msg`Danish`,
  nl: msg`Dutch`,
  en: msg`English`,
  et: msg`Estonian`,
  fil: msg`Filipino`,
  fi: msg`Finnish`,
  fr: msg`French`,
  de: msg`German`,
  el: msg`Greek`,
  he: msg`Hebrew`,
  hi: msg`Hindi`,
  hu: msg`Hungarian`,
  id: msg`Indonesian`,
  it: msg`Italian`,
  ja: msg`Japanese`,
  ko: msg`Korean`,
  lv: msg`Latvian`,
  lt: msg`Lithuanian`,
  ms: msg`Malay`,
  no: msg`Norwegian`,
  fa: msg`Persian`,
  pl: msg`Polish`,
  pt: msg`Portuguese`,
  ro: msg`Romanian`,
  ru: msg`Russian`,
  sr: msg`Serbian`,
  sk: msg`Slovak`,
  es: msg`Spanish`,
  sv: msg`Swedish`,
  th: msg`Thai`,
  tr: msg`Turkish`,
  uk: msg`Ukrainian`,
  vi: msg`Vietnamese`,
  other: msg`other`,
};

/** The language a listing named, in the reader's language. Null when unset. */
export function useCommunityLanguageLabel() {
  const { i18n } = useLingui();
  return useMemo(
    () => (code: string | null | undefined) => {
      if (!code) return null;
      const descriptor = COMMUNITY_LANGUAGE_MSGS[code as CommunityLanguage];
      return descriptor ? i18n._(descriptor) : code;
    },
    [i18n],
  );
}

export function useLanguageSelectOptions() {
  const { t } = useLingui();
  const label = useCommunityLanguageLabel();
  return useMemo(
    () => [
      { value: "", label: t`not set` },
      ...COMMUNITY_LANGUAGES.map((code) => ({ value: code, label: label(code) ?? code })),
    ],
    [t, label],
  );
}

// What the forms say when the backend refuses something. Every one of these is
// fixable by the person reading it, so they read as instructions.
const COMMUNITY_ERROR_MSGS: Record<string, MessageDescriptor> = {
  invalid_url: msg`That does not look like a Discord invite link.`,
  unknown_invite: msg`Discord does not recognise that invite. Check it is still valid.`,
  guild_mismatch: msg`That invite is for a different server than the one you picked.`,
  lookup_failed: msg`Could not reach Discord to check that invite. Try again in a moment.`,
  already_listed: msg`That server is already listed.`,
  limit_reached: msg`You can list up to ${COMMUNITY_MAX_PER_USER} servers.`,
  empty_pitch: msg`Write a short description of the server.`,
  forbidden: msg`That listing is not yours.`,
  not_found: msg`That listing no longer exists.`,
  no_discord: msg`Connect your Discord account first.`,
  no_access: msg`Log in with osu! first.`,
  own_listing: msg`That is your own listing.`,
  too_many_reports: msg`You have a few reports waiting to be read already. Give a moderator a chance to catch up.`,
};

export function useCommunityErrorMessage() {
  const { i18n } = useLingui();
  return useMemo(
    () => (code: string | undefined) => {
      const descriptor = code ? COMMUNITY_ERROR_MSGS[code] : undefined;
      return descriptor ? i18n._(descriptor) : i18n._(msg`Something went wrong. Try again.`);
    },
    [i18n],
  );
}

// What someone flagging a listing can say, in the reader's language. The
// English source stays in communities-shared, which the moderator queue reads.
const COMMUNITY_REPORT_REASON_MSGS: Record<CommunityReportReason, MessageDescriptor> = {
  misleading: msg`Not the server it says it is`,
  dead: msg`Dead server, or the invite does not work`,
  spam: msg`Spam or advertising`,
  harmful: msg`Harmful, hateful or a scam`,
  other: msg`Something else`,
};

export function useCommunityReportReasonLabel() {
  const { i18n } = useLingui();
  return useMemo(
    () => (reason: CommunityReportReason) => i18n._(COMMUNITY_REPORT_REASON_MSGS[reason] ?? COMMUNITY_REPORT_REASON_MSGS.other),
    [i18n],
  );
}

// Discord's own badges on a guild, in the reader's language.
const COMMUNITY_FEATURE_MSGS: Record<string, MessageDescriptor> = {
  PARTNERED: msg`Discord partner`,
  VERIFIED: msg`Verified`,
  COMMUNITY: msg`Community server`,
  DISCOVERABLE: msg`In server discovery`,
};

export function useCommunityFeatureLabels() {
  const { i18n } = useLingui();
  return useMemo(
    () => (features: string[] | undefined) =>
      (features ?? [])
        .map((feature) => COMMUNITY_FEATURE_MSGS[feature])
        .filter((descriptor): descriptor is MessageDescriptor => Boolean(descriptor))
        .map((descriptor) => i18n._(descriptor)),
    [i18n],
  );
}
