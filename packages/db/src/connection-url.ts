// Single responsibility: turning `DATABASE_URL` plus a resolved pool profile into the connection
// string the driver opens — the libpq `options` merge and the `application_name` label. Split from
// `client.ts` because which settings reach a connection is a rule, not a step of connecting.

import { describeValue } from '@ultimat3/core';
import { dbUnavailable } from './errors';
import { declaresLibpqOption, mergeLibpqOptions } from './libpq-options';
import type { PoolProfile } from './pool-profile';

export interface ConnectionUrlOptions {
  readonly url?: string | undefined;
  readonly applicationName?: string | undefined;
}

export function connectionUrl(options: ConnectionUrlOptions, profile: PoolProfile): string {
  const raw = options.url ?? process.env['DATABASE_URL'];
  if (raw === undefined || raw === '') {
    throw dbUnavailable('DATABASE_URL is not set, so there is no database to connect to');
  }
  let url: URL;
  try {
    url = new URL(raw);
  } catch (error) {
    // The SHAPE of the rejected value, never the value. A connection string is
    // `user:password@host` by construction, and this `cause` is the boot log line AND the `--json`
    // payload — the logger redacts `fields` by key, so a password baked into a message has no key
    // left to redact it by. `@ultimat3/core`'s `defineEnv` reached the identical conclusion about
    // the identical variable (`packages/core/src/env.ts`); this is the same rule at the second
    // reader, not a second rule. The value still has a printer: `x env check`, through
    // `maskedEnvValues`.
    throw dbUnavailable(`DATABASE_URL is not a valid url: received ${describeValue(raw)}`, error);
  }
  // libpq `options` is the portable way to pin a statement timeout for every pooled connection —
  // MERGED into the operator's own, never assigned over it, and emitted for every role including
  // the two whose bound is 0. `set` here dropped a `?options=-c search_path=app` on `web`, `sync`,
  // `worker` and `scheduler` and kept it on `migrate` and `replicator`, so the role that runs the
  // migrations and the role that serves the traffic read different schemas. 0 is a value, not a
  // silence: it is `migrate` saying it may take as long as it takes, and left unsaid a server-side
  // `alter database ... set statement_timeout` kills the one role that must outlive it.
  // `application_name` is a LABEL, not a bound: 'ultimate' is a DEFAULT, and a default may not
  // overwrite what the operator wrote — `?application_name=billing-api` is the filter their
  // `pg_stat_activity` query, their pooler rule and their audit rule all match on, and losing it
  // is silent. Both spellings count, or the URL parameter and a `-c application_name=` in
  // `options` disagree and which one the backend honours is argument order nobody here measured.
  const named = options.applicationName;
  const settings: Record<string, string> = {
    statement_timeout: String(profile.statementTimeoutMs),
  };
  const inOptions = declaresLibpqOption(url.searchParams.get('options'), 'application_name');
  // An explicit `applicationName` is a deliberate call by the role that opened the pool, so it
  // wins. Only then is the setting named to the merge, and only when the operator wrote the other
  // spelling: `mergeLibpqOptions` drops their assignment before appending, so the two cannot
  // disagree — and a URL with no assignment in it keeps the exact `options` it always had.
  if (named !== undefined && inOptions) settings['application_name'] = named;
  const declared = url.searchParams.has('application_name') || inOptions;
  url.searchParams.set('options', mergeLibpqOptions(url.searchParams.get('options'), settings));
  if (named !== undefined) url.searchParams.set('application_name', named);
  else if (!declared) url.searchParams.set('application_name', 'ultimate');
  return url.toString();
}
