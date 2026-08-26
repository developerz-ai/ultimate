import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import {
  configureErrorReporting,
  memoryErrorReporter,
  resetErrorReporting,
  UltimateError,
} from '@ultimat3/core';
import { CURRENCY_CODE_PATTERN, isCurrencyCode } from '@ultimat3/schema';
import { defineHttpConfig } from './config';
import { factsOf, toProblem } from './error-facts';
import { ERROR_STATUS, registerErrorStatus, resetErrorStatus, statusFor } from './error-map';
import { HTTP_ERROR_CODES } from './errors';
import { createPipeline } from './pipeline';
import { text } from './response';
import { createRouter, type Route } from './router';

describe('error -> status', () => {
  test('every code this package can throw has a row', () => {
    for (const code of HTTP_ERROR_CODES) {
      expect(ERROR_STATUS[code], `missing status row for ${code}`).toBeNumber();
    }
  });

  // The table is the CLOSED one, and its type now says so: it is a literal object, never
  // `Readonly<Record<string, number>>`. A mistyped row has to be a compile error, because at
  // runtime it reads `undefined` and the loop above would report the real code as missing.
  // `@ts-expect-error` IS the assertion here — it stops compiling the day the index signature
  // comes back.
  test('a row this table does not carry is refused at compile time', () => {
    // @ts-expect-error `X_QUERY_NOT_PAGABLE` is a typo for `X_QUERY_NOT_PAGEABLE`.
    const typo: unknown = ERROR_STATUS.X_QUERY_NOT_PAGABLE;
    expect(typo).toBeUndefined();
    expect(ERROR_STATUS.X_QUERY_NOT_PAGEABLE).toBe(500);
  });

  test('maps the codes callers depend on', () => {
    expect(statusFor('X_ROUTE_NOT_FOUND')).toBe(404);
    expect(statusFor('X_METHOD_NOT_ALLOWED')).toBe(405);
    expect(statusFor('X_BODY_INVALID')).toBe(422);
    expect(statusFor('X_UNAUTHENTICATED')).toBe(401);
    expect(statusFor('X_FORBIDDEN')).toBe(403);
    expect(statusFor('X_RATE_LIMITED')).toBe(429);
    expect(statusFor('X_BUILD_SKEW')).toBe(409);
  });

  // The client wrote the path. A `%ZZ` used to reach `factsOf` as an unmapped `URIError` and take
  // the 500 default — which pages the on-call for someone else's typo.
  test('a path the client mis-encoded blames the caller, not the server', () => {
    expect(statusFor('X_PATH_INVALID')).toBe(400);
  });

  // The input a primitive declared and the caller got wrong. Unmapped it was a 500, so every
  // action route and every query read answered a typo'd uuid by blaming the server — and the
  // `error-map` stage reports 5xx, so the on-call heard about it too.
  test('input the caller got wrong blames the caller, not the server', () => {
    expect(statusFor('X_INPUT_INVALID')).toBe(400);
  });

  test('codes owned by other packages are mapped here, not there', () => {
    expect(statusFor('X_NOT_FOUND')).toBe(404);
    expect(statusFor('X_INVARIANT_VIOLATED')).toBe(422);
    expect(statusFor('X_ENTITY_DUPLICATE')).toBe(409);
    expect(statusFor('X_NOT_IMPLEMENTED')).toBe(501);
  });

  // The image routes are the framework's only caller-supplied query string, so both of these are
  // the caller's mistake to fix — a 500 would send an agent hunting a server fault it cannot see.
  test('a bad image transform request blames the caller, not the server', () => {
    expect(statusFor('X_IMAGE_QUERY_INVALID')).toBe(400);
    expect(statusFor('X_IMAGE_UNSUPPORTED')).toBe(415);
  });

  test('an unmapped code is a loud 500, never a quiet 200', () => {
    expect(statusFor('X_SOMETHING_NEW')).toBe(500);
  });

  // A request the server answered and then could not finish is the server's failure — mapped, so
  // it never rides the default and never reads as an app code someone forgot to register.
  test('a response the pipeline could not finish is the server’s 500', () => {
    expect(statusFor('X_PIPELINE_FINALIZE_FAILED')).toBe(500);
  });
});

