import { createFileRoute } from "@tanstack/react-router";
import { Suspense, lazy, type ReactNode } from "react";
import {
  ALargeSmall,
  AlignCenter,
  Bold,
  Braces,
  ChevronsDownUp,
  Code,
  Copy,
  EyeOff,
  Heading1,
  Image,
  Italic,
  Link,
  List,
  ListOrdered,
  Map,
  Megaphone,
  Music,
  Palette,
  Rainbow,
  Strikethrough,
  TextQuote,
  Underline,
  UserRound,
  Youtube,
} from "lucide-react";
import { PageHeader } from "../components/layout/PageHeader";
import { OsuTriangleBackdrop } from "../components/layout/OsuTriangleBackdrop";
import { Skeleton } from "../components/ui/LoadingSkeleton";
import { useAuth } from "../lib/auth-context";
import { pageSeo } from "../lib/seo";

const BBCodeEditorLazy = lazy(() => import("../components/player/bbcode/BBCodeEditor"));

const TOOLBAR_GROUPS: Array<Array<{ label: string; icon: ReactNode }>> = [
  [
    { label: "Bold", icon: <Bold size={15} /> },
    { label: "Italic", icon: <Italic size={15} /> },
    { label: "Underline", icon: <Underline size={15} /> },
    { label: "Strikethrough", icon: <Strikethrough size={15} /> },
    { label: "Spoiler text", icon: <EyeOff size={15} /> },
  ],
  [
    { label: "Text color", icon: <Palette size={15} /> },
    { label: "Gradient text", icon: <Rainbow size={15} /> },
    { label: "Text size", icon: <ALargeSmall size={15} /> },
  ],
  [
    { label: "Link", icon: <Link size={15} /> },
    { label: "Image", icon: <Image size={15} /> },
    { label: "YouTube video", icon: <Youtube size={15} /> },
    { label: "Audio", icon: <Music size={15} /> },
    { label: "Profile link", icon: <UserRound size={15} /> },
  ],
  [
    { label: "Heading", icon: <Heading1 size={15} /> },
    { label: "Center", icon: <AlignCenter size={15} /> },
    { label: "Quote", icon: <TextQuote size={15} /> },
    { label: "Notice", icon: <Megaphone size={15} /> },
    { label: "Collapsible box", icon: <ChevronsDownUp size={15} /> },
    { label: "Inline code", icon: <Braces size={15} /> },
    { label: "Code block", icon: <Code size={15} /> },
    { label: "Bullet list", icon: <List size={15} /> },
    { label: "Numbered list", icon: <ListOrdered size={15} /> },
    { label: "Imagemap (image with clickable areas)", icon: <Map size={15} /> },
  ],
];

/** Renders the loaded editor's static chrome (header, toolbar, footer) for
    real so only the parts that depend on editor state show as skeletons,
    with matching paddings and heights so the swap doesn't shift. */
function BBCodeEditorSkeleton({ signedIn }: { signedIn: boolean }) {
  return (
    <div className="rounded-xl border border-osu-b3/20 bg-osu-b4 overflow-hidden">
      {/* Header */}
      <div className="flex items-center gap-3 px-4 py-3 border-b border-osu-b3/30">
        <div className="min-w-0">
          <div className="text-[13px] font-bold text-osu-c1">BBCode editor</div>
          <div className="text-[12px] text-osu-f1 truncate">
            Edits stay in this browser. Copy the result and paste it into the me! editor on your osu! page.
          </div>
        </div>
        <div className="ml-auto flex items-center gap-2 shrink-0">
          <button
            type="button"
            disabled
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[12px] font-semibold bg-osu-h1/20 border border-osu-h1/40 text-osu-c1 opacity-60"
          >
            <Copy size={14} />
            Copy BBCode
          </button>
        </div>
      </div>

      {/* Load me! page row */}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2 px-4 py-2.5 border-b border-osu-b3/30 bg-osu-b5/40">
        <span className="text-[12px] font-semibold text-osu-f1 shrink-0">
          {signedIn ? "Start from your live me! page" : "Load a player's me! page"}
        </span>
        {signedIn ? (
          <Skeleton className="h-[30px] w-[136px] rounded-md" />
        ) : (
          <Skeleton className="h-8 w-full rounded-md sm:w-64" />
        )}
      </div>

      {/* Toolbar */}
      <div className="flex items-center gap-0.5 px-3 py-2 border-b border-osu-b3/30 overflow-hidden">
        {TOOLBAR_GROUPS.map((group, groupIndex) => (
          <div key={groupIndex} className="flex items-center gap-0.5 shrink-0">
            {groupIndex > 0 ? <div className="w-px h-5 bg-osu-b3/60 mx-1 shrink-0" /> : null}
            {group.map((tool) => (
              <button
                key={tool.label}
                type="button"
                title={tool.label}
                aria-label={tool.label}
                disabled
                className="w-8 h-8 flex items-center justify-center rounded-md text-osu-l2 border border-transparent shrink-0"
              >
                {tool.icon}
              </button>
            ))}
          </div>
        ))}
        <div className="ml-auto pl-2 flex items-center gap-0.5 shrink-0">
          <button
            type="button"
            disabled
            className="px-2.5 py-1 rounded-md text-[11px] font-semibold uppercase tracking-wide bg-osu-h1/20 text-osu-c1 border border-osu-h1/40"
          >
            Visual
          </button>
          <button
            type="button"
            disabled
            className="px-2.5 py-1 rounded-md text-[11px] font-semibold uppercase tracking-wide text-osu-f1 border border-transparent"
          >
            BBCode
          </button>
        </div>
      </div>

      {/* Editing surface: placeholder line where the hint text sits */}
      <div className="h-[480px] lg:h-[580px] px-4 py-3">
        <Skeleton className="h-3.5 w-80 max-w-full opacity-60" />
      </div>

      {/* Footer */}
      <div className="flex items-center gap-3 px-4 py-2 border-t border-osu-b3/30 text-[12px] text-osu-f1">
        <span>0 characters</span>
        <span className="hidden sm:inline">Draft autosaves locally</span>
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
            <Suspense fallback={<BBCodeEditorSkeleton signedIn={!!viewer} />}>
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
