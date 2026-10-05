import { afterEach, describe, expect, test } from 'bun:test';
// why: Bun ships no temp-directory primitive and no recursive delete.
import { mkdtemp, rm } from 'node:fs/promises';
// why: Bun exposes no tmpdir(), so only node:os answers the platform temp root.
import { tmpdir } from 'node:os';
// why: Bun exposes no path-join primitive.
import { join } from 'node:path';
import { shredOnSignal } from './signal-shred';

// Row s: the listener that shredded the buffer also swallowed the signal.
describe('unit · a signal shreds the buffer AND still terminates', () => {
  test('SIGINT shreds, then re-raises the same signal, and the listener is gone', () => {
    const calls: string[] = [];
    const before = process.listenerCount('SIGINT');
    shredOnSignal(
      () => calls.push('shred'),
      (signal) => calls.push(`reraise ${signal}`),
    );
    expect(process.listenerCount('SIGINT')).toBe(before + 1);
    process.emit('SIGINT', 'SIGINT');
    expect(calls).toEqual(['shred', 'reraise SIGINT']);
    expect(process.listenerCount('SIGINT')).toBe(before);
    process.emit('SIGTERM', 'SIGTERM');
  });

  test('the undo removes both listeners on the normal path', () => {
    const before = [process.listenerCount('SIGINT'), process.listenerCount('SIGTERM')];
    const undo = shredOnSignal(
      () => undefined,
      () => undefined,
    );
    undo();
    expect([process.listenerCount('SIGINT'), process.listenerCount('SIGTERM')]).toEqual(before);
  });
});

const dirs: string[] = [];
afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

// M1: `once` removed the listener before the shred ran, so a second signal during the shred met
// the DEFAULT action — a kernel-level kill, mid-`rmSync` — and the plaintext buffer survived.
describe('unit · a repeat signal during the shred is held until the shred is done', () => {
  test('a repeat is ignored, the listeners stay installed through the shred, then one re-raise', () => {
    const calls: string[] = [];
    const before = process.listenerCount('SIGINT');
    shredOnSignal(
      () => {
        calls.push(`shred with ${process.listenerCount('SIGINT') - before} listener`);
        process.emit('SIGINT', 'SIGINT');
        process.emit('SIGTERM', 'SIGTERM');
      },
      (signal) => calls.push(`reraise ${signal}`),
    );
    process.emit('SIGINT', 'SIGINT');
    expect(calls).toEqual(['shred with 1 listener', 'reraise SIGINT']);
    expect(process.listenerCount('SIGINT')).toBe(before);
  });

  test('SIGHUP — a closed terminal — shreds too', () => {
    const calls: string[] = [];
    shredOnSignal(
      () => calls.push('shred'),
      (signal) => calls.push(`reraise ${signal}`),
    );
    process.emit('SIGHUP', 'SIGHUP');
    expect(calls).toEqual(['shred', 'reraise SIGHUP']);
  });

  test('a real second SIGINT inside a slow shred does not kill the process before it finishes', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'x-shred-'));
    dirs.push(dir);
    const buffer = join(dir, 'secrets.json');
    const script = join(dir, 'edit.ts');
    await Bun.write(
      script,
      `import { rmSync } from 'node:fs';\n` +
        `import { shredOnSignal } from ${JSON.stringify(join(import.meta.dir, 'signal-shred.ts'))};\n` +
        `await Bun.write(${JSON.stringify(buffer)}, 'plaintext');\n` +
        'shredOnSignal(() => {\n' +
        "  console.log('shredding');\n" +
        '  const until = Date.now() + 400;\n' +
        '  while (Date.now() < until) {}\n' +
        `  rmSync(${JSON.stringify(buffer)}, { force: true });\n` +
        '});\n' +
        "console.log('ready');\n" +
        'setInterval(() => undefined, 1000);\n',
    );
    const proc = Bun.spawn([process.execPath, script], { stdout: 'pipe' });
    const reader = proc.stdout.getReader();
    let seen = '';
    while (!seen.includes('ready')) seen += new TextDecoder().decode((await reader.read()).value);
    proc.kill('SIGINT');
    while (!seen.includes('shredding'))
      seen += new TextDecoder().decode((await reader.read()).value);
    proc.kill('SIGINT');
    expect(await proc.exited).toBe(130);
    expect(await Bun.file(buffer).exists()).toBe(false);
  });
});
