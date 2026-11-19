// `x upgrade --only`: the hop's gate narrowed to the named steps, and every report saying which
// steps it did not run — so a scoped green is never read as the full gate.

import { afterEach, describe, expect, test } from 'bun:test';
import {
  fixture,
  fixtureWithoutApp,
  planDocument,
  recording,
  removeFixtures,
  run,
  VERIFY_RED,
} from './cmd-upgrade-fixture';
import { VERIFY_STEP_NAMES } from './verify-step';

afterEach(removeFixtures);

const SCOPED = ['typecheck', 'lint'];
const NOT_RUN = VERIFY_STEP_NAMES.filter((name) => !SCOPED.includes(name));

describe('unit · x upgrade --only, a scoped gate', () => {
  test('the installed verify runs with the same list, and the report names the rest', async () => {
    const dir = await fixture();
    const { runner, spawned } = recording();
    // Typed out of order: the list is the gate's declared order, as `x verify --only` keeps it.
    const { code, output } = await run(dir, runner, ['--only', 'lint,typecheck']);
    expect(spawned.slice(-2)).toEqual(['x verify plan', 'x verify --only typecheck,lint']);
    expect(spawned).not.toContain('x verify');
    expect(code).toBe(0);
    expect(output.data?.proof).toBe('verify-only');
    expect(output.data?.verify).toMatchObject({ ok: true, only: SCOPED, notRun: NOT_RUN });
    expect(output.summary).toContain('NOT THE FULL GATE');
    expect(output.summary).not.toContain('the gate is green');
    expect(output.data?.then).toContain(`x verify --only ${NOT_RUN.join(',')} --json`);
  });

  // The follow-up runs on the INSTALLED CLI, which may be majors older than this one: a step it
  // never had is no step CI can be told to run.
  test('the steps not run are the installed release`s, never this CLI`s', async () => {
    const dir = await fixture();
    const older = ['typecheck', 'lint', 'unit', 'live', 'e2e'];
    const { output } = await run(dir, recording({ plan: planDocument(older) }).runner, [
      '--only',
      'typecheck,lint',
    ]);
    expect(output.data?.verify?.notRun).toEqual(['unit', 'live', 'e2e']);
    expect(output.data?.then).toContain('x verify --only unit,live,e2e --json');
  });

  // An older CLI's whole gate, every step of it named: nothing is owed, so it is the full gate.
  test('every step the installed release has, named: the full gate, reported as one', async () => {
    const dir = await fixture();
    const older = ['typecheck', 'lint', 'unit'];
    const { runner, spawned } = recording({ plan: planDocument(older) });
    const { output } = await run(dir, runner, ['--only', older.join(',')]);
    expect(spawned.slice(-2)).toEqual(['x verify plan', 'x verify']);
    expect(output.data?.proof).toBe('verify');
    expect(output.data?.verify).not.toHaveProperty('notRun');
    expect(output.summary).toContain('the gate is green');
  });

  test('an installed CLI with no plan to ask: this CLI`s list stands in', async () => {
    const dir = await fixture();
    const { output } = await run(dir, recording({ plan: 'error: unknown command' }).runner, [
      '--only',
      'typecheck,lint',
    ]);
    expect(output.data?.verify?.notRun).toEqual(NOT_RUN);
  });

  test('the terminal names the steps not run and the command that runs them', async () => {
    const dir = await fixture();
    const { lines } = await run(dir, recording().runner, ['--only', 'typecheck,lint'], {
      json: false,
    });
    const notRun = lines.find((line) => line.includes('not run by this hop'));
    expect(notRun).toContain(`x verify --only ${NOT_RUN.join(',')} --json`);
  });

  test('a red scoped gate is red, and still says what it did not run', async () => {
    const dir = await fixture();
    const { runner } = recording({ verify: VERIFY_RED, verifyCode: 1 });
    const { code, output } = await run(dir, runner, ['--only', 'typecheck,lint']);
    expect(code).toBe(1);
    expect(output.data?.done).toBe(false);
    expect(output.data?.verify).toMatchObject({
      ok: false,
      failed: ['typecheck'],
      notRun: NOT_RUN,
    });
  });

  test('every step named is the full gate, and is reported as one', async () => {
    const dir = await fixture();
    const { spawned, runner } = recording();
    const { output } = await run(dir, runner, ['--only', VERIFY_STEP_NAMES.join(',')]);
    expect(spawned.at(-1)).toBe('x verify');
    expect(output.data?.proof).toBe('verify');
    expect(output.summary).toContain('the gate is green');
  });

  test('no flag: the full gate, and the report carries no scope', async () => {
    const dir = await fixture();
    const { output } = await run(dir, recording().runner);
    expect(output.data?.proof).toBe('verify');
    expect(output.data?.verify).not.toHaveProperty('only');
    expect(output.data?.verify).not.toHaveProperty('notRun');
  });
});

describe('unit · x upgrade --only, the refusals', () => {
  test('a step that does not exist is refused before anything spawns, with the corrected list', async () => {
    const dir = await fixture();
    const { runner, spawned } = recording();
    const { code, output } = await run(dir, runner, ['--only', 'typecheck,lnt']);
    expect(code).toBe(1);
    expect(spawned).toEqual([]);
    expect(output.findings?.[0]?.code).toBe('X_CLI_BAD_FLAG');
    expect(output.findings?.[0]?.fix).toBe('x upgrade --only typecheck,lint --json');
  });

  test('a repository with no app has no x verify to narrow: refused, nothing spawned', async () => {
    const dir = await fixtureWithoutApp();
    const { runner, spawned } = recording();
    const { code, output } = await run(dir, runner, ['--only', 'lint']);
    expect(code).toBe(1);
    expect(spawned).toEqual([]);
    expect(output.findings?.[0]?.code).toBe('X_CLI_BAD_FLAG');
    expect(output.findings?.[0]?.fix).toBe('x upgrade --json');
  });
});
