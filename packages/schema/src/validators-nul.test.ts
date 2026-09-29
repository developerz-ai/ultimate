// Single responsibility: pins the NUL refusal — the one code point Postgres `text` and `jsonb`
// cannot store — at the public `validate()` boundary, for every string-backed builtin and for a
// `t.record` key. A loosened rule fails here rather than as a 500 from the row write.

import { describe, expect, test } from 'bun:test';
import { formatIssues, validate } from './standard';
import { builtinT, objectSchema, recordSchema } from './validators';

const NUL = '\u0000';

describe('a string carrying U+0000', () => {
  test('t.string refuses it, naming the fact and never the content', () => {
    const schema = objectSchema({ title: builtinT.string });
    const rendered = formatIssues(validate(schema, { title: `secret${NUL}tail` }).issues ?? []);
    expect(rendered).toEqual([
      'title: expected a non-empty string, received a string of 11 characters that contains a NUL character (U+0000)',
    ]);
    expect(rendered.join('')).not.toContain('secret');
  });

  test('a lone NUL is refused, not counted as the one character `min(1)` asks for', () => {
    expect(validate(builtinT.string, NUL).issues?.[0]?.message).toContain('NUL character');
  });

  test('every string-backed builtin refuses it before its own format test', () => {
    for (const [name, schema, value] of [
      ['email', builtinT.email, `a${NUL}@b.co`],
      ['url', builtinT.url, `https://a.b/${NUL}`],
      ['slug', builtinT.slug, `a${NUL}b`],
      ['pattern', builtinT.string.pattern(/./s), NUL],
      ['max', builtinT.string.max(5), `ab${NUL}`],
    ] as const) {
      const message = validate(schema, value).issues?.[0]?.message;
      expect([name, message?.endsWith('that contains a NUL character (U+0000)')]).toEqual([
        name,
        true,
      ]);
    }
  });

  test('tabs, newlines and the other C0 controls stay legal text', () => {
    const value = `line one\nline two\ttabbed\r\u0001\u001f`;
    expect(validate(builtinT.string, value)).toEqual({ value });
  });
});

describe('a t.record key carrying U+0000', () => {
  test('is refused by position, never quoted — jsonb refuses it as a key too', () => {
    const schema = objectSchema({ meta: recordSchema(builtinT.number) });
    const rendered = formatIssues(
      validate(schema, { meta: { ok: 1, [`hunter2${NUL}`]: 2 } }).issues ?? [],
    );
    expect(rendered).toEqual([
      'meta[1]: expected a record key, received one that contains a NUL character (U+0000)',
    ]);
    expect(rendered.join('')).not.toContain('hunter2');
  });
});
