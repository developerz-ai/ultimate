/**
 * Cursor pagination, and only cursor pagination.
 *
 * OFFSET IS NOT AVAILABLE ON PURPOSE: `offset` makes the database count rows it
 * will throw away (O(offset) per page), and any insert or delete before the
 * offset shifts every later page, so users see duplicates and holes. A keyset
 * cursor is O(log n) on the ordering index and stable under concurrent writes.
 */
import type { StandardSchemaV1 } from '@ultimat3/schema';
import { CursorInvalidError } from './errors';
import type { Query, SourceOptions } from './query';
import { queryHash, queryName, sourceFor } from './query';
import type { QueryShape, SeekKey } from './shape';
import { seekKeyOf } from './shape';
import type { SqlSource } from './source';
import { isJsonObject, stableStringify } from './stable';

export interface CursorPayload {
  /** Ties the cursor to one query + arguments: a cursor is not portable. */
  readonly q: string;
  readonly seek: SeekKey;
}

export interface Page<TRow> {
  readonly rows: readonly TRow[];
  readonly endCursor: string | null;
  readonly hasNextPage: boolean;
}

export interface PaginateArgs extends SourceOptions {
  readonly first: number;
  readonly after?: string;
}

let secret = Bun.env['ULTIMATE_CURSOR_SECRET'] ?? 'ultimate-dev-cursor-secret';

/** Set once at boot from the app secret. Rotating it invalidates open cursors. */
export function configureCursorSigning(next: string): void {
  secret = next;
}

/** Opaque + signed: base64url(payload).signature. Clients must not parse it. */
export function encodeCursor(payload: CursorPayload): string {
  const body = base64UrlEncode(stableStringify(payload));
  return `${body}.${sign(body)}`;
}

export function decodeCursor(cursor: string, expectedQueryHash?: string): CursorPayload {
  const dot = cursor.lastIndexOf('.');
  if (dot <= 0) throw new CursorInvalidError('malformed cursor');
  const body = cursor.slice(0, dot);
  const signature = cursor.slice(dot + 1);
  if (sign(body) !== signature) throw new CursorInvalidError('signature mismatch');

  const parsed: unknown = safeParse(base64UrlDecode(body));
  if (!isJsonObject(parsed) || typeof parsed['q'] !== 'string' || !isJsonObject(parsed['seek'])) {
    throw new CursorInvalidError('payload is not a cursor');
  }
  const seek = parsed['seek'];
  if (!Array.isArray(seek['key']) || typeof seek['id'] !== 'string') {
    throw new CursorInvalidError('payload is not a cursor');
  }
  if (expectedQueryHash !== undefined && parsed['q'] !== expectedQueryHash) {
    throw new CursorInvalidError('cursor belongs to a different query');
  }
  return { q: parsed['q'], seek: { key: seek['key'], id: seek['id'] } };
}

/**
 * One page. Push-down when the source implements `seek()`; otherwise the rows are
 * sliced after execution and the source is doing more work than it should.
 */
export async function paginate<TInput extends StandardSchemaV1, TRow extends object>(
  target: Query<TInput, TRow>,
  input: unknown,
  args: PaginateArgs,
): Promise<Page<TRow>> {
  const name = queryName(target);
  const hash = queryHash(name, input);
  const after = args.after === undefined ? null : decodeCursor(args.after, hash).seek;
  const base = await sourceFor(target, input, args);
  const shape = base.shape();

  // Fetch one extra row: its presence *is* `hasNextPage`, with no count query.
  const window = args.first + 1;
  const source: SqlSource<object> = base.seek === undefined ? base : base.seek(after, window);
  const executed = await source.execute();
  const scoped = base.seek === undefined ? sliceAfter(executed, after, shape) : executed;
  // The source came from this query's own `sql()`, so its rows are TRow.
  const rows = scoped.slice(0, args.first) as unknown as readonly TRow[];
  const last = rows[rows.length - 1];

  return {
    rows,
    endCursor: last === undefined ? null : encodeCursor({ q: hash, seek: seekKeyOf(last, shape) }),
    hasNextPage: scoped.length > args.first,
  };
}

function sliceAfter(
  rows: readonly object[],
  after: SeekKey | null,
  shape: QueryShape,
): readonly object[] {
  if (after === null) return rows;
  const index = rows.findIndex((row) => seekKeyOf(row, shape).id === after.id);
  return index === -1 ? rows : rows.slice(index + 1);
}

/** Truncated HMAC-SHA256. Cursors are tamper-evident, never confidential. */
function sign(body: string): string {
  return new Bun.CryptoHasher('sha256', secret).update(body).digest('hex').slice(0, 32);
}

function base64UrlEncode(value: string): string {
  return btoa(value).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
}

function base64UrlDecode(value: string): string {
  const padded = value.replaceAll('-', '+').replaceAll('_', '/');
  return atob(padded.padEnd(padded.length + ((4 - (padded.length % 4)) % 4), '='));
}

function safeParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    throw new CursorInvalidError('payload is not JSON');
  }
}
