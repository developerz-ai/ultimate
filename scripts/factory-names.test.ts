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
import type { Declaration } from './factory-names-declarations';
import { FACTORY_NAME_PINS } from './factory-names-pins';
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
    ['createPgliteClient', 'pgliteClient'],
    ['createGateway', 'gateway'],
    ['createToastStore', 'toastStore'],
    ['createDriver', 'driver'],
    ['createDriverFor', 'driverFor'],
    ['createMemorable', 'memorable'],
  ])('%s is retired, and the finding names %s', (name, canonical) => {
    expect(canonicalName(name)).toBe(canonical);
  });

  test.each([
    'memoryJobDriver',
    'postgresAuditLog',
    'smtpMailDriver',
    'pgliteClient',
    'create',
    'created',
    'createdAt',
    'creature',
    'Memorable',
    'Pglite',
    'PGLITE_MEMORY',
    'pgliteExecutor',
    'upgradeSchema',
  ])('%s is not', (name) => {
    // `PgDriverOptions` WOULD read as a class here: a type is excluded by the VALUE scan, not the
    // name — the type rules (`factory-names-types.ts`) read it against the factory that takes it.
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

  test('any create<Thing> value is retired, and the finding asks for a name that builds it', () => {
    expect(flagged("export { createGateway, createdAt, type createPrompt } from './x';")).toEqual([
      'createGateway',
    ]);
    const [finding] = retiredExports(entry("export { createTestClock } from './clock';"));
    expect(finding?.fix).toContain('rename createTestClock to testClock');
    expect(finding?.fix).toContain('const clock = testClock()');
  });

  test('a rule that read nothing says so, rather than reporting a clean tree', () => {
    const findings = checkFactoryNames([entry("export { createMemoryDriver } from './x';")]);
    expect(findings).toHaveLength(1);
    expect(findings[0]?.cause).toContain('was not among the entry modules read');
  });
});

const declared = (
  rows: readonly (readonly [
    string,
    Declaration['kind'],
    (string | undefined)?,
    (readonly string[])?,
  ])[],
): ReadonlyMap<string, Declaration> =>
  new Map(
    rows.map(([name, kind, returns, implemented]) => [
      name,
      { kind, implements: implemented ?? [], ...(returns === undefined ? {} : { returns }) },
    ]),
  );

const pkgEntry = (
  pkg: string,
  text: string,
  declarations: ReadonlyMap<string, Declaration>,
): EntryModule => ({
  at: `packages/${pkg}/src/index.ts`,
  specifier: `@ultimat3/${pkg}`,
  text,
  declarations,
});

const jobs = pkgEntry('jobs', "export { memoryJobDriver } from './x';", declared([]));

describe('a class beside a factory for the same seam', () => {
  const ai = (text: string, rows: Parameters<typeof declared>[0]) =>
    checkFactoryNames([jobs, pkgEntry('ai', text, declared(rows))]);

  test('a class implementing what a sibling factory returns is a finding', () => {
    const findings = ai("export { AnthropicProvider, openAiProvider } from './p';", [
      ['AnthropicProvider', 'class', undefined, ['Provider']],
      ['openAiProvider', 'value', 'Provider'],
    ]);
    expect(findings.map((one) => one.cause.split(' ')[2])).toEqual(['AnthropicProvider']);
    expect(findings[0]?.cause).toContain('openAiProvider() returns Provider');
    expect(findings[0]?.fix).toContain('rename AnthropicProvider to anthropicProvider');
    expect(findings[0]?.fix).toContain('export type { AnthropicProvider }');
  });

  test('a factory returning the class itself is a finding too', () => {
    const findings = ai("export { McpServer, mcpServer } from './s';", [
      ['McpServer', 'class'],
      ['mcpServer', 'value', 'McpServer'],
    ]);
    expect(findings.map((one) => one.cause.split(' ')[2])).toEqual(['McpServer']);
  });

  test('a class whose seam no factory returns is clean, as is the class exported as a type', () => {
    expect(
      ai("export { NatsTransport, selectTransport, type HashEmbedder, hashEmbedder } from './t';", [
        ['NatsTransport', 'class', undefined, ['Transport']],
        ['selectTransport', 'value', 'TransportSelection'],
        ['HashEmbedder', 'class', undefined, ['Embedder']],
        ['hashEmbedder', 'value', 'Embedder'],
      ]),
    ).toEqual([]);
  });

  test('a class exported under an alias is read by the binding it names', () => {
    const findings = ai(
      "export { Impl as AnthropicProvider, open as openAiProvider } from './p';",
      [
        ['Impl', 'class', undefined, ['Provider']],
        ['open', 'value', 'Provider'],
      ],
    );
    expect(findings.map((one) => one.cause.split(' ')[2])).toEqual(['AnthropicProvider']);
  });

  test('an error class is not a seam: instanceof is its API and extends its declaration', () => {
    expect(
      ai("export { UltimateError, toUltimateError } from './e';", [
        ['UltimateError', 'class'],
        ['toUltimateError', 'value', 'UltimateError'],
      ]),
    ).toEqual([]);
  });
});

