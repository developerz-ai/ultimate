// island-mount-clears: an island never empties its server markup with no way back.
// `x verify` discovers every file in `guards/` and runs its `guard` inside the `boundaries`
// step — nothing registers this file, so nothing can forget to. Delete it to drop the rule.
//
// Why: a `mount` that empties its wrapper and then renders leaves a BLANK box when the render
// throws. `mountOver` from `@ultimat3/render/client` clears the same way, puts the server's markup
// back on a throw, and rethrows — the runtime still marks the root `data-x-failed` for the reporter.
// Read: `.textContent = ''`, `.innerHTML = ''` and `.replaceChildren()` on `mount`'s own wrapper (its
// first parameter) in a `*.island.tsx` that calls no `mountOver(`. Not read: a clear of an element
// inside the wrapper, a comment, a string, a test, a file that is not an island.

import type { Finding, Guard } from '@ultimat3/cli';

/** The app owns the codes its own conventions raise — this one is named for the guard. */
const CODE = 'X_ISLAND_MOUNT_CLEARS';

export interface SourceFile {
  /** App-root-relative POSIX path, so the finding names the file an author opens. */
  readonly path: string;
  readonly source: string;
}

/** Found on the BLANKED text, so a comment or a string never matches; the value is read below. */
const WRITE = /([\w$]+)\.(?:textContent|innerHTML)\s*=(?!=)/g;
/** On the original text at a write's offset: an EMPTY literal is the clear; any other is content. */
const EMPTIES = /^[\w$]+\.(?:textContent|innerHTML)\s*=\s*(?:''|""|``)/;
const REPLACE_ALL = /([\w$]+)\.replaceChildren\s*\(\s*\)/g;
/** `function mount(el` or `mount = (el`: the wrapper's name. None found reads `el`, the convention. */
const MOUNT_PARAM = /\bmount\s*(?:=\s*(?:async\s*)?)?\(\s*([\w$]+)/;
const MOUNT_OVER = /(?<![\w$.])mountOver\s*\(/;

/** Comments and string bodies blanked IN PLACE, so a line number still points at the source. */
const blank = (text: string): string =>
  text
    .replaceAll(/\/\*[\s\S]*?\*\//g, (match) => match.replaceAll(/[^\n]/g, ' '))
    .replaceAll(/(?<![:\w])\/\/[^\n]*/g, (match) => ' '.repeat(match.length))
    .replaceAll(/'(?:[^'\\\n]|\\.)*'|"(?:[^"\\\n]|\\.)*"|`(?:[^`\\]|\\.)*`/g, (match) =>
      match.replaceAll(/[^\n]/g, ' '),
    );

/** Every offset in `source` that empties the WRAPPER: an empty-literal write or a bare replace. */
const clears = (source: string, text: string): readonly number[] => {
  const wrapper = MOUNT_PARAM.exec(text)?.[1] ?? 'el';
  return [
    ...[...text.matchAll(WRITE)]
      .filter((match) => match[1] === wrapper && EMPTIES.test(source.slice(match.index)))
      .map((match) => match.index),
    ...[...text.matchAll(REPLACE_ALL)]
      .filter((match) => match[1] === wrapper)
      .map((match) => match.index),
  ];
};

/** Pure — the caller does the I/O — so the rule is testable without a filesystem. */
export function islandMountClears(files: readonly SourceFile[]): readonly Finding[] {
  const findings: Finding[] = [];
  for (const file of files) {
    const text = blank(file.source);
    if (MOUNT_OVER.test(text)) continue;
    for (const index of [...clears(file.source, text)].sort((a, b) => a - b)) {
      const at = `${file.path}:${text.slice(0, index).split('\n').length}`;
      findings.push({
        code: CODE,
        cause: `${at} empties the island's server markup outside mountOver, so a render that throws leaves a blank box where the server's HTML was, and the visitor sees nothing to retry`,
        fix: `edit ${at} — delete the clear and end mount() with return mountOver(el, (root) => render(() => <Island {...props} />, root)), adding mountOver to the island's imports from '@ultimat3/render/client' — then: x verify`,
        at,
      });
    }
  }
  return findings;
}

/** The files the rule reads: islands, never a test. */
export const readsFile = (path: string): boolean =>
  path.endsWith('.island.tsx') && !/\.test\.tsx?$/.test(path);

export const guard: Guard = {
  summary: 'an island mounts over its server markup, never clears it with no way back',
  async check(_root, sources) {
    // The run's ONE read of the source: every guard asking for this glob shares the walk.
    const code = await sources.files('{apps,packages}/**/*.{ts,tsx}');
    return islandMountClears(
      code
        .filter((file) => readsFile(file.path))
        .map((file) => ({ path: file.path, source: file.text })),
    );
  },
};
