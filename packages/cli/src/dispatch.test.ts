// The one I/O path, driven end to end. Every assertion here is about the PARSE-FAILURE branch,
// because that is the one an agent hits by accident — a typo'd flag, a typo'd command — and it is
// the one branch that has no `ParsedArgs` to read `--json` off.

import { describe, expect, test } from 'bun:test';
import { dispatch } from './dispatch';

const REQUIRED_BUN = '1.3.14';

async function run(argv: readonly string[]): Promise<{ code: number; out: string }> {
  const lines: string[] = [];
  const code = await dispatch({
    argv,
    cwd: import.meta.dir,
    env: {},
    bunVersion: REQUIRED_BUN,
    write: (line) => lines.push(line),
  });
  return { code, out: lines.join('\n') };
}

const parsed = (out: string): { ok: boolean; findings?: { code: string }[] } =>
  JSON.parse(out) as { ok: boolean; findings?: { code: string }[] };

describe('unit · -j is --json on the parse-failure path too', () => {
  // `options.argv.includes('--json')` missed the short form, so `x doctor -j --bogusflag` rendered
  // its X_CLI_BAD_FLAG as PROSE to a caller that then ran `JSON.parse` on it and threw.
  test('a typo’d flag with -j renders JSON', async () => {
    const short = await run(['doctor', '-j', '--bogusflag']);
    expect(short.code).toBe(1);
    expect(parsed(short.out).findings?.[0]?.code).toBe('X_CLI_BAD_FLAG');
    // The long form always worked; the two must not disagree.
    const long = await run(['doctor', '--json', '--bogusflag']);
    expect(long.out).toBe(short.out.replace('-j', '--json'));
  });

  test('a typo’d COMMAND with -j renders JSON', async () => {
    const result = await run(['nonexistentcmd', '-j']);
    expect(result.code).toBe(1);
    expect(parsed(result.out).findings?.[0]?.code).toBe('X_CLI_UNKNOWN_COMMAND');
  });

  test('without either spelling the same failure is human text', async () => {
    const result = await run(['doctor', '--bogusflag']);
    expect(result.code).toBe(1);
    expect(() => JSON.parse(result.out)).toThrow();
    expect(result.out).toContain('X_CLI_BAD_FLAG');
  });
});
