import { ImageResponse } from "@vercel/og";
import { createFileRoute } from "@tanstack/react-router";
import { createElement as h } from "react";

const WIDTH = 1200;
const HEIGHT = 630;
const MAX_TITLE_LEN = 38;
const MAX_SUBTITLE_LEN = 150;
const SUBTITLE_LINE_CHARS = 48;
const SUBTITLE_MAX_LINES = 2;

const fontCache = new Map<string, Promise<ArrayBuffer>>();

function clamp(value: string | null | undefined, max: number): string {
  if (!value) return "";
  const trimmed = value.trim();
  if (trimmed.length <= max) return trimmed;
  return `${trimmed.slice(0, max - 1)}...`;
}

function wrapText(value: string, maxChars: number, maxLines: number): string[] {
  const words = value.trim().split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let current = "";

  for (const word of words) {
    const next = current ? `${current} ${word}` : word;
    if (next.length <= maxChars) {
      current = next;
      continue;
    }

    if (current) lines.push(current);
    current = word;

    if (lines.length === maxLines) break;
  }

  if (current && lines.length < maxLines) lines.push(current);

  if (lines.length === maxLines && words.join(" ").length > lines.join(" ").length) {
    const last = lines[maxLines - 1] ?? "";
    lines[maxLines - 1] = `${last.slice(0, Math.max(0, maxChars - 1)).trimEnd()}...`;
  }

  return lines;
}

function getFont(request: Request, fileName: string): Promise<ArrayBuffer> {
  const url = new URL(`/fonts/${fileName}`, request.url).toString();
  const cached = fontCache.get(url);
  if (cached) return cached;

  const promise = fetch(url).then(async (response) => {
    if (!response.ok) {
      throw new Error(`Failed to load font ${fileName}: ${response.status}`);
    }
    return response.arrayBuffer();
  });

  fontCache.set(url, promise);
  promise.catch(() => fontCache.delete(url));
  return promise;
}

export const Route = createFileRoute("/api/og")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const url = new URL(request.url);
        const title = clamp(url.searchParams.get("title"), MAX_TITLE_LEN) || "o!mania tracker";
        const subtitle = clamp(url.searchParams.get("subtitle"), MAX_SUBTITLE_LEN) ||
          "Rankings, scores, top plays, maps, and replays by country.";
        const subtitleLines = wrapText(subtitle, SUBTITLE_LINE_CHARS, SUBTITLE_MAX_LINES);

        const [regularFont, heavyFont] = await Promise.all([
          getFont(request, "Torus-Regular.otf"),
          getFont(request, "Torus-Heavy.otf"),
        ]);

        const response = new ImageResponse(
          h(
            "div",
            {
              style: {
                width: "100%",
                height: "100%",
                display: "flex",
                position: "relative",
                overflow: "hidden",
                background: "linear-gradient(135deg, #1a1517 0%, #2a1a26 100%)",
              },
            },
            [
              h("div", {
                key: "glow",
                style: {
                  position: "absolute",
                  inset: "0",
                  background:
                    "radial-gradient(circle at 22% 34%, rgba(255, 102, 170, 0.22) 0%, rgba(255, 102, 170, 0) 48%)",
                },
              }),
              h(
                "div",
                {
                  key: "content",
                  style: {
                    position: "relative",
                    zIndex: "1",
                    display: "flex",
                    flexDirection: "column",
                    width: "100%",
                    height: "100%",
                    padding: "80px",
                    color: "#ffffff",
                    fontFamily: '"Torus OG"',
                  },
                },
                [
                  h("div", {
                    key: "bar",
                    style: {
                      width: "60px",
                      height: "6px",
                      borderRadius: "999px",
                      background: "#ff66aa",
                      marginBottom: "30px",
                    },
                  }),
                  h(
                    "div",
                    {
                      key: "eyebrow",
                      style: {
                        fontSize: "28px",
                        fontWeight: 900,
                        letterSpacing: "0.18em",
                        color: "#ff99cc",
                        marginBottom: "88px",
                      },
                    },
                    "O!MANIA TRACKER",
                  ),
                  h(
                    "div",
                    {
                      key: "title",
                      style: {
                        fontSize: "82px",
                        fontWeight: 900,
                        lineHeight: "1.02",
                        maxWidth: "980px",
                        marginBottom: "52px",
                      },
                    },
                    title,
                  ),
                  h(
                    "div",
                    {
                      key: "subtitle",
                      style: {
                        display: "flex",
                        flexDirection: "column",
                        gap: "6px",
                        maxWidth: "980px",
                        color: "#c7b8c1",
                        fontSize: "34px",
                        lineHeight: "1.2",
                      },
                    },
                    subtitleLines.map((line, index) =>
                      h(
                        "div",
                        { key: `subtitle-${index}` },
                        line,
                      )),
                  ),
                  h(
                    "div",
                    {
                      key: "footer",
                      style: {
                        marginTop: "auto",
                        color: "#7a6b74",
                        fontSize: "22px",
                      },
                    },
                    "osu!mania rankings | top plays | replays",
                  ),
                ],
              ),
            ],
          ),
          {
            width: WIDTH,
            height: HEIGHT,
            fonts: [
              { name: "Torus OG", data: regularFont, style: "normal", weight: 400 },
              { name: "Torus OG", data: heavyFont, style: "normal", weight: 900 },
            ],
          },
        );

        response.headers.set(
          "Cache-Control",
          "public, max-age=3600, s-maxage=86400, stale-while-revalidate=604800",
        );
        return response;
      },
    },
  },
});
