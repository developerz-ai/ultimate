// Session lifecycle, and the one rule in this package that protects a person rather than a run:
// a refused credential is never presented twice.

import { describe, expect, test } from 'bun:test';
import { structuredLogger } from '@ultimat3/core';
import type { AuthPlanInput, PromptHandler, ScrapeAuth } from './auth';
import { ensureAuthenticated, markRefused, restorableSession, scrapePrompt } from './auth';
import { testScrapeClock } from './clock';
import { fakePage } from './driver-fake';
import type { ScrapePage } from './page';
import { redactSecrets, secretBag } from './secrets';
import { memorySessionStore, type SessionState } from './session-state';

const silent = structuredLogger({ writer: () => undefined });
const clock = testScrapeClock(new Date('2026-08-18T00:00:00.000Z'));

/** What a run was queued with: handed to the prompt handler verbatim. */
const INPUT = { connectionId: 'conn-1' };

const promptOver = (handler: PromptHandler | undefined, page: ScrapePage) =>
  scrapePrompt({ scrape: 'bank', handler, input: INPUT, page, runId: 'run-1', clock });

const codeOf = async (promise: Promise<unknown>): Promise<string | undefined> => {
  try {
    await promise;
    return undefined;
  } catch (thrown) {
    return (thrown as { code?: string }).code;
  }
};

const stored = (over: Partial<SessionState> = {}): SessionState => ({
  key: 'org-1/bank/default',
  savedAt: '2026-08-18T00:00:00.000Z',
  cookies: [
    { name: 'sid', value: 'x', domain: 'bank.test', path: '/', httpOnly: true, secure: true },
  ],
  headers: {},
  storage: {},
  userAgent: 'agent',
  origin: 'https://bank.test',
  ...over,
});

const planFor = <I>(auth: ScrapeAuth<I> | undefined): AuthPlanInput<I> => ({
  scrape: 'bank',
  auth,
  key: 'org-1/bank/default',
  clock,
  logger: silent,
});

describe('unit · reuse is the fast path', () => {
  test('a stored session is restored', async () => {
    const store = memorySessionStore({ 'org-1/bank/default': stored() });
    const found = await restorableSession(planFor({ login: () => Promise.resolve(), store }));
    expect(found?.cookies).toHaveLength(1);
  });

  test('reuse: false restores nothing, however good the session is', async () => {
    const store = memorySessionStore({ 'org-1/bank/default': stored() });
    const found = await restorableSession(
      planFor({ login: () => Promise.resolve(), store, reuse: false }),
    );
    expect(found).toBeUndefined();
  });

  test('a session past maxAge is not restored', async () => {
    const store = memorySessionStore({
      'org-1/bank/default': stored({ savedAt: '2026-08-01T00:00:00.000Z' }),
    });
    const found = await restorableSession(
      planFor({ login: () => Promise.resolve(), store, maxAge: 86_400_000 }),
    );
    expect(found).toBeUndefined();
  });
});

describe('unit · validate decides, and an invalid session is burned before the re-login', () => {
  const page = fakePage('<p>hi</p>');

  test('a valid session skips the login entirely', async () => {
    let logins = 0;
    const auth: ScrapeAuth<unknown> = {
      login: () => {
        logins += 1;
        return Promise.resolve();
      },
      validate: () => Promise.resolve(true),
      store: memorySessionStore({ 'org-1/bank/default': stored() }),
    };
    const loggedIn = await ensureAuthenticated({
      ...planFor(auth),
      input: {},
      runId: 'run-1',
      page,
      restored: stored(),
      secrets: secretBag([]),
      prompt: promptOver(undefined, page),
    });
    expect(loggedIn).toBe(false);
    expect(logins).toBe(0);
  });

  test('an expired session is burned, then re-logged-in', async () => {
    let logins = 0;
    const store = memorySessionStore({ 'org-1/bank/default': stored() });
    const auth: ScrapeAuth<unknown> = {
      login: () => {
        logins += 1;
        return Promise.resolve();
      },
      validate: () => Promise.resolve(false),
      store,
    };
    const loggedIn = await ensureAuthenticated({
      ...planFor(auth),
      input: {},
      runId: 'run-1',
      page,
      restored: stored(),
      secrets: secretBag([]),
      prompt: promptOver(undefined, page),
    });
    expect(loggedIn).toBe(true);
    expect(logins).toBe(1);
    // Burned: the next attempt starts from a new identity rather than reloading a flagged one.
    expect(await store.load('org-1/bank/default')).toBeUndefined();
  });
});

