// URL-mode elicitation on a JSON answer (MCP 2026-07-28, `client/elicitation`, `basic/patterns/
// mrtr`): how a tool says "the person must open this page", and what one `tools/call` answers for
// it. A modern request that declared `elicitation.url` gets an `InputRequiredResult`; every other
// caller gets the tool's `content`. Stateless: no `requestState` goes out, so none is trusted back.

import { isJsonObject, UltimateError } from '@ultimat3/core';
// why a side-effect import: the code this class raises is REGISTERED by `errors.ts`.
import './errors';
import { eraOf } from './protocol-era';
import type { McpToolResult, McpUrlElicitation } from './registry';
import type { JsonRpcRequest } from './wire';
import { META_CLIENT_CAPABILITIES, paramsOf } from './wire';

/** The one key of `inputRequests`, and the key a retry answers under in `inputResponses`. */
export const URL_ELICITATION_KEY = 'url_elicitation';

/** Why an ask is refused — a reason, never the value: the URL may be the secret it must not hold. */
type AskDefect = 'shape' | 'message' | 'url' | 'scheme' | 'credentials';

const DEFECT: Readonly<Record<AskDefect, string>> = {
  shape: 'is not an object with a string url and a string message',
  message: 'has an empty message, so the person would be shown a URL and no reason',
  url: 'has a url that is not an absolute URL',
  scheme: 'has a url that is neither https nor http on this machine',
  credentials: 'has a url carrying a username or password',
};

export class McpElicitationUrlError extends UltimateError {
  constructor(input: { defect: AskDefect }) {
    super({
      code: 'X_MCP_ELICITATION_URL_INVALID',
      cause: `a tool asked for a URL prompt that ${DEFECT[input.defect]}`,
      fix: "withUrlElicitation(output, { url: new URL('/connect', appOrigin).href, message: 'Open this page to finish connecting.' })   // an absolute https URL (http only on localhost), no user:password@, a non-empty message",
      callerFix:
        'this is a fault in the tool, not in the call: report it to the server operator, and do not retry — the same call is refused the same way',
      meta: { defect: input.defect },
    });
  }
}

const LOOPBACK: ReadonlySet<string> = new Set(['localhost', '127.0.0.1', '[::1]']);

/**
 * The ask, checked: the spec's server rules that can be read off the value. The URL must be valid;
 * it should be https outside development; it must not carry credentials. What cannot be read off
 * it stays the app's: nothing about the person in it, and the page it names verifies who opened it.
 */
function checked(ask: unknown): McpUrlElicitation {
  if (!isJsonObject(ask) || typeof ask['url'] !== 'string' || typeof ask['message'] !== 'string') {
    throw new McpElicitationUrlError({ defect: 'shape' });
  }
  const { url, message } = ask;
  if (message.trim() === '') throw new McpElicitationUrlError({ defect: 'message' });
  if (!URL.canParse(url)) throw new McpElicitationUrlError({ defect: 'url' });
  const parsed = new URL(url);
  const local = parsed.protocol === 'http:' && LOOPBACK.has(parsed.hostname);
  if (parsed.protocol !== 'https:' && !local)
    throw new McpElicitationUrlError({ defect: 'scheme' });
  if (parsed.username !== '' || parsed.password !== '') {
    throw new McpElicitationUrlError({ defect: 'credentials' });
  }
  return { url, message };
}

// Keyed on the returned value, as `query-page.ts` keys a cut page: the output stays what the
// handler returned, on every surface, and only the MCP projection reads the ask beside it.
const asks = new WeakMap<object, McpUrlElicitation>();

/**
 * From a tool's or an action's handler: `return withUrlElicitation(output, { url, message })`.
 * `output` is returned as it is and must still say, in its own fields, what the person has to do —
 * it is the whole answer for every client that cannot show the prompt. The call is retried by the
 * client after the person answers, so a handler that asks must be safe to run again.
 */
export function withUrlElicitation<T extends object>(output: T, ask: McpUrlElicitation): T {
  asks.set(output, checked(ask));
  return output;
}

/** The ask recorded for this output, or `undefined`. */
export function urlElicitationOf(output: unknown): McpUrlElicitation | undefined {
  return typeof output === 'object' && output !== null ? asks.get(output) : undefined;
}

/** `elicitation.url` is an object on THIS request. `elicitation: {}` is form mode only. */
function declaresUrlMode(params: Record<string, unknown> | null): boolean {
  const meta = params?.['_meta'];
  const capabilities = isJsonObject(meta) ? own(meta, META_CLIENT_CAPABILITIES) : undefined;
  const elicitation = isJsonObject(capabilities) ? own(capabilities, 'elicitation') : undefined;
  return isJsonObject(elicitation) && isJsonObject(own(elicitation, 'url'));
}

const ACTIONS: ReadonlySet<unknown> = new Set(['accept', 'decline', 'cancel']);

/**
 * The retry already carries the person's answer. Asked once per call, whatever the answer: accept
 * is consent to open the page, not proof the page was finished, and only the tool's own rerun
 * knows which — so the rerun's `content` is the answer, and a decline is never asked again.
 */
function answered(params: Record<string, unknown> | null): boolean {
  const responses = params?.['inputResponses'];
  const response = isJsonObject(responses) ? own(responses, URL_ELICITATION_KEY) : undefined;
  return isJsonObject(response) && ACTIONS.has(own(response, 'action'));
}

/** An OWN member: the request is a caller's JSON, and a prototype is not something it sent. */
const own = (value: Record<string, unknown>, key: string): unknown =>
  Object.hasOwn(value, key) ? value[key] : undefined;

/**
 * What `tools/call` answers instead of the tool's result, or `undefined` for "the result itself".
 * Throws `X_MCP_ELICITATION_URL_INVALID` for a bad ask whoever called: a fault that showed only
 * to a capable client would ship unseen.
 *
 * Legacy revisions get the plain answer. 2025-11-25 defines `URLElicitationRequiredError`
 * (`-32042`) for a JSON answer, but its capability is declared once, on `initialize`, and this
 * server keeps no handshake — and a server MUST NOT send a mode the client did not declare.
 */
export function inputRequiredFor(
  request: JsonRpcRequest,
  result: McpToolResult,
): Record<string, unknown> | undefined {
  if (result.urlElicitation === undefined) return undefined;
  const ask = checked(result.urlElicitation);
  const params = paramsOf(request);
  if (eraOf(request) !== 'modern' || !declaresUrlMode(params) || answered(params)) return undefined;
  return {
    resultType: 'input_required',
    inputRequests: {
      [URL_ELICITATION_KEY]: {
        method: 'elicitation/create',
        params: { mode: 'url', url: ask.url, message: ask.message },
      },
    },
  };
}
