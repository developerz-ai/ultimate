// What a projected LIST query answers an agent: one page through the read's own `.page()`, at most
// `MAX_WIRE_PAGE_SIZE` rows and `QUERY_LIMITS.maxBytes` of JSON — `db.query`'s ceilings — with
// `truncated` and a `nextCursor` the agent hands back as `_after`. A read with no `.limit()` dumped
// every row into a model's context; an answer that fits is still the bare rows it always was.

import { isUltimateError } from '@ultimat3/core';
import type { AnyQuery } from '@ultimat3/query';
import { MAX_WIRE_PAGE_SIZE, sourceFor } from '@ultimat3/query';
import { QUERY_LIMITS } from './query-limits';
import type { McpToolResult } from './registry';
import type { JsonSchema } from './wire';

/** The cursor argument — the wire's own `_after`, a name `query()` refuses as an input field. */
export const MCP_QUERY_AFTER_ARG = '_after';

/** Contract text, published in `tools/list` for every caller, like an action's `mcp.description`. */
const AFTER_SCHEMA: JsonSchema = {
  type: 'string',
  description: 'nextCursor of the previous answer, for the page after it; omit for the first page',
  minLength: 1,
  maxLength: 4096,
};

/** Why an answer is short: the row ceiling, the byte ceiling, or nothing. */
export type McpTruncation = 'rows' | 'bytes' | null;

/** Why a page was cut short, and where the next one starts. */
export interface PageFacts {
  readonly truncatedBy: Exclude<McpTruncation, null>;
  readonly nextCursor: string | null;
}

/**
 * The facts of each truncated page, keyed by the rows array `run` returned. `run` stays what it
 * always answered — rows — for every caller of the public `asProjectable`; only the tool result,
 * built by `from-action.ts` from the same array, reads the facts back. Weak: a page forgets itself.
 */
const truncatedPages = new WeakMap<readonly object[], PageFacts>();

/** The facts `pagedRows` recorded for this answer, or `undefined` for an answer that fits. */
export function pageFactsOf(output: unknown): PageFacts | undefined {
  return Array.isArray(output) ? truncatedPages.get(output) : undefined;
}

function answered(
  rows: readonly object[],
  nextCursor: string | null,
  truncatedBy: McpTruncation,
): readonly object[] {
  // A fresh array, so the facts never attach to a list some other code also holds.
  const own = [...rows];
  if (truncatedBy !== null) truncatedPages.set(own, { truncatedBy, nextCursor });
  return own;
}

/** `schema` with the optional cursor; an input that is not an object has no argument to add. */
export function withAfterArg(schema: JsonSchema): JsonSchema {
  if (schema.type !== 'object') return schema;
  return {
    ...schema,
    properties: { ...(schema.properties ?? {}), [MCP_QUERY_AFTER_ARG]: AFTER_SCHEMA },
  };
}

/** The call's arguments split into the read's input and the cursor. */
export function takeAfterArg(args: unknown): { readonly input: unknown; readonly after?: string } {
  if (typeof args !== 'object' || args === null || !Object.hasOwn(args, MCP_QUERY_AFTER_ARG)) {
    return { input: args };
  }
  const input: Record<string, unknown> = {};
  let after: unknown;
  for (const [field, value] of Object.entries(args)) {
    if (field === MCP_QUERY_AFTER_ARG) after = value;
    // defineProperty, never `input[field] =`: a `__proto__` field would re-prototype the copy.
    else
      Object.defineProperty(input, field, {
        value,
        writable: true,
        enumerable: true,
        configurable: true,
      });
  }
  return typeof after === 'string' ? { input, after } : { input };
}

/**
 * One page of `target`. A byte cut asks the read again for exactly the rows that fit, so the cursor
 * resumes at the first row cut — never past it. A read whose rows carry no `id` cannot be paged
 * (`X_QUERY_NOT_PAGEABLE`); it is read whole, as before, and cut here with no cursor to offer.
 */
export async function pagedRows(
  target: AnyQuery,
  input: unknown,
  after: string | undefined,
): Promise<readonly object[]> {
  const first = Math.min(MAX_WIRE_PAGE_SIZE, target.maxPage ?? MAX_WIRE_PAGE_SIZE);
  const read = (size: number) =>
    target.page(
      input,
      after === undefined
        ? { first: size, surface: 'mcp' }
        : { first: size, after, surface: 'mcp' },
    );
  let page: Awaited<ReturnType<typeof read>>;
  try {
    page = await read(first);
  } catch (thrown) {
    if (after !== undefined || !isUltimateError(thrown) || thrown.code !== 'X_QUERY_NOT_PAGEABLE') {
      throw thrown;
    }
    const rows = await (await sourceFor(target, input, { surface: 'mcp' })).execute();
    const kept = rows.slice(0, first);
    const fit = rowsWithinBytes(kept);
    return answered(
      kept.slice(0, fit),
      null,
      fit < kept.length ? 'bytes' : rows.length > first ? 'rows' : null,
    );
  }
  const fit = rowsWithinBytes(page.rows);
  if (fit === page.rows.length)
    return answered(page.rows, page.nextCursor, page.hasMore ? 'rows' : null);
  // One row over the ceiling alone: nothing fits, and a cursor past it would hide it unseen.
  if (fit === 0) return answered([], null, 'bytes');
  const narrowed = await read(fit);
  return answered(narrowed.rows, narrowed.nextCursor, 'bytes');
}

const encoder = new TextEncoder();

/** How many leading rows fit `QUERY_LIMITS.maxBytes` as JSON, `[`, `]` and separators counted. */
function rowsWithinBytes(rows: readonly object[]): number {
  let bytes = 2;
  for (const [index, row] of rows.entries()) {
    let size = 0;
    try {
      size = encoder.encode(JSON.stringify(row)).length + 1;
    } catch {
      // Not JSON (a bigint): left to `jsonResult`'s own refusal, which names the problem.
    }
    if (bytes + size > QUERY_LIMITS.maxBytes) return index;
    bytes += size;
  }
  return rows.length;
}

/**
 * A truncated page's tool result: `base` — what the rows alone answered — plus a second text block
 * and the same keys on `structuredContent`, `{ truncated: true, truncatedBy, nextCursor? }`, so
 * both kinds of client learn it was cut. Not in the `outputSchema`: it allows extra keys, and every
 * list read's `tools/list` entry would otherwise pay ~100 bytes for a rare answer.
 */
export function truncatedResult(base: McpToolResult, facts: PageFacts): McpToolResult {
  if (base.isError === true) return base;
  const page = {
    truncated: true,
    truncatedBy: facts.truncatedBy,
    ...(facts.nextCursor === null ? {} : { nextCursor: facts.nextCursor }),
  };
  return {
    content: [...base.content, { type: 'text', text: JSON.stringify(page) }],
    ...(base.structuredContent === undefined
      ? {}
      : { structuredContent: { ...base.structuredContent, ...page } }),
  };
}
