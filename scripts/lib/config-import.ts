// Single responsibility: the one-config-loader rule `scripts/boundaries.ts` runs — an `import(` of
// an app's `app.config.ts` anywhere but `packages/cli/src/app-config-load.ts` is a second reader
// with its own defaults and trust policy, which is how seventeen walks came to disagree.

import { balancedClose } from './balanced-paren';
import type { Finding } from './log';

/** The one file allowed to import an app's config module. */
export const CONFIG_LOADER_FILE = 'packages/cli/src/app-config-load.ts';

/**
 * Files that import the config module themselves for a reason the tier table forces, each with the
 * sentence saying why. Shrinks; never grows without one.
 */
export const CONFIG_IMPORT_EXEMPT: Readonly<Record<string, string>> = Object.freeze<
  Record<string, string>
>({
  // why: `@ultimat3/testing` sits below `@ultimat3/cli` (`cli -> testing` is the declared sideways
  // edge, so the reverse is forbidden) and cannot import the loader; it reads one key,
  // `defaultLocale`, and answers `undefined` on any failure rather than pinning a guessed locale.
  'packages/testing/src/e2e-locale.ts':
    'tier-forced: @ultimat3/testing cannot import @ultimat3/cli, whose loader this is',
});

export interface ConfigImportSource {
  readonly path: string;
  readonly source: string;
}

export interface ConfigImportViolation {
  readonly file: string;
  readonly line: number;
  readonly specifier: string;
}

/** What names the config file: the constant, the literal file name, or a resolved root's path. */
const NAMES_CONFIG = /\bAPP_CONFIG_FILE\b|app\.config(?:\.ts)?\b|\bconfigPath\b/;

/** `const path = join(root, APP_CONFIG_FILE)` — a binding whose initialiser names the file. */
const bindingsNamingConfig = (source: string): ReadonlySet<string> => {
  const names = new Set<string>();
  for (const match of source.matchAll(
    /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*([^;\n]+)/g,
  )) {
    if (NAMES_CONFIG.test(match[2] as string)) names.add(match[1] as string);
  }
  return names;
};

const isComment = (source: string, index: number): boolean => {
  const lineStart = source.lastIndexOf('\n', index) + 1;
  const head = source.slice(lineStart, index).trimStart();
  return head.startsWith('//') || head.startsWith('*') || head.startsWith('/*');
};

/** Every dynamic `import(…)` of the config module in one file, test files excluded by the caller. */
export function configImportsIn(file: ConfigImportSource): readonly ConfigImportViolation[] {
  if (!NAMES_CONFIG.test(file.source)) return [];
  const bindings = bindingsNamingConfig(file.source);
  const found: ConfigImportViolation[] = [];
  for (const match of file.source.matchAll(/\bimport\s*\(/g)) {
    const open = (match.index ?? 0) + match[0].length - 1;
    if (isComment(file.source, open)) continue;
    const close = balancedClose(file.source, open);
    if (close < 0) continue;
    const specifier = file.source.slice(open + 1, close).trim();
    const viaBinding = /^[A-Za-z_$][\w$]*$/.test(specifier) && bindings.has(specifier);
    if (!viaBinding && !NAMES_CONFIG.test(specifier)) continue;
    const line = file.source.slice(0, open).split('\n').length;
    found.push({ file: file.path, line, specifier });
  }
  return found;
}

/** The rule over a file set: the loader and the pinned exemptions are the only importers. */
export function checkConfigImports(
  files: readonly ConfigImportSource[],
): readonly ConfigImportViolation[] {
  return files
    .filter((file) => file.path !== CONFIG_LOADER_FILE && !file.path.includes('.test.'))
    .filter((file) => !Object.hasOwn(CONFIG_IMPORT_EXEMPT, file.path))
    .flatMap(configImportsIn);
}

export const configImportFindingFor = (violation: ConfigImportViolation): Finding => ({
  code: 'X_CONFIG_IMPORT_OUTSIDE_LOADER',
  cause: `${violation.file}:${String(violation.line)} imports the app config module (import(${violation.specifier})) — ${CONFIG_LOADER_FILE} is the one reader, so a second one carries its own defaults and its own trust policy`,
  fix: "const config = await loadAppConfig(root); // import { loadAppConfig } from './app-config-load'",
  at: violation.file,
});
