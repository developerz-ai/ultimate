// Single responsibility: the `pwa` block of `app.config.ts` — what an app must say before a
// browser will offer to install it, and the boot-time refusal when it has not.
//
// SPLIT OUT OF `config.ts` because that file reached its 500-line ceiling, and this is the seam
// that costs nothing to cross: `enabled` turns four other requirements on, so the shape, the screen
// and the remedy are one subject. `config.ts` keeps the one call.
//
// WHY THE SCREEN IS HERE AND NOT AT EMIT. `@ultimat3/pwa`'s `generateWebManifest` refuses a blank
// title too, and that refusal arrives at `x build` — which is the wrong moment: an agent that ran
// `x dev`, saw a served app and shipped it would meet the missing title in CI. Two checks, two
// subjects (a config file, and a function argument a library caller supplies directly).

import { describeValue } from './error-render';

/**
 * `installPrompt` was removed 2026-08, same rule: `@ultimat3/pwa`'s `createInstallController` is
 * real and complete, nothing ever threaded the flag into it, and both tracked apps plus every
 * scaffolded app set a switch with no wire. Call the controller from your own affordance instead.
 */
/**
 * What the service worker needs that no route can say for itself.
 *
 * `fallback` is the document a navigation gets when the network is gone and the cache has no
 * answer — the one thing an offline app cannot do without, and the reason this block replaced a
 * bare `offline: OfflineStrategy`. That key was an app-wide DEFAULT for a field `defineRoute`
 * makes **required** on every route (`route.ts` refuses a route without one), so it defaulted
 * nothing, was read by nobody, and could not be given a reader without inventing a meaning for it
 * (#390).
 *
 * The other three are `@ultimat3/pwa`'s `OfflineConfig` verbatim, and each is read by the emitter
 * that builds `sw.js`: a placeholder image, a placeholder font, and the request patterns that must
 * never be answered from a cache — auth and payments, where a stale 200 is worse than a failure.
 */
export interface PwaOfflineConfig {
  /** Absolute route path of the offline document, e.g. `/offline`. Required once `enabled`. */
  readonly fallback: string | null;
  readonly image: string | null;
  readonly font: string | null;
  readonly neverCache: readonly string[];
}

export interface PwaConfig {
  readonly enabled: boolean;
  readonly offline: PwaOfflineConfig;
  readonly backgroundSync: boolean;
  readonly push: boolean;
  /**
   * The install title, and the one manifest member nothing can derive. `AppConfig.name` is a slug
   * (`^[a-z][a-z0-9-]{1,63}$`) and an install prompt shows a person a title, so `ledger-demo` is
   * the wrong answer rather than a rough one. Required once `enabled` is true; `''` is what a
   * disabled block resolves to.
   */
  readonly name: string;
  /**
   * `theme_color` and `background_color`, per scheme. Required once `enabled` is true, and
   * `undefined` otherwise — never a colour the framework picked. There is no defensible default:
   * an install splash painted in a colour nobody chose is a wrong-looking app that boots, which is
   * worse than a boot that names the four values it needs.
   */
  readonly colors: PwaColors | undefined;
}

/**
 * The install chrome's two colours for one scheme, as CSS colour strings.
 *
 * ONE OF THE TWO PLACES A RAW COLOUR IS LEGAL, alongside `ThemeConfig.tokens` one section up, and
 * for a stronger reason than that one has: a browser paints the install splash and the address bar
 * from these before a single stylesheet has loaded, so there is no token to resolve them against
 * and no component anywhere in the loop.
 */
export interface PwaSchemeColors {
  readonly themeColor: string;
  readonly backgroundColor: string;
}

/**
 * Both schemes, because a web manifest carries exactly one `theme_color` and `<head>` carries a
 * media-scoped `<meta name="theme-color">` per scheme. One value would make the dark answer the
 * light one's, on the surface a reader sees before the app has painted anything.
 */
export interface PwaColors {
  readonly light: PwaSchemeColors;
  readonly dark: PwaSchemeColors;
}

/**
 * The two schemes and the two colours `validate` screens, for `INBOX_RETENTION_KEYS`' reason: a
 * third member added to `PwaColors` or `PwaSchemeColors` without a row here is a value an app can
 * leave blank, and `config.test.ts` asserts both lists against the types so the omission is a red
 * test rather than a manifest with an empty `theme_color`.
 */
export const PWA_SCHEMES = ['light', 'dark'] as const;
export const PWA_COLOR_KEYS = ['themeColor', 'backgroundColor'] as const;

/**
 * Appended only when the `pwa` block is what failed, and it carries the whole block rather than
 * the missing key: `pwa.enabled` is what turns four other requirements on, so a reader who set one
 * boolean needs to see the complete shape and the opt-out in the same line.
 */
export const PWA_FIX =
  "in app.config.ts, complete the pwa block: pwa: { enabled: true, offline: 'runtime', name: 'My App', colors: { light: { themeColor: '#1b1f3b', backgroundColor: '#ffffff' }, dark: { themeColor: '#1b1f3b', backgroundColor: '#0b0d1a' } } } — a browser paints the install splash and the address bar from those four values before any stylesheet loads, so there is nothing for the framework to derive them from; or set pwa.enabled: false";

/**
 * Every rule `validate` applies to the block, appended to the caller's own issue list. Answers
 * whether IT found anything, so the pwa remedy rides only on a pwa finding: `issues` may already
 * hold a bad locale, and a fix line naming the install block for that is axiom 4 broken.
 *
 * `describeValue` for the reason the retention windows use it — this is where an untyped config
 * object crosses into the framework, so every value here is `unknown` however the interface types it.
 */
export function pwaIssues(pwa: PwaConfig, issues: string[]): boolean {
  if (!pwa.enabled) return false;
  const before = issues.length;
  const { name, colors } = pwa;
  if (typeof name !== 'string' || name.trim() === '') {
    issues.push(`pwa.name is required when pwa.enabled is true, and is ${describeValue(name)}`);
  }
  // An ABSOLUTE path, screened here rather than at emit for this file's own stated reason: a
  // relative one resolves against whatever document registered the worker, so `offline` served
  // under `/posts/1` is `/posts/offline` — a 404 cached as the answer to every offline navigation.
  // `pwa.enabled` means an installable app, and an installable app that shows the browser's error
  // page offline is the failure the whole block exists to prevent, so this is required rather
  // than optional: the alternative is two meanings for one switch (axiom 1).
  const fallback: unknown = pwa.offline?.fallback;
  if (typeof fallback !== 'string' || !fallback.startsWith('/')) {
    issues.push(
      `pwa.offline.fallback is required when pwa.enabled is true and must be an absolute route path like "/offline", and is ${describeValue(fallback)}`,
    );
  }
  // `typeof !== 'object' || null`, never `=== undefined`: an untyped `app.config.ts` writing
  // `pwa.colors: null` reached `null[scheme]` one line down and took the boot out with a native
  // `TypeError`, from the validator whose whole job is producing an instruction instead of one.
  if (colors === null || typeof colors !== 'object') {
    issues.push(
      `pwa.colors is required when pwa.enabled is true, for both light and dark, and is ${describeValue(colors)}`,
    );
  } else {
    for (const scheme of PWA_SCHEMES) {
      for (const key of PWA_COLOR_KEYS) {
        const value: unknown = colors[scheme]?.[key];
        if (typeof value === 'string' && value.trim() !== '') continue;
        issues.push(
          `pwa.colors.${scheme}.${key} must be a CSS colour, not ${describeValue(value)}`,
        );
      }
    }
  }
  return issues.length > before;
}
