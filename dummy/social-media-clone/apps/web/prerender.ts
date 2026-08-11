// The static entry. `x build --target static` runs this with `--out <dir>` and it writes one HTML
// file per `render: 'static'` route — a CDN or an object store then serves site/ with no process
// behind it. Every other render mode needs a running app and is reported as skipped, never emitted.

import { join } from 'node:path';
import { prerenderSite } from '@ultimat3/cli';

const root = join(import.meta.dir, '..', '..');
const flag = Bun.argv.indexOf('--out');
const out = (flag === -1 ? undefined : Bun.argv[flag + 1]) ?? join(root, '.x', 'static');
// SITE_ORIGIN is what canonical and og:url are built from; the default is only ever a local build.
const origin = Bun.env.SITE_ORIGIN;

if (import.meta.main) {
  const report = await prerenderSite({ root, out, ...(origin === undefined ? {} : { origin }) });
  await Bun.stdout.write(
    `${JSON.stringify({ ok: true, out: report.out, pages: report.pages.length, skipped: report.skipped })}\n`,
  );
}
