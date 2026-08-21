// The static entry. `x build --target static` runs this with `--out <dir>` and it writes one HTML
// file per `render: 'static'` route — a CDN or an object store then serves site/ with no process
// behind it. Every other render mode needs a running app and is reported as skipped, never emitted.
//
// The line below prints the INVENTORY, never a count: `report.pages.length` said an artifact was
// built and nothing about what was missing from it, which is the whole of #242 — a screenshot tool
// pointed at `.x/static/` filed "the island did not mount" against a route that had never been
// emitted. `skipped` now carries a reason per route, and `report` is the path the same inventory
// was written to, so a reader who lost this stdout can still open it.

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
    `${JSON.stringify({ ok: true, out: report.out, emitted: report.pages, skipped: report.skipped, report: report.report })}\n`,
  );
}
