// The version an edit form is rendered against: a keyed fingerprint of the row as it was READ,
// posted back in a hidden field, so `adminUpdate` can tell "the row I was shown" from "the row as
// it is now" and refuse a write that would silently overwrite a concurrent edit.

import { keyedFingerprint } from '@ultimat3/core';
import type { AdminRow } from './registry';

/** The posted name of the version, beside `_operation`: never a column, never an input field. */
export const VERSION_FIELD = '_version';

/** The key a write against a stale version is refused and audited with. */
export const ROW_CHANGED_REASON = 'admin.error.row-changed';

/**
 * Every value the row enumerates — a sealed one is non-enumerable and is not in it, so a password
 * change is not a "concurrent edit" and no sealed value is ever folded into page text. Keyed: the
 * page carries it, and an unkeyed hash of a row is an offline oracle for a short value in a column
 * the form does not draw.
 */
export const rowVersion = (row: AdminRow): string => keyedFingerprint(row, 'admin.row-version');
