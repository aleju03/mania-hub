import { createFileRoute } from "@tanstack/react-router";
import { Trans, useLingui } from "@lingui/react/macro";
import { LegalDocument, LegalParagraph, LegalSection } from "#/components/legal/LegalDocument";

export const Route = createFileRoute("/legal")({
  head: () => ({
    meta: [
      { title: "Legal notice" },
      {
        name: "description",
        content: "Legal notice for Mania Tracker.",
      },
      { name: "robots", content: "noindex, nofollow" },
    ],
  }),
  component: LegalPage,
});

function LegalPage() {
  const { t } = useLingui();
  return (
    <LegalDocument eyebrow={t`Legal notice`} title={t`Mania Tracker`} updatedAt={t`June 16, 2026`}>
      <LegalSection title={t`Unofficial Project`}>
        <LegalParagraph>
          <Trans>
            Mania Tracker is an unofficial community fan project for osu!mania players. It is
            not affiliated with, endorsed by, sponsored by, or approved by ppy Pty Ltd or the
            osu! team.
          </Trans>
        </LegalParagraph>
      </LegalSection>

      <LegalSection title={t`osu! Assets And Data`}>
        <LegalParagraph>
          <Trans>
            Rights in osu!, osu!mania, osu! game branding, ruleset names, ruleset icons, score data,
            replay data, user profile data, and related osu! assets remain with ppy Pty Ltd or the
            applicable rightsholders.
          </Trans>
        </LegalParagraph>
        <LegalParagraph>
          <Trans>
            Beatmap audio, backgrounds, titles, artist names, creator names, metadata, and other
            user-submitted or third-party content remain with their respective owners. This site
            displays available public metadata and derived information for community reference.
          </Trans>
        </LegalParagraph>
      </LegalSection>

      <LegalSection title={t`Data Sources`}>
        <LegalParagraph>
          <Trans>
            Mania Tracker uses public and authenticated osu! API data, locally cached data,
            server projections, and community data services such as{" "}
            <a
              href="https://osc.kaysting.dev/"
              target="_blank"
              rel="noopener noreferrer"
              className="font-semibold text-osu-pink-light hover:text-white transition-colors"
            >
              osu! score cache
            </a>
            .
          </Trans>
        </LegalParagraph>
        <LegalParagraph>
          <Trans>
            The site caches, queues, and reuses data to avoid repeatedly requesting the same
            information from osu!. Live features are built from the site's own server projections,
            with refresh jobs used to fill in missing details and verify notable scores.
          </Trans>
        </LegalParagraph>
        <LegalParagraph>
          <Trans>
            The server defaults to a global osu! API limiter that targets 45 requests per
            minute and enforces a hard cap of 60 requests per minute.
          </Trans>
        </LegalParagraph>
        <LegalParagraph>
          <Trans>
            Even with those safeguards, data may be delayed, incomplete, stale, or unavailable.
          </Trans>
        </LegalParagraph>
      </LegalSection>

      <LegalSection title={t`Use Of The Site`}>
        <LegalParagraph>
          <Trans>
            Please do not abuse the site, overload public endpoints, attempt to bypass access
            controls, send harmful payloads, or use the service in a way that disrupts osu!, ppy,
            community APIs, or other users.
          </Trans>
        </LegalParagraph>
      </LegalSection>

      <LegalSection title={t`Accuracy And Availability`}>
        <LegalParagraph>
          <Trans>
            Mania Tracker is a community project built on external data sources, so rankings,
            scores, snipes, top plays, replay views, and other generated surfaces may be delayed,
            incomplete, unavailable, or incorrect.
          </Trans>
        </LegalParagraph>
      </LegalSection>

      <LegalSection title={t`Contact`}>
        <LegalParagraph>
          <Trans>
            For attribution, takedown, privacy, or data concerns, contact the maintainer through
            the public osu! profile linked in the site footer.
          </Trans>
        </LegalParagraph>
      </LegalSection>
    </LegalDocument>
  );
}
