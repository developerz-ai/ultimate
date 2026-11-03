// Every file `x new` writes gives ONE answer to "how do I raise an app error": `defineError`. The
// agent docs said "subclass UltimateError" after `guards/error-declared.ts` began refusing exactly
// that, so the scaffold instructed its own reader into a red gate.

import { describe, expect, test } from 'bun:test';
import { planNewApp } from '../cmd-new';

const ADVICE = /\bsubclass(?:es|ing)?\s+`?UltimateError\b/i;

describe('unit · x new · error advice', () => {
  // `guards/error-declared.ts` names the form it refuses; every other file is advice.
  test('no emitted file tells its reader to subclass UltimateError', () => {
    for (const example of [true, false]) {
      const advising = planNewApp({ name: 'advice-demo', example })
        .filter((file) => !file.path.startsWith('guards/'))
        .filter((file) => typeof file.contents === 'string' && ADVICE.test(file.contents))
        .map((file) => file.path);
      expect({ example, advising }).toEqual({ example, advising: [] });
    }
  });

  test('the agent briefs name defineError instead', () => {
    const texts = planNewApp({ name: 'advice-demo', example: true })
      .filter((file) => file.path.startsWith('.claude/'))
      .map((file) => (typeof file.contents === 'string' ? file.contents : ''))
      .join('\n');
    expect(texts).toContain('defineError');
  });
});
