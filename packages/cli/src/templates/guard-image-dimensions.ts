// The `image-dimensions` guard `x new` ships: an image reserves its box before its bytes arrive.
// An unsized `<img>` is the largest single contributor to Cumulative Layout Shift — the page reflows
// under the reader's finger the moment the bytes land — and the second half is its mirror image: a
// `loading="lazy"` on the image the page is judged by is a deliberate delay on the one paint the
// metric measures. Both are decidable from the attributes and nothing in the gate could see either.

import { guardCode } from './guard';
import type { GeneratedFile } from './naming';

/**
 * Derived from the guard's name, never written as a literal — the same rule `x g guard` follows.
 * An `X_*` literal in framework source is a FRAMEWORK code: `error-catalog.test.ts` refuses one the
 * registry does not hold, and `wiki/Error-Codes.md` would owe it a row. The APP owns the codes its
 * own conventions raise, so this one is spelled by the file it lands in and nowhere else.
 */
const NAME = 'image-dimensions';
const CODE = guardCode(NAME);

const source =
  (): string => `// image-dimensions: an image reserves its box before its bytes arrive.
// \`x verify\` discovers every file in \`guards/\` and runs its \`guard\` inside the \`boundaries\`
// step — nothing registers this file, so nothing can forget to. Delete it to drop the rule.

import type { Finding, Guard } from '@ultimat3/cli';

/** The app owns the codes its own conventions raise — this one is named for the guard. */
const CODE = '${CODE}';

/** The raw element and the framework's wrapper. A background-image reserves nothing and is not one. */
const IMAGES = new Set(['img', 'Image']);

/** \`(?<![\\w-])\` on every one: \`maxWidth\` is not \`width\`, and \`data-loading\` is not \`loading\`. */
const WIDTH = /(?<![\\w-])width\\s*=/;
const HEIGHT = /(?<![\\w-])height\\s*=/;
const ASPECT = /aspect-ratio/i;
const LAZY = /(?<![\\w-])loading\\s*=\\s*['"{]?\\s*['"]?lazy/i;
/** A bare JSX boolean (\`priority\`), \`priority={true}\`, or the HTML attribute spelled either way. */
const PRIORITY = /(?<![\\w-])(priority|fetch[Pp]riority\\s*=\\s*['"{]?\\s*['"]?high)/;

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
 * quotes: \`srcset={widths.map((w) => …)}\` holds a \`>\` that closes nothing, so a pattern reading to
 * the next \`>\` would cut the element in half and read half an attribute list as the whole one.
 *
 * The scanner is spelled out again here rather than shared, and that is the mechanism's doing:
 * every file in \`guards/\` is a guard, so a helper module beside this one would be discovered and
 * refused as a guard with no rule (\`X_GUARD_INVALID\`). One file per rule, deletable on its own.
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
    i = from - 1;
  }
  return tags;
}

/**
 * \`<template>…</template>\` holds markup the browser never lays out, so nothing inside one can
 * shift anything. Reported, it would be a finding an author cannot act on.
 */
function templateRanges(text: string): readonly (readonly [number, number])[] {
  const ranges: (readonly [number, number])[] = [];
  for (const match of text.matchAll(/<template\\b[\\s\\S]*?<\\/template>/gi)) {
    ranges.push([match.index, match.index + match[0].length]);
  }
  return ranges;
}

/** Pure — the caller does the I/O — so the rule is testable without a filesystem. */
export function unsizedImages(files: readonly SourceFile[]): readonly Finding[] {
  const findings: Finding[] = [];
  for (const file of files) {
    const text = blank(file.source);
    const inert = templateRanges(text);
    for (const tag of openingTags(text)) {
      if (!IMAGES.has(tag.name)) continue;
      if (inert.some(([from, to]) => tag.index > from && tag.index < to)) continue;
      const at = \`\${file.path}:\${lineOf(text, tag.index)}\`;
      if (!ASPECT.test(tag.attrs) && !(WIDTH.test(tag.attrs) && HEIGHT.test(tag.attrs))) {
        findings.push({
          code: CODE,
          cause: \`\${at} renders <\${tag.name}> with no width and height pair and no aspect-ratio — the browser reserves no box for it, so every element under it jumps the moment the bytes land\`,
          fix: \`add width and height to the <\${tag.name}> at \${at} — the intrinsic pixel size, since CSS still decides what it is drawn at — or an aspect-ratio, then: x verify\`,
          at: file.path,
        });
      }
      // A second finding on the same tag, deliberately: it is a different mistake with a different
      // edit, and folding the two would hand the reader one of the repairs it needs.
      if (!LAZY.test(tag.attrs) || !PRIORITY.test(tag.attrs)) continue;
      findings.push({
        code: CODE,
        cause: \`\${at} marks <\${tag.name}> as the priority image AND loading="lazy" — a lazy image is fetched after layout, and this is the one the page's largest paint is measured on, so the attribute delays the metric it is the subject of\`,
        fix: \`delete loading="lazy" from the <\${tag.name}> at \${at}, then: x verify\`,
        at: file.path,
      });
    }
  }
  return findings;
}

export const guard: Guard = {
  summary: 'an image declares its box, and the priority one is never lazy',
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
    return unsizedImages(files);
  },
};
`;

