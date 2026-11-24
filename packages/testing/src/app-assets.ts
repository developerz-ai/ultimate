// The app's site asset table, installed into `asset()` in a test process the way the app's boot
// installs it: a page, a component or a stylesheet whose Sass calls `asset()` resolves to the same
// hashed URL in a unit test as in `x dev`, and a file the app does not hold is still refused.

import { setAssetResolver } from '@ultimat3/render';
import { siteAssetTable } from '@ultimat3/render/server';
import { isAppRoot } from './app-root';

/**
 * Installs `root`'s table and answers `true`, or answers `false` and installs nothing where `root`
 * is not an app (the framework's own suites). The preload calls it once and again at every file
 * boundary, so a test that installed its own resolver and handed the slot back with
 * `setAssetResolver(undefined)` leaves the next file the app's table, not none.
 */
export function installAppAssets(root: string = process.cwd()): boolean {
  if (!isAppRoot(root)) return false;
  const table = siteAssetTable(root);
  setAssetResolver((path) => table.resolve(path).url);
  return true;
}
