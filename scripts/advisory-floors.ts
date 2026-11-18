#!/usr/bin/env bun

// Does any published `@ultimat3/*` package declare a dependency range that admits a version an npm
// advisory names — the dependency's own, or one it pulls in? When a raised floor closes it,
// `--write` raises it in place, so an app installs a patched tree with no `overrides` of its own.
//
// Two of them no dart-sass or immutable release will ever floor — their ranges already admit the
// patched versions. There the framework's own `bun.lock` IS the floor, so a declaration whose
// locked versions are all past every advisory is reported in `data.locked` rather than as a
// finding, and turns red again the moment a lockfile refresh resolves a vulnerable copy.
//
// An OPERATOR command `security-channel.yml` runs daily, never a `x verify` step: green may not
// depend on the network (registry-audit.ts states the same rule).
//
//   bun run scripts/advisory-floors.ts [--write] [--json]

import { quoteArg } from '../packages/cli/src/shell-quote';
// why: the LEAF modules, never the `@ultimat3/*` barrels, for registry-audit.ts's reason.
import { mapBounded } from '../packages/core/src/map-bounded';
import type {
  Advisory,
  Declaration,
  Exposure,
  FloorVerdict,
  PackageFacts,
  ResolvedVersions,
  World,
} from './lib/advisory-floors';
import { decideFloor, parseAdvisories, raiseManifest } from './lib/advisory-floors';
import { parseScriptArgs } from './lib/args';
import type { Finding, ScriptResult } from './lib/log';
import { report } from './lib/log';
import { repoRoot } from './lib/run';
import { ScriptError } from './lib/script-error';
import { listWorkspaces } from './lib/workspaces';

const SCRIPT = 'advisory-floors';
export const ADVISORY_API = 'https://api.github.com/advisories';
const REGISTRY = 'https://registry.npmjs.org';
const REQUEST_TIMEOUT_MS = 15_000;
/**
 * Packages asked about at once, two requests each. The advisory API allows a token 5,000 requests
 * an hour and a few dozen are asked in all: the bound is politeness and a flat socket count.
 */
export const ADVISORY_FETCH_WIDTH = 6;
const FIELDS = ['dependencies', 'peerDependencies'] as const;

/** The seam: tests drive fixtures, a test that resolves the network is a flake. */
export type AdvisoryFetch = (
  url: string,
  init: { readonly signal: AbortSignal; readonly headers: Readonly<Record<string, string>> },
) => Promise<Response>;

/** The external ranges one manifest declares. Siblings and protocol ranges are not npm's to judge. */
export function declarationsOf(manifest: string, json: unknown): Declaration[] {
  const record = typeof json === 'object' && json !== null ? (json as Record<string, unknown>) : {};
  return FIELDS.flatMap((field) => {
    const block = record[field];
    if (typeof block !== 'object' || block === null) return [];
    return Object.entries(block as Record<string, unknown>).flatMap(([name, range]) =>
      typeof range !== 'string' || name.startsWith('@ultimat3/') || range.includes(':')
        ? []
        : [{ manifest, field, name, range }],
    );
  });
}

/**
 * The repo's own `bun.lock`, read as the versions it resolves per package — the same shape
 * `packages/cli/src/doctor-advisory-floors.ts:56-64` reads, nested `parent/name` entries included,
 * because one vulnerable copy anywhere in the tree is the defect. `undefined` when the file is
 * absent or unparsable: an unread lockfile closes nothing, so every floor it might have held stays
 * reported.
 */
export async function lockedVersions(root: string): Promise<ResolvedVersions | undefined> {
  const file = Bun.file(`${root}/bun.lock`);
  if (!(await file.exists())) return undefined;
  try {
    const parsed: unknown = Bun.JSONC.parse(await file.text());
    const packages =
      typeof parsed === 'object' && parsed !== null ? Reflect.get(parsed, 'packages') : undefined;
    if (typeof packages !== 'object' || packages === null) return undefined;
    const entries = Object.entries(packages as Record<string, unknown>);
    return (name) =>
      entries.flatMap(([key, entry]) => {
        if (key !== name && !key.endsWith(`/${name}`)) return [];
        const head = Array.isArray(entry) ? entry[0] : undefined;
        return typeof head === 'string' && head.startsWith(`${name}@`)
          ? [head.slice(name.length + 1)]
          : [];
      });
  } catch {
    // Not swallowed: unreadable is `undefined`, which closes nothing and keeps every finding red.
    return undefined;
  }
}

export interface LoadedWorld {
  readonly world: World;
  /** Every package whose packument or advisories did not answer: its verdict cannot be trusted. */
  readonly unreachable: ReadonlySet<string>;
}

interface Answer {
  readonly body: unknown;
  /** `Link: <…>; rel="next"`, when the API has another page. */
  readonly next: string | undefined;
}

