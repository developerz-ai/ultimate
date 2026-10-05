// The build error behind "intrinsic tags only". `const Tag = props.as ?? 'div'; <Tag>` reads as a
// tag to the server's JSX factory and as a COMPONENT to the island build's Solid transform, which
// emits `createComponent(Tag)` and calls the string: `TypeError: e is not a function` on mount
// (#488). Any capitalised local holding a value — `props.as`, `headingTag(…)` — is the same bug.
// The fix is a `switch` over the closed union, one intrinsic per case (`Card.tsx`, `heading-node.tsx`).

import { describe, expect, test } from 'bun:test';

const SRC = new URL('..', import.meta.url).pathname;

/** `const|let|var Name = <rhs>` — a capitalised local, the spelling JSX reads as a component. */
const BINDING = /\b(?:const|let|var)\s+([A-Z]\w*)\s*(?::[^=;]+)?=\s*([^;]+)/g;

/** `let Name;` / `let Name: T;` — declared now, assigned a value later. */
const DECLARED = /\b(?:let|var)\s+([A-Z]\w*)\s*(?::[^=;]+)?;/g;

/** A right-hand side that IS a component: an arrow or a function expression. */
const FUNCTION_RHS = /^(?:async\s+)?(?:function\b|(?:\([^)]*\)|\w+)\s*(?::[^=]*)?=>)/;

/**
 * The `{…}` binding patterns: on the left of a declaration's `=`, or a function's or an arrow's
 * parameter list. A call's object literal (`configure({ glyph: Icon })`) is neither.
 */
const PATTERNS = [
  /\b(?:const|let|var)\s*\{([^}]*)\}\s*(?::[^=;]+)?=/g,
  /\bfunction\b\s*\w*\s*(?:<[^>]*>)?\(\s*\{([^}]*)\}/g,
  /\(\s*\{([^}]*)\}\s*(?::[^)]*)?\)\s*(?::[^=]*)?=>/g,
];

/** The capitalised names a pattern body binds: `as: Tag`, `as: Tag = 'div'`, `Tag`, `...Rest`. */
function patternNames(body: string): readonly string[] {
  return body
    .split(',')
    .map((entry) => {
      const target = (entry.includes(':') ? entry.slice(entry.indexOf(':') + 1) : entry)
        .split('=')[0]
        ?.replace('...', '')
        .trim();
      return target ?? '';
    })
    .filter((name) => /^[A-Z]\w*$/.test(name));
}

/** Every `<Name>` this file renders whose `Name` is a local holding a value, not a function. */
function runtimeTags(source: string): readonly string[] {
  // Comments out first: the fix's own comment quotes the pattern it replaced.
  const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
  const bound = new Set<string>();
  for (const [, name, rhs] of code.matchAll(BINDING)) {
    if (name !== undefined && rhs !== undefined && !FUNCTION_RHS.test(rhs.trim())) bound.add(name);
  }
  for (const [, name] of code.matchAll(DECLARED)) if (name !== undefined) bound.add(name);
  for (const pattern of PATTERNS) {
    for (const [, body] of code.matchAll(pattern)) {
      for (const name of patternNames(body ?? '')) bound.add(name);
    }
  }
  return [...bound].filter((name) => new RegExp(`<${name}[\\s>/]`).test(code));
}

const files = [...new Bun.Glob('**/*.tsx').scanSync({ cwd: SRC })].sort();
const findings = new Map<string, readonly string[]>();
for (const file of files) {
  const tags = runtimeTags(await Bun.file(`${SRC}${file}`).text());
  if (tags.length > 0) findings.set(file, tags);
}

describe('no ui component renders a runtime-chosen tag', () => {
  test('the scan reaches the components', () => {
    expect(files).toContain('components/Card.tsx');
    expect(files.length).toBeGreaterThan(60);
  });

  test('the detector knows the bug in each spelling, and a local component is not one', () => {
    expect(runtimeTags("const Tag = props.as ?? 'div';\nreturn <Tag class={c}>x</Tag>;")).toEqual([
      'Tag',
    ]);
    expect(runtimeTags('const Heading = headingTag(2);\n<Heading id={i} />')).toEqual(['Heading']);
    expect(runtimeTags("const T = l === undefined ? 'span' : h(l);\n<T>x</T>")).toEqual(['T']);
    expect(runtimeTags('const Row = (props: P) => <tr />;\n<Row />')).toEqual([]);
    expect(runtimeTags('const Ctx = uiContext();\n<Ctx.Provider value={v} />')).toEqual([]);
    expect(runtimeTags("const Tag = props.as ?? 'div';\nswitch (Tag) {}")).toEqual([]);
    expect(runtimeTags('// never `const Tag = props.as; <Tag>`\nswitch (props.as) {}')).toEqual([]);
  });

  // Every binding form compiles the same way: a capitalised name in a tag position is a component.
  test.each([
    ['let', "let Tag = props.as ?? 'div';\n<Tag />"],
    ['var', "var Tag = props.as ?? 'div';\n<Tag />"],
    ['let, assigned later', 'let Tag: string;\nTag = props.as;\n<Tag />'],
    ['a destructured alias', 'const { as: Tag } = props;\n<Tag />'],
    ['a destructured alias with a default', "const { as: Tag = 'div' } = props;\n<Tag />"],
    ['a destructured shorthand', 'const { Tag } = props;\n<Tag />'],
    ['a function parameter', 'function Box({ as: Tag }: P) {\n  return <Tag />;\n}'],
    ['an arrow parameter', 'const Box = ({ id, as: Tag }: P) => <Tag id={id} />;'],
  ])('the detector refuses %s', (_spelling, probe) => {
    expect(runtimeTags(probe)).toEqual(['Tag']);
  });

  test('a call taking an object literal binds nothing', () => {
    expect(
      runtimeTags('import { Icon } from "./Icon";\nconfigure({ glyph: Icon });\n<Icon />'),
    ).toEqual([]);
  });

  test('every file renders intrinsic tags only', () => {
    const faults = [...findings].map(
      ([file, tags]) => `${file}: <${tags.join('>, <')}> is chosen at runtime`,
    );
    expect(faults).toEqual([]);
  });
});
