/**
 * Version skew — what actually breaks PWAs. A client that loaded build A keeps running
 * for hours; build B deletes A's chunks; the next lazy import 404s and the app dies with
 * a blank screen. Nothing here is optional:
 *
 *   immutable build id per deploy → the client sends it on every request →
 *   old builds' assets are retained for N deploys → a stale client gets
 *   `AppUpdateAvailable`, never a 404 → forced reload only after a grace period.
 */

import { BuildIdMissingError } from './errors';

export const BUILD_ID_HEADER = 'x-ultimate-build';
export const BUILD_ID_META = 'x-ultimate-build';

export type DeployChannel = 'production' | 'preview' | 'branch';

export interface BuildIdInput {
  /** Preferred source: the commit is the deploy's real identity. */
  readonly gitSha?: string;
  /** Milliseconds; only used when there is no sha. */
  readonly timestamp?: number;
  readonly channel?: DeployChannel;
  /** Branch or PR slug; keeps preview ids from ever colliding with production. */
  readonly ref?: string;
}

/**
 * Deterministic for a given input — two builds of the same commit on the same channel
 * produce the same id, so a rebuild does not needlessly evict every client's cache.
 */
export function buildId(input: BuildIdInput = {}): string {
  const channel = input.channel ?? 'production';
  const base = input.gitSha ?? String(input.timestamp ?? 0);
  if (base === '' || base === '0') {
    throw new BuildIdMissingError(
      'cannot derive a build id: no gitSha and no timestamp',
      'set GIT_SHA in the build environment (docker build --build-arg GIT_SHA=$(git rev-parse HEAD))',
    );
  }
  const short = base.slice(0, 12);
  const ref = input.ref === undefined ? '' : `-${slug(input.ref)}`;
  return channel === 'production' ? short : `${channel}${ref}-${short}`;
}

function slug(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 24);
}

export function assertBuildId(value: string | undefined | null): asserts value is string {
  if (value === undefined || value === null || value.trim() === '') {
    throw new BuildIdMissingError(
      'the build id is empty, so caches cannot be keyed and skew cannot be detected',
      'set GIT_SHA in the build environment and pass it to generateServiceWorker(routes, config, buildId)',
    );
  }
}

/**
 * Every cache name carries the build id, so a preview deploy physically cannot write into
 * the production cache even on the same origin — the classic way a branch deploy poisons
 * production for everyone who visited it once.
 */
export function cacheNamespace(id: string, kind: 'precache' | 'runtime' | 'pages'): string {
  assertBuildId(id);
  return `x-${kind}-${id}`;
}

export interface Deploy {
  readonly buildId: string;
  /** Epoch milliseconds. */
  readonly deployedAt: number;
  readonly channel?: DeployChannel;
}

export interface RetentionPlan {
  readonly retain: readonly string[];
  readonly evict: readonly string[];
  readonly caches: readonly string[];
}

/**
 * Keep the last N builds' assets alive. N is how many deploys a tab may sit open across
 * before it is allowed to break; 3 is the sane default for a daily-deploy team.
 */
export function retentionPlan(deploys: readonly Deploy[], keep = 3): RetentionPlan {
  const ordered = [...deploys].sort((a, b) => b.deployedAt - a.deployedAt);
  const retained = ordered.slice(0, Math.max(1, keep));
  const evicted = ordered.slice(Math.max(1, keep));
  return {
    retain: retained.map((d) => d.buildId),
    evict: evicted.map((d) => d.buildId),
    caches: retained.flatMap((d) => [
      cacheNamespace(d.buildId, 'precache'),
      cacheNamespace(d.buildId, 'runtime'),
      cacheNamespace(d.buildId, 'pages'),
    ]),
  };
}

export type SkewState = 'current' | 'stale' | 'unknown';

/** `unknown` means "no id sent" — a first load, a crawler, or a cache-busted client. */
export function detectSkew(
  clientBuildId: string | null | undefined,
  serverBuildId: string,
): SkewState {
  if (clientBuildId === null || clientBuildId === undefined || clientBuildId.trim() === '') {
    return 'unknown';
  }
  return clientBuildId === serverBuildId ? 'current' : 'stale';
}

export type ForceReason = 'security' | 'breaking-protocol' | 'never';

export interface UpdatePolicyInput {
  /** How long a stale client may keep running before the reload is forced. */
  readonly graceMs?: number;
  readonly forceOn?: readonly ForceReason[];
}

export interface UpdatePolicy {
  readonly graceMs: number;
  readonly forceOn: readonly ForceReason[];
  shouldForce(reason: ForceReason, staleForMs: number): boolean;
}

export const DEFAULT_GRACE_MS = 6 * 60 * 60 * 1000;

export function updatePolicy(input: UpdatePolicyInput = {}): UpdatePolicy {
  const graceMs = input.graceMs ?? DEFAULT_GRACE_MS;
  const forceOn = input.forceOn ?? ['security'];
  return {
    graceMs,
    forceOn,
    // A security patch still respects the grace window; it just does not wait forever.
    shouldForce: (reason, staleForMs) => forceOn.includes(reason) && staleForMs >= graceMs,
  };
}

/**
 * The client-side contract. The SW posts this to every controlled page; the app shows an
 * unobtrusive "refresh to update" affordance and reloads on the user's terms — unless
 * `forced`, in which case it reloads at `deadlineAt`.
 */
export interface AppUpdateAvailable {
  readonly type: 'AppUpdateAvailable';
  readonly from: string;
  readonly to: string;
  readonly forced: boolean;
  /** Epoch milliseconds after which the client reloads itself. Null when not forced. */
  readonly deadlineAt: number | null;
}

export const APP_UPDATE_AVAILABLE = 'AppUpdateAvailable' as const;

export interface UpdateSignalInput {
  readonly clientBuildId: string | null | undefined;
  readonly serverBuildId: string;
  readonly policy: UpdatePolicy;
  readonly reason?: ForceReason;
  readonly staleForMs?: number;
  readonly now?: number;
}

/** Null when the client is current or unknown — no signal, no nag. */
export function updateSignal(input: UpdateSignalInput): AppUpdateAvailable | null {
  const state = detectSkew(input.clientBuildId, input.serverBuildId);
  if (state !== 'stale') return null;

  const reason = input.reason ?? 'never';
  const staleForMs = input.staleForMs ?? 0;
  const forced = input.policy.shouldForce(reason, staleForMs);
  const now = input.now ?? Date.now();

  return {
    type: APP_UPDATE_AVAILABLE,
    from: String(input.clientBuildId),
    to: input.serverBuildId,
    forced,
    deadlineAt: forced ? now : null,
  };
}
