import { createFileRoute } from "@tanstack/react-router";
import { Trans, useLingui } from "@lingui/react/macro";
import { LegalDocument, LegalParagraph, LegalSection } from "#/components/legal/LegalDocument";

export const Route = createFileRoute("/terms")({
  head: () => ({
    meta: [
      { title: "Terms of Service" },
      {
        name: "description",
        content: "Terms of Service for Mania Tracker.",
      },
      { name: "robots", content: "noindex, nofollow" },
    ],
  }),
  component: TermsPage,
});

function TermsPage() {
  const { t } = useLingui();
  return (
    <LegalDocument eyebrow={t`Terms`} title={t`Terms of Service`} updatedAt={t`August 23, 2026`}>
      <LegalSection title={t`Unofficial Project`}>
        <LegalParagraph>
          <Trans>
            Mania Tracker is an unofficial community fan project for osu!mania players. It is not
            affiliated with, endorsed by, sponsored by, or approved by ppy Pty Ltd or the osu! team.
          </Trans>
        </LegalParagraph>
      </LegalSection>

      <LegalSection title={t`Use Of The Site`}>
        <LegalParagraph>
          <Trans>
            You may use the site for personal and community reference. Please do not overload
            public endpoints, attempt to bypass access controls, scrape aggressively, interfere
            with other users, or use the service in a way that disrupts osu!, ppy, community APIs,
            or Mania Tracker infrastructure.
          </Trans>
        </LegalParagraph>
      </LegalSection>

      <LegalSection title={t`osu! Login`}>
        <LegalParagraph>
          <Trans>
            Mania Tracker uses osu! OAuth to identify the signed-in osu! account. Mania Tracker
            does not receive or manage your osu! password.
          </Trans>
        </LegalParagraph>
      </LegalSection>

      <LegalSection title={t`osu! Assets And Data`}>
        <LegalParagraph>
          <Trans>
            Rights in osu!, osu!mania, osu! game branding, ruleset names, score data, replay data,
            user profile data, and related osu! assets remain with ppy Pty Ltd or the applicable
            rightsholders.
          </Trans>
        </LegalParagraph>
        <LegalParagraph>
          <Trans>
            Beatmap audio, backgrounds, titles, artist names, creator names, metadata, and other
            user-submitted or third-party content remain with their respective owners. Mania Tracker
            does not claim ownership of that content.
          </Trans>
        </LegalParagraph>
        <LegalParagraph>
          <Trans>
            Mania Tracker displays public metadata, cached projections, and derived community views
            for reference. To report a bug, use the{' '}
            <a
              href="/report"
              className="text-osu-pink-light underline underline-offset-2 hover:text-white transition-colors"
            >
              Report a bug
            </a>{' '}
            form on the site. If you own content shown on the site and have an attribution,
            takedown, or data concern, email{' '}
            <a
              href="mailto:contact@mania-tracker.com"
              className="text-osu-pink-light underline underline-offset-2 hover:text-white transition-colors"
            >
              contact@mania-tracker.com
            </a>{' '}
            or contact the maintainer through the public osu! profile linked in the footer.
          </Trans>
        </LegalParagraph>
      </LegalSection>

      <LegalSection title={t`Accuracy And Availability`}>
        <LegalParagraph>
          <Trans>
            Mania Tracker is a community project built on external data sources, so rankings, score
            views, snipes, top plays, maps, farm-helper suggestions, replay views, dan estimates,
            and other generated surfaces may be delayed, incomplete, unavailable, or incorrect.
            Features may change, break, or be removed.
          </Trans>
        </LegalParagraph>
      </LegalSection>
    </LegalDocument>
  );
}
