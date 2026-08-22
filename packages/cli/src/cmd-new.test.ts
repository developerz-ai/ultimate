// The scaffolded app icon is the one source `@ultimat3/pwa` derives every install icon from. It
// has to be bytes `@ultimat3/core`'s image pipeline can actually decode — the pipeline reads PNG
// and JPEG only — so these tests pin the shape a silent regression would otherwise break quietly:
// an app that scaffolds with an icon nothing can ever turn into `/icons/icon-192.png`.

import { describe, expect, test } from 'bun:test';
// `node:fs`/`node:os` — Bun has no temp-directory API; `node:path` — no Bun path joiner.
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { decodeImage, probeImage } from '@ultimat3/core';
import type { NestedCatalog } from '@ultimat3/i18n';
import { catalogKeys, defineCatalogs, loadCatalog } from '@ultimat3/i18n';
import { BuiltinImagePipeline } from '@ultimat3/pwa';
import { renderHelp } from './cmd-help';
import { newCommand, planNewApp, writeNewApp } from './cmd-new';
import type { CommandContext } from './command';
import { MissingPositionalError } from './errors';
import { exec } from './exec';
import { MIGRATIONS_DIR } from './migrations';
import { parseArgs } from './parse';
import { SPECS } from './registry';
import { icon } from './templates/scaffold-icon';
import { belongsToType } from './test-select';
import { parseVerifyFloor, VERIFY_FLOOR_FILE } from './verify-floor';

/** The scaffolded bytes, proven to be bytes — `contents` is `string | Uint8Array`. */
function iconBytes(): Uint8Array {
  const file = planNewApp({ name: 'demo-app', example: false }).find(
    (candidate) => candidate.path === 'apps/web/site/icon.png',
  );
  expect(file).toBeDefined();
  const contents = file?.contents;
  expect(contents).toBeInstanceOf(Uint8Array);
  return contents instanceof Uint8Array ? contents : new Uint8Array();
}

describe('unit · x new · scaffolded icon', () => {
  test('emits apps/web/site/icon.png, never the old icon.svg', () => {
    const paths = planNewApp({ name: 'demo-app', example: false }).map((file) => file.path);
    expect(paths).toContain('apps/web/site/icon.png');
    expect(paths).not.toContain('apps/web/site/icon.svg');
  });

  // The load-bearing assertion: this is what proves the source icon is decodable by the pipeline
  // that @ultimat3/pwa feeds it through — a byte-for-byte guarantee `.svg` could never make.
  test('the icon is a real, pipeline-decodable 1024x1024 PNG', () => {
    const info = probeImage(iconBytes());
    expect(info.format).toBe('png');
    expect(info.width).toBe(1024);
    expect(info.height).toBe(1024);
  });

  // The end of the chain: scaffolded source -> pwa's pipeline -> the exact PNG the generated web
  // manifest names. A source the pipeline cannot decode fails here, not on an install nobody watches.
  test('the icon bytes survive a BuiltinImagePipeline resize to 192x192', async () => {
    const png = await new BuiltinImagePipeline().resize(iconBytes(), { size: 192, padding: 0.1 });
    expect(probeImage(png)).toMatchObject({ format: 'png', width: 192, height: 192 });
  });

  test('icon() is deterministic: the same bytes on every call', () => {
    expect(icon()).toEqual(icon());
  });

  // Enforced rather than commented (axiom 3). The CLI cannot reach `@ultimat3/ui`'s colour roles —
  // both are tier 5 — so the one honest placeholder is no colour at all: a grey level on all three
  // channels. A palette value pasted in here fails this test instead of surviving to a review.
  test('the mark is greyscale on a transparent canvas — no palette value to drift from', () => {
    const raster = decodeImage(iconBytes());
    const at = (x: number, y: number): readonly number[] => {
      const i = (y * raster.width + x) * 4;
      return [...raster.pixels.slice(i, i + 4)];
    };

    const [r, g, b, a] = at(raster.width / 2, raster.height / 2);
    expect([g, b]).toEqual([r, r]);
    expect(a).toBe(255);
    // The maskable safe zone stops short of the edge, so the corner is canvas, not mark.
    expect(at(0, 0)[3]).toBe(0);
  });
});

