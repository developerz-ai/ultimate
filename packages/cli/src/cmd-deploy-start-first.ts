// One compose role rolled start-first: the new containers come up beside the old ones, are waited
// on until healthy, and only then are the old ones stopped and removed, converging on the declared
// replica count. A replica is the requested version only when compose's config hash AND the image
// it runs BOTH match: a tag republished under the same name leaves that hash untouched.

import type { ExecOptions, Runner } from './exec';

/**
 * Bounds `--wait`: a new container that never reports healthy fails the step rather than holding
 * the deploy open. Five minutes is past any `start_period` the scaffold declares (30s) plus a cold
 * boot, and `--wait` already returns at once when a container turns `unhealthy` or exits.
 */
export const COMPOSE_WAIT_TIMEOUT_SECONDS = 300;

/** The label compose stamps on each container: the hash of the service definition it was made from. */
const CONFIG_HASH = 'com.docker.compose.config-hash';

/**
 * One `docker inspect` reads BOTH facts a replica carries: the definition it was made from (the
 * config hash) and the build it runs (the image id). One call, one format string — two calls could
 * describe two different moments, and the pair would be a fiction.
 */
const INSPECT_FORMAT = `{{.Id}} {{.Created}} {{index .Config.Labels "${CONFIG_HASH}"}} {{.Image}}`;

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
 * The running containers split by the TWO facts a replica carries: `current` already runs the one
 * being deployed (newest first), `stale` anything else. A container `inspect` did not describe is
 * stale — stopping one too many is a restart, keeping one too many is the old build serving.
 *
 * BOTH facts must match: compose's config hash (the definition) AND the image id (the build). The
 * hash alone is not enough — a tag republished under the same name leaves the compose file, and
 * with it that hash, untouched, so the previous build would hash-match and the deploy would report
 * a rollout it never did.
 *
 * A requested image whose id could not be resolved is UNKNOWN, and unknown is never read as
 * "unchanged": every replica is then stale — the safe direction, the role is rolled and compose
 * fetches the image during the `up`.
 */
function partition(
  running: readonly string[],
  inspected: string,
  want: string,
  wantImage: string | undefined,
): { readonly current: readonly string[]; readonly stale: readonly string[] } {
  const described = new Map(
    linesOf(inspected).map((line) => {
      const [id = '', created = '', hash = '', image = ''] = line.split(/\s+/);
      return [id, { created, hash, image }] as const;
    }),
  );
  const facts = running.map((id) => {
    const match = [...described].find(([full]) => full === id || full.startsWith(id));
    return {
      id,
      created: match?.[1].created ?? '',
      hash: match?.[1].hash,
      image: match?.[1].image,
    };
  });
  return {
    current: facts
      .filter((fact) => wantImage !== undefined && fact.hash === want && fact.image === wantImage)
      .sort((a, b) => (a.created < b.created ? 1 : -1))
      .map((fact) => fact.id),
    stale: facts
      .filter((fact) => wantImage === undefined || fact.hash !== want || fact.image !== wantImage)
      .map((fact) => fact.id),
  };
}

/**
 * Start-first for one role. The containers running now are listed and split against the version
 * being deployed: those already on it — compose's config hash AND the image id they run — are kept
 * (up to `replicas`, newest first), and only the shortfall is created BESIDE the rest (`--scale
 * running + shortfall --no-recreate`, so compose builds the extra containers from the new
 * definition and leaves the others alone). Everything is waited on until its healthcheck — `/readyz`
 * for web and sync, the scrape port for the others — answers. Only then are the stale containers
 * and any surplus stopped (SIGTERM, then the `stop_grace_period` compose stamped on each as its
 * stop timeout) and removed.
 *
 * The image id is half of what "the version being deployed" means, and the hash cannot carry it:
 * a tag republished under the same name leaves the compose file, and with it the config hash,
 * untouched — the hash alone would call the previous build the requested one, the shortfall would
 * be zero, and the deploy would report a rollout it never did. The requested id is the one the
 * deploy was ASKED for (the `--image` reference) resolves to on the daemon; a reference that
 * resolves to nothing is UNKNOWN, and unknown is never read as "unchanged": every container is
 * then stale and the role is rolled — compose fetches the image during the `up`.
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
  /** The reference the deploy was asked for — the image the plan reports and compose runs. */
  readonly image: string;
  readonly runner: Runner;
  readonly options: ExecOptions;
}): Promise<StartFirstOutcome> {
  const { role, base, replicas, image, runner, options } = step;
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
  // The id the REQUESTED reference resolves to on the daemon. Unresolved is UNKNOWN and not a
  // failure: compose fetches the image during the `up`, so a tag that is not on the daemon yet is
  // the ordinary case — and unknown must never read as "unchanged" (see `partition`).
  const resolved = await runner(
    ['docker', 'image', 'inspect', '--format', '{{.Id}}', image],
    options,
  );
  const wantImage = resolved.ok ? linesOf(resolved.stdout)[0] : undefined;
  const { current, stale } = partition(
    running,
    inspect.result.stdout,
    hashOf(config.result.stdout) ?? '',
    wantImage,
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
