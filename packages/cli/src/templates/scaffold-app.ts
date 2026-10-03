// The `apps/*` half of what `x new` writes: the three surfaces of apps/web, the admin app that
// already speaks MCP, and the mobile/desktop placeholders that exist so adding them later is not
// a restructure. Every file here is real, typed and covered — no placeholder that fails to boot.

import { sortedImports } from './imports';
import type { GeneratedFile, NameSet } from './naming';
import { apiFiles } from './scaffold-api';
import { authFiles } from './scaffold-auth';
import { dashboardFiles } from './scaffold-dashboard';
import { demoOrgFiles } from './scaffold-demo-org';
import { entryFiles } from './scaffold-entries';
import { errorPageFiles } from './scaffold-errors';
import { httpFiles } from './scaffold-http';
import { icon } from './scaffold-icon';
import { rolesFiles } from './scaffold-roles';
import { shellFiles } from './scaffold-shell';
import { siteFiles } from './scaffold-site';

// `typecheck` is the ROOT program, as in every workspace `x new` writes: a type extension declared in
// one workspace (`PermissionRegistry` in `app/*/policy.ts`) is in force only where its file is in
// the program, and the app's own `tsconfig.json` passed in `apps/admin` what the gate refuses.
//
// The one dependency this manifest names, and it is not decoration: every page below reads its
// strings through `@<app>/i18n`'s `useT()`, so the surface that renders a string DEPENDS on the
// module that registers the catalogs. An undeclared workspace dependency resolves through the root
// symlink and then breaks the day the app is built anywhere else.
//
// `@<app>/db` joins it with the example slice, whose repo.ts reads through the typed handle that
// package exports. Under `--no-example` nothing here imports it yet, so it is not declared — the
// first `x g entity` writes the line with the repo that needs it (`handle-registration.ts`).
const webPackage = (app: NameSet, example: boolean): string => {
  const db = example ? `\n    "@${app.kebab}/db": "0.0.0",` : '';
  return `{
  "name": "@${app.kebab}/web",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "exports": {
    "./*": "./*.ts",
    "./*.tsx": "./*.tsx"
  },
  "scripts": {
    "typecheck": "tsc --noEmit -p ../../tsconfig.json"
  },
  "dependencies": {${db}
    "@${app.kebab}/i18n": "0.0.0"
  }
}
`;
};

// The ambient \`*.module.scss\` declaration is not reachable through an import, so a program that
// only sees this app's files would report TS2307 on every stylesheet. Naming it in \`include\`
// is what makes \`tsc -p apps/web\` agree with \`tsc -p .\`.
const tsconfig = (): string => `{
  "extends": "../../tsconfig.json",
  "include": ["**/*.ts", "**/*.tsx", "../../types/scss.d.ts"]
}
`;

const offlineTest = (
  app: NameSet,
): string => `// The offline fallback has to render with nothing: no network, no session, no database, and no
// JavaScript. Every one of those is a config field here, and every one of them rots the moment
// someone adds an import or a policy — at which point the page the service worker precaches is a
// page that cannot render when it is finally needed.
${sortedImports([
  `import { useT } from '@${app.kebab}/i18n';`,
  "import { expect, renderRoute, unitTest } from '@ultimat3/testing';",
])}
import * as page from './page';

const url = 'https://example.test/offline';

unitTest('the offline fallback renders with no actor, and says the network is gone', async () => {
  const t = useT();
  // No actor and no context: exactly what the service worker has when it serves this.
  const view = await renderRoute(page, { url });
  expect(view.html.match(/<h1\\b/g)).toHaveLength(1);
  expect(view.text).toBe(\`\${t('app.offline.title')} \${t('app.offline.description')}\`);
  expect(view.islands).toEqual([]);
});

unitTest('the offline fallback is static, precached, and ships no JavaScript', async () => {
  const view = await renderRoute(page, { url });
  expect(page.config.render).toBe('static');
  // 'precache', or the document that answers a lost network is itself fetched over the network.
  expect(page.config.offline).toBe('precache');
  expect(page.config.hydrate).toBe('never');
  expect(page.config.budget.js).toBe('0kb');
  // A cached error page has nothing to index, and an indexed one outranks the page it stood in for
  // on the day the crawler happened to be offline.
  expect(view.meta.robots?.index).toBe(false);
});
`;

