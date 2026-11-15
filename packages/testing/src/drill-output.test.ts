// A role's output as the drill counts it: a line split across chunks is one line, the last line
// counts with no newline after it, and the count outlives the tail that the log is cut to.

import { describe, expect, test } from 'bun:test';
import { tailOf } from './drill-output';

const streamOf = (chunks: readonly string[]): ReadableStream<Uint8Array> =>
  new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(new TextEncoder().encode(chunk));
      controller.close();
    },
  });

/** Every queued chunk read: the readers run in the background. */
const settled = () => Bun.sleep(5);

describe('tailOf', () => {
  test('a line split across chunks counts once; an unterminated last line counts', async () => {
    const output = tailOf(
      [streamOf(['boot\n{"code":"X_SC', 'HEMA"}\nnext\n', 'X_SCHEMA'])],
      'X_SCHEMA',
    );
    await settled();
    expect(output.watched()).toBe(2);
    expect(output.log()).toBe('boot\n{"code":"X_SCHEMA"}\nnext\nX_SCHEMA');
  });

  test('both streams are counted, and the count is kept past the tail', async () => {
    const noise = `${'x'.repeat(9_000)}\n`;
    const output = tailOf(
      [streamOf(['X_SCHEMA wait\n', noise]), streamOf(['X_SCHEMA\n'])],
      'X_SCHEMA',
    );
    await settled();
    expect(output.watched()).toBe(2);
    expect(output.log().length).toBe(8_000);
  });

  test('no watch counts nothing', async () => {
    const output = tailOf([streamOf(['X_SCHEMA\n'])]);
    await settled();
    expect(output.watched()).toBe(0);
  });
});
