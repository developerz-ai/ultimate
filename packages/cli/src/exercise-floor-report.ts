// The `exercise` floor applied where the verdict is: the gate step reads the `.x/exercise.json` its
// child just wrote and judges it (`exercise-floor-verdict.ts`), and `x upgrade` reads the same file
// for the figures an upgraded app's ratchet starts at. A report the run did not rewrite is never
// judged — a child that died before writing would otherwise be judged by the last pass's numbers.

// why: Bun ships no path joiner.
import { join } from 'node:path';
import { t } from '@ultimat3/schema';
import { EXERCISE_REPORT_FILE } from './exercise-findings';
import type { ExerciseFloor } from './exercise-floor';
import { EXERCISE_FIELD, unprovenTally } from './exercise-floor';
import type { FloorRecord } from './exercise-floor-verdict';
import { exerciseFloorVerdict, FLOOR_CODES, measuredStatementsMax } from './exercise-floor-verdict';
import { readVerifyFloor } from './verify-floor';
import type { VerifyStep } from './verify-step';

const PROOF = t.optional(
  t.object({
    verdict: t.string,
    reason: t.optional(t.string),
    seed: t.optional(t.object({ entity: t.string, table: t.string, cause: t.string })),
  }),
);
const CEILING = t.optional(
  t.object({
    verdict: t.string,
    statements: t.number,
    max: t.number,
    why: t.optional(t.string),
    declared: t.optional(t.boolean),
    top: t.optional(t.array(t.object({ fingerprint: t.string, count: t.number }))),
  }),
);
const REPORT = t.object({
  records: t.array(
    t.object({
      kind: t.string,
      name: t.string,
      outcome: t.string,
      tenant: PROOF,
      crash: PROOF,
      scale: PROOF,
      statementCeiling: CEILING,
    }),
  ),
});

const reportFile = (root: string): Bun.BunFile => Bun.file(join(root, EXERCISE_REPORT_FILE));

/** The report's modification stamp, or `undefined` with no report: what "rewritten" is judged by. */
export const exerciseReportStamp = async (root: string): Promise<number | undefined> => {
  const file = reportFile(root);
  return (await file.exists()) ? file.lastModified : undefined;
};

/** The report's records, when the file exists and parses. */
export async function readExerciseRecords(
  root: string,
): Promise<readonly FloorRecord[] | undefined> {
  const file = reportFile(root);
  if (!(await file.exists())) return undefined;
  const parsed = REPORT.safeParse(await file.json().catch(() => undefined));
  // The schema checked every field the verdict reads; verdict strings are compared, never trusted.
  return parsed.issues === undefined ? (parsed.value.records as readonly FloorRecord[]) : undefined;
}

/**
 * `step` (the `exercise` gate step), then the floor's verdict on the report it wrote. The child
 * judged the same report with the same function; its copies of the floor's codes are dropped so
 * each is said once, and a child red only on them is green here when the verdict is.
 */
export function withUnprovenFloor(step: VerifyStep): VerifyStep {
  return {
    ...step,
    async run(ctx) {
      // The file's own stamp before and after, never the clock: a test's frozen `Date.now` and the
      // filesystem's real one are two clocks, and a report this run did not rewrite is not judged.
      const before = await exerciseReportStamp(ctx.root);
      const outcome = await step.run(ctx);
      const after = await exerciseReportStamp(ctx.root);
      if (after === undefined || after === before) return outcome;
      const records = await readExerciseRecords(ctx.root);
      if (records === undefined) return outcome;
      const verdict = exerciseFloorVerdict(records, (await readVerifyFloor(ctx.root))?.exercise);
      const own = outcome.findings.filter((finding) => !FLOOR_CODES.has(finding.code));
      const onlyFloor = !outcome.ok && outcome.findings.length > 0 && own.length === 0;
      const warnings = [...(outcome.warnings ?? []), ...verdict.warnings];
      return {
        ...outcome,
        ok: (outcome.ok || onlyFloor) && verdict.findings.length === 0,
        findings: [...own, ...verdict.findings],
        ...(warnings.length === 0 ? {} : { warnings }),
      };
    },
  };
}

/** The figures `x upgrade` writes as the app's ratchet: the last pass's, or `undefined` with none. */
export async function measuredExerciseFloor(
  root: string,
): Promise<Required<ExerciseFloor> | undefined> {
  const records = await readExerciseRecords(root);
  return records === undefined
    ? undefined
    : { unprovenMax: unprovenTally(records).figure, statementsMax: measuredStatementsMax(records) };
}

/**
 * `x.verify.json`'s text with each `exercise` figure given, every other key untouched. A figure
 * already at or under the one given is kept: the ratchet only falls. Text that is not a JSON
 * object is returned as it was — the `manifest` step already reports that file's problems.
 */
export function withExerciseFloor(text: string, figures: ExerciseFloor): string {
  let payload: unknown;
  try {
    payload = JSON.parse(text);
  } catch {
    return text;
  }
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) return text;
  const record = payload as Record<string, unknown>;
  const current = record[EXERCISE_FIELD];
  const section =
    typeof current === 'object' && current !== null && !Array.isArray(current)
      ? (current as Record<string, unknown>)
      : {};
  const next: Record<string, unknown> = { ...section };
  let changed = false;
  for (const [key, figure] of Object.entries(figures)) {
    if (typeof figure !== 'number') continue;
    const held = section[key];
    if (typeof held === 'number' && held <= figure) continue;
    next[key] = figure;
    changed = true;
  }
  if (!changed) return text;
  return `${JSON.stringify({ ...record, [EXERCISE_FIELD]: next }, null, 2)}\n`;
}
