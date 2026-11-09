// The order a wait consumes events in, and the cursor a refused event leaves: ONE rule, which the
// memory bus runs here and `SQL_EVENT_FIND` states in SQL. An event is a `(publishedAt, id)` pair,
// ms then id, so the cursor carries both and never needs the refused event's row to still exist.

/** Where a search starts: at `afterMs`, and strictly past `(afterMs, afterId)` when there is an id. */
export interface EventCursor {
  readonly afterMs: number;
  readonly afterId?: string;
}

/**
 * Whether an event is past the cursor. Without an id, "published at or after `afterMs`"; with one,
 * strictly after `(afterMs, afterId)` — so an event in the cursor's millisecond with a smaller id
 * came BEFORE it, whether or not the cursor's own event has since been purged. `''` sorts below
 * every id, which is what makes the two cases one comparison.
 */
export function pastCursor(
  event: { readonly publishedAt: number; readonly id: string },
  cursor: EventCursor,
): boolean {
  if (event.publishedAt !== cursor.afterMs) return event.publishedAt > cursor.afterMs;
  return event.id > (cursor.afterId ?? '');
}

/** The consumption order: earlier `publishedAt` first, the id breaking a tie in one millisecond. */
export function eventBefore(
  a: { readonly publishedAt: number; readonly id: string },
  b: { readonly publishedAt: number; readonly id: string },
): boolean {
  return a.publishedAt === b.publishedAt ? a.id < b.id : a.publishedAt < b.publishedAt;
}
