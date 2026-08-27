// The generators' output, held to the gate the same generators ship. A file `x new` writes that the
// scaffolded app's own `lint` or `errors` step rejects is a red first gate over code nobody typed —
// and CI's scaffold-smoke job is a full install away, so the rules run here, over the strings, where
// a failure names the template that emitted them.

import { describe, expect, test } from 'bun:test';
// why: `node:` by necessity: Bun exposes no path-join primitive, and the Biome binary is found by
// walking out of this file's directory to the repo root.
import { join } from 'node:path';
import type { GenerateOptions } from '../cmd-generate';
import { generate } from '../cmd-generate';
import { planNewApp } from '../cmd-new';
import { fixProblem, staticFix } from '../error-contract';
import { citedCommandProblem, loadCommandCatalog } from '../fix-command';
import { scanFixes } from '../fix-scan';
import { scaffoldVariants } from '../scaffold-fixture';
import { stripComments } from '../ts-scan';

/** Four levels: `templates` → `src` → `cli` → `packages` → the repo root. */
const REPO_ROOT = join(import.meta.dir, '..', '..', '..', '..');

interface EmittedText {
  /** `x new` / `x new --no-example` — which invocation wrote it, so a failure names one. */
  readonly variant: string;
  readonly path: string;
  readonly contents: string;
}

/** Every text file every documented invocation writes. The app icon is bytes and has no lines. */
const emitted = (): readonly EmittedText[] =>
  scaffoldVariants().flatMap((variant) =>
    variant.files.flatMap((file) =>
      typeof file.contents === 'string'
        ? [{ variant: variant.name, path: file.path, contents: file.contents }]
        : [],
    ),
  );

const at = (file: EmittedText, line?: number): string =>
  `${file.variant}: ${file.path}${line === undefined ? '' : `:${line}`}`;

describe('unit · every emitted file survives the formatter the scaffold configures', () => {
  // `biome check .` is the scaffolded app's whole `lint` step, and its formatter is not advisory:
  // ONE generated `page.test.ts` ending in a blank line was the single error behind `lint` being
  // red in every app `x new` has ever produced — an `x g route` template, reported against the app.
  test('a generated file ends with exactly one newline', () => {
    const offenders = emitted()
      .filter((file) => !file.contents.endsWith('\n') || file.contents.endsWith('\n\n'))
      .map((file) => at(file));
    expect(offenders).toEqual([]);
  });

  test('no generated line carries trailing whitespace', () => {
    const offenders = emitted().flatMap((file) =>
      file.contents
        .split('\n')
        .flatMap((line, index) => (/[ \t]+$/.test(line) ? [at(file, index + 1)] : [])),
    );
    expect(offenders).toEqual([]);
  });
});

