import { createFileRoute, notFound } from "@tanstack/react-router";

export const Route = createFileRoute("/admin/dan-classifier")({
  head: () => ({
    meta: [
      { title: "Dan Classifier - dev" },
      { name: "robots", content: "noindex, nofollow" },
    ],
  }),
  beforeLoad: () => {
    if (typeof window !== "undefined") {
      const host = window.location.hostname;
      const isLocal = host === "localhost" || host === "127.0.0.1" || host === "::1";
      const isDevMode = import.meta.env.VITE_DEV_MODE === "1";
      if (!isLocal && !isDevMode) throw notFound();
    } else if (process.env.VITE_DEV_MODE !== "1" && process.env.NODE_ENV === "production") {
      throw notFound();
    }
  },
  component: DanClassifierPage,
});

function DanClassifierPage() {
  return (
    <main className="min-h-screen bg-osu-b5 text-osu-c1">
      <div className="max-w-[1200px] mx-auto px-5 py-7 sm:py-10">
        <div className="pb-6 border-b border-osu-b3/30">
          <div className="text-[11px] uppercase tracking-[0.16em] text-osu-yellow font-bold">
            Admin
          </div>
          <h1 className="mt-1 text-2xl sm:text-3xl font-black text-white">
            Dan Classifier
          </h1>
          <div className="mt-2 text-sm text-osu-f1">
            Placeholder route for the upcoming dan classification tool.
          </div>
        </div>

        <section className="mt-6 rounded-lg border border-osu-b3/30 bg-osu-b4/35 p-5">
          <div className="text-sm font-bold text-white">Ready for later</div>
          <div className="mt-2 text-sm text-osu-f1">
            This admin surface is intentionally empty until the classifier work starts.
          </div>
        </section>
      </div>
    </main>
  );
}
