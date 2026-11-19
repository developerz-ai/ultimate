// `x db migrate` beside a live `x dev` on the embedded database: the pass is asked of the process
// that holds `.x/pgdata` (`dev-db-migrate.ts`'s POST), never applied by a second opener. A holder
// that cannot answer is `X_DEV_ALREADY_RUNNING`, its fix the stop, migrate, start that does work.

import { renderThrowable, UltimateError } from '@ultimat3/core';
import { t } from '@ultimat3/schema';
import type { DevMigrateData } from './dev-db-migrate';
import { DevAlreadyRunningError, type DevLock } from './dev-lock';

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

/** No `Origin` and no `Sec-Fetch-Site`: the door reads that as a local tool, never a page. */
export const postJson: PostJson = async (url) =>
  (await (
    await fetch(url, {
      method: 'POST',
      headers: { accept: 'application/json' },
      // A pass is every pending migration; a wedged server must not hold the command for ever.
      signal: AbortSignal.timeout(120_000),
      // `x dev --tls` serves its own development certificate, and this dials loopback only.
      tls: { rejectUnauthorized: false },
    })
  ).json()) as unknown;

/** The holder through loopback, whatever interface it bound: `/_x` answers that Host only. */
function migrateUrl(lock: DevLock): string {
  const scheme = URL.parse(lock.url)?.protocol === 'https:' ? 'https' : 'http';
  return `${scheme}://localhost:${lock.port}${MIGRATE_PATH}`;
}

/**
 * The pass, applied by the holder. Its own refusal (a failed migration, a forked ledger) is
 * re-thrown under its own code; anything that is not this route's answer — an `x dev` with no web
 * role, an older CLI's server, a closed port — refuses with the fix that needs no holder.
 */
export async function migrateThroughDev(
  lock: DevLock,
  stateDir: string,
  post: PostJson = postJson,
): Promise<DevMigrateData> {
  const alone = (unanswered: string): DevAlreadyRunningError =>
    new DevAlreadyRunningError({
      lock,
      stateDir,
      embeddedDb: true,
      resume: ['db', 'migrate'],
      unanswered,
    });
  const url = migrateUrl(lock);
  let answer: unknown;
  try {
    answer = await post(url);
  } catch (error) {
    throw alone(`${url} did not answer: ${renderThrowable(error)}`);
  }
  const payload = PAYLOAD.safeParse(answer);
  if (payload.issues !== undefined) {
    throw alone(`${url} is not a route of that x dev (an older CLI, or no web role)`);
  }
  const { ok, data, error } = payload.value;
  if (!ok && error !== undefined) throw new UltimateError(error);
  const parsed = DATA.safeParse(data);
  if (!ok || parsed.issues !== undefined) {
    const [issue] = parsed.issues ?? [];
    const where = issue === undefined ? 'ok: false' : `${issue.path?.join('.')}: ${issue.message}`;
    throw alone(`${url} answered a pass this CLI cannot read (${where})`);
  }
  // Narrowed, not re-validated field by field: both ends are this package on one machine, and the
  // catalog is `introspectCatalog`'s own output — `kind` is db's closed set, written by db.
  return data as unknown as DevMigrateData;
}
