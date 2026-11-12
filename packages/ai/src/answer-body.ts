// Single responsibility: a non-streamed answer's 2xx body, read as JSON within a byte cap. A raw
// `response.json()` buffered the whole body before anything measured it, and a proxy's
// `<html>bad gateway</html>` escaped as a bare SyntaxError with no code and no fix.

import { readWithinLimit, renderThrowable } from '@ultimat3/core';
import { AiTransportError } from './errors';

/**
 * 32 MiB, the cap `remoteEmbedder` holds a response to. The largest legitimate answer — 128k
 * output tokens of JSON-escaped text plus its tool arguments — is a few MiB, so nothing real
 * reaches it and nothing unreal is held.
 */
export const ANSWER_BODY_MAX_BYTES = 32 * 1024 * 1024;

/** The parsed body, `unknown` — the wire's parser decides whether it is an answer. */
export async function readAnswerBody(response: Response, provider: string): Promise<unknown> {
  const read = await readWithinLimit(response.body, ANSWER_BODY_MAX_BYTES);
  if ('over' in read) {
    throw new AiTransportError({
      provider,
      status: response.status,
      detail: `response body is at least ${read.over} bytes, limit is ${ANSWER_BODY_MAX_BYTES}`,
    });
  }
  try {
    return JSON.parse(new TextDecoder().decode(read.bytes));
  } catch (error) {
    throw new AiTransportError({
      provider,
      status: response.status,
      detail: `the response body is not valid JSON: ${renderThrowable(error)}`,
    });
  }
}
