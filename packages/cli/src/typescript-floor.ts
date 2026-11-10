// The TypeScript an EXISTING app declares, held to the one `x new` scaffolds (`TYPESCRIPT_VERSION`).
// `@ultimat3/*` ships source and `.d.ts` checked by that compiler: an app a major behind is red on
// the framework's own files (TS2769 in `cdp-shot-keys.ts` under 6.0.3), whatever its own code says.
// Pure over manifest text; `x upgrade` and `x doctor` each report what it returns.

import { quoteArg } from './shell-quote';
import { TYPESCRIPT_VERSION } from './templates/scaffold-repo';

export interface TypescriptLag {
  /** The manifest declaring it, relative to the app root, POSIX. */
  readonly file: string;
  readonly field: 'dependencies' | 'devDependencies';
  readonly from: string;
  readonly to: string;
  /** The one command that moves it, run from the app root. */
  readonly fix: string;
}

/** The floor a plain range admits: `^6.0.3`, `~6.0`, `>=5.4`, `6.0.3` → its numbers; else none. */
const PLAIN = /^\s*(?:\^|~|>=|=)?\s*v?(\d+)(?:\.(\d+))?(?:\.(\d+))?(?:-[\w.]+)?\s*$/;

export function lowerBound(range: string): readonly number[] | undefined {
  const match = PLAIN.exec(range);
  if (match === null) return undefined;
  return [match[1], match[2], match[3]].map((part) => Number(part ?? '0'));
}

/** Strictly below, part by part. A prerelease of the floor itself reads as the floor. */
export function isBelow(held: readonly number[], floor: readonly number[]): boolean {
  for (let at = 0; at < floor.length; at += 1) {
    const left = held[at] ?? 0;
    const right = floor[at] ?? 0;
    if (left !== right) return left < right;
  }
  return false;
}

const FIELDS = ['devDependencies', 'dependencies'] as const;

const declared = (text: string, field: string): string | undefined => {
  try {
    const parsed: unknown = JSON.parse(text);
    if (typeof parsed !== 'object' || parsed === null) return undefined;
    const block: unknown = Reflect.get(parsed, field);
    if (typeof block !== 'object' || block === null) return undefined;
    const range: unknown = Reflect.get(block, 'typescript');
    return typeof range === 'string' ? range : undefined;
  } catch {
    // An unreadable manifest is `bun install`'s finding, named with its line; here it says nothing.
    return undefined;
  }
};

/** `bun add` from the app root, `--cwd` into a workspace, `-d` where it was a devDependency. */
const fixFor = (file: string, field: TypescriptLag['field'], to: string): string => {
  const dir = file.includes('/') ? file.slice(0, file.lastIndexOf('/')) : '';
  return [
    'bun add',
    ...(field === 'devDependencies' ? ['-d'] : []),
    quoteArg(`typescript@${to}`),
    ...(dir === '' ? [] : ['--cwd', quoteArg(dir)]),
  ].join(' ');
};

/**
 * Every manifest whose `typescript` range admits a compiler below the scaffold's. A range this
 * cannot read (`latest`, `catalog:`, `workspace:*`, `5 || 6`) is not judged: no claim beats a
 * wrong one, and `x verify`'s typecheck still answers for it.
 */
export function typescriptLags(
  manifests: readonly { readonly file: string; readonly text: string }[],
  to: string = TYPESCRIPT_VERSION,
): readonly TypescriptLag[] {
  const floor = lowerBound(to) ?? [];
  return manifests.flatMap(({ file, text }) =>
    FIELDS.flatMap((field) => {
      const from = declared(text, field);
      const held = from === undefined ? undefined : lowerBound(from);
      if (from === undefined || held === undefined || !isBelow(held, floor)) return [];
      return [{ file, field, from, to, fix: fixFor(file, field, to) }];
    }),
  );
}
