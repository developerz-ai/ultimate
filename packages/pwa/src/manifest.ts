/**
 * The web app manifest, generated from `app.config.ts`. Colours come from the design
 * tokens for BOTH schemes: the manifest spec carries one `theme_color`, so the dark value
 * is emitted as a media-scoped `<meta name="theme-color">` — otherwise an installed dark
 * app gets a light status bar on every launch.
 */

import { escapeAttribute } from '@ultimat3/seo';
import type { CapabilityFlags, ResolvedCapabilities } from './capabilities';
import { isEnabled, resolveCapabilities } from './capabilities';
import { PwaManifestInvalidError } from './errors';

export type DisplayMode = 'standalone' | 'fullscreen' | 'minimal-ui' | 'browser';
export type Orientation = 'any' | 'natural' | 'portrait' | 'landscape';

export interface ManifestIcon {
  readonly src: string;
  readonly sizes: string;
  readonly type: string;
  readonly purpose?: 'any' | 'maskable' | 'monochrome';
}

export interface ManifestShortcut {
  readonly name: string;
  readonly short_name?: string;
  readonly description?: string;
  readonly url: string;
  readonly icons?: readonly ManifestIcon[];
}

export interface ManifestScreenshot {
  readonly src: string;
  readonly sizes: string;
  readonly type: string;
  readonly form_factor?: 'narrow' | 'wide';
  readonly label?: string;
}

export interface ShareTarget {
  readonly action: string;
  readonly method: 'GET' | 'POST';
  readonly enctype?: string;
  readonly params: {
    readonly title?: string;
    readonly text?: string;
    readonly url?: string;
    readonly files?: readonly { readonly name: string; readonly accept: readonly string[] }[];
  };
}

export interface FileHandler {
  readonly action: string;
  readonly accept: Readonly<Record<string, readonly string[]>>;
}

export interface ProtocolHandler {
  readonly protocol: string;
  readonly url: string;
}

export interface WebManifest {
  readonly name: string;
  readonly short_name: string;
  readonly description?: string;
  readonly start_url: string;
  readonly scope: string;
  readonly id?: string;
  readonly display: DisplayMode;
  readonly display_override?: readonly DisplayMode[];
  readonly orientation: Orientation;
  readonly lang: string;
  readonly dir: 'ltr' | 'rtl' | 'auto';
  readonly theme_color: string;
  readonly background_color: string;
  readonly categories?: readonly string[];
  readonly icons: readonly ManifestIcon[];
  readonly shortcuts?: readonly ManifestShortcut[];
  readonly screenshots?: readonly ManifestScreenshot[];
  readonly share_target?: ShareTarget;
  readonly file_handlers?: readonly FileHandler[];
  readonly protocol_handlers?: readonly ProtocolHandler[];
}

/** Resolved token values for one colour scheme. Never a hex literal in framework code. */
export interface SchemeColors {
  readonly themeColor: string;
  readonly backgroundColor: string;
}

export interface ThemeTokens {
  readonly light: SchemeColors;
  readonly dark: SchemeColors;
}

/** The `pwa` block of `app.config.ts`. */
export interface PwaConfig {
  readonly name: string;
  readonly shortName?: string;
  readonly description?: string;
  readonly startUrl?: string;
  readonly scope?: string;
  readonly id?: string;
  readonly display?: DisplayMode;
  readonly orientation?: Orientation;
  readonly lang?: string;
  readonly dir?: 'ltr' | 'rtl' | 'auto';
  readonly tokens: ThemeTokens;
  readonly categories?: readonly string[];
  readonly icons?: readonly ManifestIcon[];
  readonly shortcuts?: readonly ManifestShortcut[];
  readonly screenshots?: readonly ManifestScreenshot[];
  readonly shareTarget?: ShareTarget;
  readonly fileHandlers?: readonly FileHandler[];
  readonly protocolHandlers?: readonly ProtocolHandler[];
  readonly capabilities?: CapabilityFlags;
}

export interface ThemeColorMeta {
  readonly content: string;
  readonly media: string;
}

