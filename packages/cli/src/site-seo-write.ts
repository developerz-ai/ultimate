// Single responsibility: `siteSeo()`'s answer as files in a static export — `/sitemap.xml`, every
// part an index names, `robots.txt` and `llms.txt` — so a CDN serves the bytes a running web role answers.

// why: Bun exposes no path-join primitive, and every file path is relative to the output root.
import { join } from 'node:path';
import { LLMS_PATH } from '@ultimat3/seo';
import { ROBOTS_PATH, type SiteSeo } from './site-seo';

/**
 * Writes every file of `seo` under `out` and answers their site-relative paths, the sitemap files
 * first. `Bun.write` creates `sitemaps/` on the way, so an index and its parts land together.
 * `llms: false` (`seo.llms`) writes no `llms.txt`: the path is the app's, as on a running web role.
 */
export async function writeSiteSeo(
  out: string,
  seo: SiteSeo,
  options: { readonly llms?: boolean | undefined } = {},
): Promise<readonly string[]> {
  for (const file of seo.sitemaps) await Bun.write(join(out, file.path), file.xml);
  await Bun.write(join(out, ROBOTS_PATH), seo.robots);
  const sitemaps = seo.sitemaps.map((file) => file.path);
  if (options.llms === false) return [...sitemaps, ROBOTS_PATH];
  await Bun.write(join(out, LLMS_PATH), seo.llms);
  return [...sitemaps, ROBOTS_PATH, LLMS_PATH];
}
