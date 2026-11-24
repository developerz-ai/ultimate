// The static export's half of the site asset table: every asset copied under its hashed URL. The
// table itself is `@ultimat3/render/server`'s, shared with the test preload.

// why: Bun ships no sync copy or mkdir, and the export walks the table synchronously.
import { copyFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path'; // why: Bun ships no path API.
import { siteAssetTable } from '@ultimat3/render/server';

/**
 * Every asset, copied into the static export under its hashed URL — a static host serves with no
 * process behind it, so the artifact carries every byte a document names. Returns the URLs written.
 */
export function writeSiteAssets(root: string, out: string): readonly string[] {
  const written: string[] = [];
  for (const asset of siteAssetTable(root).all()) {
    const target = join(out, asset.url.slice(1));
    mkdirSync(dirname(target), { recursive: true });
    copyFileSync(asset.file, target);
    written.push(asset.url);
  }
  return written;
}
