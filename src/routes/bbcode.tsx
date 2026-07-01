import { createFileRoute } from "@tanstack/react-router";
import { Suspense, lazy } from "react";
import { PageHeader } from "../components/layout/PageHeader";
import { OsuTriangleBackdrop } from "../components/layout/OsuTriangleBackdrop";
import { Skeleton } from "../components/ui/LoadingSkeleton";
import { useAuth } from "../lib/auth-context";
import { pageSeo } from "../lib/seo";

const BBCodeEditorLazy = lazy(() => import("../components/player/bbcode/BBCodeEditor"));

export const Route = createFileRoute("/bbcode")({
  head: ({ match }) =>
    pageSeo({
      title: "BBCode editor",
      description:
        "Write and preview osu! profile BBCode for your me! page, with a live preview and one-click copy.",
      path: "/bbcode",
      origin: match.context.origin,
      imageKind: "bbcode",
    }),
  component: BBCodePage,
});

function BBCodePage() {
  const { viewer } = useAuth();

  return (
    <div className="relative flex min-h-screen flex-col">
      <div className="relative z-10 flex flex-1 flex-col overflow-clip bg-osu-b5">
        <OsuTriangleBackdrop />
        <div className="relative z-10 flex flex-1 flex-col">
          <PageHeader iconSrc="/images/icons/profile.svg" title="osu! profile BBCode editor" />

          <div className="mx-auto w-full max-w-[1100px] flex-1 px-4 py-5 sm:px-5">
            <Suspense
              fallback={(
                <div className="space-y-2 rounded-xl border border-osu-b3/20 bg-osu-b4 p-5">
                  <Skeleton className="h-4 w-40" />
                  <Skeleton className="h-4 w-full" />
                  <Skeleton className="h-4 w-2/3" />
                </div>
              )}
            >
              <BBCodeEditorLazy
                userId={viewer?.id ?? null}
                username={viewer?.username}
                initialSource={null}
                enableLoadFromUser={!viewer}
                enableLoadOwnPage={!!viewer}
              />
            </Suspense>
          </div>
        </div>
      </div>
    </div>
  );
}
