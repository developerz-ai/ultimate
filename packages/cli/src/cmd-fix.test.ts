// `x fix boundary <file>` against real fixture apps on disk. The plan it prints, never a
// rewrite — no file in the fixture tree is expected to change shape across any of these tests.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { rm } from 'node:fs/promises'; // why: Bun has no recursive remove, only a per-file delete.
// why: Bun exposes no path-join primitive; Bun.file and import() take one already joined.
import { join } from 'node:path';
import { REQUIRED_BUN } from './app-root';
import { fixCommand } from './cmd-fix';
import type { CommandContext } from './command';
import { msg } from './messages';

const ROOT = join(import.meta.dir, '..', '.cmd-fix-fixture');

const FILES: Readonly<Record<string, string>> = {
  'app.config.ts': "export const config = { name: 'fixture' };\n",

  // s1: site/ reaches app/ through two hops of shared/ — one cut, the full chain named.
  'apps/s1/site/pricing.tsx': "import { Price } from '../shared/a';\n",
  'apps/s1/shared/a.ts': "import { helper } from './b';\n",
  'apps/s1/shared/b.ts': "import { rate } from '../app/rates';\n",
  'apps/s1/app/rates.ts': 'export const rate = 1;\n',

  // s2: shared/panel.tsx is reached by exactly one surface (app/) — a split is generated.
  'apps/s2/app/dashboard.tsx': "import { Panel } from '../shared/panel';\n",
  'apps/s2/shared/panel.tsx': "import { Chart } from '../app/charts';\n",
  'apps/s2/app/charts.ts': 'export const Chart = () => null;\n',

  // s3: the same shape, but shared/panel.tsx is reached by two surfaces — no split.
  'apps/s3/app/dashboard.tsx': "import { Panel } from '../shared/panel';\n",
  'apps/s3/api/admin.ts': "import { Panel } from '../shared/panel';\n",
  'apps/s3/shared/panel.tsx': "import { Chart } from '../app/charts';\n",
  'apps/s3/app/charts.ts': 'export const Chart = () => null;\n',

  // s4: a clean surface graph — nothing to fix.
  'apps/s4/site/about.tsx': "import { Layout } from '../shared/layout';\n",
  'apps/s4/shared/layout.tsx': 'export const Layout = () => null;\n',

  // s5: two files share a basename, so the short suffix "service.ts" is ambiguous.
  'apps/s5/app/orders/service.ts': 'export const noop = 1;\n',
  'apps/s5/app/billing/service.ts': 'export const noop = 1;\n',
};

const contextFor = (file: string): CommandContext => ({
  args: {
    command: 'fix',
    subcommand: 'boundary',
    positionals: [file],
    flags: new Map(),
    json: false,
    help: false,
    passthrough: [],
  },
  cwd: ROOT,
  runner: async () => ({
    command: ['true'],
    code: 0,
    ok: true,
    stdout: '',
    stderr: '',
    durationMs: 0,
  }),
  env: {},
  bunVersion: REQUIRED_BUN,
});

beforeAll(async () => {
  await rm(ROOT, { recursive: true, force: true });
  for (const [path, contents] of Object.entries(FILES)) {
    await Bun.write(join(ROOT, path), contents);
  }
});

afterAll(async () => {
  await rm(ROOT, { recursive: true, force: true });
});

/** The same context with no positional at all — what a bare `x fix` reaches `run` with. */
const withNoFile = (): CommandContext => ({
  ...contextFor('unused'),
  args: { ...contextFor('unused').args, positionals: [] },
});

