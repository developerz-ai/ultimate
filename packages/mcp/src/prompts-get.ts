// Single responsibility: MCP's `prompts/list` entries and the `prompts/get` answer. `initialize`
// advertises the `prompts` capability, so a listed prompt that `prompts/get` cannot resolve is a
// capability the server claims and does not have.

import type { McpPrompt } from './resources';
import type { JsonRpcId, JsonRpcResponse } from './wire';
import { errorResponse, INTERNAL_ERROR, INVALID_PARAMS, resultResponse } from './wire';

/** The wire fields alone — a prompt's reader is a function and never leaves the process. */
export const promptListEntry = (prompt: McpPrompt) => ({
  name: prompt.name,
  description: prompt.description,
  ...(prompt.arguments === undefined ? {} : { arguments: prompt.arguments }),
});

/** Only string arguments: MCP types every prompt argument as a string. */
const stringArguments = (raw: unknown): Readonly<Record<string, string>> => {
  if (typeof raw !== 'object' || raw === null) return {};
  return Object.fromEntries(
    Object.entries(raw).filter((entry): entry is [string, string] => typeof entry[1] === 'string'),
  );
};

export async function promptsGet(
  prompts: readonly McpPrompt[],
  id: JsonRpcId,
  params: Readonly<Record<string, unknown>> | null,
): Promise<JsonRpcResponse> {
  const name = params?.['name'];
  if (typeof name !== 'string') {
    return errorResponse(id, INVALID_PARAMS, 'prompts/get params.name must be a string');
  }
  const prompt = prompts.find((declared) => declared.name === name);
  if (prompt === undefined) {
    return errorResponse(id, INVALID_PARAMS, `prompt not found: ${name} — read prompts/list`);
  }
  if (prompt.read === undefined) {
    return errorResponse(id, INVALID_PARAMS, `prompt "${name}" declares no body to serve`);
  }
  try {
    const text = await prompt.read(stringArguments(params?.['arguments']));
    return resultResponse(id, {
      description: prompt.description,
      messages: [{ role: 'user', content: { type: 'text', text } }],
    });
  } catch {
    // No internals: a reader's own message names a path the caller has no business seeing — the
    // rule `resources/read` follows.
    return errorResponse(id, INTERNAL_ERROR, `prompt "${name}" could not be read`);
  }
}
