// `notify.inboxReadRetentionMs` and `notify.inboxUnreadRetentionMs`, read out of the app's own
// `app.config.ts`. The sibling of `app-auth.ts`'s `loadSignInPath` and `dev-cache.ts`'s
// `loadCacheTiers`, and structural for the same reason: `defineConfig` returns a plain object, so
// a config that resolved through an older core simply has no `notify` section.
//
// WHY A LOADER AND NOT A BOOT ARGUMENT: `startServices` has no `AppConfig` — the app's modules
// import after it, which is the same reason `configureAuthLimiters` takes a factory. A key read
// here is a key read from the file the operator edited, per boot.

// why: Bun ships no path-joining API — `Object.keys(Bun)` has `file`, `write`, `Glob`,
// `pathToFileURL` and `fileURLToPath`, and nothing that joins a path.
import { join } from 'node:path';
import { INBOX_RETENTION_KEYS } from '@ultimat3/core';
import { APP_CONFIG_EXPORT } from './app-auth';
import { APP_CONFIG_FILE } from './app-root';

/**
 * The two windows in milliseconds, each `undefined` where the app named none.
 *
 * ABSENT IS A DECISION, not a missing default, and it is the only safe one: an inbox row is a
 * message a person has not read yet, so when it disappears is the app's call (axiom 8). The
 * framework picking a number silently is the failure this whole key exists to avoid.
 */
export interface InboxRetention {
  readonly readMs: number | undefined;
  readonly unreadMs: number | undefined;
}

/** Nothing swept — what a boot with no config file, no `notify` section or no keys resolves to. */
export const NO_INBOX_RETENTION: InboxRetention = Object.freeze({
  readMs: undefined,
  unreadMs: undefined,
});

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;

/**
 * Re-screened here rather than trusted from `defineConfig`. That validator runs when the app
 * IMPORTS its config, and this loader imports the module for its export — so a config object
 * assembled by hand, or one that resolved through a core too old to validate the section, reaches
 * this line unchecked. A window that is not a positive finite number reads as absent: refusing
 * would take the sweep over the other four framework tables down with it, and the whole point of
 * the key is that not sweeping is a legal state.
 */
const windowOf = (section: Record<string, unknown>, key: string): number | undefined => {
  const value = section[key];
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return undefined;
  return value;
};

export async function loadInboxRetention(root: string): Promise<InboxRetention> {
  const configPath = join(root, APP_CONFIG_FILE);
  // `Bun.file(p).exists()` rather than `existsSync`: this function is already async, so the
  // `node:fs` import buys nothing here — and an import with nothing to say for itself is what
  // `bun run node-imports` refuses.
  if (!(await Bun.file(configPath).exists())) return NO_INBOX_RETENTION;
  const module = (await import(configPath)) as Record<string, unknown>;
  const config = module[APP_CONFIG_EXPORT];
  if (!isRecord(config)) return NO_INBOX_RETENTION;
  const notify = config['notify'];
  if (!isRecord(notify)) return NO_INBOX_RETENTION;
  // Keyed off core's own list rather than two string literals here, so the two names exist in one
  // place. What actually stops a third window being declared-and-never-read is
  // `bun run scripts/config-readers.ts` — every leaf key of `AppConfig` needs a reader or a pinned
  // reason, and it is the guard whose own header calls that "the framework's most repeated defect".
  const [readKey, unreadKey] = INBOX_RETENTION_KEYS;
  return { readMs: windowOf(notify, readKey), unreadMs: windowOf(notify, unreadKey) };
}
