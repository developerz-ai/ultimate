// The scaffolder had no test at all, and it shipped two defects a test would have caught on the
// first run: a boundary doc derived from the tier TABLE (which a package being created is not in
// yet), and a `--tier` parsed with no guard.

import { describe, expect, test } from 'bun:test';
// why: Bun.file().exists() answers about a file and answers false for a directory, so a refusal
// cannot be asked through it whether it left a package directory behind.
import { existsSync } from 'node:fs';
// why: Bun has no mkdtemp and no recursive remove; the fixture needs a throwaway tree on disk.
import { mkdtemp, rm } from 'node:fs/promises';
// why: Bun exposes no tmpdir(), so only node:os answers the platform temp root.
import { tmpdir } from 'node:os';
// why: Bun exposes no path-join primitive; Bun.file and import() take one already joined.
import { join } from 'node:path';
import { PACKAGE_FILES } from '@ultimat3/cli';
import { registerIn } from './lib/error-code-plan';
import { allowedTiersFor, TIERS } from './lib/tiers';
import {
  nameProblem,
  packageTemplates,
  scaffoldPackage,
  TIER_NUMBERS,
  tierProblem,
  withPackageReference,
} from './new-package';
import { frontFindingsFor, WIKI_ROOT } from './package-front';

const fileNamed = (name: string, tier: number, path: string): string => {
  const file = packageTemplates(name, tier, 'one line').find((entry) => entry.path === path);
  if (file === undefined) expect.unreachable(`no ${path} in the templates`);
  return file.contents;
};

describe('unit · a scaffolded package opens its npm page the way the gate asks', () => {
  // `scripts/package-front.ts` refuses a publishable package with no keywords or whose README's
  // first screen lacks an install line, an example and its wiki page — so the scaffold writes them.
  test('its README and package.json pass the npm-page rule on the day they are written', () => {
    const manifest = JSON.parse(fileNamed('widgets', 1, 'package.json')) as Record<string, unknown>;
    const pkg = {
      dir: 'widgets',
      name: '@ultimat3/widgets',
      readme: fileNamed('widgets', 1, 'README.md'),
      manifest,
    };
    expect(frontFindingsFor(pkg, {})).toEqual([]);
    expect(manifest['homepage']).toBe(WIKI_ROOT);
  });
});

describe('unit · a scaffolded package documents its OWN boundary', () => {
  // `allowedTiersFor(name)` resolved through `tierOf('widgets')` -> UNLISTED_TIER (6), so every
  // scaffolded package's CLAUDE.md said "May import tiers 0-5" whatever `--tier` asked for — and
  // an agent following it would import @ultimat3/render from a tier-1 package.
  test('the allowed range comes from the tier given, not from the package name', () => {
    expect(fileNamed('widgets', 1, 'CLAUDE.md')).toContain('Tier 1. May import tiers 0-0.');
    expect(fileNamed('widgets', 3, 'CLAUDE.md')).toContain('Tier 3. May import tiers 0-2.');
    expect(fileNamed('widgets', 1, 'README.md')).toContain('Tier 1. May import tiers 0-0 only');
    expect(fileNamed('widgets', 0, 'CLAUDE.md')).toContain('May import tiers 0-0');
  });

  test('the range agrees with the table every other check reads', () => {
    for (const tier of TIER_NUMBERS) {
      expect(fileNamed('widgets', tier, 'CLAUDE.md')).toContain(
        `Tier ${tier}. May import tiers ${allowedTiersFor(tier)}.`,
      );
    }
  });

  test('every contract file the package-shape step demands is emitted', () => {
    const paths = packageTemplates('widgets', 1, 'one line').map((file) => file.path);
    for (const required of PACKAGE_FILES) expect(paths).toContain(required);
    expect(paths).toContain('LICENSE');
  });

  /**
   * The `docs:` line is the assertion that CHANGED, and it changed because it was wrong: this
   * template wrote `https://ultimate.dev/errors/<code>` into every package it ever scaffolded and
   * that host answers 404. `UltimateError`'s constructor resolves the registered descriptor, whose
   * default is `ERROR_DOCS_URL` — so the correct template emits no `docs:` at all, and a test
   * pinning the old one was pinning the defect.
   */
  test('the scaffolded error class carries a namespaced code and NO docs url', () => {
    const errors = fileNamed('widget-set', 1, 'src/errors.ts');
    expect(errors).toContain("'X_WIDGET_SET_INVALID'");
    expect(errors).toContain('extends UltimateError');
    expect(errors).not.toContain('ultimate.dev');
    // The CONSTRUCTOR call, not the word: the file's own header explains why the line is absent,
    // and asserting the word never appears would forbid it saying so.
    expect(errors).not.toContain("docs: '");
  });
});

