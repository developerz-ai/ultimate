// The one crossing in this driver that cannot be lossless: `PageLike.evaluate` takes a CLOSURE and
// every browser port in the framework takes a STRING. What is supported is stated here, what is
// not is refused by name, and a page-side throw comes back as itself rather than as a driver fault.

import { renderCauseValue, stringField } from '@ultimat3/core';
import {
  E2eEvaluateCapturedError,
  E2eEvaluateThrewError,
  E2eEvaluateUnsupportedError,
} from './e2e-errors';

/** Only what this driver needs from a page, so a test proves the crossing with two methods. */
export interface EvaluablePage {
  evaluate(expression: string): Promise<unknown>;
  url(): string;
}

/**
 * A function with no source. `Function.prototype.toString` answers `[native code]` for a native
 * function and for anything `.bind()` produced, so there is nothing to send and the page would be
 * asked to evaluate a syntax error.
 */
const NATIVE = /\{\s*\[native code\]\s*\}/;

/**
 * The parameter list of an arrow or a function expression, as written. `PageLike.evaluate` declares
 * `() => T`, so a declared parameter is a value the author meant to pass and cannot: nothing in
 * the page will supply it, and it would silently arrive `undefined`.
 */
const takesParameters = (source: string): boolean => {
  const arrow = /^(?:async\s+)?\(([^)]*)\)\s*=>/.exec(source);
  if (arrow !== null) return arrow[1]?.trim() !== '';
  // `x => x * 2` — a single unparenthesised parameter, which is still a parameter.
  if (/^(?:async\s+)?[A-Za-z_$][\w$]*\s*=>/.test(source)) return true;
  const fn = /^(?:async\s+)?function\s*\*?\s*[A-Za-z_$][\w$]*?\s*\(([^)]*)\)/.exec(source);
  return fn !== null && fn[1]?.trim() !== '';
};

/**
 * Is the source a standalone expression at all? A method shorthand — what `{ evaluate() {} }.evaluate`
 * stringifies to — is `evaluate() { … }`, which is legal in an object literal and a syntax error
 * anywhere else. `new Function` is the parser, and it PARSES only: nothing is called here, so no
 * page code and no test code runs in this process.
 */
const parses = (source: string): boolean => {
  try {
    new Function(`"use strict"; return (${source});`);
    return true;
  } catch {
    return false;
  }
};

/**
 * The static half. Everything it refuses is refused before a byte reaches the browser, because the
 * page's own answer for each of these would be a syntax error with the driver's wrapper in it.
 */
export function closureSource(fn: (...args: never[]) => unknown): string {
  const source = fn.toString();
  if (NATIVE.test(source)) {
    throw new E2eEvaluateUnsupportedError({
      reason: 'is native or bound, so it has no source to send',
      source,
    });
  }
  if (takesParameters(source)) {
    throw new E2eEvaluateUnsupportedError({
      reason: 'declares a parameter, and nothing in the page will pass one',
      source,
    });
  }
  if (!parses(source)) {
    throw new E2eEvaluateUnsupportedError({
      reason: 'does not stringify to an expression the browser can parse',
      source,
    });
  }
  return source;
}

/**
 * The wrapper. It CATCHES in the page and answers a value, rather than letting the throw cross the
 * wire: `@ultimat3/scraping`'s `cdp-target.ts` wraps anything its `evaluate` rejects with as
 * `X_SCRAPE_BROWSER_UNREACHABLE`, so an app error that travelled as a rejection would arrive
 * labelled a dead socket.
 *
 * `Promise.resolve().then(…)` because the closure may be async and because a `ReferenceError` for
 * a captured binding is raised when the body RUNS, not when the arrow is built.
 */
export const evaluateExpression = (source: string): string =>
  `(() => { const fn = (${source});
  return Promise.resolve().then(() => fn()).then(
    (value) => JSON.stringify({ ok: true, value: value }),
    (error) => JSON.stringify({ ok: false, name: String(error && error.name || 'Error'), message: String(error && error.message || error) }),
  );
})()`;

/**
 * The envelope, read by hand rather than through a schema, and the reason is `value`: it is
 * whatever the test's own closure returned, so no schema in this package can describe it and a
 * `t.object` would strip the one field the caller came for. Everything the DRIVER reads — the
 * discriminant, the error name, the message — is read defensively through core's `stringField`,
 * which is total against a getter that throws.
 *
 * A malformed answer degrades into the failure branch instead of a branch of its own: the wrapper
 * below is the only writer, so anything else is a page that shadowed `JSON.stringify`, and the
 * reader needs to see what came back either way.
 */
type Envelope =
  | { readonly ok: true; readonly value: unknown }
  | { readonly ok: false; readonly name: string; readonly message: string };

const decode = (raw: unknown): unknown => {
  if (typeof raw !== 'string') return raw;
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return raw;
  }
};

const readEnvelope = (raw: unknown): Envelope => {
  const decoded = decode(raw);
  if (typeof decoded === 'object' && decoded !== null) {
    const held = decoded as { readonly ok?: unknown; readonly value?: unknown };
    if (held.ok === true) return { ok: true, value: held.value };
    return {
      ok: false,
      name: stringField(decoded, 'name') ?? 'Error',
      message: stringField(decoded, 'message') ?? renderCauseValue(raw),
    };
  }
  return { ok: false, name: 'Error', message: renderCauseValue(raw) };
};

/** V8's wording for a free identifier. The name is the whole value of the refusal it produces. */
const NOT_DEFINED = /^([A-Za-z_$][\w$]*) is not defined$/;

/**
 * Run the closure in the page and hand back what it answered.
 *
 * The cast on the way out is the generic boundary and nothing more: `evaluate<T>` is the CALLER's
 * claim about what its own closure returns, and no schema in this process can check a claim the
 * browser was never told about. Everything the driver itself reads is read above.
 */
export async function evaluateClosure<T>(page: EvaluablePage, fn: () => T): Promise<Awaited<T>> {
  const source = closureSource(fn);
  const envelope = readEnvelope(await page.evaluate(evaluateExpression(source)));
  if (envelope.ok) return envelope.value as Awaited<T>;
  const captured = envelope.name === 'ReferenceError' ? NOT_DEFINED.exec(envelope.message) : null;
  if (captured !== null) throw new E2eEvaluateCapturedError({ binding: captured[1] ?? '', source });
  throw new E2eEvaluateThrewError({
    thrown: `${envelope.name}: ${envelope.message}`,
    url: page.url(),
  });
}
