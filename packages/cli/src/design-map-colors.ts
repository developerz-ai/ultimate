// A reference's colours as `defineTheme` palette roles: cluster what was painted, give the page, the
// text, the accent, a surface and a line a role each, then hold the result to the theme's own
// contrast table — a role whose pairing fails is DROPPED (it falls back to the shipped palette), so
// the proposal can never be one `defineTheme` refuses.

import type { ColorUse, ObservedColor } from './design-extract';

/** `@ultimat3/ui`'s palette facts, handed in: the CLI does not depend on `@ultimat3/ui`. */
export interface ThemeTables {
  /** Shipped channels per theme, by role (`colorTokens`). */
  readonly colors: Readonly<Record<'light' | 'dark', Readonly<Record<string, string>>>>;
  /** Alias role → the palette role it reads unset (`COLOR_ALIASES`). */
  readonly aliases: Readonly<Record<string, string>>;
  /** Every pairing `defineTheme` measures (`CONTRAST_PAIRS` + `ALIAS_CONTRAST_PAIRS`). */
  readonly pairs: readonly { readonly fg: string; readonly bg: string; readonly minimum: number }[];
  /** `contrastRatio` over two `'r g b'` channel strings. */
  readonly contrast: (a: string, b: string) => number;
}

export interface PaletteCluster {
  readonly channels: string;
  readonly rgb: readonly [number, number, number];
  /** Share of each use's total weight this cluster holds, `0..1`. */
  readonly uses: Readonly<Record<ColorUse, number>>;
  /** Painted area first, then text, then edges: how much of the page this colour is. */
  readonly share: number;
  readonly nearest?: { readonly role: string; readonly distance: number } | undefined;
}

/** Two colours closer than this (RGB distance) are one colour a designer picked. */
const CLUSTER_DISTANCE = 24;
/** Max minus min channel: below it a colour is a grey, never an accent. */
const ACCENT_CHROMA = 64;
const USES: readonly ColorUse[] = ['background', 'text', 'border'];

const distance = (a: readonly number[], b: readonly number[]): number =>
  Math.hypot((a[0] ?? 0) - (b[0] ?? 0), (a[1] ?? 0) - (b[1] ?? 0), (a[2] ?? 0) - (b[2] ?? 0));

const channelsOf = (rgb: readonly number[]): string => rgb.join(' ');
const rgbOf = (channels: string): number[] => channels.split(' ').map(Number);

/** Opaque-enough colours only: a 10% scrim is an overlay, not a palette entry. */
export function clusterPalette(colors: readonly ObservedColor[]): PaletteCluster[] {
  const totals = Object.fromEntries(USES.map((use) => [use, 0])) as Record<ColorUse, number>;
  for (const color of colors) totals[color.use] += color.weight;
  const clusters: { rgb: readonly [number, number, number]; weights: Record<ColorUse, number> }[] =
    [];
  for (const color of [...colors]
    .filter((c) => c.alpha >= 0.5)
    .sort((a, b) => b.weight - a.weight)) {
    const near = clusters.find((cluster) => distance(cluster.rgb, color.rgb) < CLUSTER_DISTANCE);
    if (near !== undefined) near.weights[color.use] += color.weight;
    else {
      const weights = { background: 0, text: 0, border: 0 };
      weights[color.use] = color.weight;
      clusters.push({ rgb: color.rgb, weights });
    }
  }
  return clusters
    .map((cluster) => {
      const uses = {
        background: totals.background > 0 ? cluster.weights.background / totals.background : 0,
        text: totals.text > 0 ? cluster.weights.text / totals.text : 0,
        border: totals.border > 0 ? cluster.weights.border / totals.border : 0,
      };
      return {
        channels: channelsOf(cluster.rgb),
        rgb: cluster.rgb,
        uses,
        share: uses.background * 0.6 + uses.text * 0.3 + uses.border * 0.1,
      };
    })
    .sort((a, b) => b.share - a.share);
}

/** Each cluster beside the shipped role it is closest to in `theme`, for a reader to compare. */
export function withNearestRoles(
  palette: readonly PaletteCluster[],
  theme: 'light' | 'dark',
  tables: ThemeTables,
): PaletteCluster[] {
  const roles = Object.entries(tables.colors[theme]).filter(([role]) => !(role in tables.aliases));
  return palette.slice(0, 16).map((cluster) => {
    let best = { role: '', distance: Number.POSITIVE_INFINITY };
    for (const [role, channels] of roles) {
      const gap = distance(cluster.rgb, rgbOf(channels));
      if (gap < best.distance) best = { role, distance: Math.round(gap) };
    }
    return { ...cluster, nearest: best };
  });
}