/**
 * A scaffolded package got a `tsconfig.json` and no line in the root solution, so `tsc -b` — the
 * `typecheck` step's whole implementation — compiled every project the root REFERENCES and walked
 * past the new one. The same hole `scripts/` itself sat in: a workspace outside the build graph
 * typechecks nowhere, and nothing said so.
 */
describe('unit · a scaffolded package joins the root build graph', () => {
  const root = (...paths: readonly string[]): string =>
    `${JSON.stringify({ files: [], references: paths.map((path) => ({ path })) }, null, 2)}\n`;

  test('the new package is added to the root references, in sorted order', () => {
    const next = withPackageReference(root('./packages/core', './scripts'), 'jobs') ?? '';
    expect(JSON.parse(next)).toEqual({
      files: [],
      references: [{ path: './packages/core' }, { path: './packages/jobs' }, { path: './scripts' }],
    });
    // Two spaces and a trailing newline, so re-scaffolding never shows up as a whitespace diff.
    expect(next).toBe(root('./packages/core', './packages/jobs', './scripts'));
  });

  test('an entry that is already there is left exactly as it was', () => {
    const source = root('./packages/core');
    expect(withPackageReference(source, 'core')).toBe(source);
  });

  // `checkRootReferences` reads all three spellings as one project, so a `===` on the canonical
  // one appended a second entry for a package the gate already reports as referenced — two rows
  // for one project, and a scaffolder that "fixed" a finding nobody had.
  test('an entry spelled another legal way is still the same project', () => {
    for (const spelling of ['packages/core', './packages/core/', 'packages/core/']) {
      const source = root(spelling);
      expect(withPackageReference(source, 'core')).toBe(source);
    }
  });

  test('a root config this cannot parse is returned untouched, never half-rewritten', () => {
    expect(withPackageReference('{ "references": [ // a comment\n]}', 'jobs')).toBeUndefined();
    expect(withPackageReference(JSON.stringify({ files: [] }), 'jobs')).toBeUndefined();
  });
});

