/**
 * Where each stream Postly reads stopped: one row per `consumer()` key. The framework holds no
 * cursor of its own — `consumer({ cursor: { load, save } })` reads and writes this row, and `save`
 * runs inside the batch's own transaction, so a batch and the position past it commit together.
 *
 * No tenant: a vendor's feed belongs to Postly, not to an org, and nothing here references a
 * tenant-owned row.
 */

import { entity, integer, text } from '@ultimat3/entity';

export const STREAM_NAME_MAX = 160;

export const streamCursors = entity('stream_cursors', {
  columns: {
    /** `<consumer>:<key>` — one consumer reads many keys, and each stops somewhere else. */
    stream: text({ max: STREAM_NAME_MAX }).primaryKey(),
    /** The last item a committed batch handled, in the stream's own order. */
    position: integer(),
  },
});

export type StreamCursor = typeof streamCursors.$row;
