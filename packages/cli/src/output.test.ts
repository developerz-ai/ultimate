import { describe, expect, test } from 'bun:test';
import type { CommandResult } from './output';
import {
  exitCodeFor,
  findingFrom,
  isUltimateErrorShape,
  renderFinding,
  renderHuman,
  renderJson,
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

  test('an UltimateError-shaped value is recognised across a process boundary', () => {
    const plain = { code: 'X_TEST', cause: 'because', fix: 'x doctor' };
    expect(isUltimateErrorShape(plain)).toBe(true);
    expect(isUltimateErrorShape({ code: 'nope', cause: 'a', fix: 'b' })).toBe(false);
    expect(findingFrom(plain).fix).toBe('x doctor');
  });

  test('an unknown throw still produces a finding with a fix command', () => {
    const finding = findingFrom(new Error('boom'));
    expect(finding.code).toBe('X_CLI_UNEXPECTED');
    expect(finding.fix).toBe('x doctor --json');
  });

  test('a failed result exits non-zero', () => {
    expect(exitCodeFor(failing)).toBe(1);
    expect(exitCodeFor({ ok: true, command: 'verify', summary: 'ok' })).toBe(0);
  });
});
