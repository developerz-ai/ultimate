// Which boundaries a crash proof kills at. A loop's steps named by row id are one point of the
// code, not one per row: each boundary shape is killed at its first and its last occurrence, so the
// proof costs what the job's code has, never what the database holds. Pure: labels in, indexes out.

/** Kill points one mode of a proof may cost; past it the proof refuses, `X_JOB_CRASH_UNBOUNDED`. */
export const CRASH_POINT_BOUND = 32;

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
/** A ULID, a hex digest, a cuid: eight or more letters and digits with a digit among them. */
const TOKEN = /\b(?=[A-Za-z]*\d)[A-Za-z0-9]{8,}\b/g;
const DIGITS = /\d+/g;

/** `fanout:<id>`, `page-<n>`, `sleep:<n>h (sleeping)`: a boundary label with its ids taken out. */
export const boundaryShape = (label: string): string =>
  label.replace(UUID, '<id>').replace(TOKEN, '<id>').replace(DIGITS, '<n>');

/**
 * The 1-based positions to kill at, in order: the first and the last boundary of every shape.
 * The first proves the code before the loop and the loop's own body; the last, every row before it
 * replayed and the code after it — an effect between any two rows is made again at the last.
 */
export function crashPoints(labels: readonly string[]): readonly number[] {
  const first = new Map<string, number>();
  const last = new Map<string, number>();
  labels.forEach((label, i) => {
    const shape = boundaryShape(label);
    if (!first.has(shape)) first.set(shape, i + 1);
    last.set(shape, i + 1);
  });
  return [...new Set([...first.values(), ...last.values()])].sort((a, b) => a - b);
}

/** The distinct shapes of `labels`, first seen first — what an unbounded refusal names. */
export const boundaryShapes = (labels: readonly string[]): readonly string[] => [
  ...new Set(labels.map(boundaryShape)),
];
