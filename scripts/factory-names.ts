#!/usr/bin/env bun

// Enforce ONE spelling for the memory / Postgres factories every package's public entry exports:
// `memoryX` and `postgresX`. A `create(Memory|Pg|Postgres)X` or a `pgX` export is a finding; so is
// an exported `(In)Memory|Pg|Postgres` CLASS (the factory is the value, the class a type only) and
// a `create<Vendor>Driver` (a driver is named for what it is: `smtpMailDriver`).
//
// THE DEFECT THIS EXISTS FOR. 24.x shipped both spellings side by side — `memoryAuditLog` and
// `postgresAuditLog` in admin, `memoryRateLimitStore` in http, beside `createMemoryDriver`,
// `createPgDriver`, `createPgInboxStore` and `pgSchedulerState` in jobs, mail and notify — so an
// agent guessing a factory's name guessed wrong half the time (axiom 1). The first cut of this rule
// read only camelCase and so missed `new MemoryIdempotencyStore()` beside
// `postgresIdempotencyStore()`, `PgVectorStore`, `MemoryAdapter` and mail's `createSmtpDriver`
// beside `memoryMailDriver`: the same two-spellings defect, one case away.
//
// WHAT IS READ. Every `exports` target of every `packages/*/package.json` and of
// `create-ultimate` — `src/index.ts` and each subpath (`@ultimat3/admin/schema`, …), because a
// subpath is as public as the barrel. Names come from `Bun.Transpiler#scan`, so `export type` is
// already gone (a type is not a factory — `export type { MemoryVectorStore }` is how a class stays
// nameable) and `export { a as createPgX }` is caught as `createPgX`.
//
// WHAT THIS CANNOT SEE. The rule is about SPELLING: a factory called `makeInMemoryQueue` matches
// nothing here. `Pg` followed by a lower-case letter is a word (`createPgliteClient` names PGlite,
// a product, not "Postgres"), so the prefix must be followed by an upper-case letter or a digit.
// `PGLITE_MEMORY` is a constant, not `Pg…`. A PascalCase value is read as a class; a PascalCase
// non-class value with one of these prefixes is flagged too, deliberately — it reads as one.
//
// A canonical `memoryX` / `postgresX` exported by TWO packages is a finding too (`sharedFactoryNames`).
//
// Pinned at ZERO, enforcing outright: `scripts/factory-names.test.ts` asserts the real tree.
//
//   bun run scripts/factory-names.ts [--json]

// why: Bun exposes no path-join primitive; Bun.file and import() take one already joined.
import { join } from 'node:path';
// The leaf module, never the `@ultimat3/core` barrel: a guard must not link the whole tree.
import { renderFixShellArg } from '../packages/core/src/error-render';
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

type Kind = 'factory' | 'class' | 'driver';

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
}

const transpiler = new Bun.Transpiler({ loader: 'tsx' });

const WHY: Readonly<Record<Kind, string>> = {
  factory:
    'a memory or Postgres factory is named memoryX / postgresX and nothing else, so an agent never has to guess which of two spellings a package chose',
  class:
    'a memory or Postgres implementation is built by a memoryX() / postgresX() factory and its class is not a public value, so `new MemoryX()` beside `postgresX()` is never a second spelling',
  driver:
    'a vendor transport is a <vendor><Thing>Driver() factory (smtpMailDriver, memoryJobDriver), never create<Vendor>Driver beside a memoryXDriver',
};

function fixFor(name: string, found: Retired, at: string): string {
  const grep = `git grep -nw ${renderFixShellArg(name, '<the export>')}`;
  const rename = `rename ${name} to ${found.canonical} at every hit, its declaration and ${at} included`;
  if (found.kind === 'class') {
    return `${grep}   # ${rename}: add \`export function ${found.canonical}(…): ${name}\` beside the class, keep the class exported from its own module, and export it from ${at} as \`export type { ${name} }\`; a caller's \`new ${name}(…)\` becomes \`${found.canonical}(…)\`, an in-package \`extends\` imports the module`;
  }
  if (found.kind === 'driver') {
    return `${grep}   # ${rename} — or, naming what it builds, ${found.canonical.replace(/Driver$/, '')}<Thing>Driver (smtpMailDriver)`;
  }
  return `${grep}   # ${rename}; if ${found.canonical} collides with another package's export, name the thing it builds (memoryJobDriver, not memoryDriver)`;
}

