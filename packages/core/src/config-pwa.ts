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
// `app.config.ts` CONSUMES the route vocabulary; it does not own it — `config.ts`'s rule, and the
// reason `OfflineStrategy` is imported rather than restated.
import type { OfflineStrategy } from './route-vocabulary';

/**
 * `installPrompt` was removed 2026-08, same rule: `@ultimat3/pwa`'s `createInstallController` is
 * real and complete, nothing ever threaded the flag into it, and both tracked apps plus every
 * scaffolded app set a switch with no wire. Call the controller from your own affordance instead.
 */
export interface PwaConfig {
  readonly enabled: boolean;
  readonly offline: OfflineStrategy;
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
  if (colors === undefined) {
    issues.push('pwa.colors is required when pwa.enabled is true, for both light and dark');
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
