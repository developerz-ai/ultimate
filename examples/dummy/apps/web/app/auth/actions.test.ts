// `endSession`, run inside a real request context: what it writes onto the response the pipeline
// assembles. The cookie is the demo viewer's switch, and the switch is script-settable by design.

import { runWithContext } from '@ultimat3/core';
import { asCtx, createRequestContext, defineHttpConfig } from '@ultimat3/http';
import { describe, expect, test } from '@ultimat3/testing';
import { AFTER_SIGN_OUT, endSession } from './actions';
import { DEMO_MEMBER_COOKIE, DEMO_SIGNED_OUT } from './demo-actor';

const signOut = async (accept: string) => {
  const url = new URL(`https://postly.test/api/sessions/end`);
  const config = defineHttpConfig({ dev: true, rateLimit: { scope: 'process' } });
  const request = createRequestContext({
    url,
    method: 'POST',
    role: 'web',
    config,
    requestHeaders: { accept },
  });
  const ctx = asCtx(request);
  const output = await runWithContext(ctx, () => endSession({}, { ctx }));
  return { output, request };
};

describe('ending the demo session', () => {
  test('sets the demo cookie to signed-out, and a page can still set it back', async () => {
    const { output, request } = await signOut('application/json');

    expect(output).toEqual({ ok: true, next: AFTER_SIGN_OUT });
    const cookie = request.headers
      .getSetCookie()
      .find((line) => line.startsWith(`${DEMO_MEMBER_COOKIE}=`));
    expect(cookie).toStartWith(`${DEMO_MEMBER_COOKIE}=${DEMO_SIGNED_OUT};`);
    // NOT HttpOnly: `demo-actor.ts`'s boot line tells a developer to switch member with
    // `document.cookie = '…'`, and a script write cannot overwrite an HttpOnly cookie — after one
    // sign-out that instruction would silently do nothing.
    expect(cookie?.toLowerCase()).not.toContain('httponly');
    // And the browser drops the previous member's storage and cached pages.
    expect(request.headers.get('clear-site-data')).not.toBeNull();
  });

  test('a native form post is sent home; an agent gets the JSON and no redirect', async () => {
    expect((await signOut('text/html')).request.redirect).toBeDefined();
    expect((await signOut('application/json')).request.redirect).toBeUndefined();
  });
});
