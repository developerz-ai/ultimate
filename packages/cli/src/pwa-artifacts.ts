// The web manifest an installable app promises, and that no build had ever produced.
//
// `pwa.enabled` was a switch with no reader anywhere in the tree (issue #362, and
// `scripts/lib/config-reader-pins.ts` pinned it as a `jobs.driver` candidate). `@ultimat3/pwa` has
// shipped `generateWebManifest`, `renderThemeColorMeta`, `planIcons` and `appleTouchLinks` since it
// existed and NOTHING called them, so every Ultimate app served a `<head>` with no
// `<link rel="manifest">`, no `theme-color` and no apple-touch icon — and no browser has ever
// offered to install one, however the config was written.
//
// WHY HERE. `runtime-assets.ts`'s reason exactly: three packages declare what an installable app is and
// none of them can read a config file off disk. This one composes tier 0's `pwa` block with tier
// 4's generator and hands both served surfaces and the static export the same two strings.
//
// WHAT IT DOES NOT DO: emit a service worker. `offline`, `backgroundSync` and `push` still have no
// build behind them — `wiki/PWA-And-Offline.md` says so — and a bad `sw.js` is sticky in a way a
// manifest is not, so the worker lands behind a real browser check rather than beside this.

// why: Bun exposes no path-join primitive, and the export writes each icon under an out directory.
import { join } from 'node:path';
import type { PwaColors, PwaOfflineConfig } from '@ultimat3/core';
import { escapeHtml, localeSegment, pushWired } from '@ultimat3/core';
import type { CacheHint, RequestContext, Route, UltimateRequest } from '@ultimat3/http';
import { applyCacheHeaders } from '@ultimat3/http';
import { appLocaleSet } from '@ultimat3/i18n/app-catalogs';
import {
  appleTouchLinks,
  generateWebManifest,
  renderThemeColorMeta,
  serializeWebManifest,
} from '@ultimat3/pwa';
import type { AssetPath } from '@ultimat3/render';
import { assetPathProblem } from '@ultimat3/render';
import { loadAppConfig } from './app-config-load';
import { hasSourceIcon, iconPlan, iconRenderer } from './icon-assets';
import type { AppLocales } from './pwa-manifest-locales';
import { appLocales, localeMembers, spellIn } from './pwa-manifest-locales';
import { parseHashedAssetUrl, siteAssetTable } from './site-assets';

/** What a browser fetches from `<link rel="manifest">`. The spec's own extension, not `.json`. */
export const WEB_MANIFEST_PATH = '/manifest.webmanifest';

/**
 * Short, never immutable. The path carries no content hash, so an app that changed its install
 * title must be able to publish it — an hour is `favicon.ts`'s number, for the same asset class.
 */
const MANIFEST_CACHE: CacheHint = { mode: 'public', maxAgeSeconds: 3600 };

/** One routed locale's manifest: where it is served, its bytes, and the `<head>` that names it. */
export interface LocalizedManifest {
  readonly locale: string;
  /** `/manifest.webmanifest` for the default locale, `/en/manifest.webmanifest` for `en`. */
  readonly path: string;
  readonly body: string;
  readonly head: string;
}

/** The two strings every surface needs: the file's bytes, and what `<head>` must carry to name it. */
export interface PwaArtifacts {
  /** The DEFAULT locale's `manifest.webmanifest`, serialized — `manifests[0].body`. */
  readonly body: string;
  /**
   * `<link rel="manifest">`, both `theme-color` metas, and every apple-touch icon link. One string
   * because a document either carries all of it or none: a manifest link with no theme colour
   * installs an app whose status bar flashes white on every launch, and an apple-touch link with
   * no manifest is an iOS icon for an app iOS will not add.
   */
  readonly head: string;
  /**
   * One manifest per routed locale, default first. Each speaks its own `lang`, starts at its own
   * home and spells its shortcuts in its own locale; one `id` makes them one installed app. There
   * was one manifest, `lang: "en"`, for an `es-co` app with an English half (22.3.2).
   */
  readonly manifests: readonly LocalizedManifest[];
  /** The `<head>` for a document in `locale` — it links that locale's manifest. */
  headFor(locale: string): string;
  /**
   * The three `pwa` keys the SERVICE WORKER needs, carried here so `sw-artifacts.ts` — which needs
   * the route table and the island bundle as well — reads them off the same resolved block.
   */
  readonly offline: PwaOfflineConfig;
  readonly backgroundSync: boolean;
  readonly push: boolean;
  /**
   * The routed locales the manifests above were built from, default first — `appLocaleSet`'s one
   * answer, carried here so the service worker prefixes exactly the locales the manifests name.
   */
  readonly locales: AppLocales;
}

/** The `pwa` block, as much of it as this file needs, or `undefined` when the app declares none. */
interface InstallableApp {
  readonly name: string;
  readonly colors: PwaColors;
  /** The block itself, for the manifest members `pwa-manifest-locales.ts` reads per locale. */
  readonly block: Record<string, unknown>;
  readonly locales: AppLocales;
  readonly offline: PwaOfflineConfig;
  readonly backgroundSync: boolean;
  readonly push: boolean;
}

