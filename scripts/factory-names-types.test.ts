// The four type-spelling rules of `factory-names-types.ts`, each against the 25.0.0 defect it was
// written for: an input, a built type or a factory that kept the spelling its factory retired.

import { describe, expect, test } from 'bun:test';
import type { Declaration } from './factory-names-declarations';
import { exportsIn, ownLocal } from './factory-names-exports';
import { typeMisspellings } from './factory-names-types';

type Row = readonly [string, Declaration['kind'], { returns?: string; accepts?: string }?];

const misspelt = (text: string, rows: readonly Row[]) => {
  const read = exportsIn(text);
  const own = read.names.map((exported) => ({
    exported,
    local: ownLocal(exported, read.imported),
  }));
  const declarations = new Map<string, Declaration>(
    rows.map(([name, kind, sig]) => [name, { kind, implements: [], ...sig }]),
  );
  return typeMisspellings(own, declarations).map((one) => `${one.name} → ${one.canonical}`);
};

describe('a type a factory takes', () => {
  test('a Pg/Memory input is spelled after its memoryX / postgresX factory', () => {
    expect(
      misspelt(
        "export { type PgDriverOptions, type MemoryDriverOptions, postgresJobDriver, memoryJobDriver } from './d';",
        [
          ['postgresJobDriver', 'value', { accepts: 'PgDriverOptions' }],
          ['memoryJobDriver', 'value', { accepts: 'MemoryDriverOptions' }],
        ],
      ),
    ).toEqual([
      'PgDriverOptions → PostgresJobDriverOptions',
      'MemoryDriverOptions → MemoryJobDriverOptions',
    ]);
  });

  test('an input already spelled after its factory, or shared by two, is clean', () => {
    expect(
      misspelt(
        "export { type MemoryEventBusOptions, type EventBusOptions, memoryEventBus, postgresEventBus } from './e';",
        [
          ['memoryEventBus', 'value', { accepts: 'MemoryEventBusOptions' }],
          ['postgresEventBus', 'value', { accepts: 'EventBusOptions' }],
        ],
      ),
    ).toEqual([]);
  });

  test('an aliased type export is looked up by the binding it names', () => {
    expect(
      misspelt("export { type Opts as PgOutboxOptions, postgresOutboxStore } from './o';", [
        ['postgresOutboxStore', 'value', { accepts: 'Opts' }],
      ]),
    ).toEqual(['PgOutboxOptions → PostgresOutboxStoreOptions']);
  });
});

describe('a type a factory builds', () => {
  test('a class or a Pg/Memory type a memoryX / postgresX factory returns IS its name', () => {
    expect(
      misspelt(
        "export { type BuiltinAdapter, type PgInboxStore, type InboxStore, postgresAuthAdapter, postgresInboxStore, memoryInboxStore } from './a';",
        [
          ['BuiltinAdapter', 'class'],
          ['postgresAuthAdapter', 'value', { returns: 'BuiltinAdapter' }],
          ['postgresInboxStore', 'value', { returns: 'PgInboxStore' }],
          ['memoryInboxStore', 'value', { returns: 'InboxStore' }],
        ],
      ),
    ).toEqual(['BuiltinAdapter → PostgresAuthAdapter', 'PgInboxStore → PostgresInboxStore']);
  });

  test('a Memory type built by a value not spelled memoryX names the VALUE', () => {
    expect(
      misspelt("export { type MemoryAuthLimiter, authLimiter } from './l';", [
        ['authLimiter', 'value', { returns: 'MemoryAuthLimiter' }],
      ]),
    ).toEqual(['authLimiter → memoryAuthLimiter']);
  });

  test('a Pg protocol type built by a plain function is not a factory’s: PgStream stays', () => {
    expect(
      misspelt("export { type PgStream, type PgExecutor, bunPgStream } from './s';", [
        ['bunPgStream', 'value', { returns: 'PgStream', accepts: 'PgExecutor' }],
      ]),
    ).toEqual([]);
  });

  test('another package’s type re-exported here is that package’s to spell', () => {
    expect(
      misspelt("export { type PgDriverOptions, postgresJobDriver } from '@ultimat3/jobs';", [
        ['postgresJobDriver', 'value', { accepts: 'PgDriverOptions' }],
      ]),
    ).toEqual([]);
  });
});

describe('Create<Thing>', () => {
  test('a Create input is spelled after the factory that takes it', () => {
    expect(
      misspelt(
        "export { type CreateMcpServerInput, type CreateDevServerInput, mcpServer, devMcpServer } from './m';",
        [
          ['mcpServer', 'value', { accepts: 'CreateMcpServerInput' }],
          ['devMcpServer', 'value', { accepts: 'CreateDevServerInput' }],
        ],
      ),
    ).toEqual([
      'CreateMcpServerInput → McpServerInput',
      'CreateDevServerInput → DevMcpServerInput',
    ]);
  });

  test('a create<Verb>’s own input is clean; an orphan Create type is not', () => {
    expect(
      misspelt(
        "export { type CreateSessionInput, type CreateUserInput, createSession } from './s';",
        [['createSession', 'value']],
      ),
    ).toEqual(['CreateUserInput → UserInput']);
  });
});
