#!/usr/bin/env bun

// Enforce ONE spelling per factory every package's public entry exports: `memoryX` / `postgresX`
// for the in-process and Postgres implementations, `<what it builds>()` for everything else.
// `create(Memory|Pg|Postgres)X`, `pgX` and any `create<Thing>` export are findings; so is an
// exported `(In)Memory|Pg|Postgres` CLASS, and a class exported as a VALUE beside a factory that
// returns its seam (the factory is the value, the class a type only); so is one value name declared
// by two packages.
//
// THE DEFECT THIS EXISTS FOR. 24.x shipped both spellings side by side — `memoryAuditLog` and
// `postgresAuditLog` in admin, `memoryRateLimitStore` in http, beside `createMemoryDriver`,
// `createPgDriver`, `createPgInboxStore` and `pgSchedulerState` in jobs, mail and notify — so an
// agent guessing a factory's name guessed wrong half the time (axiom 1). The first cut of this rule
// read only camelCase and so missed `new MemoryIdempotencyStore()` beside
// `postgresIdempotencyStore()`, `PgVectorStore`, `MemoryAdapter` and mail's `createSmtpDriver`
// beside `memoryMailDriver`: the same two-spellings defect, one case away. The second read only the
// memory / Postgres prefixes, and so missed `new AnthropicProvider()` beside `openAiProvider()`,
// `createPgliteClient()` beside `postgresClient()`, and `cacheKeyFor` meaning a prompt's key in
// `@ultimat3/ai` and a query's in `@ultimat3/query`.
//
// WHAT IS READ. Every `exports` target of every `packages/*/package.json` and of
// `create-ultimate` — `src/index.ts` and each subpath (`@ultimat3/admin/schema`, …), because a
// subpath is as public as the barrel. Names come from `Bun.Transpiler#scan`, so `export type` is
// already gone (a type is not a factory — `export type { MemoryVectorStore }` is how a class stays
// nameable) and `export { a as createPgX }` is caught as `createPgX`. What each name IS — a class,
// what it implements, what a function returns, whether the package declares it or re-exports it —
// comes from the package's own top-level declarations (`factory-names-declarations.ts`).
//
// WHAT THIS CANNOT SEE. The rule is about SPELLING: a factory called `makeInMemoryQueue` matches
// nothing here. `Pg` followed by a lower-case letter is a word (PGlite is a product, not
// "Postgres"), so the prefix must be followed by an upper-case letter or a digit. `PGLITE_MEMORY`
// is a constant, not `Pg…`. A PascalCase value with one of these prefixes is flagged whatever it
// is, deliberately — it reads as a class. A class beside a factory is seen only when the factory
// DECLARES its return type, and a re-export of another package's binding is the same binding — not
// a second meaning; a second import PATH for one binding is a different defect, and core's is
// `flight-copies`' (`lib/core-reexports.ts`).
//
// Pinned at ZERO, enforcing outright: `scripts/factory-names.test.ts` asserts the real tree. A
// genuine exception, or a rename another package owes, is a row in `factory-names-pins.ts` with
// its sentence; a row that matches no finding is a finding, so the table only shrinks.
//
//   bun run scripts/factory-names.ts [--json]

// why: Bun exposes no path-join primitive; Bun.file and import() take one already joined.
import { join } from 'node:path';
// The leaf module, never the `@ultimat3/core` barrel: a guard must not link the whole tree.
import { renderFixShellArg } from '../packages/core/src/error-render';
import type { Declaration } from './factory-names-declarations';
import { readDeclarations } from './factory-names-declarations';
import type { FactoryNamePins } from './factory-names-pins';
import { FACTORY_NAME_PINS, NO_PINS } from './factory-names-pins';
import { parseScriptArgs } from './lib/args';
import type { Finding } from './lib/log';
import { report } from './lib/log';
import { repoRoot } from './lib/run';

const SCRIPT = 'factory-names';
export const CODE = 'X_FACTORY_NAME_SPELLING';

/** `createMemoryX`, `createPgX`, `createPostgresX` and `pgX` — the spellings 25.0.0 deleted. */
const RETIRED = /^(?:create(Memory|Pg|Postgres)|(pg))(?=[A-Z0-9])(.*)$/;

/** An exported class (or any PascalCase value): `MemoryX`, `InMemoryX`, `PgX`, `PostgresX`. */
const CLASS = /^(?:In)?(Memory|Pg|Postgres)(?=[A-Z0-9])(.*)$/;

/** `createSmtpDriver` — the vendor transport is a value named for what it builds. */
const CREATE_DRIVER = /^create([A-Z]\w*)Driver$/;

/** `createGateway` — a factory is named for what it builds, never for the act of building. */
const CREATE = /^create([A-Z0-9]\w*)$/;

