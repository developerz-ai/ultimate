// The ratchet under `scripts/readme-fences.ts`: every fenced `ts`/`tsx` example in a package's
// `README.md` that does not typecheck today, keyed by FENCE — `<package>: <its first code line>` —
// with how many fences of that package open with that line. A row may FALL and may never rise — a
// new example must compile from the day it is written, and the ones that do not get retired over
// time.
//
// Measured when this shipped: 170 fenced examples across 27 packages, 155 of them failing. Most are
// illustrative fragments — an identifier the surrounding prose defines, an app-level import that
// resolves in an app and not here, a signature shown with its arguments elided. Turning those into
// compiling programs is fixture engineering, not a formatting pass, so the honest artifact is a
// rule with a recorded edge rather than a rule switched off. Compiling a package's blocks TOGETHER
// was measured too, on the theory that block 4 uses what block 1 declared: 156 rather than 158,
// because an unparseable block has to leave the fixture and takes its declarations with it. Two
// designs, one answer — there is no cheap fixture that rescues these, only writing them out.
//
// Keyed on the fence's FIRST CODE LINE, never its README line or a content hash: the prose around
// an example is rewritten constantly and neither of those survives a paragraph edit, while the
// example's own opening line moves only when the example does. A per-package count — this table
// until plan 101 sweep 11c — let one fixed example be swapped for a new broken one unseen.
//
// why: re-keyed per fence in plan 101 sweep 11c — 138 failing fences, the same 138 the per-package
// counts held, at 138 sites; `pin-raises` reads a wholly re-keyed table against its old total.
//
// Shrink it with `bun run scripts/readme-fences.ts --pin`, which lowers a row and refuses to
// raise one. Adding or raising a row is a hand edit, on purpose, in a review.