// Every app-defined code answered 500, and `pipeline.ts` reports `status >= 500` to the error
// monitor — so a wrong password paged the on-call. The table above is the framework's and stays
// closed; this is the app's half of it.
/**
 * The rows that are a JUDGEMENT rather than the table's default, pinned so a future edit that
 * flips one is a failing test rather than a quiet change of what a client is told. Every
 * assertion below is a decision recorded in `error-map.ts`'s own comments; none of them is
 * `DEFAULT_STATUS` falling through, which `an unmapped code is a loud 500` already covers.
 */
describe('the rows that were decided rather than defaulted', () => {
  test('a state machine answers three different statuses, because it has three failures', () => {
    // Well formed, schema passed, and the machine has no such transition — the same shape
    // `X_INVARIANT_VIOLATED` is, refused before a statement opens a connection.
    expect(statusFor('X_STATE_TRANSITION_ILLEGAL')).toBe(422);
    // The lost update caught. Nothing is wrong with the request — the identical one succeeds a
    // moment later — so 409 tells the client the one thing it can act on: re-read and retry.
    expect(statusFor('X_STATE_CONFLICT')).toBe(409);
    // A column with no machine is a declaration nobody wrote, which no request changes.
    expect(statusFor('X_STATE_UNDECLARED')).toBe(500);
  });

  test('a channel refusing a delivery is 502, because the upstream failed and not this server', () => {
    // The row that stops an email provider's outage paging this app's on-call: `stages.ts`
    // reports every `status >= 500` to the error monitor, and a wrapped provider rejection is
    // somebody else's server saying no.
    expect(statusFor('X_NOTIFY_DELIVERY_FAILED')).toBe(502);
    // Its five siblings are the app's own declaration, and they stay 500s.
    for (const code of [
      'X_NOTIFY_CHANNELS_EMPTY',
      'X_NOTIFY_CHANNEL_DUPLICATE',
      'X_NOTIFY_FANOUT_TOO_WIDE',
      'X_NOTIFY_STORE_MISSING',
      'X_NOTIFY_DIGEST_UNSUPPORTED',
    ]) {
      expect(statusFor(code)).toBe(500);
    }
  });

  test('an inbound webhook that does not authenticate is 401, and never 403 or 400', () => {
    // The request is well formed and carried a credential; the credential is what failed. A 403
    // would mean an authenticated caller was refused, and there is no authenticated caller.
    expect(statusFor('X_WEBHOOK_SIGNATURE_INVALID')).toBe(401);
    expect(statusFor('X_WEBHOOK_SIGNATURE_STALE')).toBe(401);
  });

  test('a code that can never reach a request still has a row, and it is 500', () => {
    // `X_UI_FORM_PATH_INVALID` is a render-time developer error and the row is NOT a claim
    // otherwise: an unmapped code already answers 500, so the row costs nothing at runtime and
    // buys a reviewed answer instead of an accidental one. The alternative — a backlog pin —
    // would record it as UNDECIDED, which is the opposite of what is known about it.
    expect(statusFor('X_UI_FORM_PATH_INVALID')).toBe(500);
    expect(Object.hasOwn(ERROR_STATUS, 'X_UI_FORM_PATH_INVALID')).toBe(true);
  });
});

