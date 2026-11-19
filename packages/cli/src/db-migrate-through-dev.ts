// `x db migrate` beside a live `x dev` on the embedded database: the pass is asked of the process
// that holds `.x/pgdata` (`dev-db-migrate.ts`'s POST), never applied by a second opener. A holder
// that cannot answer is `X_DEV_ALREADY_RUNNING`, its fix the stop, migrate, start that does work.

import { renderThrowable, UltimateError } from '@ultimat3/core';
import { t } from '@ultimat3/schema';
import type { DevMigrateData } from './dev-db-migrate';
import { DevAlreadyRunningError, type DevLock } from './dev-lock';
import { liveDevLockChecked } from './dev-lock-live';

/** `dev-db-migrate.ts`'s path, restated: importing that module would load the route's graph. */
const MIGRATE_PATH = '/_x/db/migrate';

const DIFFERENCE = t.object({
  kind: t.string,
  table: t.string.min(0),
  column: t.nullable(t.string),
  cause: t.string,
  fix: t.string,
});
const DATA = t.object({
  applied: t.array(t.string),
  skipped: t.number,
  appVersion: t.string,
  durationMs: t.number,
  drift: t.array(DIFFERENCE),
  catalog: t.object({ schema: t.string, tables: t.array(t.json()) }),
  storage: t.array(DIFFERENCE),
});
const PAYLOAD = t.object({
  ok: t.boolean,
  data: t.optional(t.json()),
  error: t.optional(t.object({ code: t.string, cause: t.string, fix: t.string })),
});

/** One POST to the dev server, answered as parsed JSON. A seam so a test needs no server. */
export type PostJson = (url: string) => Promise<unknown>;

/**
 * `Sec-Fetch-Site: same-origin`, as a browser on the app's own origin sends it: the app's CSRF
 * check runs before any route, and a POST carrying neither that nor an `Origin` is
 * `X_CSRF_BLOCKED` on every app with the check on — which read here as "not a route of that x dev"
 * (measured, two processes). A page on another site cannot forge the header; `/_x`'s own doors
 * (loopback Host and peer) still decide who may ask.
 */
export const postJson: PostJson = async (url) =>
  (await (
    await fetch(url, {
      method: 'POST',
      headers: { accept: 'application/json', 'sec-fetch-site': 'same-origin' },
      // A pass is every pending migration; a wedged server must not hold the command for ever.
      signal: AbortSignal.timeout(120_000),
      // `x dev --tls` serves its own development certificate, and this dials loopback only.
      tls: { rejectUnauthorized: false },
    })
  ).json()) as unknown;

/** The holder through loopback, whatever interface it bound: `/_x` answers that Host only. */
function devUrl(lock: DevLock, path: string): string {
  const scheme = URL.parse(lock.url)?.protocol === 'https:' ? 'https' : 'http';
  return `${scheme}://localhost:${lock.port}${path}`;
}

/** One question for the holder: where it is asked, and how its `data` is read. */
export interface DevAsk<T> {
  /** Under `/_x/db`, query included. */
  readonly path: string;
  /** The command as typed (`['db', 'migrate']`): what the fix runs between `x stop` and `x dev`. */
  readonly resume: readonly string[];
  /** `data` as this CLI reads it, or the reason it cannot. */
  readonly read: (data: unknown) => { readonly value: T } | { readonly unreadable: string };
}

/** How long a booting holder is waited for: a large app's `x dev` boots in about half a minute. */
export const BOOT_WAIT_MS = 120_000;
/** How long the lock may be absent — one child gone, the supervisor's next not yet claimed. */
export const LOCK_GAP_MS = 10_000;
const BOOT_POLL_MS = 500;

/** The seams of the wait: a test moves the clock and hands the lock each re-read finds. */
export interface DevWait {
  readonly now: () => number;
  readonly sleep: (ms: number) => Promise<void>;
  /** The live lock as it is now: a restarted child wrote a new one. */
  readonly relock: () => Promise<DevLock | undefined>;
}

const waitFor = (stateDir: string): DevWait => ({
  now: Date.now,
  sleep: (ms) => Bun.sleep(ms),
  relock: () => liveDevLockChecked(stateDir),
});

