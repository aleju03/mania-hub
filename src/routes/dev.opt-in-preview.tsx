import { useState } from "react";
import { createFileRoute, notFound } from "@tanstack/react-router";

import { PageHeader } from "../components/layout/PageHeader";
import { OsuTriangleBackdrop } from "../components/layout/OsuTriangleBackdrop";
import { RosterOptInCard } from "../components/me/RosterOptInCard";
import { SkillsUntrackedNotice } from "../components/player/SkillsUntrackedNotice";
import { OsuLogo } from "../components/ui/OsuLogo";
import { canUseDevFeatures } from "../lib/auth-shared";
import type { RosterSelfTrackResult } from "../lib/roster-self-track";

// Dev-only showcase for the roster self opt-in flow ("Track my plays"). Renders every state of
// the My Stats card and the profile Activity empty states against a fake action, so the whole
// flow can be eyeballed without calling the live backend or actually joining a roster.

export const Route = createFileRoute("/dev/opt-in-preview")({
  beforeLoad: ({ context }) => {
    if (!canUseDevFeatures(context.auth)) {
      throw notFound();
    }
    return undefined as never;
  },
  component: OptInPreviewPage,
});

type Scenario = "added" | "country_full" | "country_not_tracked" | "unavailable" | "network_error";

const SCENARIOS: Array<{ key: Scenario; label: string }> = [
  { key: "added", label: "success" },
  { key: "country_full", label: "country full" },
  { key: "country_not_tracked", label: "country not tracked" },
  { key: "unavailable", label: "backend unavailable" },
  { key: "network_error", label: "network error" },
];

function makeFakeAction(scenario: Scenario): () => Promise<RosterSelfTrackResult> {
  return async () => {
    // Long enough to see the pending "Adding you…" state.
    await new Promise((resolve) => setTimeout(resolve, 900));
    if (scenario === "network_error") throw new Error("simulated network error");
    if (scenario === "added") return { ok: true, status: "added", country: "CR" };
    return { ok: false, status: scenario, country: "CR" };
  };
}

function OptInPreviewPage() {
  const [scenario, setScenario] = useState<Scenario>("added");
  // Remounting the cards on scenario change resets them back to idle.
  const [resetKey, setResetKey] = useState(0);

  const pick = (next: Scenario) => {
    setScenario(next);
    setResetKey((k) => k + 1);
  };

  return (
    <div className="relative flex min-h-screen flex-col">
      <div className="relative z-10 flex flex-1 flex-col overflow-clip bg-osu-b5">
        <OsuTriangleBackdrop />
        <div className="relative z-10 flex flex-1 flex-col">
          <PageHeader
            iconSrc="/images/icons/chat.svg"
            title="opt-in preview"
            right={(
              <span className="rounded bg-osu-yellow/15 px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wider text-osu-yellow">
                dev preview
              </span>
            )}
          />

          <div className="mx-auto w-full max-w-[720px] flex-1 space-y-6 px-4 py-6 sm:px-5">
            <section className="rounded-2xl border border-osu-b3/30 bg-osu-b4 p-4">
              <div className="text-[13px] font-semibold text-osu-l2">Clicking "Track my plays" resolves as</div>
              <div className="mt-2.5 flex flex-wrap gap-1.5">
                {SCENARIOS.map((s) => (
                  <button
                    key={s.key}
                    type="button"
                    onClick={() => pick(s.key)}
                    className={`rounded-lg border px-3 py-1.5 text-[12px] font-semibold transition-colors cursor-pointer ${
                      scenario === s.key
                        ? "border-osu-pink/40 bg-osu-pink/15 text-osu-pink-light"
                        : "border-osu-b3/30 bg-osu-b5 text-osu-f1 hover:text-white"
                    }`}
                  >
                    {s.label}
                  </button>
                ))}
              </div>
              <div className="mt-2 text-[12px] text-osu-f1">
                Nothing here talks to the live backend; the click resolves against a fake after a short delay. Success also fires the site-wide "tracking on" toast with its chime, exactly as it would for a real opt-in. Picking a scenario resets the cards below.
              </div>
            </section>

            <section className="space-y-2.5">
              <div className="text-[13px] font-semibold text-osu-l2">My Stats (/my-stats) - untracked viewer</div>
              <RosterOptInCard
                key={`mystats-${resetKey}`}
                description="Your plays aren't being recorded yet because you're not in your country's top 100. Add yourself to the tracker and this page comes alive: a live feed of your plays, your playstyle, and records. Then you can set goals that auto-complete as you play."
                performAction={makeFakeAction(scenario)}
              />
            </section>

            <section className="space-y-2.5">
              <div className="text-[13px] font-semibold text-osu-l2">Profile Activity tab - own untracked profile</div>
              <RosterOptInCard
                key={`activity-${resetKey}`}
                description="Activity is recorded automatically for the top 100 of each country. You're not in it yet, but you can add yourself to the tracker."
                performAction={makeFakeAction(scenario)}
              />
            </section>

            <section className="space-y-2.5">
              <div className="text-[13px] font-semibold text-osu-l2">Profile Skills tab - own untracked profile</div>
              <SkillsUntrackedNotice
                key={`skills-${resetKey}`}
                username="aleju"
                isOwner
                performAction={makeFakeAction(scenario)}
              />
            </section>

            <section className="space-y-2.5">
              <div className="text-[13px] font-semibold text-osu-l2">Profile Activity tab - logged out (static)</div>
              <div className="rounded-xl border border-osu-b3/20 bg-osu-b4 p-6 text-center">
                <div className="text-sm font-semibold text-osu-l2">No activity data for this player</div>
                <div className="mt-1.5 text-[13px] text-osu-f1">
                  Activity is recorded for the top 100 of each tracked country. If this is your profile, log in with osu! to add yourself to the tracker.
                </div>
                <span className="mt-4 inline-flex items-center gap-2 rounded-lg border border-osu-pink/40 bg-osu-pink/15 px-4 py-2 text-[12px] font-semibold text-osu-pink-light">
                  <OsuLogo className="h-4 w-4" />
                  Log in with osu!
                </span>
              </div>
            </section>

            <section className="space-y-2.5">
              <div className="text-[13px] font-semibold text-osu-l2">Profile Activity tab - someone else's untracked profile (static)</div>
              <div className="rounded-xl border border-osu-b3/20 bg-osu-b4 p-6 text-center">
                <div className="text-sm font-semibold text-osu-l2">No activity data for this player</div>
                <div className="mt-1.5 text-[13px] text-osu-f1">
                  Plays are only recorded for the top 100 players of each tracked country, and this player isn't currently among them.
                </div>
              </div>
            </section>
          </div>
        </div>
      </div>
    </div>
  );
}