type Kind = 'factory' | 'class' | 'driver' | 'create' | 'seam';

interface Retired {
  readonly kind: Kind;
  readonly canonical: string;
}

const lowerFirst = (word: string): string => `${word.charAt(0).toLowerCase()}${word.slice(1)}`;

function retired(name: string): Retired | undefined {
  const factory = RETIRED.exec(name);
  if (factory !== null) {
    const prefix = factory[1] === 'Memory' ? 'memory' : 'postgres';
    return { kind: 'factory', canonical: `${prefix}${factory[3] ?? ''}` };
  }
  const cls = CLASS.exec(name);
  if (cls !== null) {
    const prefix = cls[1] === 'Memory' ? 'memory' : 'postgres';
    return { kind: 'class', canonical: `${prefix}${cls[2] ?? ''}` };
  }
  const driver = CREATE_DRIVER.exec(name);
  if (driver !== null) return { kind: 'driver', canonical: `${lowerFirst(driver[1] ?? '')}Driver` };
  const create = CREATE.exec(name);
  if (create !== null) return { kind: 'create', canonical: lowerFirst(create[1] ?? '') };
  return undefined;
}

/** The one spelling a retired name collapses to, so the finding can name the edit. */
export function canonicalName(name: string): string | undefined {
  return retired(name)?.canonical;
}

export interface EntryModule {
  /** Repo-relative path of the module a package.json `exports` entry points at. */
  readonly at: string;
  /** The specifier an app imports it by (`@ultimat3/jobs`, `@ultimat3/admin/schema`). */
  readonly specifier: string;
  readonly text: string;
  /**
   * The PACKAGE's top-level declarations (`factory-names-declarations.ts`). Absent, every export
   * reads as the package's own value and no class is known — the reading that flags more.
   */
  readonly declarations?: ReadonlyMap<string, Declaration>;
}

const transpiler = new Bun.Transpiler({ loader: 'tsx' });

const WHY: Readonly<Record<Kind, string>> = {
  factory:
    'a memory or Postgres factory is named memoryX / postgresX and nothing else, so an agent never has to guess which of two spellings a package chose',
  class:
    'a memory or Postgres implementation is built by a memoryX() / postgresX() factory and its class is not a public value, so `new MemoryX()` beside `postgresX()` is never a second spelling',
  driver:
    'a vendor transport is a <vendor><Thing>Driver() factory (smtpMailDriver, memoryJobDriver), never create<Vendor>Driver beside a memoryXDriver',
  create:
    'a factory is named for what it builds (openAiProvider, postgresClient, memoryVectorStore), never create<Thing>, so an agent guessing a factory never has to guess which of two conventions a package chose',
  seam: 'an implementation is built by its factory and its class is not a public value, so `new X()` beside a sibling factory is never a second way to build one seam',
};

/** `@ultimat3/admin/schema` → `@ultimat3/admin`: a subpath re-exporting its own barrel is one package. */
const packageOf = (specifier: string): string =>
  specifier
    .split('/')
    .slice(0, specifier.startsWith('@') ? 2 : 1)
    .join('/');

/** A finding plus the key a pin names it by. */
interface Keyed {
  readonly key: string;
  readonly finding: Finding;
}

function fixFor(name: string, found: Retired, at: string): string {
  const grep = `git grep -nw ${renderFixShellArg(name, '<the export>')}`;
  const rename = `rename ${name} to ${found.canonical} at every hit, its declaration and ${at} included`;
  if (found.kind === 'class' || found.kind === 'seam') {
    return `${grep}   # ${rename}: add \`export function ${found.canonical}(…): ${name}\` beside the class, keep the class exported from its own module, and export it from ${at} as \`export type { ${name} }\`; a caller's \`new ${name}(…)\` becomes \`${found.canonical}(…)\`, an in-package \`extends\` imports the module`;
  }
  if (found.kind === 'driver') {
    return `${grep}   # ${rename} — or, naming what it builds, ${found.canonical.replace(/Driver$/, '')}<Thing>Driver (smtpMailDriver)`;
  }
  if (found.kind === 'create') {
    return `${grep}   # ${rename}; a caller's \`const clock = createTestClock()\` becomes \`const clock = testClock()\`, and where ${found.canonical} would shadow the caller's own variable or another package's export, qualify it after the variant it builds (scrapePacer, not pacer)`;
  }
  return `${grep}   # ${rename}; if ${found.canonical} collides with another package's export, name the thing it builds (memoryJobDriver, not memoryDriver)`;
}

const finding = (entry: EntryModule, name: string, found: Retired, why: string): Keyed => ({
  key: `${packageOf(entry.specifier)} ${name}`,
  finding: {
    code: CODE,
    cause: `${entry.specifier} exports ${name} (${entry.at}), ${why}`,
    fix: fixFor(name, found, entry.at),
    at: entry.at,
  },
});

