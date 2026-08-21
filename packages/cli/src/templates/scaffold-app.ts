// The `apps/*` half of what `x new` writes: the three surfaces of apps/web, the admin app that
// already speaks MCP, and the mobile/desktop placeholders that exist so adding them later is not
// a restructure. Every file here is real, typed and covered — no placeholder that fails to boot.

import type { GeneratedFile, NameSet } from './naming';
import { apiFiles } from './scaffold-api';
import { icon } from './scaffold-icon';
import { rolesFiles } from './scaffold-roles';

// The one dependency this manifest names, and it is not decoration: every page below reads its
// strings through `@<app>/i18n`'s `useT()`, so the surface that renders a string DEPENDS on the
// module that registers the catalogs. An undeclared workspace dependency resolves through the root
// symlink and then breaks the day the app is built anywhere else.
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
  },
  "dependencies": {
    "@${app.kebab}/i18n": "0.0.0"
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
//
// Strings come from \`useT()\` — this app's own catalog module — and never from
// \`t\` in @ultimat3/i18n. That import is what puts the module holding \`defineCatalogs()\` in
// this page's graph, so rendering a string is what registers the catalogs. A page that reached
// past it shipped every string as \`\u27e6key\u27e7\` with \`x verify\` green (issue #249).
import { useT } from '@${app.kebab}/i18n';
import { defineRoute } from '@ultimat3/render';
import styles from './page.module.scss';

export const config = defineRoute({
  render: 'static',
  hydrate: 'never',
  offline: 'precache',
  budget: { js: '0kb' },
  // \`t\` is handed to \`meta\` by the router — one translator per render, resolved against the
  // request's locale before the head is built.
  meta: ({ t }) => ({
    title: t('site.home.title'),
    description: t('site.home.description'),
  }),
});

export function HomePage() {
  const t = useT();

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

const sitePageTest =
  (): string => `// The landing page ships zero JS and declares its metadata. Both are promises the file makes in
// its config, and both are the kind that rot silently when someone adds one import.
import { metaContextFor, routeDataFor } from '@ultimat3/render';
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

const dashboardPage = (
  app: NameSet,
): string => `// The authed dashboard. app/ streams: a static shell is flushed instantly and the holes arrive
// as their data resolves.

// \`useT()\`, not \`t\` from @ultimat3/i18n — see apps/web/site/page.tsx for why.
import { useT } from '@${app.kebab}/i18n';
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
  budget: { js: '60kb' },
  meta: ({ t }) => ({
    title: t('app.dashboard.title'),
    description: t('app.dashboard.description'),
  }),
});

