const gradeFile: Record<string, string> = {
  XH: "GradeSmall-SS-Silver",
  X: "GradeSmall-SS",
  SH: "GradeSmall-S-Silver",
  S: "GradeSmall-S",
  A: "GradeSmall-A",
  B: "GradeSmall-B",
  C: "GradeSmall-C",
  D: "GradeSmall-D",
  SS: "GradeSmall-SS",
  SSH: "GradeSmall-SS-Silver",
  F: "GradeSmall-F",
};

const preloadedGrades = new Set<string>();

export function GradeImg({ grade, size = 32 }: { grade: string; size?: number }) {
  const file = gradeFile[grade] ?? `GradeSmall-${grade}`;
  const src = `/images/badges/score-ranks-v2019/${file}.svg`;

  if (typeof window !== "undefined" && !preloadedGrades.has(src)) {
    const image = new Image();
    image.decoding = "async";
    image.src = src;
    preloadedGrades.add(src);
  }

  return (
    <img
      src={src}
      alt={grade}
      width={size}
      height={size}
      loading="eager"
      decoding="async"
      fetchPriority="high"
    />
  );
}
