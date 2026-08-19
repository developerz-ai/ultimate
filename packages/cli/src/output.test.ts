import { describe, expect, test } from 'bun:test';
import type { UltimateErrorShape } from '@ultimat3/core';
import { msg } from './messages';
import type { CommandResult, StepResult } from './output';
import {
  exitCodeFor,
  findingFrom,
  isUltimateErrorShape,
  renderFinding,
  renderHuman,
  renderJson,
  renderUltimateError,
} from './output';

const failing: CommandResult = {
  ok: false,
  command: 'verify',
  summary: '1 of 2 steps failed',
  steps: [
    { name: 'typecheck', ok: true, durationMs: 12, findings: [] },
    {
      name: 'drift',
      ok: false,
      durationMs: 3,
      findings: [
        {
          code: 'X_DB_DRIFT',
          cause: 'table "posts" has column "publish_at" not present in any migration',
          fix: 'x db gen "add publish_at"',
        },
      ],
    },
  ],
};

describe('unit · output', () => {
  test('renders the 3-line contract format', () => {
    const text = renderFinding({
      code: 'X_DB_DRIFT',
      cause: 'schema differs',
      fix: 'x db gen "add publish_at"',
    });
    expect(text.split('\n')).toEqual([
      'X_DB_DRIFT',
      '  cause: schema differs',
      '  fix:   x db gen "add publish_at"',
    ]);
  });

  test('the human render carries every step and every fix line', () => {
    const text = renderHuman(failing);
    expect(text).toContain('✓ typecheck');
    expect(text).toContain('✗ drift');
    expect(text).toContain('fix:   x db gen "add publish_at"');
  });

  test('the JSON render carries the same content as the human render', () => {
    const payload = JSON.parse(renderJson(failing)) as {
      ok: boolean;
      steps: { name: string; ok: boolean; findings: { fix: string }[] }[];
    };
    expect(payload.ok).toBe(false);
    expect(payload.steps.map((step) => step.name)).toEqual(['typecheck', 'drift']);
    expect(payload.steps[1]?.findings[0]?.fix).toBe('x db gen "add publish_at"');
  });

  // `runVerify` sets `skipped` only on a step that does not apply, so an executed step reaches
  // here without the key. A consumer parsing --json must not have to tell "ran" from "absent",
  // which is why the render normalises it — and why the documented shape says `"skipped":false`.
  test('every step in the JSON render carries an explicit skipped boolean', () => {
    const payload = JSON.parse(
      renderJson({
        ...failing,
        steps: [
          { name: 'typecheck', ok: true, durationMs: 12, findings: [] },
          { name: 'e2e', ok: true, durationMs: 0, skipped: true, findings: [] },
        ],
      }),
    ) as { steps: { name: string; skipped: boolean }[] };
    expect(payload.steps.map((step) => step.skipped)).toEqual([false, true]);
    expect(renderJson(failing)).toContain('"skipped":false');
  });

  test('an UltimateError-shaped value is recognised across a process boundary', () => {
    const plain = { code: 'X_TEST', cause: 'because', fix: 'x doctor' };
    expect(isUltimateErrorShape(plain)).toBe(true);
    expect(isUltimateErrorShape({ code: 'nope', cause: 'a', fix: 'b' })).toBe(false);
    expect(findingFrom(plain).fix).toBe('x doctor');
  });

  test('an unknown throw still produces a finding with a fix command', () => {
    // The bare Error is the subject, not an oversight: `findingFrom` exists for throws no package
    // coded, so a coded input here would test the branch above this one instead.
    const finding = findingFrom(new Error('boom'));
    expect(finding.code).toBe('X_CLI_UNEXPECTED');
    expect(finding.fix).toBe('x doctor --json');
  });

  test('a value whose fields throw when read still reaches the terminal', () => {
    // This is the last renderer before the terminal, and the SHAPE PROBE was the unguarded read:
    // `typeof value.code === 'string'` calls a getter on a value the framework did not build, so
    // the report was lost one line before the total renderer that was meant to save it.
    const trapped = Object.defineProperty(new Error('boom'), 'code', {
      get: () => {
        throw new Error('gotcha');
      },
      enumerable: true,
    });

    expect(isUltimateErrorShape(trapped)).toBe(false);
    const finding = findingFrom(trapped);
    expect(finding.code).toBe('X_CLI_UNEXPECTED');
    expect(finding.cause).toBe('Error: boom');
  });

  test('a failed result exits non-zero', () => {
    expect(exitCodeFor(failing)).toBe(1);
    expect(exitCodeFor({ ok: true, command: 'verify', summary: 'ok' })).toBe(0);
  });
});

