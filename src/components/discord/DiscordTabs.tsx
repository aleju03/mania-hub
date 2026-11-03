import { Link, useLocation } from "@tanstack/react-router";
import { Trans } from "@lingui/react/macro";
import { useAuth } from "../../lib/auth-context";

// The two Discord pages share one menu entry; this strip moves between them.
// The bot page is still a dev preview, so its tab shows only to those who can see it.
export function DiscordTabs() {
  const auth = useAuth();
  const { pathname } = useLocation();
  if (!auth.canUseDevFeatures) return null;
  const tabs = [
    { to: "/communities" as const, label: <Trans>Servers</Trans>, active: pathname.startsWith("/communities") },
    { to: "/discord" as const, label: <Trans>Bot</Trans>, active: pathname.startsWith("/discord") },
  ];
  return (
    <div className="border-b border-white/[0.07]">
      <div className="mx-auto flex w-full max-w-[1200px] gap-5 px-4 sm:px-5">
        {tabs.map((tab) => (
          <Link
            key={tab.to}
            to={tab.to}
            className={`relative py-2.5 text-[14px] font-semibold transition-colors ${tab.active ? "text-white" : "text-osu-f1 hover:text-white"}`}
          >
            {tab.label}
            {tab.active ? <span className="absolute inset-x-0 bottom-0 h-0.5 rounded-full bg-osu-pink" /> : null}
          </Link>
        ))}
      </div>
    </div>
  );
}
