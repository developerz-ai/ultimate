// The preflight's whole job is to turn two confusing late failures into two precise early ones, so
// what matters here is that each refusal names the right cause and offers a remedy that RUNS.

import { describe, expect, test } from 'bun:test';
// why: Bun has no mkdtemp and no recursive remove, and Bun.write is async in these synchronous
// fixture helpers.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
// why: Bun exposes no tmpdir(), so only node:os answers the platform temp root.
import { tmpdir } from 'node:os';
// why: Bun exposes no path-join primitive; Bun.file and import() take one already joined.
import { join } from 'node:path';
import { UltimateError } from '@ultimat3/core';
import {
  clearLock,
  DEV_LOCK_FILE,
  DevAlreadyRunningError,
  DevLockUnreadableError,
  DevPortInUseError,
  isProcessAlive,
  lockPath,
  parseLock,
  portHolder,
  preflight,
  writeLock,
} from './dev-lock';

const scratch = (): string => mkdtempSync(join(tmpdir(), 'ultimate-dev-lock-'));

/** What `exec.ts` raises when the program is not on PATH. Reproduced, never approximated. */
const missingProgram = (name: string): UltimateError =>
  new UltimateError({
    code: 'X_CLI_UNEXPECTED',
    cause: `the CLI could not run "${name}"`,
    fix: `install ${name} and put it on PATH`,
  });

const LOCK = {
  pid: 4242,
  port: 3000,
  url: 'http://localhost:3000',
  startedAt: '2026-08-20T00:00:00.000Z',
};

describe('parseLock', () => {
  test('reads a lock this module wrote', () => {
    expect(parseLock(JSON.stringify(LOCK))).toEqual(LOCK);
  });

  test('a truncated or hand-edited file is a stale lock, never a crash', () => {
    // This runs on the path whose entire job is to make a confusing failure clear; throwing here
    // would replace one bad message with a worse one.
    for (const raw of ['', '{', 'null', '[]', '{"pid":"nope"}', '{"port":3000}']) {
      expect(parseLock(raw)).toBe(null);
    }
  });

  test('a lock missing its url still resolves to one, from the port', () => {
    expect(parseLock('{"pid":1,"port":4311}')?.url).toBe('http://localhost:4311');
  });
});

describe('isProcessAlive', () => {
  test('this process is alive', () => {
    expect(isProcessAlive(process.pid)).toBe(true);
  });

  test('a pid that cannot exist is not', () => {
    expect(isProcessAlive(0)).toBe(false);
    expect(isProcessAlive(-1)).toBe(false);
    expect(isProcessAlive(2 ** 31)).toBe(false);
  });
});

