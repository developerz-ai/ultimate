// `x doctor`'s sealed-column checks: the columns the app declared `.sealed()`, against the master
// keys this environment declares. Its own file for `doctor-offline.ts`'s reason — answering needs
// the app's entities and the committed secrets, and `cmd-doctor.ts`'s job is the probe. The split
// is the same too: reaching the disk is `sealedKeysProbe`, deciding is `sealedKeyFindings`.

import {
  ERROR_DOCS_URL,
  findMasterKey,
  readSecretsFile,
  SECRETS_RETIRED_KEYS_ENV,
  sealKeyIds,
  secretsFileExists,
} from '@ultimat3/core';
import { registeredEntities, sealedFields } from '@ultimat3/entity';
import { loadApp } from './app-load';
import type { Finding } from './output';
import { quoteArg } from './shell-quote';

export interface SealedColumnFact {
  readonly entity: string;
  /** Property key, as the entity declares it. */
  readonly column: string;
  readonly lookup: boolean;
}

export interface SealedKeysFact {
  /**
   * Every sealed column the app declares, or `undefined` when the app would not load — a short
   * registry reads as "no sealed columns", which is the false green `appEntities` exists to refuse.
   */
  readonly columns: readonly SealedColumnFact[] | undefined;
  /** The key ids in force, or `undefined` when no usable master key was found. */
  readonly keys: { readonly current: string; readonly retired: readonly string[] } | undefined;
}

const named = (columns: readonly SealedColumnFact[]): string =>
  columns.map((one) => `${one.entity}.${one.column}`).join(', ');

/**
 * The rule, pure. Two conditions, and an app with no sealed column is judged by neither.
 *
 * No key: every write to a sealed column is `X_SEAL_KEY_MISSING` — core's own code and its own
 * fix, reported here before the first request finds out.
 *
 * A retired key still declared: a rotation whose re-seal has not finished. That is a live-system
 * state and not a fault, but it has a cost that ends only when someone acts — a `lookup` column
 * matches through `in (…)` over every key and its `.unique()` holds per key — so it is a finding
 * until the retired key is dropped.
 */
export function sealedKeyFindings(fact: SealedKeysFact): readonly Finding[] {
  const columns = fact.columns;
  if (columns === undefined || columns.length === 0) return [];
  if (fact.keys === undefined) {
    return [
      {
        code: 'X_SEAL_KEY_MISSING',
        cause: `${named(columns)} ${columns.length === 1 ? 'is' : 'are'} sealed and this environment has no usable master key, so every write to ${columns.length === 1 ? 'it' : 'them'} is refused`,
        fix: 'x secrets init   # or, where the key already exists: export ULTIMATE_SECRETS_KEY="$(cat .secrets.key)"',
        docs: ERROR_DOCS_URL,
      },
    ];
  }
  const [oldest] = fact.keys.retired;
  if (oldest === undefined) return [];
  const lookups = columns.filter((one) => one.lookup);
  const weakened =
    lookups.length === 0
      ? ''
      : ` — ${named(lookups)} ${lookups.length === 1 ? 'is a lookup column' : 'are lookup columns'}, so until then equality reads through in (…) over every key and .unique() holds per key`;
  return [
    {
      code: 'X_SEAL_RESEAL_PENDING',
      cause: `${named(columns)} may still hold values sealed under retired master key(s) ${fact.keys.retired.join(', ')}: a rotation whose re-seal has not finished${weakened}`,
      // The id is 16 hex characters computed here from a key, never text read from a file.
      fix: `x secrets rotate --drop ${quoteArg(oldest)} --json   # AFTER a backfill() has rewritten every row — update(id, { column: row.column }) seals under the current key`,
      docs: ERROR_DOCS_URL,
    },
  ];
}

/**
 * The retired ring as a booted process would see it: the real environment first, the committed
 * file second — `installSecrets()`'s own order, without installing anything into this process.
 */
async function retiredRing(
  root: string,
  env: Readonly<Record<string, string | undefined>>,
): Promise<string | undefined> {
  const declared = env[SECRETS_RETIRED_KEYS_ENV];
  if (declared !== undefined && declared !== '') return declared;
  const key = findMasterKey(root, { ...env });
  if (key === undefined || !secretsFileExists(root)) return undefined;
  return (await readSecretsFile(root, key))[SECRETS_RETIRED_KEYS_ENV];
}

/** The app's sealed columns, or `undefined` when it would not load. */
export type DeclaredSealedColumns = (
  root: string,
) => Promise<readonly SealedColumnFact[] | undefined>;

/** `appEntities`' rule (`schema-drift.ts`): a registry short one module is not "none declared". */
const appSealedColumns: DeclaredSealedColumns = async (root) => {
  const app = await loadApp(root);
  if (app.findings.length > 0) return undefined;
  return registeredEntities().flatMap((entry) =>
    // `core` is absent on a hand-registered entry, which declares no columns to seal.
    (entry.core === undefined ? [] : sealedFields(entry.core)).map((field) => ({
      entity: entry.name,
      column: field.property,
      lookup: field.lookup,
    })),
  );
};

export async function sealedKeysProbe(
  root: string,
  env: Readonly<Record<string, string | undefined>> = process.env,
  declared: DeclaredSealedColumns = appSealedColumns,
): Promise<SealedKeysFact> {
  const columns = await declared(root);
  // No sealed column means no question about keys, and no reason to open the secrets file.
  if (columns === undefined || columns.length === 0) return { columns, keys: undefined };
  try {
    const ring = await retiredRing(root, env);
    const source = { ...env, ...(ring === undefined ? {} : { [SECRETS_RETIRED_KEYS_ENV]: ring }) };
    return { columns, keys: await sealKeyIds({ root, env: source }) };
  } catch {
    // Whatever refused — no key, a malformed one, a secrets file this key does not open — the
    // answer for a sealed column is the same: there is no key ring to seal under.
    return { columns, keys: undefined };
  }
}
