// K14, deterministically: the claim's lock file must never be visible to another process without
// its contents. It was `openSync(path, 'wx')` and THEN a write; a racing preflight that read the
// file in between parsed an empty lock as stale, unlinked the live claim and took the slot — two
// `x dev` on one single-writer `.x/pgdata`. The window is two syscalls wide, so this observes it
// directly: every write the claim makes snapshots what a rival reading the lock path would see.

import { afterAll, describe, expect, mock, test } from 'bun:test';
// why: the claim is built on these synchronous calls; the test wraps the same module it uses.
import * as fs from 'node:fs';
// why: Bun exposes no tmpdir(), so only node:os answers the platform temp root.
import { tmpdir } from 'node:os';
// why: Bun exposes no path-join primitive.
import { join } from 'node:path';
import { UltimateError } from '@ultimat3/core';

const realWrite = fs.writeFileSync;
const realLink = fs.linkSync;
const seen: string[] = [];
let watched = '';
/** The errno the next `linkSync` fails with — a filesystem without hard links — or none. */
let linkFails: string | undefined;

/** What a rival preflight reading the lock path would get at this instant. */
const rivalView = (): string => {
  if (watched === '' || !fs.existsSync(watched)) return '<absent>';
  return fs.readFileSync(watched, 'utf8');
};

await mock.module('node:fs', () => ({
  ...fs,
  writeFileSync: (...args: Parameters<typeof fs.writeFileSync>) => {
    if (watched !== '') seen.push(rivalView());
    return realWrite(...args);
  },
  linkSync: (...args: Parameters<typeof fs.linkSync>) => {
    if (linkFails !== undefined) {
      const refusal = Object.assign(new Error(`${linkFails}: operation not permitted, link`), {
        code: linkFails,
      });
      throw refusal;
    }
    return realLink(...args);
  },
}));

const { lockPath, parseLock, preflight } = await import('./dev-lock');

afterAll(() => {
  // `mock.restore()` does not undo `mock.module`, and a run may share this process with other
  // files: the wrapper stays, so it is made inert — it only ever delegates once `watched` is empty.
  watched = '';
  seen.length = 0;
  linkFails = undefined;
  mock.restore();
});

