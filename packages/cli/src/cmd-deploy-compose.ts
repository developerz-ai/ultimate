// The compose half of `x deploy`, read off the app's compose file: which serving roles can start
// their new container BEFORE the old one stops (the sequence is `cmd-deploy-start-first.ts`), and
// what the file demands of `.env.production` — read by the deploy's pre-flight and `x env init`.
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
  const strategies = new Map<string, ComposeStrategy>(
    SERVING_ROLES.map((role) => [role, strategyOf(services[role])]),
  );
  if (Object.hasOwn(services, 'replicator')) {
    strategies.set('replicator', {
      kind: 'stop-first',
      why: 'the replicator is a singleton: the old process must stop before its replacement starts',
    });
  }
  return strategies;
}

/** The compose file at `path`, or `undefined` when there is none to read. */
export async function readComposeFile(path: string): Promise<string | undefined> {
  const file = Bun.file(path);
  return (await file.exists()) ? file.text() : undefined;
}

/**
 * The reference `x build --target docker` tags and `x deploy` deploys when neither is given one
 * (`cmd-build.ts` spells the same literal). `x env init` writes it as `IMAGE`, so a compose command
 * run by hand reaches the image the build made rather than the compose file's own default.
 */
export const DEFAULT_IMAGE = 'ultimate-app:dev';

/**
 * Every variable the file interpolates with `${VAR:?…}` or `${VAR?…}`, in first-use order — the
 * ones compose refuses to parse without. Read off the text, not the parse: YAML keeps the
 * interpolation inside a string, wherever in the document it sits. Comment lines are skipped.
 */
export function composeRequiredVars(text: string): readonly string[] {
  // A comment line is never interpolated, and the scaffold's header spells `${VAR:?…}` in prose.
  const live = text
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('#'))
    .join('\n');
  const names = [...live.matchAll(/\$\{([A-Za-z_][A-Za-z0-9_]*):?\?/g)].map((m) => m[1] ?? '');
  return [...new Set(names)];
}

/** The `db` service's role and database, which a `DATABASE_URL` for this file must name. */
export interface ComposeDatabase {
  readonly user: string;
  readonly database: string;
}

/** One `environment:` entry, from either of compose's two spellings (map or `KEY=value` list). */
function environmentValue(environment: unknown, key: string): string | undefined {
  if (isRecord(environment)) {
    const value = environment[key];
    return typeof value === 'string' || typeof value === 'number' ? String(value) : undefined;
  }
  if (!Array.isArray(environment)) return undefined;
  const entry = environment.find((e) => typeof e === 'string' && e.startsWith(`${key}=`));
  return typeof entry === 'string' ? entry.slice(key.length + 1) : undefined;
}

/**
 * The `db` service's Postgres role and database: the image's defaults (`postgres`, and a database
 * named after the role) unless `POSTGRES_USER` / `POSTGRES_DB` say otherwise. `undefined` when the
 * file runs no `db` service, so the database is the operator's and no URL can be derived.
 */
export function composeDatabase(text: string | undefined): ComposeDatabase | undefined {
  let parsed: unknown;
  try {
    parsed = text === undefined ? undefined : Bun.YAML.parse(text);
  } catch {
    return undefined;
  }
  const services = isRecord(parsed) ? parsed['services'] : undefined;
  const db = isRecord(services) ? services['db'] : undefined;
  if (!isRecord(db)) return undefined;
  const user = environmentValue(db['environment'], 'POSTGRES_USER') ?? 'postgres';
  return { user, database: environmentValue(db['environment'], 'POSTGRES_DB') ?? user };
}
