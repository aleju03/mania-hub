import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/legal")({
  head: () => ({
    meta: [
      { title: "Legal notice" },
      {
        name: "description",
        content: "Legal notice for o!mania tracker.",
      },
      { name: "robots", content: "noindex, nofollow" },
    ],
  }),
  component: LegalPage,
});

function LegalPage() {
  return (
    <div className="min-h-[calc(100vh-60px)] bg-osu-dark text-osu-f1">
      <div className="mx-auto flex w-full max-w-3xl flex-col gap-8 px-5 py-10 sm:px-6 lg:py-14">
        <header className="space-y-3">
          <p className="text-xs font-semibold uppercase tracking-wide text-osu-pink-light/70">
            Legal notice
          </p>
          <h1 className="text-3xl font-black text-white sm:text-4xl">o!mania tracker</h1>
          <p className="text-sm text-osu-f1/70">Last updated May 17, 2026</p>
        </header>

        <section className="space-y-3">
          <h2 className="text-lg font-bold text-white">Unofficial Project</h2>
          <p className="leading-7 text-osu-f1/85">
            o!mania tracker is an unofficial community fan project for osu!mania players. It is
            not affiliated with, endorsed by, sponsored by, or approved by ppy Pty Ltd or the
            osu! team.
          </p>
        </section>

        <section className="space-y-3">
          <h2 className="text-lg font-bold text-white">osu! Assets And Data</h2>
          <p className="leading-7 text-osu-f1/85">
            osu!, osu!mania, osu! game branding, ruleset names, ruleset icons, beatmap metadata,
            score data, replay data, user profile data, and related osu! assets remain the
            property of ppy Pty Ltd or their respective rightsholders.
          </p>
          <p className="leading-7 text-osu-f1/85">
            Beatmap audio, backgrounds, titles, artist names, creator names, and other
            user-submitted or third-party content belong to their respective owners. This site
            displays available public metadata and derived information for community reference.
          </p>
        </section>

        <section className="space-y-3">
          <h2 className="text-lg font-bold text-white">Data Sources</h2>
          <p className="leading-7 text-osu-f1/85">
            o!mania tracker uses public and authenticated osu! API data, locally cached data,
            live backend projections, and community data services such as{" "}
            <a
              href="https://osc.kaysting.dev/"
              target="_blank"
              rel="noopener noreferrer"
              className="font-semibold text-osu-pink-light hover:text-white transition-colors"
            >
              osu! score cache
            </a>
            .
          </p>
          <p className="leading-7 text-osu-f1/85">
            The site caches, queues, and reuses data to avoid repeatedly requesting the same
            information from osu!. Live features are built from Mania Hub's own backend
            projections, with refresh jobs used to fill in missing details and verify notable
            scores.
          </p>
          <p className="leading-7 text-osu-f1/85">
            The live backend defaults to a global osu! API limiter that targets 45 requests per
            minute and enforces a hard cap of 60 requests per minute.
          </p>
          <p className="leading-7 text-osu-f1/85">
            Even with those safeguards, data may be delayed, incomplete, stale, or unavailable.
          </p>
        </section>

        <section className="space-y-3">
          <h2 className="text-lg font-bold text-white">Use Of The Site</h2>
          <p className="leading-7 text-osu-f1/85">
            Please do not abuse the site, overload public endpoints, attempt to bypass access
            controls, upload harmful files, or use the service in a way that disrupts osu!, ppy,
            community APIs, or other users.
          </p>
        </section>

        <section className="space-y-3">
          <h2 className="text-lg font-bold text-white">No Warranty</h2>
          <p className="leading-7 text-osu-f1/85">
            o!mania tracker is provided as-is, without warranties of any kind. Rankings, scores,
            snipes, top plays, replay exports, and other generated views may contain mistakes or
            omissions.
          </p>
        </section>

        <section className="space-y-3">
          <h2 className="text-lg font-bold text-white">Contact</h2>
          <p className="leading-7 text-osu-f1/85">
            For attribution, takedown, privacy, or data concerns, contact the maintainer through
            the public osu! profile linked in the site footer.
          </p>
        </section>
      </div>
    </div>
  );
}
