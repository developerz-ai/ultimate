#!/usr/bin/env bun
// Compare the REGISTRY to this tree: for every publishable workspace, is it on npm at all, is it
// there at the version this tree stamps, and was that version published by the workflow. Nothing
// else asks — `scripts/release-workflow.ts` proves the workflow NAMES every package, which says
// nothing about whether npm holds it, and that gap is why the docs described a publish state npm
// had not been in for two releases (`flags`, then `scraping`).
//
// An OPERATOR command, not a `x verify` step, and it must not become one — the same rule
// `scripts/trust-publishers.ts` states for the same reason: the gate is the shippability contract
// and runs on free CI runners, so a step that resolves npm makes green depend on a network the
// runner does not control. Read-only always: it fetches packuments and publishes nothing, so there
// is no write mode to gate behind a `--check`.
//
//   bun run scripts/registry-audit.ts [--json]

import { parseScriptArgs } from './lib/args';
import type { Finding } from './lib/log';
import { report } from './lib/log';
import { repoRoot } from './lib/run';
import { listWorkspaces, publishOrder } from './lib/workspaces';

export const REGISTRY = 'https://registry.npmjs.org';

/** One packument is a small JSON document; a slow one must not hold the other 29 hostage. */
export const REQUEST_TIMEOUT_MS = 15_000;

/** The seam. Injected so the tests drive fixtures — a test that resolves npm is a flake. */
export type RegistryFetch = (
  url: string,
  init: { readonly signal: AbortSignal },
) => Promise<Response>;

/** What the audit needs of a workspace: its published name and the version this tree stamps. */
export interface AuditTarget {
  readonly name: string;
  readonly version: string;
}

/**
 * `unreachable` is a first-class answer, never folded into `absent`: npm rate-limits, and its
 * public packument lagged a real publish by MINUTES (PUBLISHING.md), so a request that did not
 * answer is not a package that is not there — and the fix for one is an irreversible publish.
 */
export type PublishStateKind = 'ok' | 'absent' | 'behind' | 'unattested' | 'unreachable';

export interface PublishState extends AuditTarget {
  /** 1-based position in `publishOrder`, which is the order a release run publishes in. */
  readonly ordinal: number;
  readonly total: number;
  readonly kind: PublishStateKind;
  /** `dist-tags.latest`, when the registry answered. */
  readonly latest?: string;
  /** `_npmUser` on the stamped version — `GitHub Actions` for a workflow publish. */
  readonly publishedBy?: string;
  /** Only for `unreachable`: how the request failed, in words a reader can act on. */
  readonly detail?: string;
}

/**
 * `@ultimat3/core` -> `@ultimat3%2fcore`. Only the separator is escaped: that is the path npm's own
 * client builds, and `encodeURIComponent` on the whole name would escape the `@` too.
 */
export const packumentUrl = (name: string): string => `${REGISTRY}/${name.replace('/', '%2f')}`;

/** 27th, not 27nd. The ordinal is what makes the cost of a missing bootstrap legible. */
export function ordinalLabel(n: number): string {
  const teens = n % 100;
  if (teens >= 11 && teens <= 13) return `${n}th`;
  return `${n}${['th', 'st', 'nd', 'rd'][n % 10] ?? 'th'}`;
}

interface VersionRecord {
  readonly dist?: { readonly attestations?: unknown };
  readonly _npmUser?: { readonly name?: unknown } | string;
}

interface Packument {
  readonly 'dist-tags'?: { readonly latest?: unknown };
  readonly versions?: Readonly<Record<string, VersionRecord>>;
}

/** `_npmUser` is an object on a version record and a bare string in older documents. */
function publisherOf(record: VersionRecord | undefined): string | undefined {
  const user = record?._npmUser;
  if (typeof user === 'string') return user;
  const name = typeof user === 'object' && user !== null ? user.name : undefined;
  return typeof name === 'string' ? name : undefined;
}

/**
 * Total by construction, so the one place an audit touches a value it did not create cannot throw
 * while describing the throw. No `String(failure)` and no bare interpolation: both die on a Proxy.
 */
function failureDetail(failure: unknown): string {
  if (failure instanceof Error && typeof failure.message === 'string') return failure.message;
  return 'the request failed with no message';
}

export type Lookup =
  | { readonly kind: 'found'; readonly packument: Packument }
  | { readonly kind: 'absent' }
  | { readonly kind: 'unreachable'; readonly detail: string };

/** One packument, or the reason there is none. Every non-404 failure is `unreachable`. */
export async function lookup(
  name: string,
  fetcher: RegistryFetch,
  timeoutMs: number,
): Promise<Lookup> {
  try {
    const response = await fetcher(packumentUrl(name), { signal: AbortSignal.timeout(timeoutMs) });
    if (response.status === 404) return { kind: 'absent' };
    if (!response.ok) return { kind: 'unreachable', detail: `HTTP ${response.status}` };
    // A 200 carrying an error page is not a package with no versions; it is no answer at all.
    const body: unknown = await response.json();
    if (typeof body !== 'object' || body === null) {
      return { kind: 'unreachable', detail: 'the 200 body is not a packument object' };
    }
    return { kind: 'found', packument: body as Packument };
  } catch (failure) {
    return { kind: 'unreachable', detail: failureDetail(failure) };
  }
}

