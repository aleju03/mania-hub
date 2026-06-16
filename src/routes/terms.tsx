import { createFileRoute } from "@tanstack/react-router";
import { LegalDocument, LegalParagraph, LegalSection } from "#/components/legal/LegalDocument";

const UPDATED_AT = "June 16, 2026";

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
  return (
    <LegalDocument eyebrow="Terms" title="Terms of Service" updatedAt={UPDATED_AT}>
      <LegalSection title="Unofficial Project">
        <LegalParagraph>
          Mania Tracker is an unofficial community fan project for osu!mania players. It is not
          affiliated with, endorsed by, sponsored by, or approved by ppy Pty Ltd or the osu! team.
        </LegalParagraph>
      </LegalSection>

      <LegalSection title="Use Of The Site">
        <LegalParagraph>
          You may use the site for personal and community reference. Please do not overload
          public endpoints, attempt to bypass access controls, scrape aggressively, interfere
          with other users, or use the service in a way that disrupts osu!, ppy, community APIs,
          or Mania Tracker infrastructure.
        </LegalParagraph>
      </LegalSection>

      <LegalSection title="osu! Login">
        <LegalParagraph>
          When osu! login is available, Mania Tracker uses osu! OAuth to identify the signed-in
          osu! account. Mania Tracker does not receive or manage your osu! password.
        </LegalParagraph>
      </LegalSection>

      <LegalSection title="osu! Assets And Data">
        <LegalParagraph>
          Rights in osu!, osu!mania, osu! game branding, ruleset names, score data, replay data,
          user profile data, and related osu! assets remain with ppy Pty Ltd or the applicable
          rightsholders.
        </LegalParagraph>
        <LegalParagraph>
          Beatmap audio, backgrounds, titles, artist names, creator names, metadata, and other
          user-submitted or third-party content remain with their respective owners. Mania Tracker
          does not claim ownership of that content.
        </LegalParagraph>
        <LegalParagraph>
          Mania Tracker displays public metadata, cached projections, and derived community views
          for reference. If you own content shown on the site and have an attribution, takedown,
          or data concern, contact the maintainer through the public osu! profile linked in the
          footer.
        </LegalParagraph>
      </LegalSection>

      <LegalSection title="Accuracy And Availability">
        <LegalParagraph>
          Mania Tracker is a community project built on external data sources, so rankings, score
          views, snipes, top plays, maps, farm-helper suggestions, replay views, dan estimates,
          and other generated surfaces may be delayed, incomplete, unavailable, or incorrect.
          Features may change, break, or be removed.
        </LegalParagraph>
      </LegalSection>
    </LegalDocument>
  );
}