/** The GitHub token rides to the advisory API only — never the registry, never a `Link` elsewhere. */
async function getJson(
  url: string,
  fetcher: AdvisoryFetch,
  token: string | undefined,
): Promise<Answer | undefined> {
  const github = url.startsWith(`${ADVISORY_API}?`);
  const headers: Record<string, string> = github
    ? {
        accept: 'application/vnd.github+json',
        ...(token === undefined ? {} : { authorization: `Bearer ${token}` }),
      }
    : { accept: 'application/vnd.npm.install-v1+json' };
  try {
    const response = await fetcher(url, {
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      headers,
    });
    if (!response.ok) return undefined;
    const body: unknown = await response.json();
    const next = /<([^>]+)>;\s*rel="next"/.exec(response.headers.get('link') ?? '')?.[1];
    return { body, next };
  } catch {
    // Not swallowed: `undefined` lands the package in `unreachable`, which is a finding.
    return undefined;
  }
}

/** More pages than any package has had; past it the answer is unjudged, never a short list. */
const MAX_ADVISORY_PAGES = 10;

/**
 * Every advisory page for `name`, following `rel="next"`. A page that does not answer, a `next`
 * off the advisory API, or more than `MAX_ADVISORY_PAGES` is `undefined`: a list read in part is
 * not a list with nothing more in it.
 */
async function advisoryPages(
  name: string,
  fetcher: AdvisoryFetch,
  token: string | undefined,
): Promise<unknown[] | undefined> {
  const all: unknown[] = [];
  let url: string | undefined =
    `${ADVISORY_API}?ecosystem=npm&per_page=100&affects=${encodeURIComponent(name)}`;
  for (let page = 0; page < MAX_ADVISORY_PAGES && url !== undefined; page += 1) {
    if (!url.startsWith(`${ADVISORY_API}?`)) return undefined;
    const answer: Answer | undefined = await getJson(url, fetcher, token);
    if (answer === undefined || !Array.isArray(answer.body)) return undefined;
    all.push(...answer.body);
    url = answer.next;
  }
  return url === undefined ? all : undefined;
}

function factsOf(body: unknown): PackageFacts | undefined {
  const versions =
    typeof body === 'object' && body !== null ? Reflect.get(body, 'versions') : undefined;
  if (typeof versions !== 'object' || versions === null) return undefined;
  const dependencies: Record<string, Record<string, string>> = {};
  for (const [version, record] of Object.entries(versions as Record<string, unknown>)) {
    const deps =
      typeof record === 'object' && record !== null ? Reflect.get(record, 'dependencies') : {};
    dependencies[version] =
      typeof deps === 'object' && deps !== null ? (deps as Record<string, string>) : {};
  }
  return { versions: Object.keys(dependencies), dependencies };
}

/** The packument and advisories of every declared dependency, and of each one's own dependencies. */
export async function loadWorld(
  declarations: readonly Declaration[],
  fetcher: AdvisoryFetch,
  token: string | undefined,
): Promise<LoadedWorld> {
  const facts = new Map<string, PackageFacts>();
  const advisories = new Map<string, readonly Advisory[]>();
  const unreachable = new Set<string>();
  const load = async (name: string): Promise<void> => {
    if (facts.has(name) || unreachable.has(name)) return;
    const [packument, found] = await Promise.all([
      getJson(`${REGISTRY}/${name.replaceAll('/', '%2f')}`, fetcher, token),
      advisoryPages(name, fetcher, token),
    ]);
    const read = factsOf(packument?.body);
    if (read === undefined || found === undefined) {
      unreachable.add(name);
      return;
    }
    facts.set(name, read);
    advisories.set(name, parseAdvisories(name, found));
  };
  const direct = [...new Set(declarations.map((d) => d.name))];
  await mapBounded(direct, load, { width: ADVISORY_FETCH_WIDTH });
  const transitive = new Set(
    direct.flatMap((name) =>
      Object.values(facts.get(name)?.dependencies ?? {}).flatMap((deps) => Object.keys(deps)),
    ),
  );
  await mapBounded([...transitive], load, { width: ADVISORY_FETCH_WIDTH });
  const world: World = {
    facts: (name) => facts.get(name),
    advisories: (name) => advisories.get(name) ?? [],
  };
  return { world, unreachable };
}

const named = (verdict: Extract<FloorVerdict, { exposures: unknown }>): string =>
  verdict.exposures
    .map((e) => `${e.advisory} in ${e.package}${e.via === undefined ? '' : ` via ${e.via}`}`)
    .join(', ');

