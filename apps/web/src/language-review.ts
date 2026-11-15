export type LocatableCorrection = {
  readonly correctionId: string;
  readonly replacement: string;
};

export type LocatedCorrection<T extends LocatableCorrection> = {
  readonly correction: T;
  readonly correctionIndex: number;
  readonly start: number;
  readonly end: number;
};

export function locateCorrections<T extends LocatableCorrection>(text: string, corrections: readonly T[]): readonly LocatedCorrection<T>[] {
  const lower = text.toLocaleLowerCase();
  const occupied: Array<{ start: number; end: number }> = [];
  const located: LocatedCorrection<T>[] = [];
  corrections.forEach((correction, correctionIndex) => {
    const needle = correction.replacement.toLocaleLowerCase();
    if (!needle) return;
    let start = lower.indexOf(needle);
    while (start >= 0) {
      const end = start + needle.length;
      if (!occupied.some((range) => start < range.end && end > range.start)) {
        occupied.push({ start, end });
        located.push({ correction, correctionIndex, start, end });
        break;
      }
      start = lower.indexOf(needle, start + 1);
    }
  });
  return located.sort((a, b) => a.start - b.start || a.correctionIndex - b.correctionIndex);
}
