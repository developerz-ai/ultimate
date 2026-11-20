// A hop's coverage ratchet: a gate whose `unit` step says `X_COVERAGE_FLOOR_STALE` — the tree
// covers more than `x.verify.json` states, a codemod's test among the causes — gets the floor
// raised to what that run measured, never lowered, and `unit` judged again. Written into the
// hop's diff and reported, never silently.

// why: Bun exposes no path-join primitive; `x.verify.json` sits at the app root.
import { join } from 'node:path';
import { t } from '@ultimat3/schema';
import { COVERAGE_BAR, COVERAGE_FIELD, floorFor } from './coverage-floor';
import { msg } from './messages';
import { statedCoverage } from './upgrade-coverage';
import { documentIn } from './upgrade-document';
import type { HopGate } from './upgrade-gate';
import { VERIFY_FLOOR_FILE } from './verify-floor';

const STALE = 'X_COVERAGE_FLOOR_STALE';
const UNIT = 'unit';

interface Numbers {
  readonly lines: number;
  readonly funcs: number;
}

/** What the report carries: the floor before, the one written, and the run that measured it. */
export interface HopCoverageRatchet {
  readonly file: string;
  readonly measured: Numbers;
  readonly from: Numbers;
  readonly to: Numbers;
}

type Verify = HopGate['verify'];

const MEASURED = t.object({
  data: t.object({ coverage: t.object({ unit: t.object({ lines: t.number, funcs: t.number }) }) }),
});

/** Whether the gate's `unit` step said its floor is stale. */
export const staleUnitFloor = (verify: Verify): boolean =>
  verify.findings.some((finding) => finding.step === UNIT && finding.code === STALE);

/** The `unit` step's measurement off a verify document; undefined when it carries none. */
export function measuredUnit(stdout: string): Numbers | undefined {
  const parsed = MEASURED.safeParse(documentIn(stdout));
  if (parsed.issues !== undefined) return undefined;
  const { lines, funcs } = (parsed.value as { data: { coverage: { unit: Numbers } } }).data.coverage
    .unit;
  return { lines, funcs };
}

/**
 * Each number to the larger of the stated floor and the measured whole percent — the stale
 * finding's own fix — so no floor ever falls. A floor that reaches the bar drops its `why`, as
 * that fix says. Null when nothing rises, or the app states no floor to raise.
 */
export async function raiseCoverageFloor(
  root: string,
  measured: Numbers,
): Promise<HopCoverageRatchet | null> {
  const stated = await statedCoverage(root);
  if (stated === undefined) return null;
  const from = { lines: stated.floor.lines, funcs: stated.floor.funcs };
  const to = {
    lines: Math.max(from.lines, floorFor(measured.lines)),
    funcs: Math.max(from.funcs, floorFor(measured.funcs)),
  };
  if (to.lines === from.lines && to.funcs === from.funcs) return null;
  const { why, ...raw } = stated.payload[COVERAGE_FIELD] as Record<string, unknown>;
  const cleared = to.lines >= COVERAGE_BAR && to.funcs >= COVERAGE_BAR;
  const coverage = cleared ? { ...raw, ...to } : { ...raw, ...to, why };
  const next = { ...stated.payload, [COVERAGE_FIELD]: coverage };
  await Bun.write(join(root, VERIFY_FLOOR_FILE), `${JSON.stringify(next, null, 2)}\n`);
  return { file: VERIFY_FLOOR_FILE, measured: { ...measured }, from, to };
}

/**
 * The gate's verdict with `unit` replaced by its re-run. Green only when `unit` was the one red
 * step, its re-run passed, and no finding sits outside every step.
 */
export function rejudgedVerify(verify: Verify, unit: Verify): Verify {
  const others = verify.findings.filter((finding) => finding.step !== UNIT);
  const failedOthers = verify.failed.filter((name) => name !== UNIT);
  const ok =
    unit.ok &&
    failedOthers.length === 0 &&
    verify.failed.includes(UNIT) &&
    others.every((finding) => finding.step !== undefined);
  return {
    ...verify,
    ok,
    summary: msg('cli.upgrade.coverageRejudged', { summary: verify.summary, unit: unit.summary }),
    failed: unit.ok ? failedOthers : verify.failed,
    findings: [...others, ...unit.findings],
  };
}