describe('unit · every emitted file survives the linter the scaffold configures', () => {
  /**
   * The rules above read the strings; this one runs the app's own gate over them. Two lint errors
   * shipped in `x g island` — `useLiteralKeys`, twice in the one file every island is copied from —
   * and a missing blank line in its test, and no string rule could have seen any of the three:
   * they are Biome's opinion, and the only thing that holds it is Biome.
   *
   * The scaffold's own `biome.json` is among the emitted files, so the check runs under the exact
   * config a generated app runs under. Its `$schema` names the version `package.json` installs,
   * which may be ahead of the one THIS repo has; that mismatch is an `info`, never an error, so it
   * cannot decide this test either way.
   */
  const lintFindings = async (files: readonly EmittedText[], name: string): Promise<string> => {
    const dir = join(
      process.env['TMPDIR'] ?? '/tmp',
      `x-emitted-biome-${Bun.randomUUIDv7()}`,
      name.replaceAll(/[^a-z0-9]+/g, '-'),
    );
    for (const file of files) await Bun.write(join(dir, file.path), file.contents);
    const biome = join(REPO_ROOT, 'node_modules', '.bin', 'biome');
    const run = Bun.spawnSync([biome, 'check', '.'], { cwd: dir, stdout: 'pipe', stderr: 'pipe' });
    return run.exitCode === 0 ? '' : `${run.stdout.toString()}${run.stderr.toString()}`;
  };

  for (const variant of scaffoldVariants()) {
    test(`${variant.name} emits nothing biome check rejects`, async () => {
      const files = emitted().filter((file) => file.variant === variant.name);
      // Named, so a scaffold that stopped emitting anything cannot pass by having nothing to lint.
      expect(files.length).toBeGreaterThan(0);
      expect(await lintFindings(files, variant.name)).toBe('');
    });
  }

  /** Every generator once, into one feature — the set a real app's second command produces. */
  const battery = (feature: string): readonly GenerateOptions[] => [
    { kind: 'resource', name: feature, admin: true },
    { kind: 'entity', name: feature, feature },
    { kind: 'policy', name: feature, feature },
    { kind: 'action', name: `publish-${feature}`, feature },
    { kind: 'mutator', name: `rename-${feature}`, feature },
    { kind: 'query', name: `recent-${feature}s`, feature },
    { kind: 'query', name: `${feature}-feed`, feature, live: true },
    { kind: 'job', name: `reindex-${feature}s`, feature },
    { kind: 'task', name: `nightly-${feature}-sweep`, feature },
    // Name === feature: the one invocation that redeclares the entity the sweep imports.
    { kind: 'backfill', name: feature, feature },
    { kind: 'backfill', name: `normalize-${feature}-titles`, feature },
    { kind: 'route', name: `${feature}s`, surface: 'site' },
    { kind: 'island', name: 'currency-picker', at: `apps/web/site/${feature}s` },
    { kind: 'admin:page', name: `reconcile-${feature}s`, permission: 'ledger:reconcile' },
    { kind: 'guard', name: 'migration-safety' },
  ];

  /**
   * Generated source is emitted PRE-formatted — a template cannot run a formatter — so whether it
   * survives Biome depends on the name interpolated into it, along TWO independent axes. The
   * fixture above varies neither: `invoice` is short and sorts after `can…`.
   *
   * | name | axis | what it caught |
   * |---|---|---|
   * | `subscription-invoice-line` | LENGTH | 33 files the formatter rewrites past ~22 characters |
   * | `billing`, `audit-log` | FIRST LETTER | `{ canBillingWrite, billingTag }` — `b` sorts before `c`, so `organizeImports` fails for every feature starting `a` or `b` |
   * | `zoning` | the other side of the same sort | a fix that always put the tag first would pass `billing` and break this |
   *
   * The ordering bug survived a sweep that only varied length, which is why the first letter is now
   * a named axis and not an accident of whichever example name was reached for.
   */
  for (const feature of ['subscription-invoice-line', 'billing', 'audit-log', 'zoning']) {
    test(`every generator survives biome check for a feature named ${feature}`, async () => {
      // The scaffold's biome.json rides along: the battery is linted under the app's config, not
      // this repo's, which excludes different paths and would answer a different question.
      //
      // And `.gitignore` with it, because that config declares `vcs.useIgnoreFile` — Biome exits 1
      // with `couldn't find an ignore file` when the file the config names is absent, so a harness
      // carrying one half of the pair asks a question no real app ever asks.
      const config = emitted().filter(
        (file) => file.variant === 'x new' && ['biome.json', '.gitignore'].includes(file.path),
      );
      expect(config.map((file) => file.path).sort()).toEqual(['.gitignore', 'biome.json']);
      const seen = new Set<string>();
      const files: EmittedText[] = [...config];
      for (const options of battery(feature)) {
        for (const file of generate(options)) {
          if (seen.has(file.path) || typeof file.contents !== 'string') continue;
          seen.add(file.path);
          files.push({ variant: feature, path: file.path, contents: file.contents });
        }
      }
      expect(await lintFindings(files, feature)).toBe('');
    });
  }

  // The same axis one level up: `x new apple-co` emitted `{ add, AppleCoCurrencyMismatchError,
  // zero }` in the domain package's test, and Biome sorts `AppleCo…` first — a case tie on the
  // first letter, decided uppercase-first. `ledger-demo` above cannot see it.
  test('x new survives biome check for an app name that sorts before its own imports', async () => {
    const files = planNewApp({ name: 'apple-co', example: true }).flatMap((file) =>
      typeof file.contents === 'string'
        ? [{ variant: 'apple-co', path: file.path, contents: file.contents }]
        : [],
    );
    expect(files.length).toBeGreaterThan(0);
    expect(await lintFindings(files, 'apple-co')).toBe('');
  });
});

describe('unit · every generated test says what it pins before it imports', () => {
  // 41 of the 44 `<file>.test.ts` the generators write opened with an import, and the three that
  // did not (backfill, island, guard) had no principle in common. A scaffolded app's generated
  // tests are the model its agent copies, so the scaffold was teaching the exception: 70% of this
  // repo's own test files carry the 1–4 line header the conventions ask for. Enforced rather than
  // written down, because the 30% that do not are what an unenforced convention decays into.
  test('a generated <file>.test.ts opens with a comment', () => {
    const offenders = emitted()
      .filter((file) => /\.test\.tsx?$/.test(file.path) && !file.contents.startsWith('//'))
      .map((file) => at(file));
    expect(offenders).toEqual([]);
  });
});

