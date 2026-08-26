/**
 * Version skew — what actually breaks PWAs. A client that loaded build A keeps running
 * for hours; build B deletes A's chunks; the next lazy import 404s and the app dies with
 * a blank screen. Nothing here is optional:
 *
 *   immutable build id per deploy → the client sends it on every request →
 *   old builds' assets are retained for N deploys → a stale client gets
 *   `AppUpdateAvailable`, never a 404.
 *
 * The app decides what to do with that message. This package never navigates a client.
 */

import { finiteCount } from '@ultimat3/core';
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
  // `Math.max` is not a validator, it PROPAGATES: `Math.max(1, NaN)` is `NaN`, `slice(0, NaN)` is
  // `[]`, and the plan then retains nothing and evicts every deploy — the running one included,
  // which is the case `never evicts everything` pins as impossible. `0` keeps its meaning below.
  const bound = Math.max(1, finiteCount('retentionPlan', 'keep', keep));
  const ordered = [...deploys].sort((a, b) => b.deployedAt - a.deployedAt);
  const retained = ordered.slice(0, bound);
  const evicted = ordered.slice(bound);
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

/**
 * The client-side contract, and the whole of it: what the generated worker posts to every page it
 * controls on activation. The page compares `to` against its own `BUILD_ID_META` — `detectSkew`
 * is that comparison — and renders its own "refresh to update" affordance.
 *
 * It declared `from`, `forced` and `deadlineAt` too, for a forced reload after a grace period that
 * NOTHING performed: `updateSignal`/`updatePolicy` computed the three and had no runtime caller,
 * and `x deploy --critical`, the flag that was to have set the reason, was removed in 4.0.0 for
 * being read by nobody. The two runtimes that hold both build ids cannot call into this package
 * anyway — `http`'s `ctx.clientBuildId` (tier 2) and `sync`'s `update-available` frame (tier 3)
 * are both BELOW `pwa`, and imports only go down. `version-skew.test.ts` holds this interface to
 * the literal the worker emits, so the two can no longer differ.
 */
export interface AppUpdateAvailable {
  readonly type: 'AppUpdateAvailable';
  /** The build the worker that posted this was generated for. */
  readonly to: string;
}

export const APP_UPDATE_AVAILABLE = 'AppUpdateAvailable' as const;
