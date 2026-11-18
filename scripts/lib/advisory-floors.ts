// Decide, per declared external dependency of a published package, whether its range admits a
// version an npm advisory names — its own, or one of its dependencies' through the range the
// dependency declares — and the smallest raised floor that admits none. Pure: the registry, the
// advisory database and the framework's own lockfile arrive as a `World` and a `ResolvedVersions`,
// so the decision is pinned by fixtures, never the network.
//
// A range no release of the dependency floors is STILL reported: `unfloorable` when nothing else
// closes it, and `lockfile` when the framework's own `bun.lock` resolves every exposed package past
// every advisory. The second is a floor that exists — in the lockfile, not in a range — so the
// audit says so and stays red the moment the lockfile regresses.

import { ScriptError } from './script-error';

/** One advisory against one package: `vulnerable` is a range `Bun.semver` reads. */
export interface Advisory {
  readonly id: string;
  readonly vulnerable: string;
}

/** What the registry says of a package: its versions, and each version's `dependencies`. */
export interface PackageFacts {
  readonly versions: readonly string[];
  readonly dependencies: Readonly<Record<string, Readonly<Record<string, string>>>>;
}

export interface World {
  readonly facts: (name: string) => PackageFacts | undefined;
  readonly advisories: (name: string) => readonly Advisory[];
}

/**
 * The versions the framework's own `bun.lock` resolves for `name` — every nested copy included.
 * `undefined` when the lockfile was not read, which closes nothing.
 */
export type ResolvedVersions = (name: string) => readonly string[] | undefined;

/** One external range a published manifest declares. */
export interface Declaration {
  readonly manifest: string;
  readonly field: 'dependencies' | 'peerDependencies';
  readonly name: string;
  readonly range: string;
}

/** An advisory the range lets in: on the dependency itself, or on `package` reached `via` it. */
export interface Exposure {
  readonly advisory: string;
  readonly package: string;
  readonly via?: string;
}

export type FloorVerdict =
  | { readonly kind: 'clean'; readonly declaration: Declaration }
  | { readonly kind: 'unknown'; readonly declaration: Declaration }
  | {
      readonly kind: 'raise';
      readonly declaration: Declaration;
      readonly to: string;
      readonly exposures: readonly Exposure[];
    }
  | {
      readonly kind: 'unfloorable';
      readonly declaration: Declaration;
      readonly exposures: readonly Exposure[];
    }
  | {
      /**
       * No release of the dependency floors it, and the framework's own `bun.lock` resolves every
       * exposed package past every advisory: the floor is the lockfile, not a range. Reported in
       * `data.locked`, never as a finding — and red again the moment the lockfile regresses.
       */
      readonly kind: 'lockfile';
      readonly declaration: Declaration;
      readonly exposures: readonly Exposure[];
      /** What the lockfile resolves for each exposed package: the evidence the verdict rests on. */
      readonly resolved: Readonly<Record<string, readonly string[]>>;
    };

/** The three shapes a floor can be raised in without changing what the range means. */
const RAISABLE = /^([~^]?)(\d+)\.(\d+)\.(\d+)$/;

const stable = (version: string): boolean => /^\d+\.\d+\.\d+$/.test(version);

const ascending = (versions: readonly string[]): string[] =>
  versions.filter(stable).sort((a, b) => Bun.semver.order(a, b));

/** Every advisory a version of `name` lets in — its own, and each dependency's through its range. */
function exposuresOf(name: string, version: string, world: World): Exposure[] {
  const own = world
    .advisories(name)
    .filter((advisory) => Bun.semver.satisfies(version, advisory.vulnerable))
    .map((advisory) => ({ advisory: advisory.id, package: name }));
  const deps = world.facts(name)?.dependencies[version] ?? {};
  const through = Object.entries(deps).flatMap(([dep, depRange]) => {
    const admitted = ascending(world.facts(dep)?.versions ?? []).filter((v) =>
      Bun.semver.satisfies(v, depRange),
    );
    return world
      .advisories(dep)
      .filter((advisory) => admitted.some((v) => Bun.semver.satisfies(v, advisory.vulnerable)))
      .map((advisory) => ({ advisory: advisory.id, package: dep, via: name }));
  });
  return [...own, ...through];
}

/** A version `Bun.semver` can order and an advisory can cover; a git or `file:` head is neither. */
const RELEASE = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.+-]*)?$/;

/**
 * The versions the lockfile resolves, when they close every exposure: each a release, each admitted
 * by the range it was declared under, and none covered by an advisory on its own package. Any
 * `undefined` — absent, unorderable, or still vulnerable — is not closed, because an unread
 * lockfile is never a clean one and one vulnerable copy anywhere in the tree is the defect.
 */
