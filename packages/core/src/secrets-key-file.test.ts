// A master key's file must be readable by its owner alone on every platform. POSIX gets that from
// the create mode; Windows ignores the mode, so the file's ACL is cut down to the current account
// before the rename makes it live. Both halves run here against an injected filesystem; the real
// ACL is read back by `icacls` in the win32-only test at the bottom.

import { afterAll, describe, expect, test } from 'bun:test';
// why: Bun ships no temp-directory primitive and no recursive remove: `mkdtemp`/`rm` own the roots.
import { mkdtemp, readdir, rm } from 'node:fs/promises';
// why: Bun exposes no tmpdir(), so only node:os answers the platform temp root.
import { tmpdir } from 'node:os';
// why: Bun exposes no path-join primitive.
import { join } from 'node:path';
import { isUltimateError } from './errors';
import {
  aclPrincipal,
  type KeyFileIo,
  ownerOnlyAclArgv,
  RENAME_ATTEMPTS,
  renameOver,
  writeOwnerOnlyFile,
} from './secrets-key-file';

type Call = readonly [string, ...unknown[]];

/** A filesystem that records every call and fails where a test says to. */
function fakeIo(over: Partial<KeyFileIo> & { calls?: Call[] } = {}): KeyFileIo & { calls: Call[] } {
  const calls: Call[] = over.calls ?? [];
  return {
    platform: 'linux',
    env: {},
    writeExclusive: (path, text, mode) => {
      calls.push(['write', path, text, mode]);
    },
    rename: (from, to) => {
      calls.push(['rename', from, to]);
    },
    remove: (path) => {
      calls.push(['remove', path]);
    },
    runAcl: (argv) => {
      calls.push(['acl', ...argv]);
      return { exitCode: 0, output: 'processed file' };
    },
    username: () => 'fallback',
    sleep: (ms) => {
      calls.push(['sleep', ms]);
    },
    ...over,
    calls,
  };
}

const errnoError = (code: string): Error => Object.assign(new Error(code), { code });

describe('writeOwnerOnlyFile on POSIX', () => {
  test('writes a fresh temp file at 0600 and renames it over the target, running no icacls', () => {
    const io = fakeIo();
    writeOwnerOnlyFile('/app/.secrets.key', 'k\n', io);
    const [write, rename, ...rest] = io.calls;
    expect(write?.[0]).toBe('write');
    expect(String(write?.[1])).toMatch(/^\/app\/\.secrets\.key\..+\.tmp$/);
    expect(write?.slice(2)).toEqual(['k\n', 0o600]);
    expect(rename).toEqual(['rename', write?.[1], '/app/.secrets.key']);
    expect(rest).toEqual([]);
  });
});

describe('writeOwnerOnlyFile on Windows', () => {
  test('restricts the TEMP file to the current account before the rename makes it live', () => {
    const io = fakeIo({ platform: 'win32', env: { USERDOMAIN: 'CORP', USERNAME: 'dev' } });
    writeOwnerOnlyFile('C:\\app\\.secrets.key', 'k\n', io);
    const temp = String(io.calls[0]?.[1]);
    expect(io.calls.map((call) => call[0])).toEqual(['write', 'acl', 'rename']);
    expect(io.calls[1]).toEqual(['acl', ...ownerOnlyAclArgv(temp, 'CORP\\dev')]);
  });

  test('an icacls refusal writes no key: the temp file is removed and the error names the fix', () => {
    const io = fakeIo({
      platform: 'win32',
      env: { USERNAME: 'dev' },
      runAcl: () => ({ exitCode: 1332, output: 'No mapping between account names and SIDs' }),
    });
    let thrown: unknown;
    try {
      writeOwnerOnlyFile('C:\\app\\.secrets.key', 'k\n', io);
    } catch (error) {
      thrown = error;
    }
    expect(isUltimateError(thrown) && thrown.code).toBe('X_SECRETS_KEY_ACL_FAILED');
    if (!isUltimateError(thrown)) return expect.unreachable('expected an UltimateError');
    expect(thrown.cause).toContain('1332');
    expect(thrown.cause).toContain('No mapping between account names and SIDs');
    expect(thrown.fix).toContain('where.exe icacls');
    const temp = String(io.calls[0]?.[1]);
    expect(io.calls.at(-1)).toEqual(['remove', temp]);
    expect(io.calls.some((call) => call[0] === 'rename')).toBe(false);
  });
});

