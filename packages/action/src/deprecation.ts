/**
 * A declared retirement, rendered as the two headers the standards already define — RFC 9745
 * `Deprecation` and RFC 8594 `Sunset` — plus the successor link. Pure string and date maths, and
 * deliberately throw-free: each package raises its own `X_*` for a date it cannot render.
 *
 * `@ultimat3/query` carries a twin of this file. Both are tier 3, so neither may import the
 * other, and the shared home is `@ultimat3/http` (tier 2) once that package grows one — the same
 * compromise `naming.ts` is ported under.
 */
import { counter } from '@ultimat3/core';

export interface Deprecation {
  /** When it was deprecated. ISO-8601, e.g. `'2026-08-01T00:00:00Z'`. */
  readonly since: string;
  /** When it stops answering. ISO-8601 — the date `Sunset` publishes and clients plan against. */
  readonly sunset: string;
  /** The export name of the replacement, projected to a `rel="successor-version"` link. */
  readonly replacedBy?: string;
}

export type DeprecationField = 'since' | 'sunset';

export type DeprecationRender =
  | {
      readonly ok: true;
      readonly headers: Readonly<Record<string, string>>;
      /** The same facts as data, for `x-ultimate` in the OpenAPI operation and the manifest. */
      readonly meta: Readonly<Record<string, string>>;
    }
  | { readonly ok: false; readonly field: DeprecationField; readonly value: string };

/**
 * How many calls a deprecated declaration is still taking — the number "can we remove it yet?"
 * needs and the one nothing in the framework could answer. Attributes are the primitive and the
 * declared NAME, both bounded by the size of the codebase; a caller id here would be an unbounded
 * series, which is the cardinality mistake core's own overflow bucket exists to catch.
 */
const deprecatedCalls = counter('deprecated_calls_total', {
  unit: '{call}',
  description: 'Calls served by a declaration that has been deprecated, by primitive and name',
});

export function recordDeprecatedCall(primitive: 'action' | 'query', name: string): void {
  deprecatedCalls.add(1, { primitive, name });
}

/**
 * `Deprecation` is a structured-field Date (`@` + unix seconds, RFC 9745); `Sunset` is an
 * HTTP-date (IMF-fixdate, RFC 8594). Two spellings of one instant because two RFCs chose
 * differently — never render one in the other's format, and never emit `Invalid Date`.
 */
export function renderDeprecation(
  deprecation: Deprecation,
  successorPath: string | undefined,
): DeprecationRender {
  const since = Date.parse(deprecation.since);
  if (Number.isNaN(since)) return { ok: false, field: 'since', value: deprecation.since };
  const sunset = Date.parse(deprecation.sunset);
  if (Number.isNaN(sunset)) return { ok: false, field: 'sunset', value: deprecation.sunset };

  const headers: Record<string, string> = {
    deprecation: `@${Math.floor(since / 1000)}`,
    sunset: new Date(sunset).toUTCString(),
  };
  // The successor's URL, derived by the caller from the same `naming.ts` the client uses — a
  // link this file built from the export name would be the second URL derivation in the package.
  if (successorPath !== undefined) {
    headers['link'] = `<${successorPath}>; rel="successor-version"`;
  }

  const meta: Record<string, string> = {
    since: new Date(since).toISOString(),
    sunset: new Date(sunset).toISOString(),
    ...(deprecation.replacedBy === undefined ? {} : { replacedBy: deprecation.replacedBy }),
  };
  return { ok: true, headers, meta };
}

/** Set on a response that already exists, so a redirect and a problem document carry them too. */
export function applyHeaders(response: Response, headers: Readonly<Record<string, string>>): void {
  for (const [name, value] of Object.entries(headers)) response.headers.set(name, value);
}