const test =
  (): string => `// The rule, driven directly. Failure case first: a guard whose rule silently stopped matching is
// a green gate over the convention it was written to enforce.

import { expect, unitTest } from '@ultimat3/testing';
import { unsizedImages } from './image-dimensions';

const file = (source: string) => [{ path: 'apps/web/site/page.tsx', source }];

unitTest('an img with no dimensions is refused, and the finding names the line', () => {
  const findings = unsizedImages(file('<main>\\n  <img src="/hero.png" alt="" />\\n</main>'));
  expect(findings).toHaveLength(1);
  expect(findings[0]?.code).toBe('${CODE}');
  expect(findings[0]?.cause).toContain(':2');
  expect(findings[0]?.fix).toContain('aspect-ratio');
});

unitTest('a width without a height is half a box, and half is none', () => {
  expect(unsizedImages(file('<img src="/a.png" width={800} alt="" />'))).toHaveLength(1);
});

unitTest('the pair satisfies it, and so does an aspect-ratio on its own', () => {
  expect(unsizedImages(file('<img src="/a.png" width={800} height={600} alt="" />'))).toEqual([]);
  const styled = '<img src="/a.png" style={{ "aspect-ratio": "16 / 9" }} alt="" />';
  expect(unsizedImages(file(styled))).toEqual([]);
});

unitTest('the framework wrapper is the same element for this purpose', () => {
  expect(unsizedImages(file('<Image src="/a.png" alt="" />'))).toHaveLength(1);
});

unitTest('a lazy priority image is its own finding, with its own edit', () => {
  const source = '<img src="/hero.png" width={800} height={600} priority loading="lazy" alt="" />';
  const findings = unsizedImages(file(source));
  expect(findings).toHaveLength(1);
  expect(findings[0]?.fix).toContain('delete loading="lazy"');
});

unitTest('lazy without priority is the right thing to write', () => {
  const source = '<img src="/thumb.png" width={80} height={80} loading="lazy" alt="" />';
  expect(unsizedImages(file(source))).toEqual([]);
});

// Nothing inside a <template> is laid out, so nothing inside one can shift anything.
unitTest('an img inside a template shifts nothing and is not reported', () => {
  const source = '<template><img src="/a.png" alt="" /></template>';
  expect(unsizedImages(file(source))).toEqual([]);
});

unitTest('maxWidth is not width, and a commented-out img is not an element', () => {
  expect(unsizedImages(file('<img src="/a.png" maxWidth={8} height={6} alt="" />'))).toHaveLength(
    1,
  );
  expect(unsizedImages(file('// <img src="/a.png" alt="" />\\nconst a = 1;'))).toEqual([]);
});
`;

/** `guards/image-dimensions.ts` and its test. The directory is the registration. */
export const imageDimensionsGuardFiles = (): readonly GeneratedFile[] => [
  { path: 'guards/image-dimensions.ts', contents: source() },
  { path: 'guards/image-dimensions.test.ts', contents: test() },
];
