// The rule, driven directly. Failure case first: a guard whose rule silently stopped matching is
// a green gate over the convention it was written to enforce.

import { expect, unitTest } from '@ultimat3/testing';
import { untranslatedStrings } from './untranslated-string';

const file = (source: string) => [{ path: 'apps/web/site/page.tsx', source }];

unitTest('a typed JSX string is refused, and the finding quotes it', () => {
  const findings = untranslatedStrings(file('<h1>Welcome back</h1>'));
  expect(findings).toHaveLength(1);
  expect(findings[0]?.code).toBe('X_UNTRANSLATED_STRING');
  expect(findings[0]?.cause).toContain('Welcome back');
});

unitTest('a t() child satisfies it, and so does any other expression', () => {
  expect(untranslatedStrings(file("<h1>{t('site.home.title')}</h1>"))).toEqual([]);
  expect(untranslatedStrings(file('<li class={styles.item}>{row.title}</li>'))).toEqual([]);
});

// The legitimate lookalike, and the one this rule got wrong: a JSX expression NESTS. A mask that
// does not strips the inner `{ org: … }` first and reads the unbalanced remnant as prose, so the
// guard reported the very calls it exists to require.
unitTest('a t() call carrying an interpolation object is not typed prose', () => {
  const interpolated = "<h1>{t('app.feed.heading', { org: actor.org.name })}</h1>";
  expect(untranslatedStrings(file(interpolated))).toEqual([]);
  expect(untranslatedStrings(file(`<span>{t(\`plans.\${plan}.name\`)}</span>`))).toEqual([]);
});

// The other direction: masking a nested child may not swallow the prose beside it.
unitTest('prose beside an interpolating t() call is still refused', () => {
  const mixed = "<h1>{t('app.feed.heading', { org: actor.org.name })} Welcome back</h1>";
  const findings = untranslatedStrings(file(mixed));
  expect(findings).toHaveLength(1);
  expect(findings[0]?.cause).toContain('Welcome back');
});

// The reason the rule reads a CLOSING tag: a generic type argument is a > followed by source that
// looks exactly like prose, and a pattern reading to the next < reports every one of them.
unitTest('a generic type argument is not a JSX text node', () => {
  const generic = "const [state, setState] = createSignal<SaveState>('idle');\nconst n = 1;";
  expect(untranslatedStrings(file(generic))).toEqual([]);
});

unitTest('one word character is a symbol, not a sentence', () => {
  expect(untranslatedStrings(file('<span>&</span>'))).toEqual([]);
});
