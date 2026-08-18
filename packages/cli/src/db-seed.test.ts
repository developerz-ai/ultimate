// `x db seed`'s three answers: which seeds an app declares, which of them this environment runs,
// and what one pass reports. The refusals run before any connection is opened, so every case here
// is a real command invocation against a temp app root with no database anywhere near it.

import { describe, expect, test } from 'bun:test';
// `node:fs`/`node:os` — Bun has no temp-directory API; `node:path` — no Bun path joiner.
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Seed, SeedRun } from '@ultimat3/entity';
import { dbCommand } from './cmd-db';
import type { CommandContext } from './command';
import type { DiscoveredSeed, SeedPassRow } from './db-seed';
import {
  discoverSeeds,
  parseSeedTierFlag,
  runSeeds,
  seedPassToJson,
  seedTotals,
  selectSeeds,
} from './db-seed';
import { CLI_ERROR_TITLES, docsFor } from './error-codes';
import { fixProblem } from './error-contract';
import { exec } from './exec';
import { explainErrorCode } from './mcp-errors';
import { findingFrom } from './output';
import { parseArgs } from './parse';
import { SPECS } from './registry';

const ctxFor = (
  argv: readonly string[],
  cwd: string,
  env: Readonly<Record<string, string>> = {},
): CommandContext => ({
  args: parseArgs(argv, SPECS),
  cwd,
  runner: exec,
  env,
  bunVersion: '1.3.0',
});

/** The package under test, by path: a temp directory outside the repo resolves no workspace. */
const ENTITY = join(import.meta.dir, '..', '..', 'entity', 'src', 'index.ts');

const seedModule = (name: string, tier: string): string =>
  [
    `import { defineSeed } from ${JSON.stringify(ENTITY)};`,
    `export const ${name} = defineSeed('${name}', async () => {}, { tier: '${tier}' });`,
    '',
  ].join('\n');

/**
 * An app root `requireAppRoot` accepts, with a `packages/db/seeds` directory in it. `Bun.write` is
 * a promise: unawaited, the command races the file it is meant to find.
 */
async function appRoot(seeds: Readonly<Record<string, string>> = {}): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), 'x-db-seed-'));
  await Bun.write(join(dir, 'app.config.ts'), 'export const config = {};\n');
  mkdirSync(join(dir, 'packages', 'db', 'seeds'), { recursive: true });
  for (const [file, contents] of Object.entries(seeds)) {
    await Bun.write(join(dir, file), contents);
  }
  return dir;
}