const offlineFallback = (
  app: NameSet,
): string => `// The offline fallback, and it is a ROUTE — \`pwa.offline.fallback\` in app.config.ts names this
// path, the generated sw.js precaches it, and every app/ route with offline: 'runtime' falls back
// here. So a train tunnel shows the product's own shell instead of the browser's error page.
//
// site/ and render: 'static', deliberately: the document that answers a lost network has to render
// with no network, no session and no database, which is what site/ guarantees and app/ (ssr |
// stream) cannot. \`offline: 'precache'\` for the same reason one level down — a fallback fetched
// over the network when the network is gone is not a fallback.

// \`useT()\`, not \`t\` from @ultimat3/i18n — see apps/web/site/page.tsx for why.
${sortedImports([
  `import { useT } from '@${app.kebab}/i18n';`,
  `import { defineRoute } from '@ultimat3/render';`,
])}
import styles from './page.module.scss';

export const config = defineRoute({
  render: 'static',
  offline: 'precache',
  hydrate: 'never',
  budget: { js: '0kb' },
  meta: ({ t }) => ({
    title: t('app.offline.title'),
    description: t('app.offline.description'),
    // A cached error page has nothing to index, and an indexed one outranks the page it stood in
    // for on the day the crawler happened to be offline.
    robots: { index: false },
  }),
});

export function Page() {
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

const sharedGlobalTest =
  (): string => `// The global layer reaches this app's module graph through exactly one edge. Cut it and every
// \`var(--…)\` a component emits resolves to nothing: the app renders unstyled, with every test of
// every component still green.
import { registeredStylesheets } from '@ultimat3/render/server';
import { expect, unitTest } from '@ultimat3/testing';
import './global';

unitTest('importing shared/global registers the one global stylesheet', () => {
  const sheets = registeredStylesheets().filter((sheet) => sheet.global);
  expect(sheets.map((sheet) => sheet.file.split('/').slice(-3).join('/'))).toEqual([
    'web/shared/global.scss',
  ]);
  // The custom properties themselves, declared once on the root — what \`tokens.role()\` refers to.
  expect(sheets[0]?.css).toContain(':root{');
  expect(sheets[0]?.css).toContain('--color-bg:');
});
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

// Two dependencies, and they are the edges this workspace has: `app/admin/admin.ts` reads the
// app's typed handle from `@<app>/db`, and its test loads the role map from `@<app>/web`.
// Undeclared, they exist only inside the root tsconfig's `paths`, where `bun --filter` and every
// change-detection tool are blind to them.
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
    "typecheck": "tsc --noEmit -p ../../tsconfig.json"
  },
  "dependencies": {
    "@${app.kebab}/db": "0.0.0",
    "@${app.kebab}/web": "0.0.0"
  }
}
`;

const adminDeclaration = (
  app: NameSet,
): string => `// The whole admin dashboard. \`defineAdmin()\` serves a list, a detail and a form for every entity
// below at /admin/<entity> — the columns, filters, validation and labels are derived from the
// entity, the rows are read through the app's own typed handle, and \`x dev\` mounts the screens.
// There is no page file, no repo adapter and no screen glue to write.
//
// It also ships an MCP surface over the same resources, so the user's agents can drive the user's
// product with the user's permissions (\`adminMcp\`).
${sortedImports([
  `import { db } from '@${app.kebab}/db';`,
  `import { adminEntitiesOf, defineAdmin } from '@ultimat3/admin';`,
])}

