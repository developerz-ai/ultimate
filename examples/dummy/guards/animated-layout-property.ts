// animated-layout-property: an animation moves `transform` and `opacity`, never the layout.
// `x verify` discovers every file in `guards/` and runs its `guard` inside the `boundaries`
// step — nothing registers this file, so nothing can forget to. Delete it to drop the rule.

import type { Finding, Guard } from '@ultimat3/cli';

/** The app owns the codes its own conventions raise — this one is named for the guard. */
const CODE = 'X_ANIMATED_LAYOUT_PROPERTY';

/**
 * What each layout property should have been, so the fix is an edit and not a category. A property
 * with no obvious equivalent takes the default below rather than an invented one.
 */
const INSTEAD = new Map([
  ['top', 'transform: translateY(…)'],
  ['bottom', 'transform: translateY(…)'],
  ['left', 'transform: translateX(…)'],
  ['right', 'transform: translateX(…)'],
  ['inset', 'transform: translate(…)'],
  ['width', 'transform: scaleX(…)'],
  ['height', 'transform: scaleY(…)'],
  ['box-shadow', 'opacity on a shadow layer that is already painted'],
]);

/** A property whose change the browser cannot composite: it re-lays-out or re-paints the frame. */
const isLayoutProperty = (property: string): boolean =>
  INSTEAD.has(property) ||
  property.startsWith('margin') ||
  property.startsWith('padding') ||
  /^(?:min|max)-(?:width|height)$/.test(property);

/**
 * A DECLARATION, never a whole line: a selector carries no colon, so `.transition { … }` is not a
 * value and is never reported. The value stops at the first `;`, `{` or `}`.
 */
const DECLARATION = /([\w-]+)\s*:\s*([^;{}]+)/g;

/** A CSS identifier that could name a property. `200ms`, `0.2s` and `cubic-bezier(…)` cannot. */
const IDENTIFIER = /^-?[a-z][a-z-]*$/i;
/**
 * Identifiers that appear in a `transition` and are never the property being animated —
 * `none` included, which is what makes the `transition: none` branch below load-bearing rather
 * than decorative: without `none` here it reads as a property name, and with it the declaration
 * that turns every transition OFF would be reported as one that animates everything.
 */
const TIMING = new Set([
  'ease',
  'ease-in',
  'ease-out',
  'ease-in-out',
  'linear',
  'none',
  'step-start',
  'step-end',
  'normal',
  'infinite',
  'alternate',
  'forwards',
  'backwards',
  'both',
]);

export interface StyleFile {
  /** App-root-relative POSIX path, so the finding names the file an author opens. */
  readonly path: string;
  readonly scss: string;
}

/**
 * Comments blanked rather than removed, so the reported line number still points at the source
 * line. `//` is skipped when a `:` precedes it — `url(https://…)` is a value, not a comment.
 */
const blankComments = (scss: string): string =>
  scss
    .replaceAll(/\/\*[\s\S]*?\*\//g, (match) => match.replaceAll(/[^\n]/g, ' '))
    .replaceAll(/(?<![:\w])\/\/[^\n]*/g, (match) => ' '.repeat(match.length));

const lineOf = (text: string, index: number): number => text.slice(0, index).split('\n').length;

/** Which `@keyframes` block an index sits in, so an animated property can be named with its rule. */
function keyframeRanges(scss: string): ReadonlyMap<string, readonly [number, number]> {
  const ranges = new Map<string, readonly [number, number]>();
  for (const match of scss.matchAll(/@keyframes\s+([\w-]+)[^{]*\{/g)) {
    const from = match.index + match[0].length;
    let depth = 0;
    let to = scss.length;
    for (let i = from; i < scss.length; i += 1) {
      const ch = scss[i];
      if (ch === '{') depth += 1;
      else if (ch === '}') {
        if (depth === 0) {
          to = i;
          break;
        }
        depth -= 1;
      }
    }
    ranges.set(match[1] ?? 'the animation', [from, to]);
  }
  return ranges;
}

/**
 * The property each comma-separated part of a `transition` names, or `undefined` where the part
 * names none — which is not "nothing to animate": an omitted property IS `all`, so
 * `transition: 200ms ease` animates every property this element will ever have.
 */
function transitionProperties(value: string): readonly (string | undefined)[] {
  return value.split(',').map((part) => {
    const tokens = part.trim().split(/\s+/);
    return tokens
      .find((token) => IDENTIFIER.test(token) && !TIMING.has(token.toLowerCase()))
      ?.toLowerCase();
  });
}

/** Pure — the caller does the I/O — so the rule is testable without a filesystem. */
export function animatedLayoutProperties(files: readonly StyleFile[]): readonly Finding[] {
  const findings: Finding[] = [];
  for (const file of files) {
    const scss = blankComments(file.scss);
    const keyframes = keyframeRanges(scss);
    for (const match of scss.matchAll(DECLARATION)) {
      const property = (match[1] ?? '').toLowerCase();
      const value = (match[2] ?? '').trim();
      const at = `${file.path}:${lineOf(scss, match.index)}`;
      const animation = [...keyframes].find(
        ([, [from, to]]) => match.index > from && match.index < to,
      );
      if (animation !== undefined) {
        if (!isLayoutProperty(property)) continue;
        findings.push(layoutFinding(file.path, at, property, `@keyframes ${animation[0]}`));
        continue;
      }
      if (property !== 'transition' && property !== 'transition-property') continue;
      // `transition: none` turns transitions OFF. It is the one value that names no property and
      // animates nothing, so reading it as the implicit `all` below would report the opposite.
      if (value.toLowerCase() === 'none') continue;
      for (const animated of transitionProperties(value)) {
        if (animated === undefined || animated === 'all') {
          findings.push({
            code: CODE,
            cause: `${at} transitions every property of this element — ${animated === undefined ? `\`${property}: ${value}\` names none, and an omitted property is \`all\`` : 'written out as `all`'} — so it animates properties nobody chose, the ones that cost a layout pass included, and no part of it can be composited`,
            fix: `name the properties in ${at} — \`transition: transform tokens.duration('fast') tokens.easing('out')\` — then: x verify`,
            at: file.path,
          });
          continue;
        }
        if (!isLayoutProperty(animated)) continue;
        findings.push(layoutFinding(file.path, at, animated, 'this transition'));
      }
    }
  }
  return findings;
}

function layoutFinding(path: string, at: string, property: string, where: string): Finding {
  const instead = INSTEAD.get(property) ?? 'transform or opacity, which the compositor owns';
  return {
    code: CODE,
    cause: `${at} animates ${property} in ${where} — only transform and opacity are compositor-only, so every frame of this costs a full layout or paint pass on the same main thread the app runs on, and a moving box feeds the layout-shift metric while it does it`,
    fix: `animate ${instead} instead of ${property} at ${at}, then: x verify`,
    at: path,
  };
}

export const guard: Guard = {
  summary: 'an animation moves transform and opacity, never the layout',
  async check(root) {
    const files: StyleFile[] = [];
    for await (const entry of new Bun.Glob('{apps,packages}/**/*.scss').scan({
      cwd: root,
      absolute: false,
    })) {
      const path = entry.split('\\').join('/');
      if (path.includes('node_modules/')) continue;
      files.push({ path, scss: await Bun.file(`${root}/${path}`).text() });
    }
    return animatedLayoutProperties(files);
  },
};
