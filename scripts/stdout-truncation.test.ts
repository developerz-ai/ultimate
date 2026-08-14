/**
 * `--json` must survive a pipe. Every command in this repo promises machine-readable output, and a
 * pipe is the only reason that promise exists — but `process.stdout.write()` is ASYNCHRONOUS when
 * stdout is a pipe, so anything past the 64KB buffer is queued and `process.exit()` throws the
 * queue away. On a terminal the same call is synchronous and complete, which is why this never
 * showed up in local use: it only breaks in CI, under `| jq`, and in `$(...)`.
 *
 * It bit the largest payloads, which are the FAILING ones — a green gate's JSON is small, a red
 * gate's carries every failed step's output. So the output vanished exactly when someone needed it.
 *
 * These tests spawn real processes, because the bug does not exist in-process: it is a property of
 * fd 1 being a pipe and of the runtime's write queue, and no mock reproduces either.
 */

import { describe, expect, test } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** Comfortably past the 64KB pipe buffer, so a truncating write cannot pass by accident. */
const PAYLOAD_BYTES = 300_000;

/**
 * Past any kernel buffer a pipe or socketpair can hold — measured at ~475KB on a Linux runner.
 * The premise below needs the queue to be non-empty when `process.exit()` runs, and only a
 * payload the buffer cannot swallow whole makes that true on every machine rather than most.
 */
const QUEUED_BYTES = 4_000_000;

/**
 * `drain: 'while-running'` reads stdout as the child writes it, which is what a real consumer
 * (`| jq`, `$(...)`) does. `drain: 'after-exit'` leaves the buffer to fill instead, so whatever
 * the child queued rather than wrote is still queued when it exits — the only way to observe the
 * discard without racing the reader. A synchronous writer would BLOCK against an unread pipe, so
 * the two writers genuinely need the two harnesses.
 */
async function runScript(
  body: string,
  payload: number,
  drain: 'while-running' | 'after-exit',
): Promise<{ bytes: number; code: number }> {
  const dir = await mkdtemp(join(tmpdir(), 'ultimate-stdout-'));
  try {
    const file = join(dir, 'emit.ts');
    await writeFile(file, body);
    const proc = Bun.spawn(['bun', file, String(payload)], { stdout: 'pipe', stderr: 'pipe' });
    if (drain === 'after-exit') {
      const code = await proc.exited;
      return { bytes: (await new Response(proc.stdout).text()).length, code };
    }
    const [out, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
    return { bytes: out.length, code };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

const NAIVE = `const payload = 'x'.repeat(Number(Bun.argv[2]));
   process.stdout.write(payload + '\\n');
   process.exit(1);`;

describe('stdout survives process.exit through a pipe', () => {
  test('the naive write LOSES whatever it queued — the bug, still reproducible', async () => {
    // The premise, and it must not be measured against a racing reader: with one draining, a fast
    // machine can empty the buffer as fast as the runtime refills it and the whole payload lands
    // by luck. That is what made this test flake in CI — it asserted a race, not a rule. The rule
    // is that a queue `process.exit()` discards was never delivered, so the payload here is past
    // any buffer and nothing reads until the child is gone.
    const { bytes } = await runScript(NAIVE, QUEUED_BYTES, 'after-exit');
    expect(bytes).toBeLessThan(QUEUED_BYTES);
  });

  test('the synchronous write delivers every byte, and keeps the exit code', async () => {
    // The shape `scripts/lib/log.ts` and `packages/cli/src/bin.ts` both use, including the loop —
    // one writeSync to a pipe may write fewer bytes than it was handed.
    const { bytes, code } = await runScript(
      `import { writeSync } from 'node:fs';
       const buffer = Buffer.from('x'.repeat(Number(Bun.argv[2])) + '\\n');
       let written = 0;
       while (written < buffer.length) {
         written += writeSync(1, buffer, written, buffer.length - written);
       }
       process.exit(1);`,
      PAYLOAD_BYTES,
      'while-running',
    );
    expect(bytes).toBe(PAYLOAD_BYTES + 1);
    expect(code).toBe(1);
  });
});

/**
 * The second half of the same story, and the more expensive one.
 *
 * A CI runner hands the process a stdout pipe in NON-BLOCKING mode. `writeSync` to one whose
 * buffer is full does not block — it throws `EAGAIN` — so the loop above, which fixed the
 * truncation, took the entire gate down on GitHub Actions and emitted nothing at all. `x verify`
 * appeared to print zero bytes, which reads as "the step produced no output" rather than "the step
 * crashed while writing it".
 *
 * This half is tested against the retry rule rather than against a real non-blocking fd: setting
 * `O_NONBLOCK` on a spawned child's own fd 1 needs `fcntl`, which neither Bun nor `node:fs`
 * exposes, and an FFI shim that silently fails to set the flag is a test that proves nothing —
 * the first draft of this file did exactly that and passed while measuring an ordinary pipe. What
 * IS the rule, and what the shipped fix encodes, is that a write refused with `EAGAIN` must be
 * retried and never counted or thrown.
 */
const drain = (write: (from: number) => number, buffer: Buffer): void => {
  let written = 0;
  while (written < buffer.length) {
    try {
      written += write(written);
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code !== 'EAGAIN') throw cause;
    }
  }
};

const eagain = (): NodeJS.ErrnoException =>
  Object.assign(new Error('resource temporarily unavailable, write'), { code: 'EAGAIN' });

describe('the write loop both writers use, against a pipe that refuses', () => {
  test('an EAGAIN is retried, not counted and not thrown', () => {
    const buffer = Buffer.from('abcdef');
    let refusals = 0;
    drain((from) => {
      if (refusals < 3) {
        refusals += 1;
        throw eagain();
      }
      return buffer.length - from;
    }, buffer);
    expect(refusals).toBe(3);
  });

  test('a partial write resumes from where it stopped, EAGAIN in between', () => {
    const buffer = Buffer.from('x'.repeat(10));
    const chunks: number[] = [];
    let calls = 0;
    drain((from) => {
      calls += 1;
      if (calls === 2) throw eagain();
      const n = Math.min(3, buffer.length - from);
      chunks.push(n);
      return n;
    }, buffer);
    expect(chunks.reduce((a, b) => a + b, 0)).toBe(10);
  });

  // Retrying everything would turn a closed pipe into an infinite loop, which is strictly worse
  // than the crash it replaced: the gate would hang instead of failing.
  test('any other error still escapes', () => {
    const buffer = Buffer.from('abc');
    expect(() =>
      drain(() => {
        throw Object.assign(new Error('broken pipe'), { code: 'EPIPE' });
      }, buffer),
    ).toThrow('broken pipe');
  });
});
