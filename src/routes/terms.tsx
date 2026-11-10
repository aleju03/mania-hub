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
    <LegalDocument eyebrow={t`Terms`} title={t`Terms of Service`} updatedAt={t`November 9, 2026`}>
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
            for reference. To report a bug or send feedback, use the{' '}
            <a
              href="/report"
              className="text-osu-pink-light underline underline-offset-2 hover:text-white transition-colors"
            >
              Bugs and feedback
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

      <LegalSection title={t`Supporter Themes And Uploads`}>
        <LegalParagraph>
          <Trans>
            Supporters can upload images and make their own profile themes, including shader code
            others can see and use. Whoever uploads or writes them is responsible for them and must
            have the right to share them. They go live without review.
          </Trans>
        </LegalParagraph>
        <LegalParagraph>
          <Trans>
            This covers themes, avatar frames, companions and every image. None of them may carry
            sexual or graphic content, hate or harassment, or political or religious messaging, such
            as slogans, symbols of parties or movements, or imagery of wars and conflicts. A
            country's flag on its own is fine.
          </Trans>
        </LegalParagraph>
        <LegalParagraph>
          <Trans>
            To report a theme, use Report under the profile wearing it. A theme or image that infringes someone's rights or breaks these terms is taken
            down, and a supporter who keeps uploading such content loses the ability to make
            themes.
          </Trans>
        </LegalParagraph>
      </LegalSection>

      <LegalSection title={t`Supporter Status And Payments`}>
        <LegalParagraph>
          <Trans>
            Supporter status is optional. It unlocks cosmetic extras on the site, such as profile
            themes, avatar frames, name styles and mascots, and changes nothing about rankings,
            scores or ratings. The extras on offer may change over time.
          </Trans>
        </LegalParagraph>
        <LegalParagraph>
          <Trans>
            Supporter status is bought as time on your osu! account: $4 buys 30 days, any other
            amount buys time in proportion to the day, and one payment of $40 or more buys a full
            year for every $40. A payment adds to the time you have left, and the status ends when
            the time runs out. Supporter time is tied to the account it was paid for and cannot be
            moved to another, except through the gift codes the site hands out.
          </Trans>
        </LegalParagraph>
        <LegalParagraph>
          <Trans>
            Payments go through Ko-fi, Google or lava.top, which process them under their own terms.
            Mania Tracker never sees your card or bank details. A monthly subscription renews by
            itself until you cancel it on the platform you started it on; cancelling stops the next
            payment, and the time already paid for stays until it runs out.
          </Trans>
        </LegalParagraph>
      </LegalSection>

      <LegalSection title={t`Refunds`}>
        <LegalParagraph>
          <Trans>
            Supporter time starts as soon as a payment goes through, so payments are final. A
            payment made twice or by mistake is refunded: email{' '}
            <a
              href="mailto:contact@mania-tracker.com"
              className="text-osu-pink-light underline underline-offset-2 hover:text-white transition-colors"
            >
              contact@mania-tracker.com
            </a>{' '}
            with the date of the payment and the platform you paid through, and the refund goes
            back through that platform. Refund rights the law where you live gives you also apply.
          </Trans>
        </LegalParagraph>
        <LegalParagraph>
          <Trans>
            A refund, whether made on request, through the platform itself or by a chargeback,
            removes the supporter time the payment bought.
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