export interface WebManifestResult {
  readonly manifest: WebManifest;
  /** Emit both into `<head>`; the manifest can only carry one. */
  readonly themeColorMeta: readonly ThemeColorMeta[];
  readonly capabilities: ResolvedCapabilities;
}

export function generateWebManifest(config: PwaConfig): WebManifestResult {
  assertValid(config);
  const capabilities = resolveCapabilities(config.capabilities);
  const scope = config.scope ?? '/';

  const optional: MutableManifest = {};
  if (config.description !== undefined) optional.description = config.description;
  if (config.id !== undefined) optional.id = config.id;
  if (config.categories !== undefined) optional.categories = config.categories;
  if (config.shortcuts !== undefined) optional.shortcuts = config.shortcuts;
  if (config.screenshots !== undefined) optional.screenshots = config.screenshots;

  // A disabled capability contributes no manifest member at all — not an empty one.
  if (isEnabled(capabilities, 'shareTarget') && config.shareTarget !== undefined) {
    optional.share_target = config.shareTarget;
  }
  if (isEnabled(capabilities, 'fileHandlers') && config.fileHandlers !== undefined) {
    optional.file_handlers = config.fileHandlers;
  }
  if (isEnabled(capabilities, 'protocolHandlers') && config.protocolHandlers !== undefined) {
    optional.protocol_handlers = config.protocolHandlers;
  }

  const manifest: WebManifest = {
    name: config.name,
    short_name: config.shortName ?? config.name.slice(0, 12),
    start_url: config.startUrl ?? scope,
    scope,
    display: config.display ?? 'standalone',
    display_override: ['standalone', 'minimal-ui'],
    orientation: config.orientation ?? 'any',
    lang: config.lang ?? 'en',
    dir: config.dir ?? 'ltr',
    theme_color: config.tokens.light.themeColor,
    background_color: config.tokens.light.backgroundColor,
    icons: config.icons ?? [],
    ...optional,
  };

  return {
    manifest,
    themeColorMeta: [
      { content: config.tokens.light.themeColor, media: '(prefers-color-scheme: light)' },
      { content: config.tokens.dark.themeColor, media: '(prefers-color-scheme: dark)' },
    ],
    capabilities,
  };
}

type MutableManifest = { -readonly [K in keyof WebManifest]?: WebManifest[K] };

function assertValid(config: PwaConfig): void {
  if (config.name.trim() === '') {
    throw new PwaManifestInvalidError(
      'pwa.name is empty, so the install prompt would have no title',
      'set pwa.name in app.config.ts',
    );
  }
  const scope = config.scope ?? '/';
  const startUrl = config.startUrl ?? scope;
  if (!startUrl.startsWith(scope)) {
    throw new PwaManifestInvalidError(
      `pwa.startUrl ${JSON.stringify(startUrl)} is outside pwa.scope ${JSON.stringify(scope)}, ` +
        'so the installed app would open out of scope',
      `set pwa.startUrl to a path under ${scope} in app.config.ts`,
    );
  }
  for (const scheme of ['light', 'dark'] as const) {
    const colors = config.tokens[scheme];
    if (colors.themeColor.trim() === '' || colors.backgroundColor.trim() === '') {
      throw new PwaManifestInvalidError(
        `pwa.tokens.${scheme} is missing themeColor or backgroundColor`,
        `resolve the ${scheme} theme tokens in app.config.ts — both schemes are required`,
      );
    }
  }
}

/** Deterministic serialization for the emitted `manifest.webmanifest`. */
export function serializeWebManifest(manifest: WebManifest): string {
  return `${JSON.stringify(manifest, null, 2)}\n`;
}

export function renderThemeColorMeta(metas: readonly ThemeColorMeta[]): string {
  return metas
    .map(
      // Both values are attribute sinks. `assertValid` only asks that a token is non-empty, so a
      // quote in one emitted a second, live attribute — same class as `appleTouchLinks`, same
      // escaper, one per package rather than one per call site.
      (meta) =>
        `<meta name="theme-color" content="${escapeAttribute(meta.content)}" media="${escapeAttribute(meta.media)}">`,
    )
    .join('');
}