describe('one value name, one package', () => {
  test('a name two packages each DECLARE is a finding at both, whatever its spelling', () => {
    const findings = checkFactoryNames([
      jobs,
      pkgEntry('ui', "export { formatBytes } from './f';", declared([['formatBytes', 'value']])),
      pkgEntry('core', "export { formatBytes } from './b';", declared([['formatBytes', 'value']])),
    ]);
    expect(findings.map((one) => one.at)).toEqual([
      'packages/core/src/index.ts',
      'packages/ui/src/index.ts',
    ]);
    expect(findings[0]?.cause).toContain('@ultimat3/core and @ultimat3/ui both export formatBytes');
  });

  test('an aliased export is the package’s own declaration under the name apps import', () => {
    const findings = checkFactoryNames([
      jobs,
      pkgEntry('ui', "export { bytes as formatBytes } from './f';", declared([['bytes', 'value']])),
      pkgEntry('core', "export { formatBytes } from './b';", declared([['formatBytes', 'value']])),
    ]);
    expect(findings.map((one) => one.at)).toEqual([
      'packages/core/src/index.ts',
      'packages/ui/src/index.ts',
    ]);
  });

  test('another package’s binding is not this package’s, even where a local shares its name', () => {
    expect(
      checkFactoryNames([
        jobs,
        pkgEntry('core', "export { ANY_HOST } from './hosts';", declared([['ANY_HOST', 'value']])),
        pkgEntry(
          'scraping',
          "export { ANY_HOST } from '@ultimat3/core';",
          declared([['ANY_HOST', 'value']]),
        ),
      ]),
    ).toEqual([]);
  });

  test('a re-export of another package’s binding is not a second meaning — not this rule’s', () => {
    expect(
      checkFactoryNames([
        jobs,
        pkgEntry('core', "export { ANY_HOST } from './hosts';", declared([['ANY_HOST', 'value']])),
        pkgEntry('scraping', "export { ANY_HOST } from './hosts';", declared([])),
      ]),
    ).toEqual([]);
  });
});

describe('what the guard cannot read', () => {
  test('an `export *` is reported unscanned, never read as a clean module', () => {
    const findings = checkFactoryNames([
      jobs,
      pkgEntry('mail', "export * from './drivers';", declared([])),
    ]);
    expect(findings).toHaveLength(1);
    expect(findings[0]?.cause).toContain("export * from './drivers'");
    expect(findings[0]?.fix).toContain("export { … } from './drivers'");
  });
});

describe('a type spelled after a retired factory', () => {
  test('is a finding at the entry that exports it, naming the factory’s spelling', () => {
    const findings = checkFactoryNames([
      pkgEntry(
        'jobs',
        "export { type PgDriverOptions, postgresJobDriver, memoryJobDriver } from './d';",
        new Map<string, Declaration>([
          [
            'postgresJobDriver',
            { kind: 'value', implements: [], returns: 'JobDriver', accepts: 'PgDriverOptions' },
          ],
        ]),
      ),
    ]);
    expect(findings.map((one) => one.cause.split(' ')[2])).toEqual(['PgDriverOptions']);
    expect(findings[0]?.fix).toContain('rename PgDriverOptions to PostgresJobDriverOptions');
    expect(findings[0]?.fix).toContain('export type { PostgresJobDriverOptions }');
  });
});

describe('pins', () => {
  const two = [
    jobs,
    pkgEntry('db', "export { createBranch } from './branch';", declared([])),
  ] as const;

  test('an exception or a debt silences exactly its own finding', () => {
    expect(checkFactoryNames(two)).toHaveLength(1);
    const pins = { exceptions: { '@ultimat3/db createBranch': 'a verb' }, owed: {} };
    expect(checkFactoryNames(two, pins)).toEqual([]);
    expect(
      checkFactoryNames(two, { exceptions: {}, owed: { '@ultimat3/db createBranch': 'db' } }),
    ).toEqual([]);
  });

  test('a pin that matches no finding is itself a finding, so the list only shrinks', () => {
    const findings = checkFactoryNames([jobs], {
      exceptions: {},
      owed: { '@ultimat3/db createBranch': 'db renames it' },
    });
    expect(findings).toHaveLength(1);
    expect(findings[0]?.cause).toContain('@ultimat3/db createBranch');
    expect(findings[0]?.cause).toContain('matches no finding');
  });

  test('a collision is pinned by its names and packages, so a third package re-opens it', () => {
    const shared = (pkgs: readonly string[]) =>
      checkFactoryNames(
        [
          jobs,
          ...pkgs.map((pkg) => pkgEntry(pkg, 'export const t = 1;', declared([['t', 'value']]))),
        ],
        { exceptions: {}, owed: { '@ultimat3/i18n + @ultimat3/schema t': 'i18n renames' } },
      );
    expect(shared(['i18n', 'schema'])).toEqual([]);
    expect(shared(['i18n', 'schema', 'mail']).length).toBeGreaterThan(0);
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
    // Declarations are read per package, not per entry: the class and collision rules need them.
    const ai = entries.find((one) => one.at === 'packages/ai/src/index.ts');
    expect(ai?.declarations?.get('openAiProvider')?.returns).toBe('Provider');
  });

  test('no public entry exports a retired spelling, a class beside its factory or a shared name', async () => {
    const findings = checkFactoryNames(await readEntryModules(repoRoot()), FACTORY_NAME_PINS);
    expect(findings.map((finding) => `${finding.at}: ${finding.cause.split(' ')[2]}`)).toEqual([]);
  });
});
