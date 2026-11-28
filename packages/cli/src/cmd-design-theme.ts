// `@ultimat3/ui`'s palette tables and `defineTheme`, reached at run time. The CLI does not depend on
// `@ultimat3/ui` (`error-catalog.ts` names it an optional host for the same reason), and an app that
// researches a design has it installed: resolved, the proposal's colours are contrast-checked and
// then handed to `defineTheme` itself; unresolved, the proposal carries no colours at all.

import type { DesignProposal, ThemeTables } from './design-map';

export interface ThemeHost {
  readonly tables: ThemeTables;
  /** `defineTheme`, which throws on a proposal it refuses. */
  readonly defineTheme: (input: DesignProposal) => unknown;
}

const record = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : undefined;

const stringTable = (value: unknown): Record<string, string> | undefined => {
  const table = record(value);
  if (table === undefined) return undefined;
  return Object.values(table).every((entry) => typeof entry === 'string')
    ? (table as Record<string, string>)
    : undefined;
};

const pairList = (value: unknown): ThemeTables['pairs'] =>
  (Array.isArray(value) ? value : []).flatMap((entry: unknown) => {
    const pair = record(entry);
    const fg = pair?.['fg'];
    const bg = pair?.['bg'];
    const minimum = pair?.['minimum'];
    return typeof fg === 'string' && typeof bg === 'string' && typeof minimum === 'number'
      ? [{ fg, bg, minimum }]
      : [];
  });

/** The module's exports read as `unknown` and checked: a version that renamed one is no host. */
export function themeHostOf(module: unknown): ThemeHost | undefined {
  const ui = record(module);
  const tokens = record(ui?.['colorTokens']);
  const light = stringTable(tokens?.['light']);
  const dark = stringTable(tokens?.['dark']);
  const aliases = stringTable(ui?.['COLOR_ALIASES']);
  const contrast = ui?.['contrastRatio'];
  const define = ui?.['defineTheme'];
  if (
    light === undefined ||
    dark === undefined ||
    aliases === undefined ||
    typeof contrast !== 'function' ||
    typeof define !== 'function'
  ) {
    return undefined;
  }
  return {
    tables: {
      colors: { light, dark },
      aliases,
      pairs: [...pairList(ui?.['CONTRAST_PAIRS']), ...pairList(ui?.['ALIAS_CONTRAST_PAIRS'])],
      contrast: (a, b) => Number(contrast(a, b)),
    },
    defineTheme: (input) => define(input),
  };
}

/** The specifier is a value, not a literal: `tsc` must not resolve a package the CLI never declares. */
const UI_SPECIFIER = '@ultimat3/ui';

export async function loadThemeHost(
  load: (specifier: string) => Promise<unknown> = (specifier) => import(specifier),
): Promise<ThemeHost | undefined> {
  try {
    return themeHostOf(await load(UI_SPECIFIER));
  } catch {
    // Not installed beside the CLI: the documented degraded path, reported in reference.json.
    return undefined;
  }
}

/**
 * The proposal `defineTheme` accepts, by `defineTheme`'s own verdict. Colours are the only part
 * the contrast table judges; if `defineTheme` still refuses (a palette rule this CLI predates),
 * they are dropped rather than written as a proposal that would not boot.
 */
export function acceptedProposal(
  proposal: DesignProposal,
  host: ThemeHost | undefined,
): {
  readonly proposal: DesignProposal;
  readonly validated: boolean;
} {
  if (host === undefined) return { proposal, validated: false };
  try {
    host.defineTheme(proposal);
    return { proposal, validated: true };
  } catch {
    const { colors: _dropped, ...rest } = proposal;
    host.defineTheme(rest);
    return { proposal: rest, validated: true };
  }
}