describe('unit · x new · x db gen is the only writer of packages/db/migrations', () => {
  // Two errors used to refuse each other on a pristine scaffold: `x db migrate` answered `X_DB_DRIFT`
  // naming `x db gen`, and `x db gen` answered `X_MIGRATION_SNAPSHOT_MISSING` for a sidecar nothing
  // had ever written. The condition cannot arise once the scaffold writes no migration at all —
  // `.sql`, `.snapshot.json` and `.hash` are written together, by one command, or not at all.
  test('it writes no migration and no hash sidecar', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'x-new-'));
    try {
      const written = await writeNewApp(dir, { name: 'demo-app', example: true });
      expect(written.files.filter((file) => file.startsWith(MIGRATIONS_DIR))).toEqual([]);
      // On disk as well as in the file list: the `.hash` was written past `planNewApp`, so it
      // appeared in no plan, no `--dry-run` and no test — which is how it outlived its own `.sql`.
      const migrations = join(dir, MIGRATIONS_DIR);
      expect(existsSync(migrations) ? readdirSync(migrations) : []).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // With no `.hash` on disk, `checkSourceDrift` is red until the author generates the first
  // migration — correct, and only useful if the scaffold's own next-steps line names the command
  // that clears it. Read off the rendered summary, not the catalog, so a message key that stops
  // being interpolated fails here too.
  // The finding was hand-built here — the right code, and a cause (`x new needs a name`) written
  // by hand beside the class that writes one. `MissingPositionalError` is the one declaration of
  // what a missing positional says, so the refusal is the class and never a copy of its output.
  test('no name is MissingPositionalError, not a hand-assembled finding', async () => {
    const ctx: CommandContext = {
      args: parseArgs(['new'], SPECS),
      cwd: tmpdir(),
      runner: exec,
      env: {},
      bunVersion: '1.3.0',
    };
    const thrown: unknown = await newCommand.run(ctx).then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(thrown).toBeInstanceOf(MissingPositionalError);
    const error = thrown as MissingPositionalError;
    expect(error.code).toBe('X_CLI_BAD_FLAG');
    expect(error.cause).toBe('"x new" needs a <name> positional and got none');
    expect(error.fix).toBe('x new myapp');
  });

  test('its next-steps summary names x db gen "initial"', async () => {
    const ctx: CommandContext = {
      args: parseArgs(['new', 'demo-app', '--dry-run'], SPECS),
      cwd: tmpdir(),
      runner: exec,
      env: {},
      bunVersion: '1.3.0',
    };
    const result = await newCommand.run(ctx);
    expect(result.ok).toBe(true);
    expect(result.summary).toContain('x db gen "initial"');
  });
});

/** The scaffolded catalog for one variant, as a string — `contents` is `string | Uint8Array`. */
function catalogSource(example: boolean): string {
  const file = planNewApp({ name: 'demo-app', example }).find(
    (candidate) => candidate.path === 'packages/i18n/catalogs/en.json',
  );
  const contents = file?.contents;
  expect(typeof contents).toBe('string');
  return typeof contents === 'string' ? contents : '';
}

describe('unit · x new · scaffolded catalog', () => {
  // The catalog `x new` writes is the one `defineCatalogs` loads at the app's first boot. When it
  // was authored flat (`"site.home.title"`), that boot threw X_CATALOG_INVALID — a dot is not a
  // key segment — and nothing here noticed, because every assertion read the JSON directly rather
  // than through the loader. These go through the loader.
  for (const example of [false, true]) {
    test(`--${example ? 'example' : 'no-example'} scaffolds a catalog defineCatalogs accepts`, () => {
      const en = JSON.parse(catalogSource(example)) as unknown;
      const catalogs = defineCatalogs({ default: 'en', locales: { en: en as NestedCatalog } });
      expect(catalogKeys(catalogs.catalogs.en ?? {})).toContain('site.home.title');
    });
  }

  test('the example slice and the scaffold both land in it, under the same top-level key', () => {
    const keys = catalogKeys(loadCatalog(JSON.parse(catalogSource(true))));
    expect(keys).toContain('app.dashboard.title');
    expect(keys).toContain('app.post.empty');
  });
});

/** One emitted file's text, whichever variant wrote it — `contents` is `string | Uint8Array`. */
function emitted(path: string, example: boolean): string {
  const file = planNewApp({ name: 'demo-app', example }).find(
    (candidate) => candidate.path === path,
  );
  const contents = file?.contents;
  expect(typeof contents).toBe('string');
  return typeof contents === 'string' ? contents : '';
}

