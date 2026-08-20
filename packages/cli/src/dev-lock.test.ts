// The preflight's whole job is to turn two confusing late failures into two precise early ones, so
// what matters here is that each refusal names the right cause and offers a remedy that RUNS.

import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { UltimateError } from '@ultimat3/core';
import {
  clearLock,
  DEV_LOCK_FILE,
  DevAlreadyRunningError,
  DevPortInUseError,
  isProcessAlive,
  lockPath,
  parseLock,
  portHolder,
  preflight,
  suggestPort,
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

describe('suggestPort', () => {
  test('the next port up, except at the top of the range', () => {
    expect(suggestPort(3000)).toBe(3001);
    // 65536 is not a port, and a `fix:` that cannot run is the failure this module exists to end.
    expect(suggestPort(65535)).toBe(65534);
  });
});

describe('preflight', () => {
  test('a clean directory and a free port pass, clearing nothing', async () => {
    const dir = scratch();
    try {
      expect(
        await preflight({
          stateDir: dir,
          port: 3000,
          hostname: 'localhost',
          portBound: () => false,
        }),
      ).toEqual({ clearedStale: false });
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
      expect(await Bun.file(lockPath(dir)).exists()).toBe(false);
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
      expect(error.fix).toContain('x dev --port 3001');
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
      expect(thrown.fix).toBe('x dev --port 3001');
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

describe('services other than the embedded database', () => {
  test('the lock still holds with an external DATABASE_URL — it is a checkout lock', async () => {
    // `x dev` runs every role in ONE process (dev-roles.ts), so a second one is unsupported
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
