// A fixture's verdict, from `x upgrade --json` as the CLI prints it: green only when the hop's gate
// is, and every file left to a human named — a red step's file, a stale or withheld guard, a
// Bun-floor site to confirm, a codemod's skip — because the bar is zero hand edits.

import { describe, expect, test } from 'bun:test';
import type { FixtureRun } from './upgrade-fixtures-findings';
import { fixtureFindings, fixtureLines, reproduceFixture } from './upgrade-fixtures-findings';
import { commandDocument, readCodemods, readHop } from './upgrade-fixtures-verdict';

const GREEN = {
  ok: true,
  command: 'upgrade',
  summary: '31.4.0 -> 31.27.0: the gate is green',
  data: {
    from: '31.4.0',
    to: '31.27.0',
    bun: { manual: [] },
    guards: { differs: [], missing: [] },
    doctorWarnings: [],
    verify: { ok: true, summary: '20 of 21 steps passed', failed: [], findings: [] },
  },
};

const withData = (data: Record<string, unknown>, ok = true) => ({
  ...GREEN,
  ok,
  data: { ...GREEN.data, ...data },
});

const fixture = (hop: unknown, extra: Partial<FixtureRun> = {}): FixtureRun => {
  const reading = readHop(hop);
  return {
    version: '31.4.0',
    dir: '/tmp/f/fxapp',
    before: null,
    ...(reading === undefined ? {} : { hop: reading }),
    wrote: ['package.json', 'bun.lock'],
    after: null,
    drift: null,
    ms: 1000,
    stages: { hop: 1000 },
    ...extra,
  };
};

describe('commandDocument', () => {
  test('reads the command document past the heartbeat and step lines that are JSON too', () => {
    const output = [
      JSON.stringify(GREEN),
      '{"upgrade":"verify"}',
      'x upgrade: still in verify (36s)',
      '{"step":"lint","ok":true}',
    ].join('\n');
    expect(commandDocument(output, 'upgrade')?.['summary']).toBe(GREEN.summary);
    expect(commandDocument(output, 'verify')).toBeUndefined();
    expect(commandDocument('not json', 'upgrade')).toBeUndefined();
  });
});

describe('a hop', () => {
  test('green with nothing owed raises no finding', () => {
    expect(fixtureFindings(fixture(GREEN))).toEqual([]);
  });

  test('a red gate is X_UPGRADE_FIXTURE_RED, and the file a red step names is a required edit', () => {
    const red = withData(
      {
        verify: {
          ok: false,
          summary: '19 of 21',
          failed: ['typecheck'],
          findings: [
            {
              step: 'typecheck',
              code: 'X_TYPECHECK_FAILED',
              cause: 'TS2307',
              fix: 'x',
              at: 'apps/web/app/auth.ts',
            },
          ],
        },
      },
      false,
    );
    const findings = fixtureFindings(fixture(red));
    expect(findings.map((one) => one.code)).toEqual([
      'X_UPGRADE_FIXTURE_RED',
      'X_UPGRADE_FIXTURE_HAND_STEP',
    ]);
    expect(findings[0]?.cause).toContain('typecheck');
    expect(findings[1]?.cause).toContain('apps/web/app/auth.ts');
    expect(findings[0]?.fix).toBe(reproduceFixture('31.4.0'));
  });

  test('an exit code of 1 under a document whose gate says ok is never rounded up to green', () => {
    expect(readHop({ ...GREEN, ok: false })?.green).toBe(false);
  });

  test('green, and a stale guard, a withheld guard and a Bun site to confirm are still owed', () => {
    const owed = withData({
      guards: {
        differs: [{ name: 'bare-error', refresh: 'x g guard bare-error --force' }],
        missing: [{ name: 'repo-unbounded', add: 'x g guard repo-unbounded' }],
        installed: ['unbounded-fanout'],
      },
      bun: { manual: [{ path: 'docker/Dockerfile', why: 'a digest pins a floating tag' }] },
      doctorWarnings: [
        { code: 'X_VERIFY_STEP_UNFLOORED', cause: 'e2e', fix: 'x', at: 'x.verify.json' },
        // Raised before the hop installed it: answered, so never owed.
        {
          code: 'X_SHIPPED_GUARD_MISSING',
          cause: 'absent',
          fix: 'x',
          at: 'guards/unbounded-fanout.ts',
        },
      ],
    });
    const steps = readHop(owed)?.handSteps ?? [];
    expect(steps.map((step) => [step.path, step.source, step.required])).toEqual([
      ['guards/bare-error.ts', 'guards:differs', false],
      ['guards/repo-unbounded.ts', 'guards:missing', false],
      ['docker/Dockerfile', 'bun:manual', false],
      ['x.verify.json', 'doctor', false],
    ]);
    const findings = fixtureFindings(fixture(owed));
    expect(findings.map((one) => one.code)).toEqual(['X_UPGRADE_FIXTURE_HAND_STEP']);
    expect(findings[0]?.cause).toContain('4 item(s)');
  });

  test('a refusal names its code; no document at all says so with the output tail', () => {
    const refused = {
      ok: false,
      command: 'upgrade',
      summary: 'command failed',
      findings: [{ code: 'X_UPGRADE_DIRTY_TREE', cause: '1 change', fix: 'git status' }],
    };
    expect(fixtureFindings(fixture(refused))[0]?.cause).toContain('X_UPGRADE_DIRTY_TREE');
    const none = fixtureFindings(fixture(undefined, { hopOutput: 'Segmentation fault' }));
    expect(none[0]?.code).toBe('X_UPGRADE_FIXTURE_RED');
    expect(none[0]?.cause).toContain('Segmentation fault');
  });

  test('a green hop that a standalone x verify then finds red is red', () => {
    const after = { green: false, summary: 'lint red' };
    expect(fixtureFindings(fixture(GREEN, { after }))[0]?.cause).toContain('lint red');
  });

  test('a fixture that never reached its hop is X_UPGRADE_FIXTURE_UNBUILT, and only that', () => {
    const unbuilt = fixture(undefined, {
      unbuilt: { stage: 'setup', output: 'bun install failed' },
    });
    const findings = fixtureFindings(unbuilt);
    expect(findings.map((one) => one.code)).toEqual(['X_UPGRADE_FIXTURE_UNBUILT']);
    expect(findings[0]?.cause).toContain('setup');
    expect(fixtureLines(unbuilt)[0]).toContain('unbuilt at setup');
  });
});

describe('codemods', () => {
  test('absent is null — the engine did not report — and a skip is a file owed', () => {
    expect(readCodemods(undefined)).toBeNull();
    const list = [
      { id: 'authenticator', changed: ['a.ts'], skipped: [{ path: 'b.ts', reason: 'app-edited' }] },
    ];
    expect(readCodemods(list)).toEqual([
      { id: 'authenticator', changed: ['a.ts'], skipped: [{ path: 'b.ts', reason: 'app-edited' }] },
    ]);
    expect(readCodemods({ applied: list })?.[0]?.id).toBe('authenticator');
    const steps = readHop(withData({ codemods: list }))?.handSteps ?? [];
    expect(steps).toEqual([
      { path: 'b.ts', source: 'codemod:authenticator', why: 'app-edited', required: false },
    ]);
    expect(fixtureLines(fixture(withData({ codemods: list })))).toContain(
      '    codemods: authenticator (1 changed, 1 skipped)',
    );
  });
});
