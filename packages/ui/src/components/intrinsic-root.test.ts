// The build error behind "intrinsic tags only". `const Tag = props.as ?? 'div'; <Tag>` reads as a
// tag to the server's JSX factory and as a COMPONENT to the island build's Solid transform, which
// emits `createComponent(Tag)` and calls the string: `TypeError: e is not a function` on mount
// (#488). Any capitalised local holding a value — `props.as`, `headingTag(…)` — is the same bug.
// The fix is a `switch` over the closed union, one intrinsic per case (`Card.tsx`, `heading-node.tsx`).

import { describe, expect, test } from 'bun:test';

const SRC = new URL('..', import.meta.url).pathname;

/** `const Name = <rhs>` — a capitalised local, the only spelling JSX reads as a component. */
const BINDING = /\bconst\s+([A-Z]\w*)\s*(?::[^=]+)?=\s*([^;]+)/g;

/** A right-hand side that IS a component: an arrow or a function expression. */
const FUNCTION_RHS = /^(?:async\s+)?(?:function\b|(?:\([^)]*\)|\w+)\s*(?::[^=]*)?=>)/;

/** Every `<Name>` this file renders whose `Name` is a local holding a value, not a function. */
function runtimeTags(source: string): readonly string[] {
  // Comments out first: the fix's own comment quotes the pattern it replaced.
  const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
  const found: string[] = [];
  for (const [, name, rhs] of code.matchAll(BINDING)) {
    if (name === undefined || rhs === undefined || FUNCTION_RHS.test(rhs.trim())) continue;
    if (new RegExp(`<${name}[\\s>/]`).test(code)) found.push(name);
  }
  return found;
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

  test('every file renders intrinsic tags only', () => {
    const faults = [...findings].map(
      ([file, tags]) => `${file}: <${tags.join('>, <')}> is chosen at runtime`,
    );
    expect(faults).toEqual([]);
  });
});
