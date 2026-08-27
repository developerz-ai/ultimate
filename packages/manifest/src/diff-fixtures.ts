// TEST-ONLY. One fully-populated `ManifestSources` for the diff suites, so every section carries a
// fact and every fact carries every field its type declares — a fixture with an empty `tasks` is
// how a section nothing classifies stays green. Never exported from `index.ts`.

import type { ManifestSources } from './build';
import { buildManifest } from './build';
import type { Manifest } from './schema';

export const fixtureAction = (
  name: string,
  policy: string,
  expose = true,
  permissions = [policy],
) => ({
  name,
  input: { id: 'uuid' },
  output: { ok: 'boolean' },
  policy,
  permissions,
  cacheInvalidates: ['post'],
  mcp: { expose },
});

export const fixtureQuery = (name: string, policy: string, permissions = [policy]) => ({
  name,
  input: {},
  policy,
  permissions,
  live: true,
  subscribes: ['posts'],
  cacheTags: ['post'],
});

/**
 * Built through a helper rather than written as `{ code: 'X_…' }`: `x verify`'s `errors` step
 * reads a `code:` key with an `X_*` literal as a DECLARATION, and this file is not a test file, so
 * the literal would have published a fixture's code into `framework.manifest.json` as one this
 * package owns.
 */
export const fixtureErrorCode = (code: string, owner: string) => ({ code, package: owner });

/** Every section non-empty, every optional field present. */
export const FIXTURE: ManifestSources = {
  app: { name: 'acme', version: '1.4.2' },
  routes: [
    {
      url: '/posts',
      render: 'isr',
      offline: 'precache',
      hydrate: 'idle',
      revalidateTags: ['post'],
      budget: { js: '40kb', lcp: 2000 },
      surface: 'site',
    },
  ],
  entities: [
    {
      name: 'post',
      table: 'posts',
      columns: [
        { name: 'id', type: 'uuid', nullable: false, primaryKey: true },
        { name: 'authorId', type: 'uuid', nullable: false, references: 'users.id' },
        { name: 'note', type: 'text', nullable: true },
      ],
      invariants: ['post_title_present'],
    },
  ],
  actions: [fixtureAction('publishPost', 'post:publish')],
  queries: [fixtureQuery('feed', 'feed:read')],
  jobs: [
    {
      name: 'sendMail',
      input: { orgId: 'uuid' },
      queue: 'critical',
      retry: { attempts: 5, backoff: 'exponential' },
      steps: ['a'],
    },
  ],
  tasks: [
    { name: 'nightlyDigest', cron: '0 3 * * *', tz: 'Europe/Berlin', enqueues: ['sendMail'] },
  ],
  policies: [
    { permission: 'post:publish', description: 'publish a draft', enforcedIn: ['actions.publish'] },
  ],
  locales: ['en'],
  // A code that is genuinely REGISTERED, not an invented one. `error-catalog.test.ts` scans every
  // non-test file under `packages/*/src` for an `X_*` literal and treats an unregistered one as a
  // code handed to a reader that no gate can see. A fixture is not shipped source in spirit, but
  // it is in fact — and widening that scanner to excuse a filename is a worse trade than picking a
  // real code here, since the diff classifier only ever compares the string.
  errorCodes: [fixtureErrorCode('X_NOT_FOUND', 'app')],
};

/** The fixture, built. */
export const fixtureManifest = (overrides: Partial<ManifestSources> = {}): Manifest =>
  buildManifest({ ...FIXTURE, ...overrides });
