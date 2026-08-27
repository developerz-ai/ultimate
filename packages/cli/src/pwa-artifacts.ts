// The web manifest an installable app promises, and that no build had ever produced.
//
// `pwa.enabled` was a switch with no reader anywhere in the tree (issue #362, and
// `scripts/lib/config-reader-pins.ts` pinned it as a `jobs.driver` candidate). `@ultimat3/pwa` has
// shipped `generateWebManifest`, `renderThemeColorMeta`, `planIcons` and `appleTouchLinks` since it
// existed and NOTHING called them, so every Ultimate app served a `<head>` with no
// `<link rel="manifest">`, no `theme-color` and no apple-touch icon — and no browser has ever
// offered to install one, however the config was written.
//
// WHY HERE. `dev-assets.ts`'s reason exactly: three packages declare what an installable app is and
// none of them can read a config file off disk. This one composes tier 0's `pwa` block with tier
// 4's generator and hands both served surfaces and the static export the same two strings.
//
// WHAT IT DOES NOT DO: emit a service worker. `offline`, `backgroundSync` and `push` still have no
// build behind them — `wiki/PWA-And-Offline.md` says so — and a bad `sw.js` is sticky in a way a
// manifest is not, so the worker lands behind a real browser check rather than beside this.

// why: Bun exposes no synchronous file-existence primitive, and this read is the same one
// `app-auth.ts` and `dev-cache.ts` each make before importing an app's config — a root with no
// `app.config.ts` is an ordinary answer here (a scratch root, `x build` outside an app).
import { existsSync } from 'node:fs';
// why: Bun exposes no path-join primitive, and `APP_CONFIG_FILE` is app-root-relative — the same
// necessity `favicon.ts` and `dev-assets.ts` each record for their own root-relative constant.
import { join } from 'node:path';
import type { PwaColors, PwaOfflineConfig } from '@ultimat3/core';
import type { CacheHint, Route, UltimateRequest } from '@ultimat3/http';
import { applyCacheHeaders } from '@ultimat3/http';
import {
  appleTouchLinks,
  generateWebManifest,
  renderThemeColorMeta,
  serializeWebManifest,
} from '@ultimat3/pwa';
import { escapeAttribute } from '@ultimat3/seo';
import { APP_CONFIG_EXPORT } from './app-auth';
import { APP_CONFIG_FILE } from './app-root';
import { hasSourceIcon, iconPlan, iconRenderer } from './icon-assets';

/** What a browser fetches from `<link rel="manifest">`. The spec's own extension, not `.json`. */
export const WEB_MANIFEST_PATH = '/manifest.webmanifest';

/**
 * Short, never immutable. The path carries no content hash, so an app that changed its install
 * title must be able to publish it — an hour is `favicon.ts`'s number, for the same asset class.
 */
const MANIFEST_CACHE: CacheHint = { mode: 'public', maxAgeSeconds: 3600 };

