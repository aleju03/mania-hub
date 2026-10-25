import { createFileRoute } from "@tanstack/react-router";
import { Suspense, lazy, useCallback, useLayoutEffect, useRef, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";
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
import { Trans, useLingui } from "@lingui/react/macro";
import { msg } from "@lingui/core/macro";
import { getI18n } from "../lib/i18n";
import { PageHeader } from "../components/layout/PageHeader";
import { BBCodeDoodles } from "../components/player/bbcode/BBCodeDoodles";
import { Skeleton } from "../components/ui/LoadingSkeleton";
import { useAuth } from "../lib/auth-context";
import { pageSeo } from "../lib/seo";

const BBCodeEditorLazy = lazy(() => import("../components/player/bbcode/BBCodeEditor"));

// Dragging either side of the editor widens it into the margins, per device.
const EDITOR_WIDTH_KEY = "mania-hub-bbcode-width-v1";
const EDITOR_MIN_WIDTH = 760;

const TOOLBAR_GROUPS: Array<Array<{ label: ReturnType<typeof msg>; icon: ReactNode }>> = [
  [
    { label: msg`Bold`, icon: <Bold size={15} /> },
    { label: msg`Italic`, icon: <Italic size={15} /> },
    { label: msg`Underline`, icon: <Underline size={15} /> },
    { label: msg`Strikethrough`, icon: <Strikethrough size={15} /> },
    { label: msg`Spoiler text`, icon: <EyeOff size={15} /> },
  ],
  [
    { label: msg`Text color`, icon: <Palette size={15} /> },
    { label: msg`Gradient text`, icon: <Rainbow size={15} /> },
    { label: msg`Text size`, icon: <ALargeSmall size={15} /> },
  ],
  [
    { label: msg`Link`, icon: <Link size={15} /> },
    { label: msg`Image`, icon: <Image size={15} /> },
    { label: msg`YouTube video`, icon: <Youtube size={15} /> },
    { label: msg`Audio`, icon: <Music size={15} /> },
    { label: msg`Profile link`, icon: <UserRound size={15} /> },
  ],
  [
    { label: msg`Heading`, icon: <Heading1 size={15} /> },
    { label: msg`Center`, icon: <AlignCenter size={15} /> },
    { label: msg`Quote`, icon: <TextQuote size={15} /> },
    { label: msg`Notice`, icon: <Megaphone size={15} /> },
    { label: msg`Collapsible box`, icon: <ChevronsDownUp size={15} /> },
    { label: msg`Inline code`, icon: <Braces size={15} /> },
    { label: msg`Code block`, icon: <Code size={15} /> },
    { label: msg`Bullet list`, icon: <List size={15} /> },
    { label: msg`Numbered list`, icon: <ListOrdered size={15} /> },
    { label: msg`Imagemap (image with clickable areas)`, icon: <Map size={15} /> },
  ],
];

/** Renders the loaded editor's static chrome (header, toolbar, footer) for
    real so only the parts that depend on editor state show as skeletons,
    with matching paddings and heights so the swap doesn't shift. */
function BBCodeEditorSkeleton({ signedIn }: { signedIn: boolean }) {
  const { i18n } = useLingui();
  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden bg-osu-b4">
      {/* Header */}
      <div className="flex items-center gap-3 px-4 py-3 border-b border-osu-b3/30">
        <div className="min-w-0">
          <div className="text-[13px] font-bold text-osu-c1"><Trans>BBCode editor</Trans></div>
          <div className="text-[12px] text-osu-f1 truncate">
            <Trans>Edits stay in this browser. Copy the result and paste it into the me! editor on your osu! page.</Trans>
          </div>
        </div>
        <div className="ml-auto flex items-center gap-2 shrink-0">
          <button
            type="button"
            disabled
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[12px] font-semibold bg-osu-h1/20 border border-osu-h1/40 text-osu-c1 opacity-60"
          >
            <Copy size={14} />
            <Trans>Copy BBCode</Trans>
          </button>
        </div>
      </div>

      {/* Load me! page row */}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2 px-4 py-2.5 border-b border-osu-b3/30 bg-osu-b5/40">
        <span className="text-[12px] font-semibold text-osu-f1 shrink-0">
          {signedIn ? <Trans>Start from your live me! page</Trans> : <Trans>Load a player's me! page</Trans>}
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
            {group.map((tool, toolIndex) => (
              <button
                key={toolIndex}
                type="button"
                title={i18n._(tool.label)}
                aria-label={i18n._(tool.label)}
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
            <Trans>Visual</Trans>
          </button>
          <button
            type="button"
            disabled
            className="px-2.5 py-1 rounded-md text-[11px] font-semibold uppercase tracking-wide text-osu-f1 border border-transparent"
          >
            <Trans>BBCode</Trans>
          </button>
        </div>
      </div>

      {/* Editing surface: placeholder line where the hint text sits */}
      <div className="min-h-0 flex-1 px-4 py-3">
        <Skeleton className="h-3.5 w-80 max-w-full opacity-60" />
      </div>

      {/* Footer */}
      <div className="flex items-center gap-3 px-4 py-2 border-t border-osu-b3/30 text-[12px] text-osu-f1">
        {/* Same message as the loaded footer ("{0} characters") so the catalog holds one entry. */}
        <span><Trans>{0} characters</Trans></span>
        <span className="hidden sm:inline"><Trans>Draft autosaves locally</Trans></span>
      </div>
    </div>
  );
}

export const Route = createFileRoute("/bbcode")({
  head: ({ match }) => {
    const i18n = getI18n(match.context.locale);
    return pageSeo({
      title: i18n._(msg`BBCode editor`),
      description:
        i18n._(msg`Write and preview osu! profile BBCode for your me! page, with a live preview and one-click copy.`),
      path: "/bbcode",
      origin: match.context.origin,
      imageKind: "bbcode",
      imageTitle: "BBCode editor",
    });
  },
  component: BBCodePage,
});

function readEditorWidth(): number | null {
  try {
    const stored = Number.parseInt(window.localStorage.getItem(EDITOR_WIDTH_KEY) ?? "", 10);
    return Number.isFinite(stored) && stored >= EDITOR_MIN_WIDTH ? stored : null;
  } catch {
    return null;
  }
}

function writeEditorWidth(width: number | null) {
  try {
    if (width == null) window.localStorage.removeItem(EDITOR_WIDTH_KEY);
    else window.localStorage.setItem(EDITOR_WIDTH_KEY, String(width));
  } catch {
    // Quota or privacy mode; the width just resets next visit.
  }
}

function BBCodePage() {
  const { t } = useLingui();
  const { viewer } = useAuth();
  const columnRef = useRef<HTMLDivElement>(null);

  // Kept out of React state: a drag writes the column's width straight to the
  // DOM so it never re-renders the editor.
  const applyEditorWidth = useCallback((width: number | null) => {
    const column = columnRef.current;
    if (!column) return;
    if (width == null) column.style.removeProperty("--bbcode-editor-width");
    else column.style.setProperty("--bbcode-editor-width", `${width}px`);
  }, []);

  useLayoutEffect(() => {
    applyEditorWidth(readEditorWidth());
  }, [applyEditorWidth]);

  const startEditorResize = useCallback((event: ReactPointerEvent<HTMLDivElement>, side: -1 | 1) => {
    const column = columnRef.current;
    const row = column?.parentElement;
    if (!column || !row || event.button !== 0) return;
    event.preventDefault();
    const handle = event.currentTarget;
    handle.setPointerCapture(event.pointerId);
    const startX = event.clientX;
    const startWidth = column.getBoundingClientRect().width;
    let latest = Math.round(startWidth);
    // The column stays centered, so each side moves by half the change.
    const move = (moveEvent: PointerEvent) => {
      const next = startWidth + 2 * side * (moveEvent.clientX - startX);
      latest = Math.round(Math.min(row.clientWidth, Math.max(EDITOR_MIN_WIDTH, next)));
      applyEditorWidth(latest);
    };
    const end = () => {
      handle.removeEventListener("pointermove", move);
      handle.removeEventListener("pointerup", end);
      handle.removeEventListener("pointercancel", end);
      writeEditorWidth(latest);
    };
    handle.addEventListener("pointermove", move);
    handle.addEventListener("pointerup", end);
    handle.addEventListener("pointercancel", end);
  }, [applyEditorWidth]);

  const resetEditorWidth = useCallback(() => {
    applyEditorWidth(null);
    writeEditorWidth(null);
  }, [applyEditorWidth]);

  return (
    // The editor is the page: it takes the viewport under the fixed nav and
    // scrolls inside its panes, not the document.
    <div className="relative flex h-[calc(100dvh-60px)] flex-col">
      {/* Same fill as the editor so its column does not read as a cut-out. */}
      <div className="relative z-10 flex min-h-0 flex-1 flex-col overflow-clip bg-osu-b4">
        <BBCodeDoodles />
        <div className="relative z-10 flex min-h-0 flex-1 flex-col">
          <PageHeader iconSrc="/images/icons/profile.svg" title={t`osu! profile BBCode editor`} />
          {/* Same column as the page header so the toolbar lines up with the title. */}
          <div
            ref={columnRef}
            className="relative mx-auto flex w-full max-w-[var(--bbcode-editor-width,1200px)] min-h-0 flex-1 flex-col px-4 pt-4 sm:px-5"
          >
            {([-1, 1] as const).map((side) => (
              <div
                key={side}
                aria-hidden
                title={t`Drag to resize, double-click to reset`}
                onPointerDown={(event) => startEditorResize(event, side)}
                onDoubleClick={resetEditorWidth}
                className={`group absolute inset-y-0 z-10 hidden w-4 cursor-col-resize touch-none sm:w-5 lg:block ${
                  side < 0 ? "left-0" : "right-0"
                }`}
              >
                <div className={`h-full w-0.5 transition-colors group-hover:bg-osu-h1/70 ${side < 0 ? "ml-auto" : ""}`} />
              </div>
            ))}
            <Suspense fallback={<BBCodeEditorSkeleton signedIn={!!viewer} />}>
              <BBCodeEditorLazy
                userId={viewer?.id ?? null}
                username={viewer?.username}
                initialSource={null}
                enableLoadFromUser={!viewer}
                enableLoadOwnPage={!!viewer}
                layout="page"
              />
            </Suspense>
          </div>
        </div>
      </div>
    </div>
  );
}
