// The one case in this package that boots `x dev` as a real process. Separate file, so its type is
// its filename: `x verify`'s `unit` step promises "pure logic — no database, no network", and a
// case that spawns a process and starts an embedded Postgres is a `live` test wherever it sits.
// It was the slowest test in the unit suite by an order of magnitude while being typed as one.

import { describe, expect, test } from 'bun:test';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';

/**
 * Booting embedded Postgres, the queue and the HTTP role is seconds of real work, and bun's
 * default budget is 5s — close enough to this boot that a loaded machine decided whether the file
 * passed. Explicit and generous for that reason: a hang should be reported as a hang, never as a
 * boot that was 300ms slower than the runner's default.
 */
const BOOT_TIMEOUT_MS = 60_000;

// `cmd-dev.test.ts` proves the app is served. This proves it is still being served a moment later.
// `dispatch` renders a `CommandResult` and `bin.ts` exits on it, so a dev server that only lives
// inside the promise `run` resolves is a dev server the exit code takes down between the line
// announcing the url and the first request to it — which is what `x dev` did. Only a real process
// can show that, so this one is spawned rather than called.
const HOLD_ROOT = join(import.meta.dir, '..', '.dev-hold-fixture');
const BIN = join(import.meta.dir, 'bin.ts');

/**
 * One pump per stream, into one buffer per stream. Reading a stream twice is what a naive version
 * does, and abandoning a `for await` closes the underlying reader — the second read then waits
 * forever on a stream nothing will ever write to again.
 *
 * TWO of them, because `--json` splits this process's output across both descriptors:
 * `dispatch.ts` calls `setLogStream('stderr')` when `args.json` is set, so fd 1 carries the
 * command's one JSON object and fd 2 carries every `{"msg":…}` line the boot and the drain write.
 * A single buffer over `child.stdout` waited out this file's whole 60s budget for a `stopped` line
 * that was never going to arrive on it.
 */
function pump(stream: ReadableStream<Uint8Array>): { seen: () => string } {
  const decoder = new TextDecoder();
  let seen = '';
  void (async () => {
    for await (const chunk of stream) seen += decoder.decode(chunk, { stream: true });
  })();
  return { seen: () => seen };
}

/** Poll the buffer until `marker` shows up. The caller's own timeout is the deadline. */
async function waitFor(output: { seen: () => string }, marker: string): Promise<string> {
  for (;;) {
    const seen = output.seen();
    if (seen.includes(marker)) return seen;
    await Bun.sleep(25);
  }
}

describe('x dev stays up until it is signalled', () => {
  test(
    'boots, keeps serving, and drains on SIGINT instead of being killed',
    async () => {
      await rm(HOLD_ROOT, { recursive: true, force: true });
      await Bun.write(
        join(HOLD_ROOT, 'package.json'),
        JSON.stringify({ name: 'dev-hold-fixture', version: '1.0.0' }),
      );
      // `export const config`, matching `templates/scaffold-repo.ts` and `examples/dummy` — the
      // CLI and the runtime both import `config` by name, and a default export is the one shape
      // `x new` can never produce. This fixture is the process's only app, so spelling it the
      // scaffold's way is what makes the boot below the boot a real app gets.
      await Bun.write(
        join(HOLD_ROOT, 'app.config.ts'),
        `import { defineConfig } from '@ultimat3/core';\nexport const config = defineConfig({ name: 'dev-hold-fixture' });\n`,
      );

      const child = Bun.spawn(['bun', BIN, 'dev', '--port', '0', '--json'], {
        cwd: HOLD_ROOT,
        stdout: 'pipe',
        stderr: 'pipe',
      });
      const output = pump(child.stdout);
      const logs = pump(child.stderr);
      try {
        expect(await waitFor(output, '"command":"dev"')).toContain('"ok":true');

        // The regression: the process used to be gone by now, having exited on the code for the
        // line it had just printed.
        await Bun.sleep(500);
        expect(child.exitCode).toBeNull();

        child.kill('SIGINT');
        // On fd 2, and asserted there rather than against a merged buffer: `x dev --json`'s stdout
        // is one document, and a log line reaching it is what made `json.load` raise on the second.
        const drained = await waitFor(logs, '"msg":"stopped"');
        const code = await child.exited;

        // Drained, not killed: a hard kill leaves the embedded Postgres directory locked and never
        // reaches core's phases, so this line is the whole difference.
        expect(drained).toContain('"msg":"stopped"');
        expect(output.seen()).not.toContain('"msg":');
        expect(code).toBe(0);
      } finally {
        child.kill('SIGKILL');
        await child.exited;
        await rm(HOLD_ROOT, { recursive: true, force: true });
      }
    },
    BOOT_TIMEOUT_MS,
  );
});