describe('unit · x fix boundary', () => {
  // A bare `x fix` passed `''` into the resolver, so the refusal was about a FILE named `""` —
  // `"" is not one of the 42 source file(s) under apps/*/{site,app,api,shared}` — and `nearest('')`
  // answers `undefined`, so its `fix:` degraded to `x routes --json` for a caller who had simply
  // not said which file. The missing thing is the positional, and that is what has to be named.
  test('a bare x fix names the missing positional, not a file called ""', async () => {
    const thrown: unknown = await fixCommand.run(withNoFile()).then(
      () => undefined,
      (error: unknown) => error,
    );
    expect((thrown as { code?: string }).code).toBe('X_CLI_BAD_FLAG');
    expect((thrown as { cause: string }).cause).toBe(
      '"x fix boundary" needs a <file> positional and got none',
    );
    expect((thrown as { cause: string }).cause).not.toContain('source file(s)');
  });

  test('a site/ page reaching app/ through two hops of shared/ names one cut and its full chain', async () => {
    const result = await fixCommand.run(contextFor('apps/s1/site/pricing.tsx'));
    expect(result.ok).toBe(false);
    expect(result.findings).toHaveLength(1);
    const finding = result.findings?.[0];
    expect(finding?.code).toBe('X_BOUNDARY_SITE_TO_APP');
    expect(finding?.cause).toBe(
      'apps/s1/site/pricing.tsx → apps/s1/shared/a.ts → apps/s1/shared/b.ts → apps/s1/app/rates.ts',
    );
    const data = result.data as {
      cuts: readonly { edge: { from: string; to: string }; chain: readonly string[] }[];
    };
    expect(data.cuts).toHaveLength(1);
    expect(data.cuts[0]?.edge).toEqual({ from: 'apps/s1/shared/b.ts', to: 'apps/s1/app/rates.ts' });
    expect(data.cuts[0]?.chain).toEqual([
      'apps/s1/site/pricing.tsx',
      'apps/s1/shared/a.ts',
      'apps/s1/shared/b.ts',
      'apps/s1/app/rates.ts',
    ]);
  });

  test('a shared/ module reached by exactly one surface gets a git mv onto that surface', async () => {
    const result = await fixCommand.run(contextFor('apps/s2/shared/panel.tsx'));
    expect(result.ok).toBe(false);
    const data = result.data as {
      cuts: readonly {
        split: { command: string; surface: string; to: string; importers: string[] } | null;
      }[];
    };
    expect(data.cuts).toHaveLength(1);
    const split = data.cuts[0]?.split;
    expect(split).not.toBeNull();
    expect(split?.command).toBe('git mv apps/s2/shared/panel.tsx apps/s2/app/panel.tsx');
    expect(split?.surface).toBe('app');
    expect(split?.to).toBe('apps/s2/app/panel.tsx');
    expect(split?.importers).toEqual(['apps/s2/app/dashboard.tsx']);
    // The move ALONE is not the repair: `dashboard.tsx` still imports `../shared/panel`, so the
    // published fix has to carry every specifier the move invalidates.
    expect(result.findings?.[0]?.fix).toStartWith(split?.command ?? '');
    expect(result.findings?.[0]?.fix).toContain(
      "apps/s2/app/dashboard.tsx, apps/s2/shared/panel.tsx → './panel'",
    );
  });

  test('the same shape reached by two surfaces gets no git mv — a cut instead', async () => {
    const result = await fixCommand.run(contextFor('apps/s3/shared/panel.tsx'));
    expect(result.ok).toBe(false);
    const data = result.data as { cuts: readonly { split: unknown; edit: string }[] };
    expect(data.cuts).toHaveLength(1);
    expect(data.cuts[0]?.split).toBeNull();
    expect(data.cuts[0]?.edit).not.toContain('git mv');
    expect(data.cuts[0]?.edit).toContain('api');
    expect(data.cuts[0]?.edit).toContain('app');
    expect(result.findings?.[0]?.fix).not.toContain('git mv');
  });

  test('a clean file reports no findings', async () => {
    const result = await fixCommand.run(contextFor('apps/s4/site/about.tsx'));
    expect(result.ok).toBe(true);
    expect(result.summary).toBe(msg('cli.fix.clean', { file: 'apps/s4/site/about.tsx' }));
    expect(result.findings ?? []).toEqual([]);
  });

  // The command is named `fix` and it has never fixed anything: it prints a plan and a caller runs
  // it. Renaming it would break the five packages whose `fix:` lines cite `x fix boundary <file>`,
  // so what it owes instead is to say so in both lines a reader sees — the one `x help` prints and
  // the one the run itself ends with.
  test('it says out loud that it wrote nothing, and offers no flag that would', async () => {
    const result = await fixCommand.run(contextFor('apps/s2/shared/panel.tsx'));
    expect(result.summary).toContain('nothing written');
    expect(fixCommand.spec.summary).toContain('plan');
    expect(fixCommand.spec.summary).toContain('never rewrites');
    expect(fixCommand.spec.flags?.map((flag) => flag.name) ?? []).not.toContain('write');
  });

  test('an unknown path is X_FIX_TARGET_UNKNOWN', async () => {
    await expect(fixCommand.run(contextFor('apps/s4/site/nope.tsx'))).rejects.toThrow(
      /X_FIX_TARGET_UNKNOWN/,
    );
  });

  test('a near miss suggests a real file — never the caller’s own failing path', async () => {
    const failure: unknown = await fixCommand.run(contextFor('apps/s4/site/aboutt.tsx')).then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(failure).toBeUltimateError('X_FIX_TARGET_UNKNOWN');
    expect((failure as { fix: string }).fix).toBe('x fix boundary apps/s4/site/about.tsx');
  });

  test('a path with nothing close points at a listing, not at itself', async () => {
    const failure: unknown = await fixCommand.run(contextFor('totally/elsewhere/thing.ts')).then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(failure).toBeUltimateError('X_FIX_TARGET_UNKNOWN');
    expect((failure as { fix: string }).fix).not.toContain('totally/elsewhere/thing.ts');
  });

  test('an ambiguous suffix is X_CLI_BAD_FLAG, listing every candidate', async () => {
    await expect(fixCommand.run(contextFor('service.ts'))).rejects.toThrow(/X_CLI_BAD_FLAG/);
  });

  test('a short suffix resolves onto the same file as its full app-root-relative path', async () => {
    const full = await fixCommand.run(contextFor('apps/s1/site/pricing.tsx'));
    const short = await fixCommand.run(contextFor('site/pricing.tsx'));
    expect(short.data).toEqual(full.data as never);
  });
});
