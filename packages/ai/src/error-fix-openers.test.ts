// A fix is pasted from its first character: each refusal below opens with the call, member or
// command that repairs it, filled with the failure's own values.

import { describe, expect, test } from 'bun:test';
import {
  AiPromptRenderError,
  AiPromptVersionError,
  AiProviderUnavailableError,
  EmbedderDimMismatchError,
  LlmRefusedError,
  VectorDimMismatchError,
} from './errors';

describe('the fix opens with the repair', () => {
  test('a model no provider serves names the gateway wiring, not a config key that does not exist', () => {
    const unserved = new AiProviderUnavailableError({
      model: 'm-1',
      attempts: ['no provider serves m-1'],
      unserved: true,
    });
    expect(unserved.fix).toStartWith('providerGateway({ providers: [provider] })   // ');
    expect(unserved.fix).toContain("lists 'm-1'");
    const failed = new AiProviderUnavailableError({ model: 'm-1', attempts: ['p: 503'] });
    expect(failed.fix).toStartWith('x doctor --json   # ');
    for (const { fix } of [unserved, failed]) expect(fix).not.toContain('ai.providers');
  });

  test('an unfilled slot is the vars() object with every missing key', () => {
    const { fix } = new AiPromptRenderError({ ref: 'p@1', missing: ['postId', 'body'] });
    expect(fix).toStartWith('{ postId, body }   // returned from vars()');
  });

  test('a prompt version names the id it was asked about', () => {
    const { fix } = new AiPromptVersionError({ id: 'posts.sum', requested: '3', available: [] });
    expect(fix).toStartWith("definePrompt({ id: 'posts.sum', version, template })   // ");
  });

  test('a refusal with a stronger model names it as the member to set', () => {
    const { fix } = new LlmRefusedError({
      prompt: 'summarize',
      model: 'small',
      alternative: 'large',
      category: undefined,
      explanation: undefined,
    });
    expect(fix).toStartWith('model: \'large\'   // on the "summarize" declaration');
  });

  test('the two dimension mismatches name the width to declare', () => {
    expect(new VectorDimMismatchError({ store: 's', expected: 4, received: 8 }).fix).toStartWith(
      '{ dimension: 4 }   // ',
    );
    expect(
      new EmbedderDimMismatchError({ embedder: 'e', expected: 4, received: 8 }).fix,
    ).toStartWith('{ dimension: 8 }   // ');
  });
});
