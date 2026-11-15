#!/usr/bin/env bun
// Does any published `@ultimat3/*` package declare a dependency range that admits a version an npm
// advisory names — the dependency's own, or one it pulls in? When a raised floor closes it,
// `--write` raises it in place, so an app installs a patched tree with no `overrides` of its own.
//
// An OPERATOR command `security-channel.yml` runs daily, never a `x verify` step: green may not
// depend on the network (registry-audit.ts states the same rule).
//
//   bun run scripts/advisory-floors.ts [--write] [--json]

// why: the LEAF module, never the `@ultimat3/cli` barrel, for registry-audit.ts's reason.
import { quoteArg } from '../packages/cli/src/shell-quote';
import type {
  Advisory,
  Declaration,
  Exposure,
  FloorVerdict,
  PackageFacts,
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

export interface LoadedWorld {
  readonly world: World;
  /** Every package whose packument or advisories did not answer: its verdict cannot be trusted. */
  readonly unreachable: ReadonlySet<string>;
}

async function getJson(url: string, fetcher: AdvisoryFetch, token: string | undefined) {
  const headers: Record<string, string> = url.startsWith(REGISTRY)
    ? { accept: 'application/vnd.npm.install-v1+json' }
    : {
        accept: 'application/vnd.github+json',
        ...(token === undefined ? {} : { authorization: `Bearer ${token}` }),
      };
  try {
    const response = await fetcher(url, {
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      headers,
    });
    if (!response.ok) return undefined;
    const body: unknown = await response.json();
    return body;
  } catch {
    // Not swallowed: `undefined` lands the package in `unreachable`, which is a finding.
    return undefined;
  }
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
      getJson(`${REGISTRY}/${name.replace('/', '%2f')}`, fetcher, token),
      getJson(
        `${ADVISORY_API}?ecosystem=npm&per_page=100&affects=${encodeURIComponent(name)}`,
        fetcher,
        token,
      ),
    ]);
    const read = factsOf(packument);
    if (read === undefined || !Array.isArray(found)) {
      unreachable.add(name);
      return;
    }
    facts.set(name, read);
    advisories.set(name, parseAdvisories(name, found));
  };
  const direct = [...new Set(declarations.map((d) => d.name))];
  await Promise.all(direct.map(load));
  const transitive = new Set(
    direct.flatMap((name) =>
      Object.values(facts.get(name)?.dependencies ?? {}).flatMap((deps) => Object.keys(deps)),
    ),
  );
  await Promise.all([...transitive].map(load));
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

export interface AdvisoryFloorsResult extends ScriptResult {
  readonly raises: readonly Raise[];
}

export function advisoryFloorsResult(
  declarations: readonly Declaration[],
  loaded: LoadedWorld,
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
        : decideFloor(declaration, loaded.world),
  );
  const findings = verdicts.flatMap((verdict) => findingOf(verdict) ?? []);
  const raises = verdicts.flatMap((v): Raise[] =>
    v.kind === 'raise'
      ? [{ ...v.declaration, from: v.declaration.range, to: v.to, advisories: v.exposures }]
      : [],
  );
  return {
    ok: findings.length === 0,
    script: SCRIPT,
    summary:
      findings.length === 0
        ? `${declarations.length} published dependency range(s) admit no advised version`
        : `${findings.length} of ${declarations.length} published dependency range(s) admit an advised version; ${raises.length} raisable`,
    findings,
    data: { raises },
    raises,
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
  const result = advisoryFloorsResult(declarations, await loadWorld(declarations, fetch, token));
  if (args.flags.get('write') === true) {
    for (const raise of result.raises) {
      const path = `${root}/${raise.manifest}`;
      const source = await Bun.file(path).text();
      await Bun.write(path, raiseManifest(source, raise.field, raise.name, raise.from, raise.to));
    }
  }
  report(result, args.json);
}