describe('an app declares the status for its own codes', () => {
  afterEach(resetErrorStatus);

  test('an undeclared app code is still a loud 500', () => {
    expect(statusFor('X_CREDENTIALS_INVALID')).toBe(500);
  });

  test('a declared code answers its declared status', () => {
    registerErrorStatus({ X_CREDENTIALS_INVALID: 401, X_SIGNUP_CLOSED: 403 });
    expect(statusFor('X_CREDENTIALS_INVALID')).toBe(401);
    expect(statusFor('X_SIGNUP_CLOSED')).toBe(403);
    expect(factsOf({ code: 'X_CREDENTIALS_INVALID' }).status).toBe(401);
    expect(toProblem({ code: 'X_SIGNUP_CLOSED' }).status).toBe(403);
  });

  test('a code the app never declared keeps defaulting to 500', () => {
    registerErrorStatus({ X_CREDENTIALS_INVALID: 401 });
    expect(statusFor('X_SOMETHING_ELSE')).toBe(500);
  });

  test('the framework’s own codes are not negotiable', () => {
    expect(() => registerErrorStatus({ X_UNAUTHENTICATED: 200 })).toThrow('X_ERROR_STATUS_INVALID');
    expect(statusFor('X_UNAUTHENTICATED')).toBe(401);
  });

  test('a status outside 100-599 is refused', () => {
    expect(() => registerErrorStatus({ X_WEIRD: 999 })).toThrow('X_ERROR_STATUS_INVALID');
    expect(() => registerErrorStatus({ X_WEIRD: 401.5 })).toThrow('X_ERROR_STATUS_INVALID');
  });

  test('registering the same code twice with a different status is refused', () => {
    registerErrorStatus({ X_CREDENTIALS_INVALID: 401 });
    registerErrorStatus({ X_CREDENTIALS_INVALID: 401 }); // idempotent: a re-import is not a bug
    expect(() => registerErrorStatus({ X_CREDENTIALS_INVALID: 403 })).toThrow(
      'X_ERROR_STATUS_INVALID',
    );
  });
});

// Both tables are object literals, so every name on `Object.prototype` reads as a member of them.
// `ERROR_STATUS['toString']` was a FUNCTION where a status belongs, and `new Response(body, {
// status })` raised `RangeError: The status provided (0) must be 101 or in the range of [200, 599]`
// — inside `recoverWith`'s fallback, the one frame with nothing above it, so `Pipeline.handle`
// REJECTED against its own contract and the socket got whatever the runtime printed. A `code` is a
// string off a throwable this package did not build; an app that throws `{ code: 'toString' }` is
// all it takes. `scripts/error-map.ts` reads the same table through `Object.hasOwn` already.
describe('a code that is also a name on Object.prototype', () => {
  afterEach(resetErrorStatus);

  const INHERITED = ['toString', 'constructor', 'valueOf', 'hasOwnProperty', '__proto__'];

  test('is an ordinary unmapped code: 500, a string title, and no function anywhere', () => {
    for (const code of INHERITED) {
      expect(statusFor(code), `statusFor(${code})`).toBe(500);
      const facts = factsOf({ code, message: 'x' });
      expect(typeof facts.title, `title for ${code}`).toBe('string');
      expect(typeof facts.status, `status for ${code}`).toBe('number');
      expect(() => new Response(null, { status: facts.status })).not.toThrow();
    }
  });

  test('and the app may declare a status for it, because the framework maps no such code', () => {
    // The refusal read `the framework already maps it to function toString() { [native code] }`,
    // so an app whose own code collided with a prototype name could never register one at all.
    registerErrorStatus({ toString: 401 });
    expect(statusFor('toString')).toBe(401);
  });
});

describe('storage states the caller can act on', () => {
  // The object exists and the request is well formed; the STATE is wrong, and the app's scanner
  // is what clears it. 500 read as "the server broke" for a workflow working as built.
  test('a quarantined object is a 409, not the 500 it fell through to', () => {
    expect(statusFor('X_STORAGE_QUARANTINED')).toBe(409);
  });
});

