/**
 * The summary call's text form: a tool result clipped to its first and last halves of
 * `SUMMARY_CLIP_CHARS`, and turns shortened oldest first — every turn clipped before any turn's
 * results are left out — to the least shortening that fits. A turn itself is never dropped.
 */

import { describe, expect, test } from 'bun:test';
import { clipText, SUMMARY_CLIP_CHARS, shortestFit } from './agent-compact-text';
import type { AiMessage } from './provider';

/** One turn: a call and its result of `size` characters, `HEAD<n>` first and `TAIL<n>` last. */
const turn = (n: number, size: number): readonly AiMessage[] => [
  {
    role: 'assistant',
    content: [{ type: 'tool_use', id: `c${n}`, name: 'readLog', input: { page: n } }],
  },
  {
    role: 'user',
    content: [
      {
        type: 'tool_result',
        tool_use_id: `c${n}`,
        content: `HEAD${n}${'m'.repeat(size - 10)}TAIL${n}`,
      },
    ],
  },
];

const under = (chars: number) => (text: string) => text.length <= chars;

describe('clipText', () => {
  test('keeps the first and last half of SUMMARY_CLIP_CHARS and says how much is left out', () => {
    const value = `${'a'.repeat(1_000)}${'b'.repeat(8_000)}${'c'.repeat(1_000)}`;
    const clipped = clipText(value);
    expect(clipped.startsWith('a'.repeat(SUMMARY_CLIP_CHARS / 2))).toBe(true);
    expect(clipped.endsWith('c'.repeat(SUMMARY_CLIP_CHARS / 2))).toBe(true);
    expect(clipped).not.toContain('b');
    expect(clipped).toContain('[… 8000 characters left out …]');
  });

  test('leaves a value at or under the size whole, and never makes one longer', () => {
    const at = 'x'.repeat(SUMMARY_CLIP_CHARS);
    expect(clipText(at)).toBe(at);
    const barely = 'x'.repeat(SUMMARY_CLIP_CHARS + 3);
    expect(clipText(barely)).toBe(barely);
  });

  test('never splits a surrogate pair', () => {
    const value = '😀'.repeat(3_000);
    const clipped = clipText(value);
    expect(clipped).not.toBe(value);
    expect(clipped.startsWith('😀'.repeat(1_000))).toBe(true);
    expect(clipped.endsWith('😀'.repeat(1_000))).toBe(true);
    expect(clipped).toContain('[… 1000 characters left out …]');
  });
});

describe('shortestFit', () => {
  const turns = [turn(1, 6_000), turn(2, 6_000), turn(3, 6_000)];
  const whole = shortestFit(turns, () => true) ?? expect.unreachable('nothing fit');

  test('whole when the whole transcript fits: every call and result, verbatim', () => {
    expect(whole).toMatchObject({ clipped: 0, omitted: 0 });
    for (const n of [1, 2, 3]) expect(whole.text).toContain(`HEAD${n}${'m'.repeat(5_990)}TAIL${n}`);
    expect(whole.text).toContain('[tool call readLog #c1]: {"page":1}');
  });

  test('clips the OLDEST turn first, and only as many as it must', () => {
    const fit = shortestFit(turns, under(whole.text.length - 3_000)) ?? expect.unreachable('none');
    expect(fit).toMatchObject({ clipped: 1, omitted: 0 });
    expect(fit.text).toContain('[… 4000 characters left out …]');
    expect(fit.text).not.toContain(`HEAD1${'m'.repeat(5_990)}`);
    expect(fit.text).toContain(`HEAD2${'m'.repeat(5_990)}TAIL2`);
    // Clipped, not cut off: the first result's end survives.
    expect(fit.text).toContain('TAIL1');
  });

  test('leaves results out only once every turn is clipped, oldest first', () => {
    const clippedAll = shortestFit(turns, under(7_000)) ?? expect.unreachable('none');
    expect(clippedAll).toMatchObject({ clipped: 3, omitted: 0 });
    const fit = shortestFit(turns, under(clippedAll.text.length - 1)) ?? expect.unreachable('x');
    expect(fit).toMatchObject({ clipped: 3, omitted: 1 });
    expect(fit.text).toContain('[tool result #c1 left out: 6000 characters]');
    expect(fit.text).toContain('TAIL2');
    expect(fit.text).toContain('TAIL3');
    // The call itself is still there: what was asked survives what it returned.
    expect(fit.text).toContain('[tool call readLog #c1]');
  });

  test('undefined when every result left out still does not fit — no turn is dropped', () => {
    expect(shortestFit(turns, under(50))).toBeUndefined();
  });
});