export const admin = defineAdmin({
  // Every entity the handle serves: \`x g entity\` adds one there, and it is an admin screen on
  // the next boot. Name them one by one instead — \`entities: [post]\` — to leave a table out.
  entities: adminEntitiesOf(db),
  db,
  // Who may do what is the app's role map (shared/roles.ts), asked permission by permission:
  // \`admin:read\` + \`<table>:read\` to look, \`admin:write\` + \`<table>:write\` to create or edit,
  // \`admin:destroy\` + \`<table>:delete\` to delete. \`x g entity\` grants a new table's three to
  // the \`admin\` role; a role holding only the two \`:read\` grants is a view-only operator.
  // Per-entity overrides — list columns, scopes, a row scope, which columns are sensitive — go in
  // \`resources: { <entity>: … }\`. \`x g resource <name> --admin\` writes one and lists it here.
});
`;

const adminDeclarationTest = (
  app: NameSet,
): string => `// The admin is one declaration, so what can go wrong is what it DERIVES: a route table with a
// screen behind every path, each gated — and an authz that asks the role map for every permission,
// so the admin role runs it and nobody else does.
//
// The role map is imported here because nothing else would load it: the boot scan reads
// shared/roles.ts before the first request, and a test that reaches the admin directly has to say
// so — without it the \`admin\` role grants nothing and every decision below is a refusal.
${sortedImports([
  `import { roles } from '@${app.kebab}/web/shared/roles';`,
  `import { adminRoutes, permissionsForOperation } from '@ultimat3/admin';`,
  `import { expect, unitTest } from '@ultimat3/testing';`,
])}
import { admin } from './admin';

const ctxFor = (roles: readonly string[]) =>
  admin.ctx({ actor: { id: 'a', roles }, requestId: 'test' });

unitTest('every admin route is gated and has a screen', () => {
  const routes = adminRoutes(admin);
  expect(routes.map((route) => route.path)).toContain('/admin');
  for (const route of routes) {
    // The coarse gate is the first permission of the route's own pair: \`admin:read\` for a
    // screen that reads, \`admin:write\` for a form. Never absent.
    expect(route.config.policy?.permission).toBe(route.permissions[0] ?? '');
    expect(route.config.policy?.permission.startsWith('admin:')).toBe(true);
    expect(typeof route.respond).toBe('function');
  }
});

