import { describe, expect, test } from 'bun:test';
import { VERIFY_STEP_NAMES } from '../../packages/cli/src/verify-step';
import { parseScriptArgs } from './args';
import { readVerifyArgs } from './verify-args';

const read = (...argv: string[]) => readVerifyArgs(parseScriptArgs(argv));

const refusal = (argv: readonly string[]): { code: string; cause: string; fix: string } => {
  try {
    read(...argv);
  } catch (error) {
    const e = error as { code: string; cause: string; fix: string };
    return { code: e.code, cause: e.cause, fix: e.fix };
  }
  return expect.unreachable('expected a refusal');
};

describe('unit · bun run verify --only narrows, and refuses what it cannot read', () => {
  test('every step name is accepted and forwarded', () => {
    for (const name of VERIFY_STEP_NAMES) expect(read('--only', name).only).toBe(name);
  });

  test('no flag is the whole gate', () => {
    expect(read()).toEqual({});
    expect(read('--json', '--verbose')).toEqual({});
  });

  test('--workers is forwarded when whole and positive', () => {
    expect(read('--workers', '4').workers).toBe(4);
    expect(read('--workers', '0').workers).toBeUndefined();
  });

  test('an unknown step is refused with the nearest step in the fix', () => {
    const r = refusal(['--only', 'lnt']);
    expect(r.code).toBe('X_CLI_BAD_FLAG');
    expect(r.cause).toContain('unknown step lnt');
    expect(r.fix).toBe('bun run verify --only lint');
  });

  test('--only with no value is refused, never read as the whole gate', () => {
    expect(refusal(['--only']).cause).toContain('unknown step');
  });

  test('an unknown flag is refused rather than ignored', () => {
    const r = refusal(['--onyl', 'lint']);
    expect(r.code).toBe('X_CLI_BAD_FLAG');
    expect(r.cause).toContain('unknown flag --onyl');
    expect(r.fix).toBe('bun run verify --only lint');
  });
});