// Eleven codes a REQUEST produces had no row, so each answered the 500 default — and the
// `error-map` stage reports `status >= 500` to the error monitor, so nine caller mistakes paged
// the on-call. The assertion that matters is the STATUS, one test per argument: a test counting
// rows would pass with all eleven still at 500.
describe('codes other packages throw ON a request', () => {
  // The published contract had already answered this one. `statusFor` and not `ERROR_STATUS`
  // because what a client depends on is the status the server answers.
  test('a reused idempotency key is a 409', () => {
    expect(statusFor('X_IDEMPOTENCY_CONFLICT')).toBe(409);
  });

  // Deliberately NOT a 4xx: `IdempotencyReplayedFailureError` re-throws the FIRST attempt's own
  // code whenever the store kept one, so this literal code is reached only when that attempt
  // failed carrying no code at all — an unclassified throw that may have committed. The row is
  // read off `ERROR_STATUS`, because a `statusFor` of 500 is also what a missing row answers.
  test('a replayed failure the store kept no detail of is a reported 500, by decision', () => {
    expect(ERROR_STATUS.X_IDEMPOTENCY_REPLAYED_FAILURE).toBe(500);
  });

  // A page token this server minted and the caller echoed back. Same class as
  // `X_IMAGE_QUERY_INVALID`: a value the caller sent, and the fix is theirs (`after: null`).
  test('a cursor the caller tampered with blames the caller', () => {
    expect(statusFor('X_CURSOR_INVALID')).toBe(400);
  });

  // All three are tenancy isolation, and all three refuse BEFORE any row is read — so unlike
  // `X_STORAGE_ORG_MISMATCH`, which answers 404 because a 403 would confirm a key exists, there
  // is no existence here to confirm: the comparison is actor-vs-argument and names no resource.
  test('a tenant boundary refusal is a 403, and never a 404 it has nothing to hide behind', () => {
    expect(statusFor('X_TENANCY_ACTOR_MISMATCH')).toBe(403);
    expect(statusFor('X_TENANCY_CROSS_DENIED')).toBe(403);
  });

  // 403 and never 401, for the reason `X_CSRF_BLOCKED` is: the actor may be fully authenticated
  // and simply carry no org, so a sign-in page repairs nothing it is sent to.
  test('an actor with no tenant is a 403, not a second trip to sign-in', () => {
    expect(statusFor('X_TENANCY_ACTOR_ORG_REQUIRED')).toBe(403);
  });

  // A well-formed string that fails a semantic policy — the same shape as `X_BODY_INVALID` and
  // `X_INVARIANT_VIOLATED`, both already 422 here. Unmapped, a user choosing "password" paged
  // whoever was on call.
  test('a password the policy rejects is a 422', () => {
    expect(statusFor('X_PASSWORD_WEAK')).toBe(422);
  });

  // db's own `fix:` for the unique violation says "answer 409, which is what a raced signup is",
  // and `X_ENTITY_DUPLICATE` — the same event one layer up — is already 409 in this table.
  test('a constraint the database enforced is a 409, the status db’s own fix line names', () => {
    expect(statusFor('X_DB_UNIQUE_VIOLATION')).toBe(409);
    expect(statusFor('X_DB_FOREIGN_KEY_VIOLATION')).toBe(409);
  });

  // The one of the eleven that is NOT the caller's: the fix is an edit to the read's own SQL
  // (`select({ id: true })`), so nothing the caller sends changes the answer and the on-call
  // report is the point.
  test('a read that returned rows with no id is the server’s 500, by decision', () => {
    expect(ERROR_STATUS.X_QUERY_NOT_PAGEABLE).toBe(500);
  });

  // A well-formed tag this app does not ship, asserted on a value the caller supplied.
  test('an unsupported locale the caller asked for is a 400', () => {
    expect(statusFor('X_LOCALE_UNSUPPORTED')).toBe(400);
  });

  // Its sibling, and the one that had NO row: not a tag at all. It was pinned in
  // `scripts/error-map-backlog.ts` as a code that can never reach a request, on the strength of
  // the http `locale` stage never throwing — which is true of that stage and says nothing about a
  // `?locale=` query, a path segment or an action input reaching `formatDate` / `formatMoney`.
  // Strictly more the caller's fault than the row above, so it cannot be a harsher status.
  test('a tag that is not a tag at all is a 400 too, never a 500', () => {
    expect(statusFor('X_LOCALE_INVALID')).toBe(400);
    expect(ERROR_STATUS.X_LOCALE_INVALID).toBe(400);
  });

  // Two codes that arrived with the same change as the rows above. A header the caller chose and
  // an OpenAPI parameter bound, so 400; and a lifecycle refusal raised while a role STARTS, which
  // no request can be answered with, so 500 with a row rather than 500 by omission. Both are owned
  // elsewhere — if either code is renamed, this test is where that has to be noticed.
  test('a malformed Idempotency-Key header is a 400, and a drained lifecycle a 500', () => {
    expect(statusFor('X_IDEMPOTENCY_KEY_INVALID')).toBe(400);
    expect(ERROR_STATUS.X_LIFECYCLE_DRAINED).toBe(500);
  });
});

