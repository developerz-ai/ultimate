// The one stdout write every published entry point uses. Its whole reason to exist is a failure
// that only appears when stdout is a PIPE and the process exits immediately afterwards, so the
// load-bearing test spawns a child and reads the pipe — the in-process runner's fd 1 is not a
// thing a test may redirect without taking the whole runner down with it.

import { describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import { writeErrorLine, writeLine } from './write-line';

const MODULE = join(import.meta.dir, 'write-line.ts');

/** A child that writes `bytes` characters through `writeLine` and then exits immediately. */
async function throughAPipe(bytes: number): Promise<{ stdout: string; code: number }> {
  const child = Bun.spawn(
    [
      'bun',
      '-e',
      `const { writeLine } = await import(${JSON.stringify(MODULE)});
       writeLine('x'.repeat(${bytes}));
       process.exit(0);`,
    ],
    { stdout: 'pipe', stderr: 'pipe' },
  );
  const stdout = await new Response(child.stdout).text();
  return { stdout, code: await child.exited };
}

/** The same child, writing one line to each sink, so the two fds can be told apart. */
async function bothPipes(): Promise<{ stdout: string; stderr: string; code: number }> {
  const child = Bun.spawn(
    [
      'bun',
      '-e',
      `const { writeLine, writeErrorLine } = await import(${JSON.stringify(MODULE)});
       writeLine('{"ok":true}');
       writeErrorLine('a banner');
       process.exit(0);`,
    ],
    { stdout: 'pipe', stderr: 'pipe' },
  );
  const [stdout, stderr] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  return { stdout, stderr, code: await child.exited };
}

describe('writeLine', () => {
  test('appends exactly one newline and writes nothing else', async () => {
    const { stdout, code } = await throughAPipe(3);
    expect(code).toBe(0);
    expect(stdout).toBe('xxx\n');
  });

  // The bug in one number: `process.stdout.write` queues past the 64KB pipe buffer and
  // `process.exit` discards the queue, so a `--json` payload larger than the buffer silently
  // truncated under `| jq` and in CI — the only two places `--json` is for.
  test('a payload far past the 64KB pipe buffer survives an immediate process.exit', async () => {
    const bytes = 512 * 1024;
    const { stdout, code } = await throughAPipe(bytes);
    expect(code).toBe(0);
    expect(stdout).toHaveLength(bytes + 1);
    expect(stdout.endsWith('x\n')).toBe(true);
    // Not merely long enough: no interior byte was dropped by a short write.
    expect(stdout.slice(0, -1)).toBe('x'.repeat(bytes));
  }, 30_000);

  // In-process, so the module this package ships is the one the coverage report sees. An empty
  // line is one byte of noise in the runner's output, and the assertion is real: the loop must
  // terminate on a zero-length payload rather than spinning on `written < buffer.length`.
  test('an empty line terminates rather than spinning', () => {
    expect(() => {
      writeLine('');
    }).not.toThrow();
  });
});

/**
 * The second sink. It exists because stdout is not always a log: under `x mcp serve --transport
 * stdio` it is the PROTOCOL, and under `--json` it is one document a caller parses — so a line
 * that is neither has to have somewhere else to go, with the same pipe guarantees.
 */
describe('writeErrorLine', () => {
  test('writes to fd 2, and leaves fd 1 carrying only what was written to it', async () => {
    const { stdout, stderr, code } = await bothPipes();
    expect(code).toBe(0);
    // Byte-exact: a caller may `JSON.parse` fd 1, so one stray banner byte is the whole bug.
    expect(stdout).toBe('{"ok":true}\n');
    expect(stderr).toBe('a banner\n');
  }, 30_000);

  test('an empty line terminates rather than spinning, on this fd too', () => {
    expect(() => {
      writeErrorLine('');
    }).not.toThrow();
  });
});
