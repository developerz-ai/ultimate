// `x doctor`'s advisory floors: a version the app's `bun.lock` resolves below the first release an
// npm advisory left behind, for the dependencies the framework brings and cannot floor itself.
// A warning and never the verdict (`X_BREAKING_ON_MAIN`); `scripts/advisory-floors.ts` is the
// framework-side half that raises the ranges it can.

// why: Bun exposes no path-join primitive; Bun.file takes one already joined.
import { join } from 'node:path';
import { ERROR_DOCS_URL } from '@ultimat3/core';
import type { Finding } from './output';
import { quoteArg } from './shell-quote';

export const ADVISORY_FLOOR_UNMET = 'X_ADVISORY_FLOOR_UNMET';

export interface AdvisoryFloor {
  readonly name: string;
  /** The lowest version every listed advisory left behind. */
  readonly floor: string;
  readonly advisories: readonly string[];
  /** How it reaches an app: a range the app declares itself, or one a framework dependency does. */
  readonly via: 'app' | 'transitive';
}

/**
 * As of 2026-11-15. `solid-js` is the app's own pin (`@ultimat3/ui` peers `^1.9.18`: the first
 * release asking for seroval `~1.6.11`); the other two arrive through `sass`, whose ranges admit
 * the patched versions, so a lockfile refresh is the whole fix and no `overrides` is needed.
 */
export const ADVISORY_FLOORS: readonly AdvisoryFloor[] = [
  {
    name: 'solid-js',
    floor: '1.9.18',
    advisories: ['GHSA-3qxh-p7jc-5xh6', 'GHSA-f86p-h4j2-7qgj', 'GHSA-9wx9-5pv9-3349'],
    via: 'app',
  },
  {
    name: 'source-map-js',
    floor: '1.2.2',
    advisories: ['GHSA-68fv-2mgg-jv7q'],
    via: 'transitive',
  },
  {
    name: 'immutable',
    floor: '5.1.8',
    advisories: ['GHSA-xvcm-6775-5m9r', 'GHSA-v56q-mh7h-f735'],
    via: 'transitive',
  },
];

/** The floor the codemod raises an app's `solid-js` to. */
export const SOLID_FLOOR = ADVISORY_FLOORS[0]?.floor ?? '1.9.18';

/** Every version `bun.lock` resolves for `name`, nested `parent/name` entries included. */
function resolvedVersions(packages: Readonly<Record<string, unknown>>, name: string): string[] {
  return Object.entries(packages).flatMap(([key, entry]) => {
    if (key !== name && !key.endsWith(`/${name}`)) return [];
    const head = Array.isArray(entry) ? entry[0] : undefined;
    return typeof head === 'string' && head.startsWith(`${name}@`)
      ? [head.slice(name.length + 1)]
      : [];
  });
}

async function lockPackages(root: string): Promise<Readonly<Record<string, unknown>> | undefined> {
  const file = Bun.file(join(root, 'bun.lock'));
  if (!(await file.exists())) return undefined;
  try {
    const parsed: unknown = Bun.JSONC.parse(await file.text());
    const packages =
      typeof parsed === 'object' && parsed !== null ? Reflect.get(parsed, 'packages') : undefined;
    return typeof packages === 'object' && packages !== null
      ? (packages as Record<string, unknown>)
      : undefined;
  } catch {
    // Not swallowed: an unparsable lockfile is `bun install`'s to refuse, loudly, on the next run.
    return undefined;
  }
}

/** One warning per floor the lockfile resolves under, lowest resolved version named. */
export async function advisoryFloorFindings(
  root: string,
  floors: readonly AdvisoryFloor[] = ADVISORY_FLOORS,
): Promise<readonly Finding[]> {
  const packages = await lockPackages(root);
  if (packages === undefined) return [];
  const transitive = floors.filter((f) => f.via === 'transitive').map((f) => quoteArg(f.name));
  return floors.flatMap((row) => {
    const below = resolvedVersions(packages, row.name)
      .filter((version) => Bun.semver.order(version, row.floor) < 0)
      .sort((a, b) => Bun.semver.order(a, b));
    const lowest = below[0];
    if (lowest === undefined) return [];
    return [
      {
        code: ADVISORY_FLOOR_UNMET,
        cause: `bun.lock resolves ${row.name} ${lowest}, below ${row.floor}, the first release past ${row.advisories.join(', ')}`,
        fix:
          row.via === 'app'
            ? ['bun', 'add', '--exact', `${quoteArg(row.name)}@${row.floor}`].join(' ')
            : ['bun', 'update', ...transitive].join(' '),
        docs: ERROR_DOCS_URL,
        at: 'bun.lock',
      },
    ];
  });
}
