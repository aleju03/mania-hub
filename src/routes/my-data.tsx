import { createFileRoute } from "@tanstack/react-router";

import { MyDataPanel } from "../components/me/MyDataPanel";

export const Route = createFileRoute("/my-data")({
  head: () => ({
    meta: [
      { title: "My Data" },
      { name: "description", content: "" },
      { name: "robots", content: "noindex, nofollow" },
    ],
  }),
  component: MyDataPanel,
});