describe('unit · x new · the suite floor the app is gated on', () => {
  // `X_VERIFY_SUITE_VANISHED` was unreachable in every generated app: no scaffold wrote a floor,
  // `readVerifyFloor` answers "no file is no floor", and a deleted suite turns its step from green
  // into skipped-and-green. The scaffold has to commit the claim, because it is the only party
  // that knows which steps the app it just wrote can actually run.
  for (const example of [false, true]) {
    test(`--${example ? 'example' : 'no-example'} writes a floor of steps the gate runs`, () => {
      const floor = parseVerifyFloor(emitted(VERIFY_FLOOR_FILE, example));
      expect(floor.problems).toEqual([]);
      expect(floor.steps).toContain('unit');
      expect(floor.steps).toContain('typecheck');
      expect(floor.steps).toContain('manifest');
    });

    // Derived, not restated: a floor naming a suite the scaffold ships no file for pins a step
    // that can never apply, which holds the app's first gate red forever. `eval` is not in the
    // list because it is the one step that applies with no suite of its own — every prompt must
    // have an eval, and an app with neither still has that question answered.
    test(`--${example ? 'example' : 'no-example'} names no typed suite it ships no file for`, () => {
      const files = planNewApp({ name: 'demo-app', example });
      const floor = parseVerifyFloor(emitted(VERIFY_FLOOR_FILE, example));
      for (const type of ['contract', 'live', 'job', 'e2e'] as const) {
        if (!floor.steps.includes(type)) continue;
        expect(files.some((file) => belongsToType(file.path, type))).toBe(true);
      }
    });
  }

  // The other half of the same rule: a suite the scaffold DOES ship a file for must be pinned, or
  // a generator that renames its test back to `<name>.test.ts` silently empties the step and the
  // gate stays green. `contract` is in both variants (the health action's), `live` and `job` come
  // with the example slice.
  test('it pins every typed suite the variant ships a file for', () => {
    for (const example of [false, true]) {
      const floor = parseVerifyFloor(emitted(VERIFY_FLOOR_FILE, example));
      const files = planNewApp({ name: 'demo-app', example });
      for (const type of ['contract', 'live', 'job'] as const) {
        if (!files.some((file) => belongsToType(file.path, type))) continue;
        expect([example, type, floor.steps.includes(type)]).toEqual([example, type, true]);
      }
    }
  });

  // `e2eTest` is `test.skip` until an app registers a browser driver, so the scaffolded
  // `page.e2e.test.ts` runs zero tests — a floor naming `e2e` would fail `x verify` on the
  // scaffold's own placeholder rather than on anything the author did.
  test('it does not pin e2e, whose scaffolded test skips itself until a driver exists', () => {
    expect(parseVerifyFloor(emitted(VERIFY_FLOOR_FILE, true)).steps).not.toContain('e2e');
  });
});