const exportsOf = (entry: EntryModule): readonly string[] => transpiler.scan(entry.text).exports;

function retiredKeyed(entry: EntryModule): readonly Keyed[] {
  const found: Keyed[] = [];
  for (const name of exportsOf(entry)) {
    const spelled = retired(name);
    if (spelled === undefined) continue;
    found.push(finding(entry, name, spelled, `a spelling 25.0.0 retired: ${WHY[spelled.kind]}`));
  }
  return found;
}

export function retiredExports(entry: EntryModule): readonly Finding[] {
  return retiredKeyed(entry).map((one) => one.finding);
}

/**
 * An error class is not a seam: `instanceof` is how a caller tells failures apart and `extends` is
 * how every package declares one (root `CLAUDE.md`: subclass `UltimateError`), so the class IS the
 * public value and a builder returning one is a message, not a second way to construct a seam.
 */
const isErrorClass = (name: string): boolean => /Error$/.test(name);

/**
 * A class exported as a VALUE by a package that also exports a camelCase factory DECLARED to return
 * that class or an interface the class implements: `AnthropicProvider implements Provider` beside
 * `openAiProvider(): Provider`. Structural, not lexical — `NatsTransport` beside `selectTransport():
 * TransportSelection` is two seams, and a shared suffix proves nothing.
 */
function classesBesideFactories(entries: readonly EntryModule[]): readonly Keyed[] {
  const byPackage = new Map<string, EntryModule[]>();
  for (const entry of entries) {
    const pkg = packageOf(entry.specifier);
    byPackage.set(pkg, [...(byPackage.get(pkg) ?? []), entry]);
  }
  const found: Keyed[] = [];
  for (const group of byPackage.values()) {
    const declarations = group[0]?.declarations;
    if (declarations === undefined) continue;
    const factories = new Map<string, string>();
    for (const name of new Set(group.flatMap(exportsOf))) {
      const returns = declarations.get(name)?.returns;
      if (/^[a-z]/.test(name) && returns !== undefined && !factories.has(returns)) {
        factories.set(returns, name);
      }
    }
    for (const entry of group) {
      for (const name of exportsOf(entry)) {
        const declared = declarations.get(name);
        if (declared?.kind !== 'class' || isErrorClass(name) || retired(name) !== undefined)
          continue;
        const seam = [name, ...declared.implements].find((type) => factories.has(type));
        if (seam === undefined) continue;
        const factory = factories.get(seam) ?? '';
        const why = `a class VALUE while ${factory}() returns ${seam}: ${WHY.seam}`;
        found.push(finding(entry, name, { kind: 'seam', canonical: lowerFirst(name) }, why));
      }
    }
  }
  return found;
}

/** A package.json `exports` value: a path, or a condition map whose leaves are paths. */
function exportTargets(value: unknown): readonly string[] {
  if (typeof value === 'string') return [value];
  if (value === null || typeof value !== 'object') return [];
  return Object.values(value).flatMap(exportTargets);
}

const isSource = (path: string): boolean => /\.tsx?$/.test(path) && !path.endsWith('.d.ts');

export async function readEntryModules(root: string): Promise<readonly EntryModule[]> {
  const manifests = [
    ...new Bun.Glob('packages/*/package.json').scanSync({ cwd: root }),
    'create-ultimate/package.json',
  ].sort();
  const entries: EntryModule[] = [];
  for (const manifest of manifests) {
    const file = Bun.file(join(root, manifest));
    if (!(await file.exists())) continue;
    const parsed: unknown = await file.json();
    if (parsed === null || typeof parsed !== 'object') continue;
    const name = 'name' in parsed && typeof parsed.name === 'string' ? parsed.name : manifest;
    const exportsField = 'exports' in parsed ? parsed.exports : undefined;
    const dir = manifest.slice(0, -'/package.json'.length);
    const declarations = await readDeclarations(root, dir);
    const map: Record<string, unknown> =
      typeof exportsField === 'string'
        ? { '.': exportsField }
        : exportsField !== null && typeof exportsField === 'object'
          ? { ...exportsField }
          : {};
    for (const [subpath, value] of Object.entries(map)) {
      for (const target of new Set(exportTargets(value))) {
        if (!isSource(target)) continue;
        const at = join(dir, target);
        const source = Bun.file(join(root, at));
        if (!(await source.exists())) continue;
        const specifier = subpath === '.' ? name : `${name}/${subpath.replace(/^\.\//, '')}`;
        entries.push({ at, specifier, text: await source.text(), declarations });
      }
    }
  }
  return entries;
}

