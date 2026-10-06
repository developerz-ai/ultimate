// One compose role rolled start-first: the new containers come up beside the old ones, are waited
// on until healthy, and only then are the old ones stopped and removed. Converges on the declared
// replica count, so a rerun after a half-finished deploy finishes it rather than adding replicas.

import type { ExecOptions, Runner } from './exec';

/**
 * Bounds `--wait`: a new container that never reports healthy fails the step rather than holding
 * the deploy open. Five minutes is past any `start_period` the scaffold declares (30s) plus a cold
 * boot, and `--wait` already returns at once when a container turns `unhealthy` or exits.
 */
export const COMPOSE_WAIT_TIMEOUT_SECONDS = 300;

/** The label compose stamps on each container: the hash of the service definition it was made from. */
const CONFIG_HASH = 'com.docker.compose.config-hash';
const INSPECT_FORMAT = `{{.Id}} {{.Created}} {{index .Config.Labels "${CONFIG_HASH}"}}`;

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

interface Failed {
  readonly code: number;
  readonly command: readonly string[];
}

export type StartFirstOutcome =
  | { readonly ok: true }
  | ({
      readonly ok: false;
      /**
       * The cleanup of an unhealthy new replica that ALSO failed — its argv names the containers
       * still running, which the operator now owns. Absent when the cleanup ran clean.
       */
      readonly cleanup?: Failed | undefined;
    } & Failed);

const linesOf = (stdout: string): readonly string[] =>
  stdout
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

/** `docker compose config --hash <role>` prints `<role> <hash>`. */
const hashOf = (stdout: string): string | undefined => linesOf(stdout)[0]?.split(/\s+/)[1];

/**
 * The running containers split by the definition they were made from: `current` already runs the
 * one being deployed (newest first), `stale` anything else. A container `inspect` did not describe
 * is stale — stopping one too many is a restart, keeping one too many is the old build serving.
 */
function partition(
  running: readonly string[],
  inspected: string,
  want: string,
): { readonly current: readonly string[]; readonly stale: readonly string[] } {
  const described = new Map(
    linesOf(inspected).map((line) => {
      const [id = '', created = '', hash = ''] = line.split(/\s+/);
      return [id, { created, hash }] as const;
    }),
  );
  const facts = running.map((id) => {
    const match = [...described].find(([full]) => full === id || full.startsWith(id));
    return { id, created: match?.[1].created ?? '', hash: match?.[1].hash };
  });
  return {
    current: facts
      .filter((fact) => fact.hash === want)
      .sort((a, b) => (a.created < b.created ? 1 : -1))
      .map((fact) => fact.id),
    stale: facts.filter((fact) => fact.hash !== want).map((fact) => fact.id),
  };
}

/**
 * Start-first for one role. The containers running now are listed and split by compose's config
 * hash against the definition being deployed: those already on it are kept (up to `replicas`,
 * newest first), and only the shortfall is created BESIDE the rest (`--scale running + shortfall
 * --no-recreate`, so compose builds the extra containers from the new definition and leaves the
 * others alone). Everything is waited on until its healthcheck — `/readyz` for web and sync, the
 * scrape port for the others — answers. Only then are the stale containers and any surplus stopped
 * (SIGTERM, then the `stop_grace_period` compose stamped on each as its stop timeout) and removed.
 *
 * Counting the shortfall rather than `running + replicas` is what makes a rerun safe: after a
 * deploy that brought the new containers up and then failed to stop the old, running it again
 * creates nothing and finishes the stop.
 *
 * A new replica that never turns healthy is stopped and removed, and the old ones keep serving;
 * a cleanup that fails is reported beside the failure, naming the containers left running. The
 * same sequence `docker-rollout` performs, because `deploy.update_config.order: start-first` is a
 * Swarm field `docker compose` ignores.
 */
export async function runStartFirst(step: {
  readonly role: string;
  readonly base: readonly string[];
  readonly replicas: number;
  readonly runner: Runner;
  readonly options: ExecOptions;
}): Promise<StartFirstOutcome> {
  const { role, base, replicas, runner, options } = step;
  const run = async (command: readonly string[]) => {
    const result = await runner(command, options);
    return { result, failed: { ok: false as const, code: result.code, command } };
  };
  const listing = await run([...base, 'ps', '-q', role]);
  if (!listing.result.ok) return listing.failed;
  const running = linesOf(listing.result.stdout);
  if (running.length === 0) {
    const fresh = await run(startFirstUp(base, role, undefined));
    return fresh.result.ok ? { ok: true } : fresh.failed;
  }
  const config = await run([...base, 'config', '--hash', role]);
  if (!config.result.ok) return config.failed;
  const inspect = await run(['docker', 'inspect', '--format', INSPECT_FORMAT, ...running]);
  if (!inspect.result.ok) return inspect.failed;
  const { current, stale } = partition(
    running,
    inspect.result.stdout,
    hashOf(config.result.stdout) ?? '',
  );
  const shortfall = Math.max(0, replicas - current.length);
  const up = await run(startFirstUp(base, role, running.length + shortfall));
  if (!up.result.ok) return { ...up.failed, ...(await removeCreated(step, running)) };
  const retire = [...stale, ...current.slice(replicas)];
  if (retire.length === 0) return { ok: true };
  const stopped = await run(['docker', 'stop', ...retire]);
  if (!stopped.result.ok) return stopped.failed;
  const removed = await run(['docker', 'rm', ...retire]);
  return removed.result.ok ? { ok: true } : removed.failed;
}

/**
 * After a failed `up`: stop and remove what it created, so the containers that were serving are
 * the role again. A listing that fails leaves the new replicas to the operator; a stop or rm that
 * fails is returned as `cleanup`, its argv naming the containers still there.
 */
async function removeCreated(
  step: {
    readonly role: string;
    readonly base: readonly string[];
    readonly runner: Runner;
    readonly options: ExecOptions;
  },
  running: readonly string[],
): Promise<{ readonly cleanup?: Failed }> {
  const { role, base, runner, options } = step;
  const after = await runner([...base, 'ps', '-q', role], options);
  if (!after.ok) return { cleanup: { code: after.code, command: [...base, 'ps', '-q', role] } };
  const created = linesOf(after.stdout).filter((id) => !running.includes(id));
  if (created.length === 0) return {};
  for (const command of [
    ['docker', 'stop', ...created],
    ['docker', 'rm', ...created],
  ]) {
    const result = await runner(command, options);
    if (!result.ok) return { cleanup: { code: result.code, command } };
  }
  return {};
}