/** The two strings every surface needs: the file's bytes, and what `<head>` must carry to name it. */
export interface PwaArtifacts {
  /** `manifest.webmanifest`, serialized. */
  readonly body: string;
  /**
   * `<link rel="manifest">`, both `theme-color` metas, and every apple-touch icon link. One string
   * because a document either carries all of it or none: a manifest link with no theme colour
   * installs an app whose status bar flashes white on every launch, and an apple-touch link with
   * no manifest is an iOS icon for an app iOS will not add.
   */
  readonly head: string;
  /**
   * The three `pwa` keys the SERVICE WORKER needs, carried here because this is the one module
   * that reads an app's config file — `sw-artifacts.ts` needs the route table and the island
   * bundle as well, and a second `await import` of `app.config.ts` would be a second answer to
   * "what did this app declare".
   */
  readonly offline: PwaOfflineConfig;
  readonly backgroundSync: boolean;
  readonly push: boolean;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;

const text = (value: unknown): string | undefined =>
  typeof value === 'string' && value.trim() !== '' ? value : undefined;

/**
 * `colors` read structurally, for `loadSignInPath`'s reason: `defineConfig` returns a plain object
 * and a config resolved through an older core simply has no such key. `validate()` already refused
 * a blank one an `await import` above this line, so anything this rejects is a hand-written config
 * object — and the honest answer for one is no manifest at all, never a colour we invented.
 */
function colorsOf(value: unknown): PwaColors | undefined {
  if (!isRecord(value)) return undefined;
  const light = isRecord(value['light']) ? value['light'] : undefined;
  const dark = isRecord(value['dark']) ? value['dark'] : undefined;
  if (light === undefined || dark === undefined) return undefined;
  const [lt, lb, dt, db] = [
    text(light['themeColor']),
    text(light['backgroundColor']),
    text(dark['themeColor']),
    text(dark['backgroundColor']),
  ];
  if (lt === undefined || lb === undefined || dt === undefined || db === undefined)
    return undefined;
  return {
    light: { themeColor: lt, backgroundColor: lb },
    dark: { themeColor: dt, backgroundColor: db },
  };
}

/** The `pwa` block, as much of it as this file needs, or `undefined` when the app declares none. */
interface InstallableApp {
  readonly name: string;
  readonly colors: PwaColors;
  readonly offline: PwaOfflineConfig;
  readonly backgroundSync: boolean;
  readonly push: boolean;
}

async function loadInstallable(root: string): Promise<InstallableApp | undefined> {
  const configPath = join(root, APP_CONFIG_FILE);
  if (!existsSync(configPath)) return undefined;
  const module = (await import(configPath)) as Record<string, unknown>;
  const config = module[APP_CONFIG_EXPORT];
  if (!isRecord(config)) return undefined;
  const pwa = config['pwa'];
  // `pwa.enabled`, read. Not a truthiness test: `enabled` is the key this whole file exists to
  // give a reader, and `=== true` is what makes a hand-written `enabled: 'yes'` produce no
  // manifest rather than one nobody asked for.
  if (!isRecord(pwa) || pwa['enabled'] !== true) return undefined;
  const name = text(pwa['name']);
  const colors = colorsOf(pwa['colors']);
  if (name === undefined || colors === undefined) return undefined;
  return { name, colors, offline: offlineOf(pwa['offline']), ...flags(pwa) };
}

/**
 * The offline block, read structurally for `colorsOf`'s reason: `defineConfig` refuses
 * `enabled: true` without an absolute `offline.fallback`, but a HAND-WRITTEN config object never
 * passed through it. A missing or relative fallback answers `null`, and `serviceWorkerArtifacts`
 * then emits no worker at all — never a path the framework invented, which offline would be a
 * cached 404 answering every navigation.
 */
function offlineOf(value: unknown): PwaOfflineConfig {
  const block = isRecord(value) ? value : {};
  const fallback = text(block['fallback']);
  const patterns = block['neverCache'];
  return {
    fallback: fallback?.startsWith('/') === true ? fallback : null,
    image: text(block['image']) ?? null,
    font: text(block['font']) ?? null,
    neverCache: Array.isArray(patterns)
      ? patterns.filter((entry): entry is string => typeof entry === 'string')
      : [],
  };
}

/** `=== true` for `enabled`'s reason: a hand-written `backgroundSync: 'yes'` wires nothing. */
const flags = (pwa: Record<string, unknown>): { backgroundSync: boolean; push: boolean } => ({
  backgroundSync: pwa['backgroundSync'] === true,
  push: pwa['push'] === true,
});

/**
 * Resolved ONCE at boot, like `loadSignInPath` and `loadCacheTiers` and unlike `faviconBytes`:
 * `await import` caches the module, so re-reading per request would answer the same object at a
 * per-request cost, and the head string has to be available synchronously while a document renders.
 */
export async function loadPwaArtifacts(root: string): Promise<PwaArtifacts | undefined> {
  const app = await loadInstallable(root);
  if (app === undefined) return undefined;
  // The icons the manifest promises are exactly the ones `/icons/*` serves and `x build` writes —
  // ONE plan, so no surface can name a size another will not produce.
  //
  // AND ONLY WHEN THE APP HAS A SOURCE FOR THEM. `planIcons` answers the same fourteen entries
  // whether `apps/web/site/icon.png` exists or not, so a manifest built off it unconditionally
  // promises twelve icons and three apple-touch links that are twelve 404s in an install prompt —
  // the promise-nothing-keeps shape this whole module exists to close, one level down.
  // `examples/dummy` is exactly that app: it declares `pwa.enabled: true` and commits no icon.
  // A missing source is NOT reported here — `x doctor` already refuses it by name with
  // `X_PWA_ICON_MISSING`, and a second reporter of one condition is the duplication this package's
  // own rule forbids. Read at boot, like the rest of this function: adding the file takes effect
  // on the next start, because the manifest is generated once and served as bytes.
  const icons = (await hasSourceIcon(root)) ? iconPlan() : undefined;
  const result = generateWebManifest({
    name: app.name,
    tokens: app.colors,
    icons: icons?.manifestIcons ?? [],
  });
  return {
    offline: app.offline,
    backgroundSync: app.backgroundSync,
    push: app.push,
    body: serializeWebManifest(result.manifest),
    head:
      `<link rel="manifest" href="${escapeAttribute(WEB_MANIFEST_PATH)}">` +
      renderThemeColorMeta(result.themeColorMeta) +
      (icons === undefined ? '' : appleTouchLinks(icons)),
  };
}

/**
 * The icon bytes a STATIC export has to carry, written under `out`. Answers the paths it wrote.
 *
 * A static host runs no `assetRoutes()`, so every `/icons/*` entry the manifest names is a 404
 * unless the bytes are in the artifact — the same rule `prerenderSite` already applies to
 * `favicon.ico` and `404.html`, one asset class further along. Nothing when the app has no source
 * icon, which is also when the manifest names none.
 */
export async function writePwaIcons(root: string, out: string): Promise<readonly string[]> {
  if (!(await hasSourceIcon(root))) return [];
  const plan = iconPlan();
  const render = iconRenderer(root);
  const written: string[] = [];
  for (const entry of plan.entries) {
    // `outputPath` is `/icons/<file>`; `out` is the export root, so the leading slash goes.
    await Bun.write(join(out, entry.outputPath.slice(1)), await render(plan, entry.outputPath));
    written.push(entry.outputPath);
  }
  return written;
}

/**
 * Mounted through `assetRoutes`, so `x dev` and the container serve it from one place — a surface
 * that answers in dev and not in the image is the failure that file's own header names.
 * Public: a browser fetches a manifest before anyone has signed in, and an installable app that
 * needs a session to describe itself is not installable.
 */
export const pwaManifestRoute = (artifacts: PwaArtifacts): Route => ({
  method: 'GET',
  path: WEB_MANIFEST_PATH,
  meta: { name: 'assets.manifest', auth: 'public', cache: MANIFEST_CACHE, tags: ['assets'] },
  handler: async (_request: UltimateRequest): Promise<Response> =>
    applyCacheHeaders(
      new Response(artifacts.body, {
        headers: { 'content-type': 'application/manifest+json; charset=utf-8' },
      }),
      MANIFEST_CACHE,
    ),
});