/**
 * `pwa.enabled`, read, off the one loader (`app-config-load.ts`). Core's validator refuses an
 * enabled block without a name, both colour schemes or an absolute `offline.fallback`, so nothing
 * here invents a colour or a fallback route; `colors` is optional only in the type.
 */
async function loadInstallable(root: string): Promise<InstallableApp | undefined> {
  const config = await loadAppConfig(root);
  const pwa = config?.pwa;
  if (config === undefined || pwa === undefined || !pwa.enabled || pwa.colors === undefined) {
    return undefined;
  }
  return {
    name: pwa.name,
    colors: pwa.colors,
    block: { ...pwa },
    locales: appLocales(await appLocaleSet(root)),
    offline: pwa.offline,
    backgroundSync: pwa.backgroundSync,
    push: pushWired(pwa),
  };
}

/**
 * Resolved ONCE at boot, like `loadSignInPath` and unlike `faviconBytes`: the loader's
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
  const manifests = app.locales.routed.map((locale): LocalizedManifest => {
    const result = generateWebManifest({
      name: app.name,
      tokens: app.colors,
      icons: icons?.manifestIcons ?? [],
      ...withHashedAssets(localeMembers(app.block, locale, app.locales), root),
    });
    const path = spellIn(WEB_MANIFEST_PATH, locale, app.locales);
    return {
      locale,
      path,
      body: serializeWebManifest(result.manifest),
      head:
        `<link rel="manifest" href="${escapeHtml(path)}">` +
        renderThemeColorMeta(result.themeColorMeta) +
        (icons === undefined ? '' : appleTouchLinks(icons)),
    };
  });
  // `routed` always holds the default first, so this is never undefined; the guard is the type's.
  const primary = manifests[0];
  if (primary === undefined) return undefined;
  return {
    offline: app.offline,
    backgroundSync: app.backgroundSync,
    push: app.push,
    locales: app.locales,
    body: primary.body,
    head: primary.head,
    manifests,
    headFor: (locale: string): string => manifestIn(manifests, locale)?.head ?? primary.head,
  };
}

/**
 * A screenshot or shortcut icon written as the asset it is — `assets/pwa/wide.png` or
 * `/assets/pwa/wide.png` — answers the content-hashed URL the site actually serves, exactly as
 * `asset()` does in a page. The site serves an asset ONLY at its hashed URL, and the manifest took
 * `src` verbatim, so an app had to hash its own screenshots to avoid shipping a 404 in the install
 * sheet (notificado.co's `pwa-install.ts`). A missing file is `X_ASSET_MISSING` at boot, never a
 * broken image in an install prompt; any other `src` passes untouched — an absolute path outside
 * `/assets/`, an already hashed one, or a shortcut icon's off-site URL (core screens screenshots and
 * shortcut urls to absolute paths, not icon sources).
 */
function withHashedAssets<M extends ReturnType<typeof localeMembers>>(members: M, root: string): M {
  const resolve = (src: string): string => {
    const path = src.replace(/^\//, '');
    if (!path.startsWith('assets/') || parseHashedAssetUrl(`/${path}`) !== undefined) return src;
    if (assetPathProblem(path) !== undefined) return src;
    return siteAssetTable(root).resolve(path as AssetPath).url;
  };
  return {
    ...members,
    ...(members.screenshots === undefined
      ? {}
      : { screenshots: members.screenshots.map((shot) => ({ ...shot, src: resolve(shot.src) })) }),
    ...(members.shortcuts === undefined
      ? {}
      : {
          shortcuts: members.shortcuts.map((shortcut) =>
            shortcut.icons === undefined
              ? shortcut
              : {
                  ...shortcut,
                  icons: shortcut.icons.map((icon) => ({ ...icon, src: resolve(icon.src) })),
                },
          ),
        }),
  };
}

/** The manifest `locale` names, by URL segment (`es-CO` is `es-co`), if the app routes it. */
const manifestIn = (
  manifests: readonly LocalizedManifest[],
  locale: string | undefined,
): LocalizedManifest | undefined =>
  locale === undefined
    ? undefined
    : manifests.find((manifest) => localeSegment(manifest.locale) === localeSegment(locale));

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
  // `'path'`: `/en/manifest.webmanifest` reaches this route with its prefix split off and `en` as the
  // locale, and the bare path is the default locale's — never negotiated, so a CDN may cache both.
  meta: {
    name: 'assets.manifest',
    auth: 'public',
    cache: MANIFEST_CACHE,
    tags: ['assets'],
    localeSource: 'path',
  },
  handler: async (_request: UltimateRequest, ctx: RequestContext): Promise<Response> =>
    applyCacheHeaders(
      new Response(manifestIn(artifacts.manifests, ctx.locale)?.body ?? artifacts.body, {
        headers: { 'content-type': 'application/manifest+json; charset=utf-8' },
      }),
      MANIFEST_CACHE,
    ),
});