describe('aclPrincipal', () => {
  test('domain\\user when Windows names both, the bare user otherwise', () => {
    expect(aclPrincipal({ USERDOMAIN: 'CORP', USERNAME: 'dev' }, () => 'x')).toBe('CORP\\dev');
    expect(aclPrincipal({ USERNAME: 'dev' }, () => 'x')).toBe('dev');
    expect(aclPrincipal({}, () => 'from-os')).toBe('from-os');
  });

  test('the grant replaces, and inheritance is removed — no ACE the profile handed down survives', () => {
    expect(ownerOnlyAclArgv('C:\\k.tmp', 'CORP\\dev')).toEqual([
      'icacls',
      'C:\\k.tmp',
      '/inheritance:r',
      '/grant:r',
      'CORP\\dev:F',
    ]);
  });
});

describe('renameOver', () => {
  test('a target held open (EPERM, EBUSY) is retried with a growing backoff, then succeeds', () => {
    let failures = 2;
    const io = fakeIo({
      rename: (from, to) => {
        io.calls.push(['rename', from, to]);
        if (failures-- > 0) throw errnoError(failures === 1 ? 'EPERM' : 'EBUSY');
      },
    });
    renameOver('a', 'b', io);
    expect(io.calls).toEqual([
      ['rename', 'a', 'b'],
      ['sleep', 10],
      ['rename', 'a', 'b'],
      ['sleep', 20],
      ['rename', 'a', 'b'],
    ]);
  });

  test('the retry is bounded: the last EPERM is thrown after RENAME_ATTEMPTS tries', () => {
    const io = fakeIo({
      rename: (from, to) => {
        io.calls.push(['rename', from, to]);
        throw errnoError('EPERM');
      },
    });
    expect(() => renameOver('a', 'b', io)).toThrow('EPERM');
    expect(io.calls.filter((call) => call[0] === 'rename').length).toBe(RENAME_ATTEMPTS);
  });

  test('any other failure is not retried — a missing source is not a busy target', () => {
    const io = fakeIo({
      rename: (from, to) => {
        io.calls.push(['rename', from, to]);
        throw errnoError('ENOENT');
      },
    });
    expect(() => renameOver('a', 'b', io)).toThrow('ENOENT');
    expect(io.calls).toEqual([['rename', 'a', 'b']]);
  });
});

describe('integration · the real filesystem', () => {
  const roots: string[] = [];
  afterAll(async () => {
    await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
  });

  test('writes the text and leaves nothing beside it', async () => {
    const root = await mkdtemp(join(tmpdir(), 'key-file-'));
    roots.push(root);
    const path = join(root, '.secrets.key');
    writeOwnerOnlyFile(path, 'first\n');
    writeOwnerOnlyFile(path, 'second\n');
    expect(await Bun.file(path).text()).toBe('second\n');
    expect(await readdir(root)).toEqual(['.secrets.key']);
  });

  // The ACL itself, read back the way an operator would: only meaningful where icacls exists.
  test.skipIf(process.platform !== 'win32')(
    'on Windows the key carries one explicit ACE, the current account, and nothing inherited',
    async () => {
      const root = await mkdtemp(join(tmpdir(), 'key-file-acl-'));
      roots.push(root);
      const path = join(root, '.secrets.key');
      writeOwnerOnlyFile(path, 'k\n');
      const shown = Bun.spawnSync(['icacls', path], { timeout: 10_000 });
      const text = shown.stdout.toString();
      expect(shown.exitCode).toBe(0);
      expect(text).not.toContain('(I)');
      expect(text).toContain(`${Bun.env['USERNAME'] ?? ''}:(F)`);
      for (const broad of ['Everyone', 'BUILTIN\\Users', 'Authenticated Users']) {
        expect(text).not.toContain(broad);
      }
    },
  );
});