describe('unit · the scaffolder writes the package it says it writes', () => {
  // The command's own block ran only as a process, so every line of it counted as uncovered. The
  // tree is a throwaway root: the package directory, the template files and the root `references`
  // entry are what the command claims to write, and the tree is asked whether they are there.
  test('the package directory, its template files and the root reference are all written', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ultimate-new-package-'));
    try {
      await Bun.write(
        join(root, 'tsconfig.json'),
        `${JSON.stringify({ files: [], references: [{ path: './packages/core' }] }, null, 2)}\n`,
      );

      const result = await scaffoldPackage({
        root,
        name: 'widgets',
        tier: '1',
        description: 'one line about widgets',
        only: undefined,
      });

      expect(result.ok).toBe(true);
      expect(result.summary).toBe('packages/widgets scaffolded at tier 1');
      expect(result.data).toMatchObject({ name: 'widgets', tier: 1, referenced: true });
      // The package directory, with the contract files the shape gate demands.
      expect(await Bun.file(join(root, 'packages/widgets/package.json')).exists()).toBe(true);
      expect(await Bun.file(join(root, 'packages/widgets/README.md')).exists()).toBe(true);
      expect(await Bun.file(join(root, 'packages/widgets/src/index.ts')).exists()).toBe(true);
      // The build graph: a package outside the root references is a package `tsc -b` never compiles.
      const config = JSON.parse(await Bun.file(join(root, 'tsconfig.json')).text()) as {
        readonly references: readonly { readonly path: string }[];
      };
      expect(config.references).toContainEqual({ path: './packages/widgets' });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe('unit · a refusal is a refusal, and it leaves the tree alone', () => {
  // Every refusal in the command was a branch no test reached: the happy path was pinned and the
  // refusals were not, so deleting one left this file green while the command wrote the package it
  // had just refused. Each case drives the command against a throwaway root and asks the tree what
  // the refusal left behind.
  const inThrowawayRoot = async (run: (root: string) => Promise<void>): Promise<void> => {
    const root = await mkdtemp(join(tmpdir(), 'ultimate-new-package-'));
    try {
      await run(root);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  };

  test('no package name is refused, and nothing is written', async () => {
    await inThrowawayRoot(async (root) => {
      const result = await scaffoldPackage({
        root,
        name: undefined,
        tier: '1',
        description: 'one line about widgets',
        only: undefined,
      });
      const finding = result.findings?.[0];
      expect(result.ok).toBe(false);
      expect(result.summary).toBe('a package name is required');
      expect(finding?.code).toBe('X_CLI_BAD_FLAG');
      expect(finding?.fix).toContain('bun run scripts/new-package.ts seo --tier 1');
      expect(existsSync(join(root, 'packages'))).toBe(false);
    });
  });

  test('a name that is not a kebab-case directory is refused, and nothing is written', async () => {
    await inThrowawayRoot(async (root) => {
      const result = await scaffoldPackage({
        root,
        name: '../../x',
        tier: '1',
        description: 'one line about widgets',
        only: undefined,
      });
      const finding = result.findings?.[0];
      expect(result.ok).toBe(false);
      expect(result.summary).toBe('a package name is a kebab-case directory name');
      expect(finding?.code).toBe('X_CLI_BAD_FLAG');
      expect(finding?.fix).toContain('bun run scripts/new-package.ts my-package --tier 1');
      expect(existsSync(join(root, 'packages'))).toBe(false);
    });
  });

  test('a tier that is not a tier is refused, and nothing is written', async () => {
    await inThrowawayRoot(async (root) => {
      const result = await scaffoldPackage({
        root,
        name: 'widgets',
        tier: 'abc',
        description: 'one line about widgets',
        only: undefined,
      });
      const finding = result.findings?.[0];
      expect(result.ok).toBe(false);
      expect(result.summary).toBe('a package needs a real tier before it needs a file');
      expect(finding?.code).toBe('X_CLI_BAD_FLAG');
      expect(finding?.fix).toContain('bun run scripts/new-package.ts widgets --tier 1');
      expect(existsSync(join(root, 'packages'))).toBe(false);
    });
  });

  test('a package that already exists is refused, and its directory is left as it was', async () => {
    await inThrowawayRoot(async (root) => {
      await Bun.write(join(root, 'packages/widgets/marker.txt'), 'as it was');
      const result = await scaffoldPackage({
        root,
        name: 'widgets',
        tier: '1',
        description: 'one line about widgets',
        only: undefined,
      });
      const finding = result.findings?.[0];
      expect(result.ok).toBe(false);
      expect(result.summary).toBe('packages/widgets already exists');
      expect(finding?.code).toBe('X_GENERATE_CONFLICT');
      expect(finding?.at).toBe('packages/widgets');
      expect(finding?.fix).toContain('--only README.md');
      // The directory is as it was: no template was written into it.
      expect(await Bun.file(join(root, 'packages/widgets/marker.txt')).text()).toBe('as it was');
      expect(await Bun.file(join(root, 'packages/widgets/package.json')).exists()).toBe(false);
    });
  });

  test('an --only that names no template is refused, and nothing is written', async () => {
    await inThrowawayRoot(async (root) => {
      const result = await scaffoldPackage({
        root,
        name: 'widgets',
        tier: '1',
        description: 'one line about widgets',
        only: 'NOPE.md',
      });
      const finding = result.findings?.[0];
      expect(result.ok).toBe(false);
      expect(result.summary).toBe('no template named NOPE.md');
      expect(finding?.code).toBe('X_CLI_BAD_FLAG');
      expect(finding?.fix).toContain('--only package.json');
      expect(existsSync(join(root, 'packages'))).toBe(false);
    });
  });

  // The one refusal that writes first: the package is on disk before the root config is read, so
  // the refusal has to say so — a reader who saw only "refused" would think nothing was written.
  test('a root config that cannot be rewritten is refused AFTER the package is written', async () => {
    await inThrowawayRoot(async (root) => {
      // A root solution config this cannot rewrite: JSON with a comment in it, so the parse fails.
      const config = '{ "references": [ // a comment\n]}';
      await Bun.write(join(root, 'tsconfig.json'), config);
      const result = await scaffoldPackage({
        root,
        name: 'widgets',
        tier: '1',
        description: 'one line about widgets',
        only: undefined,
      });
      const finding = result.findings?.[0];
      expect(result.ok).toBe(false);
      expect(result.summary).toBe(
        'packages/widgets was written, but tsconfig.json could not be rewritten',
      );
      expect(finding?.code).toBe('X_GENERATE_CONFLICT');
      expect(finding?.at).toBe('tsconfig.json');
      expect(finding?.fix).toContain('add { "path": "./packages/widgets" }');
      // The package was written before the refusal, and the config was left exactly as it was.
      expect(await Bun.file(join(root, 'packages/widgets/package.json')).exists()).toBe(true);
      expect(await Bun.file(join(root, 'tsconfig.json')).text()).toBe(config);
    });
  });
});

describe('unit · --tier is a tier or a refusal', () => {
  // `--tier abc` was `Number.parseInt`'d to NaN and written into the docs as "Tier NaN".
  test('a non-numeric or out-of-table tier is refused', () => {
    expect(tierProblem('abc', 'seo')).toContain('not one of');
    expect(tierProblem('9', 'seo')).toContain('not one of');
    expect(tierProblem('1.5', 'seo')).toContain('not one of');
    expect(tierProblem('', 'seo')).toContain('not one of');
  });

  test('every tier in the table passes, and an absent flag is not a problem for a listed name', () => {
    for (const tier of Object.keys(TIERS)) expect(tierProblem(tier, 'brand-new')).toBeUndefined();
    expect(tierProblem(undefined, 'seo')).toBeUndefined();
    expect(tierProblem(undefined, 'create-ultimate')).toBeUndefined();
  });

  // No `--tier` for a package in no table resolved to `UNLISTED_TIER` (6): a scaffold whose own
  // CLAUDE.md said "may import tiers 0-5", which is every package in the framework.
  test('a name in no tier table must state its tier', () => {
    expect(tierProblem(undefined, 'brand-new')).toContain('--tier is required');
  });
});

describe('unit · the name is a package directory, nothing else', () => {
  // `../../x` was joined under `packages/` and written wherever it resolved.
  test('a path, an upper-case or a non-kebab name is refused', () => {
    for (const name of [
      '../../x',
      'a/b',
      'Seo',
      'seo_two',
      '-seo',
      'seo-',
      'seo--two',
      '1seo',
      '',
    ]) {
      expect(nameProblem(name)).toContain('kebab-case');
    }
  });

  test('every package in the table is a legal name, and so is a new kebab-case one', () => {
    for (const name of [...Object.values(TIERS).flat(), 'create-ultimate', 'i18n', 'brand-new']) {
      expect(nameProblem(name)).toBeUndefined();
    }
  });
});

describe('unit · the emitted package.json is the manifest every other package has', () => {
  const manifest = (): Record<string, unknown> =>
    JSON.parse(fileNamed('widgets', 1, 'package.json')) as Record<string, unknown>;
  const withDescription = (description: string): Record<string, unknown> => {
    const file = packageTemplates('widgets', 1, description).find(
      (entry) => entry.path === 'package.json',
    );
    return JSON.parse(file?.contents ?? '') as Record<string, unknown>;
  };

  // It wrote `>=1.3.0` while every other manifest said `>=1.4.2`, and `bun-pin.test.ts` needs one
  // series — a scaffolded package was a red gate the moment it existed.
  test('engines.bun is the floor the root manifest declares', async () => {
    const root = (await Bun.file(`${import.meta.dir}/../package.json`).json()) as {
      engines: { bun: string };
    };
    expect((manifest()['engines'] as { bun: string }).bun).toBe(root.engines.bun);
  });

  // `--description 'the "fast" one'` was interpolated raw: invalid JSON, so the next install died.
  test('a description with quotes, backslashes or a newline is still valid JSON, verbatim', () => {
    for (const description of ['the "fast" one', 'a \\ path', 'two\nlines', "it's 'quoted'"]) {
      expect(withDescription(description)['description']).toBe(description);
    }
  });
});

describe('unit · the scaffolded errors.ts is a shape new-error-code can add to', () => {
  // The template had no TITLES object and no registerErrorCodes, so the generator refused a package
  // the scaffolder had just written: "register it by hand" as the first thing to do with a new package.
  test('registerIn adds a code to the array and the titles, and the result transpiles', () => {
    const source = fileNamed('widget-set', 1, 'src/errors.ts');
    const out = registerIn(source, 'packages/widget-set/src/errors.ts', {
      code: 'X_WIDGET_SET_EMPTY',
      pkg: 'widget-set',
      title: 'a widget set with no widgets',
      cause: 'c',
      fix: 'f',
    });
    expect(out).toContain("  'X_WIDGET_SET_EMPTY',\n] as const;");
    expect(out).toContain("  X_WIDGET_SET_EMPTY: 'a widget set with no widgets',\n};");
    expect(() => new Bun.Transpiler({ loader: 'ts' }).transformSync(out)).not.toThrow();
  });

  test('it registers the title it declares', () => {
    const source = fileNamed('widget-set', 1, 'src/errors.ts');
    expect(source).toContain('registerErrorCodes(');
    expect(source).toContain('WIDGET_SET_ERROR_TITLES');
  });
});
