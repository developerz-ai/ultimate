// The two entry files a deploy needs — `apps/web/server.ts` and `apps/web/prerender.ts`. Split out
// of `scaffold-app.ts` because that file is the three SURFACES and these are neither: they are what
// a container starts and what a CDN is handed. Both are deliberately thin — which role a container
// is, which port it binds, how it drains and what a static build enumerates are the framework's
// answers, so an upgrade moves them without a codemod in every app that ever shipped.

import type { GeneratedFile } from './naming';

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
import { DEFAULT_ORIGIN, type PrerenderReport, prerenderSite } from '@ultimat3/cli';
import { routeEntries } from '@ultimat3/render';
import { buildRobots, buildSitemap, type RouteRecord } from '@ultimat3/seo';

const root = join(import.meta.dir, '..', '..');
const flag = Bun.argv.indexOf('--out');
const out = (flag === -1 ? undefined : Bun.argv[flag + 1]) ?? join(root, '.x', 'static');
// SITE_ORIGIN is what canonical and og:url are built from; the default is only ever a local build.
// Property access, not \`Bun.env['SITE_ORIGIN']\`: the scaffolded tsconfig does not set
// \`noPropertyAccessFromIndexSignature\`, so the bracket form is the one biome's useLiteralKeys
// reports — a diagnostic in an app's first lint run over a file the app never wrote.
const origin = Bun.env.SITE_ORIGIN;

/**
 * The route table as \`@ultimat3/seo\` reads it. \`RouteRecord\` is a static row and \`defineRoute\`
 * is a live declaration, so one has to be projected onto the other — and \`prerenderSite\` has
 * already loaded the app by the time this runs, which is what fills \`routeEntries()\`.
 *
 * A DYNAMIC route contributes exactly the URLs this build enumerated for it, read back off the
 * report rather than by calling \`prerender()\` a second time: the sitemap then cannot name a page
 * the artifact does not contain, which is the only failure mode a sitemap really has.
 */
const siteRoutes = (report: PrerenderReport): readonly RouteRecord[] =>
  routeEntries()
    .filter((entry) => entry.surface === 'site')
    .map((entry) => ({
      path: entry.path,
      file: entry.file,
      surface: 'site' as const,
      render: entry.config.render,
      prerender: () =>
        report.pages.filter((page) => page.route === entry.path).map((page) => page.path),
    }));

/**
 * \`sitemap.xml\` and \`robots.txt\`, into the same directory the HTML went. Both belong to the
 * ARTIFACT rather than to a request: a static export is served with no process behind it, so a
 * route that answered them at run time would be a file the CDN never has.
 *
 * \`buildRobots\` fails closed — anything that is not \`ULTIMATE_ENV=production\` emits
 * \`Disallow: /\` and advertises no sitemap — so a preview build cannot outrank the real site.
 */
async function writeSeoFiles(report: PrerenderReport, baseUrl: string): Promise<readonly string[]> {
  const sitemap = await buildSitemap(siteRoutes(report), { baseUrl });
  // Past 50,000 URLs \`files\` are \`/sitemap-N.xml\` and the index is \`/sitemap.xml\`; below it,
  // \`files\` is that one file and there is no index. Writing both lists covers each case once.
  const written = sitemap.index === undefined ? sitemap.files : [sitemap.index, ...sitemap.files];
  for (const file of written) await Bun.write(join(out, file.path), file.xml);
  await Bun.write(join(out, 'robots.txt'), buildRobots({ baseUrl, sitemaps: ['/sitemap.xml'] }));
  return [...written.map((file) => file.path), '/robots.txt'];
}

if (import.meta.main) {
  const report = await prerenderSite({ root, out, ...(origin === undefined ? {} : { origin }) });
  const seo = await writeSeoFiles(report, origin ?? DEFAULT_ORIGIN);
  await Bun.stdout.write(
    \`\${JSON.stringify({ ok: true, out: report.out, emitted: report.pages, skipped: report.skipped, unmeasured: report.unmeasured, report: report.report, seo })}\\n\`,
  );
}
`;

/** The two files, in the order a deploy meets them: the process, then the artifact. */
export const entryFiles = (): readonly GeneratedFile[] => [
  { path: 'apps/web/server.ts', contents: server() },
  { path: 'apps/web/prerender.ts', contents: prerender() },
];
