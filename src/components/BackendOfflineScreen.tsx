import { Trans } from "@lingui/react/macro";

export function BackendOfflineScreen() {
  return (
    <div className="flex-1 flex flex-col items-center justify-center gap-5 px-6 py-24 text-center">
      <div className="flex items-center gap-3">
        <span className="mode-icon text-osu-pink text-4xl">{""}</span>
        <h1 className="text-3xl sm:text-4xl font-black text-white tracking-tight" style={{ fontFamily: "Torus" }}>
          mania <span className="text-osu-pink">hub</span>
        </h1>
      </div>
      <div className="text-sm font-semibold text-white"><Trans>Temporarily offline</Trans></div>
      <p className="max-w-sm text-[12px] leading-relaxed text-osu-f1">
        <Trans>Probably restarting or under maintenance. Try again in a bit.</Trans>
      </p>
      <button
        type="button"
        onClick={() => {
          if (typeof window !== "undefined") window.location.reload();
        }}
        className="rounded-md bg-osu-pink/20 px-4 py-2 text-xs font-semibold text-white hover:bg-osu-pink/30 transition-colors"
      >
        <Trans>Try again</Trans>
      </button>
    </div>
  );
}