describe('unit · every package a generated file imports is one the scaffold installs', () => {
  /**
   * The `X_TYPECHECK_FAILED` half no relative-import rule can see: `x g admin:page` and
   * `x g resource --admin` emit `import type { AdminResourceOptions } from '@ultimat3/admin'`, and
   * the scaffolded `package.json` never listed that package — so both generators wrote TS2307 into
   * an app whose `bun install` had already succeeded.
   */
  // `stripComments` is the `errors` step's own masker, not a second one: a doc comment showing an
  // app how to wire a file in is prose, and reading it as an edge reports a dependency nobody has.
  const bare = (contents: string): readonly string[] =>
    [...stripComments(contents).matchAll(/\bfrom\s+'([^'.][^']*)'/g)].flatMap(
      (match) => match[1] ?? [],
    );

  /** `@scope/name` or `name` — the specifier a `package.json` actually declares. */
  const packageOf = (specifier: string): string => {
    const parts = specifier.split('/');
    return specifier.startsWith('@') ? parts.slice(0, 2).join('/') : (parts[0] ?? specifier);
  };

  test('no generated file imports a package the scaffolded package.json does not declare', () => {
    const files = emitted().filter((file) => file.variant === 'x new');
    const manifest = files.find((file) => file.path === 'package.json')?.contents ?? '';
    expect(manifest).not.toBe('');
    const declared = new Set(
      [...manifest.matchAll(/"((?:@[^"/]+\/)?[^"@][^"]*)":\s*"[^"]*"/g)].flatMap(
        (match) => match[1] ?? [],
      ),
    );
    const offenders = files
      .filter((file) => /\.tsx?$/.test(file.path))
      .flatMap((file) =>
        bare(file.contents)
          .map(packageOf)
          // `node:`/`bun:` are the runtime's, and `@ledger-demo/...` is a tsconfig path alias
          // pointing back into this same app — neither is ever a dependency.
          .filter(
            (name) =>
              !name.startsWith('node:') &&
              !name.startsWith('bun:') &&
              !name.startsWith('@ledger-demo/') &&
              !declared.has(name),
          )
          .map((name) => `${at(file)} — ${name}`),
      );
    expect([...new Set(offenders)]).toEqual([]);
  });
});

describe('unit · every emitted fix: is one the generated app can run', () => {
  // The same two rules `checkErrorFixes` applies to this repo's own source, applied to the source
  // the generators write. `templates/action.ts` emitted a `fix:` citing `x db studio` — a PLANNED
  // subcommand that exits X_NOT_IMPLEMENTED — so every `x g action` wrote a fresh
  // X_ERROR_FIX_INVALID into the app it was scaffolding.
  test('no generated fix line is empty, advisory, or cites a command this build does not ship', async () => {
    const catalog = await loadCommandCatalog();
    const offenders = emitted()
      .filter((file) => /\.tsx?$/.test(file.path))
      .flatMap((file) =>
        scanFixes(file.contents, file.path).flatMap((site) => {
          const problem = fixProblem(site.fix) ?? citedCommandProblem(staticFix(site.fix), catalog);
          return problem === undefined ? [] : [`${at(file, site.line)} — ${problem}`];
        }),
      );
    expect(offenders).toEqual([]);
  });
});

describe('unit · the emitted biome config and the emitted biome dependency name one version', () => {
  /**
   * `''` when `x new` writes no such file. Deliberately not a throw: a missing fixture is this
   * test's own failure, not a condition an operator is ever handed, and it reads better as the
   * assertion below naming the file than as a stack out of a helper.
   */
  const rootFile = (name: string): string =>
    emitted().find((entry) => entry.path === name)?.contents ?? '';

  // A `$schema` pinned to one version beside a range that resolves to another is a config the
  // installed Biome reports as out of date on every run — and, once the two diverge far enough, a
  // rule set the app declared and the binary does not have. Pinned exactly, spelled once.
  test('biome.json names the version package.json installs', () => {
    const biome = rootFile('biome.json');
    const pkg = rootFile('package.json');
    // Named first, so a scaffold that stopped writing either file fails here rather than by
    // comparing one absent version against another and passing.
    expect({ 'biome.json': biome === '' }).toEqual({ 'biome.json': false });
    expect({ 'package.json': pkg === '' }).toEqual({ 'package.json': false });
    const schema = /schemas\/(?<version>[\d.]+)\/schema\.json/.exec(biome)?.groups?.['version'];
    const declared = /"@biomejs\/biome":\s*"(?<range>[^"]+)"/.exec(pkg)?.groups?.['range'];
    expect(schema).toBeDefined();
    expect(declared).toBe(schema as string);
  });
});
