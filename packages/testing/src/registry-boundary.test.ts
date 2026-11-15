// What the registry guard RESTORES at a file boundary, across files in one process: a file's
// body ends with it, its policy environment is its own import graph, and the noted driver stores,
// mounted admins and jobs go back. Each fixture pair is identical but for a name, so either order.

import { describe, expect, test } from 'bun:test';
// why: Bun exposes no path-join primitive.
import { join } from 'node:path';
import { runFixtures } from './registry-guard-run-fixture';

const SRC = import.meta.dir;
const POLICY = join(SRC, '..', '..', 'policy', 'src', 'index.ts');

/**
 * A test file's OWN module body is not anyone else's environment. Its imports are — a module
 * evaluates once per process, so what one declared stays for every later file — but the body of a
 * `.test.ts` is never imported by another file, so nothing it declared can be a later file's cache
 * hit. Before the baseline moved to the body's START, the body was folded into what every later
 * file inherited: one file's `definePermissions()` switched strict checking on for the worker and
 * one file's `defineRoles({ member })` was `X_ROLE_REDEFINED` in the next file that defined its own.
 *
 * Identical apart from the name, so the verdict cannot depend on which file bun runs first.
 */
const bodyDeclarer = (name: string): string => `import { expect, test } from 'bun:test';
import { defineRoles, definePermissions, knownPermissions, roleDefinitions } from '${POLICY}';

definePermissions(['body:${name}']);
defineRoles({ member: { grants: ['body:${name}'] } });

test('${name} sees its own body declarations and no other file’s', () => {
  expect(knownPermissions()).toEqual(['body:${name}']);
  expect(roleDefinitions()['member']?.grants).toEqual(['body:${name}']);
});
`;

describe('a test file’s body, in one process', () => {
  test('what one file’s body declared is gone before the next file evaluates', async () => {
    const { output, exitCode } = await runFixtures({
      'one.test.ts': bodyDeclarer('one'),
      'two.test.ts': bodyDeclarer('two'),
    });

    expect(output).toContain('2 pass');
    expect(output).not.toContain('X_ROLE_REDEFINED');
    expect(exitCode).toBe(0);
  }, 30_000);
});

/**
 * A test file's ENVIRONMENT is its own import graph, never the worker's history. A module declares
 * once per process, so the guard keeps what a module in THIS file's graph declared — the second
 * file to import `./declare-a` is a cache hit and still sees `env:a` — and drops what a module only
 * an EARLIER file imported declared. Before, the union of every earlier file's imports was every
 * later file's set: a file that declared nothing found a 12-name set and its `can('cases:create')`
 * was X_PERMISSION_UNKNOWN, or a role an unrelated app module defined was its X_ROLE_REDEFINED.
 */
const envDeclare = (
  name: string,
): string => `import { defineRoles, definePermissions } from '${POLICY}';

export const permissions = definePermissions(['env:${name}']);
defineRoles({ env${name}: { grants: ['env:${name}'] } });
`;

const envReader = (
  imports: string,
  expected: readonly string[],
): string => `import { expect, test } from 'bun:test';
import { knownPermissions, roleDefinitions } from '${POLICY}';
${imports}

test('sees exactly its own graph’s declarations', () => {
  expect(knownPermissions()).toEqual(${JSON.stringify(expected)});
  expect(Object.keys(roleDefinitions()).sort()).toEqual(${JSON.stringify(expected.map((p) => `env${p.slice(4)}`))});
});
`;

describe('a test file’s environment, in one process', () => {
  test('is what its own imports declared, a cache hit included, and nothing else', async () => {
    const { output, exitCode } = await runFixtures({
      'declare-a.ts': envDeclare('a'),
      'declare-b.ts': envDeclare('b'),
      'a1.test.ts': envReader("import './declare-a';", ['env:a']),
      'a2.test.ts': envReader("import './declare-a';", ['env:a']),
      'b.test.ts': envReader("import './declare-b';", ['env:b']),
      'ab.test.ts': envReader("import './declare-a';\nimport './declare-b';", ['env:a', 'env:b']),
      'none.test.ts': envReader('', []),
    });

    expect(output).toContain('5 pass');
    expect(output).not.toContain('(fail)');
    expect(exitCode).toBe(0);
  }, 30_000);
});

const ENTITY_ADAPTER = join(SRC, '..', '..', 'entity', 'src', 'adapter.ts');

/**
 * `x verify`'s drift step skips its schema rails for an app whose only noted driver is a custom
 * one, and the record is process-wide: one file's `defineDriver()` made every later file's fixture
 * app read as non-SQL. Identical but for the name, so either order proves it.
 */
const storeNoter = (name: string): string => `import { expect, test } from 'bun:test';
import { driverStores, noteDriverStore } from '${ENTITY_ADAPTER}';

test('${name} sees only the store it noted', () => {
  noteDriverStore('custom', '${name}');
  expect(driverStores().custom).toEqual(['${name}']);
});
`;

