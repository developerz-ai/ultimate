// `x heavy` end to end, through the real bin: what a caller depends on is its exit code, its streams
// and what becomes of the slot when it is killed.

import { afterEach, describe, expect, test } from 'bun:test';
// why: a temp ledger per test; Bun ships no mkdtemp.
import { mkdtempSync, rmSync } from 'node:fs';
// why: the test's scratch root.
import { tmpdir } from 'node:os';
// why: Bun ships no path-join primitive.
import { join } from 'node:path';

// flock(2) does not exist on Windows, where admission is off (`heavy-flock.ts`).
const NO_FLOCK = process.platform === 'win32';
const BIN = join(import.meta.dir, 'bin.ts');
const dirs: string[] = [];
const started: { kill(signal: 'SIGKILL'): void }[] = [];
afterEach(() => {
  for (const child of started.splice(0)) child.kill('SIGKILL');
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function ledgerEnv(memory = '100m') {
  const dir = mkdtempSync(join(tmpdir(), 'heavy-cmd-'));
  dirs.push(dir);
  const { CI: _ci, ULTIMATE_HEAVY_HOLD: _hold, ...rest } = Bun.env;
  return { ...rest, ULTIMATE_HEAVY_DIR: dir, ULTIMATE_HEAVY_MEMORY: memory };
}

const x = (args: readonly string[], env: Record<string, string | undefined>) => {
  const child = Bun.spawn(['bun', BIN, ...args], {
    env,
    stdout: 'pipe',
    stderr: 'pipe',
    stdin: 'ignore',
  });
  started.push(child);
  return child;
};

async function finished(child: ReturnType<typeof x>) {
  const [out, err, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return { out, err, code };
}

async function statusOf(env: Record<string, string | undefined>) {
  const { out } = await finished(x(['heavy', 'status', '--json'], env));
  return JSON.parse(out).data as {
    enabled: boolean;
    capacityMb: number;
    holds: { label: string }[];
    queue: { label: string }[];
  };
}

/** Starts a holder and returns once the shell inside it has run, so the hold is real. */
async function holding(env: Record<string, string | undefined>, label: string) {
  const child = x(
    ['heavy', 'run', '--label', label, '--mb', '100', '--', 'sh', '-c', 'echo up; exec sleep 60'],
    env,
  );
  const reader = child.stdout.getReader();
  await reader.read();
  return child;
}

describe.skipIf(NO_FLOCK)('x heavy run', () => {
  test('passes the exit code through and keeps stdout the child’s', async () => {
    const run = await finished(
      x(['heavy', 'run', '--mb', '1', '--', 'sh', '-c', 'echo out; exit 7'], ledgerEnv()),
    );
    expect(run.code).toBe(7);
    expect(run.out).toBe('out\n');
  }, 30_000);

  test('--json leaves one document on stdout and moves the child to stderr', async () => {
    const run = await finished(
      x(['heavy', 'run', '--json', '--mb', '1', '--', 'sh', '-c', 'echo out'], ledgerEnv()),
    );
    expect(JSON.parse(run.out).data.exitCode).toBe(0);
    expect(run.err).toContain('out');
  }, 30_000);

  test('a nested run inherits the hold instead of waiting on its own parent', async () => {
    const inner = `bun ${BIN} heavy run --mb 100 -- sh -c 'echo inner'`;
    const run = await finished(
      x(['heavy', 'run', '--mb', '100', '--', 'sh', '-c', inner], ledgerEnv()),
    );
    expect(run.code).toBe(0);
    expect(run.out).toContain('inner');
  }, 30_000);

  test('a waiter says who holds the memory, on stderr only, and SIGTERM frees the holder', async () => {
    const env = ledgerEnv();
    const holder = await holding(env, 'first');
    const waiter = x(['heavy', 'run', '--mb', '100', '--', 'sh', '-c', 'echo second'], env);
    const reader = waiter.stderr.getReader();
    const { value } = await reader.read();
    const line = new TextDecoder().decode(value);
    expect(line).toContain('position 1 of 1');
    expect(line).toContain('first');
    holder.kill('SIGTERM');
    expect(await holder.exited).toBe(143);
    expect(await waiter.exited).toBe(0);
    expect(await new Response(waiter.stdout).text()).toBe('second\n');
  }, 30_000);

  test('kill -9 of the wrapper keeps the reservation until the workload is gone', async () => {
    const env = ledgerEnv();
    const holder = x(
      [
        'heavy',
        'run',
        '--label',
        'doomed',
        '--mb',
        '100',
        '--',
        'sh',
        '-c',
        'echo $$; exec sleep 60',
      ],
      env,
    );
    const { value } = await holder.stdout.getReader().read();
    const workload = Number(new TextDecoder().decode(value).trim());
    holder.kill('SIGKILL');
    await holder.exited;
    expect((await statusOf(env)).holds.map((hold) => hold.label)).toEqual(['doomed']);
    process.kill(workload, 'SIGKILL');
    // Each read is a whole process, so this loop paces itself.
    while ((await statusOf(env)).holds.length > 0);
  }, 30_000);

  test('a command that does not exist is 127 with a coded finding', async () => {
    const run = await finished(
      x(['heavy', 'run', '--json', '--', 'no-such-tool-here'], ledgerEnv()),
    );
    expect(run.code).toBe(127);
    expect(JSON.parse(run.out).findings[0].code).toBe('X_HEAVY_COMMAND_NOT_FOUND');
  }, 30_000);

  test('no command is refused with a runnable example', async () => {
    const run = await finished(x(['heavy', 'run', '--json'], ledgerEnv()));
    expect(run.code).toBe(1);
    expect(JSON.parse(run.out).findings[0].code).toBe('X_CLI_BAD_FLAG');
  }, 30_000);
});

describe.skipIf(NO_FLOCK)('x heavy status', () => {
  test('reports capacity and the machine', async () => {
    const data = await statusOf(ledgerEnv('2g'));
    expect(data.enabled).toBe(true);
    expect(data.capacityMb).toBe(2048);
  }, 30_000);

  test('says why admission is off under CI', async () => {
    const { out } = await finished(x(['heavy', '--json'], { ...ledgerEnv(), CI: 'true' }));
    expect(JSON.parse(out).data).toMatchObject({ enabled: false, off: 'ci' });
  }, 30_000);

  test('a bad memory override is a coded failure, not a crash', async () => {
    const run = await finished(x(['heavy', '--json'], { ...ledgerEnv('lots') }));
    expect(run.code).toBe(1);
    expect(JSON.parse(run.out).findings[0].code).toBe('X_HEAVY_MEMORY_INVALID');
  }, 30_000);
});
