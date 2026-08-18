import { createFileRoute } from "@tanstack/react-router";

import { DynamicRendersPanel } from "../components/me/DynamicRendersPanel";

export const Route = createFileRoute("/dynamic-renders")({
  head: () => ({
    meta: [
      { title: "Dynamic Renders" },
      { name: "description", content: "" },
      { name: "robots", content: "noindex, nofollow" },
    ],
  }),
  component: DynamicRendersPanel,
});
