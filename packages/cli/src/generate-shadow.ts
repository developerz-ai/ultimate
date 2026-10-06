// A generator name whose type spelling the emitted code ALSO uses as a global or a local alias:
// `x g resource promise` imports `type { Promise }` beside `Promise<Row>`, and `row` writes
// `type Row = Row`. Decided on the planned files themselves, so a template that starts using
// another global is covered the day it does — and the names that clash nowhere stay allowed.
// The same for a VALUE: `x g job job` imports `{ job }` from `@ultimat3/jobs` and declares
// `export const job = job(…)` beside it, which is TS2440 in the module the run just wrote.

import { BadFlagError } from './errors';
import type { Generator } from './generate-kinds';
import type { GeneratedFile } from './templates';
import { camel, kebab, names } from './templates/naming';

/** The emitted file that imports `type` from the slice AND uses the same name as its own. */
function shadowingFile(files: readonly GeneratedFile[], type: string): string | undefined {
  // A pascal spelling is `[A-Za-z0-9]` only (`naming.ts`), so it splices into a pattern as is.
  const imported = new RegExp(
    `import\\s+(?:type\\s+)?\\{[^}]*\\b${type}\\b[^}]*\\}\\s+from\\s+'\\.`,
  );
  const reused = new RegExp(
    `\\b${type}<|^\\s*(?:export\\s+)?(?:type\\s+${type}\\s*=|interface\\s+${type}\\b)`,
    'm',
  );
  return files.find(
    (file) =>
      typeof file.contents === 'string' &&
      /\.tsx?$/.test(file.path) &&
      imported.test(file.contents) &&
      reused.test(file.contents),
  )?.path;
}

/** Refuses `name` when its type spelling would shadow a name the planned files rely on. */
export function refuseShadowedTypes(
  files: readonly GeneratedFile[],
  kind: Generator,
  name: string,
): void {
  const type = names(name).pascal;
  const file = shadowingFile(files, type);
  if (file === undefined) return;
  const noun = kind.split(':').at(-1) ?? kind;
  throw new BadFlagError({
    flag: 'name',
    command: `g ${kind}`,
    reason: `"${name}" becomes the type ${type}, and ${file} imports it beside its own use of ${type} — the global or local type the template means is shadowed and the file does not compile`,
    fix: ['x g', kind, `${kebab(name)}-${noun}`].join(' '),
  });
}

/** A `{ … }` value import's local names — `type` specifiers and `import type` lines excluded. */
const VALUE_IMPORT = /^import\s+\{([^}]*)\}\s+from\s+'[^']+';/gm;

const importedValues = (source: string): readonly string[] =>
  [...source.matchAll(VALUE_IMPORT)].flatMap((match) =>
    (match[1] ?? '')
      .split(',')
      .map((specifier) => specifier.trim())
      .filter((specifier) => specifier !== '' && !specifier.startsWith('type '))
      .map((specifier) => specifier.split(/\s+as\s+/).at(-1) ?? specifier),
  );

/** The emitted file that imports `value` AND declares a binding of the same name. */
function redeclaringFile(files: readonly GeneratedFile[], value: string): string | undefined {
  // A camel spelling is `[A-Za-z0-9]` only (`naming.ts`), so it splices into a pattern as is.
  const declared = new RegExp(
    `^\\s*(?:export\\s+)?(?:const|let|var|function|class)\\s+${value}\\b`,
    'm',
  );
  return files.find(
    (file) =>
      typeof file.contents === 'string' &&
      /\.tsx?$/.test(file.path) &&
      declared.test(file.contents) &&
      importedValues(file.contents).includes(value),
  )?.path;
}

/** Refuses `name` when its camel spelling is a value a planned file both imports and declares. */
export function refuseShadowedValues(
  files: readonly GeneratedFile[],
  kind: Generator,
  name: string,
): void {
  const value = camel(name);
  if (value === '') return;
  const file = redeclaringFile(files, value);
  if (file === undefined) return;
  const noun = kind.split(':').at(-1) ?? kind;
  throw new BadFlagError({
    flag: 'name',
    command: `g ${kind}`,
    reason: `"${name}" becomes the binding ${value}, and ${file} imports ${value} and declares its own — a module that declares a name it imports does not compile (TS2440)`,
    fix: ['x g', kind, `${kebab(name)}-${noun}`].join(' '),
  });
}
