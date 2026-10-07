// Single responsibility: the `app.config.ts` keys a major DELETED, and the refusal an app still
// writing one gets. A deleted key the validator ignores is a switch with no wire — an operator sets
// it, redeploys and nothing changes — so each is refused by name, with the line that replaces it.

import { isJsonObject } from './json-object';

export interface RemovedConfigKey {
  /** The major that deleted it. */
  readonly removedIn: string;
  /** What an app writes instead — the second half of the `fix:`. */
  readonly instead: string;
}

/**
 * Dotted paths, one row per deleted leaf. Every row older than 25.0.0 was silently carried through
 * `section()` until 25.0.0 refused it — this table by name, then `config-keys.ts` closing the
 * shape for any other key; a row is what turns "not a key" into the line that replaces it. A row
 * is never removed: a config written against an older major must keep getting the instruction,
 * not silence. `Object.freeze`d, read through `Object.hasOwn`, so `__proto__` in a layer names no
 * row.
 */
export const REMOVED_CONFIG_KEYS: Readonly<Record<string, RemovedConfigKey>> = Object.freeze({
  locales: {
    removedIn: '25.0.0',
    instead:
      "the app's locales are the keys of its catalogs: defineCatalogs({ default: 'en', locales: { en, es } }) from @ultimat3/i18n, in packages/i18n/src/index.ts",
  },
  defaultLocale: {
    removedIn: '25.0.0',
    instead:
      "the fallback locale is defineCatalogs({ default: 'en', locales: { en } })'s default, from @ultimat3/i18n",
  },
  defaultTimeZone: {
    removedIn: '25.0.0',
    instead:
      "nothing read it; there is no ambient zone — pass one at every call: formatDate(at, { locale, zone: 'Europe/Paris' }), task({ tz }), userActor({ tz })",
  },
  defaultCurrency: {
    removedIn: '25.0.0',
    instead:
      "nothing read it; every Money carries its own currency ({ minor, currency: 'USD' }) — an app that wants a default declares its own constant in an app module",
  },
  'jobs.driver': {
    removedIn: '5.0.0',
    instead:
      'nothing read it and boot always built Postgres; the driver is code — setJobDriver(postgresJobDriver({ executor })) from @ultimat3/jobs, or setJobDriver(memoryJobDriver()) in a test',
  },
  'realtime.heartbeatMs': {
    removedIn: '4.0.0',
    instead:
      "nothing read it; the page socket's beat is the sync node's, named in its hello reply, and the presence beat is a third of the presence ttl",
  },
  'database.urlEnv': {
    removedIn: '4.0.0',
    instead:
      'nothing read it; the connection string is the DATABASE_URL environment variable, read by @ultimat3/db',
  },
  'database.poolSize': {
    removedIn: '4.0.0',
    instead:
      'nothing read it; the pool is sized by the DATABASE_POOL_MAX environment variable, per process',
  },
  'database.schema': {
    removedIn: '4.0.0',
    instead:
      'nothing read it and nothing emits SET search_path; entity() tables live in public, and there is no replacement',
  },
  'pwa.installPrompt': {
    removedIn: '8.0.0',
    instead:
      'nothing read it; call installController() from @ultimat3/pwa in your own install affordance',
  },
  'auth.afterSignInPath': {
    removedIn: '8.0.0',
    instead:
      'nothing read it; send the visitor where you mean from your sign-in route, the only code that can honour it',
  },
  'ai.modelEnv': {
    removedIn: '8.0.0',
    instead:
      "nothing read it; the model is the prompt's own, or llm({ model }) from @ultimat3/ai — read your own env key and pass it there",
  },
  'cache.driver': {
    removedIn: '9.0.0',
    instead:
      "cache.tiers is the one selector — name the rung: cache: { tiers: ['request-memo', 'lru', 'redis'] }",
  },
  'cache.urlEnv': {
    removedIn: '9.0.0',
    instead:
      "nothing read it; the redis tier reads the REDIS_URL environment variable, so name 'redis' in cache.tiers and set REDIS_URL",
  },
  'realtime.tier': {
    removedIn: '10.0.0',
    instead:
      "nothing read it; an app's realtime tier is what it declares — a channel() topic, a live: true query, persist: true on an entity",
  },
  'theme.tokens': {
    removedIn: '25.0.0',
    instead:
      "nothing read it; the app's theme is declared once with export const brand = defineTheme({ … }) from @ultimat3/ui, in apps/web/shared/theme.ts",
  },
  'ai.mcp.path': {
    removedIn: '25.0.0',
    instead:
      "an MCP endpoint's path is its own: defineAppMcp({ path: '/mcp' }) from @ultimat3/mcp, in apps/<app>/mcp.ts — the default is /mcp, and every endpoint mounts where its own metadata says",
  },
});

const said = (layer: unknown, path: string): boolean => {
  let at: unknown = layer;
  for (const segment of path.split('.')) {
    if (!isJsonObject(at) || !Object.hasOwn(at, segment)) return false;
    at = at[segment];
  }
  // `undefined` is a layer not saying, the rule every other key follows.
  return at !== undefined;
};

/** The removed keys one layer still writes, in table order. */
export function removedKeysIn(layer: unknown): readonly string[] {
  return Object.keys(REMOVED_CONFIG_KEYS).filter((path) => said(layer, path));
}

/** One cause line per removed key, naming the major. */
export const removedKeyIssue = (path: string): string =>
  `${path} was removed in ${REMOVED_CONFIG_KEYS[path]?.removedIn ?? 'a major'} and is no longer read`;

/** One instruction per removed key: delete the line, and what replaces it. */
export const removedKeyFix = (path: string): string =>
  `delete ${path} from app.config.ts — ${REMOVED_CONFIG_KEYS[path]?.instead ?? ''}`;
