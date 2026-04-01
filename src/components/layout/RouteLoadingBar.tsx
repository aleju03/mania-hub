import { useRouterState } from "@tanstack/react-router";

export function RouteLoadingBar() {
  const isPending = useRouterState({
    select: (state) => state.status === "pending",
  });

  return (
    <div
      className={`fixed top-[60px] left-0 right-0 z-40 h-[2px] transition-opacity duration-150 ${
        isPending ? "opacity-100" : "opacity-0"
      }`}
      aria-hidden="true"
    >
      <div className="h-full w-full origin-left bg-gradient-to-r from-osu-pink via-osu-yellow to-osu-blue animate-pulse" />
    </div>
  );
}
