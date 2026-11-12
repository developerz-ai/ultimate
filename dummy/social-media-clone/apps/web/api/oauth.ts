// The two decisions on `/oauth/consent`: connect the agent, or refuse it. Declared as actions —
// the consent page's native forms post at the routes these names derive — so the decision has
// one policy, one audit trail and one typed client like every other write. The protocol (what a
// code is, where it goes) is `@ultimat3/auth`'s; this file only says WHO approved.

import { action, t } from '@ultimat3/action';
import { defineError } from '@ultimat3/core/page';
import { oauthConsent } from '../app/oauth/policy';
import { appOrigin, callerKey, mayRedirectRefusal, mcpOAuth } from '../app/oauth/server';

/** The consent page's own query, carried back by the form: the request is re-read, never trusted. */
const consentInput = t.object({ request: t.string.min(1).max(8192) });

const decisionOutput = t.object({
  /** Where the MCP client is sent next — a 303 for a browser, data for anyone else. */
  next: t.string,
});

export const OAuthRequestInvalid = defineError<string>({
  code: 'X_OAUTH_REQUEST_INVALID',
  title: 'the authorization request is not one this server can answer',
  status: 400,
  cause: (description) => `the authorization request was refused: ${description}`,
  fix: 'start the connection again from the MCP client — its authorization URL opens /oauth/consent with a fresh request',
});

/** The request the form carried, screened again exactly as the page screened it. */
const reread = async (query: string) => {
  const url = `${appOrigin()}/oauth/consent?${query}`;
  const read = await mcpOAuth.readRequest(url, { callerKey: callerKey() });
  if (read.ok) return read.request;
  if (read.redirectTo !== null && mayRedirectRefusal(new URL(url).searchParams)) {
    return read.redirectTo;
  }
  throw new OAuthRequestInvalid(read.description);
};

/**
 * A browser that posted the native form follows `next` (a 303 — to the MCP client, usually on
 * another origin); JSON gets it as data. A refused decision (`X_OAUTH_REQUEST_INVALID`) lands back
 * on the consent page it was posted from, whose `load` reads the code.
 */
const followNext = { success: (output: { readonly next: string }) => output.next };

export const approveConnection = action({
  input: consentInput,
  output: decisionOutput,
  policy: oauthConsent,
  // A person's decision, never an agent's: an agent approving its own connection is the escalation
  // the consent page exists to stop.
  mcp: { expose: false },
  native: followNext,
  async handle({ input, ctx }) {
    const request = await reread(input.request);
    if (typeof request === 'string') return { next: request };
    // The subject is the signed-in person the request established — never a value off the form.
    const next = await mcpOAuth.approve({ subject: ctx.actor.id, request, callerKey: callerKey() });
    return { next };
  },
});

export const denyConnection = action({
  input: consentInput,
  output: decisionOutput,
  policy: oauthConsent,
  mcp: { expose: false },
  native: followNext,
  async handle({ input }) {
    const request = await reread(input.request);
    if (typeof request === 'string') return { next: request };
    return { next: await mcpOAuth.deny({ request, callerKey: callerKey() }) };
  },
});
