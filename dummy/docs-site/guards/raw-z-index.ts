// raw-z-index: a layer is a name on the one z ladder, so "above the dialog" means one thing.
// `x verify` discovers every file in `guards/` and runs its `guard` inside the `boundaries`
// step — nothing registers this file, so nothing can forget to. Delete it to drop the rule.
//
// The NEGATIVE of a named layer is still a named layer — `calc(-1 * #{tokens.z(raised)})` puts a
// decoration behind its own stacking context — so a `-1 *` beside a token is not a number.

import type { Finding, Guard } from '@ultimat3/cli';

/** The app owns the codes its own conventions raise — this one is named for the guard. */
const CODE = 'X_RAW_Z_INDEX';

/** `@ultimat3/ui/tokens`' z ladder. */
export const LAYERS: readonly (readonly [string, number])[] = [
  ['base', 0],
  ['raised', 10],
  ['sticky', 100],
  ['dropdown', 200],
  ['drawer', 300],
  ['dialog', 400],
  ['popover', 500],
  ['tooltip', 600],
  ['toast', 700],
  ['skip-nav', 800],
];

export interface StyleFile {
  /** App-root-relative POSIX path, so the finding names the file an author opens. */
  readonly path: string;
  readonly scss: string;
}

const blank = (text: string): string => text.replaceAll(/[^\n]/g, ' ');

/** Comments blanked rather than removed, so a reported line number still points at the source. */
const blankComments = (scss: string): string =>
  scss.replaceAll(/\/\*[\s\S]*?\*\//g, blank).replaceAll(/(?<![:\w])\/\/[^\n]*/g, blank);

const lineOf = (text: string, index: number): number => text.slice(0, index).split('\n').length;

/** The `as <name>` the token entry point is used under in this sheet; `tokens` when it is not. */
const namespaceOf = (scss: string): string =>
  /@use\s+['"][^'"]*tokens[^'"]*['"]\s+as\s+([\w-]+)/.exec(scss)?.[1] ?? 'tokens';

const Z_INDEX = /(?<![\w$-])z-index\s*:\s*((?:#\{[^}]*\}|[^;{}])+)/g;
/** A token read: `tokens.z(dialog)`, `z('dialog')`, `var(--z-dialog)` — and the negation of one. */
const TOKEN = /(?:[\w-]+\.)?z\([^)]*\)|var\(\s*--z-[\w-]+\s*\)|-1\s*\*|\*\s*-1/g;

/** The nearest layer to a number. Never `base` for a non-zero one: `-0` is not behind anything. */
const layerFor = (value: number): string => {
  let best: readonly [string, number] | undefined;
  for (const layer of LAYERS) {
    if (value !== 0 && layer[1] === 0) continue;
    if (
      best === undefined ||
      Math.abs(layer[1] - Math.abs(value)) < Math.abs(best[1] - Math.abs(value))
    ) {
      best = layer;
    }
  }
  return best?.[0] ?? 'raised';
};

/** Pure — the caller does the I/O — so the rule is testable without a filesystem. */
export function rawZIndexes(files: readonly StyleFile[]): readonly Finding[] {
  const findings: Finding[] = [];
  for (const file of files) {
    const scss = blankComments(file.scss);
    const ns = namespaceOf(file.scss);
    for (const match of scss.matchAll(Z_INDEX)) {
      const value = (match[1] ?? '').trim();
      const literal = /-?\d+/.exec(value.replaceAll(TOKEN, ' '))?.[0];
      if (literal === undefined) continue;
      const line = lineOf(scss, match.index);
      const layer = `${ns}.z(${layerFor(Number(literal))})`;
      const written = Number(literal) < 0 ? `calc(-1 * #{${layer}})` : layer;
      findings.push({
        code: CODE,
        cause: `${file.path}:${line} writes \`z-index: ${value}\` — a number only this file knows, on no ladder another layer can be placed against`,
        fix: `z-index: ${written} — at ${file.path}:${line} (layers: ${LAYERS.map(([name]) => name).join(' ')}), then: x verify`,
        at: `${file.path}:${line}`,
      });
    }
  }
  return findings;
}

export const guard: Guard = {
  summary: 'a z-index is a named layer, never a number',
  async check(_root, sources) {
    const sheets = await sources.files('{apps,packages}/**/*.scss');
    return rawZIndexes(sheets.map((file) => ({ path: file.path, scss: file.text })));
  },
};
