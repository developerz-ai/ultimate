// The hand-off to an app's own CLI is a parent that only waits. A supervisor stopping it — a
// terminal closing (SIGHUP), `docker stop`/systemd (SIGTERM), Ctrl-C in a non-interactive shell
// (SIGINT) — signals THIS pid; without forwarding, the parent died and the child it spawned ran on
// as an orphan, a `x dev` still holding its port and its embedded Postgres (plan 101 K12).
// SIGINT is the hard one: a terminal's Ctrl-C already reached the child, a targeted one did not.

import { afterEach, describe, expect, test } from 'bun:test';
// why: Bun ships no temp-directory primitive and no recursive delete.
import { mkdtemp, rm } from 'node:fs/promises';
// why: Bun exposes no tmpdir(), so only node:os answers the platform temp root.
import { tmpdir } from 'node:os';
// why: Bun exposes no path-join primitive.
import { join } from 'node:path';
import type { HandOffChild, HandOffSignal, Schedule } from './local-cli-handoff';
import { HAND_OFF_SIGNALS, handOff } from './local-cli-handoff';

const WATCHED = [...HAND_OFF_SIGNALS, 'SIGINT'] as const;

const dirs: string[] = [];
afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

/** A child that records every signal it is sent and exits when told to. */
function fakeChild(): { child: HandOffChild; sent: HandOffSignal[]; exit: (code: number) => void } {
  const sent: HandOffSignal[] = [];
  let exit = (_code: number): void => undefined;
  const exited = new Promise<number>((resolve) => {
    exit = resolve;
  });
  return { child: { exited, kill: (signal) => sent.push(signal) }, sent, exit };
}

/** The grace timer, held by the test: `expire()` is the deadline passing, with no clock involved. */
function heldTimer(): { schedule: Schedule; armed: () => number; expire: () => void } {
  let pending: (() => void) | undefined;
  let armed = 0;
  return {
    schedule: (fire) => {
      armed += 1;
      pending = fire;
      return () => {
        pending = undefined;
      };
    },
    armed: () => armed,
    expire: () => {
      const fire = pending;
      pending = undefined;
      fire?.();
    },
  };
}

/**
 * The child's `ready <pid>` line, read until its newline arrives: a pipe hands back whatever bytes
 * are there, and a partial `ready` parsed to a NaN pid the cleanup then could not kill.
 */
async function readyPid(stdout: ReadableStream<Uint8Array>): Promise<number> {
  const reader = stdout.getReader();
  const decoder = new TextDecoder();
  let buffered = '';
  while (!buffered.includes('\n')) {
    const { done, value } = await reader.read();
    if (done) return expect.unreachable(`stdout closed before a whole ready line: ${buffered}`);
    buffered += decoder.decode(value, { stream: true });
  }
  reader.releaseLock();
  const [word, pid] = (buffered.split('\n')[0] ?? '').trim().split(' ');
  expect(word).toBe('ready');
  const parsed = Number(pid);
  expect(Number.isInteger(parsed) && parsed > 0).toBe(true);
  return parsed;
}

