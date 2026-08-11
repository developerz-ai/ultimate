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

async function runScript(body: string): Promise<{ bytes: number; code: number }> {
  const dir = await mkdtemp(join(tmpdir(), 'ultimate-stdout-'));
  try {
    const file = join(dir, 'emit.ts');
    await writeFile(file, body);
    const proc = Bun.spawn(['bun', file, String(PAYLOAD_BYTES)], {
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const [out, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
    return { bytes: out.length, code };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

describe('stdout survives process.exit through a pipe', () => {
  test('the naive write TRUNCATES — this is the bug, and it must stay reproducible', async () => {
    // If this ever stops truncating, the runtime changed and the guard below is measuring nothing.
    // A regression test whose premise has quietly evaporated is worse than no test.
    const { bytes } = await runScript(
      `const payload = 'x'.repeat(Number(Bun.argv[2]));
       process.stdout.write(payload + '\\n');
       process.exit(1);`,
    );
    expect(bytes).toBeLessThan(PAYLOAD_BYTES);
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
    );
    expect(bytes).toBe(PAYLOAD_BYTES + 1);
    expect(code).toBe(1);
  });
});
