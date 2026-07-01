import { createFileRoute } from "@tanstack/react-router";

import { MyDataPanel } from "../components/me/MyDataPanel";

export const Route = createFileRoute("/my-stats")({
  head: () => ({
    meta: [
      { title: "My Stats" },
      { name: "description", content: "" },
      { name: "robots", content: "noindex, nofollow" },
    ],
  }),
  component: MyDataPanel,
});