/**
 * Only a connection the kernel refused: the request was never sent, so asking again cannot run a
 * pass twice. Anything else (a socket closed mid-answer, a timeout) may have reached the holder,
 * and a rollback asked twice reverses two migrations.
 */
const neverSent = (error: unknown): boolean =>
  typeof error === 'object' &&
  error !== null &&
  'code' in error &&
  (error.code === 'ECONNREFUSED' || error.code === 'ConnectionRefused');

/**
 * Asked of the holder, and answered by it. Its own refusal (a failed migration, a forked ledger)
 * is re-thrown under its own code; anything that is not this route's answer — an `x dev` with no
 * web role, an older CLI's server, a closed port — refuses with the fix that needs no holder.
 *
 * A holder that is BOOTING is waited for: its lock is claimed before its port is bound, and a save
 * that restarts the child (an entity edit — the very edit this command follows) leaves exactly
 * that for the length of a boot. Told apart from a server with no listener by the lock itself: a
 * new pid, or a claim stamped inside the wait. Polled, since a boot announces nothing to wait on.
 */
export async function askDev<T>(
  lock: DevLock,
  stateDir: string,
  ask: DevAsk<T>,
  post: PostJson = postJson,
  wait: DevWait = waitFor(stateDir),
): Promise<T> {
  let holder = lock;
  const alone = (unanswered: string): DevAlreadyRunningError =>
    new DevAlreadyRunningError({
      lock: holder,
      stateDir,
      embeddedDb: true,
      resume: ask.resume,
      unanswered,
    });
  const started = wait.now();
  let goneSince: number | undefined;
  let answer: unknown;
  for (;;) {
    const url = devUrl(holder, ask.path);
    try {
      answer = await post(url);
      break;
    } catch (error) {
      const unanswered = `${url} did not answer: ${renderThrowable(error)}`;
      if (!neverSent(error) || wait.now() - started >= BOOT_WAIT_MS) throw alone(unanswered);
      const now = await wait.relock();
      if (now === undefined) {
        goneSince ??= wait.now();
        if (wait.now() - goneSince >= LOCK_GAP_MS) {
          throw alone(`${unanswered}; and that x dev exited while this command waited for it`);
        }
      } else {
        goneSince = undefined;
        const claimedAgo = wait.now() - Date.parse(now.startedAt);
        // `NaN` for a lock with no stamp: not fresh, so not booting.
        if (now.pid === holder.pid && !(claimedAgo < BOOT_WAIT_MS)) throw alone(unanswered);
        holder = now;
      }
      await wait.sleep(BOOT_POLL_MS);
    }
  }
  const url = devUrl(holder, ask.path);
  const payload = PAYLOAD.safeParse(answer);
  if (payload.issues !== undefined) {
    throw alone(`${url} is not a route of that x dev (an older CLI, or no web role)`);
  }
  const { ok, data, error } = payload.value;
  if (!ok && error !== undefined) throw new UltimateError(error);
  const read = ok ? ask.read(data) : { unreadable: 'ok: false' };
  if ('unreadable' in read) {
    throw alone(`${url} answered a pass this CLI cannot read (${read.unreadable})`);
  }
  return read.value;
}

/** The first issue of a failed parse, as `askDev`'s `unreadable` names it. */
export function unreadable(
  issues: readonly { readonly path?: readonly unknown[] | undefined; readonly message: string }[],
): { readonly unreadable: string } {
  const [issue] = issues;
  return {
    unreadable: issue === undefined ? 'ok: false' : `${issue.path?.join('.')}: ${issue.message}`,
  };
}

/** `x db migrate`'s pass, applied by the holder (`dev-db-migrate.ts`). */
export function migrateThroughDev(
  lock: DevLock,
  stateDir: string,
  post: PostJson = postJson,
): Promise<DevMigrateData> {
  return askDev(
    lock,
    stateDir,
    {
      path: MIGRATE_PATH,
      resume: ['db', 'migrate'],
      read: (data) => {
        const parsed = DATA.safeParse(data);
        if (parsed.issues !== undefined) return unreadable(parsed.issues);
        // Narrowed, not re-validated field by field: both ends are this package on one machine,
        // and the catalog is `introspectCatalog`'s own output — `kind` is db's closed set.
        return { value: data as unknown as DevMigrateData };
      },
    },
    post,
  );
}
