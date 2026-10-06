// The colour half of the typed token mirror: every role, the chart series among them, and their
// channels per theme. `_colors.scss` is CANONICAL; `tokens.test.ts` fails if the two disagree.
// Split from `tokens.ts` by size alone — `tokens.ts` re-exports all of it, so there is one import.

export type Theme = 'light' | 'dark';

export const COLOR_ROLES = [
  'bg',
  'bg-soft',
  'surface',
  'surface-raised',
  'fg',
  'fg-strong',
  'fg-muted',
  'line',
  'scrim',
  'accent',
  'accent-strong',
  'accent-fg',
  'success',
  'success-soft',
  'success-fg',
  'warning',
  'warning-soft',
  'warning-fg',
  'danger',
  'danger-soft',
  'danger-fg',
  'info',
  'info-soft',
  'info-fg',
  'chart-1',
  'chart-2',
  'chart-3',
  'chart-4',
  'chart-5',
  'chart-6',
  'chart-7',
  'chart-8',
] as const;

export type ColorRole = (typeof COLOR_ROLES)[number];

/**
 * The categorical series, in the order a chart assigns them. Okabe–Ito-derived and measured, not
 * picked: 3:1 against every surface (`CONTRAST_PAIRS`) and apart under protan, deutan and tritan
 * simulation (`colour-vision.test.ts`). A ninth series reuses `chart-1` with a second encoding —
 * a dash, a pattern, a label — never a ninth hue.
 */
export const CHART_ROLES = [
  'chart-1',
  'chart-2',
  'chart-3',
  'chart-4',
  'chart-5',
  'chart-6',
  'chart-7',
  'chart-8',
] as const satisfies readonly ColorRole[];

export type ChartRole = (typeof CHART_ROLES)[number];

/** Space-separated RGB channels, mirroring `_colors.scss`. */
export const colorTokens: Readonly<Record<Theme, Readonly<Record<ColorRole, string>>>> = {
  light: {
    bg: '253 246 240',
    'bg-soft': '245 237 230',
    surface: '250 245 241',
    'surface-raised': '255 255 255',
    fg: '38 34 31',
    'fg-strong': '17 15 13',
    'fg-muted': '110 102 94',
    line: '208 198 188',
    scrim: '17 15 13',
    accent: '31 110 178',
    'accent-strong': '21 92 152',
    'accent-fg': '255 255 255',
    success: '21 123 80',
    'success-soft': '222 244 232',
    'success-fg': '255 255 255',
    warning: '155 93 7',
    'warning-soft': '253 240 213',
    'warning-fg': '255 255 255',
    danger: '190 42 42',
    'danger-soft': '253 227 227',
    'danger-fg': '255 255 255',
    info: '31 110 178',
    'info-soft': '224 239 252',
    'info-fg': '255 255 255',
    'chart-1': '0 107 170',
    'chart-2': '189 107 14',
    'chart-3': '0 125 90',
    'chart-4': '189 44 16',
    'chart-5': '170 70 140',
    'chart-6': '47 135 195',
    'chart-7': '118 97 18',
    'chart-8': '60 60 60',
  },
  dark: {
    bg: '18 18 20',
    'bg-soft': '28 28 32',
    surface: '34 34 39',
    'surface-raised': '44 44 50',
    fg: '228 226 222',
    'fg-strong': '248 247 245',
    'fg-muted': '155 151 145',
    line: '72 72 80',
    scrim: '0 0 0',
    accent: '96 170 240',
    'accent-strong': '130 190 248',
    'accent-fg': '16 20 26',
    success: '74 190 130',
    'success-soft': '22 46 34',
    'success-fg': '12 26 18',
    warning: '226 170 66',
    'warning-soft': '52 42 20',
    'warning-fg': '28 20 6',
    danger: '240 110 110',
    'danger-soft': '56 26 26',
    'danger-fg': '30 12 12',
    info: '96 170 240',
    'info-soft': '22 38 56',
    'info-fg': '12 20 30',
    'chart-1': '105 201 255',
    'chart-2': '230 153 0',
    'chart-3': '0 167 113',
    'chart-4': '236 111 60',
    'chart-5': '203 126 189',
    'chart-6': '124 153 252',
    'chart-7': '246 234 72',
    'chart-8': '181 181 180',
  },
} as const;
