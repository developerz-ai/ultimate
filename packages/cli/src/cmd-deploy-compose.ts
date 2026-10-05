// The compose half of `x deploy`'s rollout: which serving roles can start their new container
// BEFORE the old one stops, read off the app's compose file, and the sequence that does it.
// `docker compose up -d <role>` alone is stop-first — it recreates, so the role serves nothing
// between the old container's exit and the new one's healthcheck.

import type { ExecOptions, Runner } from './exec';

/**
 * How one serving role is rolled. `start-first` is the zero-downtime path; `stop-first` is
 * compose's own recreate, kept where two containers of the role cannot coexist, with the reason.
 */
export type ComposeStrategy =
  | { readonly kind: 'start-first'; readonly replicas: number }
  | { readonly kind: 'stop-first'; readonly why: string };

/** The roles that stay up serving — the only ones a rollout strategy applies to. */
export const SERVING_ROLES = ['web', 'sync', 'worker', 'scheduler'] as const;

/**
 * Bounds `--wait`: a new container that never reports healthy fails the step rather than holding
 * the deploy open. Five minutes is past any `start_period` the scaffold declares (30s) plus a cold
 * boot, and `--wait` already returns at once when a container turns `unhealthy` or exits.
 */
export const COMPOSE_WAIT_TIMEOUT_SECONDS = 300;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * The host port a `ports:` entry pins, or `undefined` when Docker picks it. Short syntax is
 * `[[ip:]host:]container[/proto]`: `3000` and `127.0.0.1::3000` leave the host side to Docker, so
 * any number of replicas bind; `3000:3000` and `127.0.0.1:3001:3001` name one, which exactly one
 * container can hold. Long syntax pins one when `published` is said.
 */
function pinnedHostPort(entry: unknown): string | undefined {
  if (isRecord(entry)) {
    const published = entry['published'];
    return published === undefined || published === null || published === ''
      ? undefined
      : String(published);
  }
  if (typeof entry !== 'string') return undefined;
  const spec = entry.replace(/^\[[^\]]*\]:/, '').split('/')[0] ?? '';
  const parts = spec.split(':');
  const host = parts.length === 3 ? parts[1] : parts.length === 2 ? parts[0] : '';
  return host === undefined || host === '' ? undefined : host;
}

/** One service's strategy: start-first unless something in its definition forbids a second copy. */
function strategyOf(service: unknown): ComposeStrategy {
  if (!isRecord(service)) {
    return { kind: 'stop-first', why: 'the compose file declares no such service' };
  }
  if (service['container_name'] !== undefined) {
    return {
      kind: 'stop-first',
      why: 'container_name names exactly one container, so a second replica cannot be created',
    };
  }
  if (service['network_mode'] === 'host') {
    return {
      kind: 'stop-first',
      why: 'network_mode: host binds the host ports directly, so two replicas collide',
    };
  }
  const ports = Array.isArray(service['ports']) ? service['ports'] : [];
  const pinned = ports.map(pinnedHostPort).find((port) => port !== undefined);
  if (pinned !== undefined) {
    return {
      kind: 'stop-first',
      why: `publishes host port ${pinned}, which one container can bind — remove ports: and route through a proxy on the compose network to roll it start-first`,
    };
  }
  const deploy = service['deploy'];
  const declared = isRecord(deploy) ? deploy['replicas'] : undefined;
  const replicas =
    typeof declared === 'number' && Number.isSafeInteger(declared) && declared >= 0 ? declared : 1;
  return { kind: 'start-first', replicas };
}

/**
 * Every serving role's strategy, from the compose file's text. A file that is absent or does not
 * parse decides nothing: every role keeps stop-first, and compose reports the file's own error
 * when the step runs — this reader is never a second validator of it.
 */
export function composeStrategies(text: string | undefined): ReadonlyMap<string, ComposeStrategy> {
  let parsed: unknown;
  try {
    parsed = text === undefined ? undefined : Bun.YAML.parse(text);
  } catch {
    parsed = undefined;
  }
  const services = isRecord(parsed) ? parsed['services'] : undefined;
  if (!isRecord(services)) return new Map();
  return new Map(SERVING_ROLES.map((role) => [role, strategyOf(services[role])]));
}

/** The compose file at `path`, or `undefined` when there is none to read. */
export async function readComposeFile(path: string): Promise<string | undefined> {
  const file = Bun.file(path);
  return (await file.exists()) ? file.text() : undefined;
}

/** The `up` that starts the new replicas beside the running ones; `--no-recreate` keeps the old. */
export function startFirstUp(
  base: readonly string[],
  role: string,
  scale: number | undefined,
): readonly string[] {
  const wait = ['--wait', '--wait-timeout', String(COMPOSE_WAIT_TIMEOUT_SECONDS)];
  return scale === undefined
    ? [...base, 'up', '-d', '--no-deps', ...wait, role]
    : [
        ...base,
        'up',
        '-d',
        '--no-deps',
        '--no-recreate',
        ...wait,
        '--scale',
        `${role}=${scale}`,
        role,
      ];
}

export type StartFirstOutcome =
  | { readonly ok: true }
  | { readonly ok: false; readonly code: number; readonly command: readonly string[] };

const idsOf = (stdout: string): readonly string[] =>
  stdout
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

/**
 * Start-first for one role. The containers running now are listed first; the new ones are
 * created BESIDE them (`--scale running + replicas --no-recreate`, so compose builds the extra
 * containers from the new definition and leaves the old ones alone) and waited on until their
 * healthcheck — `/readyz` for web and sync, the scrape port for the others — answers. Only then
 * are the old containers stopped (SIGTERM, then compose's `stop_grace_period`, which compose
 * stamped on each container as its stop timeout) and removed.
 *
 * A new replica that never turns healthy is stopped and removed, and the old ones keep serving:
 * a failed deploy leaves the role exactly as it found it. The same sequence `docker-rollout`
 * performs, because `deploy.update_config.order: start-first` is a Swarm field `docker compose`
 * ignores.
 */
export async function runStartFirst(step: {
  readonly role: string;
  readonly base: readonly string[];
  readonly replicas: number;
  readonly runner: Runner;
  readonly options: ExecOptions;
}): Promise<StartFirstOutcome> {
  const { role, base, runner, options } = step;
  const run = async (command: readonly string[]) => {
    const result = await runner(command, options);
    return { result, failed: { ok: false as const, code: result.code, command } };
  };
  const listing = await run([...base, 'ps', '-q', role]);
  if (!listing.result.ok) return listing.failed;
  const old = idsOf(listing.result.stdout);
  if (old.length === 0) {
    const fresh = await run(startFirstUp(base, role, undefined));
    return fresh.result.ok ? { ok: true } : fresh.failed;
  }
  const up = await run(startFirstUp(base, role, old.length + step.replicas));
  if (!up.result.ok) {
    // Only what this step created is taken away. A listing that fails here leaves the new
    // replicas to the operator, and the failure reported stays the `up` that caused it.
    const after = await runner([...base, 'ps', '-q', role], options);
    const created = after.ok ? idsOf(after.stdout).filter((id) => !old.includes(id)) : [];
    if (created.length > 0) {
      await runner(['docker', 'stop', ...created], options);
      await runner(['docker', 'rm', ...created], options);
    }
    return up.failed;
  }
  const stopped = await run(['docker', 'stop', ...old]);
  if (!stopped.result.ok) return stopped.failed;
  const removed = await run(['docker', 'rm', ...old]);
  return removed.result.ok ? { ok: true } : removed.failed;
}
