import { describe, expect, test } from 'bun:test';
import { VERIFY_STEP_NAMES } from '../../packages/cli/src/verify-step';
import { parseScriptArgs } from './args';
import { REPO_GATE, readVerifyArgs, VERIFY_FLAGS, VERIFY_SUBCOMMANDS } from './verify-args';

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
    for (const name of VERIFY_STEP_NAMES) expect(read('--only', name).only).toEqual([name]);
  });

  test('a comma list is forwarded in the gate’s declared order, whatever order it was typed in', () => {
    expect(read('--only', 'manifest,lint, typecheck').only).toEqual([
      'typecheck',
      'lint',
      'manifest',
    ]);
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

  test('one typo in a list is refused, and the fix is the whole list corrected', () => {
    const r = refusal(['--only', 'lint,typechek,drift']);
    expect(r.cause).toContain('unknown step typechek');
    expect(r.fix).toBe('bun run verify --only lint,typecheck,drift');
  });

  test('--only with no value, and an empty item, are refused — never read as the whole gate', () => {
    expect(refusal(['--only']).cause).toContain('unknown step (none given)');
    expect(refusal(['--only', 'lint,,drift']).cause).toContain('unknown step (none given)');
  });

  test('an unknown flag is refused rather than ignored', () => {
    const r = refusal(['--onyl', 'lint']);
    expect(r.code).toBe('X_CLI_BAD_FLAG');
    expect(r.cause).toContain('unknown flag --onyl');
    expect(r.fix).toBe('bun run verify --only lint');
  });
});

describe('unit · bun run verify --shard is one CI runner’s slice, and only of a parallel suite', () => {
  test('i/n beside a shardable --only is forwarded', () => {
    expect(read('--only', 'unit', '--shard', '2/3')).toEqual({
      only: ['unit'],
      shard: { index: 2, total: 3 },
    });
  });

  test('a shard with no --only, of a serial step, or past its own total is refused', () => {
    expect(refusal(['--shard', '1/2']).code).toBe('X_VERIFY_SHARD_INVALID');
    expect(refusal(['--only', 'lint', '--shard', '1/2']).cause).toContain('lint cannot be split');
    expect(refusal(['--only', 'unit', '--shard', '3/2']).cause).toContain('does not exist');
  });

  test('a refused shard names the command that runs HERE, not x verify', () => {
    // `x verify` at the framework root is X_NOT_IN_APP: a fix that says it is a second failure.
    for (const argv of [
      ['--shard', '1/2'],
      ['--only', 'lint', '--shard', '1/2'],
      ['--only', 'unit', '--shard', '3/2'],
      ['--only', 'unit', '--shard', 'x'],
    ]) {
      const r = refusal(argv);
      expect(r.code).toBe('X_VERIFY_SHARD_INVALID');
      expect(r.fix.startsWith(`${REPO_GATE} --only `)).toBe(true);
      expect(r.fix).not.toContain('x verify');
      expect(r.cause.startsWith(`${REPO_GATE} --shard: `)).toBe(true);
    }
  });

  test('--timings rides a shard and is refused alone', () => {
    expect(read('--only', 'unit', '--shard', '1/2', '--timings', 't.json').timings).toBe('t.json');
    const r = refusal(['--timings', 't.json']);
    expect(r.code).toBe('X_CLI_BAD_FLAG');
    expect(r.fix).toBe('bun run verify --only unit --shard 1/3 --json');
  });

  test('the flags and the one subcommand are a closed list CI is held to', () => {
    expect([...VERIFY_FLAGS]).toEqual(['json', 'verbose', 'workers', 'only', 'shard', 'timings']);
    expect([...VERIFY_SUBCOMMANDS]).toEqual(['merge']);
  });
});