export const README_FENCE_BACKLOG: Readonly<Record<string, number>> = {
  'action: const key = req.header(IDEMPOTENCY_HEADER);': 1,
  'action: export const likePost = mutator({': 1,
  "action: import { action, t } from '@ultimat3/action';": 1,
  "action: import { defineApi } from '@ultimat3/action';": 1,
  "action: import { rpc } from '@ultimat3/action';": 1,
  // why: re-keyed, not raised — the 25.0.0 rename changed this fence's text; same site, same count
  "action: import { setAuditSink } from '@ultimat3/core';": 1,
  'action: likePost.local(tx, { postId })            // the optimistic write, replayed on rebase': 1,
  'action: publishPost.contract({': 1,
  'action: publishPost.input                              // the declared input schema': 1,
  'action: setAuditSink({': 1,
  'admin: // admin/ops/page.tsx — a component, nothing framework-shaped about it': 1,
  'admin: defineAdmin({': 1,
  "admin: import { AdminList, listHref, Widget } from '@ultimat3/admin';": 1,
  "admin: import { adminMcp, adminMcpTools } from '@ultimat3/admin';": 1,
  "admin: import { adminRouteMatch } from '@ultimat3/admin';": 1,
  "admin: import { adminTestCtx } from '@ultimat3/admin';": 1,
  'ai: // `ProjectableAction` — `{ name, mcp?, inputJsonSchema?, run }`, the projection SEAM.': 1,
  'ai: // app/support/summarize.eval.test.ts — the suite `x verify` runs': 1,
  'ai: // app/support/summarize.evals.ts — the declaration the gate reads': 1,
  'ai: configureAi({ gateway, redact: (text) => scrubPatientIdentifiers(text) });': 1,
  "ai: configureAi({ gateway: createGateway({ providers: [yourProvider], defaultModel: 'house-large' }) });": 1,
  "ai: const embedder = new RemoteEmbedder({ name: 'voyage-3', dimension: 1_024 });  // EMBEDDINGS_API_KEY": 1,
  // why: re-keyed, not raised — the 25.0.0 rename changed this fence's text; same site, same count
  "ai: const store = postgresVectorStore({ name: 'doc_chunks', dimension: 256 });   // memoryVectorStore() in dev": 1,
  "ai: const tenantStore = store.scoped({ tenant: orgId, allow: { visibility: ['public', 'internal'] } });": 1,
  'ai: export const summarize = definePrompt<{ ticket: string }>({': 1,
  'ai: export const support = agent({': 1,
  'ai: for await (const chunk of ai.stream({ messages, maxTokens: 64_000 })) {': 1,
  'ai: for await (const chunk of summarize.stream({ postId }, { ctx })) {': 1,
  'ai: import {': 1,
  "ai: import { llm, t } from '@ultimat3/ai';": 1,
  'ai: registerModel({': 1,
  "auth: const keys = providerJwks(providerFor('bigco-sso'));": 1,
  'auth: const { identity } = await verifyWorkloadToken({': 1,
  'auth: const { start, callback } = oauthLogin(auth);': 1,
  'auth: defineAuth({': 1,
  "auth: defineAuth({ adapter, providers: ['github'], link: 'verified-email' })  // the default": 1,
  // why: re-keyed, not raised — the 25.0.0 rename changed this fence's text; same site, same count
  "auth: import { defineAuth, login, oauthLogin, postgresAuthAdapter } from '@ultimat3/auth';": 1,
  'auth: oauthLogin(auth, {': 1,
  'cache: await stack.read(key, () => db.posts.byId(id), { ttlMs: 300_000, negativeTtlMs: 5_000 });': 1,
  'cache: cache: { invalidates: [tag.post, tag.feed] }': 1,
  "cache: cacheHeaders({ sMaxAge: 300, staleWhileRevalidate: 86_400, tags: [tag('post', id)] });": 1,
  'cache: const fence = sampleFence({ key, tags });': 1,
  "cache: const report = await invalidateTags([tag('post', postId)]);": 1,
  'cache: const restoreTags = isolateDeclaredTags();': 1,
  'cache: createLruTier({ rng: () => 0 });          // the full lease — what a test asserting an exact expiry wants': 1,
  "cache: import { createCacheStack, createLruTier, createMemoTier, registerTier } from '@ultimat3/cache';": 1,
  "cache: registerInvalidationBroadcast(async (wireTags) => bus.publish('cache.invalidate', wireTags));": 1,
  'cache: tag.post          // the collection — busts lists': 1,
  'core: // app.config.ts': 1,
  "core: const code = stringField(error, 'code') ?? 'X_TRANSPORT_UNAVAILABLE';": 1,
  "core: const ctx = createContext({ actor: agentActor({ id: 'mcp-1', scopes: ['post:publish'] }) });": 1,
  "core: const dsn = secret(process.env.DATABASE_URL ?? '', 'DATABASE_URL');": 1,
  "core: const published = counter('posts_published_total', { description: 'posts published' });": 1,
  "core: declare module '@ultimat3/core' {": 1,
  "core: encodeCursor({ scope, key: ['2026-01-01T00:00:00.000Z'], id: 'p_9' }); // base64url(body).hmac": 1,
  'core: export const env = defineEnv({': 1,
  'core: probeImage(bytes);                                     // { format, width, height, mimeType }': 1,
  "core: registerErrorRetry({ X_OAUTH_EXCHANGE_FAILED: 'retryable', X_RATE_LIMITED: 'retry-after' });": 1,
  "core: resolveEnvironment();      // 'development' | 'test' | 'staging' | 'production'": 1,
  'core: throw new UltimateError({': 1,
  'db: const dev = createPgliteClient({ dataDir: pgliteDataDir(services.db.url) });  // or memory://': 1,
  "db: import { db, sql, raw, withTransaction, currentTx, setDbClient } from '@ultimat3/db';": 1,
  "db: import { ensureReadOnlyRole, readOnlyQuery } from '@ultimat3/db';": 1,
  "db: return expectedQueryLoop('one indexed lookup per text field beats one unindexed OR', async () => {": 1,
  "db: return withStatementAttribution('members', 'findById', () =>": 1,
  'entity: // One statement for every post in `ids`, not one `select count(*)` each.': 1,
  'entity: // One statement per batch, one page of rows in memory at a time.': 1,
  'entity: await db.tags.insertAll(names.map((name) => ({ orgId, name })));   // one statement, n rows': 1,
  'entity: const page = await postgresRepo(posts).findMany({ orgId });': 1,
  'entity: const repo = postgresRepo(users);': 1,
  'entity: database({ orgs, posts });                                 // memoryDriver() — the default': 1,
  'entity: db.posts.delete(id);                                        // by a single primary key': 1,
  'entity: export const db = database({ orgs, posts });': 1,
  'entity: export const db = database({ orgs, posts, members });': 1,
  "entity: export const posts = entity('posts', {": 1,
  'entity: import {': 1,
  "entity: import { defaultDriver } from '@ultimat3/entity';": 1,
  "entity: nPlusOne({ kind: 'read', subject: 'members.findById', count: 50, entity: 'members', op: 'findById' });": 1,
  'entity: relationMap().posts;': 1,
  'flags: // whole tenants, named — the 90% case, which is why it has a shorthand': 1,
  "flags: applyFlagSnapshot({ 'billing.dunning-emails': { default: false } });": 1,
  'flags: configureErrorReporting({ reporter: sentryErrorReporter({ dsn }) });': 1,
  "flags: import { isEnabled } from '@ultimat3/flags';": 1,
  "i18n: // the app's own packages/i18n/src/index.ts — its whole i18n module": 1,
  "i18n: import { negotiateLocale, t } from '@ultimat3/i18n';": 1,
  'jobs: // The PASS is the no-op, never the enqueue. The one-live-run index covers `ready`/`delayed`/': 1,
  'jobs: await ctx.tx(async (tx) => {': 1,
  'jobs: await onboardOrg.enqueue({ orgId });              // joins the ambient transaction': 1,
  'jobs: export const api = defineApi({': 1,
  'jobs: export const dropLegacy = backfill({': 1,
  "jobs: import { backfill } from '@ultimat3/jobs';": 1,
  "jobs: import { isBackfill, pendingBackfills, registeredBackfills } from '@ultimat3/jobs';": 1,
  "jobs: import { job, t } from '@ultimat3/jobs';": 1,
  'jobs: run: async ({ input, ctx, step }) => {': 1,
  'jobs: tenant: (input) => input.orgId   // the run acts under this org': 1,
  "mail: import { defineMail, send, blocks, t } from '@ultimat3/mail';": 1,
  "manifest: import { buildManifest, emitManifest, assertNoDrift, verifyContract } from '@ultimat3/manifest';": 1,
  'mcp: // apps/admin/app/admin/mcp.ts — under app/, so the app scan imports it': 1,
  "mcp: import { publishPost } from '../api/posts';": 1,
  'policy: // decides on input alone — `row` is null': 1,
  'policy: export const publishPost = action({': 1,
  'policy: interface PolicyArgs<I = unknown, R = unknown> {': 1,
  'policy: setDecisionSink({': 1,
  'pwa: // The generated worker posts this to every page it controls, on activation — and this is the': 1,
  'pwa: const { source, precache, warnings } = generateServiceWorker(describeRoutes(), config, buildId);': 1,
  'query: const source = await sourceFor(target, input, {': 1,
  "query: deprecated: { since: '2026-08-01T00:00:00Z', sunset: '2026-12-31T23:59:59Z', replacedBy: 'searchOrders' },": 1,
  "query: import { query, t } from '@ultimat3/query';": 1,
  "query: import { queryClient } from '@ultimat3/query';": 1,
  'query: rateLimit: { limit: 3, windowMs: 600_000 },   // 3 held, one back every three and a bit minutes': 1,
  'realtime: // query': 1,
  "render: const ContactModal = island({ src: './contact-modal.island.tsx', props: ['subject'] });": 1,
  'render: const collector = createIslandCollector({ file, hydrate: config.hydrate, resolve });': 1,
  'render: export const config = defineRoute({': 1,
  "render: import type { RouteConfig, RouteMetaContext } from '@ultimat3/render';": 1,
  'schema: const body = t.discriminatedUnion(': 1,
  'schema: const booking = t.object({ startDate: t.date, endDate: t.date }).refine({': 1,
  "schema: import { configureSchemaProvider } from '@ultimat3/schema';": 1,
  "schema: parse(t.object({ postId: t.uuid, notify: t.boolean }), { postId: 'abc', notify: 'yes' }, 'input');": 1,
  'schema: toJsonSchema(publishPost);                    // OpenAPI 3.1 (2020-12)': 1,
  'seo: const images = builtinImageDriver({ read: (src) => Bun.file(`public${src}`).bytes() });': 1,
  'seo: const query = parseImageQuery(new URL(req.url).searchParams);': 1,
  'seo: export const config = defineRoute({': 1,
  "seo: ld.Article({ headline: 'Ship it', author: { name: 'Ada' } });": 1,
  "storage: // 1. server, inside an action's handle: mint the grant": 1,
  'storage: const grant = await grantUpload({ disk, orgId, request, quarantine: true });': 1,
  "storage: import { defineStorage, disk, localDriver, s3Driver, scopedKey } from '@ultimat3/storage';": 1,
  "testing: const anAuthenticatedAction = sharedExamples<Action>('an authenticated action', (subject) => {": 1,
  'testing: const db = await acquireWorkerDatabase({ adminUrl, migrate });': 1,
  'testing: const orgs = defineFactory(orgEntity, {': 1,
  'testing: defineFixtures({ seed: () => loadSeed, actorFor: () => actorFor });': 1,
  "testing: test('the feed reads its authors once', async ({ statements }) => {": 1,
  "time: import { formatWithOffset, fromIso, nextLocalSlot, now, toZoned } from '@ultimat3/time';": 1,
  "ui: <Accordion level={3} exclusive items={[{ id: 'ship', title: t('faq.ship'), panel: <p>…</p> }]} />": 1,
  "ui: <AppShell header={<Toolbar label={t('nav.main')}>{nav}</Toolbar>} sidebar={<SideNav />}>": 1,
  "ui: import { Button, Field, Input } from '@ultimat3/ui';": 1,
  "ui: import { Icon } from '@ultimat3/ui';": 1,
};

/** How many fences at this site may fail today. Absent means zero: a new example compiles or
 * its first `x verify` says so. */
export const pinnedFor = (
  site: string,
  backlog: Readonly<Record<string, number>> = README_FENCE_BACKLOG,
): number => (Object.hasOwn(backlog, site) ? (backlog[site] ?? 0) : 0);
