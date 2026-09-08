// The `semantic-interactive` guard `x new` ships: an element that answers a click IS a control.
// The cheapest a11y win there is, and the one an agent undoes by reflex — WebAIM's annual survey of
// a million home pages finds pages using ARIA average ~41% MORE detected errors than pages using
// none, because `role="button"` is a PROMISE (Space, Enter, focus, disabled) and only the native
// element keeps it. Nothing in the gate could see a `<div onClick>` before this file existed.

import { guardCode } from './guard';
import type { GeneratedFile } from './naming';

/**
 * Derived from the guard's name, never written as a literal — the same rule `x g guard` follows.
 * An `X_*` literal in framework source is a FRAMEWORK code: `error-catalog.test.ts` refuses one the
 * registry does not hold, and `wiki/Error-Codes.md` would owe it a row. The APP owns the codes its
 * own conventions raise, so this one is spelled by the file it lands in and nowhere else.
 */
const NAME = 'semantic-interactive';
const CODE = guardCode(NAME);

const source =
  (): string => `// semantic-interactive: a click is answered by a control, and a role is a promise.
// \`x verify\` discovers every file in \`guards/\` and runs its \`guard\` inside the \`boundaries\`
// step — nothing registers this file, so nothing can forget to. Delete it to drop the rule.

import type { Finding, Guard } from '@ultimat3/cli';

/** The app owns the codes its own conventions raise — this one is named for the guard. */
const CODE = '${CODE}';

/**
 * Elements with no behaviour of their own: no tab stop, no Enter, no Space, no disabled state.
 * A handler on one of these reaches a mouse and nothing else.
 */
const INERT = new Set([
  'div',
  'span',
  'li',
  'p',
  'section',
  'article',
  'aside',
  'header',
  'footer',
  'main',
  'nav',
  'ul',
  'ol',
  'td',
  'tr',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
]);

/** A role whose native element already exists, and the element to write instead of the role. */
const NATIVE = new Map([
  ['button', { tag: 'button', write: '<button type="button">' }],
  ['link', { tag: 'a', write: '<a href="…">' }],
  ['checkbox', { tag: 'input', write: '<input type="checkbox">' }],
]);

/** \`(?<![\\w-])\` on every one: \`data-role\` is not \`role\`, and \`maxWidth\` is not \`width\`. */
const HANDLER = /(?<![\\w-])(on(?:Click|MouseDown|KeyDown))\\s*=/;
const ROLE = /(?<![\\w-])role\\s*=\\s*["']([a-z]+)["']/;
const TABINDEX = /(?<![\\w-])tab[Ii]ndex\\s*=/;
const KEYS = /(?<![\\w-])onKey(?:Down|Up|Press)\\s*=/;

export interface SourceFile {
  /** App-root-relative POSIX path, so the finding names the file an author opens. */
  readonly path: string;
  readonly source: string;
}

interface Tag {
  readonly name: string;
  readonly attrs: string;
  readonly index: number;
}

/** Comments blanked IN PLACE — not deleted — so a reported line number still points at the source. */
const blank = (text: string): string =>
  text
    .replaceAll(/\\/\\*[\\s\\S]*?\\*\\//g, (match) => match.replaceAll(/[^\\n]/g, ' '))
    .replaceAll(/(?<![:\\w])\\/\\/[^\\n]*/g, (match) => ' '.repeat(match.length));

const lineOf = (text: string, index: number): number => text.slice(0, index).split('\\n').length;

const NAME_AT = /^([A-Za-z][\\w.-]*)/;

/**
 * Every opening tag, with its attribute text. The tag ends at the first \`>\` OUTSIDE braces and
 * quotes, which is the whole reason this is a scanner and not a regex: \`onClick={() => save()}\`
 * holds a \`>\` that closes nothing, so a pattern reading to the next \`>\` cuts the element in half
 * and misses every handler written as an arrow — the way all of them are written.
 */
function openingTags(text: string): readonly Tag[] {
  const tags: Tag[] = [];
  for (let i = 0; i < text.length; i += 1) {
    if (text[i] !== '<') continue;
    const name = NAME_AT.exec(text.slice(i + 1, i + 64))?.[1];
    if (name === undefined) continue;
    const from = i + 1 + name.length;
    let depth = 0;
    let quote = '';
    let end = from;
    for (; end < text.length; end += 1) {
      const ch = text[end];
      if (quote !== '') {
        if (ch === quote) quote = '';
        continue;
      }
      if (ch === '"' || ch === "'" || ch === '\`') quote = ch;
      else if (ch === '{') depth += 1;
      else if (ch === '}') depth -= 1;
      else if (depth === 0 && (ch === '>' || ch === '<')) break;
    }
    tags.push({ name, attrs: text.slice(from, end), index: i });
    // Continue from just after the NAME, never after the tag: a nested element inside a brace
    // expression — \`{items.map((i) => <li onClick={…}>…)}\` — is a tag this rule has to see.
    i = from - 1;
  }
  return tags;
}

/** Pure — the caller does the I/O — so the rule is testable without a filesystem. */
export function semanticInteractive(files: readonly SourceFile[]): readonly Finding[] {
  const findings: Finding[] = [];
  for (const file of files) {
    const text = blank(file.source);
    for (const tag of openingTags(text)) {
      // A role, a tab stop and a key handler together are the COMPLETE set the ARIA practices
      // guide asks for — a deliberate widget, written by someone who read the obligation. This
      // rule is about the incomplete ones, so all three present is the one shape it passes over.
      if (ROLE.test(tag.attrs) && TABINDEX.test(tag.attrs) && KEYS.test(tag.attrs)) continue;
      const at = \`\${file.path}:\${lineOf(text, tag.index)}\`;
      const role = ROLE.exec(tag.attrs)?.[1] ?? '';
      const native = NATIVE.get(role);
      // One finding per tag, role first: \`<div role="button" onClick>\` is one mistake with two
      // symptoms, and two findings would make the reader fix it twice.
      if (native !== undefined && tag.name !== native.tag) {
        findings.push({
          code: CODE,
          cause: \`\${at} puts role="\${role}" on <\${tag.name}> — a role is a promise, and this one obliges the element to answer Space, Enter, focus and disabled, which the native element already does\`,
          fix: \`replace <\${tag.name} role="\${role}"> in \${file.path} with \${native.write}, then: x verify\`,
          at: file.path,
        });
        continue;
      }
      const handler = INERT.has(tag.name) ? HANDLER.exec(tag.attrs)?.[1] : undefined;
      if (handler === undefined) continue;
      findings.push({
        code: CODE,
        cause: \`\${at} hangs \${handler} on <\${tag.name}>, which takes no focus and answers no key — a keyboard, a screen reader and a switch reach a mouse handler on an inert element in exactly one way, which is not at all\`,
        fix: \`write <button type="button"> — or the native control this element means — in place of <\${tag.name}> at \${at}, then: x verify\`,
        at: file.path,
      });
    }
  }
  return findings;
}

export const guard: Guard = {
  summary: 'a click is answered by a control, never by a div with a handler',
  async check(root) {
    const files: SourceFile[] = [];
    // TWO globs, and the rule is that a brace ALTERNATIVE may not contain a \`/\`. Measured on Bun
    // 1.4.0 against \`examples/dummy\`: \`{apps/*/{site,app},packages/*/src}/**/*.tsx\` and
    // \`{apps/web,packages/ui}/**/*.tsx\` each match ZERO files, where \`apps/*/{site,app}/**/*.tsx\`
    // matches 17 — so folding these into one line silently turns the guard off, which is worse than
    // the hole it closes. A LEADING group is fine and four guards here rely on it:
    // \`{apps,packages}/**/*.scss\` matches all 15.
    for (const pattern of ['apps/*/{site,app}/**/*.tsx', 'packages/*/src/**/*.tsx']) {
      for await (const entry of new Bun.Glob(pattern).scan({ cwd: root, absolute: false })) {
        const path = entry.split('\\\\').join('/');
        if (path.includes('node_modules/') || /\\.test\\.tsx?$/.test(path)) continue;
        files.push({ path, source: await Bun.file(\`\${root}/\${path}\`).text() });
      }
    }
    return semanticInteractive(files);
  },
};
`;

