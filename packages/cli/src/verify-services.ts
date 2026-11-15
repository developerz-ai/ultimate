// The test database the `live` step needs, found or started: the env file `x new` writes names
// where the suites look (`docker/test-services.env`), and its compose file is what starts them.
// Split from `verify-live.ts`, which decides WHEN; this file owns how a server is found ours (it
// answers, and takes our login) and the one `docker compose` line that brings it up.

// why: Bun ships no synchronous existence check or path-join primitive.
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { renderThrowable } from '@ultimat3/core';
import type { Runner } from './exec';
import { execOutput } from './exec';
import type { Finding } from './output';
import { TEST_COMPOSE_PATH, TEST_ENV_PATH } from './templates/scaffold-test-services';
import { parseDotenvValues } from './test-dotenv';

/** The URL every live suite reads first; the one this file probes. */
export const TEST_DATABASE_KEY = 'TEST_DATABASE_URL';

/** The command the scaffold's own docs name, verbatim: the fix is the line a human would run. */
export const SERVICES_UP: readonly string[] = [
  'docker',
  'compose',
  '-f',
  TEST_COMPOSE_PATH,
  'up',
  '-d',
  '--wait',
];
export const SERVICES_DOWN = `docker compose -f ${TEST_COMPOSE_PATH} down`;

/** Whether something accepts a TCP connection at a URL's host and port. Injected in tests. */
export type Probe = (url: string) => Promise<boolean>;

/** Postgres's own port, for a URL that names none. */
const DEFAULT_PORT = 5432;
const PROBE_TIMEOUT_MS = 1000;

/**
 * A TCP connect and nothing more: no handshake, no credentials. "Nothing listens" is the only
 * question here — a server that listens and refuses the login is the suite's to report, with the
 * driver's own error, not this probe's to guess at.
 */
export const tcpReachable: Probe = async (url) => {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  const hostname = parsed.hostname.replace(/^\[|\]$/g, '');
  const port = parsed.port === '' ? DEFAULT_PORT : Number(parsed.port);
  const { promise, resolve } = Promise.withResolvers<boolean>();
  const timer = setTimeout(() => resolve(false), PROBE_TIMEOUT_MS);
  const settle = (reachable: boolean) => {
    clearTimeout(timer);
    resolve(reachable);
  };
  Bun.connect({
    hostname,
    port,
    socket: {
      open: (socket) => {
        socket.end();
        settle(true);
      },
      connectError: () => settle(false),
      data: () => undefined,
    },
  }).catch(() => settle(false));
  return promise;
};

/** Whether the declared credentials log in: `refused` only on the server's own no. */
export type LoginVerdict = 'ok' | 'refused' | 'unknown';
export type LoginProbe = (url: string) => Promise<LoginVerdict>;

/** SQLSTATEs that mean "a Postgres answered and this is not our login": auth, role, database. */
const NOT_OURS = new Set(['28P01', '28000', '3D000']);

const sqlStateOf = (error: unknown): string | undefined => {
  if (typeof error !== 'object' || error === null) return undefined;
  const { errno, code } = error as { readonly errno?: unknown; readonly code?: unknown };
  if (typeof errno === 'string') return errno;
  return typeof code === 'string' ? code : undefined;
};

/**
 * One `select 1` with the env file's own credentials. A port that answers TCP may be ANOTHER app's
 * test stack — two scaffolds once shared one port — and its refusal is the only way to tell.
 * Anything but a refusal is `unknown`: the suite reports it with the driver's own error.
 */
export const postgresLogin: LoginProbe = async (url) => {
  let sql: Bun.SQL | undefined;
  try {
    sql = new Bun.SQL(url, { max: 1, connectionTimeout: 2, idleTimeout: 1 });
    await sql`select 1`;
    return 'ok';
  } catch (error) {
    const state = sqlStateOf(error);
    return state !== undefined && NOT_OURS.has(state) ? 'refused' : 'unknown';
  } finally {
    await sql?.close().catch(() => undefined);
  }
};

const portOf = (url: string): string => {
  try {
    const parsed = new URL(url);
    return parsed.port === '' ? String(DEFAULT_PORT) : parsed.port;
  } catch {
    return String(DEFAULT_PORT);
  }
};

const hostOf = (url: string): string => {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
};