export function retiredExports(entry: EntryModule): readonly Finding[] {
  const findings: Finding[] = [];
  for (const name of transpiler.scan(entry.text).exports) {
    const found = retired(name);
    if (found === undefined) continue;
    findings.push({
      code: CODE,
      cause: `${entry.specifier} exports ${name} (${entry.at}), a spelling 25.0.0 retired: ${WHY[found.kind]}`,
      fix: fixFor(name, found, entry.at),
      at: entry.at,
    });
  }
  return findings;
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
        entries.push({ at, specifier, text: await source.text() });
      }
    }
  }
  return entries;
}

export function checkFactoryNames(entries: readonly EntryModule[]): readonly Finding[] {
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
  return [...entries.flatMap(retiredExports), ...sharedFactoryNames(entries)];
}

/** `memoryX` / `postgresX` — the canonical spelling, which must also be unique across packages. */
const FACTORY = /^(?:memory|postgres)(?=[A-Z0-9])/;

/** `@ultimat3/admin/schema` → `@ultimat3/admin`: a subpath re-exporting its own barrel is one package. */
const packageOf = (specifier: string): string =>
  specifier
    .split('/')
    .slice(0, specifier.startsWith('@') ? 2 : 1)
    .join('/');

/**
 * One factory name exported by two PACKAGES. `memoryDriver` was both `@ultimat3/entity`'s and
 * `@ultimat3/storage`'s, so a test wiring a database and a disk aliased one of them by hand — the
 * collision the canonical spelling cannot see on its own, because both halves are spelled right.
 */
export function sharedFactoryNames(entries: readonly EntryModule[]): readonly Finding[] {
  const owners = new Map<string, Map<string, EntryModule>>();
  for (const entry of entries) {
    for (const name of transpiler.scan(entry.text).exports) {
      if (!FACTORY.test(name)) continue;
      const byPackage = owners.get(name) ?? new Map<string, EntryModule>();
      const pkg = packageOf(entry.specifier);
      if (!byPackage.has(pkg)) byPackage.set(pkg, entry);
      owners.set(name, byPackage);
    }
  }
  const findings: Finding[] = [];
  for (const [name, byPackage] of owners) {
    if (byPackage.size < 2) continue;
    const packages = [...byPackage.keys()].sort();
    const listed = `${packages.slice(0, -1).join(', ')} and ${packages.at(-1) ?? ''}`;
    for (const pkg of packages) {
      const entry = byPackage.get(pkg);
      if (entry === undefined) continue;
      findings.push({
        code: CODE,
        cause: `${listed} both export ${name} (${entry.at}): one factory name in two packages means a file importing both aliases one by hand, and an agent cannot tell from the name which thing it builds`,
        fix: `git grep -nw ${renderFixShellArg(name, '<the export>')}   # in every package but one, rename ${name} after the type it returns (memoryStorageDriver for a MemoryStorageDriver), its declaration and ${entry.at} included`,
        at: entry.at,
      });
    }
  }
  return findings;
}

if (import.meta.main) {
  const args = parseScriptArgs(Bun.argv.slice(2));
  const entries = await readEntryModules(repoRoot());
  const findings = checkFactoryNames(entries);
  report(
    {
      ok: findings.length === 0,
      script: SCRIPT,
      summary:
        findings.length === 0
          ? `every memory / Postgres factory across ${String(entries.length)} public entry module(s) is spelled memoryX / postgresX`
          : `${String(findings.length)} export(s) still spelled create(Memory|Pg|Postgres)X, pgX, a Memory/Pg class or create<Vendor>Driver`,
      findings,
      data: { entries: entries.map((entry) => entry.at) },
    },
    args.json,
  );
}