const test =
  (): string => `// The rule, driven directly. Failure case first: a guard whose rule silently stopped matching is
// a green gate over the convention it was written to enforce.

import { expect, unitTest } from '@ultimat3/testing';
import { semanticInteractive } from './semantic-interactive';

const file = (source: string) => [{ path: 'apps/web/app/post/page.tsx', source }];

unitTest('a div with a click handler is refused, and the finding names the line', () => {
  const findings = semanticInteractive(
    file('<main>\\n  <div onClick={() => save()}>Save</div>\\n</main>'),
  );
  expect(findings).toHaveLength(1);
  expect(findings[0]?.code).toBe('${CODE}');
  expect(findings[0]?.cause).toContain(':2');
  expect(findings[0]?.fix).toContain('<button type="button">');
});

unitTest('role="button" on a div names the native element to write instead', () => {
  const findings = semanticInteractive(file('<div role="button" onClick={go}>Go</div>'));
  expect(findings).toHaveLength(1);
  expect(findings[0]?.cause).toContain('a role is a promise');
  expect(findings[0]?.fix).toContain('<button type="button">');
});

unitTest('the native control it names is not itself a finding', () => {
  expect(semanticInteractive(file('<button type="button" onClick={go}>Go</button>'))).toEqual([]);
  expect(semanticInteractive(file('<a href="/x" onClick={go}>Go</a>'))).toEqual([]);
});

// The boundary, stated: a role, a tab stop and a key handler together are the complete set the
// ARIA practices guide asks for. This rule reports the INCOMPLETE widget, never the deliberate one.
unitTest('a role with a tab stop and a key handler is a deliberate widget', () => {
  const widget = '<div role="button" tabindex="0" onClick={go} onKeyDown={go}>Go</div>';
  expect(semanticInteractive(file(widget))).toEqual([]);
});

unitTest('data-role is not role, and a live region is not a control', () => {
  expect(semanticInteractive(file('<p data-role="status" role="status">Saved</p>'))).toEqual([]);
});

// The reason the tag end is scanned rather than matched: an arrow function's \`>\` closes nothing,
// and a pattern that stopped at it would read the element as ending before its own handler.
unitTest('an arrow function in an earlier attribute does not end the tag', () => {
  const source = '<div class={cx(() => a > b)} onClick={go}>Go</div>';
  expect(semanticInteractive(file(source))).toHaveLength(1);
});

unitTest('a commented-out handler is a note, not an element', () => {
  expect(semanticInteractive(file('// <div onClick={go}>Go</div>\\nconst a = 1;'))).toEqual([]);
});
`;

/** `guards/semantic-interactive.ts` and its test. The directory is the registration. */
export const semanticInteractiveGuardFiles = (): readonly GeneratedFile[] => [
  { path: 'guards/semantic-interactive.ts', contents: source() },
  { path: 'guards/semantic-interactive.test.ts', contents: test() },
];
