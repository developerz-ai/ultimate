# Bun coverage reports a plugin-loaded file in its OUTPUT's lines

Measured 2026-10-01 on **Bun 1.4.0 (34cbb9a40), Linux x64**. A Bun defect, recorded so nobody
chases it in app source again. Not fixed here, and not ours to fix.

## The rule

A file loaded through `Bun.plugin`'s `onLoad` is reported by `bun test --coverage` under its
SOURCE path, with the line numbers, the line total and the function total of the plugin's
**output**.

| What `--coverage` says about such a file | What it is |
|---|---|
| `Uncovered Line #s` | lines of the compiled output — never a place to look in the source |
| `% Lines`, `% Funcs`, lcov `LF` / `FNF` | counted over the output, so code the compiler emitted and the module never calls counts as uncovered |
| lcov `DA:<line>` | may name a line past the end of the file |

Every `.tsx` an Ultimate test renders is such a file: `@ultimat3/render`'s server entry installs a
`Bun.plugin` whose `onLoad` compiles `.tsx` for Solid (`packages/render/src/module-loader.ts`,
`As of 2026-10`).

## How it was found

`dummy/social-media-clone/apps/admin/app/admin/pages/ops.tsx` read "lines 32–41 uncovered" while
its test asserted both branches of the conditional on those lines (plan 101).

## The minimal case

Four files, no dependency. The plugin stands in for a JSX compiler: it returns JavaScript that
opens with a helper the module never calls, so every later line has moved down by six.

```toml
# bunfig.toml
[test]
preload = ["./plugin.ts"]
```

```ts
// plugin.ts
const HELPER = [
  'function __neverCalled(value) {',
  '  if (value) {',
  '    return 1;',
  '  }',
  '  return 2;',
  '}',
].join('\n');

Bun.plugin({
  name: 'tsx-as-a-compiler-would',
  setup(build) {
    build.onLoad({ filter: /view\.tsx$/ }, async ({ path }) => {
      const source = await Bun.file(path).text();
      const js = new Bun.Transpiler({ loader: 'tsx' }).transformSync(source);
      return { contents: `${HELPER}\n${js}`, loader: 'js' };
    });
  },
});
```

```tsx
// view.tsx — six lines
export function label(n: number): string {
  if (n > 0) {
    return 'positive';
  }
  return 'other';
}
```

```ts
// view.test.ts
import { expect, test } from 'bun:test';
import { label } from './view.tsx';

test('both branches of label() run', () => {
  expect(label(1)).toBe('positive');
  expect(label(-1)).toBe('other');
});
```

```bash
bun test --coverage --coverage-reporter=lcov --coverage-reporter=text --coverage-dir=cov
```

| | Expected | Bun 1.4.0 |
|---|---|---|
| `view.tsx` `% Lines` | 100 | 60.00 |
| `view.tsx` `% Funcs` | 100 | 50.00 |
| `Uncovered Line #s` | none | `1-4` — the helper's lines, printed against `label`'s |
| lcov `DA:` for a 6-line file | lines 1–6 | lines 1–5 and **7–11** |

## An inline source map does not help

The same plugin returning `//# sourceMappingURL=data:application/json;base64,…` — a version-3
map sending output lines 7–12 to source lines 1–6 — produces byte-identical lcov. `onLoad` has no
field for a map, and coverage does not read one out of the contents. So a compiler plugin cannot
correct this from its side.

## What to do instead

| Situation | Move |
|---|---|
| a `.tsx` reads under the floor and its tests assert every branch | read the percentage as "of the compiled module"; ignore the line list |
| a branch that needs a line-accurate answer | put the logic in a `.ts` module beside the view and test that — a `.ts` file is not plugin-loaded, and its lines are its own |
| the number is needed for one file | `bun test --coverage <its test file>`, and compare the count of uncovered lines, not their positions |

[`wiki/Testing.md`](../../wiki/Testing.md#coverage) carries the short form.
