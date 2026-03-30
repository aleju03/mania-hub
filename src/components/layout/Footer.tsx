export function Footer() {
  return (
    <footer className="bg-osu-b5 border-t border-osu-b3/20 mt-auto">
      <div className="max-w-[1200px] mx-auto px-5 py-6 flex flex-col md:flex-row items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <img src="/images/layout/osu-logo-white.svg" alt="osu!" width={20} height={20} className="opacity-40" />
          <span className="text-[10px] text-osu-f1">
            osu!mania hub - Design inspired by osu! &copy; ppy Pty Ltd
          </span>
        </div>
        <div className="flex gap-4 text-[10px]">
          <a href="https://osu.ppy.sh" target="_blank" rel="noreferrer" className="text-osu-f1 hover:text-white transition-colors duration-[120ms]">osu!</a>
          <a href="https://osu.ppy.sh/wiki/en/Game_mode/osu!mania" target="_blank" rel="noreferrer" className="text-osu-f1 hover:text-white transition-colors duration-[120ms]">mania wiki</a>
        </div>
      </div>
    </footer>
  );
}
