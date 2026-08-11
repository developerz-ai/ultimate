// The `apps/*` half of what `x new` writes: the three surfaces of apps/web, the admin app that
// already speaks MCP, and the mobile/desktop placeholders that exist so adding them later is not
// a restructure. Every file here is real, typed and covered — no placeholder that fails to boot.

import type { GeneratedFile, NameSet } from './naming';
import { icon } from './scaffold-icon';

const webPackage = (app: NameSet): string => `{
  "name": "@${app.kebab}/web",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "exports": {
    "./*": "./*.ts",
    "./*.tsx": "./*.tsx"
  },
  "scripts": {
    "typecheck": "tsc --noEmit -p tsconfig.json"
  }
}
`;

// The ambient \`*.module.scss\` declaration is not reachable through an import, so a program that
// only sees this app's files would report TS2307 on every stylesheet. Naming it in \`include\`
// is what makes \`tsc -p apps/web\` agree with \`tsc -p .\`.
const tsconfig = (): string => `{
  "extends": "../../tsconfig.json",
  "include": ["**/*.ts", "**/*.tsx", "../../types/scss.d.ts"]
}
`;

const sitePage = (
  app: NameSet,
): string => `// The landing page. site/ is 0kb JS: static render, hydrate never, no framework script tag.
import { t } from '@ultimat3/i18n';
import { defineRoute } from '@ultimat3/render';
import styles from './page.module.scss';

export const config = defineRoute({
  render: 'static',
  hydrate: 'never',
  offline: 'precache',
  budget: { js: '0kb', lcp: 1500 },
  meta: () => ({
    title: t('site.home.title'),
    description: t('site.home.description'),
  }),
});

export function HomePage() {
  return (
    <main class={styles.hero}>
      <h1>{t('site.home.title')}</h1>
      <p>{t('site.home.description')}</p>
      <a class={styles.cta} href="/dashboard">
        {t('site.home.cta')}
      </a>
    </main>
  );
}

export const appName = '${app.kebab}';
`;

const siteStyle = (): string => `@use '@ultimat3/ui/tokens' as tokens;

.hero {
  display: grid;
  gap: tokens.space(4);
  padding: tokens.space(8);
  background: tokens.role('bg');
  color: tokens.role('fg');
}

.cta {
  justify-self: start;
  padding: tokens.space(2) tokens.space(4);
  border-radius: tokens.radius('md');
  background: tokens.role('accent');
  color: tokens.role('accent-fg');
}
`;

const sitePageTest = (): string => `import { metaContextFor, routeDataFor } from '@ultimat3/render';
import { expect, unitTest } from '@ultimat3/testing';
import { config } from './page';

// The same two objects a render builds: \`routeDataFor\` resolves the route's data once, and
// \`metaContextFor\` wraps it the way every render mode wraps it before calling \`meta\`.
const ctx = { params: {}, url: 'https://example.test/' };

unitTest('the landing page ships zero JS and declares metadata', async () => {
  expect(config.render).toBe('static');
  expect(config.hydrate).toBe('never');
  expect(config.budget.js).toBe('0kb');
  const meta = await config.meta(metaContextFor(ctx, await routeDataFor(config, ctx)));
  expect(meta.title ?? '').not.toBe('');
});
`;

const dashboardPage =
  (): string => `// The authed dashboard. app/ streams: a static shell is flushed instantly and the holes arrive
// as their data resolves.

import { t } from '@ultimat3/i18n';
import { defineRoute } from '@ultimat3/render';
import styles from './page.module.scss';

export const config = defineRoute({
  // 'ssr', not 'stream', and this is not a downgrade: 'stream' needs a boundary to stream into,
  // and the framework has no hole marker yet. Solid's <Suspense> is not it — it throws outside a
  // Solid renderer, and the server JSX factory is inert on purpose. A scaffolded 'stream' route
  // therefore failed x routes with X_ROUTE_MODE_INVALID on the first run, printing a fix nobody
  // could follow. Ship the mode that works. Async data needs no boundary: await it in the page.
  render: 'ssr',
  hydrate: 'visible',
  offline: 'runtime',
  // Auth is a policy, never a route-local flag: one authz system, evaluated everywhere.
  policy: { permission: 'dashboard:read' },
  budget: { js: '60kb', lcp: 2500 },
  meta: () => ({ title: t('app.dashboard.title'), description: t('app.dashboard.description') }),
});

export function DashboardPage() {
  return (
    <section class={styles.panel}>
      <h1>{t('app.dashboard.title')}</h1>
    </section>
  );
}
`;

const dashboardStyle = (): string => `@use '@ultimat3/ui/tokens' as tokens;

.panel {
  padding: tokens.space(6);
  background: tokens.role('surface-raised');
  color: tokens.role('fg');
}
`;

const dashboardTest = (): string => `import { expect, unitTest } from '@ultimat3/testing';
import { config } from './page';

unitTest('the dashboard renders on the server, is gated, and has an offline strategy', () => {
  expect(config.render).toBe('ssr');
  expect(config.policy?.permission).toBe('dashboard:read');
  expect(config.offline).toBe('runtime');
});
`;