export function classify(
  target: AuditTarget,
  seat: Pick<PublishState, 'ordinal' | 'total'>,
  found: Lookup,
): PublishState {
  // Projected field by field, never spread: a caller passes a whole `Workspace`, and spreading it
  // would put this machine's absolute `path` into the `--json` an operator pastes into an issue.
  const base = { name: target.name, version: target.version, ...seat };
  if (found.kind === 'absent') return { ...base, kind: 'absent' };
  if (found.kind === 'unreachable') return { ...base, kind: 'unreachable', detail: found.detail };
  const tag = found.packument['dist-tags']?.latest;
  const latest = typeof tag === 'string' ? tag : 'none';
  const record = found.packument.versions?.[target.version];
  if (record === undefined) return { ...base, kind: 'behind', latest };
  const publishedBy = publisherOf(record);
  const attested = record.dist?.attestations !== undefined && record.dist.attestations !== null;
  return {
    ...base,
    kind: attested ? 'ok' : 'unattested',
    latest,
    ...(publishedBy === undefined ? {} : { publishedBy }),
  };
}

const defaultFetch: RegistryFetch = (url, init) => fetch(url, init);

/** Sequential on purpose: 30 small GETs, and a burst is what npm rate-limits. */
export async function auditRegistry(
  targets: readonly AuditTarget[],
  fetcher: RegistryFetch = defaultFetch,
  timeoutMs: number = REQUEST_TIMEOUT_MS,
): Promise<readonly PublishState[]> {
  const states: PublishState[] = [];
  for (const [index, target] of targets.entries()) {
    const found = await lookup(target.name, fetcher, timeoutMs);
    states.push(classify(target, { ordinal: index + 1, total: targets.length }, found));
  }
  return states;
}

const absentFinding = (state: PublishState): Finding => ({
  code: 'X_REGISTRY_BOOTSTRAP_OWED',
  at: state.name,
  cause: `${state.name} is publishable and the registry has no such package — it is ${ordinalLabel(state.ordinal)} of ${state.total} in the publish order, so a release run publishes ${state.ordinal - 1} packages irreversibly and then dies on this one`,
  fix: `npm publish -w ${state.name} --access public --provenance=false   # PUBLISHING.md step 1, the one-time bootstrap; then bun run scripts/trust-publishers.ts`,
});

const behindFinding = (state: PublishState): Finding => ({
  code: 'X_REGISTRY_VERSION_BEHIND',
  at: state.name,
  cause: `this tree stamps ${state.name} at ${state.version} and the registry's newest is ${state.latest ?? 'none'}, so the release that should have published ${state.version} did not reach this package`,
  fix: `gh workflow run release.yml --ref v${state.version} -f version=${state.version}   # when the run aborts EPUBLISHCONFLICT on a sibling already at ${state.version}, publish this one alone: npm publish -w ${state.name} --access public --provenance=false`,
});

const unattestedFinding = (state: PublishState): Finding => ({
  code: 'X_REGISTRY_UNATTESTED',
  at: state.name,
  cause: `${state.name}@${state.version} is on the registry with no dist.attestations, published by ${state.publishedBy ?? 'an account the packument does not name'} rather than by release.yml — so nothing proves the tarball a consumer installs was built from this repo`,
  fix: `bun run scripts/trust-publishers.ts --json   # attach the OIDC publisher, then release the next version through the workflow (bun run scripts/release.ts --bump patch); npm publishes are immutable, so ${state.version} itself can never gain an attestation`,
});

const unreachableFinding = (state: PublishState): Finding => ({
  code: 'X_REGISTRY_UNREACHABLE',
  at: state.name,
  cause: `the registry did not answer for ${state.name}: ${state.detail ?? 'no detail'} — this is not evidence that ${state.name} is unpublished`,
  fix: `curl -sS -o /dev/null -w '%{http_code}\\n' ${packumentUrl(state.name)}   # then re-run: bun run scripts/registry-audit.ts --json`,
});

const FINDINGS: Readonly<Record<PublishStateKind, ((state: PublishState) => Finding) | undefined>> =
  {
    ok: undefined,
    absent: absentFinding,
    behind: behindFinding,
    unattested: unattestedFinding,
    unreachable: unreachableFinding,
  };

export const findingFor = (state: PublishState): Finding | undefined =>
  FINDINGS[state.kind]?.(state);

export const registryFindings = (states: readonly PublishState[]): readonly Finding[] =>
  states.map(findingFor).filter((finding): finding is Finding => finding !== undefined);

if (import.meta.main) {
  const args = parseScriptArgs(Bun.argv.slice(2));
  const targets = publishOrder(await listWorkspaces(repoRoot()));
  const states = await auditRegistry(targets);
  const findings = registryFindings(states);
  const attested = states.filter((state) => state.kind === 'ok').length;
  const version = targets[0]?.version ?? 'unknown';
  report(
    {
      ok: findings.length === 0,
      script: 'registry-audit',
      summary:
        findings.length === 0
          ? `${attested}/${states.length} publishable packages are on npm at ${version}, every one attested`
          : `${findings.length} registry gap(s) across ${states.length} publishable packages`,
      findings,
      data: { registry: REGISTRY, states },
    },
    args.json,
  );
}
