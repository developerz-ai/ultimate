// Admin branding through the token system only. `ThemeTokenRef` is a template-literal type,
// so `accent: '#7c3aed'` is a compile error rather than a code-review comment: branding
// aliases one design token to another, and every colour still resolves in @ultimat3/ui's
// light and dark scales.

/** Any framework design token. Raw hex, `rgb()`, and colour names cannot satisfy this. */
export type ThemeTokenRef = `--x-${string}`;

export type ThemeMode = 'system' | 'light' | 'dark';

export interface AdminBranding {
  /** i18n key for the product name in the header and the document title. */
  readonly nameKey: string;
  readonly logo?: { readonly src: string; readonly altKey: string; readonly width?: number };
  /** Alias for `--x-color-accent`, e.g. `--x-color-brand`. */
  readonly accent?: ThemeTokenRef;
  /** Extra token aliases: `{ '--x-color-surface': '--x-color-brand-surface' }`. */
  readonly tokens?: Readonly<Partial<Record<ThemeTokenRef, ThemeTokenRef>>>;
  /** `system` follows `prefers-color-scheme`; the others pin `data-theme`. */
  readonly mode?: ThemeMode;
  readonly density?: 'comfortable' | 'compact';
}

export const defaultBranding: AdminBranding = {
  nameKey: 'admin.brand.name',
  mode: 'system',
  density: 'comfortable',
};

export function adminBranding(input: Partial<AdminBranding> = {}): AdminBranding {
  return { ...defaultBranding, ...input };
}

export interface ThemeAttributes {
  /** Absent under `system` so the media query decides; present otherwise, and it wins. */
  readonly 'data-theme'?: 'light' | 'dark';
  readonly 'data-density': 'comfortable' | 'compact';
  /** Inline custom-property declarations: token → token, never token → literal. */
  readonly style: string;
}

/**
 * The attributes the admin shell puts on its root element. Written as data attributes plus
 * custom properties so a theme flip re-paints without re-rendering a single component.
 */
export function themeAttributes(branding: AdminBranding): ThemeAttributes {
  const aliases: [ThemeTokenRef, ThemeTokenRef][] = [];
  if (branding.accent !== undefined) aliases.push(['--x-color-accent', branding.accent]);
  for (const [target, source] of Object.entries(branding.tokens ?? {})) {
    if (source !== undefined) aliases.push([target as ThemeTokenRef, source]);
  }

  const mode = branding.mode ?? 'system';
  return {
    ...(mode === 'system' ? {} : { 'data-theme': mode }),
    'data-density': branding.density ?? 'comfortable',
    style: aliases.map(([target, source]) => `${target}: var(${source});`).join(' '),
  };
}