export function DashboardPage() {
  const t = useT();

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

const dashboardTest =
  (): string => `// The dashboard renders per request, is gated by a policy, and has an offline strategy. Losing
// the policy is the interesting regression: the page still renders, to anyone.
import { expect, unitTest } from '@ultimat3/testing';
import { config } from './page';

unitTest('the dashboard renders on the server, is gated, and has an offline strategy', () => {
  expect(config.render).toBe('ssr');
  expect(config.policy?.permission).toBe('dashboard:read');
  expect(config.offline).toBe('runtime');
});
`;

const offlineFallback = (
  app: NameSet,
): string => `// The offline fallback. Every app/ route with offline: 'runtime' falls back here, so a train
// tunnel shows the product's own shell instead of the browser's error page.

// \`useT()\`, not \`t\` from @ultimat3/i18n — see apps/web/site/page.tsx for why.
import { useT } from '@${app.kebab}/i18n';
import styles from './offline.module.scss';

export function OfflineFallback() {
  const t = useT();

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

const sharedTokens =
  (): string => `// This app's authoring layer for stylesheets: \`@use '../../shared/tokens' as t;\` in a
// \`*.module.scss\` and reach for \`t.role(…)\`. Forwards @ultimat3/ui's token layer verbatim and is
// where this app's own functions and mixins go.
//
// Emits no CSS, and must not: every module is its own Sass compilation, so a \`:root\` block in here
// would be inlined once per stylesheet that uses it. The custom properties those functions REFER to
// are defined exactly once, by \`shared/global.scss\`.
//
// A raw hex anywhere in the app is a lint failure, because dark theme is not a later project.
//
// The API is functions, not variables: \`role('accent')\`, \`space(4)\`, \`radius('md')\`,
// \`text('lg')\`, \`shadow('sm')\`, plus mixins like \`@include focus-ring\` and \`@include surface\`.
// Colours are stored as space-separated RGB CHANNELS, so \`role('accent', 0.12)\` gives you a tint
// without inventing a second token.
@forward '@ultimat3/ui/tokens';
`;

const sharedGlobalStyle =
  (): string => `// The app document's global layer, and the only stylesheet in this app that emits top-level CSS:
// @ultimat3/ui's custom properties (\`:root{--color-*;--space-*;…}\`) and then its reset. Every rule
// a component emits reads those properties through \`var(--…)\`, so without this file the browser
// drops every one of those declarations and the app renders unstyled.
//
// Exactly one file, imported for its side effect by \`global.ts\` — never \`@use\`d from a
// \`*.module.scss\`. Each module is a separate Sass compilation, so a \`@use\` that emits would
// duplicate the whole \`:root\` block once per module.
//
// This app's own global rules go below the @use, never inside a component module.
@use '@ultimat3/ui/global.scss';
`;

const sharedGlobalModule =
  (): string => `// The one edge that puts the global stylesheet in this app's module graph. \`shared/\` is loaded by
// both surfaces and by the framework's own boot scan, so the tokens reach every document without a
// page having to remember to import them — and \`x verify\` fails with X_STYLES_GLOBAL_MISSING if
// this edge is ever cut.

import './global.scss';
`;

const sharedActor =
  (): string => `// The actor type both surfaces agree on. Policies read this and nothing else, so authz cannot
// disagree between HTTP, live queries, jobs and MCP.
import { expandRoles, grantMatches } from '@ultimat3/policy';
import { roles } from './roles';

export interface Actor {
  readonly id: string;
  readonly orgId: string;
  readonly roles: readonly string[];
}

/**
 * What this actor may DO, answered from the declared role map. Never \`actor.roles.includes('admin')\`:
 * a role-name comparison is a second authz rule, and it goes stale the moment a role is renamed or
 * a grant moves to another role. \`grantMatches\` is what reads a \`post:*\` wildcard as one.
 */
export const holds = (actor: Actor | null, permission: string): boolean =>
  actor !== null &&
  expandRoles(actor.roles, roles).some((grant) => grantMatches(grant, permission));
`;

const sharedActorTest =
  (): string => `// \`holds\` answers from the declared role map, never from a role NAME. An undeclared role must
// expand to no grants — the branch that turns a typo into an actor who can do everything.
import { expect, unitTest } from '@ultimat3/testing';
import type { Actor } from './actor';
import { holds } from './actor';

const actor = (...names: readonly string[]): Actor => ({ id: 'a', orgId: 'o', roles: names });

unitTest('holds answers from the role map, and an anonymous actor holds nothing', () => {
  expect(holds(null, 'dashboard:read')).toBe(false);
  // A role no defineRoles() call declares expands to no grants — never to every grant.
  expect(holds(actor('visitor'), 'dashboard:read')).toBe(false);
  expect(holds(actor('member'), 'dashboard:read')).toBe(true);
  expect(holds(actor('admin'), 'dashboard:read')).toBe(true);
  expect(holds(actor('member'), 'admin:read')).toBe(false);
});
`;

// Same one dependency as `apps/web`, and for the same reason: `app/admin/page.tsx` reads its
// strings through `@<app>/i18n`'s `useT()`.
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
  },
  "dependencies": {
    "@${app.kebab}/i18n": "0.0.0"
  }
}
`;

const adminPage = (
  app: NameSet,
): string => `// The generated admin dashboard. It ships an MCP surface over the app's own actions, so the
// user's agents can drive the user's product with the user's permissions.

// \`useT()\`, not \`t\` from @ultimat3/i18n — see apps/web/site/page.tsx for why.
import { useT } from '@${app.kebab}/i18n';
import { defineRoute } from '@ultimat3/render';

export const config = defineRoute({
  render: 'ssr',
  hydrate: 'idle',
  offline: 'network-only',
  // Behind auth, so the mode has to render per request: \`ssr\` and \`stream\` both do, and both take
  // a \`policy\`. \`static\` and \`isr\` refuse one outright — a file on disk has no actor to decide
  // against, and an ISR document is cached per URL, so the first actor's HTML would be served to
  // every later one who passes the same policy.
  policy: { permission: 'admin:read' },
  budget: { js: '120kb' },
  meta: ({ t }) => ({ title: t('admin.home.title'), description: t('admin.home.description') }),
});

export function AdminHome() {
  const t = useT();

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

// MORE THAN ONE REPLICA? Add these two lines, above \`runRole\`:
//
//   import { configureIdempotency } from '@ultimat3/action';
//   configureIdempotency({ scope: 'shared' });
//
// \`idempotent: true\` on an action promises that a retry does not repeat the work. Under the
// process-scoped default that promise holds inside ONE process — a client retrying
// \`POST /api/payments/charge\` after a timeout lands on another replica, which has never seen the
// key, and charges the card twice, silently, with \`x verify\` green. Declaring \`'shared'\` is what
// makes that a boot error (\`X_IDEMPOTENCY_NOT_SHARED\`) unless a shared store is installed.
// \`runRole\` installs the Postgres one for you, on the connection it resolved from \`DATABASE_URL\`,
// so the declaration is all this app owes. It must run before \`runRole\` imports the actions.

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
//
// Skipped is not unweighed: a route that declares a \`budget:\` is rendered in memory and measured
// whatever its mode, so \`x verify\`'s \`budgets\` step has a number for it. \`unmeasured\` is the list
// this build could not render — each one is an X_BUDGET_UNMEASURED at the gate, and this is where
// the reason is.
//
// It writes the whole of \`pages\` and \`skipped\`, never a COUNT of either. A count is what let a
// partial artifact read as a complete one: someone pointed a screenshot tool at \`.x/static\` and
// filed "the island did not mount" against a route that had never been emitted (issue #242). Each
// skipped route carries its own \`reason\` and \`why\`, and \`report\` is where the same inventory
// landed on disk — which is what \`x build --target static --json\` reads back.

import { join } from 'node:path';
import { prerenderSite } from '@ultimat3/cli';

const root = join(import.meta.dir, '..', '..');
const flag = Bun.argv.indexOf('--out');
const out = (flag === -1 ? undefined : Bun.argv[flag + 1]) ?? join(root, '.x', 'static');
// SITE_ORIGIN is what canonical and og:url are built from; the default is only ever a local build.
// Property access, not \`Bun.env['SITE_ORIGIN']\`: the scaffolded tsconfig does not set
// \`noPropertyAccessFromIndexSignature\`, so the bracket form is the one biome's useLiteralKeys
// reports — a diagnostic in an app's first lint run over a file the app never wrote.
const origin = Bun.env.SITE_ORIGIN;

if (import.meta.main) {
  const report = await prerenderSite({ root, out, ...(origin === undefined ? {} : { origin }) });
  await Bun.stdout.write(
    \`\${JSON.stringify({ ok: true, out: report.out, emitted: report.pages, skipped: report.skipped, unmeasured: report.unmeasured, report: report.report })}\\n\`,
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

/** `example` reaches only `apps/web/api/index.ts`: the slice it registers is written elsewhere. */
export function appFiles(app: NameSet, example: boolean): readonly GeneratedFile[] {
  return [
    { path: 'apps/web/package.json', contents: webPackage(app) },
    { path: 'apps/web/tsconfig.json', contents: tsconfig() },
    { path: 'apps/web/server.ts', contents: server() },
    { path: 'apps/web/prerender.ts', contents: prerender() },
    { path: 'apps/web/site/icon.png', contents: icon() },
    { path: 'apps/web/site/page.tsx', contents: sitePage(app) },
    { path: 'apps/web/site/page.module.scss', contents: siteStyle() },
    { path: 'apps/web/site/page.test.ts', contents: sitePageTest() },
    { path: 'apps/web/app/dashboard/page.tsx', contents: dashboardPage(app) },
    { path: 'apps/web/app/dashboard/page.module.scss', contents: dashboardStyle() },
    { path: 'apps/web/app/dashboard/page.test.ts', contents: dashboardTest() },
    { path: 'apps/web/app/offline.tsx', contents: offlineFallback(app) },
    { path: 'apps/web/app/offline.module.scss', contents: offlineStyle() },
    // The third surface, and the one call that registers what the app declares — `scaffold-api.ts`.
    ...apiFiles(example),
    { path: 'apps/web/shared/tokens.scss', contents: sharedTokens() },
    { path: 'apps/web/shared/global.scss', contents: sharedGlobalStyle() },
    { path: 'apps/web/shared/global.ts', contents: sharedGlobalModule() },
    { path: 'apps/web/shared/actor.ts', contents: sharedActor() },
    { path: 'apps/web/shared/actor.test.ts', contents: sharedActorTest() },
    // The app's role map, beside the actor that reads it. `shared/` and not a feature folder:
    // `defineRoles()` merges, so a per-feature call is legal and is how an app ends up with no
    // answer to "which roles exist?" — see `scaffold-roles.ts`.
    ...rolesFiles(),
    { path: 'apps/admin/package.json', contents: adminPackage(app) },
    { path: 'apps/admin/tsconfig.json', contents: tsconfig() },
    // `apps/admin/app/admin/page.tsx`, not `apps/admin/app/page.tsx`: the directory IS the URL,
    // relative to the surface root, so the shallower path resolves to `/` and collides with
    // `apps/web/site/page.tsx` — `x dev` loads both surfaces into one route table and the
    // scaffolded app failed its own `x routes` with X_ROUTE_DUPLICATE. `/admin` also matches
    // @ultimat3/admin's own `basePath` default, so the two agree instead of merely not clashing.
    { path: 'apps/admin/app/admin/page.tsx', contents: adminPage(app) },
    { path: 'apps/mobile/README.md', contents: placeholder('mobile', app) },
    { path: 'apps/desktop/README.md', contents: placeholder('desktop', app) },
  ];
}
