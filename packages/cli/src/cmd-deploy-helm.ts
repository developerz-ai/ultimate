// The helm half of `x deploy`: which release, in which namespace, waited on for how long, and what
// the rollout reported. Split from cmd-deploy.ts, which owns the plan and the compose method.
//
// `helm upgrade --install` with no `--wait` exits 0 the moment the API server ACCEPTS the objects,
// so a deploy whose pods never became ready reported success; and helm's default 5m timeout failed
// an upgrade whose migrate hook was still applying a long migration, leaving the Job running.

// why: Bun exposes no path-join primitive; the chart path is handed to helm as one joined string.
import { join } from 'node:path';
import { UltimateError } from '@ultimat3/core';
import { APP_CONFIG_EXPORT } from './app-auth';
import { APP_CONFIG_FILE } from './app-root';
import { BadFlagError } from './errors';

/** Long enough for a migration a pre-upgrade hook must finish; helm's own 5m default is not. */
export const HELM_DEFAULT_TIMEOUT = '15m';

/** What a helm deploy is aimed at, resolved once from the flags and `app.config.ts`. */
export interface HelmTarget {
  readonly release: string;
  readonly namespace: string | undefined;
  readonly timeout: string;
}

/** Helm's own `time.ParseDuration` grammar, positive units only: `15m`, `900s`, `1h30m`. */
const DURATION = /^(?:\d+(?:h|m|s|ms))+$/;
/** A namespace and a release are both DNS-1123 labels; helm caps a release at 53 characters. */
const LABEL = /^[a-z0-9](?:[-a-z0-9]*[a-z0-9])?$/;
const RELEASE_MAX = 53;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;

/** `--timeout`, screened: a value helm would reject is refused before anything is spawned. */
export function readHelmTimeout(raw: string | undefined): string {
  if (raw === undefined) return HELM_DEFAULT_TIMEOUT;
  if (DURATION.test(raw) && /[1-9]/.test(raw)) return raw;
  throw new BadFlagError({
    flag: 'timeout',
    command: 'deploy',
    reason: 'it is not a positive helm duration such as 15m, 900s or 1h30m',
    fix: 'x deploy --method helm --timeout 15m --json',
  });
}

/** `--namespace` and `--release`, each a DNS-1123 label or a refusal naming the flag. */
export function readLabel(flag: 'namespace' | 'release', raw: string): string {
  const max = flag === 'release' ? RELEASE_MAX : 63;
  if (raw.length <= max && LABEL.test(raw)) return raw;
  throw new BadFlagError({
    flag,
    command: 'deploy',
    reason: `it must be a lowercase DNS-1123 label of at most ${max} characters`,
    fix:
      flag === 'release'
        ? 'x deploy --method helm --release my-app --json'
        : 'x deploy --method helm --namespace my-namespace --json',
  });
}

/**
 * The release name: `--release`, else `app.config.ts`'s `name`. It was the literal `app` for every
 * app, so two apps deployed to one namespace were one release and the second upgrade replaced the
 * first. `--release` exists for a release that already carries another name — `app`, for every
 * cluster an earlier version deployed to — because a release name is cluster state the framework
 * does not own and cannot rename.
 */
export async function readReleaseName(root: string, flag: string | undefined): Promise<string> {
  if (flag !== undefined) return readLabel('release', flag);
  const module = (await import(join(root, APP_CONFIG_FILE))) as Record<string, unknown>;
  const config = module[APP_CONFIG_EXPORT];
  const name = isRecord(config) ? config['name'] : undefined;
  if (typeof name === 'string' && name.length <= RELEASE_MAX && LABEL.test(name)) return name;
  throw new UltimateError({
    code: 'X_CONFIG_INVALID',
    cause:
      typeof name === 'string'
        ? `app.config.ts names the app "${name.slice(0, 80)}", which is not a helm release name (a DNS-1123 label of at most ${RELEASE_MAX} characters)`
        : 'app.config.ts exports no config.name, and x deploy --method helm names the release after it',
    fix: 'name the release explicitly: x deploy --method helm --release my-app --json',
  });
}

/** The one `helm upgrade`, waited on: `--wait` for the rollout, `--output json` for the verdict. */
export function helmUpgradeArgs(
  root: string,
  target: HelmTarget,
  imageOverrides: readonly string[],
): readonly string[] {
  return [
    'helm',
    'upgrade',
    '--install',
    target.release,
    join(root, 'docker', 'helm'),
    ...(target.namespace === undefined ? [] : ['--namespace', target.namespace]),
    '--wait',
    '--timeout',
    target.timeout,
    '--output',
    'json',
    ...imageOverrides,
  ];
}

/** What `--json` reports about the rollout helm waited on. */
export interface Rollout {
  readonly release: string;
  readonly namespace: string | null;
  readonly revision: number | null;
  readonly status: string;
}

/**
 * helm's `--output json` release record, read structurally. `status` is helm's own word —
 * `deployed`, `failed`, `pending-upgrade` — and `unknown` only when helm printed no record at all,
 * never a guess dressed as one.
 */
export function readRollout(target: HelmTarget, stdout: string): Rollout {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    parsed = undefined;
  }
  const info = isRecord(parsed) ? parsed['info'] : undefined;
  const status = isRecord(info) ? info['status'] : undefined;
  const revision = isRecord(parsed) ? parsed['version'] : undefined;
  const namespace = isRecord(parsed) ? parsed['namespace'] : undefined;
  return {
    release: target.release,
    namespace: typeof namespace === 'string' ? namespace : (target.namespace ?? null),
    revision: typeof revision === 'number' ? revision : null,
    status: typeof status === 'string' ? status : 'unknown',
  };
}
