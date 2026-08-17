// The branch facts, both databases, no live Postgres: the embedded half against a real temp
// directory and the external half against `@ultimat3/db`'s recording client. What every case here
// is really pinning is that a branch NAME and a branch VERB are different things — the confusion
// that made `x db branch ls` clone a database called `ls`.

import { describe, expect, test } from 'bun:test';
// `node:fs` — Bun has no temp-directory API and no directory listing; `node:path` — no joiner.
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRecordingClient } from '@ultimat3/db';
import {
  BRANCH_SUBCOMMANDS,
  branchDatabaseName,
  branchNameIn,
  branchNameOf,
  createExternalBranch,
  createPgliteBranch,
  dropExternalBranch,
  dropPgliteBranch,
  isBranchName,
  isBranchSubcommand,
  listExternalBranches,
  listPgliteBranches,
  pgliteBranchName,
  previewUrl,
} from './db-branch';

/** A `.x` state directory with a data directory in it, the way `x dev` leaves one. */
function stateDir(): { readonly dir: string; readonly url: string } {
  const dir = mkdtempSync(join(tmpdir(), 'x-branch-'));
  mkdirSync(join(dir, 'pgdata'));
  return { dir, url: `pglite://${join(dir, 'pgdata')}` };
}

describe('unit · the verb set is closed', () => {
  test('every verb is a legal branch name, which is exactly why the verb comes first', () => {
    // `ls`, `create` and `drop` all pass `assertBranchName`, so a command that read its argument
    // as a name could never have told them apart from one. Requiring the verb is what does.
    for (const verb of BRANCH_SUBCOMMANDS) {
      expect(isBranchName(verb)).toBe(true);
      expect(isBranchSubcommand(verb)).toBe(true);
    }
    expect(isBranchSubcommand('feat-new-billing')).toBe(false);
    expect(isBranchName('../../etc')).toBe(false);
  });
});

describe('unit · the two directions of a branch name', () => {
  test('the database name round-trips back to the branch it was made for', () => {
    expect(branchDatabaseName('postly', 'feat/new-thing')).toBe('postly_branch_feat_new_thing');
    expect(branchNameOf('postly_branch_feat_new_thing')).toBe('feat_new_thing');
    // A database nothing named this way is not a branch, and is answered as such.
    expect(branchNameOf('postly')).toBeNull();
  });

  test('asked of ONE source, a name is the exact inverse of the database it names', () => {
    // What `ls` shows is what `drop` derives its target from, so the two must be inverses or the
    // listing is a set of names the command cannot act on.
    for (const branch of ['feat_x', 'a_branch_b', 'x']) {
      expect(branchNameIn('postly', branchDatabaseName('postly', branch))).toBe(branch);
    }
    // Another app's clone on the same server, and the row `branchNameOf` reduced to `feat` — one
    // name for two databases is what let a listing authorise a drop against the wrong one.
    expect(branchNameOf('analytics_branch_feat')).toBe('feat');
    expect(branchNameIn('postly', 'analytics_branch_feat')).toBeNull();
    // A branch of a branch, seen from the branch: `b`, not `a_branch_b`.
    expect(branchNameIn('postly_branch_a', 'postly_branch_a_branch_b')).toBe('b');
    expect(branchNameIn('postly', 'postly')).toBeNull();
  });

  test('the data directory round-trips the same way', () => {
    expect(pgliteBranchName('/app/.x/pgdata-feat-x', '/app/.x/pgdata')).toBe('feat-x');
    // The dev directory is not a branch of itself, and a sibling is not one either.
    expect(pgliteBranchName('/app/.x/pgdata', '/app/.x/pgdata')).toBeNull();
    expect(pgliteBranchName('/other/pgdata', '/app/.x/pgdata')).toBeNull();
  });

  test('the preview url is the branch, not the database', () => {
    expect(previewUrl('feat-x', 3000)).toBe('http://feat-x.localhost:3000');
  });
});

