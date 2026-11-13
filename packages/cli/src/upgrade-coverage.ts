// A Bun-floor hop's coverage rebaseline: Bun 1.4.4 counted functions differently with no test or
// source changed, so a hop that moves the Bun floor measures the unit suite once (the installed
// CLI's `verify --only unit`) and, only when that lands under the stated floor, moves the floor to
// what it measured with a dated `why`. Written into the hop's diff and reported, never silently.

// why: Bun exposes no path-join primitive; `x.verify.json` sits at the app root.
import { join } from 'node:path';
import { t } from '@ultimat3/schema';
import type { CoverageFloor } from './coverage-floor';
import { COVERAGE_FIELD, floorFor, readCoverageFloor, shown } from './coverage-floor';
import { msg } from './messages';
import { documentIn } from './upgrade-document';
import type { InstalledCli } from './upgrade-guards';
import { parseJson } from './upgrade-registry';
import { VERIFY_FLOOR_FILE } from './verify-floor';

const NUMBERS = t.object({ lines: t.number, funcs: t.number });
const UNIT = t.object({
  steps: t.array(
    t.object({
      name: t.string,
      findings: t.optional(t.array(t.object({ code: t.string }))),
    }),
  ),
  data: t.object({ coverage: t.object({ unit: NUMBERS }) }),
});

interface Numbers {
  readonly lines: number;
  readonly funcs: number;
}

/** What the `why` says about the hop that moved the floor. */
export interface CoverageRebaseline {
  readonly release: string;
  readonly bunFrom: string | null;
  readonly bunTo: string;
  /** `YYYY-MM-DD`, UTC: the day the measurement was taken. */
  readonly today: string;
}

/** What the report carries: the floor before, the one written, and the measurement behind it. */
export interface HopCoverage {
  readonly file: string;
  readonly measured: Numbers;
  readonly from: Numbers;
  readonly to: Numbers;
  readonly why: string;
}

/** The app's floor file, as an object, with the coverage floor in it — or undefined: nothing to move. */
export async function statedCoverage(
  root: string,
): Promise<
  { readonly payload: Record<string, unknown>; readonly floor: CoverageFloor } | undefined
> {
  const file = Bun.file(join(root, VERIFY_FLOOR_FILE));
  if (!(await file.exists())) return undefined;
  const payload = parseJson(await file.text());
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) return undefined;
  const record = payload as Record<string, unknown>;
  const floor = readCoverageFloor(record).coverage;
  return floor === undefined ? undefined : { payload: record, floor };
}

/** Measures once; moves only the number that fell under its floor, and only to what was measured. */
export async function rebaselineCoverage(input: {
  readonly cli: InstalledCli;
  readonly root: string;
  readonly stated: NonNullable<Awaited<ReturnType<typeof statedCoverage>>>;
  readonly bun: CoverageRebaseline;
}): Promise<HopCoverage | null> {
  const { cli, root, stated, bun } = input;
  const parsed = UNIT.safeParse(
    documentIn((await cli(['verify', '--only', 'unit', '--json'])).stdout),
  );
  if (parsed.issues !== undefined) return null;
  const document = parsed.value as {
    readonly steps: readonly { name: string; findings?: readonly { code: string }[] }[];
    readonly data: { readonly coverage: { readonly unit: Numbers } };
  };
  const below = document.steps
    .find((step) => step.name === 'unit')
    ?.findings?.some((finding) => finding.code === 'X_COVERAGE_BELOW_FLOOR');
  if (below !== true) return null;
  const measured = document.data.coverage.unit;
  const from = { lines: stated.floor.lines, funcs: stated.floor.funcs };
  const to = {
    lines: measured.lines < from.lines ? floorFor(measured.lines) : from.lines,
    funcs: measured.funcs < from.funcs ? floorFor(measured.funcs) : from.funcs,
  };
  const said = msg('cli.upgrade.coverage.why', {
    date: bun.today,
    release: bun.release,
    bunFrom: bun.bunFrom ?? msg('cli.upgrade.coverage.unpinned'),
    bunTo: bun.bunTo,
    lines: shown(measured.lines),
    funcs: shown(measured.funcs),
    fromLines: String(from.lines),
    fromFuncs: String(from.funcs),
    toLines: String(to.lines),
    toFuncs: String(to.funcs),
  });
  const why = stated.floor.why === undefined ? said : `${said} ${stated.floor.why}`;
  const raw = stated.payload[COVERAGE_FIELD] as Record<string, unknown>;
  const next = { ...stated.payload, [COVERAGE_FIELD]: { ...raw, ...to, why } };
  await Bun.write(join(root, VERIFY_FLOOR_FILE), `${JSON.stringify(next, null, 2)}\n`);
  return { file: VERIFY_FLOOR_FILE, measured, from, to, why };
}
