// `x actions`, `x queries`, `x entities` against real registrations — the point of this file is
// that the three commands read the framework's own registries, so a fixture that only pretended
// to be a declaration would prove nothing. Registries are process-global: every test resets them.

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import {
  action,
  describeActions,
  getAction,
  registerAction,
  resetRegistry as resetActions,
} from '@ultimat3/action';
import {
  clearRegistry as clearEntities,
  describeEntities,
  entity,
  getEntity,
  text,
  uuid,
} from '@ultimat3/entity';
import { allow } from '@ultimat3/policy';
import {
  describeQueries,
  from,
  getQuery,
  query,
  registerQuery,
  resetRegistry as resetQueries,
} from '@ultimat3/query';
import { t } from '@ultimat3/schema';
import { actionsCommand, entitiesCommand, queriesCommand } from './cmd-registries';
import type { CommandContext } from './command';
import { msg } from './messages';
import type { FlagValue } from './parse';
import { parseArgs } from './parse';
import type { ThrownShape } from './thrown-by';

const ROOT = join(import.meta.dir, '..', '.registries-fixture');
const BROKEN = join(import.meta.dir, '..', '.registries-broken-fixture');
const APP_CONFIG = `export const config = { name: 'fixture' };\n`;

const ACTION_NAME = 'publishPost';
const QUERY_NAME = 'recentPosts';
const ENTITY_NAME = 'registries_test_posts';

/** One of each primitive, registered fresh before every test — see the file header. */
function registerFixtures(): void {
  registerAction(
    ACTION_NAME,
    action({
      input: t.object({ id: t.uuid }),
      output: t.object({ id: t.uuid }),
      policy: allow('post:publish'),
      mcp: { expose: true, description: 'publish a post' },
      async handle({ input }) {
        return { id: input.id };
      },
    }),
  );
  registerQuery(
    QUERY_NAME,
    query({
      input: t.object({ limit: t.number.default(10) }),
      policy: allow('post:read'),
      live: true,
      sql: ({ limit }) =>
        from<{ id: string }>('posts', () => [])
          .orderBy('id')
          .limit(limit),
    }),
  );
  entity(ENTITY_NAME, {
    columns: { id: uuid().primaryKey(), title: text({ max: 80 }) },
  });
}

const contextFor = (
  subcommand: string | undefined,
  positionals: readonly string[] = [],
  cwd: string = ROOT,
): CommandContext => ({
  args: {
    command: 'actions',
    subcommand,
    positionals,
    flags: new Map<string, FlagValue>(),
    json: false,
    help: false,
    passthrough: [],
  },
  cwd,
  runner: async () => ({
    command: ['true'],
    code: 0,
    ok: true,
    stdout: '',
    stderr: '',
    durationMs: 0,
  }),
  env: {},
  bunVersion: '1.3.0',
});

/** The thrown value, so a test can assert on `code`/`fix` — `run()` rejects, it never returns
 * an `ok: false` result for a bad flag or an unknown declaration. */
async function rejectedBy(call: () => Promise<unknown>): Promise<ThrownShape> {
  try {
    await call();
  } catch (error) {
    return error as ThrownShape;
  }
  return expect.unreachable('expected a rejection');
}

beforeAll(async () => {
  await Bun.write(join(ROOT, 'app.config.ts'), APP_CONFIG);
  await Bun.write(join(BROKEN, 'app.config.ts'), APP_CONFIG);
  await Bun.write(
    join(BROKEN, 'apps/web/app/broken.ts'),
    `export { nope } from './does-not-exist';\n`,
  );
});

afterAll(async () => {
  await rm(ROOT, { recursive: true, force: true });
  await rm(BROKEN, { recursive: true, force: true });
});

beforeEach(() => {
  registerFixtures();
});

afterEach(() => {
  resetActions();
  resetQueries();
  clearEntities();
});

describe('unit · x actions|queries|entities · list', () => {
  test('actions: a row per declaration, and the full descriptor array under data', async () => {
    const result = await actionsCommand.run(contextFor('list'));
    expect(result.ok).toBe(true);
    expect(result.summary).toBe(msg('cli.registry.count', { count: 1, kind: 'actions' }));
    expect(result.lines?.[0]).toContain('name');
    expect(result.lines?.some((line) => line.includes(ACTION_NAME))).toBe(true);
    expect(result.data).toEqual(describeActions());
  });

  test('queries: a row per declaration, and the full descriptor array under data', async () => {
    const result = await queriesCommand.run(contextFor('list'));
    expect(result.ok).toBe(true);
    expect(result.summary).toBe(msg('cli.registry.count', { count: 1, kind: 'queries' }));
    expect(result.lines?.some((line) => line.includes(QUERY_NAME))).toBe(true);
    expect(result.data).toEqual(describeQueries());
  });

  test('entities: a row per declaration, and the full descriptor array under data', async () => {
    const result = await entitiesCommand.run(contextFor('list'));
    expect(result.ok).toBe(true);
    expect(result.summary).toBe(msg('cli.registry.count', { count: 1, kind: 'entities' }));
    expect(result.lines?.some((line) => line.includes(ENTITY_NAME))).toBe(true);
    expect(result.data).toEqual(describeEntities());
  });

  test('the default subcommand is list — for the parser, and for run() given no subcommand', async () => {
    const parsed = parseArgs(['actions'], [actionsCommand.spec]);
    expect(parsed.subcommand).toBe('list');

    const viaParser = await actionsCommand.run(contextFor(parsed.subcommand, parsed.positionals));
    expect(viaParser.summary).toBe(msg('cli.registry.count', { count: 1, kind: 'actions' }));

    const viaUndefined = await actionsCommand.run(contextFor(undefined));
    expect(viaUndefined.summary).toBe(viaParser.summary);
  });
});

