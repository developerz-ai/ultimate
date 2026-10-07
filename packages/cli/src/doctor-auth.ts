// `x doctor`'s auth-storage checks: what an upgrade leaves in the database for an operator to
// finish — second-factor secrets written before they were sealed, and a framework table no
// release reads any more. Reaching the server is `authStorageProbe`, deciding is
// `authStorageFindings` — the split `doctor-sealed.ts` makes.

import { countUnsealedMfaSecrets, postgresAuthAdapter } from '@ultimat3/auth';
import { ERROR_DOCS_URL } from '@ultimat3/core';
import { postgresClient, raw } from '@ultimat3/db';
import type { Finding } from './output';

/**
 * Framework tables an earlier release created and none reads now, each with the command that
 * removes it. The boot never drops one: a replica still on the previous release may be using it
 * for the length of a rolling deploy. A whole literal per table — nothing is spliced into a fix.
 */
type RetiredTable = 'x_auth_failures';

// A Map, not an object: a table name is looked up by key, and an object answers `constructor`.
const RETIRED_TABLE_FIXES: ReadonlyMap<RetiredTable, string> = new Map([
  [
    'x_auth_failures',
    `psql "$DATABASE_URL" -c 'drop table if exists x_auth_failures'   # once every replica runs this release`,
  ],
]);

export const RETIRED_FRAMEWORK_TABLES: readonly RetiredTable[] = Object.freeze([
  ...RETIRED_TABLE_FIXES.keys(),
]);

export interface AuthStorageFact {
  /** `x_users` rows holding an `mfa_secret` that is not sealed. */
  readonly unsealedMfaSecrets: number;
  /** Which of `RETIRED_FRAMEWORK_TABLES` are still present. */
  readonly retiredTables: readonly RetiredTable[];
}

/** What a database that was not asked — embedded, or unreachable — answers: nothing to report. */
export const NO_AUTH_STORAGE_FACT: AuthStorageFact = Object.freeze({
  unsealedMfaSecrets: 0,
  retiredTables: Object.freeze([]),
});

/** The rule, pure. */
export function authStorageFindings(fact: AuthStorageFact): readonly Finding[] {
  const findings: Finding[] = [];
  if (fact.unsealedMfaSecrets > 0) {
    findings.push({
      code: 'X_MFA_SECRET_UNSEALED',
      cause: `${fact.unsealedMfaSecrets} user(s) hold a second-factor secret that is not sealed; the framework never reads a plaintext secret, so each of them is refused at the second factor until it is sealed`,
      fix: 'x auth seal-mfa --json',
      docs: ERROR_DOCS_URL,
    });
  }
  for (const table of fact.retiredTables) {
    const fix = RETIRED_TABLE_FIXES.get(table);
    if (fix === undefined) continue;
    findings.push({
      code: 'X_FRAMEWORK_TABLE_ORPHANED',
      cause: `${table} is still in the database and no release reads it any more; the boot does not drop it, because a replica on the previous release may still be writing to it during a rolling deploy`,
      fix,
      docs: ERROR_DOCS_URL,
    });
  }
  return findings;
}

/**
 * Asks an EXTERNAL database only — `probeDatabase`'s own rule: opening the embedded one boots
 * PGlite and takes the single-writer lock the next command needs. A server that does not answer
 * is `database()`'s finding to make, so every failure here is "nothing to report".
 */
export async function authStorageProbe(url: string | undefined): Promise<AuthStorageFact> {
  if (url === undefined || url.trim() === '') return NO_AUTH_STORAGE_FACT;
  const client = postgresClient({ url, applicationName: 'x-doctor' });
  try {
    const present = async (table: string): Promise<boolean> => {
      const rows = await client.query<{ readonly present: boolean }>(
        raw(`select to_regclass('public.${table}') is not null as present`),
      );
      return rows[0]?.present === true;
    };
    const retiredTables: RetiredTable[] = [];
    for (const table of RETIRED_FRAMEWORK_TABLES) {
      if (await present(table)) retiredTables.push(table);
    }
    const unsealedMfaSecrets = (await present('x_users'))
      ? await countUnsealedMfaSecrets({ adapter: postgresAuthAdapter(client) })
      : 0;
    return { unsealedMfaSecrets, retiredTables };
  } catch {
    return NO_AUTH_STORAGE_FACT;
  } finally {
    await client.close();
  }
}
