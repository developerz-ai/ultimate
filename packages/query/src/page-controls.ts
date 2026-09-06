// Single responsibility: the two search-string keys that turn `GET /_x/query/<name>` into a page,
// and what a value under either has to look like. A LEAF on purpose: `client.ts` is browser-safe
// and `openapi.ts` is a projection, and both spell these names — one file, or the client encodes a
// key the route does not read.
//
// The keys are `_first` and `_after`, not `first` and `after`. `PaginateArgs` spells them bare,
// and the route could have too — except a search string is ALSO the query's input, and an input
// field named `first` was legal on every release before this one (`http.test.ts` declares one,
// and a listing's page-size field is the most natural name for it). Reserving the bare names would
// have turned every such declaration into a refusal at `query()`, in a minor. The underscore is
// the framework's own namespace mark — the route lives under `/_x/` for the same reason — and
// `input-shape.ts` refuses a declaration that reaches for it, so the two names can never collide.

import { QueryInputInvalidError } from './errors';

/** `?_first=20` — the page size. Present is what makes the route answer a `Page`. */
export const PAGE_FIRST_KEY = '_first';
/** `?_after=<cursor>` — the signed cursor the previous page's `endCursor` carried. */
export const PAGE_AFTER_KEY = '_after';
export const PAGE_CONTROL_KEYS: readonly string[] = [PAGE_FIRST_KEY, PAGE_AFTER_KEY];

/**
 * The largest page a read will serve. A TWIN of `@ultimat3/entity`'s `MAX_PAGE_SIZE` — this
 * package holds no dependency on that one, the same compromise `naming.ts` and `deprecation.ts`
 * are ported under — and it exists for the same reason: `first` reaches `paginate` straight from
 * an action's input or a route parameter, so `args.first + 1` bound whatever a client sent and one
 * request could ask for five million rows. Lives here rather than in `pagination.ts` because the
 * route validates against it BEFORE `paginate` runs — see `pageControlsOf`.
 */
export const MAX_PAGE_SIZE = 10_000;

/** What the route hands `query.page()` — `PaginateArgs` minus the server-side options. */
export interface PageControls {
  readonly first: number;
  readonly after?: string;
}

/** The values a search string decodes to: `@ultimat3/http`'s `QueryValues`, restated as a leaf. */
export type SearchValues = Readonly<Record<string, string | readonly string[] | undefined>>;

export interface SplitSearch {
  /** The search string with both controls removed — what the query's own schema sees. */
  readonly input: Record<string, string | readonly string[] | undefined>;
  /** `undefined` when neither control was sent, so the route answers a bare array as it always has. */
  readonly page: PageControls | undefined;
}

/**
 * Whole digits only — `Number('1e3')` is 1000 and `Number(' 2')` is 2, and a page size that
 * needs a lenient parse is a page size nobody meant.
 */
const WHOLE_NUMBER = /^\d+$/;

/**
 * Splits the two controls out of a search string, judged at the WIRE and never left to `paginate`:
 * that function `assert`s its bound, which is `X_INVARIANT` — a 500, blaming the server for a
 * number the caller typed. Here every refusal is the query's own `X_INPUT_INVALID`, a 400 whose
 * fix line prints the schema, exactly what a bad `orgId` on the same URL already answers.
 *
 * The cursor's VALIDITY is not judged here. `decodeCursor` owns that — `X_CURSOR_INVALID`, also a
 * 400 — and a second reader of the codec's envelope would be a second opinion about what a cursor
 * is. Only its shape as a search value is checked: one string, non-empty.
 */
export function pageControlsOf(name: string, values: SearchValues): SplitSearch {
  // `Object.create(null)`, never `{}`, and the same rule `@ultimat3/http`'s `collectFields`
  // follows: a repeated `?__proto__=a&__proto__=b` arrives as an ARRAY, which is exactly what
  // `Object.prototype.__proto__`'s setter accepts — one assignment and this object's prototype IS
  // that array, so `'length' in input` answers true about a field nobody sent. A null prototype
  // has no such accessor, so the key is ordinary data on the way to the schema.
  const input: Record<string, string | readonly string[] | undefined> = Object.create(null);
  for (const [key, value] of Object.entries(values)) {
    if (!PAGE_CONTROL_KEYS.includes(key)) input[key] = value;
  }
  const first = values[PAGE_FIRST_KEY];
  const after = values[PAGE_AFTER_KEY];
  if (first === undefined && after === undefined) return { input, page: undefined };
  if (first === undefined) {
    throw new QueryInputInvalidError(
      name,
      `${PAGE_AFTER_KEY} was sent without ${PAGE_FIRST_KEY} — a cursor continues a page, so the page size is what names one`,
    );
  }
  const size = single(name, PAGE_FIRST_KEY, first);
  if (!WHOLE_NUMBER.test(size) || Number(size) < 1 || Number(size) > MAX_PAGE_SIZE) {
    throw new QueryInputInvalidError(
      name,
      `${PAGE_FIRST_KEY} must be a whole number of rows between 1 and ${MAX_PAGE_SIZE}, got "${size}"`,
    );
  }
  if (after === undefined) return { input, page: { first: Number(size) } };
  const cursor = single(name, PAGE_AFTER_KEY, after);
  if (cursor.length === 0) {
    throw new QueryInputInvalidError(
      name,
      `${PAGE_AFTER_KEY} is empty — omit it for the first page, or send the endCursor the previous page answered`,
    );
  }
  return { input, page: { first: Number(size), after: cursor } };
}

/**
 * A control sent twice is refused rather than resolved. `coerceQuery` takes the LAST repeat of a
 * declared scalar, but a page size is not a filter: two of them is two different pages asked for
 * in one request, and answering either one silently is the wrong half of a guess.
 */
function single(name: string, key: string, value: string | readonly string[]): string {
  if (typeof value === 'string') return value;
  throw new QueryInputInvalidError(
    name,
    `${key} was sent ${value.length} times — a page has one size and one cursor`,
  );
}
