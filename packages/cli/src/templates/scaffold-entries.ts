// The two entry files a deploy needs — `apps/web/server.ts` and `apps/web/prerender.ts`. Split out
// of `scaffold-app.ts` because that file is the three SURFACES and these are neither: they are what
// a container starts and what a CDN is handed. Both are deliberately thin — which role a container
// is, which port it binds, how it drains and what a static build enumerates are the framework's
// answers, so an upgrade moves them without a codemod in every app that ever shipped.

import type { GeneratedFile } from './naming';

const server =
  (): string => `// The production entry. \`docker/Dockerfile\` starts this, and \`x build --target binary\` compiles it.
// ROLE selects what this process is — web, sync, worker, scheduler, replicator, or migrate, which
// applies the migrations and exits. PORT is bound on HOST, and HOST defaults to every interface,
// because a container bound to loopback is unreachable through its own port mapping. HOST=127.0.0.1
// is for a process that must never answer a public interface: reachable only where the container
// shares the host's network namespace (\`--network host\`), or through a sidecar and \`ssh -L\`.

import { join } from 'node:path';
import { runRole } from '@ultimat3/cli/serve';

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
import { loadSiteSettings, type PrerenderReport, prerenderSite, siteSeo } from '@ultimat3/cli';

const root = join(import.meta.dir, '..', '..');
const flag = Bun.argv.indexOf('--out');
const out = (flag === -1 ? undefined : Bun.argv[flag + 1]) ?? join(root, '.x', 'static');
// SITE_ORIGIN is what canonical and og:url are built from; the default is only ever a local build.
// Property access, not \`Bun.env['SITE_ORIGIN']\`: the scaffolded tsconfig does not set
// \`noPropertyAccessFromIndexSignature\`, so the bracket form is the one biome's useLiteralKeys
// reports — a diagnostic in an app's first lint run over a file the app never wrote.
const origin = Bun.env.SITE_ORIGIN;

/**
 * \`sitemap.xml\` and \`robots.txt\`, into the same directory the HTML went: a static export is
 * served with no process behind it, so the CDN needs the files. \`siteSeo\` is the same answer a
 * running web role serves at \`/sitemap.xml\` and \`/robots.txt\` — the public \`site/\` routes, a
 * page whose \`meta\` says \`robots: { index: false }\` left out — so a crawler reads one sitemap
 * from the CDN and from the container.
 *
 * A DYNAMIC route contributes exactly the URLs this build emitted for it, read back off the report
 * rather than by calling \`prerender()\` a second time: the sitemap then cannot name a page the
 * artifact does not contain.
 *
 * \`robots.txt\` fails closed — anything that is not \`ULTIMATE_ENV=production\` emits
 * \`Disallow: /\` and advertises no sitemap — so a preview build cannot outrank the real site.
 */
async function writeSeoFiles(report: PrerenderReport): Promise<readonly string[]> {
  const seo = await siteSeo({
    // The origin the pages were built against, so the sitemap and every canonical agree.
    baseUrl: report.origin,
    disallow: (await loadSiteSettings(root)).disallow,
    pagesFor: (route) =>
      report.pages.filter((page) => page.route === route).map((page) => page.path),
  });
  for (const file of seo.sitemaps) await Bun.write(join(out, file.path), file.xml);
  await Bun.write(join(out, 'robots.txt'), seo.robots);
  return [...seo.sitemaps.map((file) => file.path), '/robots.txt'];
}

if (import.meta.main) {
  const report = await prerenderSite({ root, out, ...(origin === undefined ? {} : { origin }) });
  const seo = await writeSeoFiles(report);
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