/** Something else holds the declared port: named, with the line that shows which container. */
const foreignFinding = (url: string): Finding => ({
  code: 'X_TEST_SERVICES_UNAVAILABLE',
  cause: `a Postgres answers at ${hostOf(url)} (${TEST_ENV_PATH}'s ${TEST_DATABASE_KEY}) and refuses this app's credentials — another app's test stack holds the port, so the live suites are not run against it`,
  fix: `docker ps --filter publish=${portOf(url)}   # stop that stack (docker compose -p <project> down), or give this app another port in ${TEST_COMPOSE_PATH} and ${TEST_ENV_PATH}`,
  at: TEST_ENV_PATH,
});

/** What `ensureTestServices` found: the env to hand the suites, and what happened on the way. */
export type ServicesVerdict =
  /** Nothing to do: the caller's own URL, or a repo with no test stack to start. */
  | { readonly kind: 'ambient' }
  /** The stack was already listening; the env file's values, for the keys the caller left unset. */
  | { readonly kind: 'reachable'; readonly env: Readonly<Record<string, string>> }
  /** This run started it, and left it running. */
  | { readonly kind: 'started'; readonly env: Readonly<Record<string, string>> }
  /** It could not be started: the suites run as they would have, and this says why. */
  | { readonly kind: 'unavailable'; readonly finding: Finding };

export interface ServicesInput {
  readonly root: string;
  readonly runner: Runner;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly probe?: Probe;
  readonly login?: LoginProbe;
}

/** The env file's values for every key the caller's own environment does not already set. */
const unsetFrom = (
  file: ReadonlyMap<string, string>,
  env: ServicesInput['env'],
): Readonly<Record<string, string>> => {
  const out = new Map<string, string>();
  for (const [key, value] of file) if (env[key] === undefined) out.set(key, value);
  return Object.fromEntries(out);
};

/**
 * Found or started, never torn down: the stack is RAM-only and starts in seconds, so the next run
 * reuses it and the warning names `SERVICES_DOWN`. A caller URL that is NOT the env file's is the
 * caller's own server — never second-guessed, reachable or not.
 */
export async function ensureTestServices(input: ServicesInput): Promise<ServicesVerdict> {
  const compose = join(input.root, TEST_COMPOSE_PATH);
  const envFile = join(input.root, TEST_ENV_PATH);
  if (!existsSync(compose) || !existsSync(envFile)) return { kind: 'ambient' };
  const file = parseDotenvValues(await Bun.file(envFile).text());
  const declared = file.get(TEST_DATABASE_KEY);
  const ambient = input.env[TEST_DATABASE_KEY];
  if (declared === undefined) return { kind: 'ambient' };
  if (ambient !== undefined && ambient !== declared) return { kind: 'ambient' };
  const env = unsetFrom(file, input.env);
  if (await (input.probe ?? tcpReachable)(declared)) {
    const login = await (input.login ?? postgresLogin)(declared);
    return login === 'refused'
      ? { kind: 'unavailable', finding: foreignFinding(declared) }
      : { kind: 'reachable', env };
  }
  const refused = await startStack(input);
  return refused === undefined
    ? { kind: 'started', env }
    : { kind: 'unavailable', finding: refused };
}

/** `undefined` when the stack came up; otherwise the finding naming why and the line to run. */
async function startStack(input: ServicesInput): Promise<Finding | undefined> {
  let why: string;
  try {
    const result = await input.runner(SERVICES_UP, { cwd: input.root });
    if (result.ok) return undefined;
    why = `it exited ${String(result.code)}: ${execOutput(result).slice(-400)}`;
  } catch (error) {
    // No `docker` on PATH: `exec.ts` raises its own coded refusal, rendered here, never thrown —
    // a missing container runtime costs the live suites their database, not the whole gate.
    why = renderThrowable(error);
  }
  return {
    code: 'X_TEST_SERVICES_UNAVAILABLE',
    cause: `no test database answers at ${TEST_ENV_PATH}'s ${TEST_DATABASE_KEY}, and \`${SERVICES_UP.join(' ')}\` could not start one — ${why}`,
    fix: `${SERVICES_UP.join(' ')}   # needs Docker running; or export ${TEST_DATABASE_KEY} to a Postgres you run`,
    at: TEST_COMPOSE_PATH,
  };
}
