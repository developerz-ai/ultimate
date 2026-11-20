// The hop's coverage ratchet, reported: a raised floor is one terminal line naming both floors and
// the measurement, and `--json` carries the same fact as `coverageRaised` (null when none rose).

import { describe, expect, test } from 'bun:test';
import { msg } from './messages';
import type { HopGate } from './upgrade-gate';
import type { UpgradeHop } from './upgrade-plan';
import { humanLines, NO_WRITES, report } from './upgrade-report';

const hop: UpgradeHop = { from: '1.0.0', to: '2.0.0', next: null, atTarget: false, section: null };

const RAISED = {
  file: 'x.verify.json',
  measured: { lines: 72.34, funcs: 66.18 },
  from: { lines: 69, funcs: 60 },
  to: { lines: 72, funcs: 66 },
};

const gate = (raised: boolean): HopGate => ({
  manifest: { ok: true, findings: [] },
  doctorWarnings: [],
  guards: { reported: true, missing: [], differs: [], installed: [], withheld: [] },
  coverage: null,
  exercise: { reported: true, ok: true, findings: [] },
  exerciseFloor: null,
  ...(raised ? { coverageRaised: RAISED } : {}),
  verify: { ok: true, summary: 's', failed: [], findings: [] },
});

// Shorthand: biome refuses a literal `then:` key, which reads as a thenable.
const then = 'next';
const LINE = msg('cli.upgrade.coverageRaised', {
  file: 'x.verify.json',
  fromLines: 69,
  fromFuncs: 60,
  toLines: 72,
  toFuncs: 66,
  lines: 72.3,
  funcs: 66.1,
});

const jsonOf = (g: HopGate) =>
  report({
    hop,
    writes: NO_WRITES,
    gate: g,
    typescript: [],
    done: true,
    dryRun: false,
    pins: [],
    bunFrom: null,
    bunTo: null,
    app: true,
    scripts: [],
    then,
  }) as { readonly coverageRaised: unknown };

describe('unit · a raised coverage floor is reported', () => {
  test('one terminal line, and --json carries the raise', () => {
    const lines = humanLines({
      hop,
      writes: NO_WRITES,
      gate: gate(true),
      scripts: [],
      then,
      typescript: [],
    });
    expect(lines).toContain(LINE);
    expect(jsonOf(gate(true)).coverageRaised).toEqual(RAISED);
  });

  test('none raised: no line, and --json says null', () => {
    const lines = humanLines({
      hop,
      writes: NO_WRITES,
      gate: gate(false),
      scripts: [],
      then,
      typescript: [],
    });
    expect(lines).not.toContain(LINE);
    expect(jsonOf(gate(false)).coverageRaised).toBeNull();
  });
});