unitTest('one resource per entity on the handle, each reading through it', () => {
  for (const resource of admin.resources) {
    expect(admin.routes.map((route) => route.path)).toContain(\`/admin\${resource.path}\`);
    expect(resource.repo).toBeDefined();
  }
});

unitTest('the admin role holds every permission the admin derives, and a member none', () => {
  // Every route's pair and every operation's — a delete has no route of its own, it is a POST at
  // the row's URL — asked of the role map by name: a table the handle gained without its three
  // grants in shared/roles.ts fails HERE, not as a 403 an operator reports.
  const required = [
    ...new Set([
      ...admin.routes.flatMap((route) => route.permissions),
      ...admin.resources.flatMap((resource) =>
        resource.operations.flatMap((op) => permissionsForOperation(resource.permission, op)),
      ),
    ]),
  ];
  expect(required).toContain('admin:read');
  for (const permission of required) {
    const asked = { permission, subject: { entity: 'any' } };
    const granted = admin.authz.decide({ ...asked, actor: ctxFor(['admin']).actor });
    expect({ permission, allowed: granted.allowed }).toEqual({ permission, allowed: true });
  }
  // Held whether or not the app has a table yet: the first \`x g entity\` must find them here.
  expect(roles.admin.grants).toContain('admin:write');
  expect(roles.admin.grants).toContain('admin:destroy');
  const refused = admin.authz.decide({
    permission: 'admin:write',
    actor: ctxFor(['member']).actor,
  });
  expect(refused.allowed).toBe(false);
  expect(refused.permission).toBe('admin:write');
});

unitTest('the dashboard answers 200 for the admin role and 403 for anyone else', async () => {
  const [home] = adminRoutes(admin);
  const ask = (roles: readonly string[]) =>
    home?.respond({
      ctx: ctxFor(roles),
      params: {},
      url: 'http://localhost/admin',
      method: 'GET',
      form: null,
    });
  const allowed = await ask(['admin']);
  expect(allowed?.kind === 'document' && allowed.status).toBe(200);
  const denied = await ask(['member']);
  expect(denied?.kind === 'document' && denied.status).toBe(403);
});
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

/** `example` decides the API registration, the shell's nav and which dashboard is written; the
 * slice itself is written elsewhere. */
export function appFiles(app: NameSet, example: boolean): readonly GeneratedFile[] {
  return [
    { path: 'apps/web/package.json', contents: webPackage(app, example) },
    { path: 'apps/web/tsconfig.json', contents: tsconfig() },
    // The process a container starts and the artifact a CDN is handed — `scaffold-entries.ts`.
    ...entryFiles(),
    { path: 'apps/web/site/icon.png', contents: icon() },
    // The landing page: hero, two calls to action, three feature cards — `scaffold-site.ts`.
    ...siteFiles(app),
    // The signed-in product: its frame and the one island it ships (`scaffold-shell.ts`), then the
    // dashboard in the shape the invocation earns (`scaffold-dashboard.ts`).
    ...shellFiles(app, example),
    ...dashboardFiles(app, example),
    // Served verbatim for those statuses and carried into the static export — `scaffold-errors.ts`.
    ...errorPageFiles(app),
    // The third piece of the authz story the scaffold already tells twice: the routes declare a
    // policy and `shared/roles.ts` declares the grants, and until this file existed nothing
    // answered "who is this?" — so every one of those routes refused every request.
    ...authFiles(app),
    // `site/offline/page.tsx`, not `app/offline.tsx`: the directory is the URL and `<name>.tsx` is
    // not a route file, so the old path shipped a component nothing rendered and left `/offline` a
    // URL the generated service worker could not fall back to.
    { path: 'apps/web/site/offline/page.tsx', contents: offlineFallback(app) },
    { path: 'apps/web/site/offline/page.module.scss', contents: offlineStyle() },
    { path: 'apps/web/site/offline/page.test.ts', contents: offlineTest(app) },
    // The third surface, and the one call that registers what the app declares — `scaffold-api.ts`.
    ...apiFiles(example),
    { path: 'apps/web/shared/tokens.scss', contents: sharedTokens() },
    { path: 'apps/web/shared/global.scss', contents: sharedGlobalStyle() },
    { path: 'apps/web/shared/global.ts', contents: sharedGlobalModule() },
    { path: 'apps/web/shared/global.test.ts', contents: sharedGlobalTest() },
    { path: 'apps/web/shared/actor.ts', contents: sharedActor() },
    { path: 'apps/web/shared/actor.test.ts', contents: sharedActorTest() },
    // The one org the dev actor, the seed and the dashboard all name — `scaffold-demo-org.ts`.
    ...demoOrgFiles(),
    // The app's role map, beside the actor that reads it. `shared/` and not a feature folder:
    // `defineRoles()` merges, so a per-feature call is legal and is how an app ends up with no
    // answer to "which roles exist?" — see `scaffold-roles.ts`.
    ...httpFiles(app),
    ...rolesFiles(example),
    { path: 'apps/admin/package.json', contents: adminPackage(app) },
    { path: 'apps/admin/tsconfig.json', contents: tsconfig() },
    // `apps/admin/app/admin/admin.ts`: a DECLARATION, not a page. `defineAdmin()` registers the
    // admin and `x dev` mounts every screen it derives under `/admin` (`runtime-admin.ts`), so the
    // app carries no route file for it. It sits under `app/` because that is where the boot scan
    // looks — a module nothing imports declares nothing — and its test rides beside it, because
    // generated source with no test is uncovered source in an app whose gate holds a floor.
    { path: 'apps/admin/app/admin/admin.ts', contents: adminDeclaration(app) },
    { path: 'apps/admin/app/admin/admin.test.ts', contents: adminDeclarationTest(app) },
    { path: 'apps/mobile/README.md', contents: placeholder('mobile', app) },
    { path: 'apps/desktop/README.md', contents: placeholder('desktop', app) },
  ];
}
