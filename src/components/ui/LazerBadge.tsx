export function LazerBadge() {
  return (
    <span
      className="inline-flex items-center px-1.5 py-[3px] rounded flex-shrink-0"
      style={{
        background: "linear-gradient(135deg, #6644cc, #8866ee)",
        boxShadow: "0 0 6px rgba(136, 102, 238, 0.3), inset 0 1px 0 rgba(170, 136, 255, 0.25)",
      }}
      title="Played on osu!lazer"
    >
      <span
        className="text-[8px] font-bold tracking-[0.06em]"
        style={{
          fontFamily: "Torus, sans-serif",
          color: "rgba(255, 255, 255, 0.92)",
        }}
      >
        LAZER
      </span>
    </span>
  );
}