// A well-formed currency code this process carries no row for, end to end. The table is OPEN
// (`registerCurrency`), so "unknown" stopped meaning "impossible" — and every surface between the
// wire and the throw accepts any `^[A-Z]{3}$`, which is what makes the code REACHABLE rather than
// merely declared. With no row it answered the 500 default, and `stages.ts` reports `>= 500` to
// the error monitor: the on-call was paged for a value the framework's own schema had accepted.
//
// The throw is REPRODUCED, not imported. `@ultimat3/money` is tier 1 and this package is tier 2,
// so the import would be legal — but money is not a dependency of `@ultimat3/http` and must not
// become one to run a test. The seam is the CODE, exactly as it is for `X_LOCALE_UNSUPPORTED` and
// every other borrowed row in this table.
describe('a currency this process has no row for', () => {
  const reporter = memoryErrorReporter();

  // `MoneyError extends UltimateError`, and `currencyUnknown()` is what `assertCurrency` throws.
  const currencyUnknownAsMoneyThrowsIt = (currency: string): UltimateError =>
    new UltimateError({
      code: 'X_CURRENCY_UNKNOWN',
      cause: `"${currency}" is not a currency this process knows`,
      fix: 'pass a code currencyCodes() lists, uppercased',
    });

  const routes: readonly Route[] = [
    {
      method: 'POST',
      path: '/prices',
      meta: { name: 'prices.create', auth: 'public' },
      // Where an app calls `money(input.minor, input.currency)`: the body already parsed, so the
      // only thing left to refuse the code is the currency table.
      handler: () => {
        throw currencyUnknownAsMoneyThrowsIt('ZWL');
      },
    },
    {
      method: 'GET',
      path: '/ok',
      meta: { name: 'ok', auth: 'public' },
      handler: () => text('ok'),
    },
  ];

  const pipeline = () =>
    createPipeline({
      table: createRouter(routes),
      config: defineHttpConfig({ rateLimit: { scope: 'process' }, dev: false }),
      hooks: {},
    });

  const post = (body: unknown): Request =>
    new Request('http://localhost/prices', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });

  beforeEach(() => {
    resetErrorReporting();
    reporter.reset();
    configureErrorReporting({ reporter });
  });

  afterEach(resetErrorReporting);

  // The half that makes the rest reachable: the ONE currency declaration every projection derives
  // from says `ZWL` is a legal code. `json-schema.ts` publishes this source as the OpenAPI
  // `pattern` and `@ultimat3/entity` emits it inside a Postgres CHECK, so all three agree — the
  // value gets through the wire and only the currency table refuses it.
  test('the schema, and therefore the published contract, accepts the code that gets here', () => {
    expect(isCurrencyCode('ZWL')).toBe(true);
    expect(new RegExp(CURRENCY_CODE_PATTERN).test('ZWL')).toBe(true);
  });

  test('answers 400 with the code, not the 500 it fell through to', async () => {
    const response = await pipeline().handle(post({ minor: 100, currency: 'ZWL' }), {
      role: 'web',
    });

    expect(response.status).toBe(400);
    expect(response.headers.get('content-type')).toContain('application/problem+json');
    const body = (await response.json()) as Record<string, unknown>;
    expect(body['code']).toBe('X_CURRENCY_UNKNOWN');
    expect(body['status']).toBe(400);
  });

  // The assertion the row exists for. `stages.ts` reports every `status >= 500` to the monitor, so
  // without the row this request woke somebody up for a caller's own currency code.
  test('the error monitor is not paged for it', async () => {
    await pipeline().handle(post({ minor: 100, currency: 'ZWL' }), { role: 'web' });

    expect(reporter.events).toEqual([]);
  });

  test('the row is 400 wherever the status is read from', () => {
    expect(statusFor('X_CURRENCY_UNKNOWN')).toBe(400);
    expect(ERROR_STATUS.X_CURRENCY_UNKNOWN).toBe(400);
  });
});

