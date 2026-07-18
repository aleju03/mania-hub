import { createFileRoute } from "@tanstack/react-router";
import { Suspense, lazy } from "react";
import { PageHeader } from "../components/layout/PageHeader";
import { OsuTriangleBackdrop } from "../components/layout/OsuTriangleBackdrop";
import { Skeleton } from "../components/ui/LoadingSkeleton";
import { useAuth } from "../lib/auth-context";
import { pageSeo } from "../lib/seo";

const BBCodeEditorLazy = lazy(() => import("../components/player/bbcode/BBCodeEditor"));

/** Mirrors the loaded editor's chrome (header, load row, toolbar, surface,
    footer) with matching paddings and heights so the swap doesn't shift. */
function BBCodeEditorSkeleton() {
  return (
    <div className="rounded-xl border border-osu-b3/20 bg-osu-b4 overflow-hidden">
      {/* Header: title + description left, Copy BBCode button right */}
      <div className="flex items-center gap-3 px-4 py-3 border-b border-osu-b3/30">
        <div className="min-w-0 space-y-1.5 py-0.5">
          <Skeleton className="h-3.5 w-28" />
          <Skeleton className="h-3 w-72 max-w-[60vw]" />
        </div>
        <Skeleton className="ml-auto h-[30px] w-[110px] shrink-0 rounded-lg" />
      </div>

      {/* Load me! page row */}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2 px-4 py-2.5 border-b border-osu-b3/30 bg-osu-b5/40">
        <Skeleton className="h-3.5 w-44 shrink-0" />
        <Skeleton className="h-8 w-full rounded-md sm:w-64" />
      </div>

      {/* Toolbar: icon buttons in groups, mode toggle right */}
      <div className="flex items-center gap-0.5 px-3 py-2 border-b border-osu-b3/30 overflow-hidden">
        {[5, 3, 5, 9].map((count, group) => (
          <div key={group} className="flex items-center gap-0.5 shrink-0">
            {group > 0 ? <div className="w-px h-5 bg-osu-b3/60 mx-1 shrink-0" /> : null}
            {Array.from({ length: count }, (_, i) => (
              <Skeleton key={i} className="w-8 h-8 rounded-md" />
            ))}
          </div>
        ))}
        <div className="ml-auto pl-2 flex items-center gap-0.5 shrink-0">
          <Skeleton className="h-[26px] w-16 rounded-md" />
          <Skeleton className="h-[26px] w-16 rounded-md" />
        </div>
      </div>

      {/* Editing surface: placeholder line where the hint text sits */}
      <div className="h-[480px] lg:h-[580px] px-4 py-3">
        <Skeleton className="h-3.5 w-80 max-w-full opacity-60" />
      </div>

      {/* Footer */}
      <div className="flex items-center gap-3 px-4 py-2 border-t border-osu-b3/30">
        <Skeleton className="h-3 w-24" />
        <Skeleton className="hidden h-3 w-32 sm:block" />
        <Skeleton className="ml-auto h-3 w-20" />
      </div>
    </div>
  );
}

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
            <Suspense fallback={<BBCodeEditorSkeleton />}>
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
