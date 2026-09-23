import { createFileRoute, notFound, useNavigate } from "@tanstack/react-router";
import { canSeeTeams } from "../../lib/auth-shared";
import { Trans } from "@lingui/react/macro";
import { fetchLiveTeamStoredSnapshot, type LiveTeamProfileSnapshot } from "../../lib/live-backend";
import { pageSeo } from "../../lib/seo";
import { TeamProfilePage, isTeamTab, type TeamTab } from "../../components/team/TeamProfilePage";

type TeamSearch = { tab?: TeamTab };

const TEAM_LOADER_TIMEOUT_MS = 1_500;

function parseTeamId(raw: string): number | null {
  const id = Number(raw);
  return Number.isInteger(id) && id > 0 ? id : null;
}

/* SSR only, like the player route: a client navigation fetches the full
   snapshot itself, and the stored-only read never reaches osu!. */
async function loadTeamRouteData(rawTeamId: string): Promise<{ snapshot: LiveTeamProfileSnapshot | null }> {
  const teamId = parseTeamId(rawTeamId);
  if (typeof document !== "undefined" || teamId == null) return { snapshot: null };
  const timeout = new Promise<null>((resolve) => setTimeout(() => resolve(null), TEAM_LOADER_TIMEOUT_MS));
  try {
    const snapshot = await Promise.race([fetchLiveTeamStoredSnapshot({ data: { teamId } }), timeout]);
    return { snapshot };
  } catch {
    return { snapshot: null };
  }
}

export const Route = createFileRoute("/team/$teamId")({
  validateSearch: (search: Record<string, unknown>): TeamSearch => (
    isTeamTab(search.tab) && search.tab !== "best" ? { tab: search.tab } : {}
  ),
  beforeLoad: ({ context }) => {
    if (!canSeeTeams(context.auth)) throw notFound();
  },
  loader: async ({ params }) => loadTeamRouteData(params.teamId),
  head: ({ params, match, loaderData }) => {
    const name = loaderData?.snapshot?.team.name;
    return pageSeo({
      title: name ?? "Team",
      description: name ? `${name}'s osu!mania team stats.` : "An osu!mania team's stats.",
      path: `/team/${params.teamId}`,
      origin: match.context.origin,
      type: "profile",
    });
  },
  component: TeamRoute,
});

function TeamRoute() {
  const { teamId } = Route.useParams();
  const search = Route.useSearch();
  const { snapshot } = Route.useLoaderData();
  const navigate = useNavigate({ from: Route.fullPath });
  const id = parseTeamId(teamId);
  if (id == null) {
    return <div className="flex-1 bg-osu-b5 px-4 py-16 text-center text-sm text-osu-f1"><Trans>Not a team id.</Trans></div>;
  }
  return (
    <TeamProfilePage
      key={id}
      teamId={id}
      initialSnapshot={snapshot?.team.id === id ? snapshot : null}
      tab={search.tab ?? "best"}
      onTabChange={(tab) => {
        void navigate({ search: tab === "best" ? {} : { tab }, replace: true, resetScroll: false });
      }}
    />
  );
}
