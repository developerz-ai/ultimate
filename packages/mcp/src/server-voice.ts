// What the server SAYS, per caller, as opposed to what it decides: `initialize`'s `instructions`,
// the audience every `fix:` line is written for, and the tool result a mistyped argument earns.
// Split from `server.ts` for the size ceiling; it holds no gate — dispatch stays there.

import { InputInvalidError } from '@ultimat3/action';
import type { ErrorAudience } from '@ultimat3/core';
import { formatIssues } from '@ultimat3/schema';
import type { McpCaller, McpToolResult } from './registry';
import type { ArgIssue } from './validate-args';

/** See `McpServerInput.instructions`. */
export type McpInstructions = string | ((caller: McpCaller) => string | undefined);

/** The server's per-caller wording: `initialize`'s advice and the audience of every `fix:` line. */
export interface McpServerVoice {
  readonly instructions?: McpInstructions | undefined;
  readonly errorAudience: ErrorAudience;
}

/** The instructions THIS caller is handed, or `undefined`. Fail-closed to none, never a throw. */
export function instructionsFor(
  instructions: McpInstructions | undefined,
  caller: McpCaller,
): string | undefined {
  if (instructions === undefined) return undefined;
  let text: unknown;
  try {
    text = typeof instructions === 'function' ? instructions(caller) : instructions;
  } catch {
    // The handshake is the one call every client makes; advice that failed to render must not
    // take the connection down with it.
    return undefined;
  }
  return typeof text === 'string' && text.trim() !== '' ? text : undefined;
}

/**
 * A tool RESULT for arguments that failed the published schema — not a JSON-RPC error, since
 * 22.10. Clients surface a protocol error to the human and hide it from the model, so the `-32602`
 * this answered left the agent nothing to correct and it retried blind. `isError` reaches the
 * model carrying the same `X_INPUT_INVALID` an HTTP caller gets for the same input, each issue
 * addressed by path. `-32602` stays for what is not a call at all (no params, a non-string name).
 */
export function invalidArgsResult(
  name: string,
  issues: readonly ArgIssue[],
  audience: ErrorAudience,
): { readonly code: string; readonly result: McpToolResult } {
  const invalid = new InputInvalidError(
    name,
    formatIssues(issues).join('; '),
    issues.map((issue) => ({
      path: issue.path,
      expected: issue.message,
      received: '',
      message: issue.message,
    })),
    'tool',
  );
  return {
    code: invalid.code,
    result: { content: [{ type: 'text', text: invalid.format({ audience }) }], isError: true },
  };
}