describe('unit · a refused credential is never presented twice', () => {
  test('reuse: false still refuses — the tombstone is read BEFORE the reuse decision', async () => {
    const store = memorySessionStore();
    // `reuse: false` means "do not restore this session", never "present the rejected credential
    // again": a second wrong password is what locks the account, and the record is the only thing
    // that knows it was wrong.
    const plan = planFor<unknown>({ login: () => Promise.resolve(), store, reuse: false });
    await markRefused(plan, undefined);
    expect(await codeOf(restorableSession(plan))).toBe('X_SCRAPE_AUTH_FAILED');
  });

  test('the refusal is written down, and the NEXT attempt fails before reaching a login form', async () => {
    const store = memorySessionStore();
    const plan = planFor<unknown>({ login: () => Promise.resolve(), store });
    await markRefused(plan, undefined);
    // The queue dead-letters a `terminal` code on the attempt that threw it, so this is not what
    // makes the failure terminal — it is what makes it CHEAP. A replay, a manual requeue or a
    // second enqueue of the same input refuses here, before a browser opens, rather than typing
    // the same wrong password into the same bank once more.
    expect(await codeOf(restorableSession(plan))).toBe('X_SCRAPE_AUTH_FAILED');
  });
});

describe('unit · the 2FA prompt', () => {
  const page = fakePage('<p>hi</p>');

  test('with no handler declared, asking is X_SCRAPE_PROMPT_UNANSWERED', async () => {
    expect(await codeOf(promptOver(undefined, page)('sms code'))).toBe(
      'X_SCRAPE_PROMPT_UNANSWERED',
    );
  });

  test('an empty answer is not an answer', async () => {
    expect(await codeOf(promptOver(() => '', page)('sms code'))).toBe('X_SCRAPE_PROMPT_UNANSWERED');
  });

  test('a handler answers, and is told what is being asked', async () => {
    const prompt = promptOver((request) => `code-for-${request.label}`, page);
    expect(await prompt('sms code')).toBe('code-for-sms code');
  });

  test('each prompt is told which run asks and which prompt of the run it is', async () => {
    const seen: string[] = [];
    const prompt = promptOver((request) => {
      seen.push(`${request.runId}:${String(request.index)}`);
      return 'a-code';
    }, page);
    await prompt('sms code');
    await prompt('security question');
    expect(seen).toEqual(['run-1:1', 'run-1:2']);
  });

  test('an answer is concealed in the run secret set and counted, before the body has it', async () => {
    const secrets = secretBag([]);
    let answered = 0;
    const prompt = scrapePrompt({
      scrape: 'bank',
      handler: () => '482913',
      input: INPUT,
      page,
      runId: 'run-1',
      clock,
      secrets,
      onAnswered: () => {
        answered += 1;
      },
    });
    expect(await prompt('sms code')).toBe('482913');
    expect(answered).toBe(1);
    expect(redactSecrets('the code 482913 was echoed', secrets)).toBe(
      'the code [redacted] was echoed',
    );
  });

  test('keepAlive is one read through the page vocabulary — it reports activity', async () => {
    let touches = 0;
    const watched = fakePage('<p>hi</p>', {
      context: {
        onActivity: () => {
          touches += 1;
        },
      },
    });
    const prompt = promptOver(async (request) => {
      await request.keepAlive();
      return 'a-code';
    }, watched);
    await prompt('sms code');
    expect(touches).toBe(1);
  });
});