describe('unit · renderUltimateError', () => {
  const error = (over: Partial<UltimateErrorShape> = {}) =>
    ({
      code: 'X_DB_DRIFT',
      message: 'schema differs from migrations',
      cause: 'table "posts" has column "publish_at" not present in any migration',
      fix: 'x db gen "add publish_at"',
      ...over,
    }) as UltimateErrorShape;

  test('the head is the code and its summary, and every contract line follows', () => {
    expect(renderUltimateError(error({ docs: 'https://ultimate.dev/errors/X_DB_DRIFT' }))).toBe(
      [
        'X_DB_DRIFT: schema differs from migrations',
        '  cause: table "posts" has column "publish_at" not present in any migration',
        '  fix:   x db gen "add publish_at"',
        '  docs:  https://ultimate.dev/errors/X_DB_DRIFT',
      ].join('\n'),
    );
  });

  test('no docs means no docs line — never an "undefined" one', () => {
    const rendered = renderUltimateError(error());
    expect(rendered.split('\n')).toHaveLength(3);
    expect(rendered).not.toContain('docs');
  });

  // `message` defaults to the code on a framework error, and `X_DB_DRIFT: X_DB_DRIFT` is a head
  // that says one thing twice.
  test('a message equal to the code, or empty, leaves the head as the bare code', () => {
    expect(renderUltimateError(error({ message: 'X_DB_DRIFT' })).split('\n')[0]).toBe('X_DB_DRIFT');
    expect(renderUltimateError(error({ message: '' })).split('\n')[0]).toBe('X_DB_DRIFT');
  });

  test('the indent applies to every line, head included', () => {
    for (const line of renderUltimateError(error(), '    ').split('\n')) {
      expect(line.startsWith('    ')).toBe(true);
    }
  });
});

describe('unit · renderHuman says how a step was run', () => {
  const stepResult = (over: Partial<StepResult>): StepResult => ({
    name: 'unit',
    ok: true,
    durationMs: 40,
    findings: [],
    ...over,
  });

  test('one worker reads as serial, more than one names the width', () => {
    const serial = renderHuman({
      ok: true,
      command: 'verify',
      summary: 'ok',
      steps: [stepResult({ workers: 1 })],
    });
    expect(serial).toContain(msg('cli.verify.serial'));

    const parallel = renderHuman({
      ok: true,
      command: 'verify',
      summary: 'ok',
      steps: [stepResult({ workers: 8 })],
    });
    expect(parallel).toContain(msg('cli.verify.workers', { workers: 8 }));
    expect(parallel).not.toContain(msg('cli.verify.serial'));
  });

  test('a step that did not run says nothing about workers, and is marked skipped', () => {
    const skipped = renderHuman({
      ok: true,
      command: 'verify',
      summary: 'ok',
      steps: [stepResult({ workers: 8, skipped: true })],
    });
    expect(skipped).not.toContain(msg('cli.verify.workers', { workers: 8 }));
    expect(skipped).toContain('- unit');
  });

  test('a step with no workers field says nothing either', () => {
    expect(
      renderHuman({ ok: true, command: 'verify', summary: 'ok', steps: [stepResult({})] }),
    ).not.toContain(msg('cli.verify.serial'));
  });
});