/** A fixture that builds its store as it is imported, the shape a conformance module has. */
const NOTES_AT_IMPORT = `import { noteDriverStore } from '${ENTITY_ADAPTER}';
noteDriverStore('custom', 'fixture-store');
`;

describe('the noted driver stores, in one process', () => {
  test('a store an earlier file IMPORTED is not the next file’s either', async () => {
    const { output, exitCode } = await runFixtures({
      'store.ts': NOTES_AT_IMPORT,
      'a-imports.test.ts': `import { test } from 'bun:test';\nimport './store';\ntest('imports', () => {});\n`,
      'b-reads.test.ts': `import { expect, test } from 'bun:test';
import { driverStores } from '${ENTITY_ADAPTER}';
test('reads', () => expect(driverStores().custom).toEqual([]));
`,
    });

    expect(output).toContain('2 pass');
    expect(exitCode).toBe(0);
  }, 30_000);

  test('a store one file built is not a store the next file built', async () => {
    const { output, exitCode } = await runFixtures({
      'one.test.ts': storeNoter('one'),
      'two.test.ts': storeNoter('two'),
    });

    expect(output).toContain('2 pass');
    expect(exitCode).toBe(0);
  }, 30_000);
});

const ADMIN_MOUNTS_MODULE = join(SRC, '..', '..', 'admin', 'src', 'mounts.ts');

/**
 * Through `@ultimat3/admin`'s own `mounts.ts`, so the symbol this package restates is held to the
 * one admin keeps its mounts on: a drifted string would leave the second file seeing the first's.
 */
const mounter = (name: string): string => `import { expect, test } from 'bun:test';
import { adminMounts, registerAdminMount } from '${ADMIN_MOUNTS_MODULE}';

test('${name} sees only the admin it mounted', () => {
  registerAdminMount({ basePath: '/${name}' } as never);
  expect(adminMounts().map((app) => app.basePath)).toEqual(['/${name}']);
});
`;

describe('the mounted admins, in one process', () => {
  test('an admin one file mounted is not mounted in the next', async () => {
    const { output, exitCode } = await runFixtures({
      'one.test.ts': mounter('one'),
      'two.test.ts': mounter('two'),
    });

    expect(output).toContain('2 pass');
    expect(exitCode).toBe(0);
  }, 30_000);
});

const JOBS = join(SRC, '..', '..', 'jobs', 'src', 'index.ts');

/** A job declared at import, once per process — `sendMailJob`'s shape. */
const SCHEMA = join(SRC, '..', '..', 'schema', 'src', 'index.ts');
const DECLARE_JOB = `import { job } from '${JOBS}';
import { t } from '${SCHEMA}';
export const probeJob = job({
  tenant: 'none',
  name: 'probeJob',
  input: t.object({}),
  retry: { attempts: 1, backoff: 'linear' },
  idempotencyKey: () => 'k',
  run: async () => {},
});
`;

/** Identical, so the second to run is the victim either way: each clears what it inherited. */
const jobClearer = (name: string): string => `import { afterAll, expect, test } from 'bun:test';
import { registeredJobs, resetJobs } from '${JOBS}';
import './declare-job';

test('${name} sees the job its import declared', () => {
  expect(registeredJobs().map((handle) => handle.name)).toContain('probeJob');
});

afterAll(() => resetJobs());
`;

describe('the job registry, in one process', () => {
  test('a file that clears the jobs does not take an imported one from the next file', async () => {
    const { output, exitCode } = await runFixtures({
      'declare-job.ts': DECLARE_JOB,
      'first.test.ts': jobClearer('first'),
      'second.test.ts': jobClearer('second'),
    });

    expect(output).toContain('2 pass');
    expect(exitCode).toBe(0);
  }, 30_000);
});

const I18N = join(SRC, '..', '..', 'i18n', 'src', 'index.ts');

describe('the locale config, in one process', () => {
  test('a narrowing an earlier file IMPORTED is not the next file’s config', async () => {
    const { output, exitCode } = await runFixtures({
      'narrow.ts': `import { configureLocales } from '${I18N}';
configureLocales({ supported: ['en'], fallback: 'en' });
`,
      'a-imports.test.ts': `import { expect, test } from 'bun:test';
import { resolveLocale } from '${I18N}';
import './narrow';
test('narrowed', () => expect(resolveLocale({ header: 'de-DE' }).locale).toBe('en'));
`,
      'b-reads.test.ts': `import { expect, test } from 'bun:test';
import { resolveLocale } from '${I18N}';
test('shipped set', () => expect(resolveLocale({ header: 'de-DE' }).locale).toBe('de'));
`,
    });

    expect(output).toContain('2 pass');
    expect(exitCode).toBe(0);
  }, 30_000);
});
