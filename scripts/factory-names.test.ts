// The enforcement half of `scripts/factory-names.ts`: this file IS the build error. The gate's
// `unit` step runs every `scripts/**/*.test.ts`, so a `createMemoryX` / `createPgX` / `pgX` export
// reds `bun run verify` with no extra wiring. The real tree is asserted NON-VACUOUSLY — a scan that
// read nothing reports "no findings", which is the answer a clean tree gives too.

import { describe, expect, setDefaultTimeout, test } from 'bun:test';
import {
  CODE,
  canonicalName,
  checkFactoryNames,
  type EntryModule,
  readEntryModules,
  retiredExports,
} from './factory-names';
import { REPO_SCAN_TIMEOUT_MS, repoRoot } from './lib/run';

setDefaultTimeout(REPO_SCAN_TIMEOUT_MS);

const entry = (text: string, at = 'packages/a/src/index.ts'): EntryModule => ({
  at,
  specifier: '@ultimat3/a',
  text,
});
const flagged = (text: string): readonly string[] =>
  retiredExports(entry(text)).map((finding) => finding.cause.split(' ')[2] ?? '');

describe('which spellings are retired', () => {
  test.each([
    ['createMemoryDriver', 'memoryDriver'],
    ['createPgInboxStore', 'postgresInboxStore'],
    ['createPostgresClient', 'postgresClient'],
    ['pgSchedulerState', 'postgresSchedulerState'],
    ['createPg2Thing', 'postgres2Thing'],
    ['MemoryIdempotencyStore', 'memoryIdempotencyStore'],
    ['InMemoryChangeFeed', 'memoryChangeFeed'],
    ['PgVectorStore', 'postgresVectorStore'],
    ['PostgresThing', 'postgresThing'],
    ['createSmtpDriver', 'smtpDriver'],
    ['createRedisDriver', 'redisDriver'],
  ])('%s is retired, and the finding names %s', (name, canonical) => {
    expect(canonicalName(name)).toBe(canonical);
  });

  test.each([
    'memoryJobDriver',
    'postgresAuditLog',
    'smtpMailDriver',
    'createPgliteClient',
    'createDriver',
    'createDriverFor',
    'createToastStore',
    'Memorable',
    'Pglite',
    'PGLITE_MEMORY',
    'pgliteExecutor',
    'createMemorable',
    'upgradeSchema',
  ])('%s is not', (name) => {
    // `PgDriverOptions` WOULD read as a class here: a type is excluded by the scan, not the name.
    expect(canonicalName(name)).toBeUndefined();
  });
});

