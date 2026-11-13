// `x upgrade` reads the hop's `x doctor` for its guard listing only: the 31.16.0 doctor warnings,
// or a doctor that exits red on them (an older CLI, or `next`), never red a hop that verifies green.

import { afterEach, describe, expect, test } from 'bun:test';
import { fixture, recording, removeFixtures, run } from './cmd-upgrade-fixture';
import type { Runner } from './exec';

afterEach(removeFixtures);

const HELD = ['X_FRAMEWORK_PIN_RANGE', 'X_ENV_NAME_RESERVED', 'X_DB_ROW_SECURITY_OFF'];
const held = HELD.map((code) => ({ code, cause: 'how the app is held', fix: 'x doctor --json' }));
const listing = { guards: { missing: [], differs: [] } };

/** The recording runner, with `x doctor` answering `stdout` and exiting `code`. */
const doctorAnswering = (stdout: string, code: number): Runner => {
  const { runner } = recording();
  return async (command, options) => {
    const answered = await runner(command, options);
    if (command[2] !== 'doctor') return answered;
    return { ...answered, stdout, code, ok: code === 0 };
  };
};

describe('unit · x upgrade, the hop and the doctor', () => {
  test('a doctor warning on the four checks leaves the hop green', async () => {
    const doctor = JSON.stringify({ ok: true, findings: [], data: { ...listing, warnings: held } });
    const { code, output } = await run(await fixture(), doctorAnswering(doctor, 0));
    expect(code).toBe(0);
    expect(output.ok).toBe(true);
  });

  // The warnings are the next major's red: the hop that installs the doctor saying them says them
  // too, rather than leaving an author to rerun `x doctor` to learn what `next` will refuse.
  test('the doctor warnings ride in the report, a line each, and the hop stays green', async () => {
    const doctor = JSON.stringify({ ok: true, findings: [], data: { ...listing, warnings: held } });
    const { code, output } = await run(await fixture(), doctorAnswering(doctor, 0));
    expect(code).toBe(0);
    expect(output.data?.doctorWarnings?.map((warning) => warning.code)).toEqual(HELD);
    const human = await run(await fixture(), doctorAnswering(doctor, 0), [], { json: false });
    const said = human.lines.join('\n').split('\n');
    expect(said.filter((line) => line.includes('doctor warning: X_'))).toHaveLength(3);
  });

  test('a doctor that exits red on them still leaves a hop green whose verify is green', async () => {
    const doctor = JSON.stringify({ ok: false, findings: held, data: listing });
    const { code, output } = await run(await fixture(), doctorAnswering(doctor, 1));
    expect(code).toBe(0);
    expect(output.ok).toBe(true);
    expect(output.findings ?? []).not.toContainEqual(
      expect.objectContaining({ code: 'X_FRAMEWORK_PIN_RANGE' }),
    );
  });
});
