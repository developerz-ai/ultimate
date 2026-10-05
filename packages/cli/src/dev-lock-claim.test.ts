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

const realWrite = fs.writeFileSync;
const seen: string[] = [];
let watched = '';

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
}));

const { lockPath, parseLock, preflight } = await import('./dev-lock');

afterAll(() => {
  // `mock.restore()` does not undo `mock.module`, and a run may share this process with other
  // files: the wrapper stays, so it is made inert — it only ever delegates once `watched` is empty.
  watched = '';
  seen.length = 0;
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
