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
  F: "GradeSmall-D",
};

export function GradeImg({ grade, size = 32 }: { grade: string; size?: number }) {
  const file = gradeFile[grade] ?? `GradeSmall-${grade}`;
  return (
    <img
      src={`/images/badges/score-ranks-v2019/${file}.svg`}
      alt={grade}
      width={size}
      height={size}
    />
  );
}
