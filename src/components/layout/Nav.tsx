import { motion } from "framer-motion";
import { Link, useLocation, useNavigate } from "@tanstack/react-router";
import { SearchInput } from "../ui/SearchInput";
import { searchUsers } from "../../lib/osu";
import { useAppStore } from "../../store";

const links = [
  { id: "home", to: "/", label: "home" },
  { id: "rankings", to: "/rankings", label: "rankings" },
  { id: "scores", to: "/scores", label: "tracker" },
  { id: "popoffs", to: "/popoffs", label: "pop-offs" },
  { id: "replay", to: "/replay", label: "replay" },
] as const;

export function Nav() {
  const location = useLocation();
  const navigate = useNavigate();
  const current = links.find((l) => location.pathname.startsWith(l.to === "/" ? "/__home" : l.to)) ||
    (location.pathname === "/" ? links[0] : location.pathname.startsWith("/player") ? null : links[0]);

  const handleSearch = async (q: string) => {
    const res = await searchUsers({ data: { query: q } });
    return (res.user?.data ?? []).slice(0, 6).map((u: { id: number; username: string; avatar_url: string; country_code: string }) => ({
      id: u.id,
      username: u.username,
      avatar_url: u.avatar_url,
      country_code: u.country_code,
    }));
  };

  return (
    <header className="fixed top-0 left-0 right-0 z-50">
      <div className="absolute inset-0 bg-osu-b6">
        <img
          src="/images/layout/nav2-background-hue0.png"
          alt=""
          className="absolute inset-0 w-full h-full object-cover opacity-60"
          style={{ filter: "hue-rotate(333deg) saturate(0.8)" }}
        />
      </div>
      <div className="absolute inset-0 bg-[#111]/70" />
      <div
        className="absolute bottom-0 left-0 right-0 h-px"
        style={{ background: "hsl(333,100%,70%,0.2)" }}
      />
      <nav className="relative flex items-center justify-between h-[60px] px-5 max-w-[1200px] mx-auto">
        <div className="flex items-center gap-1">
          <motion.div
            className="cursor-pointer mr-2"
            whileHover={{ scale: 1.11 }}
            transition={{ duration: 0.1 }}
          >
            <Link to="/" preload="intent" className="flex items-center gap-2">
              <div className="relative w-10 h-10">
                <div
                  className="absolute inset-0"
                  style={{
                    background: "linear-gradient(180deg, #002b7f 20%, #fff 20%, #fff 35%, #ce1126 35%, #ce1126 65%, #fff 65%, #fff 80%, #002b7f 80%)",
                    maskImage: "url(/images/layout/osu-logo-circle.svg)",
                    WebkitMaskImage: "url(/images/layout/osu-logo-circle.svg)",
                    maskSize: "contain",
                    WebkitMaskSize: "contain",
                    maskRepeat: "no-repeat",
                    WebkitMaskRepeat: "no-repeat",
                    maskPosition: "center",
                    WebkitMaskPosition: "center",
                  }}
                />
                <div
                  className="absolute inset-0"
                  style={{
                    background: "white",
                    maskImage: "url(/images/layout/osu-logo-text.svg)",
                    WebkitMaskImage: "url(/images/layout/osu-logo-text.svg)",
                    maskSize: "contain",
                    WebkitMaskSize: "contain",
                    maskRepeat: "no-repeat",
                    WebkitMaskRepeat: "no-repeat",
                    maskPosition: "center",
                    WebkitMaskPosition: "center",
                  }}
                />
              </div>
              <span className="mode-icon text-osu-pink text-lg" title="mania">{"\ue802"}</span>
            </Link>
          </motion.div>
          {links.map((l) => (
            <Link
              key={l.id}
              to={l.to}
              preload="intent"
              className={`relative px-2.5 py-[19px] text-[12px] font-semibold capitalize transition-colors duration-[120ms] ${
                current?.id === l.id
                  ? "text-white"
                  : "text-osu-pink-light hover:text-white"
              }`}
            >
              {l.label}
              {current?.id === l.id && (
                <motion.div
                  layoutId="nav-bar"
                  className="absolute bottom-0 left-2 right-2 h-[3px] rounded-full bg-osu-yellow"
                  transition={{ type: "spring", stiffness: 500, damping: 35 }}
                />
              )}
            </Link>
          ))}
        </div>
        <div className="flex items-center gap-2">
          {import.meta.env.VITE_DEV_MODE === "1" && (
            <button
              onClick={() => {
                useAppStore.persist.clearStorage();
                window.location.reload();
              }}
              className="px-2 py-1 rounded-lg bg-osu-red/20 text-[10px] text-osu-red font-semibold hover:bg-osu-red/30 transition-colors cursor-pointer border border-osu-red/30"
              title="Clear all cached data and reload"
            >
              Clear cache
            </button>
          )}
          <SearchInput
            className="w-52"
            placeholder="find player..."
            onSearch={handleSearch}
            onSelect={(u) => navigate({ to: "/player/$username", params: { username: u.username } })}
          />
        </div>
      </nav>
    </header>
  );
}
