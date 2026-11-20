// A supervised child's lines say which child wrote them: `child: <index>` on every process-logger
// line, read once from `ULTIMATE_CHILD`. Run in a fresh process, because the field is a fact the
// module reads at load and this test runner is not a child.

import { describe, expect, test } from 'bun:test';

const LOGGER = JSON.stringify(import.meta.resolve('./logger.ts'));

async function linesUnder(
  ultimateChild: string | undefined,
): Promise<{ code: number; lines: Record<string, unknown>[]; stderr: string }> {
  const script = `
    import { logger, structuredLogger } from ${LOGGER};
    logger.info('plain');
    logger.child({ requestId: 'r1' }).warn('derived');
    logger.info('forged', { child: 'mine' });
    structuredLogger({ writer: (line) => console.log(line) }).info('own writer');
  `;
  const env: Record<string, string | undefined> = { ...process.env, LOG_LEVEL: 'info' };
  delete env['ULTIMATE_CHILD'];
  if (ultimateChild !== undefined) env['ULTIMATE_CHILD'] = ultimateChild;
  const run = Bun.spawn(['bun', '-e', script], {
    env,
    stdout: 'pipe',
    stderr: 'pipe',
    timeout: 10_000,
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(run.stdout).text(),
    new Response(run.stderr).text(),
    run.exited,
  ]);
  const lines = stdout
    .split('\n')
    .filter((line) => line.startsWith('{'))
    .map((line) => JSON.parse(line) as Record<string, unknown>);
  return { code, lines, stderr };
}

describe('logger · the supervised child field', () => {
  test('every line of child 1 of 2 carries child: 1, derived and own-writer loggers included', async () => {
    const { code, lines } = await linesUnder('1/2');
    expect(code).toBe(0);
    expect(lines.map((line) => [line['msg'], line['child']])).toEqual([
      ['plain', 1],
      ['derived', 1],
      ['forged', 1],
      ['own writer', 1],
    ]);
  });

  test("a caller's own `child` field is kept as field.child, never allowed to replace the index", async () => {
    const { lines } = await linesUnder('0/3');
    const forged = lines.find((line) => line['msg'] === 'forged');
    expect(forged).toMatchObject({ child: 0, 'field.child': 'mine' });
  });

  test('an unsupervised process writes no child key, and a caller field stays its own', async () => {
    const { code, lines } = await linesUnder(undefined);
    expect(code).toBe(0);
    expect(lines.some((line) => Object.hasOwn(line, 'child') && line['msg'] !== 'forged')).toBe(
      false,
    );
    expect(lines.find((line) => line['msg'] === 'forged')).toMatchObject({ child: 'mine' });
    expect(lines.some((line) => Object.hasOwn(line, 'field.child'))).toBe(false);
  });

  test('a malformed ULTIMATE_CHILD refuses at load, coded', async () => {
    const { code, stderr } = await linesUnder('2/2');
    expect(code).not.toBe(0);
    expect(stderr).toContain('X_INVARIANT');
    expect(stderr).toContain('ULTIMATE_CHILD');
  });
});