// `@ultimat3/action` is tier 3 and this package is tier 2, so no import can ever compare the
// two — and while nothing did, the OpenAPI document promised 409 for `X_IDEMPOTENCY_CONFLICT`
// while the server answered 500. The bytes are the only seam left; the same shape as
// `scripts/oauth-route-status.test.ts`, which pins auth's statuses from outside both packages.
describe('the published contract and the answered status agree', () => {
  test('the action’s OpenAPI operation publishes the status this table answers', async () => {
    const source = await Bun.file(`${import.meta.dir}/../../action/src/http.ts`).text();
    const published = /'(\d{3})': problemResponse\('X_IDEMPOTENCY_CONFLICT'\)/.exec(source)?.[1];
    expect(
      published,
      'packages/action/src/http.ts no longer publishes a status for X_IDEMPOTENCY_CONFLICT',
    ).toBeDefined();
    expect(statusFor('X_IDEMPOTENCY_CONFLICT')).toBe(Number(published));
  });
});

// The four codes 12.0.0 minted in packages that answer requests. One test per ARGUMENT, and each
// asserts the status: a test counting rows, or one asserting `statusFor` is a number, would pass
// with every one of them still falling through to the 500 default.
describe('the codes 12.0.0 added are each classified on purpose', () => {
  // Read off `ERROR_STATUS` and never through `statusFor`, because 500 is also what a MISSING row
  // answers — the row IS the claim here, and `statusFor` cannot tell a decision from an omission.
  test('an aggregate no driver can answer alike is a declared 500, not an omitted one', () => {
    expect(ERROR_STATUS.X_AGGREGATE_UNSUPPORTED).toBe(500);
  });

  // Data-dependent, not author-dependent: the rows just happened to span currencies, so a read
  // that worked for two years starts refusing on the day a second currency lands in the table.
  // Nothing the caller sends changes it, which is why it is not a 4xx.
  test('an amount aggregated across currencies is the server’s 500, by decision', () => {
    expect(ERROR_STATUS.X_AGGREGATE_MIXED_CURRENCY).toBe(500);
  });

  // One query string away from a caller: a handler that adds `.where()` from an optional filter
  // flips `approximateCount()` into this refusal. Still 500 — `posts.count()` is the fix, and it
  // is the author's edit, so a 400 would tell the caller to repair a request that is not wrong.
  test('an estimate asked of a filtered chain blames the read, not the request', () => {
    expect(ERROR_STATUS.X_APPROXIMATE_COUNT_FILTERED).toBe(500);
  });

  // The reason the three entity rows are rows at all, rather than lines in
  // `scripts/error-map-backlog.ts`: an UNDECLARED 5xx is blanked — `toProblem` swaps its cause for
  // the opaque internal sentence — so a pin would have answered "the server failed while handling
  // this request" for a fault whose own `fix:` names the exact call to write instead.
  test('a declared 500 still hands the author the instruction it was thrown with', () => {
    const document = toProblem({
      code: 'X_AGGREGATE_MIXED_CURRENCY',
      cause: "invoices.sum('total') covers 2 currencies (EUR, JPY) — they have no common unit",
      fix: "invoices.andWhere('total.currency', 'eq', 'EUR').sum('total')",
    });
    expect(document.status).toBe(500);
    expect(document.cause).toContain('2 currencies');
    expect(document.fix).toContain('andWhere');
  });

  // The one of the four that is a caller's own doing, and the only one with a second surface:
  // `mcpHttpRoute` builds a 429 with `retry-after` by hand. A code answering 429 on one surface
  // and 500 on another is the split this table exists to prevent.
  test('the MCP throttle answers the 429 its own transport already writes', () => {
    expect(statusFor('X_MCP_RATE_LIMITED')).toBe(429);
  });

  // The bytes are the seam: `@ultimat3/mcp` is tier 4 and can never be imported here, exactly as
  // `scripts/oauth-route-status.test.ts` pins auth's statuses from outside both packages.
  test('and that 429 is the number the MCP transport hardcodes', async () => {
    const source = await Bun.file(`${import.meta.dir}/../../mcp/src/transport-http.ts`).text();
    const written = /new McpRateLimitedError\([\s\S]*?status: (\d{3}),/.exec(source)?.[1];
    expect(
      written,
      'packages/mcp/src/transport-http.ts no longer answers a status beside McpRateLimitedError',
    ).toBeDefined();
    expect(statusFor('X_MCP_RATE_LIMITED')).toBe(Number(written));
  });
});