describe('claim · the lock is never visible half-written', () => {
  test('a rival reading the lock path sees no file or a whole lock — never an empty one', async () => {
    const dir = fs.mkdtempSync(join(tmpdir(), 'ultimate-dev-lock-claim-'));
    try {
      watched = lockPath(dir);
      const claim = await preflight({
        stateDir: dir,
        port: 3000,
        hostname: 'localhost',
        portBound: () => false,
      });
      // The claim wrote something, or this proves nothing.
      expect(seen.length).toBeGreaterThan(0);
      for (const view of seen) {
        expect(view === '<absent>' || parseLock(view) !== null).toBe(true);
      }
      expect(parseLock(fs.readFileSync(watched, 'utf8'))?.pid).toBe(process.pid);
      // Nothing but the lock is left in the state directory: the staging file is gone.
      expect(fs.readdirSync(dir)).toEqual(['dev.lock']);
      claim.release();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

// A filesystem that refuses the hard link (exFAT, some SMB/FUSE mounts) is not a competing claim:
// only EEXIST is. Anything else escaped raw and reached the operator as X_CLI_UNEXPECTED.
describe('claim · a link the filesystem refuses is X_DEV_STATE_UNWRITABLE', () => {
  test('EPERM from linkSync names the state dir and the errno, and leaves nothing behind', async () => {
    const dir = fs.mkdtempSync(join(tmpdir(), 'ultimate-dev-lock-link-'));
    linkFails = 'EPERM';
    try {
      const refusal = await preflight({
        stateDir: dir,
        port: 3000,
        hostname: 'localhost',
        portBound: () => false,
      }).then(
        () => expect.unreachable('a refused link must not answer a claim'),
        (error: unknown) => error,
      );
      expect(refusal).toBeInstanceOf(UltimateError);
      const coded = refusal as UltimateError;
      expect(coded.code).toBe('X_DEV_STATE_UNWRITABLE');
      expect(coded.cause).toContain(dir);
      expect(coded.cause).toContain('EPERM');
      expect(coded.fix).toContain(`ls -ld ${dir}`);
      // The staging file is removed even on this path.
      expect(fs.readdirSync(dir)).toEqual([]);
    } finally {
      linkFails = undefined;
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

// K14: the claim used to be `openSync(path, 'wx')` and THEN a write. Between the two a racing
// preflight read an empty file, parsed it as a stale lock, unlinked the live claim and took the
// slot itself — two `x dev` on one `.x/pgdata`. Real processes, released together off one barrier,
// because the window is between two syscalls and only separate processes can land inside it.
//
// No timers decide anything: each child's stdin is its barrier. It says `ready` on stdout, blocks
// until the parent writes `go`, claims, prints its verdict, then blocks until the parent closes its
// stdin — so no winner exits (and becomes, legitimately, a stale lock) while a peer still decides.
describe('claim · racing claimers', () => {
  const CLAIMERS = 12;
  const ROUNDS = 2;

  const claimer = (dir: string): string => `
import { preflight } from ${JSON.stringify(join(import.meta.dir, 'dev-lock.ts'))};
const reader = Bun.stdin.stream().getReader();
const decoder = new TextDecoder();
let input = '';
const awaitLine = async (line: string): Promise<void> => {
  while (!input.split('\\n').includes(line)) {
    const { done, value } = await reader.read();
    // The parent went away before releasing this child: nothing left to decide.
    if (done) process.exit(2);
    input += decoder.decode(value, { stream: true });
  }
};
console.log('ready');
await awaitLine('go');
let verdict = 'won';
try {
  await preflight({ stateDir: ${JSON.stringify(dir)}, port: 3000, hostname: 'localhost', portBound: () => false });
} catch (error) {
  verdict = 'refused:' + String((error as { code?: unknown }).code);
}
console.log(verdict);
// Alive while the others decide: the parent closes stdin only once every verdict is in.
while (!(await reader.read()).done) {}
`;

  /** Every line the child prints, as it prints them — `next()` resolves once a WHOLE line is in. */
  const lines = (stream: ReadableStream<Uint8Array>): (() => Promise<string>) => {
    const reader = stream.getReader();
    const decoder = new TextDecoder();
    let buffered = '';
    return async () => {
      while (!buffered.includes('\n')) {
        const { done, value } = await reader.read();
        if (done) return expect.unreachable(`child stdout closed mid-line: ${buffered}`);
        buffered += decoder.decode(value, { stream: true });
      }
      const at = buffered.indexOf('\n');
      const line = buffered.slice(0, at);
      buffered = buffered.slice(at + 1);
      return line.trim();
    };
  };

  test('exactly one of many simultaneous claimers wins, every round', async () => {
    for (let round = 0; round < ROUNDS; round += 1) {
      const dir = fs.mkdtempSync(join(tmpdir(), 'ultimate-dev-lock-race-'));
      const procs: Bun.Subprocess<'pipe', 'pipe', 'pipe'>[] = [];
      try {
        const script = join(dir, 'claim.ts');
        realWrite(script, claimer(join(dir, '.x')));
        for (let i = 0; i < CLAIMERS; i += 1) {
          procs.push(
            Bun.spawn([process.execPath, script], {
              stdin: 'pipe',
              stdout: 'pipe',
              stderr: 'pipe',
            }),
          );
        }
        const readers = procs.map((proc) => lines(proc.stdout));
        // Readiness barrier: every child is blocked on its stdin before any is released.
        expect(await Promise.all(readers.map((next) => next()))).toEqual(
          Array.from({ length: CLAIMERS }, () => 'ready'),
        );
        for (const proc of procs) {
          proc.stdin.write('go\n');
          proc.stdin.flush();
        }
        const verdicts = await Promise.all(readers.map((next) => next()));
        // Completion barrier: only now may a winner exit.
        for (const proc of procs) proc.stdin.end();
        expect(await Promise.all(procs.map((proc) => proc.exited))).toEqual(
          Array.from({ length: CLAIMERS }, () => 0),
        );
        expect(verdicts.filter((verdict) => verdict === 'won')).toHaveLength(1);
        expect(
          verdicts
            .filter((verdict) => verdict !== 'won')
            .every((v) => v.startsWith('refused:X_DEV_')),
        ).toBe(true);
      } finally {
        for (const proc of procs) proc.kill();
        fs.rmSync(dir, { recursive: true, force: true });
      }
    }
  }, 60_000);
});
