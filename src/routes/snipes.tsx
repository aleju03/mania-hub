import { createFileRoute } from "@tanstack/react-router";
import { PageHeader } from "../components/layout/PageHeader";

export const Route = createFileRoute("/snipes")({
  component: SnipesPage,
});

function SnipesPage() {
  return (
    <div className="flex-1">
      <PageHeader
        iconSrc="/images/icons/sniper.webp"
        title="CR mania snipes"
      />
      <div className="bg-osu-b5 flex-1">
        <div className="max-w-[1200px] mx-auto px-5 py-40 text-center">
          <span className="text-2xl font-bold text-osu-f1">no.</span>
        </div>
      </div>
    </div>
  );
}
