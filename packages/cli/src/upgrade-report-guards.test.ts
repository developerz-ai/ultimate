// The terminal's lines for a hop's guards: a guard installed at its baseline says so, with the
// count `x.verify.json` now holds it at — `--json` carries the same fact in `guards.baselined`.

import { describe, expect, test } from 'bun:test';
import { msg } from './messages';
import type { HopGate } from './upgrade-gate';
import type { UpgradeHop } from './upgrade-plan';
import { humanLines, NO_WRITES } from './upgrade-report';

const hop: UpgradeHop = { from: '1.0.0', to: '2.0.0', next: null, atTarget: false, section: null };

const gate = (baselined: NonNullable<HopGate['guards']['baselined']>): HopGate => ({
  manifest: { ok: true, findings: [] },
  doctorWarnings: [],
  guards: {
    reported: true,
    missing: [],
    differs: [],
    installed: ['no-eval'],
    withheld: [],
    baselined,
  },
  coverage: null,
  exercise: { reported: true, ok: true, findings: [] },
  exerciseFloor: null,
  verify: { ok: true, summary: 's', failed: [], findings: [] },
});

const then = 'next';
const linesFor = (g: HopGate) =>
  humanLines({ hop, writes: NO_WRITES, gate: g, scripts: [], then, typescript: [] });

describe('unit · a baselined guard is said on the terminal', () => {
  test('one line per baselined guard, naming its count', () => {
    const lines = linesFor(gate([{ name: 'no-eval', findings: 3 }]));
    expect(lines).toContain(msg('cli.upgrade.guardBaselined', { name: 'no-eval', count: 3 }));
  });

  test('none baselined: no such line', () => {
    const line = msg('cli.upgrade.guardBaselined', { name: 'no-eval', count: 3 });
    expect(linesFor(gate([]))).not.toContain(line);
  });
});
