type OsuTriangle = { points: string; opacity: number; className?: string };

const PATTERN_WIDTH = 1920;
const PATTERN_HEIGHT = 1080;

const OSU_TRIANGLES: OsuTriangle[] = [
  { points: "0,0 320,540 0,1080", opacity: 0.042, className: "text-osu-pink-light" },
  { points: "0,0 640,0 320,540", opacity: 0.02 },
  { points: "640,0 960,540 320,540", opacity: 0.03 },
  { points: "640,0 1280,0 960,540", opacity: 0.018 },
  { points: "1280,0 1600,540 960,540", opacity: 0.026 },
  { points: "1280,0 1920,0 1600,540", opacity: 0.018 },
  { points: "1920,0 1920,1080 1600,540", opacity: 0.034 },
  { points: "0,1080 320,540 640,1080", opacity: 0.026 },
  { points: "320,540 960,540 640,1080", opacity: 0.018 },
  { points: "960,540 1280,1080 640,1080", opacity: 0.032 },
  { points: "960,540 1600,540 1280,1080", opacity: 0.02 },
  { points: "1600,540 1920,1080 1280,1080", opacity: 0.028 },
  { points: "1600,540 1920,0 1920,1080", opacity: 0.016 },
  { points: "320,540 640,0 640,1080", opacity: 0.012 },
  { points: "960,540 1280,0 1280,1080", opacity: 0.014 },
];

export function OsuTriangleBackdrop() {
  return (
    <div className="pointer-events-none absolute inset-0 overflow-hidden" aria-hidden="true">
      <div className="absolute inset-0 bg-[radial-gradient(circle_at_18%_12%,rgba(255,102,171,0.06),transparent_30%),radial-gradient(circle_at_82%_24%,rgba(102,204,255,0.035),transparent_28%)]" />
      <svg
        className="absolute inset-0 h-full w-full text-osu-pink opacity-60"
      >
        <defs>
          <pattern id="osu-triangle-backdrop" width={PATTERN_WIDTH} height={PATTERN_HEIGHT} patternUnits="userSpaceOnUse">
            {OSU_TRIANGLES.map((triangle, index) => (
              <polygon
                key={index}
                points={triangle.points}
                fill="currentColor"
                fillOpacity={triangle.opacity}
                className={triangle.className}
              />
            ))}
          </pattern>
        </defs>
        <rect width="100%" height="100%" fill="url(#osu-triangle-backdrop)" />
      </svg>
      <div className="absolute inset-0 bg-gradient-to-b from-osu-b6/40 via-osu-b5/70 to-osu-b6/90" />
    </div>
  );
}
