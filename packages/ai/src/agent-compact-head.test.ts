// The first message a compaction rebuilds: the prompt as sent, what the USER said in the turns
// being summarised (verbatim — an instruction is not left to a summary), then the one summary.
import { describe, expect, test } from 'bun:test';
import { compactedHead, KEPT_USER_CHARS } from './agent-compact';
import { repairTurn } from './agent-transcript';
import type { AiMessage } from './provider';

const texts = (message: AiMessage): readonly string[] =>
  typeof message.content === 'string'
    ? [message.content]
    : message.content.flatMap((block) => (block.type === 'text' ? [block.text] : []));

const turn = (id: string, user?: string): readonly AiMessage[] => [
  { role: 'assistant', content: [{ type: 'tool_use', id, name: 'readDoc', input: {} }] },
  {
    role: 'user',
    content: [
      { type: 'tool_result', tool_use_id: id, content: 'a page' },
      ...(user === undefined ? [] : [{ type: 'text' as const, text: user }]),
    ],
  },
];

const HEAD: AiMessage = { role: 'user', content: 'Write about tides.' };

describe('compactedHead()', () => {
  test("a continuation's user turn older than keepTurns is still sent verbatim", () => {
    const older = [...turn('a'), ...turn('b', 'Rewrite section 3 in French.'), ...turn('c')];
    const head = compactedHead(HEAD, older, 3, 'SUMMARY');
    expect(texts(head)).toEqual([
      'Write about tides.',
      'Rewrite section 3 in French.',
      expect.stringContaining('SUMMARY'),
    ]);
    // Tool results are the summary's to cover: none is carried.
    expect(JSON.stringify(head)).not.toContain('tool_result');
  });

  test('a plain user message between turns is kept; the framework’s own correction is not', () => {
    const older: readonly AiMessage[] = [
      { role: 'assistant', content: 'A draft.' },
      { role: 'user', content: 'Shorter, please.' },
      { role: 'assistant', content: 'Not JSON.' },
      repairTurn([], 'title: expected string'),
    ];
    expect(texts(compactedHead(HEAD, older, 2, 'S')).slice(0, -1)).toEqual([
      'Write about tides.',
      'Shorter, please.',
    ]);
  });

  test('a second compaction replaces the summary and keeps what the user said before it', () => {
    const once = compactedHead(HEAD, turn('a', 'In French.'), 1, 'FIRST');
    const twice = compactedHead(once, turn('b', 'And shorter.'), 1, 'SECOND');
    expect(texts(twice)).toEqual([
      'Write about tides.',
      'In French.',
      'And shorter.',
      expect.stringContaining('SECOND'),
    ]);
    expect(JSON.stringify(twice)).not.toContain('FIRST');
  });

  test('repeated compactions never carry more than KEPT_USER_CHARS of user text in total', () => {
    let head = HEAD;
    for (const round of [0, 1, 2, 3, 4]) {
      head = compactedHead(head, turn(`t${round}`, `U${round}:${'x'.repeat(3_000)}`), 1, 'S');
    }
    const carried = texts(head).slice(1, -1);
    expect(texts(head)[0]).toBe('Write about tides.');
    // Newest first: the two latest fit the one budget, the older three are the summary's.
    expect(carried.map((text) => text.slice(0, 3))).toEqual(['U3:', 'U4:']);
    expect(carried.join('').length).toBeLessThanOrEqual(KEPT_USER_CHARS);
  });

  test('a prompt of several blocks stays whole across compactions; only carried text is charged', () => {
    const prompt: AiMessage = {
      role: 'user',
      content: [
        { type: 'text', text: 'Write about tides.' },
        { type: 'text', text: 'y'.repeat(KEPT_USER_CHARS) },
      ],
    };
    const once = compactedHead(prompt, turn('a', 'In French.'), 1, 'FIRST');
    const twice = compactedHead(once, turn('b', 'And shorter.'), 1, 'SECOND');
    expect(texts(twice).slice(0, -1)).toEqual([
      'Write about tides.',
      'y'.repeat(KEPT_USER_CHARS),
      'In French.',
      'And shorter.',
    ]);
  });

  test('a prompt that merely STARTS with the marker is not mistaken for an old summary', () => {
    const head: AiMessage = { role: 'user', content: '[compacted: notes] Write about tides.' };
    expect(texts(compactedHead(head, turn('a'), 1, 'S'))[0]).toBe(
      '[compacted: notes] Write about tides.',
    );
  });

  test('user text past the allowance is left to the summary, newest kept first', () => {
    const long = 'x'.repeat(KEPT_USER_CHARS);
    const older = [...turn('a', long), ...turn('b', 'The newest instruction.')];
    expect(texts(compactedHead(HEAD, older, 2, 'S')).slice(0, -1)).toEqual([
      'Write about tides.',
      'The newest instruction.',
    ]);
  });
});