function findingOf(verdict: FloorVerdict): Finding | undefined {
  const { manifest, field, name, range } = verdict.declaration;
  const at = `${manifest} ${field}.${name}`;
  if (verdict.kind === 'clean') return undefined;
  if (verdict.kind === 'unknown') {
    return {
      code: 'X_ADVISORY_UNREACHABLE',
      at,
      cause: `the registry or the advisory database did not answer for ${name} or one of its dependencies, so its range was never judged`,
      fix: 'GH_TOKEN="$(gh auth token)" bun run scripts/advisory-floors.ts',
    };
  }
  // A floor the lockfile holds is not a defect: it is reported in `data.locked`, and the whole
  // point of the verdict is that it goes red by itself when that floor is gone.
  if (verdict.kind === 'lockfile') return undefined;
  if (verdict.kind === 'raise') {
    return {
      code: 'X_ADVISORY_RANGE_OPEN',
      at,
      cause: `${name}@${range} admits ${named(verdict)}; ${verdict.to} is the lowest floor that admits none`,
      fix: 'bun run scripts/advisory-floors.ts --write',
    };
  }
  const reached = [...new Set(verdict.exposures.map((e) => e.package))];
  return {
    code: 'X_ADVISORY_UNFLOORABLE',
    at,
    cause: `${name}@${range} admits ${named(verdict)}, and no ${name} release on this line excludes it, so an app's lockfile is the only floor`,
    fix: ['bun', 'update', ...reached.map(quoteArg)].join(' '),
  };
}

/** One raise `--write` applies: the declaration, the range it holds, and the floor that closes it. */
export interface Raise extends Declaration {
  readonly from: string;
  readonly to: string;
  readonly advisories: readonly Exposure[];
}

/** One declaration no release floors, held closed by the framework's own `bun.lock` today. */
export interface Locked extends Declaration {
  readonly exposures: readonly Exposure[];
  /** What the lockfile resolves for each exposed package — the evidence, not a promise. */
  readonly resolved: Readonly<Record<string, readonly string[]>>;
}

export interface AdvisoryFloorsResult extends ScriptResult {
  readonly raises: readonly Raise[];
  readonly locked: readonly Locked[];
}

export function advisoryFloorsResult(
  declarations: readonly Declaration[],
  loaded: LoadedWorld,
  resolved?: ResolvedVersions,
): AdvisoryFloorsResult {
  // A dependency of a dependency that did not answer is unjudged too: its advisories are the ones
  // `decideFloor` would have read through the range, and none read is not none found.
  const unjudged = (name: string): boolean =>
    loaded.unreachable.has(name) ||
    Object.values(loaded.world.facts(name)?.dependencies ?? {}).some((deps) =>
      Object.keys(deps).some((dep) => loaded.unreachable.has(dep)),
    );
  const verdicts = declarations.map(
    (declaration): FloorVerdict =>
      unjudged(declaration.name)
        ? { kind: 'unknown', declaration }
        : decideFloor(declaration, loaded.world, resolved),
  );
  const findings = verdicts.flatMap((verdict) => findingOf(verdict) ?? []);
  const raises = verdicts.flatMap((v): Raise[] =>
    v.kind === 'raise'
      ? [{ ...v.declaration, from: v.declaration.range, to: v.to, advisories: v.exposures }]
      : [],
  );
  const locked = verdicts.flatMap((v): Locked[] =>
    v.kind === 'lockfile'
      ? [{ ...v.declaration, exposures: v.exposures, resolved: v.resolved }]
      : [],
  );
  const held =
    locked.length === 0 ? '' : `; ${locked.length} held by bun.lock, no range able to floor it`;
  return {
    ok: findings.length === 0,
    script: SCRIPT,
    summary:
      findings.length === 0
        ? `${declarations.length} published dependency range(s) admit no advised version${held}`
        : `${findings.length} of ${declarations.length} published dependency range(s) admit an advised version; ${raises.length} raisable${held}`,
    findings,
    data: { raises, locked },
    raises,
    locked,
  };
}

if (import.meta.main) {
  const args = parseScriptArgs(Bun.argv.slice(2), {
    names: ['write'],
    refuse: (unknown) =>
      new ScriptError({
        code: 'X_CLI_BAD_FLAG',
        cause: `advisory-floors reads --write and --json only, and was given --${unknown.join(', --')}`,
        fix: 'bun run scripts/advisory-floors.ts --write --json',
      }),
  });
  const root = repoRoot();
  const workspaces = (await listWorkspaces(root)).filter((w) => !w.private);
  const declarations = (
    await Promise.all(
      workspaces.map(async (w) => {
        const manifest = `packages/${w.dir}/package.json`;
        return declarationsOf(manifest, await Bun.file(`${root}/${manifest}`).json());
      }),
    )
  ).flat();
  const token = process.env['GH_TOKEN'] ?? process.env['GITHUB_TOKEN'];
  const result = advisoryFloorsResult(
    declarations,
    await loadWorld(declarations, fetch, token),
    await lockedVersions(root),
  );
  if (args.flags.get('write') === true) {
    for (const raise of result.raises) {
      const path = `${root}/${raise.manifest}`;
      const source = await Bun.file(path).text();
      await Bun.write(path, raiseManifest(source, raise.field, raise.name, raise.from, raise.to));
    }
  }
  report(result, args.json);
}
