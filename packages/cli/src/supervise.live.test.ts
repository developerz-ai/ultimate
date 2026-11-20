// Two real child processes on one port under the real supervisor (`supervise-live-fixture.ts`):
// fresh connections reach both, a SIGKILLed child comes back and readiness with it, and SIGTERM
// drains both to exit 0 and frees the port. Linux only: `reusePort` balances nowhere else.

import { describe, expect, test } from 'bun:test';
// why: Bun exposes no path-join primitive.
import { join } from 'node:path';
import { allowHost, bindFreePorts } from '@ultimat3/testing';

const FIXTURE = join(import.meta.dir, 'supervise-live-fixture.ts');
const TIMEOUT_MS = 60_000;

interface Running {
  readonly proc: ReturnType<typeof Bun.spawn>;
  readonly port: number;
  readonly metricsPort: number;
}

/** Polls `url` until it answers `status`; the test's timeout is the bound. */
async function until(url: string, status: number): Promise<void> {
  for (;;) {
    const answered = await fetch(url).then(
      (response) => response.status,
      () => 0,
    );
    if (answered === status) return;
    // real-clock: another process's readiness, asked over its socket; it has no event to await here.
    await Bun.sleep(50);
  }
}

/** `<index> <pid>` from one fresh connection (keep-alive would pin every request to one child). */
async function hit(port: number): Promise<{ index: string; pid: number }> {
  const text = await (
    await fetch(`http://127.0.0.1:${String(port)}/`, { headers: { connection: 'close' } })
  ).text();
  const [index = '', pid = '0'] = text.split(' ');
  return { index, pid: Number(pid) };
}

const start = (): Promise<Running> =>
  bindFreePorts(
    async ([port = 0, metricsPort = 0]) => {
      allowHost(`127.0.0.1:${String(port)}`);
      allowHost(`127.0.0.1:${String(metricsPort)}`);
      const proc = Bun.spawn([process.execPath, FIXTURE], {
        env: {
          ...process.env,
          PORT: String(port),
          METRICS_PORT: String(metricsPort),
          FIXTURE_COUNT: '2',
        },
        stdout: 'ignore',
        stderr: 'inherit',
      });
      await Promise.race([
        until(`http://127.0.0.1:${String(metricsPort)}/readyz`, 200),
        proc.exited.then((code) => expect.unreachable(`the supervisor exited ${String(code)}`)),
      ]);
      return { proc, port, metricsPort };
    },
    { count: 2 },
  );

describe.skipIf(process.platform !== 'linux')('live · supervise · two children, one port', () => {
  test(
    'both serve, a killed child returns, and SIGTERM drains both to 0 and frees the port',
    async () => {
      const { proc, port, metricsPort } = await start();
      const seen = new Map<string, number>();
      for (let request = 0; request < 40; request += 1) {
        const { index, pid } = await hit(port);
        seen.set(index, pid);
      }
      expect([...seen.keys()].sort()).toEqual(['0', '1']);

      const merged = await (await fetch(`http://127.0.0.1:${String(metricsPort)}/metrics`)).text();
      expect(merged).toContain('fixture_up{child="0"} 1');
      expect(merged).toContain('fixture_up{child="1"} 1');

      process.kill(seen.get('1') ?? 0, 'SIGKILL');
      await until(`http://127.0.0.1:${String(metricsPort)}/readyz`, 503);
      await until(`http://127.0.0.1:${String(metricsPort)}/readyz`, 200);
      const after = new Set<number>();
      for (let request = 0; request < 40; request += 1) after.add((await hit(port)).pid);
      expect(after.size).toBe(2);
      expect(after.has(seen.get('1') ?? 0)).toBe(false);

      const stoppedAt = performance.now();
      proc.kill('SIGTERM');
      expect(await proc.exited).toBe(0);
      expect(performance.now() - stoppedAt).toBeLessThan(5_000);
      const freed = Bun.serve({ port, hostname: '127.0.0.1', fetch: () => new Response() });
      freed.stop(true);
    },
    TIMEOUT_MS,
  );
});
