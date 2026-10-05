// The hand-off to an app's own CLI is a parent that only waits. A supervisor stopping it — a
// terminal closing (SIGHUP), `docker stop`/systemd (SIGTERM), Ctrl-C in a non-interactive shell
// (SIGINT) — signals THIS pid; without forwarding, the parent died and the child it spawned ran on
// as an orphan, a `x dev` still holding its port and its embedded Postgres (plan 101 K12).

import { afterEach, describe, expect, test } from 'bun:test';
// why: Bun ships no temp-directory primitive and no recursive delete.
import { mkdtemp, rm } from 'node:fs/promises';
// why: Bun exposes no tmpdir(), so only node:os answers the platform temp root.
import { tmpdir } from 'node:os';
// why: Bun exposes no path-join primitive.
import { join } from 'node:path';
import type { HandOffChild, HandOffSignal } from './local-cli-handoff';
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

describe('unit · the local-CLI hand-off forwards the stop signals', () => {
  test('SIGTERM and SIGHUP reach the child; SIGINT is not sent a second time', async () => {
    const fake = fakeChild();
    const before = WATCHED.map((signal) => process.listenerCount(signal));
    const done = handOff(['bun', 'local-bin.ts'], {}, () => fake.child);
    for (const signal of WATCHED) process.emit(signal, signal);
    // Ctrl-C reaches the whole foreground group: the child already has its SIGINT.
    expect(fake.sent).toEqual(['SIGTERM', 'SIGHUP']);
    fake.exit(130);
    expect(await done).toBe(130);
    // Released with the child: a listener left behind would keep forwarding to a dead pid.
    expect(WATCHED.map((signal) => process.listenerCount(signal))).toEqual(before);
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
    const reader = proc.stdout.getReader();
    const { value } = await reader.read();
    const line = new TextDecoder().decode(value);
    expect(line).toContain('ready');
    const childPid = Number(line.trim().split(' ')[1]);
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
    const { value } = await proc.stdout.getReader().read();
    const line = new TextDecoder().decode(value);
    expect(line).toContain('ready');
    const childPid = Number(line.trim().split(' ')[1]);
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
