// Single responsibility: the value every `app.config.ts` key has when no layer says otherwise.
// Split from `config.ts`, which sits at its 500-line ceiling; literals only, so it reads no key.

import type { AppConfig } from './config';
import { JOBS_CONCURRENCY_DEFAULT } from './config-jobs';
import { DRAIN_DEADLINE_DEFAULT_MS } from './drain-deadline';
import { defaultReadinessGraceMs } from './lifecycle-grace';
import { ROLES } from './roles';

/** The keys their own files default: `config-site.ts`, `-navigation`, `-islands`, `-mail`. */
type Sectioned = 'name' | 'site' | 'seo' | 'navigation' | 'islands' | 'mail';

export function configDefaults(name: string): Omit<AppConfig, Sectioned> {
  return {
    theme: { defaultMode: 'system' },
    auth: { signInPath: null },
    pwa: {
      enabled: false,
      offline: { fallback: null, image: null, font: null, neverCache: [], personalPages: 'never' },
      backgroundSync: false,
      push: false,
      name: '',
      colors: undefined,
    },
    roles: [...ROLES],
    database: { driver: 'postgres', ssl: false },
    cache: { defaultTtlMs: 60_000, tiers: ['request-memo', 'lru'] },
    jobs: {
      queues: [`${name}-default`],
      concurrency: JOBS_CONCURRENCY_DEFAULT,
      maxAttempts: 5,
      backoff: 'exponential',
      visibilityTimeoutMs: 30_000,
    },
    // ON by default since 22.0.0, when the boot began obeying the key: an app with no section
    // keeps the `sync` node it always got, and `enabled: false` is the explicit opt-out.
    // `maxSubscriptionsPerActor` unset means the sync node's own default, `DEFAULT_MAX_PER_ACTOR`
    // (1,000) in `@ultimat3/realtime` — a tenth of its 10,000 windows, so no one actor fills it.
    realtime: {
      enabled: true,
      transport: 'memory',
      urlEnv: undefined,
      maxSubscriptionsPerActor: undefined,
      // Unset: the sync node's `DEFAULT_MAX_SOCKETS_PER_ACTOR` (16).
      maxSocketsPerActor: undefined,
    },
    notify: { inboxReadRetentionMs: undefined, inboxUnreadRetentionMs: undefined },
    ai: { mcp: { expose: true } },
    // Read from the process env when the config is DEFINED — the same env the drain will run in.
    drain: { readinessGraceMs: defaultReadinessGraceMs(), deadlineMs: DRAIN_DEADLINE_DEFAULT_MS },
    health: { readiness: 'dependencies' },
  };
}