describe('unit · the local-CLI hand-off forwards the stop signals', () => {
  test('SIGTERM and SIGHUP reach the child at once; SIGINT is not sent while the child stops', async () => {
    const fake = fakeChild();
    const timer = heldTimer();
    const before = WATCHED.map((signal) => process.listenerCount(signal));
    const done = handOff(['bun', 'local-bin.ts'], {}, { spawn: () => fake.child, ...timer });
    for (const signal of WATCHED) process.emit(signal, signal);
    // Ctrl-C reaches the whole foreground group: the child already has its SIGINT.
    expect(fake.sent).toEqual(['SIGTERM', 'SIGHUP']);
    fake.exit(130);
    expect(await done).toBe(130);
    // The child stopped inside the grace: the deadline is cancelled, so it can never fire late.
    timer.expire();
    expect(fake.sent).toEqual(['SIGTERM', 'SIGHUP']);
    // Released with the child: a listener left behind would keep forwarding to a dead pid.
    expect(WATCHED.map((signal) => process.listenerCount(signal))).toEqual(before);
  });

  test('a SIGINT the child did not stop on within the grace is forwarded, once', async () => {
    // `kill -INT <parent>`, or a runtime whose STOPSIGNAL is SIGINT: only this pid was signalled.
    const fake = fakeChild();
    const timer = heldTimer();
    const done = handOff(['bun', 'local-bin.ts'], {}, { spawn: () => fake.child, ...timer });
    process.emit('SIGINT', 'SIGINT');
    // A repeat inside one grace starts no second deadline: one forward per window, never two.
    process.emit('SIGINT', 'SIGINT');
    expect(timer.armed()).toBe(1);
    expect(fake.sent).toEqual([]);
    timer.expire();
    expect(fake.sent).toEqual(['SIGINT']);
    fake.exit(130);
    expect(await done).toBe(130);
  });

  test('a real SIGTERM to the parent stops the child, and the parent exits with its code', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'x-handoff-'));
    dirs.push(dir);
    const child = join(dir, 'child.ts');
    await Bun.write(
      child,
      "process.on('SIGTERM', () => process.exit(42));\nconsole.log('ready', process.pid);\nsetInterval(() => undefined, 1000);\n",
    );
    const parent = join(dir, 'parent.ts');
    await Bun.write(
      parent,
      `import { handOff } from ${JSON.stringify(join(import.meta.dir, 'local-cli-handoff.ts'))};\n` +
        `process.exit(await handOff([process.execPath, ${JSON.stringify(child)}], Bun.env));\n`,
    );
    const proc = Bun.spawn([process.execPath, parent], { stdout: 'pipe', stderr: 'inherit' });
    // Signalled only once the child is listening, so the verdict is about forwarding, not timing.
    const childPid = await readyPid(proc.stdout);
    try {
      proc.kill('SIGTERM');
      expect(await proc.exited).toBe(42);
    } finally {
      // A regression leaves the child orphaned, holding the pipe open: never leak it past the test.
      try {
        process.kill(childPid, 'SIGKILL');
      } catch {
        // Already gone — the passing case.
      }
    }
  });

  test('a SIGINT sent to the parent pid alone still stops the child', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'x-handoff-'));
    dirs.push(dir);
    const child = join(dir, 'child.ts');
    await Bun.write(
      child,
      "process.on('SIGINT', () => process.exit(41));\nconsole.log('ready', process.pid);\nsetInterval(() => undefined, 1000);\n",
    );
    const parent = join(dir, 'parent.ts');
    await Bun.write(
      parent,
      `import { handOff } from ${JSON.stringify(join(import.meta.dir, 'local-cli-handoff.ts'))};\n` +
        `process.exit(await handOff([process.execPath, ${JSON.stringify(child)}], Bun.env));\n`,
    );
    const proc = Bun.spawn([process.execPath, parent], { stdout: 'pipe', stderr: 'inherit' });
    const childPid = await readyPid(proc.stdout);
    try {
      // The parent's pid, not its group: the child hears of it only if the hand-off says so.
      proc.kill('SIGINT');
      expect(await proc.exited).toBe(41);
    } finally {
      try {
        process.kill(childPid, 'SIGKILL');
      } catch {
        // Already gone — the passing case.
      }
    }
  });

  // M1: Ctrl-C in `x secrets edit` behind a global `x`. The terminal signals the whole group, the
  // hand-off forwarded a SECOND SIGINT, and the child — mid-shred of its decrypted buffer — died on
  // it with the plaintext still in $TMPDIR. Real processes in their own group, signalled as a
  // terminal does it, with a shred slow enough that a second signal lands inside it.
  test('Ctrl-C to the process group shreds the buffer and exits with the child code', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'x-handoff-'));
    dirs.push(dir);
    const buffer = join(dir, 'secrets.json');
    const child = join(dir, 'child.ts');
    await Bun.write(
      child,
      `import { rmSync } from 'node:fs';\n` +
        `import { shredOnSignal } from ${JSON.stringify(join(import.meta.dir, 'signal-shred.ts'))};\n` +
        `await Bun.write(${JSON.stringify(buffer)}, 'plaintext');\n` +
        'shredOnSignal(() => {\n' +
        '  const until = Date.now() + 300;\n' +
        '  while (Date.now() < until) {}\n' +
        `  rmSync(${JSON.stringify(buffer)}, { force: true });\n` +
        '});\n' +
        "console.log('ready', process.pid);\n" +
        'setInterval(() => undefined, 1000);\n',
    );
    const parent = join(dir, 'parent.ts');
    await Bun.write(
      parent,
      `import { handOff } from ${JSON.stringify(join(import.meta.dir, 'local-cli-handoff.ts'))};\n` +
        `process.exit(await handOff([process.execPath, ${JSON.stringify(child)}], Bun.env));\n`,
    );
    // `setsid` execs in place, so the parent's pid is its new group's id, as a shell job's is.
    const proc = Bun.spawn(['setsid', process.execPath, parent], { stdout: 'pipe' });
    const childPid = await readyPid(proc.stdout);
    try {
      process.kill(-proc.pid, 'SIGINT');
      expect(await proc.exited).toBe(130);
      expect(await Bun.file(buffer).exists()).toBe(false);
    } finally {
      try {
        process.kill(childPid, 'SIGKILL');
      } catch {
        // Already gone — the passing case.
      }
    }
  });
});