const chroma = (rgb: readonly number[]): number => Math.max(...rgb) - Math.min(...rgb);

/** Light theme: the page is closer to white than to black; dark: the reverse. */
const fits = (bg: string, theme: 'light' | 'dark', tables: ThemeTables): boolean => {
  const towardBlack = tables.contrast(bg, '0 0 0');
  const towardWhite = tables.contrast(bg, '255 255 255');
  return theme === 'light' ? towardBlack > towardWhite : towardWhite > towardBlack;
};

/** The roles one scheme's capture proposes, before the contrast table has had its say. */
function assignRoles(
  palette: readonly PaletteCluster[],
  theme: 'light' | 'dark',
  tables: ThemeTables,
): Record<string, string> {
  const byUse = (use: ColorUse) => [...palette].sort((a, b) => b.uses[use] - a.uses[use]);
  const bg = byUse('background')[0];
  if (bg === undefined || bg.uses.background === 0 || !fits(bg.channels, theme, tables)) return {};
  const roles: Record<string, string> = { bg: bg.channels };
  const fg = byUse('text').find(
    (c) => c.uses.text > 0 && tables.contrast(c.channels, bg.channels) >= 4.5,
  );
  if (fg !== undefined) roles['fg'] = fg.channels;
  const surface = byUse('background').find(
    (c) => c !== bg && c.uses.background > 0 && tables.contrast(c.channels, bg.channels) < 1.6,
  );
  // Every surface a component paints on is the page or the one near tone beside it: left on the
  // shipped palette, a surface would be measured against an accent the reference never put on it.
  roles['surface'] = surface?.channels ?? bg.channels;
  roles['bg-soft'] = surface?.channels ?? bg.channels;
  roles['surface-raised'] = surface?.channels ?? bg.channels;
  // A FILLED colour first (a button, a badge): text in a hue is as often the browser's default link
  // blue as it is a brand, and a fill is always somebody's choice.
  const accent = palette
    .filter((c) => c !== bg && c !== fg && chroma(c.rgb) >= ACCENT_CHROMA)
    .sort(
      (a, b) =>
        b.uses.background + b.uses.border - (a.uses.background + a.uses.border) ||
        b.share - a.share,
    )[0];
  if (accent !== undefined) {
    roles['accent'] = accent.channels;
    // The text ON the accent: whichever of the page, white or near-black reads best on it.
    const [onAccent] = [bg.channels, '255 255 255', '17 15 13'].sort(
      (a, b) => tables.contrast(b, accent.channels) - tables.contrast(a, accent.channels),
    );
    if (onAccent !== undefined) roles['accent-fg'] = onAccent;
  }
  const line = byUse('border').find((c) => c !== bg && c.uses.border > 0);
  if (line !== undefined) roles['line'] = line.channels;
  return roles;
}

/**
 * `defineTheme`'s own measurement, run until it passes: a failing pairing drops the proposed role
 * on its foreground side (else its background), and the shipped palette — which passes every
 * pairing — is what the role falls back to. Terminates: each round removes a role or stops.
 */
export function repairContrast(
  roles: Record<string, string>,
  theme: 'light' | 'dark',
  tables: ThemeTables,
): Record<string, string> {
  const out = { ...roles };
  const source = (role: string): string => tables.aliases[role] ?? role;
  const own = (role: string): string | undefined => out[role] ?? out[source(role)];
  const resolved = (role: string): string =>
    own(role) ?? tables.colors[theme][source(role)] ?? '0 0 0';
  for (;;) {
    const failing = tables.pairs.find(
      (pair) =>
        (own(pair.fg) !== undefined || own(pair.bg) !== undefined) &&
        tables.contrast(resolved(pair.fg), resolved(pair.bg)) < pair.minimum,
    );
    if (failing === undefined) return out;
    const drop = own(failing.fg) !== undefined ? failing.fg : failing.bg;
    delete out[drop in out ? drop : source(drop)];
  }
}

/** One scheme's capture as the colour overrides for that theme, contrast-checked; `{}` for none. */
export function proposeColors(
  palette: readonly PaletteCluster[],
  theme: 'light' | 'dark',
  tables: ThemeTables,
): Record<string, string> {
  return repairContrast(assignRoles(palette, theme, tables), theme, tables);
}