describe('preflight', () => {
  test('a clean directory and a free port pass, clearing nothing', async () => {
    const dir = scratch();
    try {
      const result = await preflight({
        stateDir: dir,
        port: 3000,
        hostname: 'localhost',
        portBound: () => false,
      });
      expect(result.clearedStale).toBe(false);
      // The claim is the pass: `preflight` returns having ALREADY taken the directory, so there is
      // no window between the check and the boot for a second one to walk through.
      expect(parseLock(await Bun.file(lockPath(dir)).text())?.pid).toBe(process.pid);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('two boots racing the preflight: the SECOND is refused, before either opens .x/pgdata', async () => {
    const dir = scratch();
    try {
      const first = await preflight({
        stateDir: dir,
        port: 3000,
        hostname: 'localhost',
        embeddedDb: true,
        portBound: () => false,
      });
      // `startDev` takes seconds — embedded Postgres, the queue, the transport, the app's modules
      // — and the lock was written AFTER all of it. So this second preflight ran while the first
      // boot was still in progress. Observed before the fix: `{ clearedStale: false }`, no throw,
      // both boots opening one single-writer `.x/pgdata`, and the operator getting
      // X_DB_UNAVAILABLE whose own `fix:` says to run `x dev`.
      const thrown = await preflight({
        stateDir: dir,
        port: 3000,
        hostname: 'localhost',
        embeddedDb: true,
        portBound: () => false,
      }).catch((error: unknown) => error);

      expect(thrown).toBeInstanceOf(DevAlreadyRunningError);
      expect((thrown as DevAlreadyRunningError).code).toBe('X_DEV_ALREADY_RUNNING');
      // This process IS the holder here, which is the honest answer: the pid in the file is alive.
      expect((thrown as DevAlreadyRunningError).cause).toContain(String(process.pid));
      first.release();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('a boot that fails releases the claim, so the retry is not refused by its own corpse', async () => {
    const dir = scratch();
    try {
      const first = await preflight({
        stateDir: dir,
        port: 3000,
        hostname: 'localhost',
        portBound: () => false,
      });
      // What `cmd-dev.ts` does when `startDev` throws: give the directory back. Without it the
      // rollback is worse than the bug — every later boot in this shell is refused by a lock whose
      // pid is a process that gave up.
      first.release();
      expect(await Bun.file(lockPath(dir)).exists()).toBe(false);

      const second = await preflight({
        stateDir: dir,
        port: 3000,
        hostname: 'localhost',
        portBound: () => false,
      });
      expect(second.clearedStale).toBe(false);
      second.release();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('a refused port leaves no claim behind — the remedy is --port, and it must work', async () => {
    const dir = scratch();
    try {
      await preflight({
        stateDir: dir,
        port: 3000,
        hostname: 'localhost',
        portBound: () => true,
        holder: async () => ({}),
      }).catch(() => undefined);
      // A claim held past a refusal would make `x dev --port 3002` — the fix line this very
      // refusal prints — fail with X_DEV_ALREADY_RUNNING naming the process that just exited.
      expect(await Bun.file(lockPath(dir)).exists()).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('a live lock is refused, and the refusal names the pid holding the directory', async () => {
    const dir = scratch();
    try {
      await writeLock(dir, LOCK);
      const thrown = await preflight({
        stateDir: dir,
        port: 3000,
        hostname: 'localhost',
        embeddedDb: true,
        portBound: () => false,
        alive: () => true,
      }).catch((error: unknown) => error);
      expect(thrown).toBeInstanceOf(DevAlreadyRunningError);
      const error = thrown as DevAlreadyRunningError;
      expect(error.code).toBe('X_DEV_ALREADY_RUNNING');
      expect(error.cause).toContain('4242');
      expect(error.cause).toContain('single-writer');
      // The remedy is the running server or stopping it — never `x dev`, which is what the
      // framework's own X_DB_UNAVAILABLE used to say when this exact thing happened.
      expect(error.fix).toContain('kill 4242');
      expect(error.fix).not.toMatch(/^x dev/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('a stale lock is cleared and the boot continues — a hard kill must not block the next one', async () => {
    const dir = scratch();
    try {
      await writeLock(dir, LOCK);
      const result = await preflight({
        stateDir: dir,
        port: 3000,
        hostname: 'localhost',
        portBound: () => false,
        alive: () => false,
      });
      expect(result.clearedStale).toBe(true);
      // The dead pid's lock is gone and THIS process holds the directory: cleared, then claimed,
      // in one pass. An empty path here would be the check-then-act window reopened.
      expect(parseLock(await Bun.file(lockPath(dir)).text())?.pid).toBe(process.pid);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('an unparseable lock is treated as stale, not as a live owner', async () => {
    const dir = scratch();
    try {
      writeFileSync(join(dir, DEV_LOCK_FILE), 'not json');
      const result = await preflight({
        stateDir: dir,
        port: 3000,
        hostname: 'localhost',
        portBound: () => false,
      });
      expect(result.clearedStale).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('a taken port is refused with a runnable --port, and names the holder when the OS says', async () => {
    const dir = scratch();
    try {
      const thrown = await preflight({
        stateDir: dir,
        port: 3000,
        hostname: 'localhost',
        portBound: () => true,
        holder: async () => ({ pid: 99, command: 'docker-pr' }),
      }).catch((error: unknown) => error);
      expect(thrown).toBeInstanceOf(DevPortInUseError);
      const error = thrown as DevPortInUseError;
      expect(error.code).toBe('X_PORT_IN_USE');
      expect(error.cause).toContain('docker-pr');
      expect(error.cause).toContain('99');
      // Two up, never one: `x dev --port 3001` binds 3001 AND 3002 for sync, and 3001 is the
      // neighbour of the very pair that was refused (`portPairAfter`).
      expect(error.fix).toContain('x dev --port 3002');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('an unidentifiable holder still gets a refusal with a remedy — root-owned ports are common', async () => {
    const dir = scratch();
    try {
      const thrown = (await preflight({
        stateDir: dir,
        port: 3000,
        hostname: 'localhost',
        portBound: () => true,
        holder: async () => ({}),
      }).catch((error: unknown) => error)) as DevPortInUseError;
      expect(thrown.cause).toContain('another process');
      expect(thrown.fix).toBe('x dev --port 3002');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('the lock check runs BEFORE the port check — a second x dev is not a port problem', async () => {
    // Moving a second `x dev` to another port would still fail on the single-writer database, so
    // reporting the port first would send the reader down the wrong path entirely.
    const dir = scratch();
    try {
      await writeLock(dir, LOCK);
      const thrown = await preflight({
        stateDir: dir,
        port: 3000,
        hostname: 'localhost',
        portBound: () => true,
        alive: () => true,
      }).catch((error: unknown) => error);
      expect(thrown).toBeInstanceOf(DevAlreadyRunningError);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('a lock file this process can neither read nor remove', () => {
  // A DIRECTORY at `dev.lock` reaches every branch of that path for real: `openSync(…, 'wx')` is
  // EEXIST so the claim fails, `Bun.file(…).exists()` is false so both reads answer `null`, and
  // `unlinkSync` is EISDIR so the file survives the clear. Nothing is stubbed.
  test('is its own refusal, and never this process reported as the holder', async () => {
    const dir = scratch();
    try {
      mkdirSync(lockPath(dir));
      const thrown = (await preflight({
        stateDir: dir,
        port: 3000,
        hostname: 'localhost',
        portBound: () => false,
        alive: () => true,
      }).catch((error: unknown) => error)) as DevLockUnreadableError;

      // Measured before this landed: `X_DEV_ALREADY_RUNNING`, `pid <this process> is already
      // running x dev`, and `fix: … kill <this process>` — a remedy that kills its own reader.
      expect(thrown).toBeInstanceOf(DevLockUnreadableError);
      expect(thrown.code).toBe('X_DEV_LOCK_UNREADABLE');
      expect(thrown.cause).not.toContain(String(process.pid));
      expect(thrown.fix).toBe(`rm ${lockPath(dir)}   # then re-run x dev`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('services other than the embedded database', () => {
  test('the lock still holds with an external DATABASE_URL — it is a checkout lock', async () => {
    // `x dev` runs every role in ONE process (role-start.ts), so a second one is unsupported
    // whatever the services are. Gating the lock on the database would leave the shared state
    // directory — embedded storage and events still live there — with two writers.
    const dir = scratch();
    try {
      await writeLock(dir, LOCK);
      const thrown = (await preflight({
        stateDir: dir,
        port: 3000,
        hostname: 'localhost',
        embeddedDb: false,
        portBound: () => false,
        alive: () => true,
      }).catch((error: unknown) => error)) as DevAlreadyRunningError;
      expect(thrown).toBeInstanceOf(DevAlreadyRunningError);
      // …but the CAUSE must not name a mechanism that is not in play. Claiming embedded Postgres
      // against an external DATABASE_URL is the same defect as the message this module replaced.
      expect(thrown.cause).not.toContain('single-writer');
      expect(thrown.cause).toContain('one process');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('an unspecified database says the neutral thing, never the embedded one', async () => {
    const dir = scratch();
    try {
      await writeLock(dir, LOCK);
      const thrown = (await preflight({
        stateDir: dir,
        port: 3000,
        hostname: 'localhost',
        portBound: () => false,
        alive: () => true,
      }).catch((error: unknown) => error)) as DevAlreadyRunningError;
      expect(thrown.cause).not.toContain('single-writer');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('portHolder', () => {
  test('goes through the exec Runner, so a test never races a real socket', async () => {
    const calls: string[][] = [];
    const holder = await portHolder(3000, async (command) => {
      calls.push([...command]);
      return {
        command,
        code: 0,
        ok: true,
        stdout: 'LISTEN 0 512 *:3000 *:* users:(("bun",pid=41234,fd=11))',
        stderr: '',
        durationMs: 0,
      };
    });
    expect(holder).toEqual({ command: 'bun', pid: 41234 });
    expect(calls[0]?.[0]).toBe('ss');
  });

  test('a missing ss falls through to lsof rather than escaping as X_CLI_UNEXPECTED', async () => {
    // `exec` refuses a missing program with the CLI's catch-all. Letting that escape would replace
    // X_PORT_IN_USE with X_CLI_UNEXPECTED — the exact substitution this module exists to end.
    const holder = await portHolder(3000, async (command) => {
      // Exactly what `exec` raises for a missing program, not a bare Error: the point of the test
      // is that THIS refusal does not escape as the CLI's catch-all.
      if (command[0] === 'ss') throw missingProgram('ss');
      return {
        command,
        code: 0,
        ok: true,
        stdout: 'p41234\ncbun\n',
        stderr: '',
        durationMs: 0,
      };
    });
    expect(holder).toEqual({ command: 'bun', pid: 41234 });
  });

  test('neither tool available is an empty holder, never a throw', async () => {
    const holder = await portHolder(3000, async ([head]) => {
      throw missingProgram(head ?? '?');
    });
    expect(holder).toEqual({});
  });
});

describe('clearLock', () => {
  test('removes the file, and is safe to call again — shutdown paths overlap', async () => {
    const dir = scratch();
    try {
      await writeLock(dir, LOCK);
      clearLock(dir);
      expect(await Bun.file(lockPath(dir)).exists()).toBe(false);
      expect(() => clearLock(dir)).not.toThrow();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// K14: the claim used to be `openSync(path, 'wx')` and THEN a write. Between the two a racing
// preflight read an empty file, parsed it as a stale lock, unlinked the live claim and took the
// slot itself — two `x dev` on one `.x/pgdata`. Real processes, released together off one barrier,
// because the window is between two syscalls and only separate processes can land inside it.
describe('claim · racing claimers', () => {
  const CLAIMERS = 12;
  const ROUNDS = 2;

  const claimer = (dir: string, barrier: string): string => `
import { preflight } from ${JSON.stringify(join(import.meta.dir, 'dev-lock.ts'))};
while (!(await Bun.file(${JSON.stringify(barrier)}).exists())) await Bun.sleep(1);
let verdict = 'won';
try {
  await preflight({ stateDir: ${JSON.stringify(dir)}, port: 3000, hostname: 'localhost', portBound: () => false });
} catch (error) {
  verdict = 'refused:' + String((error as { code?: unknown }).code);
}
console.log(verdict);
// Alive while the others decide: a winner that exited would read as a stale lock, legitimately.
await Bun.sleep(800);
`;

  test('exactly one of many simultaneous claimers wins, every round', async () => {
    for (let round = 0; round < ROUNDS; round += 1) {
      const dir = scratch();
      try {
        const barrier = join(dir, 'go');
        const script = join(dir, 'claim.ts');
        writeFileSync(script, claimer(join(dir, '.x'), barrier));
        const procs = Array.from({ length: CLAIMERS }, () =>
          Bun.spawn([process.execPath, script], { stdout: 'pipe', stderr: 'pipe' }),
        );
        // Every child has started and is polling before the barrier drops.
        await Bun.sleep(400);
        writeFileSync(barrier, '');
        const verdicts = await Promise.all(
          procs.map(async (proc) => (await new Response(proc.stdout).text()).trim()),
        );
        await Promise.all(procs.map((proc) => proc.exited));
        expect(verdicts.filter((verdict) => verdict === 'won')).toHaveLength(1);
        expect(
          verdicts
            .filter((verdict) => verdict !== 'won')
            .every((v) => v.startsWith('refused:X_DEV_')),
        ).toBe(true);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }
  }, 60_000);
});