const offlineFallback =
  (): string => `// The offline fallback. Every app/ route with offline: 'runtime' falls back here, so a train
// tunnel shows the product's own shell instead of the browser's error page.

import { t } from '@ultimat3/i18n';
import styles from './offline.module.scss';

export function OfflineFallback() {
  return (
    <main class={styles.offline}>
      <h1>{t('app.offline.title')}</h1>
      <p>{t('app.offline.description')}</p>
    </main>
  );
}
`;

const offlineStyle = (): string => `@use '@ultimat3/ui/tokens' as tokens;

.offline {
  display: grid;
  gap: tokens.space(3);
  padding: tokens.space(8);
  background: tokens.role('bg');
  color: tokens.role('fg-muted');
}
`;

const apiAction =
  (): string => `// api/ holds actions only: no rendering, no components. This one is the readiness probe every
// role exposes, declared as an action so it appears in OpenAPI and MCP like everything else.

import { action, t } from '@ultimat3/action';
import { allow } from '@ultimat3/policy';

export const health = action({
  input: t.object({}),
  output: t.object({ ok: t.boolean, role: t.string }),
  // Public, said out loud. \`can('x:y')\` is the other branch; a missing policy is a build error,
  // so "anyone may call this" has to be a declaration too.
  policy: allow('public'),
  mcp: { expose: true, description: 'Readiness of this process' },
  async handle({ ctx }) {
    return { ok: true, role: ctx.role };
  },
});
`;

const apiTest = (): string => `import { contractTest, expect } from '@ultimat3/testing';
import { health } from './health';

// Named here because every projection needs a stable name and this file does not boot the app.
// At boot \`registerActions\` stamps the same name onto the same object.
const target = health.named('health');

contractTest('health is an action exposed over MCP', () => {
  expect(target.kind).toBe('action');
  expect(target.mcp?.expose).toBe(true);
});

contractTest('health projects one MCP tool and one OpenAPI operation', () => {
  // Same policy object on both surfaces — a public action says so once, not once per surface.
  expect(target.tool().policy).toBe(target.policy);
  expect(target.openapi().operationId).toBe('health');
});
`;

const sharedTokens =
  (): string => `// This app's one styling entry point. Forwards @ultimat3/ui's token layer verbatim and is where
// this app's own additions go. Emits no CSS: the global custom properties come from ui's theme.scss.
//
// A raw hex anywhere in the app is a lint failure, because dark theme is not a later project.
//
// The API is functions, not variables: \`role('accent')\`, \`space(4)\`, \`radius('md')\`,
// \`text('lg')\`, \`shadow('sm')\`, plus mixins like \`@include focus-ring\` and \`@include surface\`.
// Colours are stored as space-separated RGB CHANNELS, so \`role('accent', 0.12)\` gives you a tint
// without inventing a second token.
@forward '@ultimat3/ui/tokens';
`;

const sharedActor =
  (): string => `// The actor type both surfaces agree on. Policies read this and nothing else, so authz cannot
// disagree between HTTP, live queries, jobs and MCP.
export interface Actor {
  readonly id: string;
  readonly orgId: string;
  readonly roles: readonly string[];
}

export const isMember = (actor: Actor | null): boolean =>
  actor !== null && (actor.roles.includes('member') || actor.roles.includes('owner'));
`;

const sharedActorTest = (): string => `import { expect } from 'bun:test';
import { unitTest } from '@ultimat3/testing';
import { isMember } from './actor';

unitTest('isMember rejects anonymous and viewer actors', () => {
  expect(isMember(null)).toBe(false);
  expect(isMember({ id: 'a', orgId: 'o', roles: ['viewer'] })).toBe(false);
  expect(isMember({ id: 'a', orgId: 'o', roles: ['owner'] })).toBe(true);
});
`;

const adminPackage = (app: NameSet): string => `{
  "name": "@${app.kebab}/admin",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "exports": {
    "./*": "./*.ts",
    "./*.tsx": "./*.tsx"
  },
  "scripts": {
    "typecheck": "tsc --noEmit -p tsconfig.json"
  }
}
`;

const adminPage =
  (): string => `// The generated admin dashboard. It ships an MCP surface over the app's own actions, so the
// user's agents can drive the user's product with the user's permissions.

import { t } from '@ultimat3/i18n';
import { defineRoute } from '@ultimat3/render';

export const config = defineRoute({
  render: 'spa',
  hydrate: 'idle',
  offline: 'network-only',
  // A spa renders no data, so the shell itself must be gated — @ultimat3/render requires it.
  policy: { permission: 'admin:read' },
  budget: { js: '120kb', lcp: 3000 },
  meta: () => ({ title: t('admin.home.title'), description: t('admin.home.description') }),
});

export function AdminHome() {
  return <h1>{t('admin.home.title')}</h1>;
}
`;

// The two entry files a deploy needs. Both are deliberately thin: which role a container is, which
// port it binds, how it drains and what a static build enumerates are the framework's answers, so
// an upgrade moves them without a codemod in every app that ever shipped.