/** A pin row that silences nothing: the rename landed, or the exception no longer holds. */
function stalePins(pins: FactoryNamePins, keys: ReadonlySet<string>): readonly Finding[] {
  const rows = [
    ...Object.keys(pins.exceptions).map((key) => ['exceptions', key] as const),
    ...Object.keys(pins.owed).map((key) => ['owed', key] as const),
  ];
  return rows
    .filter(([, key]) => !keys.has(key))
    .map(([table, key]) => ({
      code: CODE,
      cause: `factory-names-pins.ts ${table} row ${JSON.stringify(key)} matches no finding: the rename landed or the exception no longer holds, and a stale row would silence the next export of that name`,
      fix: `bun run scripts/factory-names.ts --json   # after deleting the ${JSON.stringify(key)} row from ${table} in scripts/factory-names-pins.ts`,
      at: 'scripts/factory-names-pins.ts',
    }));
}

export function checkFactoryNames(
  entries: readonly EntryModule[],
  pins: FactoryNamePins = NO_PINS,
): readonly Finding[] {
  if (!entries.some((entry) => entry.at === 'packages/jobs/src/index.ts')) {
    return [
      {
        code: CODE,
        cause:
          'packages/jobs/src/index.ts was not among the entry modules read, so every retired spelling would have read as absent',
        fix: 'bun run scripts/factory-names.ts --json   # from the repository root; if package.json exports moved, update readEntryModules in scripts/factory-names.ts',
        at: 'scripts/factory-names.ts',
      },
    ];
  }
  const keyed = [
    ...entries.flatMap(retiredKeyed),
    ...classesBesideFactories(entries),
    ...sharedNamesKeyed(entries),
  ];
  const pinned = (key: string): boolean =>
    Object.hasOwn(pins.exceptions, key) || Object.hasOwn(pins.owed, key);
  return [
    ...keyed.filter((one) => !pinned(one.key)).map((one) => one.finding),
    ...stalePins(pins, new Set(keyed.map((one) => one.key))),
  ];
}

/**
 * One value name DECLARED by two packages and exported from both. `memoryDriver` was both
 * `@ultimat3/entity`'s and `@ultimat3/storage`'s, so a test wiring a database and a disk aliased
 * one of them by hand; `cacheKeyFor` was a prompt's key in `@ultimat3/ai` and a query's in
 * `@ultimat3/query`, and `NO_TENANT` was `''` in one package and `'global'` in another. A
 * re-export of another package's binding declares nothing, so it is not counted here.
 */
function sharedNamesKeyed(entries: readonly EntryModule[]): readonly Keyed[] {
  const owners = new Map<string, Map<string, EntryModule>>();
  for (const entry of entries) {
    for (const name of exportsOf(entry)) {
      if (entry.declarations !== undefined && !entry.declarations.has(name)) continue;
      const byPackage = owners.get(name) ?? new Map<string, EntryModule>();
      const pkg = packageOf(entry.specifier);
      if (!byPackage.has(pkg)) byPackage.set(pkg, entry);
      owners.set(name, byPackage);
    }
  }
  const found: Keyed[] = [];
  for (const [name, byPackage] of owners) {
    if (byPackage.size < 2) continue;
    const packages = [...byPackage.keys()].sort();
    const listed = `${packages.slice(0, -1).join(', ')} and ${packages.at(-1) ?? ''}`;
    for (const pkg of packages) {
      const entry = byPackage.get(pkg);
      if (entry === undefined) continue;
      found.push({
        key: `${packages.join(' + ')} ${name}`,
        finding: {
          code: CODE,
          cause: `${listed} both export ${name} (${entry.at}): one name declared by two packages means a file importing both aliases one by hand, and an agent cannot tell from the name which thing it is`,
          fix: `git grep -nw ${renderFixShellArg(name, '<the export>')}   # in every package but the lowest-tier one, rename ${name} after what it is there (memoryStorageDriver for a MemoryStorageDriver, promptCacheKey for a prompt's cache key), its declaration and ${entry.at} included; if the two are one thing, delete the copy and import the lower tier's`,
          at: entry.at,
        },
      });
    }
  }
  return found;
}

if (import.meta.main) {
  const args = parseScriptArgs(Bun.argv.slice(2));
  const entries = await readEntryModules(repoRoot());
  const findings = checkFactoryNames(entries, FACTORY_NAME_PINS);
  report(
    {
      ok: findings.length === 0,
      script: SCRIPT,
      summary:
        findings.length === 0
          ? `every factory across ${String(entries.length)} public entry module(s) is spelled memoryX / postgresX / <what it builds>, no class beside its factory, no name declared twice`
          : `${String(findings.length)} export(s) spelled create<Thing>, create(Memory|Pg|Postgres)X or pgX, a class value beside its factory, a name two packages declare, or a stale pin`,
      findings,
      data: { entries: entries.map((entry) => entry.at) },
    },
    args.json,
  );
}
