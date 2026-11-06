// Single responsibility: the framework's one writer of a transaction-local setting. Every
// `set_config` the framework sends is this file's: parameter-bound and always local, so a value
// ends with the transaction that set it and a pooled connection hands the next caller nothing.

import type { DbClient } from './client';
import { sql } from './sql';

/** A setting's name and its value, both text — what `set_config` takes. */
export type LocalSettings = Readonly<Record<string, string>>;

/**
 * `select set_config($1, $2, true)` per setting, on `tx`. `true` is "local": the value lives until
 * the transaction ends, which is the only lifetime safe behind a transaction-mode pooler. Never
 * `set`/`set local` text: those take no parameters, so a value would have to be spliced in.
 */
export async function setLocal(tx: DbClient, settings: LocalSettings): Promise<void> {
  for (const [name, value] of Object.entries(settings)) {
    await tx.execute(sql`select set_config(${name}, ${value}, true)`);
  }
}

interface SettingRow {
  readonly value: string | null;
}

/**
 * What each named setting reads as now, on `tx`, for a caller that must put it back. An unset custom
 * setting (`x.tenant` before anything set it) reads `''`, which `set_config` restores to the same
 * "unset" every policy reads through `nullif(…, '')`.
 */
export async function readLocal(tx: DbClient, names: readonly string[]): Promise<LocalSettings> {
  const prior = new Map<string, string>();
  for (const name of names) {
    const row = await tx.one<SettingRow>(sql`select current_setting(${name}, true) as value`);
    prior.set(name, row?.value ?? '');
  }
  return Object.fromEntries(prior);
}