const server =
  (): string => `// The production entry. \`docker/Dockerfile\` starts this, and \`x build --target binary\` compiles it.
// ROLE selects what this process is — web, sync, worker, scheduler, replicator, or migrate, which
// applies the migrations and exits. PORT is bound on every interface, because a container bound to
// localhost is unreachable through its own port mapping.

import { join } from 'node:path';
import { runRole } from '@ultimat3/cli';

/**
 * Where the app is. From this file normally — the image's WORKDIR is not the app root's business.
 * A \`--compile\` binary is the exception: its \`import.meta.dir\` is Bun's virtual filesystem, which
 * holds this module's bundled imports and none of the app's source, and the framework's registries
 * are filled by scanning that source at boot. So a binary reads its root from the directory it is
 * started in — it is a launcher for an app tree, not a self-contained copy of one.
 */
const root = import.meta.dir.startsWith('/$bunfs')
  ? process.cwd()
  : join(import.meta.dir, '..', '..');

// Guarded, because the framework's module scan imports every file under apps/*/ to fill its
// registries — an unguarded boot would start a server inside \`x verify\`.
if (import.meta.main) {
  await runRole({ root, env: Bun.env });
}
`;

const prerender =
  (): string => `// The static entry. \`x build --target static\` runs this with \`--out <dir>\` and it writes one HTML
// file per \`render: 'static'\` route — a CDN or an object store then serves site/ with no process
// behind it. Every other render mode needs a running app and is reported as skipped, never emitted.

import { join } from 'node:path';
import { prerenderSite } from '@ultimat3/cli';

const root = join(import.meta.dir, '..', '..');
const flag = Bun.argv.indexOf('--out');
const out = (flag === -1 ? undefined : Bun.argv[flag + 1]) ?? join(root, '.x', 'static');
// SITE_ORIGIN is what canonical and og:url are built from; the default is only ever a local build.
const origin = Bun.env['SITE_ORIGIN'];

if (import.meta.main) {
  const report = await prerenderSite({ root, out, ...(origin === undefined ? {} : { origin }) });
  await Bun.stdout.write(
    \`\${JSON.stringify({ ok: true, out: report.out, pages: report.pages.length, skipped: report.skipped })}\\n\`,
  );
}
`;

const placeholder = (surface: string, app: NameSet): string => `# ${surface}

Placeholder. The monorepo shape exists now so adding ${surface} later is a new directory, not a
restructure.

| Question | Answer |
|---|---|
| Stack | ${surface === 'mobile' ? 'native Swift / Kotlin against the generated typed client' : 'Tauri shell around the app/ surface'} |
| API | the same actions as \`apps/web/api\` — one authz system, one contract |
| Contract | \`openapi.json\` at the repo root, regenerated by \`x manifest\` |
| Start | \`x new ${app.kebab}-${surface}\` inside this directory, or wire it by hand |
`;

export function appFiles(app: NameSet): readonly GeneratedFile[] {
  return [
    { path: 'apps/web/package.json', contents: webPackage(app) },
    { path: 'apps/web/tsconfig.json', contents: tsconfig() },
    { path: 'apps/web/server.ts', contents: server() },
    { path: 'apps/web/prerender.ts', contents: prerender() },
    { path: 'apps/web/site/icon.png', contents: icon() },
    { path: 'apps/web/site/page.tsx', contents: sitePage(app) },
    { path: 'apps/web/site/page.module.scss', contents: siteStyle() },
    { path: 'apps/web/site/page.test.ts', contents: sitePageTest() },
    { path: 'apps/web/app/dashboard/page.tsx', contents: dashboardPage() },
    { path: 'apps/web/app/dashboard/page.module.scss', contents: dashboardStyle() },
    { path: 'apps/web/app/dashboard/page.test.ts', contents: dashboardTest() },
    { path: 'apps/web/app/offline.tsx', contents: offlineFallback() },
    { path: 'apps/web/app/offline.module.scss', contents: offlineStyle() },
    { path: 'apps/web/api/health.ts', contents: apiAction() },
    { path: 'apps/web/api/health.test.ts', contents: apiTest() },
    { path: 'apps/web/shared/tokens.scss', contents: sharedTokens() },
    { path: 'apps/web/shared/actor.ts', contents: sharedActor() },
    { path: 'apps/web/shared/actor.test.ts', contents: sharedActorTest() },
    { path: 'apps/admin/package.json', contents: adminPackage(app) },
    { path: 'apps/admin/tsconfig.json', contents: tsconfig() },
    // `apps/admin/app/admin/page.tsx`, not `apps/admin/app/page.tsx`: the directory IS the URL,
    // relative to the surface root, so the shallower path resolves to `/` and collides with
    // `apps/web/site/page.tsx` — `x dev` loads both surfaces into one route table and the
    // scaffolded app failed its own `x routes` with X_ROUTE_DUPLICATE. `/admin` also matches
    // @ultimat3/admin's own `basePath` default, so the two agree instead of merely not clashing.
    { path: 'apps/admin/app/admin/page.tsx', contents: adminPage() },
    { path: 'apps/mobile/README.md', contents: placeholder('mobile', app) },
    { path: 'apps/desktop/README.md', contents: placeholder('desktop', app) },
  ];
}