const withRoot = async (
  seeds: Readonly<Record<string, string>>,
  work: (root: string) => Promise<void>,
): Promise<void> => {
  const root = await appRoot(seeds);
  try {
    await work(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
};

const failure = (result: Promise<unknown>): Promise<unknown> =>
  result.then(
    () => undefined,
    (error: unknown) => error,
  );

const fakeSeed = (name: string, tier: 'reference' | 'dev', run?: () => Promise<SeedRun>): Seed => ({
  name,
  tier,
  run:
    run ??
    (async () => ({ name, tier, metrics: { inserted: 1, updated: 0, skipped: 0 } }) as SeedRun),
});

const found = (name: string, tier: 'reference' | 'dev', file: string): DiscoveredSeed => ({
  seed: fakeSeed(name, tier),
  file,
});

describe('unit · x db seed · discovery', () => {
  test('a seed under packages/*/seeds is found, and a test file beside it is not', async () => {
    await withRoot(
      {
        'packages/db/seeds/dev.ts': seedModule('dev', 'dev'),
        'packages/db/seeds/dev.test.ts': "export const notASeed = { name: 'dev' };\n",
      },
      async (root) => {
        const discovery = await discoverSeeds(root);
        expect(discovery.findings).toEqual([]);
        expect(discovery.seeds.map((entry) => entry.seed.name)).toEqual(['dev']);
        expect(discovery.seeds[0]?.file).toBe('packages/db/seeds/dev.ts');
        expect(discovery.seeds[0]?.seed.tier).toBe('dev');
      },
    );
  });

  test('a seed beside its entities (packages/*/src) is found too, and the order is by file', async () => {
    await withRoot(
      {
        'packages/db/src/seed.ts': seedModule('demo', 'reference'),
        'packages/db/seeds/dev.ts': seedModule('dev', 'dev'),
      },
      async (root) => {
        const discovery = await discoverSeeds(root);
        expect(discovery.seeds.map((entry) => entry.file)).toEqual([
          'packages/db/seeds/dev.ts',
          'packages/db/src/seed.ts',
        ]);
      },
    );
  });

  test('a module that will not import is a finding, never a silent absence', async () => {
    await withRoot(
      { 'packages/db/seeds/broken.ts': "import { nope } from './nowhere';\nexport { nope };\n" },
      async (root) => {
        const discovery = await discoverSeeds(root);
        expect(discovery.seeds).toEqual([]);
        expect(discovery.findings).toHaveLength(1);
        expect(discovery.findings[0]?.at).toBe('packages/db/seeds/broken.ts');
      },
    );
  });
});

describe('unit · x db seed · which seeds this environment runs', () => {
  const catalog = [found('demo', 'reference', 'packages/db/src/seed.ts'), found('dev', 'dev', 'a')];

  test('no name runs every tier the environment takes — production leaves dev out', () => {
    expect(
      selectSeeds({ discovered: catalog, environment: 'staging' }).map((one) => one.seed.name),
    ).toEqual(['demo', 'dev']);
    expect(
      selectSeeds({ discovered: catalog, environment: 'production' }).map((one) => one.seed.name),
    ).toEqual(['demo']);
  });

  test('a dev seed in production is refused, and the refusal names both ways to consent', () => {
    const error = (() => {
      try {
        selectSeeds({ discovered: catalog, name: 'dev', environment: 'production' });
      } catch (thrown: unknown) {
        return thrown;
      }
      return undefined;
    })();
    // NOT `X_CLI_BAD_FLAG`: nothing about the invocation is malformed. Refusing to seed
    // production is a safety refusal with its own remedy, and `x errors explain` has to be able
    // to answer it without the reader first deciding which of a bad flag's many causes this was.
    expect(error).toBeUltimateError('X_SEED_ENVIRONMENT');
    expect((error as { cause: string }).cause).toContain('ULTIMATE_SEED_TIER=dev');
    expect((error as { fix: string }).fix).toBe('x db seed dev --tier dev --json');
  });

  test('the refusal is explainable on its own: registered, titled, with a runnable fix', () => {
    const explained = explainErrorCode('X_SEED_ENVIRONMENT');
    expect(explained?.cause).toBe(CLI_ERROR_TITLES.X_SEED_ENVIRONMENT);
    expect(explained?.fix).toContain('x db seed');
    expect(explained?.fix).toContain('--tier dev');
    expect(explained?.fix).toContain('--json');
    expect(fixProblem(explained?.fix ?? '')).toBeUndefined();
    expect(explained?.docs).toBe(docsFor('X_SEED_ENVIRONMENT'));
  });

  test('naming the tier is the consent: --tier dev runs it in production', () => {
    expect(
      selectSeeds({
        discovered: catalog,
        name: 'dev',
        environment: 'production',
        requested: 'dev',
      }).map((one) => one.seed.name),
    ).toEqual(['dev']);
  });

  test('an unknown tier is refused before anything is discovered', () => {
    expect(parseSeedTierFlag(undefined)).toBeUndefined();
    expect(parseSeedTierFlag('reference')).toBe('reference');
    let error: unknown;
    try {
      parseSeedTierFlag('nightly');
    } catch (thrown: unknown) {
      error = thrown;
    }
    expect(error).toBeUltimateError('X_CLI_BAD_FLAG');
    expect((error as { cause: string }).cause).toContain('reference, dev');
  });

  test('one name declared twice is refused rather than resolved to whichever sorted first', () => {
    let error: unknown;
    try {
      selectSeeds({
        discovered: [found('dev', 'dev', 'a.ts'), found('dev', 'dev', 'b.ts')],
        name: 'dev',
        environment: 'development',
      });
    } catch (thrown: unknown) {
      error = thrown;
    }
    expect(error).toBeUltimateError('X_CLI_BAD_FLAG');
    expect((error as { cause: string }).cause).toContain('a.ts, b.ts');
  });
});

describe('unit · x db seed · one transaction per seed', () => {
  const entryFor = (seed: Seed): DiscoveredSeed => ({ seed, file: `${seed.name}.ts` });

  test('a seed that throws is a row and a finding, and the next seed still runs', async () => {
    const order: string[] = [];
    const rows = await runSeeds({
      seeds: [
        entryFor(
          fakeSeed('first', 'dev', async () => {
            order.push('first');
            throw new Error('the fixture graph is wrong');
          }),
        ),
        entryFor(
          fakeSeed('second', 'dev', async () => {
            order.push('second');
            return {
              name: 'second',
              tier: 'dev',
              metrics: { inserted: 2, updated: 1, skipped: 3 },
            };
          }),
        ),
      ],
      driver: { repo: () => ({}) as never },
      dryRun: false,
      transaction: (work) => work(),
    });
    expect(order).toEqual(['first', 'second']);
    expect(rows.map((row) => row.status)).toEqual(['failed', 'ok']);
    expect(rows[0]?.finding?.at).toBe('first.ts');
    expect(seedTotals(rows)).toEqual({ inserted: 2, updated: 1, skipped: 3, failed: 1 });
  });

  test('every seed is wrapped on its own, so one rollback cannot take another with it', async () => {
    let opened = 0;
    await runSeeds({
      seeds: [entryFor(fakeSeed('a', 'dev')), entryFor(fakeSeed('b', 'reference'))],
      driver: { repo: () => ({}) as never },
      dryRun: false,
      transaction: async (work) => {
        opened += 1;
        return work();
      },
    });
    expect(opened).toBe(2);
  });

  test('--json carries a row per seed, slowest first, plus the totals', () => {
    const row = (name: string, ms: number): SeedPassRow => ({
      file: `${name}.ts`,
      name,
      tier: 'dev',
      status: 'ok',
      ms,
      inserted: 1,
      updated: 0,
      skipped: 2,
      finding: null,
    });
    const json = seedPassToJson([row('quick', 3), row('slow', 90)]) as {
      seeds: readonly { name: string; ms: number }[];
      totals: Record<string, number>;
    };
    expect(json.seeds.map((one) => one.name)).toEqual(['slow', 'quick']);
    expect(json.totals).toEqual({ inserted: 2, updated: 0, skipped: 4, failed: 0 });
  });
});

describe('unit · x db seed · the command', () => {
  test('an unknown name lists the seeds that do exist and never opens a connection', async () => {
    await withRoot({ 'packages/db/seeds/dev.ts': seedModule('dev', 'dev') }, async (root) => {
      const error = await failure(dbCommand.run(ctxFor(['db', 'seed', 'devv'], root)));
      expect(error).toBeUltimateError('X_DECLARATION_UNKNOWN');
      expect((error as { cause: string }).cause).toContain('known: dev');
      expect((error as { fix: string }).fix).toBe('x db seed --dry-run --json');
    });
  });

  test('ULTIMATE_ENV=production refuses the app dev seed by name, before any boot', async () => {
    await withRoot({ 'packages/db/seeds/dev.ts': seedModule('dev', 'dev') }, async (root) => {
      const error = await failure(
        dbCommand.run(ctxFor(['db', 'seed', 'dev'], root, { ULTIMATE_ENV: 'production' })),
      );
      expect(error).toBeUltimateError('X_SEED_ENVIRONMENT');
      expect((error as { cause: string }).cause).toContain('tier dev');
      // The `--json` body the terminal and CI both read: the code an agent branches on, and a
      // fix line it can run without reading this file.
      expect(findingFrom(error)).toEqual({
        code: 'X_SEED_ENVIRONMENT',
        cause: (error as { cause: string }).cause,
        fix: 'x db seed dev --tier dev --json',
        docs: docsFor('X_SEED_ENVIRONMENT'),
      });
    });
  });

  test('a production run with nothing of that tier answers, rather than booting a queue', async () => {
    await withRoot({ 'packages/db/seeds/dev.ts': seedModule('dev', 'dev') }, async (root) => {
      const result = await dbCommand.run(
        ctxFor(['db', 'seed'], root, { ULTIMATE_ENV: 'production' }),
      );
      expect(result.ok).toBe(true);
      expect(result.data).toEqual({
        seeds: [],
        totals: { inserted: 0, updated: 0, skipped: 0, failed: 0 },
      });
    });
  });

  test('seed is in the subcommand list, so x help db and the parser both reach it', () => {
    expect(dbCommand.spec.subcommands).toContain('seed');
    expect(parseArgs(['db', 'seed', 'dev', '--dry-run'], SPECS).subcommand).toBe('seed');
  });
});