describe('unit · the embedded database', () => {
  test('an app that has never branched lists nothing, and does not fail over it', async () => {
    const { dir, url } = stateDir();
    try {
      expect(await listPgliteBranches(url)).toEqual([]);
      // A directory that does not exist at all is the same answer, not a throw: `x db branch ls`
      // has to be runnable before `x dev` has ever booted.
      expect(await listPgliteBranches('pglite:///nope/pgdata')).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('create then list then drop, and the dev directory is never in the set', async () => {
    const { dir, url } = stateDir();
    try {
      await Bun.write(join(dir, 'pgdata', 'PG_VERSION'), '15\n');
      const created = await createPgliteBranch(url, 'feat-x');
      expect(created.location).toBe(join(dir, 'pgdata-feat-x'));

      const listed = await listPgliteBranches(url);
      expect(listed.map((branch) => branch.name)).toEqual(['feat-x']);
      // `pgdata` itself shares the prefix and is deliberately not a branch of itself — the whole
      // reason `drop` can be told "you may only drop what ls shows".
      expect(listed.map((branch) => branch.location)).not.toContain(join(dir, 'pgdata'));

      expect(await dropPgliteBranch(url, 'feat-x')).toBe(true);
      expect(await listPgliteBranches(url)).toEqual([]);
      // Idempotent, and it says so: "there was no branch there" is the answer a teardown wants.
      expect(await dropPgliteBranch(url, 'feat-x')).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('a name that would escape the state directory never reaches the filesystem', async () => {
    const { dir, url } = stateDir();
    try {
      const thrown: unknown = await dropPgliteBranch(url, '../..').then(
        () => undefined,
        (error: unknown) => error,
      );
      expect(thrown).toBeUltimateError('X_SQL_UNSAFE');
      expect(await listPgliteBranches(url)).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('unit · the external database', () => {
  test('only databases carrying the branch marker are branches', async () => {
    const client = createRecordingClient();
    client.on('current_database', { rows: [{ name: 'postly' }] });
    client.on('pg_database', {
      rows: [
        { name: 'postly', comment: null, size_bytes: 4096 },
        {
          name: 'postly_branch_feat_x',
          comment: 'ultimate:branch:2026-08-01T00:00:00.000Z',
          size_bytes: 8192,
        },
      ],
    });

    // The shared database is right there in `pg_database` and is not in the answer: that is what
    // stops `x db branch drop postly` from ever being attempted.
    expect(await listExternalBranches(client)).toEqual([
      {
        name: 'feat_x',
        location: 'postly_branch_feat_x',
        createdAt: '2026-08-01T00:00:00.000Z',
        sizeBytes: 8192,
      },
    ]);
  });

  /**
   * One Postgres server, two Ultimate apps. The marker records WHEN a clone was made and never
   * what it was cloned FROM, so `listBranches()` answers with every marked database on the server
   * — and both `postly_branch_feat` and `analytics_branch_feat` reduced to the branch name `feat`.
   * The listing is the whole of `drop`'s guard, so a row belonging to another app authorised a
   * `drop database` this session's own listing had never approved.
   */
  const twoApps = (): ReturnType<typeof createRecordingClient> => {
    const client = createRecordingClient();
    client.on('current_database', { rows: [{ name: 'postly' }] });
    client.on('pg_database', {
      rows: [
        { name: 'postly', comment: null, size_bytes: 4096 },
        {
          name: 'analytics_branch_feat',
          comment: 'ultimate:branch:2026-08-01T00:00:00.000Z',
          size_bytes: 8192,
        },
        // Named like a branch of `postly`, carrying no marker: nothing here made it, so nothing
        // here may delete it. A `DROP DATABASE` is not recoverable.
        { name: 'postly_branch_feat', comment: null, size_bytes: 16384 },
      ],
    });
    return client;
  };

  test('a marked clone of another database on this server is not a branch of this one', async () => {
    expect(await listExternalBranches(twoApps())).toEqual([]);
  });

  test('a foreign row cannot authorise a drop, and the drop is not attempted', async () => {
    const client = twoApps();
    // `exists()` would answer yes for `postly_branch_feat`: the refusal has to come before it.
    client.on('from pg_database where datname', { rows: [{ ok: 1 }] });

    expect(await dropExternalBranch(client, 'feat')).toBe(false);
    expect(client.texts.filter((text) => text.includes('drop database'))).toEqual([]);
  });

  test('create writes the marker, so the branch it makes is one ls can see', async () => {
    const client = createRecordingClient();
    client.on('current_database', { rows: [{ name: 'postly' }] });

    const created = await createExternalBranch(client, 'feat-x');
    expect(created).toMatchObject({ name: 'feat_x', location: 'postly_branch_feat_x' });

    const texts = client.texts.join('\n');
    expect(texts).toContain('create database "postly_branch_feat_x" template "postly"');
    // The half `psql` never wrote. Without it `listBranches` returns nothing and every branch the
    // CLI made was invisible to the only lister the framework has.
    expect(texts).toContain('comment on database "postly_branch_feat_x"');
  });

  test('drop aims at the clone, never at the database the name was derived from', async () => {
    const client = createRecordingClient();
    client.on('current_database', { rows: [{ name: 'postly' }] });
    client.on('pg_database', {
      rows: [
        { name: 'postly', comment: null, size_bytes: 4096 },
        {
          name: 'postly_branch_feat_x',
          comment: 'ultimate:branch:2026-08-01T00:00:00.000Z',
          size_bytes: 8192,
        },
      ],
    });
    client.on('from pg_database where datname', { rows: [{ ok: 1 }] });

    // `feat-x` and `feat_x` are one clone — the database name substitutes the hyphen — so both
    // spellings must reach it, and neither may reach anything the listing above does not hold.
    expect(await dropExternalBranch(client, 'feat-x')).toBe(true);
    const dropped = client.texts.filter((text) => text.includes('drop database'));
    expect(dropped).toHaveLength(1);
    expect(dropped[0]).toContain('"postly_branch_feat_x"');
    expect(dropped[0]).not.toBe('drop database if exists "postly"');
  });
});