describe('unit · x actions|queries|entities · describe', () => {
  test('an action describes as its full ActionDescriptor', async () => {
    const result = await actionsCommand.run(contextFor('describe', [ACTION_NAME]));
    expect(result.ok).toBe(true);
    expect(result.summary).toBe(
      msg('cli.registry.described', { kind: 'action', name: ACTION_NAME }),
    );
    expect(result.data).toEqual(getAction(ACTION_NAME)?.describe());
  });

  test('a query describes as its full QueryDescriptor plus the input JSON schema', async () => {
    const result = await queriesCommand.run(contextFor('describe', [QUERY_NAME]));
    expect(result.ok).toBe(true);
    expect(result.summary).toBe(msg('cli.registry.described', { kind: 'query', name: QUERY_NAME }));
    expect(result.data).toEqual({
      ...getQuery(QUERY_NAME)?.describe(),
      input: (result.data as { input: unknown }).input,
    });
    expect((result.data as { input?: object }).input).toBeTruthy();
  });

  test('an entity describes as its full EntityDescription', async () => {
    const result = await entitiesCommand.run(contextFor('describe', [ENTITY_NAME]));
    expect(result.ok).toBe(true);
    expect(result.summary).toBe(
      msg('cli.registry.described', { kind: 'entity', name: ENTITY_NAME }),
    );
    expect(result.data).toEqual(getEntity(ENTITY_NAME)?.describe());
  });
});

describe('unit · x actions|queries|entities · errors', () => {
  // `MissingPositionalError` raises the same CODE a `BadFlagError` does, so the cause is the only
  // thing that can tell them apart — and the cause is the half that used to name `--name`, a flag
  // no registry command declares, about a missing positional.
  test('describe with no name names the positional and never a flag', async () => {
    const actionsThrown = await rejectedBy(() => actionsCommand.run(contextFor('describe', [])));
    expect(actionsThrown).toBeUltimateError('X_CLI_BAD_FLAG');
    expect(actionsThrown.cause).toBe('"x actions describe" needs a <name> positional and got none');
    expect(actionsThrown.fix).toBe('x actions list --json');

    const queriesThrown = await rejectedBy(() => queriesCommand.run(contextFor('describe', [])));
    expect(queriesThrown).toBeUltimateError('X_CLI_BAD_FLAG');
    expect(queriesThrown.cause).toBe('"x queries describe" needs a <name> positional and got none');
    expect(queriesThrown.fix).toBe('x queries list --json');

    const entitiesThrown = await rejectedBy(() => entitiesCommand.run(contextFor('describe', [])));
    expect(entitiesThrown).toBeUltimateError('X_CLI_BAD_FLAG');
    expect(entitiesThrown.cause).toBe(
      '"x entities describe" needs a <name> positional and got none',
    );
    expect(entitiesThrown.fix).toBe('x entities list --json');
  });

  test('describe <typo> is an unknown-declaration error, and the fix names the nearest real name', async () => {
    const thrown = await rejectedBy(() =>
      actionsCommand.run(contextFor('describe', ['publishPst'])),
    );
    expect(thrown).toBeUltimateError('X_DECLARATION_UNKNOWN');
    expect(thrown.cause).toContain('publishPst');
    expect(thrown.fix).toBe(`x actions describe ${ACTION_NAME}`);
  });

  test('describe <unrelated> falls back to list --json when nothing is close enough to suggest', async () => {
    const thrown = await rejectedBy(() =>
      actionsCommand.run(contextFor('describe', ['completely-unrelated-name'])),
    );
    expect(thrown).toBeUltimateError('X_DECLARATION_UNKNOWN');
    expect(thrown.fix).toBe('x actions list --json');
  });
});

describe('unit · x actions|queries|entities · findings', () => {
  test('a module that will not import is a finding, and ok is false — for every kind alike', async () => {
    const result = await actionsCommand.run(contextFor('list', [], BROKEN));
    expect(result.ok).toBe(false);
    expect(result.findings?.length).toBeGreaterThan(0);
    expect(result.findings?.[0]?.at).toBe('apps/web/app/broken.ts');
  });
});
