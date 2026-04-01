import { HeadContent, Scripts, createRootRoute } from "@tanstack/react-router";
import { Nav } from "../components/layout/Nav";
import { RouteLoadingBar } from "../components/layout/RouteLoadingBar";
import appCss from "../styles.css?url";

export const Route = createRootRoute({
  head: () => ({
    meta: [
      { charSet: "utf-8" },
      { name: "viewport", content: "width=device-width, initial-scale=1" },
      { title: "osu!mania hub" },
    ],
    links: [
      { rel: "icon", type: "image/webp", href: "/favicon.webp" },
      { rel: "stylesheet", href: appCss },
      {
        rel: "preload",
        href: "/fonts/Torus-Heavy.otf",
        as: "font",
        type: "font/otf",
        crossOrigin: "anonymous",
      },
    ],
  }),
  shellComponent: RootDocument,
});

function RootDocument({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <head>
        <HeadContent />
      </head>
      <body className="min-h-screen flex flex-col font-sans antialiased">
        <Nav />
        <RouteLoadingBar />
        <main className="flex-1 pt-[60px]">{children}</main>
        <Scripts />
      </body>
    </html>
  );
}
