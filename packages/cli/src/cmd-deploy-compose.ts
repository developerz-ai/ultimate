// The compose half of `x deploy`'s rollout: which serving roles can start their new container
// BEFORE the old one stops, read off the app's compose file. The sequence that does it is
// `cmd-deploy-start-first.ts`.
// `docker compose up -d <role>` alone is stop-first — it recreates, so the role serves nothing
// between the old container's exit and the new one's healthcheck.

/**
 * How one serving role is rolled. `start-first` is the zero-downtime path; `stop-first` is
 * compose's own recreate, kept where two containers of the role cannot coexist, with the reason.
 */
export type ComposeStrategy =
  | { readonly kind: 'start-first'; readonly replicas: number }
  | { readonly kind: 'stop-first'; readonly why: string };

/** The roles that stay up serving — the only ones a rollout strategy applies to. */
export const SERVING_ROLES = ['web', 'sync', 'worker', 'scheduler'] as const;

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