describe('unit · x new · writing into the parent directory', () => {
  const newContext = (argv: readonly string[], cwd: string): CommandContext => ({
    args: parseArgs(argv, SPECS),
    cwd,
    runner: exec,
    env: {},
    bunVersion: '1.3.0',
  });

  test('the app lands under <parent>/<kebab-name>, and the report counts what it wrote', async () => {
    const parent = mkdtempSync(join(tmpdir(), 'x-new-run-'));
    try {
      // A name that is NOT already kebab: the directory is the kebab form, never the argument.
      const result = (await newContext(['new', 'Demo App'], parent)) satisfies CommandContext;
      const written = await newCommand.run(result);
      expect(written.ok).toBe(true);
      const target = join(parent, 'demo-app');
      const data = written.data as { dir: string; files: readonly string[] };
      expect(data.dir).toBe(target);
      expect(existsSync(join(target, 'app.config.ts'))).toBe(true);
      // Every planned file is on disk, and the plan is what the report names.
      expect(data.files).toEqual(
        planNewApp({ name: 'Demo App', example: true }).map((f) => f.path),
      );
      expect(written.lines).toEqual([`  ${data.files.length} files in ${target}`]);
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  }, 30_000);

  test('a directory that already exists is refused with --force as the fix, and writes nothing', async () => {
    const parent = mkdtempSync(join(tmpdir(), 'x-new-run-'));
    try {
      const target = join(parent, 'demo-app');
      await Bun.write(join(target, 'KEEP.txt'), 'do not overwrite me');
      const result = await newCommand.run(newContext(['new', 'demo-app'], parent));
      expect(result.ok).toBe(false);
      const finding = result.findings?.[0];
      expect(finding?.code).toBe('X_GENERATE_CONFLICT');
      expect(finding?.cause).toBe(`${target} already exists`);
      expect(finding?.fix).toBe('x new demo-app --force, or choose another name');
      expect(finding?.at).toBe(target);
      // Refused BEFORE writing: nothing but the file the test put there.
      expect(readdirSync(target)).toEqual(['KEEP.txt']);
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  });

  test('--force writes into the directory that was refused', async () => {
    const parent = mkdtempSync(join(tmpdir(), 'x-new-run-'));
    try {
      const target = join(parent, 'demo-app');
      await Bun.write(join(target, 'KEEP.txt'), 'kept');
      const result = await newCommand.run(newContext(['new', 'demo-app', '--force'], parent));
      expect(result.ok).toBe(true);
      expect(existsSync(join(target, 'app.config.ts'))).toBe(true);
      // --force adds; it does not clear the directory first.
      expect(existsSync(join(target, 'KEEP.txt'))).toBe(true);
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  }, 30_000);

  test('--dir is resolved against the cwd when it is relative, and taken whole when absolute', async () => {
    const parent = mkdtempSync(join(tmpdir(), 'x-new-run-'));
    try {
      const relative = await newCommand.run(
        newContext(['new', 'demo-app', '--dir', 'nested', '--dry-run'], parent),
      );
      expect((relative.data as { dir: string }).dir).toBe(join(parent, 'nested', 'demo-app'));
      const absolute = await newCommand.run(
        newContext(['new', 'demo-app', '--dir', parent, '--dry-run'], tmpdir()),
      );
      expect((absolute.data as { dir: string }).dir).toBe(join(parent, 'demo-app'));
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  });
});

// `registerActions` and `registerQueries` run on the framework's own module scan; NOTHING registers
// a job that way. A job module no `defineApi` hands over keeps the positional name `job()` gave it
// — measured in a scaffolded app: `x manifest --json` reported `counts.jobs: 2` and named one of
// them `anonymous-job-2`, in `x.manifest.json`, on the queue row and in every dead-letter trace.
describe('unit · x new · the API surface registers the app own primitives by name', () => {
  const apiIndex = (example: boolean): string => emitted('apps/web/api/index.ts', example);

  /** Every relative specifier the file imports, as the repo path it resolves to. */
  const importedPaths = (source: string): readonly string[] =>
    [...source.matchAll(/from '(\.[^']+)'/g)].map(
      (match) => `${join('apps/web/api', match[1] ?? '')}.ts`,
    );

  for (const example of [false, true]) {
    test(`--${example ? 'example' : 'no-example'} declares its surface through defineApi`, () => {
      expect(apiIndex(example)).toContain("import { defineApi } from '@ultimat3/action';");
      expect(apiIndex(example)).toContain('export const api = defineApi({');
    });

    // A specifier that resolves to nothing is TS2307 in an app whose `bun install` succeeded.
    test(`--${example ? 'example' : 'no-example'} imports only modules the scaffold writes`, () => {
      const paths = planNewApp({ name: 'demo-app', example }).map((file) => file.path);
      const imported = importedPaths(apiIndex(example));
      expect(imported.length).toBeGreaterThan(0);
      for (const path of imported) expect([path, paths.includes(path)]).toEqual([path, true]);
    });
  }

  test('every job module the example slice writes is handed to defineApi', () => {
    const paths = planNewApp({ name: 'demo-app', example: true }).map((file) => file.path);
    const jobs = paths.filter(
      (path) => path.includes('/jobs/') && path.endsWith('.ts') && !path.includes('.test.'),
    );
    expect(jobs.length).toBeGreaterThan(0);
    const imported = importedPaths(apiIndex(true));
    for (const job of jobs) expect([job, imported.includes(job)]).toEqual([job, true]);
    // Handed over as JOBS: `actions: [reindexPost]` would register nothing and read as correct.
    const list = /jobs: \[(?<names>[^\]]*)\]/.exec(apiIndex(true))?.groups?.['names'] ?? '';
    expect(list.split(',').map((entry) => entry.trim())).toContain('reindexPost');
  });
});

/**
 * `x new --help` used to contradict itself: the usage line offered `--no-example`, the flag table
 * listed `--example`, and neither said which way the scaffold goes when you type neither. The
 * example slice is 126 files against 99, so "which one do I get" is the first question the page has
 * to answer — and `default: true` is a field only `--json` renders.
 */
describe('unit · x new --help states the default it scaffolds with', () => {
  test('the example flag names its default and the spelling that turns it off', () => {
    const flag = newCommand.spec.flags?.find((entry) => entry.name === 'example');
    expect(flag?.default).toBe(true);
    expect(flag?.summary).toContain('--no-example');
    expect(flag?.summary).toContain('default');
    // The rendered page carries both spellings on one line, so a reader never has to reconcile
    // the usage line with the flag table.
    const line = renderHelp(SPECS, 'new').find((entry) => entry.includes('--example'));
    expect(line).toBeDefined();
    expect(line).toContain('--no-example');
  });

  test('and the flag still decides what is written', () => {
    const withExample = planNewApp({ name: 'demo', example: true }).length;
    const without = planNewApp({ name: 'demo', example: false }).length;
    expect(withExample).toBeGreaterThan(without);
  });
});