describe('what an entry module exports', () => {
  test('a re-export, an alias and a local declaration are all exports', () => {
    expect(
      flagged(
        [
          "export { createMemoryDriver } from './driver-memory';",
          "export { postgresJobDriver as createPgDriver } from './driver-pg';",
          'export const pgSchedulerState = () => 1;',
          'export function createMemoryStepStore() {}',
        ].join('\n'),
      ),
    ).toEqual([
      'createMemoryDriver',
      'createMemoryStepStore',
      'createPgDriver',
      'pgSchedulerState',
    ]);
  });

  test('a class and a PascalCase value are exports too — the class is the retired spelling', () => {
    expect(
      flagged(
        [
          'export class MemoryVectorStore {}',
          "export { PgAdvisoryLock, InMemoryChangeFeed } from './lock';",
          'export const PostgresFeed = 1;',
          "export { createSesDriver } from './driver-ses';",
        ].join('\n'),
      ),
    ).toEqual([
      'InMemoryChangeFeed',
      'MemoryVectorStore',
      'PgAdvisoryLock',
      'PostgresFeed',
      'createSesDriver',
    ]);
  });

  test('a class exported as a type only is clean: the type stays nameable, the factory builds it', () => {
    expect(
      flagged(
        [
          "export type { MemoryVectorStore, PgVectorStoreOptions } from './vector';",
          "export { type PgAdvisoryLock, memoryVectorStore } from './vector';",
          'export interface PostgresThing {}',
        ].join('\n'),
      ),
    ).toEqual([]);
  });

  test('a class finding asks for the factory, a create*Driver finding for the named driver', () => {
    const [cls] = retiredExports(entry("export { MemoryAdapter } from './memory-adapter';"));
    expect(cls?.fix).toContain('rename MemoryAdapter to memoryAdapter');
    expect(cls?.fix).toContain('export type { MemoryAdapter }');
    const [driver] = retiredExports(entry("export { createSmtpDriver } from './driver-smtp';"));
    expect(driver?.fix).toContain('rename createSmtpDriver to smtpDriver');
    expect(driver?.fix).toContain('smtpMailDriver');
  });

  test('a type is not a factory, and an alias AWAY from a retired name is clean', () => {
    expect(
      flagged(
        [
          "export type { PgDriverOptions, createMemoryShape } from './driver-pg';",
          "export { type createPgThing, memoryJobDriver } from './driver-memory';",
          "export { createMemoryDriver as memoryJobDriver2 } from './driver-memory';",
        ].join('\n'),
      ),
    ).toEqual([]);
  });

  test('the finding names the module, the canonical spelling and the collision rule', () => {
    const [finding] = retiredExports(entry("export { createPgEventBus } from './events-pg';"));
    expect(finding?.code).toBe(CODE);
    expect(finding?.at).toBe('packages/a/src/index.ts');
    expect(finding?.fix).toContain('rename createPgEventBus to postgresEventBus');
    expect(finding?.fix).toContain('git grep -nw createPgEventBus');
  });

  test('one memory / Postgres factory name exported by two packages is a finding at each', () => {
    const at = (pkg: string, text: string): EntryModule => ({
      at: `packages/${pkg}/src/index.ts`,
      specifier: `@ultimat3/${pkg}`,
      text,
    });
    const findings = checkFactoryNames([
      at('jobs', "export { memoryJobDriver } from './x';"),
      at('entity', "export { memoryDriver, postgresDriver } from './x';"),
      at('storage', "export { memoryDriver } from './x';"),
      { ...at('storage', "export { memoryDriver } from './y';"), specifier: '@ultimat3/storage/x' },
    ]);
    expect(findings.map((one) => one.at)).toEqual([
      'packages/entity/src/index.ts',
      'packages/storage/src/index.ts',
    ]);
    expect(findings[0]?.cause).toContain(
      '@ultimat3/entity and @ultimat3/storage both export memoryDriver',
    );
    expect(findings[0]?.fix).toContain('git grep -nw memoryDriver');
  });

  test('a rule that read nothing says so, rather than reporting a clean tree', () => {
    const findings = checkFactoryNames([entry("export { createMemoryDriver } from './x';")]);
    expect(findings).toHaveLength(1);
    expect(findings[0]?.cause).toContain('was not among the entry modules read');
  });
});

describe('the real tree', () => {
  test('every package entry is read — the barrels and the subpaths', async () => {
    const entries = await readEntryModules(repoRoot());
    const read = entries.map((one) => one.at);
    expect(read).toContain('packages/jobs/src/index.ts');
    expect(read).toContain('packages/notify/src/index.ts');
    expect(read).toContain('packages/admin/src/audit-schema.ts');
    expect(entries.find((one) => one.at === 'packages/admin/src/audit-schema.ts')?.specifier).toBe(
      '@ultimat3/admin/schema',
    );
  });

  test('no public entry exports a retired spelling: create(Memory|Pg|Postgres)X, pgX, a Memory/Pg class, create*Driver', async () => {
    const findings = checkFactoryNames(await readEntryModules(repoRoot()));
    expect(findings.map((finding) => `${finding.at}: ${finding.cause.split(' ')[2]}`)).toEqual([]);
  });
});