function closedByLockfile(
  declaration: Declaration,
  exposures: readonly Exposure[],
  world: World,
  resolved: ResolvedVersions | undefined,
): Readonly<Record<string, readonly string[]>> | undefined {
  if (resolved === undefined) return undefined;
  const declared = resolved(declaration.name) ?? [];
  if (declared.length === 0) return undefined;
  const inRange = declared.every(
    (version) => RELEASE.test(version) && Bun.semver.satisfies(version, declaration.range),
  );
  if (!inRange) return undefined;
  const closing: Record<string, readonly string[]> = {};
  for (const exposure of exposures) {
    const versions = resolved(exposure.package) ?? [];
    if (versions.length === 0) return undefined;
    const advisories = world.advisories(exposure.package);
    for (const version of versions) {
      if (!RELEASE.test(version)) return undefined;
      if (advisories.some((advisory) => Bun.semver.satisfies(version, advisory.vulnerable))) {
        return undefined;
      }
    }
    closing[exposure.package] = versions;
  }
  return closing;
}

const unique = (exposures: readonly Exposure[]): Exposure[] => [
  ...new Map(exposures.map((e) => [`${e.advisory} ${e.package}`, e])).values(),
];

export function decideFloor(
  declaration: Declaration,
  world: World,
  resolved?: ResolvedVersions,
): FloorVerdict {
  const facts = world.facts(declaration.name);
  if (facts === undefined) return { kind: 'unknown', declaration };
  const versions = ascending(facts.versions);
  const admittedBy = (candidate: string): string[] =>
    versions.filter((v) => Bun.semver.satisfies(v, candidate));
  const exposedIn = (candidate: string): Exposure[] =>
    unique(admittedBy(candidate).flatMap((v) => exposuresOf(declaration.name, v, world)));

  const exposures = exposedIn(declaration.range);
  if (exposures.length === 0) return { kind: 'clean', declaration };
  // No range can close it: the lockfile is the only floor left, and whether it holds is a fact.
  const unfloored = (): FloorVerdict => {
    const closed = closedByLockfile(declaration, exposures, world, resolved);
    return closed === undefined
      ? { kind: 'unfloorable', declaration, exposures }
      : { kind: 'lockfile', declaration, exposures, resolved: closed };
  };
  const shape = RAISABLE.exec(declaration.range);
  if (shape === null) return unfloored();
  const [, operator = '', major = '', minor = '', patch = ''] = shape;
  const base = `${major}.${minor}.${patch}`;
  // Same major, and the same minor under 0.x: a caret on 0.y is a minor-wide range, so moving
  // past it would be a breaking change dressed as a security floor.
  const sameLine = (v: string): boolean =>
    v.split('.')[0] === major && (major !== '0' || v.split('.')[1] === minor);
  for (const version of versions) {
    if (Bun.semver.order(version, base) <= 0 || !sameLine(version)) continue;
    const candidate = `${operator}${version}`;
    if (exposedIn(candidate).length === 0) {
      return { kind: 'raise', declaration, to: candidate, exposures };
    }
  }
  return unfloored();
}

interface RawVulnerability {
  readonly package?: { readonly name?: unknown };
  readonly vulnerable_version_range?: unknown;
}

const asRecord = (value: unknown): Readonly<Record<string, unknown>> | undefined =>
  typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : undefined;

/** GitHub writes `>= 1.5.5, < 1.6.10`; `Bun.semver` reads `>=1.5.5 <1.6.10`. */
const semverRange = (raw: string): string =>
  raw.replace(/([<>=~^]+)\s+/g, '$1').replace(/\s*,\s*/g, ' ');

/** The GitHub advisory API's answer for `name`, narrowed to what `decideFloor` reads. */
export function parseAdvisories(name: string, body: readonly unknown[]): Advisory[] {
  return body.flatMap((entry) => {
    const advisory = asRecord(entry);
    const id = advisory?.['ghsa_id'];
    if (advisory === undefined || typeof id !== 'string' || advisory['withdrawn_at'] != null) {
      return [];
    }
    const vulnerabilities = Array.isArray(advisory['vulnerabilities'])
      ? (advisory['vulnerabilities'] as readonly RawVulnerability[])
      : [];
    const ranges = vulnerabilities
      .filter((v) => v.package?.name === name && typeof v.vulnerable_version_range === 'string')
      .map((v) => semverRange(v.vulnerable_version_range as string));
    return ranges.length === 0 ? [] : [{ id, vulnerable: ranges.join(' || ') }];
  });
}

const literal = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** One declaration's range rewritten in place, every other byte of the manifest kept. */
export function raiseManifest(
  source: string,
  field: Declaration['field'],
  name: string,
  from: string,
  to: string,
): string {
  const block = new RegExp(
    `("${literal(field)}"\\s*:\\s*\\{[^}]*?"${literal(name)}"\\s*:\\s*")${literal(from)}"`,
  );
  if (!block.test(source)) {
    throw new ScriptError({
      code: 'X_ADVISORY_MANIFEST_MOVED',
      cause: `the manifest no longer declares ${name} at ${from} in ${field}; it changed after the audit read it`,
      fix: 'bun run scripts/advisory-floors.ts --write',
    });
  }
  return source.replace(block, `$1${to}"`);
}
